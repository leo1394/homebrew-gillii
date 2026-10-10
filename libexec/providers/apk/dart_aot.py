"""Evidence-preserving ARM64 lifts and direct-call relationships, not Dart source."""
import re


INSTRUCTION = re.compile(r'^\s*//\s+(0x[0-9a-fA-F]+):\s+([a-z][a-z0-9.]*)\s*(.*?)\s*$')
REGISTER = r'(?:[xw]\d+|[xw]zr|sp|SP|fp|lr|NULL|HEAP|THR|PP)'


def lift_instruction(line, number):
    match = INSTRUCTION.match(line)
    if not match:
        return None
    address, opcode, raw = match.groups()
    if raw.lstrip().startswith('=') or opcode == 'branch' or re.fullmatch(r'r\d+', opcode):
        return None
    operands, _, annotation = raw.partition(';')
    operands = operands.strip()
    args = [part.strip().lstrip('#') for part in operands.split(',')]
    text = None
    call = None
    kind = 'instruction'
    if opcode == 'mov' and len(args) == 2 and re.fullmatch(REGISTER, args[0]):
        text = args[0] + ' = ' + args[1] + ';'
    elif opcode in ('add', 'sub', 'and', 'orr', 'eor', 'lsl', 'lsr', 'asr') and len(args) == 3:
        operator = {'add': '+', 'sub': '-', 'and': '&', 'orr': '|', 'eor': '^', 'lsl': '<<', 'lsr': '>>>', 'asr': '>>'}[opcode]
        text = args[0] + ' = ' + args[1] + ' ' + operator + ' ' + args[2] + ';'
    elif opcode in ('cmp', 'tst') and len(args) == 2:
        text = 'NZCV = ' + ('compare_flags' if opcode == 'cmp' else 'test_flags') + '(' + ', '.join(args) + ');'
    elif opcode in ('ldr', 'ldur', 'str', 'stur'):
        memory = re.fullmatch('(' + REGISTER + r'),\s*\[(' + REGISTER + r')(?:,\s*#?(-?(?:0x[0-9a-fA-F]+|\d+)))?\]', operands)
        if memory:
            register, base, offset = memory.groups()
            location = base + ' + (' + (offset or '0') + ')'
            width = '32' if register.startswith('w') else '64'
            text = register + ' = load_u' + width + '(' + location + ');' if opcode.startswith('ld') else 'store_u' + width + '(' + location + ', ' + register + ');'
    elif opcode == 'bl' and re.fullmatch(r'0x[0-9a-fA-F]+', args[0]):
        text = 'call_at(' + args[0] + ');'
        call = {'address': args[0].lower(), 'line': number, 'instruction': address.lower(), 'kind': 'direct', 'annotation': annotation.strip()[:500]}
        kind = 'call'
    elif opcode in ('blr', 'br'):
        text = ('call_indirect' if opcode == 'blr' else 'branch_indirect') + '(' + operands + '); // unresolved target'
        call = {'address': None, 'line': number, 'instruction': address.lower(), 'kind': 'indirect', 'register': operands[:100]}
        kind = 'unresolved'
    elif opcode == 'b' and re.fullmatch(r'0x[0-9a-fA-F]+', args[0]):
        text = 'goto L_' + args[0][2:] + ';'
        kind = 'branch'
    elif opcode.startswith('b.') and len(args) == 1 and re.fullmatch(r'0x[0-9a-fA-F]+', args[0]):
        text = 'if (NZCV.' + opcode[2:] + ') goto L_' + args[0][2:] + ';'
        kind = 'branch'
    elif opcode in ('cbz', 'cbnz') and len(args) == 2:
        text = 'if (' + args[0] + (' == ' if opcode == 'cbz' else ' != ') + '0) goto L_' + args[1].removeprefix('0x') + ';'
        kind = 'branch'
    elif opcode in ('tbz', 'tbnz') and len(args) == 3:
        text = 'if (bit(' + args[0] + ', ' + args[1] + ')' + (' == 0' if opcode == 'tbz' else ' != 0') + ') goto L_' + args[2].removeprefix('0x') + ';'
        kind = 'branch'
    elif opcode == 'ret':
        text = 'return_to(' + (operands or 'lr') + ');'
    regs = re.findall(r'\b(?:[xw]\d+|[xw]zr|sp|SP|fp|lr|NULL|HEAP|THR|PP)\b', operands)
    canonical = lambda reg: {'fp': 'x29', 'lr': 'x30', 'SP': 'x15', 'PP': 'x27', 'THR': 'x26', 'HEAP': 'x28'}.get(reg, 'x' + reg[1:] if re.fullmatch(r'w\d+', reg) else reg)
    regs = list(dict.fromkeys(canonical(reg) for reg in regs if reg not in ('xzr', 'wzr', 'NULL')))
    definitions = []
    uses = list(regs)
    known = text is not None
    if opcode in ('mov', 'add', 'sub', 'and', 'orr', 'eor', 'lsl', 'lsr', 'asr', 'ldr', 'ldur') and known and regs:
        definitions = [canonical(args[0])]
        uses = list(dict.fromkeys(canonical(reg) for reg in re.findall(r'\b' + REGISTER + r'\b', operands.partition(',')[2]) if reg not in ('xzr', 'wzr', 'NULL')))
    elif opcode in ('cmp', 'tst'):
        definitions = ['NZCV']
    elif opcode.startswith('b.'):
        uses.append('NZCV')
    elif opcode in ('bl', 'blr'):
        definitions = ['x' + str(i) for i in range(31)] + ['NZCV', 'sp']
        uses = list(dict.fromkeys(uses + ['x' + str(i) for i in range(8)]))
    elif opcode == 'ret':
        uses = uses or ['x30']
    elif not known:
        # Unknown machine operations may write any named operand or flags.
        definitions = list(dict.fromkeys(regs + ['NZCV']))
    target = args[-1].lower() if opcode == 'b' or opcode.startswith('b.') or opcode in ('cbz', 'cbnz', 'tbz', 'tbnz') else None
    if target and not re.fullmatch(r'0x[0-9a-f]+', target):
        target = None
    terminator = 'jump' if opcode == 'b' else 'conditional' if target else 'return' if opcode == 'ret' else 'indirect' if opcode == 'br' else None
    return {'opcode': opcode, 'operands': operands, 'defs': definitions, 'uses': uses, 'opaque': not known,
            'target': target, 'terminator': terminator, 'address': address.lower(), 'line': number, 'text': text or 'asm(' + repr(opcode + ' ' + operands) + ');',
            'lifted': text is not None, 'kind': kind, 'annotation': annotation.strip()[:500], 'call': call}


