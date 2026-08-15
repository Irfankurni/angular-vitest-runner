/**
 * testRunner.ts
 *
 * Run Handler
 *
 * Maps TestRunRequest → RunGroups, spawns `ng test` child processes,
 * and parses Vitest verbose text output to map per-test pass/fail/skip
 * status and error messages back to individual VS Code TestItems.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { AngularWorkspace } from './angularWorkspace';
import { AngularVitestController } from './testController';
import { TestNode, SuiteNode, CaseNode } from './testItemModel';
import { spawnNgTest, resolveNgPath } from './cliRunner';
import { parseRunOutput, ParsedRunResult } from './outputParser';
import { getOutputChannel, log, warn, error } from './logger';

// ─── RunGroup ─────────────────────────────────────────────────────────────────

/**
 * Represents a single `ng test` invocation.
 * Multiple TestItems may share a RunGroup if they belong to the same project/file.
 */
interface RunGroup {
  /** Angular project name passed to `ng test <project>`. */
  projectName: string;
  /** Vitest `--include` glob (relative to workspace root). */
  includeGlob?: string;
  /** Vitest `--testNamePattern` regex string. */
  testNamePattern?: string;
  /** The TestItems whose status this run will update. */
  requestItems: vscode.TestItem[];
}

// ─── TestRunner ───────────────────────────────────────────────────────────────

export class TestRunner {
  constructor(
    private readonly workspace: AngularWorkspace,
    private readonly ctrl: AngularVitestController,
  ) {}

  /**
   * Main entry point — called by the controller's Run/Debug profile handler.
   */
  async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const testRun = this.ctrl.controller.createTestRun(request);
    const channel = getOutputChannel();

