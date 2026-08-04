/**
 * logger.ts
 *
 * A singleton output channel for all extension log messages.
 * Use this instead of console.log so that output is surfaced in the
 * "Angular Vitest Runner" output panel rather than the Developer Console.
 */
import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

/**
 * Returns (and lazily creates) the shared output channel.
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('Angular Vitest Runner');
  }
  return _channel;
}

export function log(message: string): void {
  getOutputChannel().appendLine(`[INFO]  ${timestamp()} ${message}`);
}

export function warn(message: string): void {
  getOutputChannel().appendLine(`[WARN]  ${timestamp()} ${message}`);
}

export function error(message: string, err?: unknown): void {
  const detail = err instanceof Error ? ` — ${err.message}` : '';
  getOutputChannel().appendLine(`[ERROR] ${timestamp()} ${message}${detail}`);
}

export function disposeOutputChannel(): void {
  _channel?.dispose();
  _channel = undefined;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toISOString();
}
