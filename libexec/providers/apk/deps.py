"""Capability-scoped APK tools. Downloads are pinned; failures are stage-local."""
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

try:
    import fcntl
except ImportError:
    fcntl = None

LOCK_PATH = Path(__file__).with_name('toolchain-lock.json')
MAX_DOWNLOAD = 512 * 1024 * 1024


def _hash(path, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _download(spec, directory, offline):
    for attempt in range(3):
        try:
            return _download_once(spec, directory, offline)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if offline or attempt == 2:
                raise
            time.sleep(attempt + 1)


def _download_once(spec, directory, offline):
    directory.mkdir(parents=True, exist_ok=True)
    algorithm = spec.get('algorithm', 'sha256')
    target = directory / (spec['hash'] + '.zip')
    if target.is_file() and _hash(target, algorithm) == spec['hash']:
        return target
    if offline:
        raise RuntimeError('verified download unavailable in offline cache')
    partial = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as output:
            partial = Path(output.name)
            started = time.monotonic()
            with urllib.request.urlopen(spec['url'], timeout=30) as response:
                size = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_DOWNLOAD or time.monotonic() - started > 300:
                        raise RuntimeError('download exceeds size/time limit')
                    output.write(chunk)
        if _hash(partial, algorithm) != spec['hash']:
            raise RuntimeError('download checksum mismatch')
        os.replace(partial, target)
        return target
    finally:
        if partial and partial.exists():
            partial.unlink()


def _extract(archive, destination):
    with zipfile.ZipFile(archive) as bundle:
        if sum(item.file_size for item in bundle.infolist()) > 2 * 1024 ** 3:
            raise RuntimeError('tool archive exceeds expanded size limit')
        for item in bundle.infolist():
            target = destination / item.filename
            if not target.resolve().is_relative_to(destination.resolve()):
                raise RuntimeError('unsafe tool archive path')
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError('tool archive contains symlink')
        bundle.extractall(destination)


def _run(args, timeout=300):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, text=True)
    if result.returncode:
        raise RuntimeError('tool setup failed: ' + result.stderr[-1500:])
    return result.stdout


def _inventory(directory):
    return {str(p.relative_to(directory)): _hash(p) for p in directory.rglob('*')
            if p.is_file() and p.name != '.verified.json' and '__pycache__' not in p.parts
            and p.suffix != '.pyc'}


def _valid(directory):
    try:
        saved = json.loads((directory / '.verified.json').read_text())
        return bool(saved) and saved == _inventory(directory)
    except (OSError, ValueError):
        return False


def _install(directory, build):
    directory.parent.mkdir(parents=True, exist_ok=True)
    if fcntl is None:
        raise RuntimeError('automatic tool installation requires POSIX file locking')
    with (directory.parent / (directory.name + '.lock')).open('a') as lock:
        started = time.monotonic()
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() - started > 600:
                    raise RuntimeError('timed out waiting for dependency cache lock')
                time.sleep(0.1)
        try:
            return _install_locked(directory, build)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _install_locked(directory, build):
    if _valid(directory):
        return directory
    directory.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=directory.name + '-', dir=directory.parent))
    try:
        build(temporary)
        (temporary / '.verified.json').write_text(json.dumps(_inventory(temporary), sort_keys=True))
        if directory.exists():
            shutil.rmtree(directory)
        os.replace(temporary, directory)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return directory


def _android(tool):
    roots = [os.environ.get(variable) for variable in ('ANDROID_SDK_ROOT', 'ANDROID_HOME')]
    roots.extend([Path.home() / 'Library/Android/sdk', Path.home() / 'Android/Sdk'])
    for root in roots:
        if root:
            for build in sorted((Path(root) / 'build-tools').glob('*'), reverse=True):
                candidate = build / tool
                if candidate.is_file() and os.access(candidate, os.X_OK):
                    return str(candidate)
    return shutil.which(tool)


