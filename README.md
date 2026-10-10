# Gillii

![gillii banner](assets/banner.svg)

<p align="center"><strong>English</strong> · <a href="README-ZH.md">简体中文</a></p>

A local reverse-engineering workbench, with dedicated support for WeChat mini-programs. Recover cached client code or analyze an Android APK, then explore its architecture, source and evidence in one workspace.

- **WeChat mini-programs:** discover cached packages, decrypt and restore client code, merge cached subpackages from the same version, and trace pages, events, functions and references.
- **Android APKs:** inspect packages and resources, decompile Java and managed assemblies, export supported Unity assets, and analyze Flutter ARM64 Dart AOT.
- **Developer workbench:** browse architecture and source, follow evidence, inspect reconstruction blueprints, and open projects in VS Code, Sublime Text, Android Studio, Cursor or Antigravity.
- **Retained results:** bilingual HTML reports, JSON evidence, original packages, file hashes and reproduction steps.

## Install

### Homebrew (recommended)

```bash
brew install leo1394/gillii/gillii
```

Homebrew installs Node.js. The release bundles mini-program recovery dependencies; installing Gillii requires no local compilation.

### Bash (Linux / macOS)

Requires Bash 3.2+ and Node.js 22+.

```bash
curl -fsSL https://raw.githubusercontent.com/leo1394/homebrew-gillii/master/install.sh | bash
```

The installer downloads the latest stable release, verifies SHA256 and installs into `~/.local`. Add `~/.local/bin` to PATH if prompted. Run the same command again to upgrade.

APK tools are prepared only when you first analyze an APK, according to its detected payload. Installing Gillii or recovering a mini-program does not download APK tools. APK analysis requires Python 3.10+ with `venv`/`pip`; on macOS with Homebrew, missing Python is prepared on first use. Java decompilation requires an installed Java 11+ runtime. Flutter analysis may compile its analysis tools on first use. See [APK dependencies and offline operation](docs/APK.md).

## Get started

### WeChat mini-programs

```bash
gillii list
gillii chase wx0123456789abcdef
```

If the AppID is unknown, quit desktop WeChat and run `gillii clean`. Reopen WeChat, visit the target mini-program, then use `list` and `chase` to recover it. `clean` permanently deletes discovered `.wxapkg` packages while preserving other WeChat data.

`chase` selects the newest readable main package, copies it, decrypts it and restores the available client code. Results go into a new `<AppID>-<unique suffix>` directory in the current directory, with recovered code under `source/`. For package details, use `gillii info <AppID>`.

### Android APKs

```bash
gillii chase /path/to/app.apk
```

Results go into a new `<filename>-apk-<unique suffix>` directory. Supported analysis depends on the contents:

| Payload | Result |
| --- | --- |
| Android DEX | Manifest and resource inspection, JADX Java decompilation |
| Managed assemblies / Unity Mono | ILSpy C# decompilation; supported Unity asset export |
| Flutter ARM64 AOT | Annotated assembly, function mapping diagnostics, static call graph, CFG/register SSA and low-level pseudocode with supported local control structures |
| Unity IL2CPP / other native libraries | Artifact inventory and retained binaries; full source reconstruction is unsupported |

Dart analysis recognizes simple branches, natural loops and equality-chain switches where the evidence permits. It does not recover original Dart source or a complete dynamic call graph. Dynamic collection is planned for a later phase. See [Dart AOT scope](docs/DART-AOT.md).

### Workbench

Interactive `chase` runs automatically open the local workbench. Reopen the most recent result at any time:

```bash
gillii open
```

The workbench includes architecture, source browsing and local editing buffers, evidence and an in-page rebuild blueprint. Mini-program reports add feature tracing and symbol references; Flutter reports add Dart analysis. IDE launch uses an installed editor through the local viewer. Reports support Chinese and English, following the system language with English fallback.

The retained `index.html` is available offline; source loading and IDE launch use the local viewer. `report.json` records stages and coverage. Repeated runs preserve previous results. Optional cache/output overrides are documented in `gillii help chase`.

## Scope

Gillii performs static analysis. Recovered artifacts are not guaranteed to be a buildable original project, preserve original identifiers, or reproduce runtime behavior. It does not recover backend code, fetch uncached mini-program pages or send business API requests. Missing pages and unsupported or unsuccessful APK stages remain visible in the report.

APK exit codes: **0 complete**, **2 partial**, **1 failed**. Partial results retain useful artifacts and diagnostic logs. Mini-program reports distinguish successful recovery of available cache from missing declared pages. See [mini-program reports](docs/MINI-PROGRAM-REPORTS.md) and [APK workflow](docs/APK.md).

macOS is the verified target. Linux recovery remains unverified; Windows is unsupported. If macOS blocks WeChat cache access, grant your terminal the required access in system settings.

## AI agents and development

Codex, DSH, Claude Code, Gemini CLI, Cursor and GitHub Copilot share [AGENTS.md](AGENTS.md). See [AI agent integration](docs/AI-AGENTS.md) for CLI invocation and report handling.

Run `node --test libexec/providers/*/*.test.mjs`, `python3 -B -m unittest discover -s tests -p 'test_apk*.py'` and `bash tests/test.sh` for the relevant checks. Preserve existing formatting and use focused behavioral tests.

[Manual](man/gillii.1) · [Validation](docs/VALIDATION.md) · [Third-party notices](THIRD-PARTY.md) · [GPL-3.0-or-later](LICENSE)
