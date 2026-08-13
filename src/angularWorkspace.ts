/**
 * angularWorkspace.ts
 *
 * Workspace Initialization & Context Mapping
 *
 * Responsibilities:
 *  1. Locate and read the `angular.json` file in the workspace root.
 *  2. Parse every project entry and extract its `root` / `sourceRoot`.
 *  3. Verify that the project's `architect.test.builder` is a Vitest-compatible
 *     builder (e.g. `@analogjs/platform:vitest`).
 *  4. Expose the parsed project map for use by the rest of the extension.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { log, warn, error } from './logger';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A single Angular project entry extracted from angular.json.
 */
export interface AngularProject {
  /** The key name in `angular.json` projects map, e.g. "my-app". */
  name: string;
  /** Absolute path to the project root directory. */
  root: string;
  /** Absolute path to the project source root (may equal `root`). */
  sourceRoot: string;
  /** The Vitest builder identifier, e.g. `@analogjs/platform:vitest`. */
  vitestBuilder: string;
}

/**
 * The parsed angular.json schema (subset we care about).
 */
interface AngularJson {
  projects: Record<string, RawAngularProject>;
}

interface RawAngularProject {
  root?: string;
  sourceRoot?: string;
  architect?: {
    test?: {
      builder?: string;
      options?: Record<string, unknown>;
    };
  };
}

// ─── Known Vitest builder identifiers ────────────────────────────────────────

/**
 * Builder strings that confirm a project is configured to use Vitest.
 * Extend this list as the ecosystem grows.
 */
const VITEST_BUILDERS: ReadonlyArray<string> = [
  '@angular/build:unit-test',   // Angular v19+ built-in Vitest builder
  '@analogjs/platform:vitest',  // AnalogJS
  '@nx/vite:test',              // Nx + Vite
  'nx:vitest',                  // Nx Vitest executor
];

// ─── Main class ───────────────────────────────────────────────────────────────

export class AngularWorkspace {
  /** Absolute path to the workspace root that contains angular.json. */
  public readonly workspaceRoot: string;

  /** All Vitest-enabled Angular projects discovered in angular.json. */
  public readonly projects: ReadonlyMap<string, AngularProject>;

  private constructor(
    workspaceRoot: string,
    projects: Map<string, AngularProject>,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.projects = projects;
  }

  // ─── Factory ───────────────────────────────────────────────────────────────

  /**
   * Tries to load and parse `angular.json` from the given workspace root.
   * Returns `undefined` if the file is absent or malformed.
   */
  static async load(
    workspaceRoot: string,
  ): Promise<AngularWorkspace | undefined> {
    const angularJsonPath = path.join(workspaceRoot, 'angular.json');

    if (!fs.existsSync(angularJsonPath)) {
      warn(`angular.json not found at: ${angularJsonPath}`);
      return undefined;
    }

    let raw: AngularJson;
    try {
      const content = fs.readFileSync(angularJsonPath, 'utf-8');
      raw = JSON.parse(content) as AngularJson;
    } catch (err) {
      error(`Failed to parse angular.json`, err);
      return undefined;
    }

    if (!raw.projects || typeof raw.projects !== 'object') {
      warn('angular.json contains no "projects" key.');
      return undefined;
    }

    const projects = new Map<string, AngularProject>();

    for (const [name, rawProject] of Object.entries(raw.projects)) {
      const builder = rawProject.architect?.test?.builder ?? '';

      if (!isVitestBuilder(builder)) {
        log(
          `Skipping project "${name}": builder "${builder}" is not a Vitest builder.`,
        );
        continue;
      }

      const root = path.resolve(
        workspaceRoot,
        rawProject.root ?? '',
      );
      const sourceRoot = path.resolve(
        workspaceRoot,
        rawProject.sourceRoot ?? rawProject.root ?? '',
      );

      projects.set(name, { name, root, sourceRoot, vitestBuilder: builder });
      log(`Discovered Vitest project: "${name}" (builder: ${builder})`);
    }

    if (projects.size === 0) {
      warn(
        'No Angular projects with a Vitest builder were found in angular.json.',
      );
    }

    return new AngularWorkspace(workspaceRoot, projects);
  }

  // ─── Public helpers ────────────────────────────────────────────────────────

  /**
   * Returns `true` if any Vitest-enabled project was found.
   */
  get hasVitestProjects(): boolean {
    return this.projects.size > 0;
  }

  /**
   * Iterates over all known projects.
   */
  allProjects(): AngularProject[] {
    return Array.from(this.projects.values());
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Checks whether a builder string is a known Vitest-compatible builder.
 * Performs an exact match against the allow-list first, then falls back to
 * a substring check for custom/community builders that contain "vitest".
 */
function isVitestBuilder(builder: string): boolean {
  if (!builder) {
    return false;
  }
  if (VITEST_BUILDERS.includes(builder)) {
    return true;
  }
  // Fallback: any builder whose name contains "vitest" (case-insensitive).
  return builder.toLowerCase().includes('vitest');
}

// ─── Workspace loader (entry point used from extension.ts) ────────────────────

/**
 * Resolves the workspace root from VS Code's workspace folders and loads the
 * AngularWorkspace. Returns `undefined` if the workspace is not suitable.
 */
export async function loadAngularWorkspace(): Promise<
  AngularWorkspace | undefined
> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    warn('No workspace folder is open.');
    return undefined;
  }

  // In a multi-root workspace, search each folder for angular.json.
  for (const folder of folders) {
    const ws = await AngularWorkspace.load(folder.uri.fsPath);
    if (ws) {
      log(
        `Angular workspace loaded from: ${folder.uri.fsPath} ` +
          `(${ws.projects.size} Vitest project(s))`,
      );
      return ws;
    }
  }

  return undefined;
}