def _unity(directory, downloads, lock, offline):
    def build(target):
        wheels = target / 'wheels'
        wheels.mkdir()
        if offline:
            raise RuntimeError('Unity Python environment unavailable offline')
        _run([sys.executable, '-m', 'venv', str(target / 'venv')])
        python = target / 'venv/bin/python'
        pins = lock['python']['packages']
        _run([str(python), '-m', 'pip', '--isolated', '--disable-pip-version-check', 'download',
              '--index-url', 'https://pypi.org/simple',
              '--only-binary=:all:', '--no-deps', '--dest', str(wheels),
              *[name + '==' + version for name, version in pins.items()
                if name not in lock['python'].get('pure_python_archives', {})]], timeout=600)
        # Verify all wheels against PyPI's published digest for the pinned version.
        normalized = {name.lower().replace('-', '_'): version for name, version in pins.items()}
        for wheel in wheels.glob('*.whl'):
            name, version = wheel.name.split('-')[:2]
            if normalized.get(name.lower()) != version:
                raise RuntimeError('unlocked Python dependency: ' + wheel.name)
            with urllib.request.urlopen('https://pypi.org/pypi/' + name + '/' + version + '/json', timeout=30) as response:
                data = json.load(response)
            hashes = {item['digests']['sha256'] for item in data['urls'] if item['filename'] == wheel.name}
            if _hash(wheel) not in hashes:
                raise RuntimeError('Python wheel checksum mismatch: ' + wheel.name)
        _run([str(python), '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install',
              '--no-index', '--no-deps', *map(str, wheels.glob('*.whl'))], timeout=600)
        for name, spec in lock['python'].get('pure_python_archives', {}).items():
            # tpk_ar publishes only a pure-Python sdist. Copy its inspected module
            # files and static metadata; never execute setuptools/build scripts.
            if name != 'tpk_ar' or spec['version'] != '0.2.4':
                raise RuntimeError('unsupported pure-Python source package')
            archive = _download(spec, downloads, offline)
            site = Path(_run([str(python), '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))']).strip())
            prefix = 'tpk_ar-0.2.4/'
            with tarfile.open(archive, 'r:gz') as bundle:
                members = bundle.getmembers()
                if sum(member.size for member in members) > 10 * 1024 ** 2:
                    raise RuntimeError('pure-Python archive exceeds size limit')
                for member in members:
                    if not member.isfile():
                        continue
                    relative = member.name.removeprefix(prefix)
                    if member.name.startswith(prefix + 'tpk_ar/') and relative.endswith('.py'):
                        dest = site / relative
                        if not dest.resolve().is_relative_to((site / 'tpk_ar').resolve()):
                            raise RuntimeError('unsafe pure-Python package path')
                    elif member.name == prefix + 'PKG-INFO':
                        dest = site / 'tpk_ar-0.2.4.dist-info/METADATA'
                    elif member.name == prefix + 'LICENSE':
                        dest = site / 'tpk_ar-0.2.4.dist-info/LICENSE'
                    else:
                        continue
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(member) as source, dest.open('wb') as output:
                        shutil.copyfileobj(source, output)
        _run([str(python), '-m', 'pip', '--isolated', 'check'])
        _run([str(python), '-c', 'import UnityPy, TypeTreeGeneratorAPI, tpk_ar'])
        shutil.rmtree(wheels)
    _install(directory, build)
    return str(directory / 'venv/bin/python')


def _patch_blutter_exports(runtime):
    # Obfuscated Code owners live in nativeLib, outside upstream app.libs.
    # Export raw ARM64 without passing anonymous functions to semantic analysis.
    path = runtime / 'blutter/src/DartDumper.cpp'
    text = path.read_text()
    marker = 'void DartDumper::DumpCode(const char* out_dir)\n{'
    if text.count(marker) != 1:
        raise RuntimeError('unsupported Blutter raw Code export layout')
    text = text.replace(marker, marker + r"""
    if (app.nativeLib.topClass) {
        std::filesystem::create_directories(out_dir);
        size_t part = 0;
        std::ofstream raw(std::filesystem::path(out_dir) / "_snapshot_raw_0.dart");
        Disassembler disassembler(false);
        for (auto function : app.nativeLib.topClass->Functions()) {
            if (function->Size() <= 0) continue;
            if (raw.tellp() > 256 * 1024) {
                raw.close();
                raw.open(std::filesystem::path(out_dir) / std::format("_snapshot_raw_{}.dart", ++part));
            }
            raw << std::format("  __unknown_function___{:x}() {{\n    // ** addr: {:#x}, size: {:#x}\n", function->Address(), function->Address(), function->Size());
            auto instructions = disassembler.Disasm((const uint8_t*)function->MemAddress(), function->Size(), function->Address());
            for (size_t i = 0; i < instructions.Count(); ++i) {
                auto instruction = instructions.Ptr(i);
                raw << std::format("    // {:#x}: {} {}\n", instruction->address, instruction->mnemonic, instruction->op_str);
            }
            raw << "  }\n";
        }
    }
""")
    path.write_text(text)


