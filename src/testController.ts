/**
 * testController.ts
 *
 * VS Code Testing API Integration
 *
 * Responsibilities:
 *  1. Create the `vscode.TestController` that drives the Test Explorer UI.
 *  2. Register Run and Debug profiles.
 *  3. Expose helpers for adding/removing TestItems that correspond to our
 *     internal ProjectNode / FileNode / SuiteNode / CaseNode models.
 *  4. Provide stub run/debug handlers (real execution wired in testRunner).
 */

import * as vscode from 'vscode';
import {
  ProjectNode,
  FileNode,
  SuiteNode,
  CaseNode,
  TestNode,
} from './testItemModel';
import { AngularWorkspace } from './angularWorkspace';
import { makeProjectNode } from './testItemModel';
import { log, warn } from './logger';

// ─── Controller ID (must be stable across VS Code sessions) ──────────────────
const CONTROLLER_ID = 'angularVitestController';
const CONTROLLER_LABEL = 'Angular Vitest';

// ─── Main class ───────────────────────────────────────────────────────────────

export class AngularVitestController {
  /** The native VS Code test controller that drives the Test Explorer UI. */
  public readonly controller: vscode.TestController;

  /**
   * Bidirectional map: TestItem.id ↔ our internal TestNode.
   * Used to look up metadata when a run request arrives.
   */
  private readonly nodeMap = new Map<string, TestNode>();

  /**
   * Secondary lookup for test cases: `"<filePath>|<fullTestName>"` → TestItem.
   * Populated by `upsertCaseItem`. Allows output-parser results to find
   * their corresponding TestItems without knowing the line number.
   */
  private readonly caseNameMap = new Map<string, vscode.TestItem>();

  private readonly _disposables: vscode.Disposable[] = [];

  /**
   * Pluggable handler for Run profile requests.
   * Replaced by the real child_process runner in testRunner.ts.
   */
  public runHandler: (
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ) => Promise<void> = stubRunHandler;

  /**
   * Pluggable handler for Debug profile requests.
   */
  public debugHandler: (
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ) => Promise<void> = stubDebugHandler;

  // ─── Construction ─────────────────────────────────────────────────────────

  constructor() {
    this.controller = vscode.tests.createTestController(
      CONTROLLER_ID,
      CONTROLLER_LABEL,
    );

    // ── Run profile ─────────────────────────────────────────────────────────
    const runProfile = this.controller.createRunProfile(
      'Run Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runHandler(request, token),
      /* isDefault */ true,
    );

    // ── Debug profile ───────────────────────────────────────────────────────
    const debugProfile = this.controller.createRunProfile(
      'Debug Tests',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.debugHandler(request, token),
      /* isDefault */ false,
    );

    this._disposables.push(this.controller, runProfile, debugProfile);
    log('TestController created with Run and Debug profiles.');
  }

  // ─── Workspace population ─────────────────────────────────────────────────

  /**
   * Populates the top-level TestItem tree with one item per Angular project.
   * Called once during activation and again whenever angular.json changes.
   */
  populateFromWorkspace(workspace: AngularWorkspace): void {
    // Clear existing items before re-populating.
    this.controller.items.replace([]);
    this.nodeMap.clear();
    this.caseNameMap.clear();

    for (const project of workspace.allProjects()) {
      const node = makeProjectNode(
        project.name,
        project.vitestBuilder,
        project.root,
      );

      const item = this.controller.createTestItem(
        node.id,
        project.name,
        vscode.Uri.file(project.root),
      );
      item.description = project.vitestBuilder;
      // Mark children as "not yet resolved" — the file watcher fills them in.
      item.canResolveChildren = true;

      this.controller.items.add(item);
      this.nodeMap.set(node.id, node);
      log(`TestItem added for project: "${project.name}"`);
    }
  }

  // ─── TestItem CRUD helpers ────────────────────────────────────────────────

  /**
   * Adds or replaces a TestItem for a spec file under its project item.
   */
  upsertFileItem(node: FileNode): vscode.TestItem {
    const projectItemId = `project:${node.projectName}`;
    const projectItem = this.controller.items.get(projectItemId);

    const uri = vscode.Uri.file(node.filePath);
    const label = uri.path.split('/').pop() ?? node.filePath;

    const item = this.controller.createTestItem(node.id, label, uri);
    item.canResolveChildren = true;

    if (projectItem) {
      projectItem.children.add(item);
    } else {
      // Fallback: add at root level if project item is missing.
      warn(
        `Project item "${projectItemId}" not found. Adding file at root level.`,
      );
      this.controller.items.add(item);
    }

    this.nodeMap.set(node.id, node);
    return item;
  }

