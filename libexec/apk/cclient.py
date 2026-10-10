"""Read-only, schema-aware CClient configuration evidence."""
import collections
import hashlib
import json
from pathlib import Path

TABLES = ('SocketHosts', 'Views', 'Macros', 'RelayCommands', 'QueryCommands', 'TglGroups')


def walk(value, path='$'):
    stack = [(path, value)]
    while stack:
        location, node = stack.pop()
        if isinstance(node, dict):
            yield location, node
            stack.extend((location + '.' + str(k), v) for k, v in node.items())
        elif isinstance(node, list):
            stack.extend((location + '[' + str(i) + ']', v) for i, v in enumerate(node))


def analyze(extracted, output=None):
    results = {'projects': [], 'issues': [], 'errors': [], 'skipped': []}
    for source in sorted(Path(extracted).rglob('data.json')):
        project = source.relative_to(extracted).as_posix()
        recognized = False
        try:
            if source.stat().st_size > 64 * 1024 * 1024:
                raise ValueError('configuration exceeds 64 MiB analysis limit')
            raw = source.read_bytes()
            data = json.loads(raw.decode('utf-8-sig'))
            # Filename alone is not evidence of this application's schema.
            if not isinstance(data, dict) or not set(TABLES) <= data.keys():
                results['skipped'].append({'path': project, 'reason': 'not a recognized CClient schema'})
                continue
            recognized = True
            errors = []
            ids = {}
            for table in TABLES:
                rows = data.get(table)
                if not isinstance(rows, list):
                    errors.append({'path': '$.' + table, 'error': 'missing or non-list reference table'})
                    continue
                ids[table] = set()
                for i, row in enumerate(rows):
                    key = row.get('Id') if isinstance(row, dict) else None
                    if not isinstance(key, (str, int)) or isinstance(key, bool):
                        errors.append({'path': '$.' + table + '[' + str(i) + ']', 'error': 'invalid Id'})
                    elif key in ids[table]:
                        errors.append({'path': '$.' + table + '[' + str(i) + ']', 'error': 'duplicate Id', 'value': key})
                    else:
                        ids[table].add(key)
            controls, actions = collections.Counter(), collections.Counter()

            def check(path, node, field, target, allow_zero=False):
                if target not in ids:
                    return
                value = node.get(field)
                if allow_zero and isinstance(value, (int, float)) and not isinstance(value, bool) and value <= 0:
                    return
                if not isinstance(value, (str, int)) or isinstance(value, bool) or value not in ids[target]:
                    results['issues'].append({'project': project, 'path': path + '.' + field,
                                              'value': value, 'missing_from': target})

            for path, node in walk(data):
                if 'controlName' in node:
                    controls[str(node['controlName'])] += 1
                action = node.get('ActionType')
                if 'ActionType' in node:
                    actions[str(action)] += 1
                if action in (1, 2):
                    check(path, node, 'SocketHostId', 'SocketHosts')
                if action == 1:
                    check(path, node, 'CmdRefId', 'RelayCommands')
                if action == 3:
                    check(path, node, 'MacroId', 'Macros')
                if action in (5, 6, 7):
                    check(path, node, 'TargetViewId' if 'TargetViewId' in node else 'OpenViewId', 'Views', action == 7)
                for field, target in (('TglGroupId', 'TglGroups'), ('QueryCmdId', 'QueryCommands')):
                    if field in node:
                        check(path, node, field, target, True)
                send = node.get('SendData')
                if 'MinValue' in node and isinstance(send, dict) and send.get('Data'):
                    check(path, node, 'SocketHostId', 'SocketHosts')
            for i, view in enumerate(data.get('Views', [])):
                if isinstance(view, dict):
                    check('$.Views[' + str(i) + ']', view, 'ParentId', 'Views', True)
            results['projects'].append({'path': project, 'sha256': hashlib.sha256(raw).hexdigest(),
                                        'version': data.get('Version'), 'resolution': data.get('Resolution'),
                                        'counts': {k: len(v) for k, v in data.items() if isinstance(v, list)},
                                        'controls': dict(controls), 'action_types': dict(actions), 'schema_errors': errors})
            results['errors'].extend(dict(e, project=project) for e in errors)
        except (ValueError, UnicodeError, OSError, RecursionError) as exc:
            if recognized:
                results['errors'].append({'project': project, 'error': str(exc)})
            else:
                results['skipped'].append({'path': project, 'reason': 'unrecognized configuration: ' + str(exc)})
    if output is not None:
        Path(output).write_text(json.dumps(results, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')
    return results
