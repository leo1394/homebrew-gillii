#!/usr/bin/env python3
"""Static APK evidence pipeline. Never executes application code."""
import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

from cclient import analyze as analyze_cclient
from report import write_report
from flutter import aot_input, index_output

MAX_ENTRIES = 100000
MAX_FILE = 1024 * 1024 * 1024
MAX_TOTAL = 8 * 1024 * 1024 * 1024
MAX_RATIO = 1000
CHUNK = 1024 * 1024


class InvalidAPK(ValueError):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(CHUNK), b''):
            digest.update(block)
    return digest.hexdigest()


def validate_entries(archive, allow_case_files=False):
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES:
        raise InvalidAPK('ZIP entry count exceeds limit')
    paths, total, result = {}, 0, []
    exact_paths = set()
    for entry in entries:
        name = entry.filename
        # orig_filename retains NULs that ZipInfo.filename would silently truncate.
        if entry.orig_filename != name or not name or '\\' in name or ':' in name or any(ord(c) < 32 for c in name):
            raise InvalidAPK('unsafe ZIP path: ' + repr(name))
        value = name[:-1] if entry.is_dir() else name
        parts = value.split('/')
        if any(p in ('', '.', '..') or p.endswith((' ', '.')) for p in parts) or PurePosixPath(value).is_absolute():
            raise InvalidAPK('unsafe ZIP path: ' + repr(name))
        mode = entry.external_attr >> 16
        if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise InvalidAPK('ZIP links and special files are not allowed: ' + name)
        if stat.S_ISDIR(mode) and not entry.is_dir():
            raise InvalidAPK('inconsistent ZIP directory: ' + name)
        if entry.flag_bits & 1:
            raise InvalidAPK('encrypted ZIP members are not supported')
        key = unicodedata.normalize('NFC', value).casefold()
        if value in exact_paths or (key in paths and (not allow_case_files or entry.is_dir() or paths[key][0])):
            raise InvalidAPK('duplicate or case-colliding ZIP path: ' + name)
        exact_paths.add(value)
        paths.setdefault(key, (entry.is_dir(), value))
        if entry.file_size > MAX_FILE or entry.file_size < 0:
            raise InvalidAPK('ZIP member exceeds size limit: ' + name)
        if entry.file_size > max(entry.compress_size, 1) * MAX_RATIO:
            raise InvalidAPK('ZIP compression ratio exceeds limit: ' + name)
        total += entry.file_size
        if total > MAX_TOTAL:
            raise InvalidAPK('ZIP total size exceeds limit')
        result.append(entry)
    # Compare implicit directory names too: Foo/a and foo/b collide on macOS.
    directory_spellings = {}
    for entry in result:
        parts = entry.filename.rstrip('/').split('/')
        for i in range(1, len(parts) + (1 if entry.is_dir() else 0)):
            directory = '/'.join(parts[:i])
            key = unicodedata.normalize('NFC', directory).casefold()
            if key in paths and not paths[key][0]:
                raise InvalidAPK('ZIP file/directory collision: ' + directory)
            previous = directory_spellings.setdefault(key, directory)
            if previous != directory:
                raise InvalidAPK('case-colliding ZIP directory: ' + directory)
            if key in paths and paths[key][1] != directory:
                raise InvalidAPK('case-colliding ZIP directory: ' + directory)
    manifest = next((e for e in result if e.filename == 'AndroidManifest.xml' and not e.is_dir()), None)
    if manifest is None:
        raise InvalidAPK('APK must contain a root AndroidManifest.xml')
    return result


def validate_manifest(path):
    if path.stat().st_size > 16 * 1024 * 1024:
        raise InvalidAPK('AndroidManifest.xml exceeds limit')
    content = path.read_bytes()
    if content.startswith(b'\x03\x00\x08\x00'):
        if len(content) < 8 or struct.unpack_from('<I', content, 4)[0] != len(content):
            raise InvalidAPK('invalid binary AndroidManifest.xml length')
        offset, has_element = 8, False
        while offset < len(content):
            if offset + 8 > len(content):
                raise InvalidAPK('truncated binary manifest chunk')
            kind, header_size, chunk_size = struct.unpack_from('<HHI', content, offset)
            if header_size < 8 or chunk_size < header_size or offset + chunk_size > len(content):
                raise InvalidAPK('invalid binary manifest chunk')
            has_element = has_element or kind == 0x0102
            offset += chunk_size
        if not has_element:
            raise InvalidAPK('binary manifest has no XML element')
        return
    try:
        root = ElementTree.fromstring(content)
    except (ElementTree.ParseError, ValueError) as exc:
        raise InvalidAPK('invalid AndroidManifest.xml: ' + str(exc)) from exc
    if root.tag != 'manifest':
        raise InvalidAPK('AndroidManifest.xml root must be manifest')


