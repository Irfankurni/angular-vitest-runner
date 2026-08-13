/**
 * specParser.ts
 *
 * Spec File Parser (regex + brace-depth, no TypeScript compiler API)
 *
 * Parses a `.spec.ts` file line by line using regular expressions and
 * brace-depth tracking to extract all `describe` / `it` / `test` call sites
 * with their:
 *  - label string
 *  - fully-qualified name (for --testNamePattern filtering)
 *  - 1-based line number (for VS Code range mapping)
 *
 * Handles:
 *  - Nested describes (arbitrary depth)
 *  - Focused/skipped variants: fdescribe, xdescribe, fit, xit, xtest, ftest
 *  - `describe.each` / `it.each` / `it.skip` / `it.only` patterns
 *  - Template-literal and variable test names are gracefully skipped
 *
 * Note: relies on the common convention that `describe('name', () => {` appears
 * on a single line. Multi-line describe headers are gracefully ignored.
 */

// ─── Public result types ──────────────────────────────────────────────────────

export interface ParsedCase {
  /** The raw label passed to `it(...)` or `test(...)`. */
  name: string;
  /**
   * Full name used for Vitest's `--testNamePattern`.
   * Concatenates all ancestor describe labels and the test label with spaces.
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

// ─── Regex patterns ───────────────────────────────────────────────────────────

/**
 * Matches: describe / fdescribe / xdescribe (with optional .each / .skip / .only)
 * Captures group 3: the string literal label (content between the quotes).
 */
const DESCRIBE_RE =
  /\b(fdescribe|xdescribe|describe)\s*(?:\.(?:each|skip|only)\s*(?:\([^)]*\))?\s*)?\(\s*(['"`])((?:[^\\]|\\.)*?)\2/;

/**
 * Matches: it / test / fit / xit / xtest / ftest (with optional .each / .skip / .only / .todo)
 * Captures group 3: the string literal label (content between the quotes).
 */
const IT_RE =
  /\b(fit|xit|xtest|ftest|it|test)\s*(?:\.(?:each|skip|only|todo)\s*(?:\([^)]*\))?\s*)?\(\s*(['"`])((?:[^\\]|\\.)*?)\2/;

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Parses the given spec file content and returns the discovered test structure.
 * This is a pure, synchronous function — no I/O.
 */
export function parseSpecFile(_filePath: string, content: string): ParsedSpec {
  const lines = content.split('\n');

  interface StackFrame {
    suite: ParsedSuite;
    /** Brace depth recorded immediately after processing the describe's opening line. */
    openDepth: number;
  }

  const stack: StackFrame[] = [];
  let depth = 0;

  const rootSuites: ParsedSuite[] = [];
  const rootCases: ParsedCase[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;

    // Pop any suites whose callback body we have exited.
    // A suite opened at openDepth N is active while depth >= N.
    while (stack.length > 0 && depth < stack[stack.length - 1].openDepth) {
      stack.pop();
    }

    // Determine the current insertion targets.
    const currentSuites =
      stack.length > 0 ? stack[stack.length - 1].suite.nested : rootSuites;
    const currentCases =
      stack.length > 0 ? stack[stack.length - 1].suite.cases : rootCases;
    const suiteNamePath = stack.map((f) => f.suite.name);

    // ── Check for describe ────────────────────────────────────────────────────
    const describeMatch = DESCRIBE_RE.exec(stripLineComment(raw));
    if (describeMatch) {
      const name = unescapeString(describeMatch[3]);
      const fullName = [...suiteNamePath, name].join(' > ');
      const suite: ParsedSuite = { name, fullName, line: lineNum, cases: [], nested: [] };
      currentSuites.push(suite);

      // Update depth FIRST, then push the frame so openDepth reflects the
      // depth inside the callback body (after the opening `{`).
      depth += netBraces(raw);
      stack.push({ suite, openDepth: depth });
      continue;
    }

    // ── Check for it / test ───────────────────────────────────────────────────
    const itMatch = IT_RE.exec(stripLineComment(raw));
    if (itMatch) {
      const name = unescapeString(itMatch[3]);
      // Vitest's --testNamePattern matches "<suite> <test>" (space-joined).
      const fullName = [...suiteNamePath, name].join(' ');
      currentCases.push({ name, fullName, line: lineNum });
    }

    // ── Update brace depth ────────────────────────────────────────────────────
    depth += netBraces(raw);
  }

  return { suites: rootSuites, orphanCases: rootCases };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strips everything from the first `//` line comment onwards,
 * while being careful not to strip `//` inside string literals.
 */
function stripLineComment(line: string): string {
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') { i++; continue; } // escaped char
      if (ch === stringChar) { inString = false; }
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
    }
  }
  return line;
}

/**
 * Counts the net number of `{` minus `}` on a single line,
 * ignoring braces that appear inside string literals or line comments.
 */
function netBraces(line: string): number {
  let open = 0;
  let close = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) { inString = false; }
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') { break; } // line comment
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '{') { open++; }
    if (ch === '}') { close++; }
  }

  return open - close;
}

/**
 * Converts common escape sequences captured inside regex group back to
 * their real characters (e.g. `\'` → `'`, `\\` → `\`).
 */
function unescapeString(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}
