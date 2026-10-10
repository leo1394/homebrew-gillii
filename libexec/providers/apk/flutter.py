"""Flutter AOT adapter. Analysis output is assembly, never original Dart source."""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from workbench import safe_file
from dart_aot import lift_instruction, enrich, symbol_evidence
from dart_flow import analyze


def aot_input(root):
    base = 'extracted/lib/arm64-v8a/'
    paths = [safe_file(root, base + name) for name in ('libapp.so', 'libflutter.so')]
    if all(paths):
        for path in paths:
            with path.open('rb') as stream:
                header = stream.read(20)
            if len(header) < 20 or header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != 183:
                return None
        return paths[0].parent
    return None


def index_output(root):
    base = root / 'decompiled/dart'
    records = []
    files = []
    budget = 128 * 1024 * 1024
    truncated = False
    instruction_budget = 100000
    for path in sorted((base / 'asm').glob('*.dart'), key=lambda item: (2 if item.name.startswith(('dart_', 'package_flutter_', 'package_flutter__')) else 1 if item.name.startswith('_snapshot_raw_') else 0, int(match[1]) if (match := re.fullmatch(r'_snapshot_raw_(\d+)\.dart', item.name)) else 0, item.name)):
        relative = path.relative_to(root).as_posix()
        path = safe_file(root, relative)
        if path is None:
            continue
        files.append(relative)
        if path.stat().st_size > min(budget, 4 * 1024 * 1024):
            truncated = True
            continue
        budget -= path.stat().st_size
        previous = ''
        owner = None
        for number, line in enumerate(path.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
            match = re.search(r'// \*\* addr: (0x[0-9a-fA-F]+), size: (-?0x[0-9a-fA-F]+)', line)
            if match:
                if len(records) >= 20000:
                    truncated = True
                    break
                owner = {'name': previous.strip()[:500], 'address': match[1].lower(), 'size': match[2], 'assembly_available': not match[2].startswith('-'), 'file': relative, 'line': number - 1, 'calls': [], 'indirect_calls': [], 'pseudocode': [], 'pseudocode_truncated': False, 'calls_truncated': False}
                records.append(owner)
            elif owner and owner['assembly_available']:
                instruction = lift_instruction(line, number)
                if instruction:
                    call = instruction.pop('call')
                    if instruction['kind'] == 'branch' and instruction['text'].startswith('goto ') and int(owner['size'], 16) > 0:
                        target = re.search(r'\bb\s+#?(0x[0-9a-fA-F]+)', line)
                        if target and not int(owner['address'], 16) <= int(target[1], 16) < int(owner['address'], 16) + int(owner['size'], 16):
                            call = {'address': target[1].lower(), 'line': number, 'instruction': instruction['address'], 'kind': 'tail'}
                            instruction['text'] = 'tail_call_at(' + target[1] + ');'
                            instruction['kind'] = 'call'
                            instruction['terminator'] = 'tail'
                    if call:
                        bucket = owner['indirect_calls'] if call['kind'] == 'indirect' else owner['calls']
                        if len(bucket) < 100:
                            bucket.append(call)
                        else:
                            owner['calls_truncated'] = True
                            truncated = True
                    if instruction_budget > 0 and len(owner['pseudocode']) < 2000:
                        owner['pseudocode'].append(instruction)
                        instruction_budget -= 1
                    else:
                        owner['pseudocode_truncated'] = True
                        truncated = True
            previous = line
    symbols, ranges, pool = symbol_evidence(root)
    for item in records:
        item['flow'] = analyze(item['pseudocode'], item['pseudocode_truncated'])
        item['dart_semantics'] = []
        for row in item['pseudocode']:
            match = re.search(r'\[PP,\s*#(0x[0-9a-fA-F]+)\]', row.get('operands', ''))
            entry = pool.get(match[1].lower()) if match else None
            if entry:
                item['dart_semantics'].append({'kind': 'object_pool', 'instruction': row['address'], **entry, 'evidence_line': entry['line'], 'line': row['line']})
        for call in item['calls']:
            names = symbols.get(call['address'], [])
            stub = next((entry for entry in names if '::' not in entry['name']), None)
            if stub:
                name = stub['name']
                kind = 'async_runtime' if any(word in name for word in ('Await', 'Async')) else 'type_check' if any(word in name for word in ('TypeTest', 'IsType', 'Subtype')) else 'runtime_stub'
                item['dart_semantics'].append({'kind': kind, 'instruction': call['instruction'], 'line': call['line'], 'value': name, 'file': stub['file'], 'evidence_line': stub['line']})
    graph = enrich(records, symbols, ranges)
    details = root / 'evidence/dart-details'
    details.mkdir(exist_ok=True)
    for item in records:
        item['detail_file'] = 'evidence/dart-details/' + item['address'] + '.json'
        (root / item['detail_file']).write_text(json.dumps(item, ensure_ascii=True, separators=(',', ':')) + '\n')
    graph['truncated'] = truncated
    (root / 'evidence/dart-callgraph.json').write_text(json.dumps(graph, ensure_ascii=True, indent=2) + '\n')
    data = {'pseudocode_scope': 'Low-level ARM64 pseudocode with machine registers and NZCV flags; not runnable Dart. Unknown instructions remain asm() intrinsics. Every row maps to an assembly line.', 'scope': 'Blutter static assembly and object-pool analysis; original Dart source is not recovered.',
            'functions': records, 'symbols': [node for node in graph['nodes'] if node['kind'] != 'function'], 'mapping_diagnostics': graph['mapping_diagnostics'], 'files': files[:3000], 'truncated': truncated or len(files) > 3000}
    (root / 'evidence/dart-functions.json').write_text(json.dumps(data, ensure_ascii=True, separators=(',', ':')) + '\n')
    return {'function_count': len(records), 'assembly_files': len(files), 'truncated': data['truncated'],
            'callgraph': 'evidence/dart-callgraph.json', 'pseudocode_functions': sum(bool(item['pseudocode']) for item in records),
            'symbol_resolved_edges': graph['symbol_resolved_edges'], 'body_resolved_edges': graph['body_resolved_edges'],
            'cfg_functions': sum(bool(item['flow']['blocks']) for item in records), 'control_regions': sum(len(item['flow']['regions']) for item in records),
            'direct_call_edges': len(graph['edges']), 'resolved_call_edges': graph['resolved_edges'], 'unresolved_indirect_calls': graph['unresolved_indirect_calls'],
            'evidence': 'evidence/dart-functions.json', 'output': 'decompiled/dart'}


def run_backend(script, libraries, output, offline):
    # Executed only for a supported Flutter APK, never during install/setup/mini.
    import fcntl
    script = Path(script).resolve()
    sys.path.insert(0, str(script.parent))
    import blutter
    import dartvm_fetch_build
    real_info = blutter.get_dart_lib_info
    def checked_info(app, engine):
        info = real_info(app, engine)
        if not re.fullmatch(r'(?:\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?|[a-f0-9]{40})', info.version) or info.arch != 'arm64' or info.os_name != 'android':
            raise RuntimeError('unsupported Dart version or target')
        return info
    blutter.get_dart_lib_info = checked_info
    if offline:
        import requests
        def blocked(*args, **kwargs):
            raise RuntimeError('Flutter version resolution needs network; unavailable offline')
        requests.head = requests.get = blocked
        real_checkout = dartvm_fetch_build.checkout_dart
        def cached_checkout(info):
            version_file = Path(dartvm_fetch_build.SDK_DIR) / ('v' + info.version) / 'runtime/vm/version.cc'
            if not version_file.is_file():
                raise RuntimeError('matching Dart runtime unavailable offline')
            return real_checkout(info)
        dartvm_fetch_build.checkout_dart = cached_checkout
    with (script.parent / '.build.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if shutil.which('brew'):
            prefix = subprocess.check_output(['brew', '--prefix', 'icu4c'], text=True).strip()
            os.environ['PKG_CONFIG_PATH'] = prefix + '/lib/pkgconfig' + (':' + os.environ['PKG_CONFIG_PATH'] if os.environ.get('PKG_CONFIG_PATH') else '')
        tools = ['cmake', 'ninja', 'pkg-config', 'git']
        missing = [name for name in tools if not shutil.which(name)]
        packages = []
        for name in ('capstone', 'icu-uc'):
            if not shutil.which('pkg-config') or subprocess.run(['pkg-config', '--exists', name]).returncode:
                packages.append('icu4c' if name == 'icu-uc' else name)
        if missing or packages:
            brew = shutil.which('brew')
            if offline or sys.platform != 'darwin' or not brew:
                raise RuntimeError('Flutter build prerequisites missing: ' + ', '.join(missing + packages) + '. Install C++20 compiler, cmake, ninja, pkg-config, ICU and capstone.')
            print('[apk] Preparing Flutter compiler dependencies', flush=True)
            subprocess.run([brew, 'install', *[name for name in missing if name != 'git'], *packages], check=True,
                           env={**os.environ, 'HOMEBREW_NO_AUTO_UPDATE': '1'}, timeout=1200)
        info = checked_info(str(Path(libraries) / 'libapp.so'), str(Path(libraries) / 'libflutter.so'))
        revision = script.parent / ('.gillii-raw-code-v3-' + info.version)
        rebuild = not revision.is_file()
        blutter.main(str(libraries), str(output), rebuild, False, False)
        revision.write_text('raw Code export v3\n')
        builds = list((script.parent / 'dartsdk').glob('*/.git'))
        for git in builds:
            commit = subprocess.check_output(['git', '-C', str(git.parent), 'rev-parse', 'HEAD'], text=True).strip()
            print('Dart runtime source commit: ' + commit, flush=True)


if __name__ == '__main__':
    run_backend(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == 'offline' or os.environ.get('GILLII_APK_OFFLINE') == '1')