def extract_apk(source, destination):
    inventory = []
    with zipfile.ZipFile(source) as archive:
        entries = validate_entries(archive, allow_case_files=True)
        reserved = {unicodedata.normalize('NFC', '/'.join(e.filename.rstrip('/').split('/')[:i])).casefold()
                    for e in entries for i in range(1, len(e.filename.rstrip('/').split('/')) + 1)}
        used = set()
        actual_total = 0
        for entry in entries:
            relative = entry.filename
            key = unicodedata.normalize('NFC', relative.rstrip('/')).casefold()
            if key in used:
                path = PurePosixPath(relative)
                suffix = hashlib.sha256(relative.encode('utf-8')).hexdigest()
                relative = str(path.with_name(path.stem + '.gillii-' + suffix + path.suffix))
                mapped_key = unicodedata.normalize('NFC', relative).casefold()
                while mapped_key in reserved:
                    relative += '_'
                    mapped_key = unicodedata.normalize('NFC', relative).casefold()
                reserved.add(mapped_key)
            used.add(key)
            target = destination / relative
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            size, digest = 0, hashlib.sha256()
            with archive.open(entry) as stream, target.open('xb') as output:
                while True:
                    block = stream.read(CHUNK)
                    if not block:
                        break
                    size += len(block)
                    actual_total += len(block)
                    if size > MAX_FILE or size > entry.file_size or actual_total > MAX_TOTAL:
                        raise InvalidAPK('ZIP decompressed bytes exceed declared size or limits')
                    digest.update(block)
                    output.write(block)
            if size != entry.file_size:
                raise InvalidAPK('ZIP size mismatch: ' + entry.filename)
            expected_hash = digest.hexdigest()
            if sha256(target) != expected_hash:
                raise InvalidAPK('extracted file verification failed: ' + entry.filename)
            inventory.append({'path': relative, 'archive_path': entry.filename, 'bytes': size, 'crc32': '%08x' % entry.CRC,
                              'sha256': expected_hash, 'verified': True})
    validate_manifest(destination / 'AndroidManifest.xml')
    return inventory


def detect(root):
    files = sorted(p for p in root.rglob('*') if p.is_file())
    names = [p.relative_to(root).as_posix() for p in files]
    dex = [n for n in names if re.fullmatch(r'classes(?:[0-9]+)?\.dex', n)]
    managed = [n for n in names if n.lower().endswith('.dll') and any(p.lower() == 'managed' for p in PurePosixPath(n).parts)]
    native = [n for n in names if n.lower().endswith('.so')]
    il2cpp = [n for n in names if n.endswith(('libil2cpp.so', 'global-metadata.dat'))]
    flutter = [n for n in names if '/flutter_assets/' in '/' + n or n.endswith('libflutter.so')]
    from unity_export import candidates
    unity_inputs = [p.relative_to(root).as_posix() for p in candidates(root)]
    unity = bool(il2cpp or unity_inputs or any(Path(n).name.lower() in ('libunity.so', 'unityengine.dll', 'unityengine.coremodule.dll') for n in names))
    return {'dex': dex, 'managed': managed, 'native': native, 'il2cpp': il2cpp,
            'flutter': flutter, 'unity': unity, 'unity_inputs': unity_inputs,
            'limitations': ['Native libraries and IL2CPP are inventoried only; original C/C++/Dart source is not reconstructed.'] if native or il2cpp or flutter else []}


def skip_assembly(name):
    name = name.lower()
    if name in ('mscorlib.dll', 'netstandard.dll', 'system.dll', 'microsoft.csharp.dll', 'mono.security.dll', 'i18n.dll'):
        return 'runtime/framework assembly'
    if name.startswith(('system.', 'microsoft.', 'mono.', 'i18n.')):
        return 'runtime/framework assembly'
    if name in ('unityengine.dll', 'unityeditor.dll') or name.startswith(('unityengine.', 'unityeditor.', 'unity.')):
        return 'Unity framework assembly'
    return None