def _blutter(root, downloads, lock, offline):
    spec = lock['blutter']
    directory = root / ('blutter-' + spec['revision'])
    def build(target):
        _extract(_download(spec, downloads, offline), target / 'archive')
        source = list((target / 'archive').glob('*/blutter.py'))
        if len(source) != 1:
            raise RuntimeError('Blutter archive missing entrypoint')
        shutil.move(str(source[0].parent), target / 'source')
        shutil.rmtree(target / 'archive')
        # Upstream uses recovered library URLs as output paths. Flatten them before
        # compiling so untrusted package paths cannot escape the analysis output.
        cpp = target / 'source/blutter/src/DartLibrary.cpp'
        text = cpp.read_text()
        start = text.index('std::string DartLibrary::CreatePath(')
        end = text.index('\nvoid DartLibrary::PrintCommentInfo', start)
        text = text[:start] + """std::string DartLibrary::CreatePath(const char* base_dir)
{
    std::string leaf = url.substr(0, 180);
    for (char& c : leaf) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) c = '_';
    leaf += "_" + std::to_string(std::hash<std::string>{}(url)) + ".dart";
    return (std::filesystem::path(base_dir) / leaf).string();
}
""" + text[end:]
        cpp.write_text(text)
        _run([sys.executable, '-m', 'venv', str(target / 'venv')])
        python = target / 'venv/bin/python'
        wheels = target / 'wheels'
        wheels.mkdir()
        if offline:
            raise RuntimeError('Flutter Python environment unavailable offline')
        pins = spec['packages']
        _run([str(python), '-m', 'pip', '--isolated', '--disable-pip-version-check', 'download',
              '--index-url', 'https://pypi.org/simple', '--only-binary=:all:', '--no-deps', '--dest', str(wheels),
              *[name + '==' + version for name, version in pins.items()]], timeout=600)
        for wheel in wheels.glob('*.whl'):
            name, version = wheel.name.split('-')[:2]
            normalized = {key.replace('-', '_').lower(): value for key, value in pins.items()}
            if normalized.get(name.lower()) != version:
                raise RuntimeError('unlocked Flutter Python dependency')
            with urllib.request.urlopen('https://pypi.org/pypi/' + name + '/' + version + '/json', timeout=30) as response:
                data = json.load(response)
            hashes = {item['digests']['sha256'] for item in data['urls'] if item['filename'] == wheel.name}
            if _hash(wheel) not in hashes:
                raise RuntimeError('Flutter Python wheel checksum mismatch')
        _run([str(python), '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install',
              '--no-index', '--no-deps', *map(str, wheels.glob('*.whl'))], timeout=600)
        _run([str(python), '-m', 'pip', '--isolated', 'check'])
        shutil.rmtree(wheels)
    target = _install(directory, build)
    # Version-specific SDK/build files are mutable; keep them outside the verified
    # source/environment inventory, and restore every upstream source file on use.
    runtime = root / ('blutter-runtime-' + spec['revision'])
    if runtime.is_symlink() or (runtime.exists() and any(path.is_symlink() for path in runtime.rglob('*'))):
        raise RuntimeError('unsafe Flutter runtime cache link')
    runtime.mkdir(exist_ok=True)
    shutil.copytree(target / 'source', runtime, dirs_exist_ok=True)
    _patch_blutter_exports(runtime)
    return str(target / 'venv/bin/python'), str(runtime / 'blutter.py')


def _java_version():
    java = shutil.which('java')
    if not java:
        raise RuntimeError('JADX requires Java 11 or newer; install a JRE or set GILLII_APK_JADX')
    process = subprocess.run([java, '-version'], capture_output=True, text=True, timeout=30)
    version = re.search(r'version "(?:1\.)?(\d+)', process.stdout + process.stderr)
    if process.returncode or not version or int(version.group(1)) < 11:
        raise RuntimeError('JADX requires a working Java 11 or newer runtime')
    return (process.stdout + process.stderr).strip().splitlines()[0]


