# Angular Vitest Runner

Angular Vitest Runner is a Visual Studio Code extension that seamlessly integrates Vitest-based Angular projects into the native VS Code Test Explorer. It allows you to run, discover, and inspect tests for Angular applications directly from your editor.

## Features

- **Test Discovery:** Automatically scans your workspace for `angular.json` and parses all `*.spec.ts` files to build a rich tree view of your test suites and cases in the VS Code Test Explorer.
- **Run Tests Natively:** Run your entire project, specific files, or individual test suites directly from the UI.
- **Live Output Parsing:** Captures and sanitizes live terminal output from the Angular CLI (`ng test`), mapping success/failure status and detailed error traces directly to the exact line of code where the test failed.
- **Smart Filtering:** Supports execution filtering. It knows whether to execute a whole project or limit execution to a specific file using `--include`.
- **Zero Config for Angular:** Built specifically for `@angular/build:unit-test` and standard Angular CLI setups utilizing Vitest. 

## Requirements

- VS Code version 1.125.0 or higher.
- An Angular workspace containing `angular.json`.
- Vitest configured as the test runner (e.g., using `@angular/build:unit-test`).

## Extension Settings

This extension contributes the following settings:

* `angularVitestRunner.ngCliPath`: Absolute path to the Angular CLI binary. Leave empty to use the workspace-local `./node_modules/.bin/ng`.
* `angularVitestRunner.defaultArgs`: Additional arguments to pass to `ng test` by default (e.g., `["--no-cache"]`).

## How It Works

1. **Workspace Parsing:** On activation, the extension parses `angular.json` to find all projects that use the Vitest builder.
2. **AST Scanning:** It reads `.spec.ts` files using TypeScript AST to map `describe` and `it` blocks to their exact line numbers.
3. **Execution:** Clicking "Run" spawns a child process using `ng test <project>`. The extension isolates the Vitest output from the Angular build logs, maps results back to the UI, and attaches stack traces to failed items.
