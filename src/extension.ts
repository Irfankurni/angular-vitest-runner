/**
 * extension.ts — Entry point for the Angular Vitest Runner extension.
 *
 * Activation steps:
 *  1. Load angular.json, discover Vitest projects, build ProjectResolver.
 *  2. Create the VS Code TestController, register Run/Debug profiles,
 *     and populate the top-level Test Explorer tree with Angular projects.
 *  3. Run AST-based test discovery on all *.spec.ts files and watch for
 *     live file changes to keep the tree up-to-date.
 *  4. Wire up the TestRunner so Run requests spawn real `ng test` processes.
 */
import * as vscode from 'vscode';
import { loadAngularWorkspace, AngularWorkspace } from './angularWorkspace';
import { ProjectResolver } from './projectResolver';
import { AngularVitestController } from './testController';
import { TestDiscovery } from './testDiscovery';
import { TestRunner } from './testRunner';
import { log, warn, error, disposeOutputChannel, getOutputChannel } from './logger';

// ─── Extension-level singletons ──────────────────────────────────────────────

/** The parsed angular.json workspace. Available after activation. */
export let angularWorkspace: AngularWorkspace | undefined;

/** Resolves spec file paths to their owning Angular project. */
export let projectResolver: ProjectResolver | undefined;

/** The VS Code TestController + profile manager. */
export let vitestController: AngularVitestController | undefined;

/** Discovers spec files and keeps the Test Explorer tree live. */
export let testDiscovery: TestDiscovery | undefined;

/** Runs `ng test` child processes and updates VS Code test results. */
export let testRunner: TestRunner | undefined;

// ─── Activation ───────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log('Angular Vitest Runner activating…');

  // Surface the output channel so users can see it immediately.
  getOutputChannel().show(/* preserveFocus */ true);

  // ── Load the Angular workspace ────────────────────────────────────────────
  angularWorkspace = await loadAngularWorkspace();

  if (!angularWorkspace) {
    warn(
      'Could not find a valid angular.json with Vitest projects. ' +
        'The extension will remain dormant until a qualifying workspace is opened.',
    );
    return;
  }

  if (!angularWorkspace.hasVitestProjects) {
    warn(
      'angular.json was found, but no projects use a Vitest builder. ' +
        'Configure `architect.test.builder` (e.g. `@angular/build:unit-test`) ' +
        'in your angular.json to enable this extension.',
    );
    return;
  }

  // ── Build the project resolver ────────────────────────────────────────────
  projectResolver = new ProjectResolver(angularWorkspace);
  log(
    `ProjectResolver ready. Tracking ${angularWorkspace.projects.size} project(s): ` +
      angularWorkspace.allProjects().map((p) => p.name).join(', '),
  );

  // ── Create the VS Code TestController ────────────────────────────────────
  vitestController = new AngularVitestController();
  vitestController.populateFromWorkspace(angularWorkspace);
  context.subscriptions.push({ dispose: () => vitestController?.dispose() });
  log('Test Explorer populated with Angular project nodes. ✓');

  // ── Wire the TestRunner as the Run profile handler ────────────────────────
  testRunner = new TestRunner(angularWorkspace, vitestController);
  vitestController.runHandler = (req, token) => testRunner!.run(req, token);
  log('TestRunner wired to Run profile. ✓');

  // ── Run AST test discovery + start file watcher ───────────────────────────
  testDiscovery = new TestDiscovery(projectResolver, vitestController);
  await testDiscovery.start(context.subscriptions);
  log('Test discovery running. ✓');

  // ── Watch angular.json for project changes ────────────────────────────────
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(angularWorkspace.workspaceRoot, 'angular.json'),
  );

  const reloadWorkspace = async () => {
    log('angular.json changed — reloading workspace configuration…');
    try {
      angularWorkspace = await loadAngularWorkspace();
      if (angularWorkspace) {
        projectResolver = new ProjectResolver(angularWorkspace);

        // Re-populate project nodes in the tree.
        vitestController?.populateFromWorkspace(angularWorkspace);

        // Re-run discovery with the updated resolver.
        testDiscovery = new TestDiscovery(projectResolver, vitestController!);
        await testDiscovery.start(context.subscriptions);

        // Rebuild the runner with the new workspace.
        testRunner = new TestRunner(angularWorkspace, vitestController!);
        vitestController!.runHandler = (req, token) => testRunner!.run(req, token);

        log('Workspace configuration reloaded successfully.');
      }
    } catch (err) {
      error('Failed to reload angular.json', err);
    }
  };

  watcher.onDidChange(reloadWorkspace, undefined, context.subscriptions);
  watcher.onDidCreate(reloadWorkspace, undefined, context.subscriptions);
  watcher.onDidDelete(() => {
    warn('angular.json was deleted. Extension entering dormant state.');
    angularWorkspace = undefined;
    projectResolver = undefined;
    vitestController?.controller.items.replace([]);
  }, undefined, context.subscriptions);

  context.subscriptions.push(watcher);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  context.subscriptions.push({
    dispose: () => disposeOutputChannel(),
  });

  log('Angular Vitest Runner activated successfully. ✓');
}

// ─── Deactivation ─────────────────────────────────────────────────────────────

export function deactivate(): void {
  log('Angular Vitest Runner deactivating…');
  vitestController?.dispose();
  vitestController = undefined;
  testDiscovery = undefined;
  testRunner = undefined;
  angularWorkspace = undefined;
  projectResolver = undefined;
}