def _tool_versions(result):
    metadata = result['metadata']
    for tool in ('aapt', 'dexdump', 'jadx', 'dotnet', 'ilspy', 'python'):
        if tool not in result:
            continue
        try:
            if tool == 'dexdump':
                properties = Path(result[tool]).parent / 'source.properties'
                version = re.search(r'Pkg.Revision\s*=\s*(.+)', properties.read_text()) if properties.is_file() else None
                value = version.group(1).strip() if version else metadata['versions'].get(tool, 'not reported (no version flag)')
            elif tool == 'python':
                command = 'import sys,json,importlib.metadata as m; print(json.dumps({"python":sys.version.split()[0],"UnityPy":m.version("UnityPy"),"TypeTreeGeneratorAPI":m.version("TypeTreeGeneratorAPI")}))'
                value = json.loads(_run([result[tool], '-c', command], timeout=30))
            else:
                commands = {'aapt': [result[tool], 'version'], 'jadx': [result[tool], '--version'],
                            'dotnet': [result[tool], '--list-runtimes'],
                            'ilspy': [result.get('dotnet', 'dotnet'), result[tool], '--version']}
                value = _run(commands[tool], timeout=30).strip()[:1000]
            metadata['versions'][tool] = value
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            metadata.setdefault('version_errors', {})[tool] = str(error)


