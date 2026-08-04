# Change Log

All notable changes to the "angular-test" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added
- **Test Discovery:** Implemented TypeScript AST parsing to discover `describe` and `it` blocks within `.spec.ts` files and map them to precise line numbers.
- **Angular Workspace Integration:** Automatically reads `angular.json` to identify projects configured with the Vitest builder (`@angular/build:unit-test`).
- **VS Code Test Explorer Integration:** Populates the native Test Explorer UI with a hierarchical tree of your Angular workspace, projects, test suites, and test cases.
- **Test Execution:** Wires up Run profiles to launch the Angular CLI (`ng test`) as a child process.
- **Smart Execution Filtering:** Passes `--include` globs to the Angular CLI to run tests at the file level when a specific test file or test case is executed.
- **Live Output Parsing:** Sanitizes and parses the text output from the Vitest verbose reporter, filtering out Angular esbuild logs.
- **Test Results Mapping:** Matches test output back to the specific VS Code `TestItem` and marks it as passed, skipped, or failed (complete with detailed error traces and location links).