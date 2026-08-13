/**
 * testDiscovery.ts
 *
 * Test Discovery & File Watcher
 *
 * Responsibilities:
 *  1. On activation: find all existing `*.spec.ts` files inside known Vitest
 *     projects and parse them to populate the Test Explorer tree.
 *  2. Register a `vscode.FileSystemWatcher` to keep the tree live as files
 *     are created, modified, or deleted during development.
 *
 * Depends on:
 *  - `ProjectResolver`       — maps a spec file to its Angular project
 *  - `AngularVitestController` — upserts / removes TestItems in the tree
 *  - `specParser`            — statically extracts test structure via TS AST
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { ProjectResolver } from './projectResolver';
import { AngularVitestController } from './testController';
import { parseSpecFile, ParsedSuite } from './specParser';
import { makeFileNode, makeSuiteNode, makeCaseNode } from './testItemModel';
import { log, warn, error } from './logger';

export class TestDiscovery {
  constructor(
    private readonly resolver: ProjectResolver,
    private readonly controller: AngularVitestController,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Performs an initial scan of all `*.spec.ts` files and registers a
   * FileSystemWatcher. Should be called once during `activate()`.
   *
   * @param subscriptions The extension's `context.subscriptions` array so that
   *                      all watchers are disposed on extension deactivation.
   */
  async start(subscriptions: vscode.Disposable[]): Promise<void> {
    // 1. Eager initial discovery
    await this.discoverAll();

    // 2. Live watcher
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.workspace.workspaceFolders?.[0] ?? '',
        '**/*.spec.ts',
      ),
    );

    watcher.onDidCreate(
      (uri) => {
        log(`Spec file created: ${uri.fsPath}`);
        void this.parseAndUpsert(uri.fsPath);
      },
      undefined,
      subscriptions,
    );

    watcher.onDidChange(
      (uri) => {
        log(`Spec file changed: ${uri.fsPath}`);
        void this.parseAndUpsert(uri.fsPath);
      },
      undefined,
      subscriptions,
    );

    watcher.onDidDelete(
      (uri) => {
        log(`Spec file deleted: ${uri.fsPath}`);
        this.controller.removeFileItems(uri.fsPath);
      },
      undefined,
      subscriptions,
    );

    subscriptions.push(watcher);
    log('FileSystemWatcher registered for **/*.spec.ts');
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Finds all `*.spec.ts` files in the workspace (excluding node_modules)
   * and parses each one.
   */
  private async discoverAll(): Promise<void> {
    const uris = await vscode.workspace.findFiles(
      '**/*.spec.ts',
      '**/node_modules/**',
    );

    log(`Initial discovery: found ${uris.length} spec file(s). Parsing…`);

    // Parse files in parallel.
    await Promise.all(uris.map((uri) => this.parseAndUpsert(uri.fsPath)));

    log('Initial spec file discovery complete. ✓');
  }

  /**
   * Reads and parses a single spec file, then upserts the corresponding
   * TestItems in the Test Explorer tree.
   *
   * Calling this again for the same file (e.g. on save) replaces the old
   * TestItems with fresh ones, effectively refreshing the tree.
   */
  private async parseAndUpsert(filePath: string): Promise<void> {
    // Only process files that belong to a known Vitest project.
    const project = this.resolver.resolveProject(filePath);
    if (!project) {
      return;
    }

    // ── Read ──────────────────────────────────────────────────────────────
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      error(`Could not read spec file: ${filePath}`, err);
      return;
    }

    // ── Parse (AST) ────────────────────────────────────────────────────────
    let parsed;
    try {
      parsed = parseSpecFile(filePath, content);
    } catch (err) {
      error(`Could not parse spec file: ${filePath}`, err);
      return;
    }

    const fileName = filePath.split('/').pop() ?? filePath;

    // ── Upsert the file TestItem ───────────────────────────────────────────
    // VS Code replaces any existing item with the same ID (clearing children).
    const fileNode = makeFileNode(filePath, project.name);
    const fileItem = this.controller.upsertFileItem(fileNode);

    let totalCases = parsed.orphanCases.length;

    // ── Add top-level describe suites ─────────────────────────────────────
    for (const suite of parsed.suites) {
      totalCases += this.addSuiteRecursive(suite, fileItem, filePath);
    }

    // ── Add orphan cases (top-level it/test outside any describe) ─────────
    for (const c of parsed.orphanCases) {
      const caseNode = makeCaseNode(c.name, c.fullName, filePath, c.line);
      this.controller.upsertCaseItem(caseNode, fileItem);
    }

    log(
      `  ${fileName}: ${parsed.suites.length} suite(s), ${totalCases} test case(s)`,
    );
  }

  /**
   * Recursively adds a suite and all its descendants (nested suites + cases)
   * under the given parent TestItem.
   *
   * @returns Total number of test cases added within this suite tree.
   */
  private addSuiteRecursive(
    suite: ParsedSuite,
    parentItem: vscode.TestItem,
    filePath: string,
  ): number {
    const suiteNode = makeSuiteNode(
      suite.name,
      suite.fullName,
      filePath,
      suite.line,
    );
    const suiteItem = this.controller.upsertSuiteItem(suiteNode, parentItem);

    let count = suite.cases.length;

    // Direct cases inside this describe block.
    for (const c of suite.cases) {
      const caseNode = makeCaseNode(c.name, c.fullName, filePath, c.line);
      this.controller.upsertCaseItem(caseNode, suiteItem);
    }

    // Nested describes.
    for (const nested of suite.nested) {
      count += this.addSuiteRecursive(nested, suiteItem, filePath);
    }

    return count;
  }
}
