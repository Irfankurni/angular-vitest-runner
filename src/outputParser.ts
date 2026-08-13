/**
 * outputParser.ts
 *
 * Output Sanitization & Result Parsing
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
 *       × should fail something 2ms             ← failed case (no error here)
 *
 *   ⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯            ← error detail block (bottom)
 *    FAIL  src/app/app.component.spec.ts > AppComponent > should fail something
 *
 *   AssertionError: expected true to equal false
 *    ❯ Object.<anonymous> src/app/spec.ts:12:5
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
  debugLog?: (msg: string) => void,
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

  // Enrich failed cases with error details from the "Failed Tests" block
  // that Vitest emits at the bottom of its output.
  const failedDetails = parseFailedTestsSection(lines, workspaceRoot, debugLog);

  debugLog?.(`[parseRunOutput] failedDetails map has ${failedDetails.size} entry(ies):`);
  failedDetails.forEach((msg, key) => {
    debugLog?.(`  key="${key}"  msg=${msg.slice(0, 80).replace(/\n/g, '↵')}`);
  });

  for (const c of cases) {
    if (c.status === 'failed') {
      // 1) Exact key match (filePath::fullTestName)
      const lookupKey = `${c.filePath}::${c.fullTestName}`;
      let detail = failedDetails.get(lookupKey);

      // 2) Fuzzy match: try matching by test name only (handles path differences)
      if (!detail) {
        for (const [key, msg] of failedDetails) {
          const storedName = key.split('::')[1];
          if (storedName === c.fullTestName) {
            detail = msg;
            debugLog?.(`[parseRunOutput] fuzzy name match for "${c.fullTestName}"`);
            break;
          }
        }
      }

      debugLog?.(`[parseRunOutput] looking up key="${lookupKey}" → ${detail ? 'FOUND' : 'NOT FOUND'}`);
      if (detail) {
        c.errorMessage = detail;
      }
    }
  }

  // 3) Last-resort fallback: for any failed case still without an error message,
  //    search the raw output directly for error text near the test name.
  for (const c of cases) {
    if (c.status === 'failed' && !c.errorMessage) {
      const fallback = extractFallbackError(lines, c.fullTestName, debugLog);
      if (fallback) {
        c.errorMessage = fallback;
        debugLog?.(`[parseRunOutput] fallback error extracted for "${c.fullTestName}"`);
      }
    }
  }

  const summary = parseSummary(lines);

  return { cases, buildFailed: false, summary };
}

// ─── ANSI / terminal escape stripping ────────────────────────────────────────

// Matches ESC [ ... m / G / K / H / F color and cursor codes.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// Also matches OSC sequences (e.g. hyperlinks: ESC ] ... ESC \ or BEL)
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Bell character (sometimes used as OSC terminator residue)
const BELL_RE = /\x07/g;

function stripAnsi(s: string): string {
  return s.replace(OSC_RE, '').replace(ANSI_RE, '').replace(BELL_RE, '');
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
const SYM_RUNNING = '\u276f'; // ❯  file/suite with mixed results

interface MarkerInfo {
  status: TestStatus;
  content: string; // text after the symbol, trimmed of trailing whitespace
  indent: number;  // number of leading spaces
}

/**
 * Parses a single Vitest result line.
 * Returns `undefined` for lines that don't start with a result marker.
 *
 * Handles both:
 *   ✓/×/↓  (single trailing space, classic format)
 *   ❯       (one or more trailing spaces, used for files/suites with failures)
 */
