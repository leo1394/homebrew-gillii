"""Offline, escaped reports for static APK analysis."""
import html
import re
from xml.etree import ElementTree
import json
import shlex
import os
import subprocess
import sys
import hashlib
import base64
from pathlib import Path
from urllib.parse import quote
from workbench import workbench, safe_file, MAX_MANIFEST


def system_language():
    language = os.environ.get('LC_ALL') or os.environ.get('LC_MESSAGES') or os.environ.get('LANG') or ''
    if sys.platform == 'darwin':
        try:
            result = subprocess.run(['defaults', 'read', '-g', 'AppleLanguages'], capture_output=True, text=True, timeout=1)
            if result.returncode == 0:
                language = result.stdout.split('"')[1]
        except (OSError, subprocess.TimeoutExpired, IndexError):
            pass
    return 'zh' if language.lower().startswith('zh') else 'en'


def investigation(report):
    """Separate retained artifact observations from identification and runtime claims."""
    evidence = []
    relationships = []
    steps = []
    detected = report.get('detected', {})
    for error in report.get('errors', []):
        steps.append({'priority': 'high', 'title': 'Resolve input or pipeline failure',
                      'reason': str(error), 'evidence': 'local-observed',
                      'action': 'Check the retained original and failure logs; correct the reported input or extraction problem before creating a new analysis run.'})
    for kind in ('dex', 'managed', 'native', 'il2cpp', 'flutter', 'unity_inputs'):
        for path in detected.get(kind, []):
            evidence.append({'kind': kind, 'path': 'extracted/' + path, 'evidence': 'local-observed',
                             'basis': 'Retained file matched the static detector; runtime use is not verified.'})
    if detected.get('unity'):
        evidence.append({'kind': 'unity-identification', 'evidence': 'static-inferred',
                         'basis': 'Unity file signatures/names; see detected and Unity export evidence.'})
    for assembly in report.get('assemblies', []):
        if assembly.get('output'):
            relationships.append({'from': 'extracted/' + assembly['path'], 'to': assembly['output'],
                                  'kind': 'decompilation-output', 'evidence': 'local-observed',
                                  'status': assembly.get('status', 'unknown')})
    for stage in report.get('stages', []):
        if stage.get('status') not in ('partial', 'failed') or stage['name'] == 'unsupported-source-recovery':
            continue
        steps.append({'priority': 'high', 'title': 'Investigate stage: ' + stage['name'],
                      'reason': stage.get('error') or 'Stage did not complete.', 'evidence': 'local-observed',
                      'action': 'Inspect recorded tool arguments and retained logs; resolve the reported dependency or output error before rerunning into a new directory.'})
    if any(detected.get(kind) for kind in ('native', 'il2cpp', 'flutter')):
        steps.append({'priority': 'medium', 'title': 'Investigate retained native/runtime payloads',
                      'evidence': 'unverified', 'reason': 'These payloads have no original-source recovery in Gillii.',
                      'action': 'Use the retained binary inventory and hashes to select a matching native/runtime analysis tool; verify behavior separately in an authorized runtime.'})
    steps.append({'priority': 'medium', 'title': 'Verify behavior before making runtime claims',
                  'evidence': 'unverified', 'reason': 'Static artifacts do not prove entrypoint reachability or network activity.',
                  'action': 'Follow relevant manifest entrypoints into decompiled methods, then collect authorized runtime traces for the specific hypothesis.'})
    return {'scope': 'Static APK artifacts and tool outputs; no application execution.',
            'evidenceClasses': {'local-observed': 'Directly observed in retained local artifacts/tool records.',
                                'static-inferred': 'Identification inferred from static signatures or declarations.',
                                'unverified': 'A hypothesis requiring additional evidence.'},
            'evidence': evidence, 'relationships': relationships, 'nextSteps': steps}


def application_name(root):
    path = safe_file(root, 'evidence/metadata.txt')
    if path is not None and path.stat().st_size <= MAX_MANIFEST:
        content = path.read_text(encoding='utf-8', errors='replace')
        match = re.search(r"^application-label:'([^'\r\n]+)'\s*$", content, re.MULTILINE)
        if match and match.group(1).strip():
            return match.group(1).strip()
    path = safe_file(root, 'extracted/AndroidManifest.xml')
    if path is not None and path.stat().st_size <= MAX_MANIFEST:
        try:
            document = ElementTree.fromstring(path.read_bytes())
            application = document.find('application')
            label = application.get('{http://schemas.android.com/apk/res/android}label', '') if application is not None else ''
            if label.strip() and not label.startswith(('@', '?')):
                return label.strip()
        except ElementTree.ParseError:
            pass
    return ''


