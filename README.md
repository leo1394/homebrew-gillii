[中文](README-ZH.md)

![gillii banner](assets/banner.svg)

<img src="assets/logo.svg" width="64" alt="gillii scan brackets and code logo">

# gillii

Find cached WeChat mini-program packages, decrypt them and restore readable client code through one Shell command.

- Read-only discovery lists AppIDs and timestamps; info shows package details.
- Recovery keeps original packages, raw files and restored source separately.
- Stage logs and static checks show missing pages, syntax failures and unresolved style imports.

## Install

Requires Bash 3.2+ and Node.js 22+. npm and registry access are needed for `setup`.
Only the current macOS host has been tested; Linux recovery is intended but unverified. Older macOS compatibility depends on a supported Node.js runtime.

This is **0.1.0-dev**, not a published release. Repository: https://github.com/leo1394/homebrew-gillii (publication not verified).
No GitHub release archive or public checksum is claimed to exist.

```bash
# From this source checkout, without Homebrew:
bash install.sh --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
export MANPATH="$HOME/.local/share/man:${MANPATH:-}"
gillii --version
```

The Formula is generated against a real local source archive for development. A local tap can install it:

```bash
brew tap --custom gillii/local "$PWD"
brew install gillii/local/gillii
```

Before public distribution, change the Formula URL to an immutable published archive and retain its matching SHA256. `brew install leo1394/gillii/gillii` is the planned public command, not currently verified.

## First result

Three commands are enough:

```bash
gillii list
gillii clean
gillii chase wx0123456789abcdef
```

If the AppID is unknown, quit desktop WeChat, run `gillii clean`, then reopen WeChat and visit only the target mini-program. Run `gillii list` to get its AppID, then `gillii chase <AppID>`.

`list` and `clean --dry-run` show only `appid` and `modified`, one row per AppID using its newest package timestamp. Use `gillii info <AppID>` for package paths, versions, sizes and cache access details.

Modification times use local time in `YYYY-MM-DD HH:mm:ss` format.

`clean` permanently deletes discovered `.wxapkg` files, preserving other data. `chase` automatically selects the newest readable main package, copies it, decrypts and restores it. Dependencies are installed automatically on first run using npm. Results are saved under `./<AppID>-<unique suffix>/source`; original files, logs and report.json are retained alongside it. Repeated runs create separate directories.

If macOS blocks access, grant the terminal access in system settings and retry. Optional overrides for copied caches or custom output paths are available with `gillii help chase`.

## Completion

Bash: `source "$HOME/.local/share/bash-completion/completions/gillii"`.
Zsh: add `$HOME/.local/share/zsh/site-functions` to `fpath` before `autoload -Uz compinit; compinit`.
Fish: `source ~/.local/share/fish/vendor_completions.d/gillii.fish`.
Homebrew installs these resources under its standard directories; activate your shell's completion support as usual. Tab performs no setup or downloads.

## Limits and development

Supports the verified V1MMWX format, main packages, plugins and the tested compiled template formats. Automatically merges cached subpackages from the same version. Missing uncached pages are listed in report.json with status `complete_cached`; successful restoration covers the available cache. Does not recover server code, original names or guarantee runtime/rendering equivalence. Does not send business API requests. Re-running the installer upgrades the executable; failures before final replacement preserve the existing executable. Supporting-file installation is not a single atomic transaction.

Run `bash tests/test.sh` for CLI/installer/completion behavior. Run `gillii setup` then `node --test "${XDG_CACHE_HOME:-$HOME/.cache}/gillii/0.1.0-dev/"*.test.mjs` for helper tests. See [third-party notices](THIRD-PARTY.md), [manual](man/gillii.1) and [validation](docs/VALIDATION.md). Contributions should preserve formatting and add focused behavioral tests. GPL-3.0-or-later; [license](LICENSE). Funding was declined; no funding configuration is included.
