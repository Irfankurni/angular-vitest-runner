/**
 * cliRunner.ts
 *
 * Phase 4 — Execution via Angular CLI (Child Process)
 *
 * Responsibilities:
 *  1. Locate the workspace-local Angular CLI binary (`./node_modules/.bin/ng`).
 *  2. Construct the correct `ng test` argument list for a given run target.
 *  3. Spawn the process and stream stdout/stderr to callers.
 *
 * Command shape:
 *   ng test <project> [--include=<glob>]
 *
 * Note: `@angular/build:unit-test` runs Vitest programmatically and does not
 * expose `--testNamePattern` (or `--reporter`) as CLI-passable builder options.
 * File-level filtering via `--include` is supported; test-name filtering is
 * handled at the output-parsing layer (Phase 5) or via a Vitest config file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { log, warn } from './logger';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface NgTestOptions {
  /** Absolute path to the workspace root — used as cwd for the process. */
  workspaceRoot: string;
  /** The Angular project name to pass to `ng test`. */
  projectName: string;
  /**
   * Glob or relative path passed as `--include` to the builder.
   * Used to filter execution to a specific spec file.
   */
  includeGlob?: string;
  /**
   * Desired test name pattern (stored for logging/future use).
   *
   * ⚠️  `@angular/build:unit-test` does NOT expose `--testNamePattern` as a
   * CLI-level builder option. When set, this value is only logged so the user
   * knows what was requested; the actual filter cannot be applied at the CLI
   * layer. Per-test filtering will be revisited in Phase 5/6.
   */
  testNamePattern?: string;
  /**
   * Override the path to the `ng` binary.
   * Defaults to workspace-local `./node_modules/.bin/ng`.
   */
  ngBinPath?: string;
}

export interface NgTestResult {
  /** Process exit code, or `null` if the process could not be spawned. */
  exitCode: number | null;
  /** All stdout collected from the process (contains Angular build logs + Vitest JSON). */
  stdout: string;
  /** All stderr collected from the process. */
  stderr: string;
}

// ─── CLI path resolution ──────────────────────────────────────────────────────

/**
 * Returns the absolute path to the `ng` CLI binary.
 *
 * Priority:
 *  1. User-configured override (`angularVitestRunner.ngCliPath`).
 *  2. Workspace-local `./node_modules/.bin/ng`.
 *  3. Global `ng` on PATH (fallback — may cause version mismatch).
 */
export function resolveNgPath(workspaceRoot: string, override?: string): string {
  if (override && override.trim().length > 0) {
    if (fs.existsSync(override)) {
      log(`Using configured ng path: ${override}`);
      return override;
    }
    warn(`Configured ngCliPath "${override}" not found — falling back.`);
  }

  const localNg = path.join(workspaceRoot, 'node_modules', '.bin', 'ng');
  if (fs.existsSync(localNg)) {
    log(`Using workspace-local Angular CLI: ${localNg}`);
    return localNg;
  }

  warn(
    '`./node_modules/.bin/ng` not found. ' +
      'Falling back to global `ng` — version mismatch is possible.',
  );
  return 'ng';
}

/**
 * Builds the `ng test` argument list.
 *
 * Only options present in `@angular/build:unit-test`'s JSON schema are
 * safe to pass. Unknown options cause schema validation failures.
 * Currently confirmed working: `--include` (file glob filter).
 *
 * `--testNamePattern` and `--reporter` are NOT in the schema — they are
 * omitted here. Per-test filtering will be explored in Phase 5/6.
 *
 * @returns An array of string arguments (does NOT include the binary name).
 */
export function buildNgTestArgs(options: NgTestOptions): string[] {
  const args: string[] = ['test', options.projectName];

  // File-level filter.
  if (options.includeGlob) {
    args.push(`--include=${options.includeGlob}`);
  }

  // Log the requested name pattern for diagnostics even though we can't
  // apply it at the CLI layer.
  if (options.testNamePattern) {
    log(
      `Note: --testNamePattern="${options.testNamePattern}" requested but not ` +
        'supported by @angular/build:unit-test CLI options. ' +
        'Running the whole file instead.',
    );
  }

  // Append any user-configured extra args from settings.
  const extraArgs: string[] = vscode.workspace
    .getConfiguration('angularVitestRunner')
    .get<string[]>('defaultArgs', []);
  args.push(...extraArgs);

  return args;
}


// ─── Process spawner ──────────────────────────────────────────────────────────

/**
 * Spawns `ng test` as a child process and resolves when the process exits.
 *
 * @param options     Run parameters (project, file filter, name pattern, etc.).
 * @param token       VS Code cancellation token — kills the process on cancel.
 * @param onStdout    Optional callback invoked for each stdout chunk (for live streaming).
 * @param onStderr    Optional callback invoked for each stderr chunk.
 */
export function spawnNgTest(
  options: NgTestOptions,
  token: vscode.CancellationToken,
  onStdout?: (chunk: string) => void,
  onStderr?: (chunk: string) => void,
): Promise<NgTestResult> {
  const ngBin = resolveNgPath(options.workspaceRoot, options.ngBinPath);
  const args = buildNgTestArgs(options);

  log(`Spawning: ${ngBin} ${args.join(' ')}`);
  log(`CWD: ${options.workspaceRoot}`);

  return new Promise<NgTestResult>((resolve) => {
    const proc = spawn(ngBin, args, {
      cwd: options.workspaceRoot,
      // Required on Windows where .bin entries are .cmd files.
      shell: process.platform === 'win32',
      // Inherit the parent environment so tools like nvm / volta work correctly.
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf-8');
      stdout += str;
      onStdout?.(str);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf-8');
      stderr += str;
      onStderr?.(str);
    });

    proc.on('error', (err) => {
      warn(`Failed to start process: ${err.message}`);
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n[spawn error] ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      log(`ng test exited with code: ${code}`);
      resolve({ exitCode: code, stdout, stderr });
    });

    // Honour VS Code cancellation.
    const cancelSub = token.onCancellationRequested(() => {
      log('Cancellation requested — terminating ng test process.');
      proc.kill('SIGTERM');
      cancelSub.dispose();
    });
  });
}
