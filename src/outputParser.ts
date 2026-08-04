/**
 * outputParser.ts
 *
 * Phase 5 — Output Sanitization & Result Parsing
 *
 * Parses the raw stdout from `ng test` (using `@angular/build:unit-test`)
 * into a structured list of per-test results.
 *
 * Why text parsing instead of JSON?
 *   `@angular/build:unit-test` runs Vitest programmatically and does not
 *   expose `--reporter=json` as a passable CLI option. The builder's schema
 *   rejects unknown flags. Text output parsing is therefore the only
 *   available strategy at this layer.
 *
 * Vitest verbose output format (after ANSI stripping):
 *
 *   ✓ src/app/app.component.spec.ts (3)        ← file header (1 space)
 *     ✓ AppComponent (3)                        ← describe block (3 spaces)
 *       ✓ should create the app 3ms             ← test case (5+ spaces)
 *       × should fail something 2ms             ← failed case
 *         → Expected: false                     ← error lines (more indented)
 *           Received: true
 *
 *   Test Files  1 passed (1)                    ← summary section
 *   Tests       2 passed | 1 failed (3)
 */

import * as path from 'path';

// ─── Public result types ──────────────────────────────────────────────────────

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestCaseResult {
  /**
   * Absolute path to the spec file.
   * Resolved from the relative path Vitest reports.
   */
  filePath: string;
  /**
   * Full test name used for TestItem lookup.
   * Format: "<suite1> <suite2> <testLabel>" (space-joined).
   * Matches CaseNode.fullTestName produced by specParser.ts.
   */
  fullTestName: string;
  status: TestStatus;
  /** Duration string as reported by Vitest (e.g. "3ms"). */
  duration?: string;
  /** Human-readable error description for failed tests. */
  errorMessage?: string;
}

export interface RunSummary {
  filesPassed: number;
  filesFailed: number;
  testsPassed: number;
  testsFailed: number;
  testsSkipped: number;
}

export interface ParsedRunResult {
  /** Individual test case results. Empty when the build itself failed. */
  cases: TestCaseResult[];
  /**
   * True when the Angular build step failed before Vitest ran.
   * In this case `cases` is empty and `buildError` contains the failure text.
   */
  buildFailed: boolean;
  buildError?: string;
  summary?: RunSummary;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Parses the combined stdout/stderr captured from a `ng test` process.
 *
 * @param rawOutput     Raw text from the process (may contain ANSI codes).
 * @param workspaceRoot Absolute workspace root used to resolve relative paths.
 */
export function parseRunOutput(
  rawOutput: string,
  workspaceRoot: string,
): ParsedRunResult {
  const clean = stripAnsi(rawOutput);
  const lines = clean.split(/\r?\n/);

  // ── Build failure guard ──────────────────────────────────────────────────
  if (isBuildFailed(lines)) {
    return {
      cases: [],
      buildFailed: true,
      buildError: extractBuildError(lines),
    };
  }

  const cases = parseVitestLines(lines, workspaceRoot);
  const summary = parseSummary(lines);

  return { cases, buildFailed: false, summary };
}

// ─── ANSI / terminal escape stripping ────────────────────────────────────────

// Matches ESC [ ... m / G / K / H / F color and cursor codes.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ─── Angular build-log detection ─────────────────────────────────────────────

/**
 * Patterns that identify Angular CLI / esbuild build log lines that should
 * be ignored during test-result parsing.
 */
const BUILD_LOG_RE: RegExp[] = [
  /^✔\s+/,                            // build success checkmarks
  /^▲\s+/,                            // esbuild warnings
  /bundle generation complete/i,
  /^Building/i,
  /^Compiling/i,
  /^Watch mode/i,
  /^Watching/i,
  /^\[Angular\]/,
  /^\[vite\]/i,
  /^\[esbuild\]/i,
  /^Application bundle/i,
  /^Initial chunk files/i,
  /^Lazy chunk files/i,
  /^Output location:/i,
  /\d+ dependencies optimized/i,
];

function isAngularBuildLine(line: string): boolean {
  const t = line.trimStart();
  return BUILD_LOG_RE.some((re) => re.test(t));
}

// ─── Build-failure detection ──────────────────────────────────────────────────

const BUILD_ERROR_RE: RegExp[] = [
  /^✘\s+\[ERROR\]/,
  /^Error:\s+/,
  /build failed/i,
  /compilation failed/i,
  /cannot find module/i,
];

/** True when the build failed BEFORE any Vitest output was produced. */
function isBuildFailed(lines: string[]): boolean {
  const hasVitestOutput = lines.some(isVitestResultLine);
  if (hasVitestOutput) {
    return false;
  }
  return lines.some((l) => BUILD_ERROR_RE.some((re) => re.test(l)));
}

function isVitestResultLine(line: string): boolean {
  return /^\s+[✓×✗↓]\s/.test(line);
}

function extractBuildError(lines: string[]): string {
  const errorLines: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (!capturing && BUILD_ERROR_RE.some((re) => re.test(line))) {
      capturing = true;
    }
    if (capturing) {
      errorLines.push(line);
      if (errorLines.length >= 25) {
        break;
      }
    }
  }

