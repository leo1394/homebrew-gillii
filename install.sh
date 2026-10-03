#!/bin/bash
# Install the latest release automatically, or install a local source checkout.
# Requires Bash 3.2+, tar, shasum. No Homebrew required.
set -eu
prefix=${HOME}/.local
expected=''; archive=''; checksum=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix|--version|--archive|--sha256)
      key=$1;shift;[ "$#" -gt 0 ] || { printf 'Missing value for %s\n' "$key" >&2;exit 1; }
      case "$key" in --prefix) prefix=$1;; --version) expected=$1;; --archive) archive=$1;; --sha256) checksum=$1;; esac;;
    --help|-h) printf 'Usage: bash install.sh [--prefix DIR] [--version VERSION]\nDownloaded/piped scripts automatically install the latest stable release.\nDefault prefix: ~/.local. Installs CLI, manual and Bash/Zsh/Fish completion. No sudo or dependency installation.\n';exit 0;;
    *) printf 'Unknown option: %s\n' "$1" >&2;exit 1;;
  esac
  shift
done
case "$(uname -s)" in Darwin|Linux) :;; *) printf 'Only macOS/Linux are supported.\n' >&2;exit 1;; esac
case "$prefix" in /*) :;; *) prefix=$PWD/$prefix;; esac
scratch=$(mktemp -d "${TMPDIR:-/tmp}/gillii-install.XXXXXX")
stage=''; launcher=''
trap 'rm -rf "$scratch"; [ -z "$stage" ] || rm -rf "$stage"; [ -z "$launcher" ] || rm -f "$launcher"' EXIT
source_root=''
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  candidate=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  if [ -f "$candidate/bin/gillii" ] && [ -f "$candidate/lib/metadata.sh" ]; then source_root=$candidate; fi
fi
if [ -z "$archive" ] && [ -z "$source_root" ]; then
  repository=https://github.com/leo1394/homebrew-gillii
  if [ -z "$expected" ]; then
    latest=$(curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
      "$repository/releases/latest" -o /dev/null --write-out '%{url_effective}')
    case "$latest" in "$repository/releases/tag/v"*) expected=${latest##*/v};;
      *) printf 'Cannot resolve latest gillii release.\n' >&2;exit 1;; esac
  fi
  [[ "$expected" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Invalid release version.\n' >&2;exit 1; }
  filename=gillii-$expected.tar.gz
  archive=$repository/releases/download/v$expected/$filename
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
    "$repository/releases/download/v$expected/gillii-$expected.sha256" -o "$scratch/checksum"
  checksum=$(awk -v filename="$filename" '$2 == filename { value=$1; count++ } END { if(count==1) print value; else exit 1 }' "$scratch/checksum")
fi
if [ -n "$archive" ]; then
  [ -n "$expected" ] && [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || { printf 'Archive mode requires --version and --sha256.\n' >&2;exit 1; }
  case "$archive" in https://*) curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' "$archive" -o "$scratch/source.tar.gz";;
    *) printf 'Archive URL must use HTTPS.\n' >&2;exit 1;; esac
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$scratch/source.tar.gz" | awk '{print $1}')
  else
    actual=$(sha256sum "$scratch/source.tar.gz" | awk '{print $1}')
  fi
  [ "$actual" = "$checksum" ] || { printf 'SHA256 mismatch; previous installation preserved.\n' >&2;exit 1; }
  tar -tzf "$scratch/source.tar.gz" > "$scratch/entries"
  if LC_ALL=C grep -E '(^/|(^|/)\.\.(/|$))' "$scratch/entries" >/dev/null; then printf 'Unsafe archive paths.\n' >&2;exit 1;fi
  mkdir "$scratch/source"
  tar -xzf "$scratch/source.tar.gz" -C "$scratch/source" --strip-components=1
  source_root=$scratch/source
fi
for file in bin/gillii lib/metadata.sh lib/contract.sh libexec/gillii.mjs man/gillii.1 completions/gillii.bash completions/gillii.zsh completions/gillii.fish;do
  [ -f "$source_root/$file" ] || { printf 'Missing resource: %s\n' "$file" >&2;exit 1; }
done
. "$source_root/lib/metadata.sh"
if [ -n "$expected" ] && [ "$expected" != "$GILLII_VERSION" ];then printf 'Version mismatch; previous installation preserved.\n' >&2;exit 1;fi
expected_output=$(printf 'gillii version %s (%s)\n%s' "$GILLII_VERSION" "$GILLII_DATE" "$GILLII_REPOSITORY")
[ "$(bash "$source_root/bin/gillii" version)" = "$expected_output" ] || { printf 'Version validation failed.\n' >&2;exit 1; }
mkdir -p "$prefix/bin" "$prefix/libexec/gillii" "$prefix/share/man/man1" "$prefix/share/bash-completion/completions" "$prefix/share/zsh/site-functions" "$prefix/share/fish/vendor_completions.d"
stage=$(mktemp -d "$prefix/libexec/gillii/.stage.XXXXXX")
for dir in bin lib libexec completions man;do cp -R "$source_root/$dir" "$stage/";done
cp "$source_root/LICENSE" "$source_root/THIRD-PARTY.md" "$stage/"
release=$prefix/libexec/gillii/$GILLII_VERSION-$(basename "$stage" | sed 's/^\.stage\.//')
# Supporting resources finish before replacing the executable.
for spec in 'man/gillii.1:share/man/man1/gillii.1' 'completions/gillii.bash:share/bash-completion/completions/gillii' 'completions/gillii.zsh:share/zsh/site-functions/_gillii' 'completions/gillii.fish:share/fish/vendor_completions.d/gillii.fish';do
  src=${spec%%:*};dest=${spec#*:};temp=$(mktemp "$prefix/$(dirname "$dest")/.gillii.XXXXXX")
  cp "$stage/$src" "$temp";chmod 644 "$temp";mv -f "$temp" "$prefix/$dest"
done
mv "$stage" "$release";stage=''
launcher=$(mktemp "$prefix/bin/.gillii.XXXXXX")
printf '#!/bin/bash\nexec /bin/bash %q "$@"\n' "$release/bin/gillii" > "$launcher"
chmod 755 "$launcher"
[ "$("$launcher" --version)" = "$expected_output" ] || { printf 'Installed payload validation failed; previous executable preserved.\n' >&2;exit 1; }
mv -f "$launcher" "$prefix/bin/gillii";launcher=''
printf 'Installed gillii %s into %s\n' "$GILLII_VERSION" "$prefix"
printf 'Add %s/bin to PATH. For manuals: export MANPATH="%s/share/man:${MANPATH:-}"\n' "$prefix" "$prefix"
printf 'Bash: source "%s/share/bash-completion/completions/gillii"\n' "$prefix"
printf 'Zsh: add "%s/share/zsh/site-functions" to fpath before compinit.\n' "$prefix"
printf 'Fish: source "%s/share/fish/vendor_completions.d/gillii.fish"\n' "$prefix"
printf 'Use gillii list, gillii clean, then gillii chase <AppID>. Dependencies are prepared automatically.\n'