def symbol_evidence(root):
    from workbench import safe_file
    symbols = {}
    ranges = {}
    pool = {}
    path = safe_file(root, 'decompiled/dart/ida_script/addNames.py')
    if path and path.stat().st_size <= 16 * 1024 * 1024:
        # Generated Python is inert input. Never execute or import it.
        for number, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
            match = re.fullmatch(r'idaapi\.set_name\((0x[0-9a-fA-F]+), "([^"\\]{1,1000})"\)', line)
            if match and len(symbols) < 50000:
                symbols.setdefault(match[1].lower(), []).append({'name': match[2], 'line': number, 'file': 'decompiled/dart/ida_script/addNames.py'})
            match = re.fullmatch(r'ida_funcs\.add_func\((0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+)\)', line)
            if match and int(match[2], 16) > int(match[1], 16):
                ranges[match[1].lower()] = match[2].lower()
    path = safe_file(root, 'decompiled/dart/pp.txt')
    if path and path.stat().st_size <= 16 * 1024 * 1024:
        for number, line in enumerate(path.read_text(errors='replace').splitlines(), 1):
            match = re.match(r'\[pp\+(0x[0-9a-fA-F]+)\] (.{1,1500})', line)
            if match and len(pool) < 50000:
                pool[match[1].lower()] = {'value': match[2], 'line': number, 'file': 'decompiled/dart/pp.txt'}
    return symbols, ranges, pool


def enrich(records, symbols=None, ranges=None):
    symbols, ranges = symbols or {}, ranges or {}
    by_address = {}
    for item in records:
        previous = by_address.get(item['address'])
        if previous is None or (item['assembly_available'] and not previous['assembly_available']):
            by_address[item['address']] = item
        item['called_by'] = []
    nodes = {address: {'address': address, 'name': item['name'], 'file': item['file'], 'line': item['line'], 'kind': 'function', 'body_available': item['assembly_available']} for address, item in by_address.items()}
    for address, names in symbols.items():
        if address in nodes:
            continue
        stubs = [entry for entry in names if '::' not in entry['name']]
        aliases = {match[1] for entry in names if (match := re.search(r'_([0-9a-f]+)_(?:check|miss)$', entry['name']))}
        canonical = '0x' + next(iter(aliases)) if len(aliases) == 1 and not stubs else None
        entry = stubs[-1] if stubs else names[0]
        nodes[address] = {'address': address, **entry, 'kind': 'runtime_stub' if stubs else 'entry_alias' if canonical else 'symbol',
                          'canonical_address': canonical, 'body_available': False, 'alias_count': len(names), 'range_end': ranges.get(address)}
    edges = []
    external = set()
    counts = {}
    for item in records:
        for call in item['calls']:
            node = nodes.get(call['address'])
            category = 'indexed_function' if call['address'] in by_address else node['kind'] if node else 'unknown'
            counts[category] = counts.get(category, 0) + 1
            call['resolution'] = category
            if node:
                call['target_name'] = node['name']
            edge = {'source': item['address'], 'target': call['address'], 'file': item['file'], 'line': call['line'],
                    'kind': call.get('kind', 'direct'), 'resolved': category == 'indexed_function', 'resolution': category,
                    'symbol_resolved': node is not None, 'body_available': bool(node and node['body_available'])}
            edges.append(edge)
            target = by_address.get(call['address']) or (by_address.get(node.get('canonical_address')) if node else None)
            if target:
                target['called_by'].append(edge)
            if not node:
                external.add(call['address'])
    for edge in edges:
        if edge['target'] in nodes and edge['target'] not in by_address:
            nodes[edge['target']].setdefault('called_by', []).append(edge)
    for item in records:
        item['called_by'] = by_address[item['address']]['called_by']
    return {'scope': 'Static calls only. Symbol/stub recognition is distinct from indexed function bodies; indirect targets remain unresolved.',
            'nodes': list(nodes.values()), 'external_targets': sorted(external), 'edges': edges,
            'mapping_diagnostics': {'categories': counts, 'assembly_functions': len(records), 'unique_assembly_entries': len(by_address),
                                    'declaration_only': sum(not item['assembly_available'] for item in records), 'ida_symbols': len(symbols), 'ida_ranges': len(ranges),
                                    'anonymous_code_entries': sum('/_snapshot_raw_' in item['file'] for item in records),
                                    'address_basis': 'Blutter libapp-relative virtual addresses; no guessed offset correction.',
                                    'unknown_targets': sorted(external), 'dynamic_collection': 'Deferred next phase; not implemented.'},
            'resolved_edges': sum(edge['resolved'] for edge in edges),
            'symbol_resolved_edges': sum(edge['symbol_resolved'] for edge in edges),
            'body_resolved_edges': sum(edge['body_available'] for edge in edges),
            'unresolved_indirect_calls': sum(len(item['indirect_calls']) for item in records)}