  return (
    errorLines.join('\n').trim() ||
    'Angular build failed. See the "Angular Vitest Runner" output channel for details.'
  );
}

// ─── Vitest result-line marker helpers ────────────────────────────────────────

// Symbols emitted by Vitest reporters.
const SYM_PASS = '\u2713'; // ✓
const SYM_FAIL_A = '\u00d7'; // ×
const SYM_FAIL_B = '\u2717'; // ✗
const SYM_SKIP = '\u2193'; // ↓

interface MarkerInfo {
  status: TestStatus;
  content: string; // text after the symbol, trimmed of trailing whitespace
  indent: number;  // number of leading spaces
}

/**
 * Parses a single Vitest result line.
 * Returns `undefined` for lines that don't start with a result marker.
 */
function parseMarkerLine(line: string): MarkerInfo | undefined {
  // Match: <spaces><symbol><space><rest>
  const m = /^( *)([\u2713\u00d7\u2717\u2193]) (.+)$/.exec(line);
  if (!m) {
    return undefined;
  }

  const indent = m[1].length;
  const sym = m[2];
  const content = m[3].trimEnd();

  let status: TestStatus;
  if (sym === SYM_PASS) {
    status = 'passed';
  } else if (sym === SYM_SKIP) {
    status = 'skipped';
  } else {
    status = 'failed';
  }

  return { status, content, indent };
}

// ─── Content classification ───────────────────────────────────────────────────

// Matches a timing suffix such as "3ms", "1.5s", "120ms"
const TIMING_RE = /\s+\d+(?:\.\d+)?(ms|s)$/;

// Matches a suite/file count suffix like "(3)" or "(1 failed | 2 passed)"
const COUNT_RE = /\s+\(\d+(?:\s+\w+(?:\s*\|\s*\d+\s+\w+)*)?\)\s*$/;

// Spec file extension
const SPEC_EXT_RE = /\.(spec|test)\.(ts|tsx|js|jsx|mts|mjs)\s*$/;

/** True when the content is a test-case line (has timing at the end). */
function isTestCase(content: string): boolean {
  return TIMING_RE.test(content);
}

/** True when the content refers to a spec file. */
function isSpecFile(content: string): boolean {
  const base = content.replace(COUNT_RE, '').trim();
  return SPEC_EXT_RE.test(base);
}

function stripTimingSuffix(content: string): { name: string; duration: string } {
  const m = TIMING_RE.exec(content);
  if (!m) {
    return { name: content.trim(), duration: '' };
  }
  const duration = content.slice(m.index).trim();
  const name = content.slice(0, m.index).trim();
  return { name, duration };
}

function stripCountSuffix(content: string): string {
  return content.replace(COUNT_RE, '').trim();
}

// ─── State-machine parser ─────────────────────────────────────────────────────

interface SuiteFrame {
  name: string;
  indent: number;
}

interface ParserState {
  currentFileRelative: string;
  suiteStack: SuiteFrame[];
  currentCase: TestCaseResult | undefined;
  errorLines: string[];
  results: TestCaseResult[];
}

function flushCurrentCase(state: ParserState): void {
  if (!state.currentCase) {
    return;
  }
  if (state.errorLines.length > 0) {
    state.currentCase.errorMessage = state.errorLines.join('\n').trim();
  }
  state.results.push(state.currentCase);
  state.currentCase = undefined;
  state.errorLines = [];
}

