# library pack

Applies when the work touches code that other projects install and import: a published package, an SDK, or a shared module with its own version. It assumes the library declares its public API in one place (an entry file, an exports map or an `__all__` list) and releases versions that follow semver. It extends the core pack, and core's rules still apply.

## Rules

1. The public API is declared in one entry point, and everything not exported there is internal.
   Test: each new public symbol in the diff is exported from the package's entry file or exports map, and nothing outside it is documented as public.
2. Internal modules are marked so consumers can't mistake them for the public API.
   Test: new internal files sit under an internal path (for example `internal/` or `_private`) or carry the language's private marker, and the exports map doesn't expose them.
3. Versions follow semver: a breaking change to the public API bumps the major version.
   Test: if the diff removes or renames a public symbol, changes a signature, or narrows accepted input, the version bump in the diff is major.
4. New features bump the minor version; fixes bump the patch version.
   Test: the version change in the diff matches the change type recorded in the changelog entry.
5. Every release has a changelog entry that names each public API change.
   Test: the diff updates `CHANGELOG.md` (or the release-notes file) with every added, changed, deprecated or removed public symbol.
6. A public symbol is deprecated, with a warning and a named replacement, for at least one minor release before it is removed.
   Test: any public symbol the diff removes was marked deprecated in an earlier release, and newly deprecated symbols emit a warning naming the replacement.
7. Importing the library has no side effects: no network calls, file writes, global configuration changes, monkey-patching or output.
   Test: module top-level code in the diff only defines names; importing the package in a clean process makes no I/O and prints nothing.
8. The library reads no environment variables or config files on import; callers pass configuration in.
   Test: no environment or file read at module top level in the diff; configuration arrives through constructor or function parameters.
9. The library never exits the process or installs global handlers.
   Test: grep the diff for process exit calls, signal handlers and global exception hooks; none appear.
10. Runtime dependencies are few and declared as version ranges, not exact pins.
   Test: each new runtime dependency in the manifest has a range compatible with semver, and dev-only tools are under dev dependencies.
11. Public functions raise or return documented error types, not raw errors from dependencies.
   Test: each public function the diff adds wraps dependency errors in the library's own error types, and its doc names them.
12. The public API surface is checked by a test or an API report.
   Test: a test imports every exported symbol, or an API-extractor style report is updated in the diff, so an accidental export or removal fails CI.
13. Every public symbol has a doc comment and a usage example in the docs or tests.
   Test: each new export in the diff has a doc comment, and a doc page or test shows it being called.
