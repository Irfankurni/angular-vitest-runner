/**
 * testItemModel.ts
 *
 * Phase 2 — Internal Test Item Hierarchy
 *
 * Defines the data models that mirror the VS Code TestItem tree:
 *
 *   Workspace
 *   └── AngularProject         (one per project in angular.json)
 *       └── TestFile           (one per .spec.ts file)
 *           └── TestSuite      (one per `describe(...)` block)
 *               └── TestCase   (one per `it(...)` / `test(...)` call)
 *
 * These are *our* internal models. Each carries the metadata needed to:
 *  - Build a stable, unique `vscode.TestItem` ID.
 *  - Map back to a source location for Code Lens (Phase 3).
 *  - Construct the correct `ng test` invocation (Phase 4).
 */

// ─── ID scheme ────────────────────────────────────────────────────────────────
// IDs must be stable across reloads so VS Code can match run results to items.
//
//  project  → "project:<projectName>"
//  file     → "file:<absolutePath>"
//  suite    → "suite:<absolutePath>|<suiteName>:<line>"
//  case     → "case:<absolutePath>|<fullTestName>:<line>"

export const TestItemId = {
  project: (projectName: string) => `project:${projectName}`,

  file: (absolutePath: string) => `file:${absolutePath}`,

  suite: (absolutePath: string, suiteName: string, line: number) =>
    `suite:${absolutePath}|${suiteName}:${line}`,

  case: (absolutePath: string, fullTestName: string, line: number) =>
    `case:${absolutePath}|${fullTestName}:${line}`,
} as const;

// ─── Model interfaces ─────────────────────────────────────────────────────────

/** Represents a single Angular project discovered in angular.json. */
export interface ProjectNode {
  kind: 'project';
  /** Angular project name, e.g. "my-app". */
  projectName: string;
  /** Vitest builder string, e.g. "@angular/build:unit-test". */
  builder: string;
  /** Absolute path to the project root directory. */
  rootPath: string;
  /** The vscode.TestItem ID for this node. */
  id: string;
}

/** Represents a single `.spec.ts` file within a project. */
export interface FileNode {
  kind: 'file';
  /** Absolute path to the spec file. */
  filePath: string;
  /** The Angular project this file belongs to. */
  projectName: string;
  /** The vscode.TestItem ID for this node. */
  id: string;
}

/** Represents a `describe(...)` block inside a spec file. */
export interface SuiteNode {
  kind: 'suite';
  /** The `describe` label string. */
  suiteName: string;
  /** Fully-qualified name including any nested describe labels (joined by " > "). */
  fullSuiteName: string;
  /** Absolute path of the file containing this suite. */
  filePath: string;
  /** 1-based line number of the `describe(` call. */
  line: number;
  /** The vscode.TestItem ID for this node. */
  id: string;
}

/** Represents a single `it(...)` or `test(...)` call. */
export interface CaseNode {
  kind: 'case';
  /** The test label string. */
  testName: string;
  /**
   * Fully-qualified name for `--testNamePattern` filtering:
   * "<fullSuiteName> <testName>" (space-separated, Vitest convention).
   */
  fullTestName: string;
  /** Absolute path of the file containing this test. */
  filePath: string;
  /** 1-based line number of the `it(` or `test(` call. */
  line: number;
  /** The vscode.TestItem ID for this node. */
  id: string;
}

/** Union of all node types for type-safe switching. */
export type TestNode = ProjectNode | FileNode | SuiteNode | CaseNode;

// ─── Factory helpers ──────────────────────────────────────────────────────────

export function makeProjectNode(
  projectName: string,
  builder: string,
  rootPath: string,
): ProjectNode {
  return {
    kind: 'project',
    projectName,
    builder,
    rootPath,
    id: TestItemId.project(projectName),
  };
}

export function makeFileNode(
  filePath: string,
  projectName: string,
): FileNode {
  return {
    kind: 'file',
    filePath,
    projectName,
    id: TestItemId.file(filePath),
  };
}

export function makeSuiteNode(
  suiteName: string,
  fullSuiteName: string,
  filePath: string,
  line: number,
): SuiteNode {
  return {
    kind: 'suite',
    suiteName,
    fullSuiteName,
    filePath,
    line,
    id: TestItemId.suite(filePath, fullSuiteName, line),
  };
}

export function makeCaseNode(
  testName: string,
  fullTestName: string,
  filePath: string,
  line: number,
): CaseNode {
  return {
    kind: 'case',
    testName,
    fullTestName,
    filePath,
    line,
    id: TestItemId.case(filePath, fullTestName, line),
  };
}
