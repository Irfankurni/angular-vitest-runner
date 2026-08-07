# Change Log

All notable changes to the **Angular Vitest Runner** extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0] - 2026-08-06

### 🎉 Initial Release

#### Added
- **Test Discovery** — Uses the TypeScript compiler API to statically parse `.spec.ts` files and extract `describe` / `it` / `test` blocks with precise line numbers, supporting nested suites and focused/skipped variants (`fdescribe`, `xdescribe`, `fit`, `xit`, etc.).
- **Angular Workspace Integration** — Automatically reads `angular.json` to detect projects configured with the Vitest builder (`@angular/build:unit-test`), with no manual configuration required.
- **VS Code Test Explorer Integration** — Populates the native Test Explorer UI with a hierarchical tree of your Angular workspace, projects, test suites, and individual test cases.
- **Test Execution** — Wires up Run and Debug profiles to launch the Angular CLI (`ng test`) as a child process, fully integrated with VS Code's testing infrastructure.
- **Smart Execution Filtering** — Passes `--include` globs and `--testNamePattern` to the Angular CLI to run tests at the file or individual test-case level.
- **Live Output Parsing** — Sanitizes and parses streaming output from the Vitest verbose reporter, filtering out Angular esbuild noise.
- **Test Results Mapping** — Matches parsed test results back to the specific VS Code `TestItem` and marks each as passed, skipped, or failed — complete with error messages, stack traces, and source location links.
- **Configurable CLI Path** — Supports a custom `angularVitestRunner.ngCliPath` setting for non-standard Angular CLI installations.
- **Additional CLI Arguments** — Supports `angularVitestRunner.defaultArgs` to pass extra flags to `ng test` globally.