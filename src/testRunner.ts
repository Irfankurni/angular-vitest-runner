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

      // Mark all participating items as enqueued before spawning anything.
      groups.forEach((g) => g.requestItems.forEach((item) => testRun.enqueued(item)));

      // Resolve the ng binary once (shared across all groups).
      const ngBinPath = resolveNgPath(
        this.workspace.workspaceRoot,
        vscode.workspace.getConfiguration('angularVitestRunner').get<string>('ngCliPath', ''),
      );

      for (const group of groups) {
        if (token.isCancellationRequested) {
          group.requestItems.forEach((item) => testRun.skipped(item));
          continue;
        }

        // ── Mark as started ────────────────────────────────────────────────
        group.requestItems.forEach((item) => testRun.started(item));

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
          group.requestItems.forEach((item) => testRun.skipped(item));
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
   *  2. Per-test results → look up each case via `findCaseByName` and mark it.
   *  3. Fallback items (project/file level) → derive status from the parsed
   *     summary or the set of case results.
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
    const updated = new Set<string>();
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

      updated.add(testItem.id);
      matchedCount++;

      const durationMs = parseDurationMs(caseResult.duration);

      switch (caseResult.status) {
        case 'passed':
          testRun.passed(testItem, durationMs);
          // Show the test title in the Test Results output panel.
          testRun.appendOutput(
            `\r\n✅ ${caseResult.fullTestName}\r\n`,
            testItem.uri && testItem.range
              ? new vscode.Location(testItem.uri, testItem.range.start)
              : undefined,
            testItem,
          );
          break;
        case 'skipped':
          testRun.skipped(testItem);
          // Show the test title in the Test Results output panel.
          testRun.appendOutput(
            `\r\n⏭️ ${caseResult.fullTestName} (skipped)\r\n`,
            testItem.uri && testItem.range
              ? new vscode.Location(testItem.uri, testItem.range.start)
              : undefined,
            testItem,
          );
          break;
        case 'failed': {
          const errText =
            caseResult.errorMessage ||
            'Test failed. See the output channel for details.';
          const msg = new vscode.TestMessage(errText);
          if (testItem.uri && testItem.range) {
            msg.location = new vscode.Location(testItem.uri, testItem.range.start);
          }
          testRun.failed(testItem, msg, durationMs);

          // Show the test title and error details in the Test Results output panel.
          const outputText =
            `\r\n❌ ${caseResult.fullTestName}\r\n` +
            errText.replace(/\n/g, '\r\n') +
            '\r\n';
          testRun.appendOutput(
            outputText,
            testItem.uri && testItem.range
              ? new vscode.Location(testItem.uri, testItem.range.start)
              : undefined,
            testItem,
          );
          break;
        }
      }
    }

    log(
      `${matchedCount}/${parsed.cases.length} test case(s) matched to TestItems.`,
    );

    // ── Fallback items (project / file / suite level) ────────────────────────
    const allPassed = parsed.cases.length > 0 &&
      parsed.cases.every((c) => c.status === 'passed');
    const anyFailed = parsed.cases.some((c) => c.status === 'failed');

    for (const item of fallbackItems) {
      if (updated.has(item.id)) {
        continue; // Already handled as a case item.
      }
      if (allPassed) {
        testRun.passed(item);
      } else if (anyFailed) {
        // Aggregate error messages from individual failed cases.
        const failedCases = parsed.cases.filter((c) => c.status === 'failed');
        const errorDetail = failedCases
          .map((c) => {
            const header = `✗ ${c.fullTestName}`;
            return c.errorMessage
              ? `${header}\n${c.errorMessage}`
              : header;
          })
          .join('\n\n─────────────────────────────────────\n\n');

        const msg = new vscode.TestMessage(
          errorDetail ||
            `${failedCases.length} test(s) failed. See the output channel for details.`,
        );
        testRun.failed(item, msg);
      } else if (parsed.cases.length === 0) {
        // Nothing was parsed from output (unusual).
        testRun.passed(item);
      }
    }
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

