/**
 * specParser.ts
 *
 * Phase 3 — AST Parser
 *
 * Uses the TypeScript compiler API to statically analyze a `.spec.ts` file
 * and extract all `describe` / `it` / `test` call sites with their:
 *  - label string
 *  - fully-qualified name (for --testNamePattern filtering)
 *  - 1-based line number (for VS Code range mapping)
 *
 * Handles:
 *  - Nested describes (arbitrary depth)
 *  - Focused/skipped variants: fdescribe, xdescribe, fit, xit, xtest, ftest
 *  - `describe.each` / `it.each` patterns (base callee extracted)
 *  - Template-literal and variable test names are gracefully skipped
 */

import * as ts from 'typescript';

// ─── Public result types ──────────────────────────────────────────────────────

export interface ParsedCase {
  /** The raw label passed to `it(...)` or `test(...)`. */
  name: string;
  /**
   * Full name used for Vitest's `--testNamePattern`.
   * Concatenates all ancestor describe labels and the test label with spaces:
   * e.g. "Suite A Nested Suite my test name"
   */
  fullName: string;
  /** 1-based line number of the `it(` / `test(` call. */
  line: number;
}

export interface ParsedSuite {
  /** The raw label passed to `describe(...)`. */
  name: string;
  /**
   * Full suite path joining ancestor labels with " > ".
   * e.g. "Suite A > Nested Suite"
   */
  fullName: string;
  /** 1-based line number of the `describe(` call. */
  line: number;
  /** Direct `it` / `test` cases inside this describe block. */
  cases: ParsedCase[];
  /** Nested `describe` blocks inside this describe block. */
  nested: ParsedSuite[];
}

export interface ParsedSpec {
  /** Top-level `describe(...)` blocks. */
  suites: ParsedSuite[];
  /** Top-level `it(...)` / `test(...)` calls outside any describe. */
  orphanCases: ParsedCase[];
}

// ─── Test function name sets ──────────────────────────────────────────────────

const DESCRIBE_NAMES = new Set([
  'describe',
  'fdescribe', // focused (Jasmine)
  'xdescribe', // skipped (Jasmine)
]);

const IT_NAMES = new Set([
  'it',
  'test',
  'fit',   // focused (Jasmine)
  'xit',   // skipped (Jasmine)
  'xtest', // skipped (Vitest)
  'ftest', // focused (Vitest)
]);

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Parses the given spec file content and returns the discovered test structure.
 * This is a pure, synchronous function — no I/O.
 */
export function parseSpecFile(filePath: string, content: string): ParsedSpec {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const { suites, cases } = visitBlock(sourceFile, sourceFile, []);
  return { suites, orphanCases: cases };
}

// ─── Recursive block visitor ──────────────────────────────────────────────────

/**
 * Walks the direct children of a `ts.SourceFile` or a `ts.Block` (the body of
 * a describe callback) and collects any `describe` / `it` / `test` calls.
 *
 * We deliberately do NOT recurse into function declarations or other
 * function-like nodes, so that private helper functions inside the spec file
 * are not mistakenly treated as test definitions.
 */
function visitBlock(
  block: ts.Node,
  sourceFile: ts.SourceFile,
  suiteStack: string[],
): { suites: ParsedSuite[]; cases: ParsedCase[] } {
  const suites: ParsedSuite[] = [];
  const cases: ParsedCase[] = [];

  ts.forEachChild(block, (child) => {
    // We only care about expression statements: `describe(...)`, `it(...)` etc.
    if (!ts.isExpressionStatement(child)) {
      return;
    }

    const call = child.expression;
    if (!ts.isCallExpression(call)) {
      return;
    }

    const callee = extractCalleeName(call.expression);
    if (!callee) {
      return;
    }

    if (DESCRIBE_NAMES.has(callee)) {
      const suite = parseDescribeCall(call, sourceFile, suiteStack);
      if (suite) {
        suites.push(suite);
      }
    } else if (IT_NAMES.has(callee)) {
      const testCase = parseItCall(call, sourceFile, suiteStack);
      if (testCase) {
        cases.push(testCase);
      }
    }
    // beforeEach, afterAll, etc. are silently ignored.
  });

  return { suites, cases };
}

// ─── Describe parser ──────────────────────────────────────────────────────────

function parseDescribeCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  suiteStack: string[],
): ParsedSuite | undefined {
  // describe(name, fn) → args[0] is the name, args[1] is the callback.
  const label = extractStringArg(call, 0);
  if (label === undefined) {
    // Dynamic name (variable / expression) — skip this describe block.
    return undefined;
  }

  const line = getLine(call, sourceFile);
  const fullName = [...suiteStack, label].join(' > ');
  const newStack = [...suiteStack, label];

  // Extract the callback function (second argument).
  const callbackArg = call.arguments[1];
  let nested: ParsedSuite[] = [];
  let nestedCases: ParsedCase[] = [];

  if (
    callbackArg &&
    (ts.isFunctionExpression(callbackArg) || ts.isArrowFunction(callbackArg))
  ) {
    const fn = callbackArg as ts.FunctionExpression | ts.ArrowFunction;
    // Only handle block bodies `() => { ... }`, not expression bodies `() => expr`.
    if (ts.isBlock(fn.body)) {
      const result = visitBlock(fn.body, sourceFile, newStack);
      nested = result.suites;
      nestedCases = result.cases;
    }
  }

  return { name: label, fullName, line, cases: nestedCases, nested };
}

// ─── it / test parser ─────────────────────────────────────────────────────────

function parseItCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  suiteStack: string[],
): ParsedCase | undefined {
  const label = extractStringArg(call, 0);
  if (label === undefined) {
    // Dynamic test name — skip.
    return undefined;
  }

  const line = getLine(call, sourceFile);
  // Vitest's --testNamePattern matches against "<suite> <test>" (space-joined).
  const fullName = [...suiteStack, label].join(' ');

  return { name: label, fullName, line };
}

// ─── AST utility helpers ──────────────────────────────────────────────────────

/**
 * Extracts the base callee identifier from an expression.
 *
 * Examples:
 *  - `describe`           → "describe"
 *  - `describe.each`      → "describe"
 *  - `it.skip`            → "it"
 *  - `something.describe` → "something" (not in our sets, safely ignored)
 */
function extractCalleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression)
  ) {
    return expr.expression.text;
  }
  return undefined;
}

/**
 * Returns the string value of the `index`-th argument if it is a static
 * string literal or no-substitution template literal. Returns `undefined`
 * for any other expression (variables, concatenations, tagged templates, etc.).
 */
function extractStringArg(
  call: ts.CallExpression,
  index: number,
): string | undefined {
  const arg = call.arguments[index];
  if (!arg) {
    return undefined;
  }
  if (
    ts.isStringLiteral(arg) ||
    ts.isNoSubstitutionTemplateLiteral(arg)
  ) {
    return arg.text;
  }
  return undefined;
}

/**
 * Returns the 1-based line number for the start position of a node.
 */
function getLine(node: ts.Node, sourceFile: ts.SourceFile): number {
  const pos = node.getStart(sourceFile);
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}
