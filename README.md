# Gillii

![gillii banner](assets/banner.svg)

<p align="center"><strong>English</strong> · <a href="README-ZH.md">简体中文</a></p>

Find cached WeChat mini-program packages, decrypt them and restore readable client code through one Shell command.

- Read-only discovery lists AppIDs and timestamps; info shows package details.
- Recovery keeps original packages, raw files and restored source separately.
- Stage logs and static checks show missing pages, syntax failures and unresolved style imports.

## Install

### Homebrew (recommended)

```bash
brew install leo1394/gillii/gillii
```

Homebrew installs Node.js and shell completions. The release includes recovery dependencies and requires no local compilation.

### Bash (Linux / macOS)

Requires Bash 3.2+ and Node.js 22+.

```bash
curl -fsSL https://raw.githubusercontent.com/leo1394/homebrew-gillii/master/install.sh | bash
```

The installer automatically downloads the latest stable release, verifies SHA256 and installs into `~/.local`. Add `~/.local/bin` to your PATH if needed. Run the installer again to upgrade. Tested on macOS; Linux recovery remains unverified.

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

Run `bash tests/test.sh` for CLI/installer/completion behavior. `publish.sh --prepare` also runs helper tests against the packaged dependencies. See [third-party notices](THIRD-PARTY.md), [manual](man/gillii.1) and [validation](docs/VALIDATION.md). Contributions should preserve formatting and add focused behavioral tests. GPL-3.0-or-later; [license](LICENSE). Funding was declined; no funding configuration is included.
