"""Bounded register data flow and conservative ARM64 control regions."""
import re


def analyze(rows, truncated=False):
    if not rows:
        return {'blocks': [], 'regions': [], 'ssa': [], 'complete': not truncated}
    addresses = {row['address']: i for i, row in enumerate(rows)}
    leaders = {0}
    for i, row in enumerate(rows):
        if row.get('target') in addresses:
            leaders.add(addresses[row['target']])
        if row.get('terminator') and i + 1 < len(rows):
            leaders.add(i + 1)
    starts = sorted(leaders)
    if len(starts) > 256:
        return {'blocks': [], 'regions': [], 'ssa': [], 'complete': False, 'reason': 'block limit'}
    blocks = []
    owner = {}
    for n, start in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(rows)
        block = {'id': rows[start]['address'], 'line': rows[start]['line'], 'start': start, 'end': end, 'successors': [], 'predecessors': []}
        blocks.append(block)
        for row in rows[start:end]:
            owner[row['address']] = block['id']
    by_id = {block['id']: block for block in blocks}
    for n, block in enumerate(blocks):
        last = rows[block['end'] - 1]
        if last.get('target') in owner:
            block['successors'].append(owner[last['target']])
        elif last.get('target') and last.get('terminator'):
            block['external_target'] = last['target']
        if last.get('terminator') not in ('jump', 'return', 'indirect', 'tail') and n + 1 < len(blocks):
            block['successors'].append(blocks[n + 1]['id'])
        block['successors'] = list(dict.fromkeys(block['successors']))
    for block in blocks:
        for target in block['successors']:
            by_id[target]['predecessors'].append(block['id'])
    # Only reachable blocks participate in dominators and register SSA.
    reachable = set()
    pending = [blocks[0]['id']]
    while pending:
        key = pending.pop()
        if key not in reachable:
            reachable.add(key); pending.extend(by_id[key]['successors'])
    dom = {key: ({key} if key == blocks[0]['id'] else set(reachable)) for key in reachable}
    for _ in range(256):
        changed = False
        for key in reachable - {blocks[0]['id']}:
            parents = [dom[p] for p in by_id[key]['predecessors'] if p in reachable]
            value = {key} | (set.intersection(*parents) if parents else set())
            if value != dom[key]:
                dom[key] = value; changed = True
        if not changed:
            break
    # Register SSA uses stable instruction-address definitions; memory stays opaque.
    registers = sorted({reg for row in rows for reg in row.get('defs', []) + row.get('uses', [])})
    incoming = {key: {reg: reg + '@entry' for reg in registers} for key in reachable}
    outgoing = {key: dict(value) for key, value in incoming.items()}
    converged = False
    for _ in range(256):
        changed = False
        for block in blocks:
            key = block['id']
            if key not in reachable:
                continue
            parents = [p for p in block['predecessors'] if p in reachable]
            value = {}
            for reg in registers:
                values = {outgoing[p][reg] for p in parents}
                if key == blocks[0]['id']:
                    values.add(reg + '@entry')
                value[reg] = next(iter(values)) if len(values) == 1 else (reg + '@phi:' + key if values else reg + '@entry')
            state = dict(value)
            for row in rows[block['start']:block['end']]:
                for reg in registers if row.get('opaque') else row.get('defs', []):
                    state[reg] = reg + '@' + row['address']
            if value != incoming[key] or state != outgoing[key]:
                incoming[key] = value; outgoing[key] = state; changed = True
        if not changed:
            converged = True; break
    ssa = []
    regions = []
    for block in blocks:
        key = block['id']
        block['reachable'] = key in reachable
        block['dominators'] = sorted(dom.get(key, []))
        if key not in reachable:
            continue
        state = dict(incoming[key])
        block['phis'] = {reg: {p: outgoing[p][reg] for p in block['predecessors'] if p in reachable} for reg in registers if state[reg] == reg + '@phi:' + key}
        if key == blocks[0]['id']:
            for reg in block['phis']:
                block['phis'][reg]['entry'] = reg + '@entry'
        for row in rows[block['start']:block['end']]:
            uses = {reg: state[reg] for reg in row.get('uses', [])}
            definitions = {reg: reg + '@' + row['address'] for reg in (registers if row.get('opaque') else row.get('defs', []))}
            ssa.append({'address': row['address'], 'line': row['line'], 'uses': uses, 'defs': definitions, 'opaque': row.get('opaque', False)})
            state.update(definitions)
        for target in block['successors']:
            if target in dom[key]:
                members = {target, key}; work = [] if target == key else [key]
                while work:
                    current = work.pop()
                    for parent in by_id[current]['predecessors']:
                        if parent in reachable and parent not in members:
                            members.add(parent); work.append(parent)
                exits = sorted({s for m in members for s in by_id[m]['successors'] if s not in members})
                body = []
                for member in [target] + [b['id'] for b in blocks if b['id'] in members and b['id'] != target]:
                    node = by_id[member]
                    body.append('L_' + member[2:] + ':')
                    for row in rows[node['start']:node['end']]:
                        text = row['text']
                        if row.get('target') == target:
                            text = text.replace('goto L_' + target[2:] + ';', 'continue;')
                        elif len(exits) == 1 and row.get('target') == exits[0]:
                            text = text.replace('goto L_' + exits[0][2:] + ';', 'break;')
                        body.append(text)
                    last = rows[node['end'] - 1]
                    if last.get('terminator') not in ('jump', 'tail', 'return', 'indirect'):
                        fallthrough = node['successors'][-1] if node['successors'] else None
                        if fallthrough:
                            body.append('continue;' if fallthrough == target else 'break;' if len(exits) == 1 and fallthrough == exits[0] else 'goto L_' + fallthrough[2:] + ';')
                regions.append({'kind': 'loop', 'header': target, 'latch': key, 'blocks': sorted(members), 'exits': exits,
                                'line': by_id[target]['line'], 'text': 'while (true) {\n  ' + '\n  '.join(body) + '\n}'})
        if len(block['successors']) == 2:
            a, b = block['successors']
            left, right = by_id[a]['successors'], by_id[b]['successors']
            join = left[0] if len(left) == len(right) == 1 and left == right and a != b and a != key and b != key else None
            if join and join not in (key, a, b) and by_id[a]['predecessors'] == [key] and by_id[b]['predecessors'] == [key]:
                condition = rows[block['end'] - 1]['text'].split(') goto ')[0].removeprefix('if (')
                body_a = [r['text'] for r in rows[by_id[a]['start']:by_id[a]['end']] if r.get('terminator') != 'jump']
                body_b = [r['text'] for r in rows[by_id[b]['start']:by_id[b]['end']] if r.get('terminator') != 'jump']
                regions.append({'kind': 'if', 'header': key, 'join': join, 'line': block['line'], 'text': 'if (' + condition + ') {\n  ' + '\n  '.join(body_a) + '\n} else {\n  ' + '\n  '.join(body_b) + '\n}'})
    # Equality ladders only; computed branch jump tables remain unresolved.
    consumed = set()
    for block in blocks:
        key = block['id']; cases = []; register = None; current = block
        while current['id'] not in consumed and current['reachable'] and len(current['successors']) == 2:
            body = rows[current['start']:current['end']]
            if len(body) != 2 or body[0].get('opcode') != 'cmp' or body[1].get('opcode') != 'b.eq':
                break
            match = re.fullmatch(r'(\w+),\s*#(-?(?:0x[\da-fA-F]+|\d+))', body[0].get('operands', ''))
            if not match or register not in (None, match[1]):
                break
            register = match[1]; cases.append({'value': match[2], 'target': body[1]['target'], 'line': body[1]['line']})
            consumed.add(current['id']); next_id = current['successors'][1]
            if next_id in consumed or by_id[next_id]['predecessors'] != [current['id']]:
                break
            current = by_id[next_id]
        if len(cases) >= 2:
            regions.append({'kind': 'switch', 'header': key, 'line': block['line'], 'cases': cases, 'default': current['id'],
                            'text': 'switch (' + register + ') {\n' + '\n'.join('  case ' + case['value'] + ': goto L_' + case['target'][2:] + ';' for case in cases) + '\n  default: goto L_' + current['id'][2:] + ';\n}'})
    return {'blocks': blocks, 'regions': regions, 'ssa': ssa, 'complete': not truncated and converged,
            'scope': 'Register SSA only. Calls conservatively clobber general registers; unsupported instructions are opaque. No memory/type/exception SSA or computed jump tables.'}