  /**
   * Adds or replaces a TestItem for a `describe` suite under its file item.
   */
  upsertSuiteItem(
    node: SuiteNode,
    parentItem: vscode.TestItem,
  ): vscode.TestItem {
    const item = this.controller.createTestItem(
      node.id,
      node.suiteName,
      vscode.Uri.file(node.filePath),
    );
    item.range = new vscode.Range(
      new vscode.Position(node.line - 1, 0),
      new vscode.Position(node.line - 1, 0),
    );
    item.canResolveChildren = true;
    parentItem.children.add(item);
    this.nodeMap.set(node.id, node);
    return item;
  }

  /**
   * Adds or replaces a TestItem for an `it`/`test` case under its parent.
   */
  upsertCaseItem(
    node: CaseNode,
    parentItem: vscode.TestItem,
  ): vscode.TestItem {
    const item = this.controller.createTestItem(
      node.id,
      node.testName,
      vscode.Uri.file(node.filePath),
    );
    item.range = new vscode.Range(
      new vscode.Position(node.line - 1, 0),
      new vscode.Position(node.line - 1, 0),
    );
    item.canResolveChildren = false;
    parentItem.children.add(item);
    this.nodeMap.set(node.id, node);
    // Populate secondary lookup for output-parser result matching.
    this.caseNameMap.set(`${node.filePath}|${node.fullTestName}`, item);
    return item;
  }

  /**
   * Removes all TestItems (and their children) associated with a given file.
   */
  removeFileItems(filePath: string): void {
    const fileId = `file:${filePath}`;
    // Search all project items for the file child.
    this.controller.items.forEach((projectItem) => {
      projectItem.children.forEach((child) => {
        if (child.id === fileId) {
          projectItem.children.delete(fileId);
          // Clean up nodeMap and caseNameMap entries for this file and its descendants.
          for (const id of [...this.nodeMap.keys()]) {
            if (id.includes(filePath)) {
              this.nodeMap.delete(id);
            }
          }
          for (const key of [...this.caseNameMap.keys()]) {
            if (key.startsWith(filePath + '|')) {
              this.caseNameMap.delete(key);
            }
          }
        }
      });
    });
  }

  // ─── Lookup ───────────────────────────────────────────────────────────────

  /** Returns our internal node for a given TestItem ID, if known. */
  getNode(testItemId: string): TestNode | undefined {
    return this.nodeMap.get(testItemId);
  }

  /**
   * Returns the Angular project name that owns the given spec file.
   * Used by `TestRunner` to resolve the project for suite/case nodes (which
   * don't store projectName directly — only their parent FileNode does).
   */
  getProjectNameForFilePath(filePath: string): string | undefined {
    const fileNode = this.nodeMap.get(`file:${filePath}`);
    return fileNode?.kind === 'file' ? fileNode.projectName : undefined;
  }

  /**
   * Finds the TestItem for a specific test case by file path and full test name.
   * Used by the output parser to map parsed results back to VS Code TestItems.
   *
   * @param filePath     Absolute path to the spec file.
   * @param fullTestName The full test name (suite + case, space-joined).
   */
  findCaseByName(filePath: string, fullTestName: string): vscode.TestItem | undefined {
    return this.caseNameMap.get(`${filePath}|${fullTestName}`);
  }

  /** Finds a TestItem anywhere in the tree by its ID. */
  findItem(id: string): vscode.TestItem | undefined {
    return findInCollection(this.controller.items, id);
  }

  // ─── Disposal ─────────────────────────────────────────────────────────────

  dispose(): void {
    this._disposables.forEach((d) => d.dispose());
    this.nodeMap.clear();
    this.caseNameMap.clear();
    log('TestController disposed.');
  }
}

// ─── Stub handlers ──────────────────────────────────────────────────────────────────

async function stubRunHandler(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  const run = (request as any)._controller
    ? undefined
    : undefined;
  // Real runner is wired in testRunner.ts.
  void request;
  void token;
  vscode.window.showInformationMessage(
    'Angular Vitest Runner: No run handler configured.',
  );
}

async function stubDebugHandler(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
): Promise<void> {
  void request;
  void token;
  vscode.window.showInformationMessage(
    'Angular Vitest Runner: Debug execution is not yet available.',
  );
}

// ─── Tree search helper ───────────────────────────────────────────────────────

function findInCollection(
  collection: vscode.TestItemCollection,
  id: string,
): vscode.TestItem | undefined {
  let found: vscode.TestItem | undefined;
  collection.forEach((item) => {
    if (found) {
      return;
    }
    if (item.id === id) {
      found = item;
    } else {
      found = findInCollection(item.children, id);
    }
  });
  return found;
}
