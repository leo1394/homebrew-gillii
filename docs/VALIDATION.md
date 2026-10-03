# Validation — 0.1.0, 2026-10-03

Validated on the current macOS host with bundled Bash 3.2 and Node.js 22.12.0:

- list / clean --dry-run: two-column output, one latest timestamp per AppID; info: positional AppID, full package metadata, missing/invalid AppID errors and directory completion.
- chase: AppID-only invocation, automatic dependency preparation with a local npm stub, selection of a main package despite a newer subpackage, automatic copying/extraction, separate output directories on repeated attempts and retained failure reports.
- clean: isolated package deletion, dry-run, AppID filtering, empty caches, paths with spaces, preserved non-package files and symlink targets. Live WeChat cleanup/redownload remains unverified.
- Two-line version contract, top-level/command help without Node, typo suggestions and nonzero errors.
- Bash completion candidate behavior: commands, options, shell enum, paths containing spaces, valued options and `--`.
- Zsh completion candidates and file/directory dispatch through its completion function. Interactive quote insertion remains unverified.
- Isolated source installation, custom prefix containing spaces, explicit version, upgrades and installed-resource presence.
- Version mismatch, mocked HTTPS download failure and checksum mismatch preserve the existing executable.
- `man -w gillii` discovers the installed manual; mandoc renders it and reports no lint warnings.
- Offline setup using previously cached npm packages, then a real V1MMWX package through the Shell entry point: 94 JS modules, 15 pages, 51 WXML, 49 WXSS, 21 WXS; JSON/syntax/coverage/import checks pass.
- Nineteen Node helper tests pass, including the upstream concurrent app.json write regression and path traversal rejection.
- Real cached main package wx81ce904580cc0ff1: fixed string-keyed WXSS in app-wxss.js, restored 44 WXSS files and 49 JS modules; syntax, JSON and stylesheet imports pass. Fourteen declared subpackage pages are absent from the cache and are reported separately with status complete_cached.
- Original SVG logo and banner rendered with Quick Look and visually checked for contrast and readability.

Unverified: Fish behavior (not installed), Linux, older macOS versions, interactive Zsh quoting, Homebrew installation and `brew test`, live remote installer/release downloads, developer-tool execution and WXML rendering equivalence.

The Formula points to the versioned GitHub Release installation archive with a computed SHA256. `scripts/package.sh --release` bundles locked npm dependencies and regenerates the Formula. Python 3 is a development/test dependency, not a CLI runtime dependency. No sponsorship configuration is included. No private mini-program packages are bundled in this project.

## Full local cache regression

All 14 supplied AppIDs passed the actual `bin/gillii chase` command against copies of their local caches: 9 complete, 5 complete_cached. Missing templates, modules, cached page files, stylesheet imports and syntax/JSON failures were zero. Coverage includes standalone plugins, cached subpackages, lazy WXML closures and Skyline compiled templates. Original WeChat caches were preserved.

The five caches with unavailable declared pages are wx7ec43a6a6c80544d (315), wx81ce904580cc0ff1 (14), wxa8da525af05281f3 (279), wxb1a70937ee94c194 (79) and wxdcd3d073e47d1742 (65). These pages cannot be restored without their packages.

Developer reproduction: `node scripts/validate-cache.mjs <copied-cache-directory> <new-results-directory>`. Each result retains the command log, restored source and detailed report. Local evidence: [summary](../runs-cache-validation-final/summary.json).

Release validation: the installation archive passes all 19 helper tests and isolated installation. A first synthetic recovery runs with npm disabled, proving that bundled dependencies require no first-run download.