def resolve_tools(profile, offline=False):
    """Return available paths and metadata.errors; never abort unrelated stages.

    Profiles: basic (aapt), android (aapt/dexdump/jadx), managed (dotnet/ilspy),
    unity (isolated Python). ILSpy is a DLL to invoke with the returned dotnet.
    Explicit GILLII_APK_* paths are trusted user overrides, not downloaded code.
    """
    profiles = {profile} if isinstance(profile, str) else set(profile)
    offline = offline or os.environ.get('GILLII_APK_OFFLINE') == '1'
    lock = json.loads(LOCK_PATH.read_text())
    system = platform.system().lower()
    arch = {'aarch64': 'arm64', 'amd64': 'x86_64'}.get(platform.machine().lower(), platform.machine().lower())
    cache = Path(os.environ.get('GILLII_APK_CACHE', str(Path.home() / '.cache/gillii/apk'))).expanduser().resolve()
    # Lock digest isolates changes even when upstream version labels stay equal.
    root = cache / (system + '-' + arch) / _hash(LOCK_PATH)[:16]
    downloads = cache / 'downloads'
    metadata = {'errors': {}, 'sources': {}, 'versions': {}, 'cache': str(root)}
    result = {'metadata': metadata}
    requested = set()
    for name, values in {'basic': {'aapt'}, 'android': {'aapt', 'dexdump', 'jadx'},
                         'managed': {'dotnet', 'ilspy'}, 'unity': {'python'}, 'flutter': {'blutter'}}.items():
        if name in profiles:
            requested.update(values)
    for tool in sorted(requested):
        print('[apk] Preparing ' + tool + (' (offline)' if offline else ''), file=sys.stderr, flush=True)
        try:
            override = os.environ.get('GILLII_APK_' + tool.upper())
            if override:
                candidate = Path(os.path.abspath(os.path.expanduser(override)))
                if not candidate.is_file() or (tool not in ('ilspy', 'blutter') and not os.access(candidate, os.X_OK)):
                    raise RuntimeError('invalid explicit tool path: ' + str(candidate))
                result[tool] = str(candidate)
                if tool == 'blutter':
                    result['flutter_python'] = sys.executable
                metadata['sources'][tool] = 'explicit override'
                continue
            if tool in ('aapt', 'dexdump'):
                found = _android(tool)
                if found:
                    result[tool] = found
                    metadata['sources'][tool] = 'local Android SDK/PATH'
                    continue
                if system not in ('darwin', 'linux') or (system == 'linux' and arch != 'x86_64'):
                    raise RuntimeError('automatic Android tools require macOS or Linux x86_64; set explicit tool paths')
                spec = lock['android']['archives'][system]
                def build(target):
                    _extract(_download(spec, downloads, offline), target)
                    for name in ('aapt', 'dexdump'):
                        matches = list(target.rglob(name))
                        if len(matches) != 1:
                            raise RuntimeError('Android archive missing ' + name)
                        matches[0].chmod(0o755)
                target = _install(root / ('android-' + lock['android']['version']), build)
                result[tool] = str(next(target.rglob(tool)))
                metadata['versions'][tool] = lock['android']['version']
            elif tool == 'jadx':
                metadata['versions']['java'] = _java_version()
                def build(target):
                    _extract(_download(lock['jadx'], downloads, offline), target)
                    (target / 'bin/jadx').chmod(0o755)
                target = _install(root / ('jadx-' + lock['jadx']['version']), build)
                result[tool] = str(target / 'bin/jadx')
                metadata['versions'][tool] = lock['jadx']['version']
            elif tool == 'ilspy':
                def build(target):
                    archive = _download(lock['ilspy'], downloads, offline)
                    _extract(archive, target)
                target = _install(root / ('ilspy-' + lock['ilspy']['version']), build)
                result[tool] = str(target / 'tools/net8.0/any/ilspycmd.dll')
                if not Path(result[tool]).is_file():
                    raise RuntimeError('ILSpy bundle missing entrypoint')
                metadata['versions'][tool] = lock['ilspy']['version']
            elif tool == 'dotnet':
                rid = {'darwin-arm64': 'osx-arm64', 'darwin-x86_64': 'osx-x64',
                       'linux-x86_64': 'linux-x64', 'linux-arm64': 'linux-arm64'}.get(system + '-' + arch)
                if not rid:
                    raise RuntimeError('automatic .NET runtime supports macOS/Linux x64/arm64; set GILLII_APK_DOTNET for other hosts')
                version = lock['dotnet']['version']
                def build(target):
                    if rid in lock['dotnet'].get('runtime_archives', {}):
                        archive = _download(lock['dotnet']['runtime_archives'][rid], downloads, offline)
                        with tarfile.open(archive, 'r:gz') as bundle:
                            members = bundle.getmembers()
                            if sum(member.size for member in members) > 2 * 1024 ** 3:
                                raise RuntimeError('runtime archive exceeds size limit')
                            for member in members:
                                dest = target / member.name
                                if not dest.resolve().is_relative_to(target.resolve()) or not (member.isdir() or member.isfile()):
                                    raise RuntimeError('unsafe runtime archive entry')
                                if member.isdir():
                                    dest.mkdir(parents=True, exist_ok=True)
                                else:
                                    dest.parent.mkdir(parents=True, exist_ok=True)
                                    with bundle.extractfile(member) as source, dest.open('wb') as output:
                                        shutil.copyfileobj(source, output)
                                    dest.chmod(member.mode & 0o755)
                        return
                    for kind, spec in lock['dotnet']['archives'][rid].items():
                        archive = _download(spec, downloads, offline)
                        with zipfile.ZipFile(archive) as bundle:
                            for member in bundle.namelist():
                                prefix = 'runtimes/' + rid + '/'
                                if not member.startswith(prefix) or member.endswith('/'):
                                    continue
                                name = Path(member).name
                                if kind == 'host' and name == 'dotnet':
                                    dest = target / 'dotnet'
                                elif kind == 'hostresolver' and name == 'libhostfxr.dylib':
                                    dest = target / 'host/fxr' / version / name
                                elif kind == 'runtime' and (member.startswith(prefix + 'native/') or member.startswith(prefix + 'lib/net8.0/')):
                                    dest = target / 'shared/Microsoft.NETCore.App' / version / name
                                else:
                                    continue
                                dest.parent.mkdir(parents=True, exist_ok=True)
                                dest.write_bytes(bundle.read(member))
                    (target / 'dotnet').chmod(0o755)
                target = _install(root / ('dotnet-' + version), build)
                result[tool] = str(target / 'dotnet')
                metadata['versions'][tool] = version
            elif tool == 'blutter':
                if system not in ('darwin', 'linux'):
                    raise RuntimeError('automatic Flutter analysis requires macOS/Linux')
                result['flutter_python'], result[tool] = _blutter(root, downloads, lock, offline)
                metadata['versions'][tool] = lock['blutter']['revision']
            elif tool == 'python':
                if system not in ('darwin', 'linux'):
                    raise RuntimeError('automatic Unity Python environment requires macOS/Linux')
                result[tool] = _unity(root / ('python-' + platform.python_version()), downloads, lock, offline)
                metadata['versions'][tool] = lock['python']['packages']
            metadata['sources'][tool] = 'verified isolated cache'
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile, tarfile.TarError) as error:
            result.pop(tool, None)
            metadata['errors'][tool] = str(error)
    _tool_versions(result)
    return result