def log_event(root, message):
    with (root / 'logs/execution.log').open('a', encoding='utf-8') as stream:
        stream.write(time.strftime('%Y-%m-%dT%H:%M:%S%z') + ' ' + message + '\n')


class Runner:
    def __init__(self, root, report, timeout=600):
        self.root, self.report, self.timeout = root, report, timeout

    def run(self, stage, argv):
        print('APK stage: ' + stage, file=sys.stderr, flush=True)
        number = len(self.report['commands']) + 1
        log = self.root / 'logs' / ('%03d-' % number + re.sub(r'[^A-Za-z0-9_-]', '_', stage) + '.log')
        command = {'stage': stage, 'argv': [str(v) for v in argv], 'cwd': str(self.root),
                   'log': log.relative_to(self.root).as_posix()}
        self.report['commands'].append(command)
        log_event(self.root, 'START ' + stage + ' argv=' + json.dumps(command['argv']) + ' log=' + command['log'])
        start = time.monotonic()
        process = None
        try:
            with log.open('wb') as stream:
                process = subprocess.Popen(command['argv'], cwd=self.root, stdout=stream, stderr=subprocess.STDOUT,
                                           stdin=subprocess.DEVNULL, start_new_session=True)
                try:
                    command['returncode'] = process.wait(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    command.update(returncode=124, error='command timed out after ' + str(self.timeout) + ' seconds')
        except OSError as exc:
            command.update(returncode=127, error=str(exc))
        finally:
            command['seconds'] = round(time.monotonic() - start, 3)
        log_event(self.root, 'END ' + stage + ' exit=' + str(command['returncode']) + ' seconds=' + str(command['seconds']) + ' error=' + str(command.get('error', '')))
        status = 'complete' if command['returncode'] == 0 else 'partial'
        self.report['stages'].append({'name': stage, 'status': status, 'log': command['log'],
                                      'returncode': command['returncode'], 'error': command.get('error')})
        return command['returncode'] == 0, log

    def missing(self, stage, tool):
        reason = self.report.get('dependencies', {}).get('errors', {}).get(tool, 'required tool unavailable')
        self.report['stages'].append({'name': stage, 'status': 'partial', 'error': str(reason), 'tool': tool})
        log_event(self.root, 'UNAVAILABLE ' + stage + ': ' + str(reason))


def summarize_decompilation(root, report):
    """Keep tool failures separate from retained, approximate Java output."""
    outputs = {'dex-decompile': ('normal', 'decompiled/java'), 'dex-simple': ('simple', 'decompiled/java-simple')}
    summaries = []
    for stage in report['stages']:
        if stage['name'] not in outputs:
            continue
        mode, output = outputs[stage['name']]
        count = sum(1 for path in (root / output).rglob('*.java') if path.is_file() and not path.is_symlink())
        summary = {'stage': stage['name'], 'mode': mode, 'output': output, 'source_files': count,
                   'returncode': stage.get('returncode'), 'error_count': None, 'diagnostics': []}
        log = root / stage.get('log', 'logs/unavailable')
        if log.is_file() and not log.is_symlink():
            # The final JADX summary is at the tail. Avoid loading debug logs in full.
            with log.open('rb') as stream:
                stream.seek(max(0, log.stat().st_size - 128 * 1024))
                text = stream.read(128 * 1024).decode('utf-8', errors='replace')
            matches = re.findall(r'(?:finished with errors, count:\s*|ERROR\s+-\s+)(\d{1,12})(?!\d)(?: errors occurred)?', text)
            if matches:
                summary['error_count'] = int(matches[-1])
            for line in text.splitlines():
                if 'ERROR' in line and ('Method:' in line or 'Class:' in line):
                    summary['diagnostics'].append(line.strip()[:500])
                    if len(summary['diagnostics']) >= 12:
                        break
        if stage['status'] != 'complete' and not stage.get('error'):
            stage['error'] = 'JADX exit=' + str(stage.get('returncode')) + '; ' + str(count) + ' Java files retained'
            if summary['error_count'] is not None:
                stage['error'] += '; ' + str(summary['error_count']) + ' decompiler errors'
            stage['error'] += '. Output is approximate; inspect the retained diagnostics.'
        summaries.append(summary)
    report['decompilation'] = summaries


def analyze(source, output=None, offline=False, timeout=600, resolver=None):
    source = Path(source).expanduser().resolve()
    # An explicit output is an exact new directory; never merge with previous results.
    if output:
        root = Path(output).expanduser().absolute()
        root.mkdir(parents=True, exist_ok=False)
        root = root.resolve()
    else:
        slug = re.sub(r'[^A-Za-z0-9_.-]', '_', source.stem)[:60] or 'application'
        root = Path(tempfile.mkdtemp(prefix=slug + '-apk-', dir=Path.cwd()))
    report = {'schema_version': 1, 'status': 'failed', 'input': str(source), 'output': str(root),
              'commands': [], 'stages': [], 'errors': [], 'analysis': 'static; application code is never executed'}
    for directory in ('raw', 'extracted', 'evidence', 'logs', 'docs'):
        (root / directory).mkdir()
    runner = Runner(root, report, timeout)
    report['execution_log'] = 'logs/execution.log'
    log_event(root, 'START input=' + str(source))
    try:
        if not source.exists():
            raise InvalidAPK('APK file not found: ' + str(source))
        if not source.is_file():
            raise InvalidAPK('APK input is not a regular file: ' + str(source))
        if source.stat().st_size > MAX_TOTAL:
            raise InvalidAPK('APK file exceeds 8 GiB limit: ' + str(source))
        original = root / 'raw' / 'original.apk'
        digest, size = hashlib.sha256(), 0
        with source.open('rb') as incoming, original.open('xb') as outgoing:
            for block in iter(lambda: incoming.read(CHUNK), b''):
                size += len(block)
                if size > MAX_TOTAL:
                    raise InvalidAPK('input exceeds 8 GiB limit')
                digest.update(block)
                outgoing.write(block)
        report['input_sha256'] = digest.hexdigest()
        report['original_copy_sha256'] = sha256(original)
        if report['input_sha256'] != report['original_copy_sha256']:
            raise InvalidAPK('original copy hash verification failed')
        print('APK stage: verify and extract', file=sys.stderr, flush=True)
        log_event(root, 'START verify and extract')
        inventory = extract_apk(original, root / 'extracted')
        log_event(root, 'END extraction files=' + str(len(inventory)))
        (root / 'evidence/files.json').write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')
        report['extraction'] = {'files': len(inventory), 'bytes': sum(i['bytes'] for i in inventory),
                                'verified': True, 'renamed': sum(i['path'] != i['archive_path'] for i in inventory), 'inventory': 'evidence/files.json'}
        report['stages'].append({'name': 'extraction', 'status': 'complete'})
        detected = detect(root / 'extracted')
        report['detected'] = detected
        if detected['native'] or detected['il2cpp'] or detected['flutter']:
            report['stages'].append({'name': 'unsupported-source-recovery', 'status': 'partial',
                                      'error': ('Flutter original Dart source is not recovered; runtime libraries and assets are retained. JADX analyzes only Android Java/Kotlin code.' if detected['flutter'] else 'Native/IL2CPP original source recovery is unsupported; binary evidence is retained.')})
        flutter_input = aot_input(root) if detected['flutter'] else None
        profiles = {'android' if detected['dex'] else 'basic'}
        if flutter_input:
            profiles.add('flutter')
        if detected['managed']:
            profiles.add('managed')
        if detected['unity']:
            profiles.add('unity')
        if resolver is None:
            from deps import resolve_tools
            resolver = resolve_tools
        log_event(root, 'START dependencies profiles=' + str(sorted(profiles)))
        try:
            tools = resolver(profiles, offline=offline)
        except Exception as exc:
            tools = {'metadata': {'errors': {'resolver': str(exc)}}}
            report['stages'].append({'name': 'dependencies', 'status': 'partial', 'error': str(exc)})
        report['dependencies'] = tools.get('metadata', {})
        log_event(root, 'END dependencies errors=' + json.dumps(report['dependencies'].get('errors', {})))
        report['tool_paths'] = {k: v for k, v in tools.items() if isinstance(v, str)}
        if tools.get('aapt'):
            for name, arguments in (('metadata', ['dump', 'badging', str(original)]),
                                    ('manifest', ['dump', 'xmltree', str(original), 'AndroidManifest.xml'])):
                ok, log = runner.run(name, [tools['aapt']] + arguments)
                shutil.copyfile(log, root / 'evidence' / (name + '.txt'))
                if ok and log.stat().st_size == 0:
                    report['stages'].append({'name': name + '-output', 'status': 'partial', 'error': 'tool produced empty output'})
        else:
            runner.missing('metadata/manifest', 'aapt')
        if detected['dex']:
            if tools.get('jadx'):
                ok, log = runner.run('dex-decompile', [tools['jadx'], '--log-level', 'debug', '-d', str(root / 'decompiled/java'), str(original)])
                if not ok:
                    # Preserve normal output; simplified instructions aid inspection of methods
                    # whose control flow/type reconstruction failed. This is not full recovery.
                    fallback = root / 'decompiled/java-simple'
                    fallback_ok, _ = runner.run('dex-simple', [tools['jadx'], '--log-level', 'debug',
                                                 '--decompilation-mode', 'simple', '--no-res', '-d', str(fallback), str(original)])
                    if fallback_ok and not any(fallback.rglob('*.java')):
                        report['stages'].append({'name': 'dex-simple-output', 'status': 'partial', 'error': 'JADX produced no simplified source'})
                if ok and not any((root / 'decompiled/java').rglob('*.java')):
                    report['stages'].append({'name': 'dex-output', 'status': 'partial', 'error': 'JADX produced no Java source'})
            else:
                runner.missing('dex-decompile', 'jadx')
            for index, dex in enumerate(detected['dex']):
                if tools.get('dexdump'):
                    ok, log = runner.run('dexdump-' + str(index), [tools['dexdump'], '-f', str(root / 'extracted' / dex)])
                    shutil.copyfile(log, root / 'evidence' / (Path(dex).name + '.txt'))
                else:
                    runner.missing('dexdump-' + str(index), 'dexdump')
        if detected['flutter']:
            report['flutter'] = {'status': 'partial', 'original_source_recovered': False}
            if flutter_input and tools.get('blutter') and tools.get('flutter_python'):
                before = runner.timeout
                runner.timeout = max(before, 1800)
                try:
                    ok, _ = runner.run('flutter-aot', [tools['flutter_python'], str(Path(__file__).with_name('flutter.py')),
                                             tools['blutter'], str(flutter_input), str(root / 'decompiled/dart'), 'offline' if offline else 'online'])
                finally:
                    runner.timeout = before
                report['flutter'].update(index_output(root))
                report['flutter']['status'] = 'complete' if ok and report['flutter']['assembly_files'] else 'partial'
                if ok and not report['flutter']['assembly_files']:
                    report['stages'].append({'name': 'flutter-output', 'status': 'partial', 'error': 'Blutter produced no assembly files'})
            elif flutter_input:
                runner.missing('flutter-aot', 'blutter')
            else:
                report['stages'].append({'name': 'flutter-aot', 'status': 'partial',
                                         'error': 'No supported ARM64 ELF libapp.so/libflutter.so pair; binaries/assets retained.'})
        assemblies = []
        for index, assembly in enumerate(detected['managed']):
            path = root / 'extracted' / assembly
            reason = skip_assembly(path.name)
            record = {'path': assembly, 'skipped': bool(reason), 'reason': reason}
            assemblies.append(record)
            if reason:
                continue
            if not tools.get('dotnet') or not tools.get('ilspy'):
                runner.missing('managed-' + path.name, 'ilspy' if not tools.get('ilspy') else 'dotnet')
                continue
            destination = root / 'decompiled/managed' / (str(index) + '-' + path.stem)
            args = [tools['dotnet'], tools['ilspy'], '-p', '-o', str(destination)]
            for reference in sorted({str((root / 'extracted' / p).parent) for p in detected['managed']}):
                args.extend(['-r', reference])
            args.append(str(path))
            ok, log = runner.run('managed-' + path.name, args)
            record['status'] = 'complete' if ok else 'partial'
            record['output'] = destination.relative_to(root).as_posix()
            record['source_files'] = len(list(destination.rglob('*.cs')))
            if ok and not record['source_files']:
                record['status'] = 'partial'
                report['stages'].append({'name': 'managed-output-' + path.name, 'status': 'partial',
                                          'error': 'ILSpy produced no C# source'})
        report['assemblies'] = assemblies
        if detected['unity']:
            if tools.get('python'):
                ok, log = runner.run('unity-export', [tools['python'], str(Path(__file__).with_name('unity_export.py')),
                                           '--input', str(root / 'extracted'), '--output', str(root / 'unity-export'),
                                           '--evidence', str(root / 'evidence/unity-objects.json')])
                evidence = root / 'evidence/unity-objects.json'
                try:
                    unity = json.loads(evidence.read_text(encoding='utf-8'))
                    report['unity'] = {'counts': unity['counts'], 'unity_versions': unity['unity_versions'],
                                       'objects': len(unity['objects']), 'errors': len(unity['errors']),
                                       'header_verified': sum(bool(o.get('header_verified')) for o in unity['objects']),
                                       'evidence': 'evidence/unity-objects.json'}
                    if unity['errors'] and ok:
                        report['stages'].append({'name': 'unity-objects', 'status': 'partial', 'error': 'object export errors'})
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    report['stages'].append({'name': 'unity-evidence', 'status': 'partial', 'error': str(exc)})
            else:
                runner.missing('unity-export', 'python')
        try:
            configs = analyze_cclient(root / 'extracted')
            if configs['projects']:
                (root / 'evidence/cclient.json').write_text(json.dumps(configs, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
                report['cclient'] = {'projects': len(configs['projects']), 'reference_issues': len(configs['issues']),
                                     'errors': len(configs['errors']), 'evidence': 'evidence/cclient.json'}
                report['stages'].append({'name': 'cclient', 'status': 'partial' if configs['errors'] else 'complete'})
        except Exception as exc:
            report['stages'].append({'name': 'cclient', 'status': 'partial', 'error': str(exc)})
        report['status'] = 'partial' if any(s['status'] == 'partial' for s in report['stages']) else 'complete'
    except (InvalidAPK, zipfile.BadZipFile, OSError, ValueError, RuntimeError, NotImplementedError) as exc:
        report['errors'].append(str(exc))
        report['status'] = 'failed'
        print_error(str(exc))
    finally:
        try:
            summarize_decompilation(root, report)
        except (OSError, ValueError) as exc:
            report['diagnostic_summary_error'] = str(exc)[:500]
        for error in report['errors']:
            log_event(root, 'ERROR ' + error)
        for stage in report['stages']:
            if stage['status'] != 'complete':
                reason = stage.get('error') or ('exit=' + str(stage.get('returncode')))
                log_event(root, 'ISSUE ' + stage['name'] + ': ' + reason)
                print_error(stage['name'] + ': ' + reason)
        log_event(root, 'FINISH status=' + report['status'])
        report['logs_retained'] = report['status'] != 'complete'
        if report['status'] == 'complete':
            report['execution_log'] = None
            for record in report['commands'] + report['stages']:
                if 'log' in record:
                    record['log_retained'] = False
            write_report(root, report)
            shutil.rmtree(root / 'logs')
        else:
            print_error('See execution log: ' + str(root / 'logs/execution.log'))
            print_error('See detailed tool logs: ' + str(root / 'logs'))
        write_report(root, report)
    return {'complete': 0, 'partial': 2, 'failed': 1}[report['status']], root


def print_error(message):
    text = 'gillii: ' + message
    if sys.stderr.isatty() and 'NO_COLOR' not in os.environ and os.environ.get('TERM') != 'dumb':
        text = '\x1b[1;31m' + text + '\x1b[0m'
    print(text, file=sys.stderr, flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, help='APK archive to inspect statically')
    parser.add_argument('--output', help='new output directory (must not already exist)')
    parser.add_argument('--offline', action='store_true', help='use cached tools only')
    parser.add_argument('--timeout', type=int, default=600, help='per-command timeout in seconds (default: 600)')
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    try:
        code, root = analyze(args.input, args.output, args.offline or os.environ.get('GILLII_APK_OFFLINE') == '1', args.timeout)
    except OSError as exc:
        print_error('APK analysis could not create output: ' + str(exc))
        return 1
    print('APK analysis ' + {0: 'complete', 2: 'partial', 1: 'failed'}[code] + ': ' + str(root))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