def write_report(root, report):
    root = Path(root)
    (root / 'docs').mkdir(exist_ok=True)
    report['appName'] = application_name(root)
    report['investigation'] = investigation(report)
    report['workbench'] = workbench(root, report)
    payload = json.dumps(report, ensure_ascii=True, indent=2)
    (root / 'report.json').write_text(payload + '\n', encoding='utf-8')
    title = 'APK developer workbench: ' + report.get('status', 'failed')
    escape = lambda value: html.escape(str(value), quote=True)
    dual = lambda en, zh: '<span data-en="' + escape(en) + '" data-zh="' + escape(zh) + '">' + escape(en) + '</span>'
    filename = Path(report.get('input', '')).name or 'APK'
    identity = escape(report['appName'] + ' (' + filename + ')' if report['appName'] else filename)
    status = report.get('status', 'failed')
    status_badge = '<strong class="status-badge" data-status="' + escape(status) + '">' + escape(status) + '</strong>'
    controls_style = (Path(__file__).parent.parent / 'workbench' / 'report-controls.css').read_text(encoding='utf-8')
    workbench_style = (Path(__file__).parent.parent / 'workbench' / 'report-workbench.css').read_text(encoding='utf-8')
    language_script = (Path(__file__).parent.parent / 'workbench' / 'report-language.js').read_text(encoding='utf-8')
    blueprint_script = (Path(__file__).parent.parent / 'workbench' / 'report-blueprint.js').read_text(encoding='utf-8')
    source_script = (Path(__file__).parent.parent / 'workbench' / 'report-source-tools.js').read_text(encoding='utf-8')
    workbench_script = """(() => {
  const buttons = [...document.querySelectorAll('[data-source-path]')];
  const files = buttons.filter(button => button.dataset.sourceBytes !== undefined).map(button => ({path: button.dataset.sourcePath, bytes: Number(button.dataset.sourceBytes)}));
  const pane = window.gilliiSourceTools.mount(document.getElementById('source-pane'), {files, sourceRoot: document.documentElement.dataset.sourceRoot});
  const ids = ['architecture', 'entrypoints', 'source-browser', 'dart', 'recovery', 'blueprint'];
  function show(id) {
    if (!ids.includes(id)) id = 'architecture';
    if (location.hash !== '#' + id) location.hash = id;
    for (const name of ids) document.getElementById(name).hidden = name !== id;
    for (const anchor of document.querySelectorAll('.workbench-nav a')) anchor.setAttribute('aria-current', anchor.getAttribute('href') === '#' + id ? 'page' : 'false');
  }
  for (const anchor of document.querySelectorAll('.workbench-nav a[href^="#"]')) anchor.onclick = () => show(anchor.getAttribute('href').slice(1));
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  for (const button of buttons) button.addEventListener('click', () => { show('source-browser'); pane.open(button.dataset.sourcePath); });
  const search = document.getElementById('apk-file-search');
  search.oninput = () => { for (const item of document.querySelectorAll('#apk-file-list li')) item.hidden = !item.textContent.toLowerCase().includes(search.value.toLowerCase()); };
  show(location.hash.slice(1));
  const dartData = JSON.parse(document.getElementById('dart-data').textContent);
  const dartSearch = document.getElementById('dart-search'), dartList = document.getElementById('dart-list'), dartDetail = document.getElementById('dart-detail');
  const byAddress = new Map(); for (const item of [...dartData.functions, ...(dartData.symbols || [])]) if (!byAddress.has(item.address)) byAddress.set(item.address, item);
  for (const item of byAddress.values()) item.called_by = [];
  for (const item of dartData.functions) for (const call of item.calls) {
    const target = byAddress.get(call.address); if (target) target.called_by.push({source:item.address,target:call.address,file:item.file,line:call.line});
  }
  let selectedDart = null, dartRequest = 0;
  async function loadDart(item) {
    const ticket = ++dartRequest;
    if (!item.detail_file || item.loaded) return inspectDart(item);
    selectedDart = item; dartDetail.replaceChildren();
    dartNote('Loading static evidence…', '正在载入静态证据…');
    try {
      const response = await fetch(item.detail_file); if (!response.ok) throw new Error('load');
      const detail = await response.json(); if (ticket !== dartRequest) return;
      Object.assign(item, detail, {loaded:true}); inspectDart(item);
    } catch (error) {
      if (ticket !== dartRequest) return;
      inspectDart(item); dartNote('Detailed evidence requires the local report viewer. The full JSON remains in the output folder.', '详细证据需通过本地报告查看器载入；完整 JSON 保留在输出目录。');
      const link = document.createElement('a'); link.href = item.detail_file; link.textContent = window.gilliiI18n.t('Open function evidence JSON', '打开函数证据 JSON'); dartDetail.appendChild(link);
    }
  }
  function dartHeading(en, zh) {
    const heading = document.createElement('h4'); heading.textContent = window.gilliiI18n.t(en, zh); dartDetail.appendChild(heading);
  }
  function dartNote(en, zh) {
    const note = document.createElement('p'); note.textContent = window.gilliiI18n.t(en, zh); dartDetail.appendChild(note);
  }
  function graph(item) {
    dartHeading('Call graph · one hop', '调用图 · 一层关系');
    const incoming = item.called_by || [], outgoing = item.calls || [];
    const unique = rows => [...new Map(rows.map(row => [row.address, row])).values()];
    const left = unique(incoming.map(edge => ({address: edge.source, line: edge.line, file: edge.file}))).slice(0, 20);
    const right = unique(outgoing.filter(call => call.address)).slice(0, 20);
    const centerX = left.length ? 350 : 10, rightX = centerX + 340, viewWidth = right.length ? rightX + 270 : centerX + 270;
    const height = Math.max(180, Math.max(left.length, right.length) * 58 + 70), center = Math.min(height / 2, 180);
    const wrap = document.createElement('div'); wrap.className = 'dart-graph';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 ' + viewWidth + ' ' + height); svg.setAttribute('width', viewWidth); svg.style.minWidth = Math.max(280, viewWidth * .75) + 'px'; svg.setAttribute('height', height); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', window.gilliiI18n.t('Callers → current function → callees', '调用者 → 当前函数 → 被调用者'));
    function element(name, attributes) { const node = document.createElementNS(ns, name); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); return node; }
    for (const [rows, direction] of [[left, 'in'], [right, 'out']]) rows.forEach((row, index) => {
      const y = 60 + index * 58, path = direction === 'in' ? 'M 270 ' + y + ' C 310 ' + y + ', 310 ' + center + ', ' + centerX + ' ' + center : 'M ' + (centerX + 260) + ' ' + center + ' C ' + (centerX + 300) + ' ' + center + ', ' + (rightX - 40) + ' ' + y + ', ' + rightX + ' ' + y;
      svg.appendChild(element('path', {d:path,fill:'none',stroke:'#8798b0','stroke-width':2}));
      const tipX = direction === 'in' ? centerX : rightX, tipY = direction === 'in' ? center : y;
      svg.appendChild(element('path', {d:'M ' + tipX + ' ' + tipY + ' l -9 -5 v 10 Z',fill:'#8798b0'}));
    });
    function node(address, x, y, row, current) {
      const target = byAddress.get(address), group = element('g', {transform:'translate(' + x + ' ' + (y - 22) + ')',role:'button',tabindex:0,'aria-label':(target ? target.name : window.gilliiI18n.t('Unresolved target', '未解析目标')) + ' · ' + address});
      group.appendChild(element('rect', {width:260,height:44,rx:6,fill:current ? '#edf0fc' : target && (target.assembly_available || target.kind === undefined) ? '#edf7f0' : '#fff6e8',stroke:current ? '#4355a3' : '#b6c9d0'}));
      const full = target ? target.name : row.annotation || address, label = element('text', {x:10,y:18,fill:'#172831','font-size':11}); label.textContent = full.length > 34 ? full.slice(0, 31) + '…' : full; group.appendChild(label);
      const addr = element('text', {x:10,y:34,fill:'#60727c','font-size':11}); addr.textContent = address; group.appendChild(addr);
      const title = element('title', {}); title.textContent = full; group.appendChild(title);
      const action = () => target ? loadDart(target) : (show('source-browser'), pane.open(item.file, row.line));
      group.addEventListener('click', action); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); } }); svg.appendChild(group);
    }
    left.forEach((row, index) => node(row.address, 10, 60 + index * 58, row, false));
    node(item.address, centerX, center, item, true);
    right.forEach((row, index) => node(row.address, rightX, 60 + index * 58, row, false));
    wrap.appendChild(svg); dartDetail.appendChild(wrap);
    dartNote('Green: indexed function; amber: symbol-only or unresolved address. Up to 20 neighbors per side; arrows describe static evidence only.', '绿色：已索引函数；暖黄色：仅符号或未解析地址。每侧最多展示 20 个相邻函数；箭头仅表示静态证据。');
  }
  function inspectDart(item) {
    selectedDart = item;
    dartDetail.replaceChildren();
    const title = document.createElement('h3'); title.textContent = item.name; dartDetail.appendChild(title);
    const position = document.createElement('p'); position.textContent = item.address + ' · ' + item.file + ':' + item.line; dartDetail.appendChild(position);
    const open = document.createElement('button'); open.textContent = window.gilliiI18n.t('Inspect assembly', '查看汇编'); open.onclick = () => { show('source-browser'); pane.open(item.file, item.line); }; dartDetail.appendChild(open);
    if (!item.assembly_available) dartNote('Declaration only: assembly body unavailable.', '仅恢复声明：汇编函数体不可用。');
    if (item.kind) dartNote('Symbol category: ' + item.kind + '; this does not recover its body.', '符号类别：' + item.kind + '；识别符号不代表已恢复函数体。');
    graph(item);
    const flow = item.flow || {blocks: [], regions: [], ssa_count: 0};
    dartHeading('Control regions · CFG / register SSA', '控制结构 · CFG / 寄存器 SSA');
    dartNote(flow.blocks.length + ' blocks · ' + flow.regions.length + ' regions · ' + (flow.ssa || []).length + ' SSA instructions. Regions are local reconstructions; original jumps remain below.', flow.blocks.length + ' 个基本块 · ' + flow.regions.length + ' 个结构区域 · ' + (flow.ssa || []).length + ' 条 SSA 指令。结构属于局部恢复；下方保留原始跳转。');
    if (item.flow && !flow.complete) dartNote('Incomplete analysis: truncated input or data-flow limit.', '分析不完整：输入截断或达到数据流上限。');
    for (const region of flow.regions) {
      const button = document.createElement('button'); button.className = 'dart-statement';
      const code = document.createElement('pre'); code.textContent = region.kind + ' · ' + region.header + '\\n' + region.text; button.appendChild(code);
      button.onclick = () => { show('source-browser'); pane.open(item.file, region.line); }; dartDetail.appendChild(button);
    }
    if (flow.blocks.length) {
      const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
      summary.textContent = window.gilliiI18n.t('Inspect CFG and SSA merges (full SSA in JSON)', '查看 CFG 与 SSA 合并（完整 SSA 见 JSON）'); pre.className = 'dart-pseudocode'; pre.textContent = JSON.stringify(flow, null, 2); details.append(summary, pre); dartDetail.appendChild(details);
    }
    dartHeading('Dart semantic evidence', 'Dart 语义证据');
    for (const semantic of item.dart_semantics || []) {
      const button = document.createElement('button'); button.className = 'dart-statement'; button.textContent = semantic.kind + ' · ' + semantic.value;
      button.onclick = () => { show('source-browser'); pane.open(semantic.file, semantic.evidence_line); }; dartDetail.appendChild(button);
    }
    dartHeading('Low-level pseudocode', '低层伪代码');
    dartNote('Registers and NZCV flags retain machine semantics. asm() preserves unsupported instructions; this is not runnable Dart. Click a row to inspect its assembly evidence.', '寄存器与 NZCV 标志保留机器层语义。asm() 保留未支持的指令；这些内容不是可运行的 Dart。点击语句可定位对应汇编证据。');
    const pseudo = document.createElement('div'); pseudo.className = 'dart-pseudocode';
    for (const row of item.pseudocode || []) {
      const button = document.createElement('button'); button.className = 'dart-statement';
      const code = document.createElement('code'); code.textContent = 'L_' + row.address.slice(2) + ': ' + row.text; button.appendChild(code);
      if (row.annotation) { const note = document.createElement('small'); note.textContent = row.annotation; button.appendChild(note); }
      button.onclick = () => { show('source-browser'); pane.open(item.file, row.line); }; pseudo.appendChild(button);
    }
    dartDetail.appendChild(pseudo);
    if (!(item.pseudocode || []).length) dartNote('No pseudocode body recovered.', '未恢复伪代码函数体。');
    if (item.pseudocode_truncated || item.calls_truncated) dartNote('Analysis limit reached; inspect the complete assembly for omitted instructions or calls.', '已达到分析上限；遗漏指令或调用请查看完整汇编。');
    for (const [en, zh, rows] of [['Called by', '被谁调用', item.called_by || []], ['Direct static calls', '直接静态调用', item.calls || []]]) {
      dartHeading(en + ' · ' + rows.length, zh + ' · ' + rows.length);
      for (const row of rows.slice(0, 100)) {
        const target = byAddress.get(row.source || row.address), button = document.createElement('button'); button.textContent = (target ? target.name + ' · ' : '') + (row.source || row.address);
        button.onclick = () => target ? loadDart(target) : (show('source-browser'), pane.open(item.file, row.line)); dartDetail.appendChild(button);
      }
    }
    dartHeading('Unresolved indirect calls / branches', '未解析的间接调用 / 跳转');
    if (!(item.indirect_calls || []).length) dartNote('None observed in the indexed body; this does not prove absence of dynamic dispatch.', '索引函数体中未观察到；这不代表不存在动态派发。');
    for (const call of item.indirect_calls || []) { const button = document.createElement('button'); button.textContent = call.instruction + ' · ' + call.register; button.onclick = () => { show('source-browser'); pane.open(item.file, call.line); }; dartDetail.appendChild(button); }
  }
  function renderDart() {
    dartList.replaceChildren(); dartDetail.replaceChildren();
    dartSearch.placeholder = window.gilliiI18n.t('Find Dart function or address…', '查找 Dart 函数或地址…'); dartSearch.setAttribute('aria-label', dartSearch.placeholder);
    const matching = [...dartData.functions, ...(dartData.symbols || [])].filter(item => (item.name + item.address + item.file).toLowerCase().includes(dartSearch.value.toLowerCase()));
    for (const item of matching.slice(0, 500)) { const button = document.createElement('button'); button.textContent = item.name + ' · ' + item.address; button.onclick = () => loadDart(item); dartList.appendChild(button); }
    const count = document.createElement('p'); count.textContent = matching.length + window.gilliiI18n.t(' indexed functions; showing up to 500.', ' 个索引函数；最多显示 500 个。'); dartList.appendChild(count);
    if (selectedDart) loadDart(selectedDart);
  }
  dartSearch.oninput = () => { ++dartRequest; selectedDart = null; renderDart(); }; renderDart();
  document.addEventListener('gillii-language-change', () => { pane.refreshLanguage(); renderDart(); });
})();"""
    script_hashes = ' '.join("'sha256-" + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode() + "'" for script in (language_script, source_script, blueprint_script, workbench_script))
    stages = ''.join('<tr><td>' + escape(stage['name']) + '</td><td>' + '<strong class="status-badge" data-status="' + escape(stage['status']) + '">' + escape(stage['status']) + '</strong>'
                     + '</td><td>' + escape(stage.get('error') or '') + '</td></tr>'
                     for stage in report.get('stages', []))
    links = [('logs/execution.log', 'Execution log'), ('report.json', 'Machine-readable report'), ('docs/reproduction.md', 'Reproduction commands'), ('docs/rebuild.md', 'Reconstruction plan'),
             ('evidence/files.json', 'Verified APK file inventory'), ('evidence/manifest.txt', 'Android manifest'),
             ('evidence/metadata.txt', 'Package metadata'), ('evidence/unity-objects.json', 'Unity object coverage'),
             ('evidence/cclient.json', 'CClient configuration audit'), ('evidence/dart-callgraph.json', 'Dart call graph'), ('evidence/dart-functions.json', 'Dart functions and pseudocode')]
    link_labels = {'Execution log': '执行日志', 'Machine-readable report': 'JSON 报告', 'Reproduction commands': '复现命令', 'Reconstruction plan': '重建计划',
                   'Verified APK file inventory': '已校验 APK 文件清单', 'Android manifest': 'Android 清单',
                   'Package metadata': '包元信息', 'Unity object coverage': 'Unity 对象覆盖', 'CClient configuration audit': 'CClient 配置审计', 'Dart call graph': 'Dart 调用图', 'Dart functions and pseudocode': 'Dart 函数与伪代码'}
    navigation = ''.join('<li><a href="' + escape(path) + '">' + dual(label, link_labels[label]) + '</a></li>'
                         for path, label in links if path in ('docs/reproduction.md', 'docs/rebuild.md') or (root / path).is_file())
    directories = ''.join('<li>' + escape(name) + ': ' + str(sum(1 for p in (root / name).rglob('*') if p.is_file()))
                          + ' ' + dual('files', '个文件') + '</li>' for name in ('raw', 'extracted', 'decompiled', 'unity-export', 'logs')
                          if (root / name).is_dir())
    findings = report['investigation']
    evidence_rows = ''.join('<tr><td>' + escape(item['kind']) + '</td><td>' + escape(item.get('path', ''))
                            + '</td><td>' + escape(item['evidence']) + '</td></tr>' for item in findings['evidence'])
    translations = {
        'Resolve input or pipeline failure': '处理输入或分析流程失败',
        'Check the retained original and failure logs; correct the reported input or extraction problem before creating a new analysis run.': '检查保留的原包和失败日志，处理输入或解包问题后，再创建新的分析结果。',
        'Inspect recorded tool arguments and retained logs; resolve the reported dependency or output error before rerunning into a new directory.': '检查记录的工具参数和日志，解决依赖或输出错误后，再恢复到新目录。',
        'Investigate retained native/runtime payloads': '调查保留的原生与运行时文件',
        'These payloads have no original-source recovery in Gillii.': 'Gillii 尚不支持还原这些文件的原始源码。',
        'Use the retained binary inventory and hashes to select a matching native/runtime analysis tool; verify behavior separately in an authorized runtime.': '根据二进制清单与哈希选择合适的分析工具，在获授权的运行环境中单独验证行为。',
        'Verify behavior before making runtime claims': '确认运行行为后再作结论',
        'Static artifacts do not prove entrypoint reachability or network activity.': '静态文件不能证明入口可达或实际发生网络请求。',
        'Follow relevant manifest entrypoints into decompiled methods, then collect authorized runtime traces for the specific hypothesis.': '从清单入口追踪反编译方法，再为具体假设收集获授权的运行记录。'
    }
    translated = lambda text: dual(text, '检查阶段：' + text.removeprefix('Investigate stage: ') if text.startswith('Investigate stage: ') else translations.get(text, text))
    next_steps = ''.join('<li><b>' + translated(item['title']) + '</b> (' + escape(item['priority']) + ', '
                         + escape(item['evidence']) + ')<p>' + translated(item['reason']) + '<br>'
                         + translated(item['action']) + '</p></li>' for item in findings['nextSteps'])
    work = report['workbench']
    facts = [('Type', '类型', 'APK'), ('File', '文件', Path(report.get('input', '')).name or '—'), ('Package', '包名', work['manifestPackage'] or '—'), ('Listed source files', '已列出的源码文件', str(work['sourceCountShown'])), ('Entrypoints', '入口', str(len(work['entrypoints']))), ('Recovery', '恢复状态', report.get('status', 'failed'))]
    basic_info = '<dl class="architecture-info">' + ''.join('<div><dt>' + dual(en, zh) + '</dt><dd>' + escape(value) + '</dd></div>' for en, zh, value in facts) + '</dl>'
    decompilation_info = '<dl class="architecture-info">' + ''.join('<div><dt>' + dual('Java source files · ', 'Java 源码文件 · ') + escape(item.get('mode', item.get('stage', 'unknown'))) + '</dt><dd>'
                         + escape(item.get('source_files', 0)) + '<small>' + escape(item.get('output', '')) + '</small></dd></div>' for item in report.get('decompilation', [])) + '</dl>' if report.get('decompilation') else ''
    flutter_note = '<p class="payload-note">' + dual('Flutter scope: Flutter runtime libraries and assets are retained. JADX covers Android Java/Kotlin integration; original Dart source and a buildable original project are not recovered.', 'Flutter 范围：保留 Flutter 运行库与资源。JADX 处理 Android Java/Kotlin 集成代码；未恢复原始 Dart 源码或可构建的原始工程。') + '</p>' if report.get('detected', {}).get('flutter') else ''
    dart_data = {'functions': [], 'files': []}
    dart_index = safe_file(root, 'evidence/dart-functions.json')
    if dart_index is not None and dart_index.stat().st_size <= 128 * 1024 * 1024:
        dart_data = json.loads(dart_index.read_text(encoding='utf-8'))
        used = {call['address'] for item in dart_data.get('functions', []) for call in item.get('calls', [])}
        dart_data['functions'] = [{**{key: item[key] for key in ('name', 'address', 'size', 'assembly_available', 'file', 'line', 'detail_file') if key in item},
                                   'calls': [{key: call[key] for key in ('address', 'line', 'kind') if key in call} for call in item.get('calls', [])]}
                                  for item in dart_data.get('functions', [])]
        dart_data['symbols'] = [{key: node[key] for key in ('name', 'address', 'kind', 'file', 'line', 'body_available', 'canonical_address') if key in node}
                                for node in dart_data.get('symbols', []) if node['address'] in used]

    flutter = report.get('flutter', {})
    dart_info = '<dl class="architecture-info">' + ''.join('<div><dt>' + dual(en, zh) + '</dt><dd>' + escape(value) + '</dd></div>' for en, zh, value in [
                 ('Analysis status', '分析状态', flutter.get('status', 'not_run')), ('Indexed functions', '索引函数', flutter.get('function_count', 0)),
                 ('Assembly files', '汇编文件', flutter.get('assembly_files', 0)), ('Pseudocode bodies', '伪代码函数体', flutter.get('pseudocode_functions', 0)),
                 ('Static call edges', '静态调用关系', flutter.get('direct_call_edges', 0)), ('Indexed function edges', '已索引函数关系', flutter.get('resolved_call_edges', 0)), ('Recognized symbol edges', '已识别符号关系', flutter.get('symbol_resolved_edges', 0)), ('Targets with bodies', '具备函数体的目标', flutter.get('body_resolved_edges', 0)), ('CFG functions', 'CFG 函数', flutter.get('cfg_functions', 0)), ('Control regions', '控制结构区域', flutter.get('control_regions', 0)), ('Unresolved indirect targets', '未解析间接目标', flutter.get('unresolved_indirect_calls', 0))]) + '</dl>'
    payload_labels = {'dex': ('Android DEX', 'Android DEX'), 'managed': ('Managed assemblies', '托管程序集'),
                      'native': ('Native binaries', '原生二进制'), 'il2cpp': ('IL2CPP', 'IL2CPP'),
                      'flutter': ('Flutter', 'Flutter'), 'unity_inputs': ('Unity inputs', 'Unity 输入文件')}
    if flutter.get('truncated'):
        dart_info += '<p class="payload-note">' + dual('Analysis limits reached; counts and control regions cover retained evidence only.', '已达到分析上限；计数与控制结构仅覆盖保留的分析证据。') + '</p>'
    categories = dart_data.get('mapping_diagnostics', {}).get('categories', {})
    if categories:
        dart_info += '<p>' + dual('Mapping categories:', '映射分类：') + ' ' + escape(', '.join(key + ': ' + str(value) for key, value in categories.items())) + '</p>'
    payload_cards = ''.join('<article class="architecture-layer" data-layer-kind="' + escape(group['kind']) + '"><h3>'
                            + dual(*payload_labels.get(group['kind'], (group['kind'], group['kind']))) + '</h3><p class="payload-count"><b>' + str(group['count']) + '</b> '
                            + dual('retained files', '个保留文件') + '</p><ul>' + ''.join('<li><code>' + escape(path) + '</code></li>' for path in group['paths'][:5]) + '</ul>'
                            + ('<small>' + dual('Showing 5 examples; see the full artifact evidence.', '显示 5 个示例；其余请查看完整文件证据。') + '</small>' if group['count'] > 5 else '')
                            + '<small>' + dual('local-observed · retained payload', 'local-observed · 保留的载荷') + '</small></article>'
                            for group in work['payloadGroups'])
    source_rows = ''.join('<li><button type="button" data-source-path="' + escape(item['path']) + '" data-source-bytes="' + str(item['bytes']) + '">' + escape(item['path']) + '</button> <a href="' + quote(item['path'], safe='/') + '">' + dual('Open file', '打开文件') + '</a></li>' for item in work['sourceFiles'])
    entry_rows = ''.join('<tr><td>' + escape(item['kind']) + '</td><td><code>' + escape(item['qualifiedName']) + '</code>'
                         + ('<br><small>' + dual('Target activity:', '目标 Activity：') + ' <code>' + escape(item['targetQualifiedName']) + '</code></small>' if item.get('targetQualifiedName') else '') + '</td><td>'
                         + (''.join('<button type="button" data-source-path="' + escape(path) + '">' + escape(path) + '</button>' for path in item['sourcePaths']) if item['sourcePaths'] else dual('No exact source filename match', '未找到完全匹配的源码文件名'))
                         + '</td><td>' + escape(item['evidence']) + '</td></tr>' for item in work['entrypoints'])
    rebuild = ['# APK reconstruction plan', '', 'This is a starting checklist for a new project, not a claim that the original project can be rebuilt.',
               'Keep this analysis output read-only. Work in a separate project directory and preserve the original APK and hashes.', '',
               '## Retained inputs', '', '- Original package: `raw/original.apk`', '- Verified extracted files: `evidence/files.json` and `extracted/`',
               '- Decompiled source: `decompiled/` (when present)', '- Analysis and tool arguments: `report.json` and `docs/reproduction.md`', '',
               '## Target boundaries', '', '- Android DEX/Java: create a new Android project; use recovered Java as reference and restore build configuration, dependencies, resources, and generated code manually.',
               '- Managed assemblies: create a matching .NET/Unity project only after identifying engine and framework versions; treat decompiled C# as reference.',
               '- Native, IL2CPP, and Flutter payloads: binaries are retained for separate analysis. Original source and a rebuild target are not recovered here.',
               '- Backend services, signing keys, store metadata, secrets, and runtime behavior require independent evidence.', '',
               '## Entrypoint implementation checklist', '',
               '1. Confirm package name, SDK levels, permissions, components, and intent filters against the retained manifest.',
               '2. For each declaration below, inspect the listed source candidate or resolve the missing class manually.',
               '3. Recreate application initialization, component lifecycle methods, navigation, resources, and declared permissions in the new project.',
               '4. Resolve dependencies and generated bindings before attempting a local build. Compare build errors against recovered artifacts.',
               '5. Validate behavior separately in an authorized test environment; static matches do not establish runtime reachability.', '']
    for item in work['entrypoints']:
        label = item['qualifiedName'].replace('`', "'").replace('\n', ' ')
        paths = ', '.join('`' + path + '`' for path in item['sourcePaths']) or 'no exact source filename match'
        target = ' → target `' + item['targetQualifiedName'].replace('`', "'") + '`' if item.get('targetQualifiedName') else ''
        rebuild.append('- [ ] ' + item['kind'] + ' `' + label + '`' + target + ' — ' + paths + ' (declared in `' + item['evidence'] + '`)')
    if not work['entrypoints']:
        rebuild.append('- No manifest component names were available from retained evidence; inspect `extracted/AndroidManifest.xml` and `evidence/manifest.txt`.')
    rebuild += ['', '## Limits', '', 'Source inventory is capped at 1,000 files; browser reads are capped at 4 MiB and 20,000 lines per file.',
                'A source filename match is only a navigation hint. No recovered application code is executed by this report.', '']
    (root / 'docs/rebuild.md').write_text('\n'.join(rebuild), encoding='utf-8')

    document = ('<!doctype html><html lang="en" data-system-language="' + system_language() + '" data-source-root="' + escape(str(root.resolve())) + '"><meta charset="utf-8">'
                '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
                'script-src ' + script_hashes + '; connect-src \'self\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>' + html.escape(title) + '</title>'
                '<style>' + workbench_style + controls_style + '</style><body class="apk-report">'
                '<header><div class="badge">GILLII / LOCAL CODE EVIDENCE</div>'
                '<h1>' + dual('APK developer workbench', 'APK 开发工作台') + '</h1><p class="report-identity">' + identity + ' · ' + dual('Recovery', '恢复状态') + ': ' + status_badge + '</p>'
                '<p>' + dual('Static evidence only. No application code was executed. Decompiled source is an approximation and does not guarantee a buildable original project.', '仅分析本地静态证据，不执行应用代码。反编译结果是近似还原，不保证能构建为原始工程。') + '</p>'
                '</header><main>'
                '<nav class="workbench-nav" aria-label="Workspace / 工作区"><a href="#architecture">' + dual('Architecture', '架构纵览') + '</a><a href="#entrypoints">' + dual('Entrypoints', '入口') + '</a><a href="#source-browser">' + dual('Source workspace', '源码工作区') + '</a>' + ('<a href="#dart">' + dual('Dart analysis', 'Dart 分析') + '</a>' if report.get('detected', {}).get('flutter') else '') + '<a href="#recovery">' + dual('Recovery & evidence', '恢复与证据') + '</a><a class="advanced-tab" href="#blueprint">' + dual('Rebuild blueprint', '复建蓝图') + '</a><select id="report-language" aria-label="Language / 语言"><option value="en">English</option><option value="zh">中文</option></select></nav>'
                '<section id="architecture"><h2>' + dual('Recovered architecture', '恢复结果架构') + '</h2>' + basic_info + decompilation_info + flutter_note + '<p>' + dual('Counts describe retained payloads and decompiled files. They do not establish runtime use or original source completeness.', '数量仅描述保留的载荷与反编译文件，不代表运行时使用情况或原始源码完整性。') + '</p>'
                '<div class="architecture-layers">' + (payload_cards or '<p>' + dual('No supported payloads identified in retained evidence.', '保留证据中未识别出受支持的载荷。') + '</p>') + '</div><p>' + dual('Source groups:', '源码分组：') + ' ' + (escape(', '.join(work['sourceGroups'])) if work['sourceGroups'] else dual('none', '无')) + '</p></section>'
                '<section id="blueprint"><h2>' + dual('Rebuild blueprint', '复建蓝图') + '</h2><article class="blueprint-content"></article><pre id="blueprint-data" hidden>' + escape('\n'.join(rebuild)) + '</pre></section>'
                '<section id="entrypoints"><h2>' + dual('Manifest-declared entrypoints', '清单声明的入口') + '</h2><p>' + dual('A filename match is a static navigation hint, not proof that the entrypoint works or that the class was recovered completely.', '文件名匹配仅供静态导航，不证明入口可运行或类已完整恢复。') + '</p>'
                '<div class="table"><table><tr><th>' + dual('Type', '类型') + '</th><th>' + dual('Class', '类') + '</th><th>' + dual('Source candidate', '候选源码') + '</th><th>' + dual('Declaration evidence', '声明证据') + '</th></tr>' + entry_rows + '</table></div></section>'
                '<section id="source-browser"><h2>' + dual('Recovered source browser', '恢复源码浏览') + '</h2><p>' + dual('Showing up to 1,000 source files. Open a file link directly when viewing this report offline.', '最多列出 1,000 个源码文件。离线查看报告时可直接打开文件链接。') + '</p>'
                '<div class="workbench-grid"><div><input id="apk-file-search" type="search" aria-label="Find source file / 查找源码文件"><div class="workbench-files"><ul id="apk-file-list">' + source_rows + '</ul></div></div><div id="source-pane"></div></div></section>'
                '<section id="dart"><h2>' + dual('Dart AOT analysis', 'Dart AOT 分析') + '</h2>' + dart_info + '<p>' + dual('Assembly, object pools and direct calls are static analysis artifacts, not original Dart source. Search a function and inspect its retained assembly. Runtime dispatch and behavior require separate verification.', '汇编、对象池和直接调用属于静态分析结果，并非原始 Dart 源码。搜索函数可查看保留的汇编；动态派发与运行行为需要单独验证。') + '</p><div class="workbench-grid"><div><input id="dart-search" type="search"><div id="dart-list" class="workbench-files"></div></div><article id="dart-detail" class="dart-detail"></article></div><pre id="dart-data" hidden>' + escape(json.dumps(dart_data, ensure_ascii=True, separators=(',', ':'))) + '</pre></section>'
                '<section id="recovery"><h2>' + dual('Recovery & evidence', '恢复与证据') + '</h2><p><b>' + dual('Input:', '输入：') + '</b> ' + escape(report.get('input', '')) + '</p>'
                '<p><b>SHA-256:</b> <code>' + escape(report.get('input_sha256', 'unavailable')) + '</code></p>'
                '<h2>' + dual('Evidence', '证据') + '</h2><ul>' + navigation + '</ul><h2>' + dual('Outputs', '输出') + '</h2><ul>' + directories + '</ul>'
                '<details><summary>' + dual('Analysis details', '分析详情') + '</summary><h2>' + dual('Stages', '分析阶段') + '</h2><div class="table"><table><tr><th>' + dual('Stage', '阶段') + '</th><th>' + dual('Status', '状态') + '</th><th>' + dual('Issue', '问题') + '</th></tr>' + stages + '</table></div>'
                '<h2>' + dual('Investigation next steps', '下一步调查') + '</h2><ol>' + next_steps + '</ol>'
                '<h2>' + dual('Artifact evidence', '文件证据') + '</h2><p>' + dual('local-observed: retained local evidence; static-inferred: static identification; unverified: requires further evidence. None confirms runtime behavior.', 'local-observed：本地文件事实；static-inferred：静态识别与推导；unverified：仍需额外证据。均不代表运行时确认。') + '</p>'
                '<div class="table"><table><tr><th>' + dual('Kind', '类型') + '</th><th>' + dual('Artifact', '文件') + '</th><th>' + dual('Evidence class', '证据等级') + '</th></tr>' + evidence_rows + '</table></div>'
                '<details><summary>' + dual('Full report', '完整报告') + '</summary><pre>' + html.escape(payload) + '</pre></details></details></section></main><script>' + language_script + '</script><script>' + source_script + '</script><script>' + blueprint_script + '</script><script>' + workbench_script + '</script></body></html>')
    (root / 'index.html').write_text(document, encoding='utf-8')
    lines = ['# Reproduction', '', 'These are the exact argument vectors invoked, quoted for a POSIX shell.',
             'Paths refer to this retained analysis run. No application entrypoint is executed.', '']
    for command in report.get('commands', []):
        lines += ['## ' + command['stage'].replace('\n', ' '), '',
                  '```sh', 'cd ' + shlex.quote(command['cwd']),
                  shlex.join(command['argv']).replace('```', '` ` `'), '```', '',
                  'Result: ' + str(command.get('returncode', command.get('error', 'unknown'))), '']
    if not report.get('commands'):
        lines += ['No external commands were invoked.', '']
    (root / 'docs/reproduction.md').write_text('\n'.join(lines), encoding='utf-8')