/**
 * Core parser: processes lines in order, maintaining a state machine to
 * track the current file, the active describe-block stack, and error capture.
 */
function parseVitestLines(
  lines: string[],
  workspaceRoot: string,
): TestCaseResult[] {
  const state: ParserState = {
    currentFileRelative: '',
    suiteStack: [],
    currentCase: undefined,
    errorLines: [],
    results: [],
  };

  for (const line of lines) {
    // Always skip Angular build log noise.
    if (isAngularBuildLine(line)) {
      continue;
    }

    const marker = parseMarkerLine(line);

    if (!marker) {
      // Could be an error-detail line after a failed test.
      if (state.currentCase?.status === 'failed' && line.trim().length > 0) {
        // Only capture lines that are more indented than the previous content lines,
        // and stop at summary lines.
        if (!/^\s+(Test Files|Tests|Start at|Duration)\s/.test(line)) {
          state.errorLines.push(line.trimStart());
        }
      }
      continue;
    }

    const { status, content, indent } = marker;

    if (isSpecFile(content)) {
      // ── File-level line ─────────────────────────────────────────────────
      flushCurrentCase(state);
      state.currentFileRelative = stripCountSuffix(content);
      state.suiteStack = [];
    } else if (isTestCase(content)) {
      // ── Test case line ───────────────────────────────────────────────────
      flushCurrentCase(state);

      const { name: caseName, duration } = stripTimingSuffix(content);

      // Build the full test name by joining ancestor suite names with a space.
      // We only include suites whose indent is strictly less than the case indent.
      const suiteNames = state.suiteStack
        .filter((f) => f.indent < indent)
        .map((f) => f.name);
      const fullTestName = [...suiteNames, caseName].join(' ');

      const absFilePath = state.currentFileRelative
        ? path.isAbsolute(state.currentFileRelative)
          ? state.currentFileRelative
          : path.join(workspaceRoot, state.currentFileRelative)
        : '';

      state.currentCase = {
        filePath: absFilePath,
        fullTestName,
        status,
        duration: duration || undefined,
      };
    } else {
      // ── Suite (describe-block) line ──────────────────────────────────────
      flushCurrentCase(state);

      const suiteName = stripCountSuffix(content);

      // Pop any suites at the same or deeper indentation (we're returning
      // to a shallower nesting level).
      while (
        state.suiteStack.length > 0 &&
        state.suiteStack[state.suiteStack.length - 1].indent >= indent
      ) {
        state.suiteStack.pop();
      }
      state.suiteStack.push({ name: suiteName, indent });
    }
  }

  flushCurrentCase(state);
  return state.results;
}

// ─── Summary extraction ───────────────────────────────────────────────────────

const TEST_FILES_SUMMARY_RE = /^\s+Test Files\s+(.+)$/;
const TESTS_SUMMARY_RE = /^\s+Tests\s+(.+)$/;

function parseSummary(lines: string[]): RunSummary | undefined {
  let filesText = '';
  let testsText = '';

  for (const line of lines) {
    const tf = TEST_FILES_SUMMARY_RE.exec(line);
    if (tf) {
      filesText = tf[1];
    }
    const ts = TESTS_SUMMARY_RE.exec(line);
    if (ts) {
      testsText = ts[1];
    }
  }

  if (!filesText && !testsText) {
    return undefined;
  }

  return {
    filesPassed: extractSummaryCount(filesText, 'passed'),
    filesFailed: extractSummaryCount(filesText, 'failed'),
    testsPassed: extractSummaryCount(testsText, 'passed'),
    testsFailed: extractSummaryCount(testsText, 'failed'),
    testsSkipped: extractSummaryCount(testsText, 'skipped'),
  };
}

/**
 * Extracts a named count from a Vitest summary string.
 * Examples:
 *   "3 passed (3)"            → passed=3
 *   "1 failed | 2 passed (3)" → failed=1, passed=2
 */
function extractSummaryCount(text: string, label: string): number {
  const m = new RegExp(`(\\d+)\\s+${label}`).exec(text);
  return m ? parseInt(m[1], 10) : 0;
}
