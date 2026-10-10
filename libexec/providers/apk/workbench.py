"""Bounded, path-safe inventory for the APK developer workbench."""
import os
import re
from pathlib import Path
from xml.etree import ElementTree


MAX_SOURCES = 1000
MAX_MANIFEST = 4 * 1024 * 1024
COMPONENTS = ('application', 'activity', 'activity-alias', 'service', 'receiver', 'provider')


def safe_file(root, relative):
    path = root / relative
    if any(part in ('', '.', '..') for part in Path(relative).parts):
        return None
    current = root
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            return None
    try:
        if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            return None
    except OSError:
        return None
    return path


def source_inventory(root):
    files = []
    truncated = False
    base = root / 'decompiled'
    if not base.is_dir() or base.is_symlink():
        return files, truncated
    for directory, dirs, names in os.walk(base, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink() and not (Path(directory) == base and d == 'dart'))
        for name in sorted(names):
            if Path(name).suffix.lower() not in ('.java', '.kt', '.cs', '.dart'):
                continue
            relative = (Path(directory) / name).relative_to(root).as_posix()
            path = safe_file(root, relative)
            if path is None:
                continue
            if len(files) == MAX_SOURCES:
                truncated = True
                break
            files.append({'path': relative, 'bytes': path.stat().st_size,
                          'group': relative.split('/')[1] if len(relative.split('/')) > 2 else 'decompiled'})
        if truncated:
            break
    return files, truncated


def manifest_components(root):
    package = ''
    entries = []
    path = safe_file(root, 'extracted/AndroidManifest.xml')
    if path is not None and path.stat().st_size <= MAX_MANIFEST:
        content = path.read_bytes()
        if content.lstrip().startswith(b'<'):
            try:
                document = ElementTree.fromstring(content)
                package = document.get('package', '')
                for item in document.iter():
                    kind = item.tag.rsplit('}', 1)[-1]
                    if kind not in COMPONENTS:
                        continue
                    name = item.get('{http://schemas.android.com/apk/res/android}name')
                    if name:
                        entry = {'kind': kind, 'name': name, 'evidence': 'extracted/AndroidManifest.xml'}
                        if kind == 'activity-alias':
                            entry['targetActivity'] = item.get('{http://schemas.android.com/apk/res/android}targetActivity', '')
                        entries.append(entry)
            except ElementTree.ParseError:
                pass
    if entries:
        return package, entries
    path = safe_file(root, 'evidence/manifest.txt')
    if path is None or path.stat().st_size > MAX_MANIFEST:
        return package, entries
    stack = []
    for number, line in enumerate(path.read_text(encoding='utf-8', errors='replace').splitlines(), 1):
        element = re.match(r'^(\s*)E: ([A-Za-z][\w.-]*)\b', line)
        if element:
            depth = len(element.group(1))
            stack = [item for item in stack if item[0] < depth]
            kind = element.group(2)
            entry = {'kind': kind, 'name': '', 'evidence': 'evidence/manifest.txt:' + str(number)} if kind in COMPONENTS else None
            stack.append((depth, entry))
            if entry is not None:
                entries.append(entry)
            continue
        attribute = re.search(r'A: (?:android:)?(name|package|targetActivity)(?:\([^)]*\))?="([^"]*)"', line)
        if not attribute:
            continue
        key, value = attribute.groups()
        if key == 'package' and not package:
            package = value
        if key == 'name' and stack and stack[-1][1] is not None:
            stack[-1][1]['name'] = value
        if key == 'targetActivity' and stack and stack[-1][1] is not None and stack[-1][1]['kind'] == 'activity-alias':
            stack[-1][1]['targetActivity'] = value
    return package, [entry for entry in entries if entry['name']]


def workbench(root, report):
    files, truncated = source_inventory(root)
    dart_base = root / 'decompiled/dart'
    dart_files = []
    if dart_base.is_dir() and not dart_base.is_symlink():
        for path in sorted((dart_base / 'asm').glob('*.dart'))[:3000]:
            relative = path.relative_to(root).as_posix()
            safe = safe_file(root, relative)
            if safe is not None:
                dart_files.append({'path': relative, 'bytes': safe.stat().st_size, 'group': 'dart'})
        for name in ('pp.txt', 'objs.txt', 'ida_script/addNames.py'):
            relative = 'decompiled/dart/' + name
            safe = safe_file(root, relative)
            if safe is not None:
                dart_files.append({'path': relative, 'bytes': safe.stat().st_size, 'group': 'dart'})
    files = dart_files + [item for item in files if item['group'] != 'dart']
    package, entries = manifest_components(root)
    def qualify(name):
        return package + name if name.startswith('.') else package + '.' + name if '.' not in name and package else name
    for entry in entries:
        entry['qualifiedName'] = qualify(entry['name'])
        source_name = entry.get('targetActivity') if entry['kind'] == 'activity-alias' else entry['name']
        if entry['kind'] == 'activity-alias':
            entry['targetQualifiedName'] = qualify(source_name) if source_name else ''
        qualified = qualify(source_name) if source_name else ''
        suffixes = tuple('/' + qualified.replace('.', '/') + extension for extension in ('.java', '.kt')) if qualified else ()
        matches = [item['path'] for item in files if item['path'].endswith(suffixes) and
                   item['path'].startswith(('decompiled/java/', 'decompiled/java-simple/'))]
        entry['sourcePaths'] = matches
        entry['mapping'] = 'filename-match' if matches else 'unresolved'
    detected = report.get('detected', {})
    groups = []
    for kind in ('dex', 'managed', 'native', 'il2cpp', 'flutter', 'unity_inputs'):
        paths = detected.get(kind, [])
        if paths:
            groups.append({'kind': kind, 'count': len(paths), 'paths': ['extracted/' + path for path in paths[:50]],
                           'truncated': len(paths) > 50})
    return {'sourceFiles': files, 'sourceTruncated': truncated, 'sourceCountShown': len(files),
            'sourceGroups': sorted(set(item['group'] for item in files)),
            'payloadGroups': groups, 'manifestPackage': package, 'entrypoints': entries}
