/**
 * projectResolver.ts
 *
 * Phase 1 — Path Resolution Utility
 *
 * Given an absolute path to a `.spec.ts` file, determine which Angular project
 * it belongs to by comparing the file path against each project's `root` and
 * `sourceRoot` directories.
 *
 * This is used in later phases to know which `ng test <project>` command to
 * invoke when the developer triggers a test run for a specific file.
 */

import * as path from 'path';
import { AngularProject, AngularWorkspace } from './angularWorkspace';
import { log, warn } from './logger';

// ─── Main resolver ────────────────────────────────────────────────────────────

export class ProjectResolver {
  private readonly workspace: AngularWorkspace;

  constructor(workspace: AngularWorkspace) {
    this.workspace = workspace;
  }

  /**
   * Returns the `AngularProject` that owns the given spec file, or `undefined`
   * if no project claims it.
   *
   * Resolution strategy (first match wins):
   *  1. The file path starts with the project's `sourceRoot`.
   *  2. The file path starts with the project's `root`.
   *
   * When multiple projects could match (e.g. a library inside an app), the
   * project with the **longest** matching prefix is preferred (most-specific).
   */
  resolveProject(specFilePath: string): AngularProject | undefined {
    const normalized = normalizePath(specFilePath);

    let bestMatch: AngularProject | undefined;
    let bestMatchLength = 0;

    for (const project of this.workspace.allProjects()) {
      const sourceRootMatch = matchPrefix(normalized, project.sourceRoot);
      const rootMatch = matchPrefix(normalized, project.root);
      const matchLength = Math.max(sourceRootMatch, rootMatch);

      if (matchLength > bestMatchLength) {
        bestMatchLength = matchLength;
        bestMatch = project;
      }
    }

    if (bestMatch) {
      log(
        `Resolved "${path.basename(specFilePath)}" → project "${bestMatch.name}"`,
      );
    } else {
      warn(
        `Could not resolve a Vitest project for: ${specFilePath}. ` +
          `Make sure the file is inside a project root defined in angular.json.`,
      );
    }

    return bestMatch;
  }

  /**
   * Returns the path of `specFilePath` relative to the workspace root.
   * Used when constructing the `--include` argument for `ng test`.
   */
  relativeToWorkspace(specFilePath: string): string {
    return path.relative(this.workspace.workspaceRoot, specFilePath);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalizes a path to use forward slashes and ensures there is a trailing
 * separator so that prefix matching doesn't accidentally match a sibling
 * directory (e.g. "projects/foo-extra" matching "projects/foo").
 */
function normalizePath(p: string): string {
  return path.normalize(p).replace(/\\/g, '/');
}

/**
 * Returns the length of the common prefix between `filePath` and `dir`.
 * Returns 0 if `filePath` is not inside `dir`.
 */
function matchPrefix(filePath: string, dir: string): number {
  const normalizedDir = normalizePath(dir);
  // Ensure the directory ends with a separator for safe prefix comparison.
  const dirWithSep = normalizedDir.endsWith('/')
    ? normalizedDir
    : `${normalizedDir}/`;

  if (filePath.startsWith(dirWithSep)) {
    return dirWithSep.length;
  }
  return 0;
}