function parseMarkerLine(line: string): MarkerInfo | undefined {
  // \s+ handles variable spacing after ❯ (which uses 2 spaces in Angular output)
  const m = /^( *)([\u2713\u00d7\u2717\u2193\u276f])\s+(.+)$/.exec(line);
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
  } else if (sym === SYM_RUNNING) {
    // ❯ is a structural marker (file/suite has mixed results).
    // Treat as 'passed' here; actual child results determine real status.
    status = 'passed';
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

// Matches a spec/test file extension anywhere in a string (no end-anchor,
// so it works when the path is followed by counts, timing, or project names).
const SPEC_EXT_RE = /\.(spec|test)\.(ts|tsx|js|jsx|mts|mjs)/;

/** True when the content is a test-case line (has timing at the end). */
function isTestCase(content: string): boolean {
  return TIMING_RE.test(content);
}

/** True when the content refers to a spec file (path appears anywhere in string). */
function isSpecFile(content: string): boolean {
  return SPEC_EXT_RE.test(content);
}

/**
 * Extracts the bare relative spec-file path from a Vitest file-header content
 * string that may contain a leading project name and trailing count/timing.
 *
 * Examples:
 *   "test-project  src/app/app.spec.ts (2 tests | 1 failed) 123ms"
 *     → "src/app/app.spec.ts"
 *   "src/app/app.component.spec.ts (3)"
 *     → "src/app/app.component.spec.ts"
 */
function extractSpecFilePath(content: string): string {
  // Match: optional non-space chars + 2-or-more spaces (project prefix), then
  // capture a path segment ending with a spec/test extension.
  const m = /(\S+\.(?:spec|test)\.(?:ts|tsx|js|jsx|mts|mjs))/.exec(content);
  return m ? m[1] : '';
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
    // Trim trailing blank lines and join.
    const trimmed = state.errorLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n') // collapse 3+ blank lines → 2
      .trim();
    state.currentCase.errorMessage = trimmed;
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
      // Accumulate error-detail lines (Expected/Received/stack traces)
      // that appear between two test marker lines.
      // We capture them regardless of indentation — just skip Vitest summary
      // footer lines and blank lines at the start of a block.
      if (state.currentCase?.status === 'failed') {
        if (/^\s*(Test Files|Tests|Start at|Duration)\s/.test(line)) {
          // Summary footer — stop capturing.
          flushCurrentCase(state);
        } else if (/Failed Tests/i.test(line)) {
          // "Failed Tests" section start — stop inline capture.
          // The dedicated parseFailedTestsSection() will handle these.
          flushCurrentCase(state);
        } else if (state.errorLines.length < 50) {
          // Skip leading blank lines, but allow blank lines within the block.
          if (line.trim().length > 0 || state.errorLines.length > 0) {
            state.errorLines.push(line.trimEnd());
          }
        }
      }
      continue;
    }

    // A new marker line always flushes whatever case was open.
    flushCurrentCase(state);

    const { status, content, indent } = marker;

    if (isSpecFile(content)) {
      // ── File-level line ─────────────────────────────────────────────────
      // Use extractSpecFilePath to strip any leading "projectName  " prefix
      // and any trailing count/timing suffixes.
      state.currentFileRelative = extractSpecFilePath(content);
      state.suiteStack = [];
    } else if (isTestCase(content)) {
      // ── Test case line ───────────────────────────────────────────────────
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

// ─── Failed-tests detail section parser ──────────────────────────────────────

/**
 * Parses the "Failed Tests N" detail block that Vitest emits at the bottom
 * of verbose output. This is where the actual AssertionErrors / stack traces
 * live — NOT inline after the × result line.
 *
 * Format (after ANSI stripping):
 *
 *   ⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯
 *
 *    FAIL  src/app/app.component.spec.ts > AppComponent > should fail 2ms
 *
 *   AssertionError: expected false to equal true
 *   Expected: true
 *   Received: false
 *    ❯ Object.<anonymous> src/app/spec.ts:10:5
 *
 *   ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
 *
 * Returns a Map keyed by "<absFilePath>::<fullTestName>" → error message.
 * The fullTestName uses the same space-joined format as parseVitestLines().
 */
function parseFailedTestsSection(
  lines: string[],
  workspaceRoot: string,
  debugLog?: (msg: string) => void,
): Map<string, string> {
  const result = new Map<string, string>();

  // The section header contains "Failed Tests" with an optional count.
  // e.g. "⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯" or "⎯⎯⎯⎯ Failed Tests ⎯⎯⎯⎯"
  const SECTION_START_RE = /Failed Tests(?:\s+\d+)?/i;

  // Each failed entry header: " FAIL  <relPath> > <suite> > <test> [timing]"
  // May also appear as:        " FAIL  <relPath>" (file-level failure)
  const FAIL_HEADER_RE = /^\s*FAIL\s+(.+)$/;

  // Long separator lines that divide sections (⎯ U+2015, – U+2013, — U+2014, or ─ U+2500 or -)
  // Check against trimmed line to handle any leading spaces.
  const SEPARATOR_RE = /^[⎯\-─—=]{10,}/;

  let inSection = false;
  let currentAbsPath = '';
  let currentTestName = '';
  let currentLines: string[] = [];

  function flush(): void {
    if (currentAbsPath && currentTestName && currentLines.length > 0) {
      const message = currentLines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (message) {
        debugLog?.(`[parseFailedTestsSection] storing key="${currentAbsPath}::${currentTestName}"`);
        result.set(`${currentAbsPath}::${currentTestName}`, message);
      }
    }
    currentAbsPath = '';
    currentTestName = '';
    currentLines = [];
  }

  for (const line of lines) {
    if (!inSection) {
      if (SECTION_START_RE.test(line)) {
        debugLog?.(`[parseFailedTestsSection] section start found: ${line.trim().slice(0, 60)}`);
        inSection = true;
      }
      continue;
    }

    // A FAIL header starts a new failed-test block.
    // Format: " FAIL   [projectName  ]relPath > suite > testName [timing]"
    const failMatch = FAIL_HEADER_RE.exec(line);
    if (failMatch) {
      flush();

      // Strip optional trailing timing (e.g. "35ms").
      const raw = failMatch[1].trim().replace(/\s+\d+(?:\.\d+)?(ms|s)\s*$/, '');
      const parts = raw.split(/\s+>\s+/);

      // parts[0] may be "projectName  relPath" (2+ spaces separate them).
      // Use extractSpecFilePath to get just the bare relative path.
      const relPath = extractSpecFilePath(parts[0]);
      // Also strip timing from individual test parts (defensive).
      const testParts = parts.slice(1).map(
        (s) => s.trim().replace(/\s+\d+(?:\.\d+)?(ms|s)\s*$/, ''),
      );

      currentAbsPath = relPath
        ? path.isAbsolute(relPath)
          ? relPath
          : path.join(workspaceRoot, relPath)
        : '';

      // fullTestName uses space-joining to match the format built by parseVitestLines.
      currentTestName = testParts.join(' ');
      debugLog?.(`[parseFailedTestsSection] FAIL header → path="${currentAbsPath}" testName="${currentTestName}"`);
      continue;
    }

    // A separator line ends the current block (but don't stop scanning —
    // there may be more FAIL blocks).
    // Check trimStart() to handle any incidental leading spaces.
    if (SEPARATOR_RE.test(line.trimStart())) {
      flush();
      continue;
    }

    // Accumulate error body lines (skip leading blank lines only).
    if (currentTestName && currentLines.length < 60) {
      if (line.trim().length > 0 || currentLines.length > 0) {
        currentLines.push(line.trimEnd());
      }
    }
  }

  flush();
  return result;
}

// ─── Fallback error extractor ─────────────────────────────────────────────────

/**
 * Last-resort error extraction: searches the raw output for a FAIL header
 * that matches the given test name (using fuzzy matching), then collects
 * the error body lines.
 *
 * This handles cases where parseFailedTestsSection() fails due to:
 * - Path/key mismatches
 * - Unexpected output formatting
 * - Different Vitest versions or reporters
 */
function extractFallbackError(
  lines: string[],
  testName: string,
  debugLog?: (msg: string) => void,
): string | undefined {
  // Split the test name into its component parts for matching.
  // e.g. "AppComponent should render title" → ["AppComponent", "should", "render", "title"]
  const nameParts = testName.split(/\s+/);
  // Also try matching against the last part (test case name is often unique).
  const lastPart = nameParts[nameParts.length - 1];

  let inFailedSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track when we enter the Failed Tests section.
    if (/Failed Tests/i.test(line)) {
      inFailedSection = true;
      continue;
    }

    if (!inFailedSection) {
      continue;
    }

    // Look for a FAIL header that contains our test name parts.
    // FAIL headers use " > " to separate path > suite > test.
    if (!/^\s*FAIL\s/i.test(line)) {
      continue;
    }

    // Extract parts from the FAIL header and check if they match.
    // The FAIL header looks like: "FAIL  path > Suite > test name [timing]"
    const headerParts = line.split(/\s+>\s+/);
    // Join all parts after the path and flatten into words.
    const headerWords = headerParts
      .slice(1)
      .join(' ')
      .replace(/\s+\d+(?:\.\d+)?(ms|s)\s*$/, '') // strip timing
      .split(/\s+/)
      .filter((w) => w.length > 0);

    // Check if a sufficient number of test name parts appear in the header.
    const matchCount = nameParts.filter((part) =>
      headerWords.some((hw) => hw === part),
    ).length;

    // Require at least 50% of parts to match, or that the last word matches.
    const threshold = Math.max(1, Math.ceil(nameParts.length * 0.5));
    if (matchCount < threshold && !headerWords.includes(lastPart)) {
      continue;
    }

    debugLog?.(`[extractFallbackError] matched FAIL header for "${testName}" at line ${i}`);

    // Capture error body lines until the next FAIL header, separator, or summary.
    const errorLines: string[] = [];
    for (let j = i + 1; j < lines.length && errorLines.length < 40; j++) {
      const el = lines[j];
      if (
        /^\s*FAIL\s/i.test(el) ||
        /^[⎯\-─—=]{10,}/.test(el.trimStart()) ||
        /^\s*(Test Files|Tests|Start at|Duration)\s/.test(el)
      ) {
        break;
      }
      if (el.trim().length > 0 || errorLines.length > 0) {
        errorLines.push(el.trimEnd());
      }
    }

    if (errorLines.length > 0) {
      return errorLines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  }

  return undefined;
}
