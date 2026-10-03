#!/bin/bash
# Called by ../publish.sh for the ready-to-install Shell/JavaScript distribution.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
action=${1:-dry-run}
version=${2:-}
[ -n "$version" ] || version=$(cat "$root/VERSION.txt")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Invalid release version: %s\n' "$version" >&2; exit 1; }
repo=leo1394/homebrew-gillii
tag=v$version
archive=$root/dist/gillii-$version.tar.gz
checksum=$root/dist/gillii-$version.sha256
case "$action" in
  dry-run)
    printf 'target: %s\nversion: %s\nstrategy: interpreted archive (no compilation)\nURL: https://github.com/%s/releases/download/%s/gillii-%s.tar.gz\n' "$root" "$version" "$repo" "$tag" "$version"
    printf 'prepare: bundle locked npm dependencies, test archive, update Formula\napply: commit release files, push master/tag, upload and publish GitHub Release\n'
    exit 0;;
  prepare|apply) :;;
  *) printf 'gillii supports --dry-run, --prepare and --apply.\n' >&2; exit 1;;
esac
cd "$root"
if [ "$action" = prepare ] || [ ! -f "$archive" ] ||
    ! grep -Fq "GILLII_VERSION='$version'" lib/metadata.sh; then
  python3 - "$version" <<'PY'
from pathlib import Path
import datetime,re,sys
from zoneinfo import ZoneInfo
version=sys.argv[1];date=datetime.datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d')
p=Path('lib/metadata.sh');s=p.read_text();s=re.sub(r"GILLII_VERSION='[^']+'",f"GILLII_VERSION='{version}'",s);s=re.sub(r"GILLII_DATE='[^']+'",f"GILLII_DATE='{date}'",s);p.write_text(s)
p=Path('man/gillii.1');s=p.read_text();s=re.sub(r'^.TH GILLII.*$',f'.TH GILLII 1 "{date}" "gillii {version}" "User Commands"',s,flags=re.M);p.write_text(s)
Path('VERSION.txt').write_text(version+'\n')
PY
fi
bash scripts/package.sh --release
# Check the exact artifact that will be uploaded, including offline dependencies.
scratch=$(mktemp -d "${TMPDIR:-/tmp}/gillii-release.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
(cd dist && shasum -a 256 -c "gillii-$version.sha256")
tar -xzf "$archive" -C "$scratch"
bash tests/test.sh
ruby -c Formula/gillii.rb
bash -n bin/gillii scripts/release.sh
mandoc -T lint man/gillii.1
payload=$scratch/gillii-$version
# The original helpers resolve dependencies from the installed payload.
cp libexec/*.test.mjs "$payload/libexec/"
node --test "$payload/libexec/"*.test.mjs
rm "$payload/libexec/"*.test.mjs
bash "$payload/install.sh" --prefix "$scratch/install"
"$scratch/install/bin/gillii" --version
# Exercise first recovery with npm disabled to prove bundled dependencies are sufficient.
mkdir -p "$scratch/no-npm"
printf '#!/bin/bash\nexit 99\n' > "$scratch/no-npm/npm"
chmod +x "$scratch/no-npm/npm"
python3 - "$scratch/main.wxapkg" <<'PYFIXTURE'
import struct,sys
from pathlib import Path
files={'app-service.js':b'define("app.js",function(){App({});});','app-config.json':b'{"pages":[]}', 'page-frame.html':b'<script></script>'}
offset=18+sum(12+len(name.encode()) for name in files)
index=struct.pack('>I',len(files))
for name,body in files.items():
    name=name.encode();index+=struct.pack('>I',len(name))+name+struct.pack('>II',offset,len(body));offset+=len(body)
Path(sys.argv[1]).write_bytes(b'\xbe'+b'\0'*4+struct.pack('>II',len(index),sum(map(len,files.values())))+b'\xed'+index+b''.join(files.values()))
PYFIXTURE
PATH="$scratch/no-npm:$PATH" XDG_CACHE_HOME="$scratch/cache" "$scratch/install/bin/gillii" chase wx0123456789abcdef --input "$scratch/main.wxapkg" --output "$scratch/recovered"
if [ "$action" = prepare ]; then
  printf 'Prepared %s; publish with publish.sh --target homebrew-gillii --version %s --apply\n' "$archive" "$version"
  exit 0
fi
[ "$(git branch --show-current)" = master ] || { printf 'Publish from master.\n' >&2; exit 1; }
gh auth status
# Publish only source and release metadata; never add copied caches/recovery output.
git add .gitignore Formula bin lib libexec completions man scripts tests README.md README-ZH.md LICENSE THIRD-PARTY.md assets docs install.sh VERSION.txt
if ! git diff --cached --quiet; then git commit -m "Release gillii $version with ready-to-install archive"; fi
[ -z "$(git status --porcelain --untracked-files=no)" ] || { printf 'Uncommitted tracked files remain.\n' >&2; exit 1; }
commit=$(git rev-parse HEAD)
if git rev-parse "$tag" >/dev/null 2>&1; then
  [ "$(git rev-parse "$tag^{commit}")" = "$commit" ] || { printf 'Tag already points to another commit.\n' >&2; exit 1; }
else
  git tag -a "$tag" -m "gillii $version"
fi
git push origin master "refs/tags/$tag"
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  [ "$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft)" = true ] || {
    printf 'Release is already public; refuse to replace immutable assets.\n' >&2; exit 1;
  }
  gh release upload "$tag" "$archive" "$checksum" --repo "$repo" --clobber
else
  gh release create "$tag" "$archive" "$checksum" --repo "$repo" --verify-tag --draft \
    --title "gillii $version" --notes "Ready-to-install archive with locked JavaScript dependencies. No local compilation. Fixes JavaScript, WXML, WXSS, plugin and cached subpackage recovery."
fi
gh release edit "$tag" --repo "$repo" --draft=false
printf 'Published https://github.com/%s/releases/tag/%s\nInstall: brew install leo1394/gillii/gillii\n' "$repo" "$tag"
