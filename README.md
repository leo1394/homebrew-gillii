# Gillii

![gillii banner](assets/banner.svg)

<p align="center"><strong>English</strong> · <a href="README-ZH.md">简体中文</a></p>

Find cached WeChat mini-program packages, decrypt them and restore readable client code through one Shell command. Gillii also analyzes Android APK files and exports readable code and assets where supported.

- Recover cached WeChat mini-programs, including same-version subpackages and static analysis reports.
- Analyze APKs with Java/managed-code decompilation and Unity asset export where detected.
- Review offline HTML/JSON reports, file hashes and reproduction steps.
- Use shared instructions for AI agents.

## AI agents

Codex, DSH, Claude Code, Gemini CLI, Cursor and GitHub Copilot entry files share [AGENTS.md](AGENTS.md). See [AI agent integration and CLI/report usage](docs/AI-AGENTS.md) for invocation, exit codes and loading behavior.

## Install

### Homebrew (recommended)

```bash
brew install leo1394/gillii/gillii
```

Homebrew installs Node.js and Python. The release includes recovery dependencies and requires no local compilation.

### Bash (Linux / macOS)

Requires Bash 3.2+ and Node.js 22+.

```bash
curl -fsSL https://raw.githubusercontent.com/leo1394/homebrew-gillii/master/install.sh | bash
```

The installer automatically downloads the latest stable release, verifies SHA256 and installs into `~/.local`. Add `~/.local/bin` to your PATH if needed. Run the installer again to upgrade. Tested on macOS; Linux recovery remains unverified.

## APK analysis

Available since v0.2.0. Requires Bash 3.2+, Node.js 22+ and Python 3.10+ (Homebrew installs Node and Python). From a source checkout:

```bash
./bin/gillii chase /absolute/path/app.apk
./bin/gillii chase /absolute/path/app.apk --output ./apk-result
```

`--output` must name a new directory with an existing parent.

- Creates only relevant export directories; case-colliding APK resources are preserved with an original-to-exported path mapping.
- Retains normal JADX output and tries a separate simplified-instruction export when decompilation fails.
- Failed or partial runs highlight issues and point to `logs/execution.log` and detailed tool logs. Fully complete runs remove process logs while keeping reports and evidence.
- Open `index.html` or read `report.json`: exit codes are **0 complete**, **2 partial**, **1 failed**.

Recovery does not guarantee a buildable original project. Flutter, Unity IL2CPP and native libraries are inventoried; their original Dart/C#/C++ source is not reconstructed.

macOS is the initial target; Linux APK recovery is unverified and Windows is unsupported. See [APK workflow, dependencies and offline operation](docs/APK.md).

## Get started

Three commands are enough:

```bash
gillii list
gillii clean
gillii chase wx0123456789abcdef
```

If the AppID is unknown, quit desktop WeChat, run `gillii clean`, then reopen WeChat and visit only the target mini-program. Run `gillii list` to get its AppID, then `gillii chase <AppID>`.

`clean` permanently deletes discovered `.wxapkg` files, preserving other data. `chase` automatically selects the newest readable main package, copies it, decrypts and restores it. Release packages include dependencies; source installs prepare them automatically using npm. Results are saved under `./<AppID>-<unique suffix>/source`; original files, logs and report.json are retained alongside it. Repeated runs create separate directories.

If macOS blocks access, grant the terminal access in system settings and retry. Optional overrides for copied caches or custom output paths are available with `gillii help chase`.

## Limits and development

Supports the verified V1MMWX format, main packages, plugins and the tested compiled template formats. Automatically merges cached subpackages from the same version. Missing uncached pages are listed in report.json with status `complete_cached`; successful restoration covers the available cache. Does not recover server code, original names or guarantee runtime/rendering equivalence. Does not send business API requests. Re-running the installer upgrades the executable; failures before final replacement preserve the existing executable. Supporting-file installation is not a single atomic transaction.

Run `bash tests/test.sh` for CLI and installer behavior and `python3 -B -m unittest discover -s tests` for APK helper checks. `publish.sh --prepare` also runs helper tests against the packaged dependencies. See [third-party notices](THIRD-PARTY.md), [manual](man/gillii.1) and [validation](docs/VALIDATION.md). Contributions should preserve formatting and add focused behavioral tests. GPL-3.0-or-later; [license](LICENSE). Funding was declined; no funding configuration is included.

## Mini-program analysis reports

Each recovery now writes an offline `index.html`, `docs/analysis.md`, `docs/reproduction.md`, file hash inventories and static API/config evidence under `evidence/`. Failed runs retain diagnostics; uncached pages remain distinct from failed recovery. See [report documentation](docs/MINI-PROGRAM-REPORTS.md).
