#!/usr/bin/env python3
"""Build an allowlisted, reproducible installation archive; never include cached apps."""
import argparse
import datetime
import gzip
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = ('bin', 'lib', 'libexec', 'completions', 'man', 'LICENSE', 'THIRD-PARTY.md', 'install.sh')

def build(release=False):
    metadata = (ROOT / 'lib/metadata.sh').read_text()
    def field(name):
        return re.search(r"^" + name + r"='([^']+)'", metadata, re.M)[1]
    version, date, repo = (field(name) for name in ('GILLII_VERSION', 'GILLII_DATE', 'GILLII_REPOSITORY'))
    if release and not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Release version must be x.y.z')
    (ROOT / 'dist').mkdir(exist_ok=True)
    archive = ROOT / 'dist' / f'gillii-{version}.tar.gz'
    with tempfile.TemporaryDirectory(prefix='gillii-package-') as temporary:
        stage = Path(temporary) / f'gillii-{version}'
        stage.mkdir()
        for name in PAYLOAD:
            source = ROOT / name
            if source.is_dir():
                shutil.copytree(source, stage / name, ignore=shutil.ignore_patterns('node_modules', '*.test.mjs', '.DS_Store', '__pycache__'))
            else:
                shutil.copy2(source, stage / name)
        if release:
            tool = stage / 'libexec/tools/wxappUnpacker'
            subprocess.run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=tool, check=True)
            # These helpers and their dependencies must work without any first-run download.
            subprocess.run(['node', '--input-type=module', '-e', "import {moduleEntries} from './libexec/restore-js.mjs'; if(moduleEntries('define(\"a.js\",function(){})').length!==1) process.exit(1)"], cwd=stage, check=True)
            for native in stage.rglob('*.node'):
                raise ValueError(f'Platform-specific dependency in universal archive: {native}')
        mtime = int(datetime.datetime.fromisoformat(date).replace(tzinfo=datetime.timezone.utc).timestamp())
        with archive.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as tar:
            for source in sorted(stage.rglob('*')):
                if source.is_dir():
                    continue
                info = tar.gettarinfo(str(source), arcname=str(source.relative_to(stage.parent)))
                info.mtime = mtime
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                if source.is_symlink():
                    tar.addfile(info)
                else:
                    with source.open('rb') as content:
                        tar.addfile(info, content)
    sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    (ROOT / 'dist' / f'gillii-{version}.sha256').write_text(f'{sha}  {archive.name}\n')
    formula = ROOT / 'Formula/gillii.rb'
    text = formula.read_text()
    text = re.sub(r'^#.*\n', '', text, flags=re.M)
    url = f'{repo}/releases/download/v{version}/{archive.name}' if release else archive.as_uri()
    text = re.sub(r'^  url .*$', f'  url "{url}"', text, flags=re.M)
    text = re.sub(r'^  version .*$', f'  version "{version}"', text, flags=re.M)
    text = re.sub(r'^  sha256 .*$', f'  sha256 "{sha}"', text, flags=re.M)
    text = re.sub(r'gillii version [\w.-]+ \(\d{4}-\d{2}-\d{2}\)', f'gillii version {version} ({date})', text)
    text = text.replace('dependencies are installed automatically on first run.', 'the release includes recovery dependencies.' if release else 'dependencies are installed automatically on first run.')
    formula.write_text(text)
    print(f'{archive}\nSHA256 {sha}')
    return archive

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', action='store_true')
    build(parser.parse_args().release)