    try {
      const groups = this.buildRunGroups(request);

      if (groups.length === 0) {
        warn('No runnable test groups could be built for this request.');
        testRun.end();
        return;
      }

      // Mark all participating items (and their descendant case items) as enqueued
      // before spawning anything. VS Code silently ignores passed()/failed() calls
      // on any TestItem that was never enrolled in the run via enqueued().
      groups.forEach((g) => {
        g.requestItems.forEach((item) => {
          testRun.enqueued(item);
          collectDescendants(item).forEach((d) => testRun.enqueued(d));
        });
      });

      // Resolve the ng binary once (shared across all groups).
      const ngBinPath = resolveNgPath(
        this.workspace.workspaceRoot,
        vscode.workspace.getConfiguration('angularVitestRunner').get<string>('ngCliPath', ''),
      );

      for (const group of groups) {
        if (token.isCancellationRequested) {
          group.requestItems.forEach((item) => {
            testRun.skipped(item);
            collectDescendants(item).forEach((d) => testRun.skipped(d));
          });
          continue;
        }

        // ── Mark as started (request items + all descendants) ───────────────
        group.requestItems.forEach((item) => {
          testRun.started(item);
          collectDescendants(item).forEach((d) => testRun.started(d));
        });

        channel.appendLine(
          `\n${'─'.repeat(60)}\n` +
            `▶  ng test ${group.projectName}` +
            (group.includeGlob ? `  [file: ${group.includeGlob}]` : '') +
            (group.testNamePattern ? `  [pattern: ${group.testNamePattern}]` : '') +
            `\n${'─'.repeat(60)}`,
        );

        // ── Spawn the process ──────────────────────────────────────────────
        const result = await spawnNgTest(
          {
            workspaceRoot: this.workspace.workspaceRoot,
            projectName: group.projectName,
            includeGlob: group.includeGlob,
            testNamePattern: group.testNamePattern,
            ngBinPath,
          },
          token,
          (chunk) => channel.append(chunk),
          (chunk) => channel.append(chunk),
        );

        // ── Update UI ──────────────────────────────────────────────────────
        if (token.isCancellationRequested) {
          group.requestItems.forEach((item) => {
            testRun.skipped(item);
            collectDescendants(item).forEach((d) => testRun.skipped(d));
          });
          continue;
        }

        if (result.exitCode === null) {
          // Process could not be started (e.g. ng binary not found).
          const msg = new vscode.TestMessage(
            'Failed to launch the Angular CLI. ' +
              'Check the "Angular Vitest Runner" output channel for details.',
          );
          group.requestItems.forEach((item) => testRun.failed(item, msg));
          continue;
        }

        // Parse Vitest verbose output → per-test results.
        const parsed = parseRunOutput(
          result.stdout + '\n' + result.stderr,
          this.workspace.workspaceRoot,
          (msg) => channel.appendLine(msg),
        );

        // ── Diagnostic logging (visible in "Angular Vitest Runner" output) ─
        log(`Parsed ${parsed.cases.length} case(s), buildFailed=${parsed.buildFailed}`);
        for (const c of parsed.cases) {
          const errSnippet = c.errorMessage
            ? c.errorMessage.slice(0, 120).replace(/\n/g, '↵')
            : '(none)';
          log(`  [${c.status}] "${c.fullTestName}" | file: ${c.filePath} | error: ${errSnippet}`);
        }

        this.applyParsedResults(parsed, testRun, group.requestItems);
      }
    } catch (err) {
      error('Unexpected error in TestRunner.run()', err);
    } finally {
      testRun.end();
    }
  }

  // ─── Group building ─────────────────────────────────────────────────────────

  /**
   * Converts a `vscode.TestRunRequest` into an ordered list of RunGroups.
   *
   * Strategy:
   *  - No explicit include  → one group per known Angular project.
   *  - Single item          → most specific filter (project / file / pattern).
   *  - Multiple items, same file → combine testNamePatterns with `|`.
   *  - Multiple items, different files → run the whole project (no filter).
   */
  private buildRunGroups(request: vscode.TestRunRequest): RunGroup[] {
    if (!request.include || request.include.length === 0) {
      // Run everything: one group per top-level project TestItem.
      const groups: RunGroup[] = [];
      this.ctrl.controller.items.forEach((projectItem) => {
        const node = this.ctrl.getNode(projectItem.id);
        if (node?.kind === 'project') {
          groups.push({ projectName: node.projectName, requestItems: [projectItem] });
        }
      });
      return groups;
    }

    // Group requested items by project name.
    const byProject = new Map<string, { items: vscode.TestItem[]; nodes: TestNode[] }>();

    for (const item of request.include) {
      const node = this.ctrl.getNode(item.id);
      if (!node) {
        warn(`No internal node found for TestItem "${item.id}" — skipping.`);
        continue;
      }

      const projectName = this.resolveProjectName(node);
      if (!projectName) {
        warn(`Cannot determine project for TestItem "${item.id}" — skipping.`);
        continue;
      }

      const bucket = byProject.get(projectName) ?? { items: [], nodes: [] };
      bucket.items.push(item);
      bucket.nodes.push(node);
      byProject.set(projectName, bucket);
    }

    return Array.from(byProject.entries()).map(([projectName, { items, nodes }]) =>
      this.buildGroupForProject(projectName, items, nodes),
    );
  }

  private buildGroupForProject(
    projectName: string,
    items: vscode.TestItem[],
    nodes: TestNode[],
  ): RunGroup {
    // ── Single-item selection: use maximum specificity ──────────────────────
    if (nodes.length === 1) {
      return this.groupFromSingleNode(projectName, nodes[0], items);
    }

    // ── Multi-item selection ────────────────────────────────────────────────
    // Collect unique file paths (project nodes don't have filePaths).
    const filePaths = new Set<string>();
    for (const node of nodes) {
      if (node.kind === 'file' || node.kind === 'suite' || node.kind === 'case') {
        filePaths.add(node.filePath);
      }
    }

    if (filePaths.size === 1) {
      const [filePath] = filePaths;
      const rel = path.relative(this.workspace.workspaceRoot, filePath);

      // If ALL selected items are suites/cases, combine their name patterns.
      const allNameable = nodes.every((n) => n.kind === 'suite' || n.kind === 'case');
      if (allNameable) {
        const pattern = nodes
          .map((n) =>
            n.kind === 'suite'
              ? TestRunner.escapeRegex((n as SuiteNode).fullSuiteName)
              : TestRunner.escapeRegex((n as CaseNode).fullTestName),
          )
          .join('|');
        return { projectName, includeGlob: rel, testNamePattern: pattern, requestItems: items };
      }

      // Some items are file-level → just filter by file.
      return { projectName, includeGlob: rel, requestItems: items };
    }

    // Multiple files → run the whole project without a file filter.
    return { projectName, requestItems: items };
  }

  /** Builds the most specific RunGroup possible for a single TestNode. */
  private groupFromSingleNode(
    projectName: string,
    node: TestNode,
    items: vscode.TestItem[],
  ): RunGroup {
    switch (node.kind) {
      case 'project':
        return { projectName, requestItems: items };

      case 'file': {
        const rel = path.relative(this.workspace.workspaceRoot, node.filePath);
        return { projectName, includeGlob: rel, requestItems: items };
      }

      case 'suite': {
        const rel = path.relative(this.workspace.workspaceRoot, node.filePath);
        return {
          projectName,
          includeGlob: rel,
          testNamePattern: TestRunner.escapeRegex(node.fullSuiteName),
          requestItems: items,
        };
      }

      case 'case': {
        const rel = path.relative(this.workspace.workspaceRoot, node.filePath);
        return {
          projectName,
          includeGlob: rel,
          testNamePattern: TestRunner.escapeRegex(node.fullTestName),
          requestItems: items,
        };
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Resolves the owning Angular project name for any TestNode kind.
   *
   * - ProjectNode / FileNode  → `projectName` is stored directly.
   * - SuiteNode / CaseNode    → look up the parent FileNode via the controller.
   */
  private resolveProjectName(node: TestNode): string | undefined {
    if (node.kind === 'project') return node.projectName;
    if (node.kind === 'file') return node.projectName;
    // Suite and case nodes don't store projectName directly.
    return this.ctrl.getProjectNameForFilePath(node.filePath);
  }

  // ─── Result application ───────────────────────────────────────────────────

  /**
   * Applies parsed Vitest output to the active TestRun.
   *
   * Strategy:
   *  1. Build failure → mark all request items as failed with the build error.
   *  2. Per-test case results → look up each case via `findCaseByName`, mark it
   *     passed/failed/skipped, and append its output to the Test Results panel.
   *  3. Roll-up → walk the TestItem tree upward from each request item, marking
   *     every suite/file/project with an aggregated status derived from its
   *     children, and appending a hierarchical child-list to the Test Results
   *     panel so the user sees each test nested under its parent.
   *  4. Edge-case fallback → if nothing was parsed, mark request items passed.
   */
  private applyParsedResults(
    parsed: ParsedRunResult,
    testRun: vscode.TestRun,
    fallbackItems: vscode.TestItem[],
  ): void {
    // ── Build failure ────────────────────────────────────────────────────────
    if (parsed.buildFailed) {
      const msg = new vscode.TestMessage(
        'Angular build failed:\n\n' +
          (parsed.buildError ?? 'See the output channel for details.'),
      );
      fallbackItems.forEach((item) => testRun.failed(item, msg));
      log('✗ Build failed — no tests ran.');
      return;
    }

    // ── Per-test case results ────────────────────────────────────────────────
    /**
     * Tracks which TestItem IDs are leaf case items and their final status.
     * Used by rollUpItem() to determine parent statuses without re-querying
     * the VS Code API (which has no "get current status" method).
     */
    const caseStatusMap = new Map<string, 'passed' | 'failed' | 'skipped'>();
    let matchedCount = 0;

    for (const caseResult of parsed.cases) {
      const testItem = this.ctrl.findCaseByName(
        caseResult.filePath,
        caseResult.fullTestName,
      );

      if (!testItem) {
        // Dynamic test name (e.g. .each parametrized) — can't map statically.
        warn(
          `Could not find TestItem for "${caseResult.fullTestName}" ` +
            `in ${caseResult.filePath} — dynamic test name?`,
        );
        continue;
      }

      caseStatusMap.set(testItem.id, caseResult.status);
      matchedCount++;

      const durationMs = parseDurationMs(caseResult.duration);
      const loc =
        testItem.uri && testItem.range
          ? new vscode.Location(testItem.uri, testItem.range.start)
          : undefined;

      switch (caseResult.status) {
        case 'passed':
          testRun.passed(testItem, durationMs);
          // Show just the local test name — the parent suite output will list
          // all children, so no need to repeat the full suite path here.
          testRun.appendOutput(`\r\n✅ ${testItem.label}\r\n`, loc, testItem);
          break;

        case 'skipped':
          testRun.skipped(testItem);
          testRun.appendOutput(
            `\r\n⏭️ ${testItem.label} (skipped)\r\n`,
            loc,
            testItem,
          );
          break;

        case 'failed': {
          const errText =
            caseResult.errorMessage ||
            'Test failed. See the output channel for details.';
          const msg = new vscode.TestMessage(errText);
          if (loc) {
            msg.location = loc;
          }
          testRun.failed(testItem, msg, durationMs);
          testRun.appendOutput(
            `\r\n❌ ${testItem.label}\r\n${errText.replace(/\n/g, '\r\n')}\r\n`,
            loc,
            testItem,
          );
          break;
        }
      }
    }

    log(`${matchedCount}/${parsed.cases.length} test case(s) matched to TestItems.`);

    // ── Roll up results to suite / file / project items ──────────────────────
    // Walk from each request item downward. Every intermediate node (suite,
    // file, project) is marked with the aggregated status of its children and
    // receives hierarchical output so the Test Results panel shows each test
    // nested under its parent suite.
    for (const item of fallbackItems) {
      this.rollUpItem(testRun, item, caseStatusMap);
    }

    // ── Edge-case fallback: nothing was parsed ───────────────────────────────
    // When Vitest produces no parseable output (very unusual), mark request
    // items as passed so they don't stay stuck in "running" state.
    if (parsed.cases.length === 0) {
      fallbackItems.forEach((item) => {
        if (!caseStatusMap.has(item.id)) {
          testRun.passed(item);
        }
      });
    }
  }

  /**
   * Recursively propagates case-level results up through the TestItem tree.
   *
   * Leaf case items:   already marked in the case loop — returns their status.
   * Suite/file items:  aggregates children's statuses, marks the item, and
   *                    appends a child-list to the Test Results output panel.
   *
   * Returns the aggregated status, or `null` when no cases ran under this item
   * (so the caller knows not to apply a status to it).
   */
  private rollUpItem(
    testRun: vscode.TestRun,
    item: vscode.TestItem,
    caseStatusMap: Map<string, 'passed' | 'failed' | 'skipped'>,
  ): 'passed' | 'failed' | 'skipped' | null {
    // ── Leaf case item: already marked above ─────────────────────────────────
    if (caseStatusMap.has(item.id)) {
      return caseStatusMap.get(item.id)!;
    }

    // ── No children: nothing ran under this item ─────────────────────────────
    if (item.children.size === 0) {
      return null;
    }

    // ── Recurse into children ────────────────────────────────────────────────
    interface ChildResult {
      label: string;
      status: 'passed' | 'failed' | 'skipped';
    }
    const childResults: ChildResult[] = [];

    item.children.forEach((child) => {
      const status = this.rollUpItem(testRun, child, caseStatusMap);
      if (status !== null) {
        childResults.push({ label: child.label, status });
      }
    });

    if (childResults.length === 0) {
      return null; // No cases ran under any child.
    }

    // ── Aggregate status ─────────────────────────────────────────────────────
    const aggregated: 'passed' | 'failed' | 'skipped' = childResults.some(
      (c) => c.status === 'failed',
    )
      ? 'failed'
      : childResults.some((c) => c.status === 'passed')
      ? 'passed'
      : 'skipped';

    const loc =
      item.uri && item.range
        ? new vscode.Location(item.uri, item.range.start)
        : undefined;

    // ── Mark this item ───────────────────────────────────────────────────────
    switch (aggregated) {
      case 'passed':
        testRun.passed(item);
        break;
      case 'failed': {
        const failCount = childResults.filter((c) => c.status === 'failed').length;
        testRun.failed(
          item,
          new vscode.TestMessage(`${failCount} child test(s) failed.`),
        );
        break;
      }
      case 'skipped':
        testRun.skipped(item);
        break;
    }

    // ── Append hierarchical output for the Test Results panel ────────────────
    // When the user clicks this suite/file item in the Test Results view, they
    // see its child tests listed with icons, nested one level below the parent.
    const headerIcon =
      aggregated === 'passed' ? '✅' : aggregated === 'failed' ? '❌' : '⏭️';
    const childLines = childResults
      .map((c) => {
        const icon =
          c.status === 'passed' ? '✅' : c.status === 'failed' ? '❌' : '⏭️';
        return `  ${icon} ${c.label}`;
      })
      .join('\r\n');

    testRun.appendOutput(
      `${headerIcon} ${item.label}\r\n${childLines}\r\n`,
      loc,
      item,
    );

    return aggregated;
  }

  /**
   * Escapes special regex metacharacters so a test name can be used safely
   * as a `--testNamePattern` value.
   */
  private static escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursively collects all descendant TestItems under the given item.
 *
 * This is used to enqueue/start/skip every case item in the tree whenever
 * a parent (file or project) item is selected for a run. VS Code only renders
 * pass/fail icons for items that were enrolled via testRun.enqueued() before
 * the run started — descendants that are never enrolled have their results
 * silently dropped even when passed()/failed() is called on them later.
 */
function collectDescendants(item: vscode.TestItem): vscode.TestItem[] {
  const result: vscode.TestItem[] = [];
  item.children.forEach((child) => {
    result.push(child);
    result.push(...collectDescendants(child));
  });
  return result;
}

/**
 * Converts a Vitest duration string (e.g. "3ms", "1.5s") to milliseconds.
 * Returns `undefined` if the string is falsy or unparseable.
 */
function parseDurationMs(duration?: string): number | undefined {
  if (!duration) {
    return undefined;
  }
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(duration.trim());
  if (!m) {
    return undefined;
  }
  const value = parseFloat(m[1]);
  return m[2] === 's' ? value * 1000 : value;
}

