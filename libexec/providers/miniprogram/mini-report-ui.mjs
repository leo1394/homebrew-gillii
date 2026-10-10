import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderRebuildMarkdown } from './mini-reconstruction.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const controlsStyle = readFileSync(new URL('../workbench/report-controls.css', import.meta.url), 'utf8');
const workbenchStyle = readFileSync(new URL('../workbench/report-workbench.css', import.meta.url), 'utf8');
const sourceScript = readFileSync(new URL('../workbench/report-source-tools.js', import.meta.url), 'utf8');
const blueprintScript = readFileSync(new URL('../workbench/report-blueprint.js', import.meta.url), 'utf8');
const languageScript = readFileSync(new URL('../workbench/report-language.js', import.meta.url), 'utf8');
const translations = {'Mini-program developer workbench': '小程序开发工作台', 'Feature relationships': '功能关系', 'Prioritized next steps': '优先后续步骤', 'Stages and coverage': '阶段与覆盖', 'Evidence & reproduction': '证据与复现', 'Limits of this analysis': '分析边界', 'Complete recovery report': '完整恢复报告', 'API counts, sanitized URLs and configuration': 'API 次数、脱敏 URL 与配置', 'All kinds': '全部类型', 'All evidence': '全部证据', 'source files': '源码文件', 'main page declarations': '主包页面声明', 'direct API calls': '直接 API 调用', 'evidence gaps': '证据缺口', 'Stage': '阶段', 'Status': '状态', 'Duration ms': '耗时毫秒', 'Error': '错误', 'Explore recovered pages, events, functions and dependencies. Static relationships describe source evidence; runtime behavior and backend implementation remain unverified.': '探索恢复的页面、事件、函数与依赖。静态关系描述源码证据；运行时行为与后端实现尚未验证。', 'Open this page in the authorized app, refresh the local cache and recover again.': '在已授权的应用中打开此页面，刷新本地缓存后重新恢复。', 'Inspect this source location and resolve the missing or dynamic reference with runtime evidence.': '检查此源码位置，并使用运行时证据确认缺失或动态引用。', 'Review this function and verify its trigger, inputs and effects in an authorized runtime session.': '审阅此函数，并在已授权的运行环境中验证触发条件、输入与影响。', 'Record the exact page, user action, application version and observed result. Correlate authorized runtime traces with static locations; do not infer backend behavior from URL strings.': '记录具体页面、用户操作、应用版本与观察结果，将已授权的运行时轨迹关联到静态位置；不要从 URL 字符串推断后端行为。', 'Inspect the failed recovery stage and retained logs, resolve the reported cause and retry into a new output directory.': '检查失败的恢复阶段与保留日志，解决原因后在新输出目录重试。', 'Local-observed means recovered file evidence, never observed runtime execution.': '本地观察仅指恢复文件中的证据，不代表观察到运行时执行。', 'Static-inferred relationships do not prove reachability, event dispatch or successful network access.': '静态推断关系不能证明运行可达性、事件派发或网络访问成功。', 'Only direct lexical functions, literal module paths and simple WXML event bindings are linked. Aliases, template expansion and dynamic dispatch require review.': '仅关联直接词法函数、字面量模块路径与简单 WXML 事件绑定。别名、模板展开和动态派发需要进一步审阅。', 'Nested callbacks own their calls; they are not attributed to enclosing handlers. Import/export symbol flow is not resolved.': '嵌套回调中的调用归属于回调本身，不归属于外层处理函数。尚未解析导入导出符号流。', 'No recovered code is executed and no business endpoint is contacted. Runtime behavior and backend implementation remain unverified.': '不会执行恢复代码或访问业务接口。运行时行为与后端实现仍未验证。'};
Object.assign(translations, {
  'Recovery & evidence': '恢复与证据', 'Architecture': '架构纵览', 'Feature traces': '功能追踪', 'Symbols & references': '符号与引用', 'Source workspace': '源码工作区', 'Rebuild blueprint': '复建蓝图', 'Recovered structure grouped for reading. Choose a source entry to inspect its references; the rebuild blueprint proposes boundaries for your new project.': '按阅读职责分组恢复结构。选择源码入口查看引用关系；复建蓝图提供新项目边界建议。',
  'Recovery': '恢复状态', 'Coverage': '覆盖状态', 'Input': '输入', 'Type': '类型', 'Mini-program': '小程序', 'Declared pages': '声明页面', 'Cached packages': '缓存包', 'Source files': '源码文件', 'Renderer': '渲染器', 'Not declared': '未声明',
  'present in recovered files': '存在于恢复文件中', 'linked by static syntax': '由静态语法关联', 'needs missing source or runtime evidence.': '需要缺失源码或运行时证据。',
  'Search page, function, API or file…': '搜索页面、函数、API 或文件…',
  'Source excerpts show up to five lines of 500 characters each, with a 1 MiB overall excerpt budget. Source files above 4 MiB are not parsed.': '源码摘录最多显示五行，每行 500 字符，总预算为 1 MiB。超过 4 MiB 的源码文件不会解析。',
  'uncached-page': '未缓存页面', 'unresolved-component': '未解析组件', 'unresolved-import': '未解析导入', 'unresolved-navigation': '未解析导航', 'dynamic-api': '动态 API', 'dynamic-target': '动态目标', 'unresolved-handler': '未解析事件处理函数', 'unresolved-method': '未解析方法', 'parse-error': '解析错误', 'resource-limit': '资源上限', 'template-expansion': '模板展开', 'important-function': '重要函数', 'runtime-evidence': '运行时证据', 'recovery-failure': '恢复失败'
});
const bilingual = text => '<span data-en="' + escape(text) + '" data-zh="' + escape(translations[text] || text) + '">' + escape(text) + '</span>';
// This script is fixed trusted UI code. Recovered content is decoded only as JSON/text.
const script = `
const t = (en, zh) => window.gilliiI18n.t(en, zh);
function translateLabels() { document.getElementById('search').setAttribute('aria-label', t('Search source evidence', '搜索源码证据')); document.getElementById('kind').setAttribute('aria-label', t('Node kind', '节点类型')); document.getElementById('evidence').setAttribute('aria-label', t('Evidence class', '证据类型')); }
translateLabels();
const names = { page:'页面', module:'模块', function:'函数', component:'组件', event:'事件', api:'API', endpoint:'接口地址', 'navigation-target':'导航目标', 'local-observed':'本地文件观察', 'static-inferred':'静态推断', unverified:'尚未验证', 'page-file':'页面文件', 'defines-function':'定义函数', 'registers-handler':'注册处理函数', 'binds-event':'绑定事件', 'event-handler':'事件处理函数', 'calls-method':'调用方法', calls:'调用', 'calls-api':'调用 API', imports:'导入', requires:'加载模块', 'uses-component':'使用组件', 'declares-component':'声明组件', 'component-module':'组件模块', 'request-target':'请求目标' };
const label = value => t(value, names[value] || value);
const data = JSON.parse(document.getElementById('data').textContent);
const nodes = data.relationships.nodes, edges = data.relationships.edges;
const byId = new Map(nodes.map(node => [node.id, node]));
const list = document.getElementById('results'), detail = document.getElementById('detail');
const search = document.getElementById('search'), kind = document.getElementById('kind'), evidence = document.getElementById('evidence');
const workspaceIds = ['architecture', 'features', 'relationships', 'source-workspace', 'blueprint', 'recovery'];
function showWorkspace(id) {
  if (!workspaceIds.includes(id)) id = 'architecture';
  if (location.hash !== '#' + id) location.hash = id;
  for (const name of workspaceIds) document.getElementById(name).hidden = name !== id;
  for (const section of document.querySelectorAll('.recovery-details')) section.hidden = id !== 'recovery';
  for (const anchor of document.querySelectorAll('.workbench-nav a')) anchor.setAttribute('aria-current', anchor.getAttribute('href') === '#' + id ? 'page' : 'false');
}
window.addEventListener('hashchange', () => showWorkspace(location.hash.slice(1)));
for (const anchor of document.querySelectorAll('.workbench-nav a[href^="#"]')) anchor.onclick = () => showWorkspace(anchor.getAttribute('href').slice(1));
showWorkspace(location.hash.slice(1));
const reconstruction = data.reconstruction || { layers: [], features: [], files: [] };
const sourceTools = window.gilliiSourceTools.mount(document.getElementById('source-panel'), { files: reconstruction.files, basePath: 'source/', sourceRoot: data.sourceRoot });
const fileSearch = document.getElementById('file-search'), fileList = document.getElementById('file-list');
function sourceLocation(node, parent) {
  const button = el('button', t('Inspect / edit source', '查看 / 编辑源码'), parent);
  button.onclick = () => { sourceTools.open(node.file, node.line); showWorkspace('source-workspace'); };
}
function renderFiles() {
  fileSearch.placeholder = t('Find a file…', '查找文件…'); fileSearch.setAttribute('aria-label', fileSearch.placeholder); fileList.replaceChildren();
  const files = reconstruction.files.filter(file => file.path.toLowerCase().includes(fileSearch.value.toLowerCase()));
  for (const file of files.slice(0, 400)) { const button = el('button', file.path, fileList); el('small', file.kind + ' · ' + file.bytes + ' B', button); button.onclick = () => sourceTools.open(file.path); }
  if (files.length > 400) el('small', t('Showing 400 files. Narrow the search.', '显示前 400 个文件，请缩小搜索范围。'), fileList);
}
fileSearch.oninput = renderFiles;
function renderArchitecture() {
  const root = document.getElementById('architecture-layers'); root.replaceChildren();
  const filter = document.getElementById('architecture-search'); filter.placeholder = t('Find a page or module…', '查找页面或模块…'); filter.setAttribute('aria-label', filter.placeholder); filter.oninput = renderArchitecture;
  const titles = { components: '组件', shared: '共享模块', platform: '平台接口与目标', other: '其他恢复模块' };
  const layers = reconstruction.layers.filter(layer => layer.label.toLowerCase().includes(filter.value.toLowerCase()) || layer.nodeIds.some(id => byId.get(id)?.file.toLowerCase().includes(filter.value.toLowerCase())));
  for (const layer of layers.slice(0, 100)) {
    const box = el('div', undefined, root); box.className = 'architecture-layer'; box.dataset.layerKind = layer.id.startsWith('page:') ? 'page' : ['shared', 'components', 'platform'].includes(layer.id) ? layer.id : 'other'; el('h3', t(layer.label, layer.id.startsWith('page:') ? '页面：' + layer.id.slice(5) : titles[layer.id] || layer.label), box);
    for (const id of layer.nodeIds.slice(0, 12)) { const node = byId.get(id); if (!node) continue; const button = el('button', node.label, box); button.onclick = () => { choose(node); showWorkspace('relationships'); }; }
    el('small', layer.nodeIds.length + t(' source items', ' 个源码项'), box);
    const dependencyFiles = (reconstruction.dependencies || []).filter(edge => layer.nodeIds.includes(edges[edge.edgeIndex]?.from)).slice(0, 8);
    for (const edge of dependencyFiles) el('small', edge.from + ' → ' + edge.to, box);
  }
  if (layers.length > 100) el('p', t('Showing 100 groups. Narrow the search.', '显示前 100 个分组，请缩小搜索范围。'), root);
}
let activeFeature;
function renderFeature(feature) {
  activeFeature = feature; const panel = document.getElementById('feature-detail'); panel.replaceChildren();
  el('h3', feature.label, panel); el('p', t('Static reading path, not a runtime execution trace.', '静态阅读路径，不代表运行时执行轨迹。'), panel);
  const trace = el('ol', undefined, panel); trace.className = 'feature-trace';
  const root = byId.get(feature.entryId); if (root) { const row = el('li', undefined, trace); const button = el('button', label(root.kind) + ' · ' + root.label, row); button.onclick = () => { choose(root); showWorkspace('relationships'); }; }
  for (const index of feature.edgeIndexes.slice(0, 80)) {
    const edge = edges[index]; if (!edge) continue; const from = byId.get(edge.from), to = byId.get(edge.to); if (!from || !to) continue;
    const row = el('li', undefined, trace); el('span', from.label + ' — ' + label(edge.kind) + ' → ', row);
    const button = el('button', to.label, row); button.onclick = () => { choose(to); sourceTools.open(to.file, to.line); showWorkspace('source-workspace'); };
    el('small', edge.file + ':' + edge.line + ' · ' + label(edge.evidence), row);
  }
  if (feature.truncated || feature.edgeIndexes.length > 80) el('p', t('Reading path is capped. Inspect the complete relationships for remaining references.', '阅读路径已限量，请查看完整关系中的其余引用。'), panel);
  el('h3', t('Files to read / migrate', '阅读 / 迁移文件'), panel);
  for (const file of feature.files) { const button = el('button', file, panel); button.onclick = () => { sourceTools.open(file); showWorkspace('source-workspace'); }; }
  const gaps = feature.gaps || []; if (gaps.length) { el('h3', t('Resolve before rebuilding', '复建前待确认'), panel); for (const gap of gaps) el('p', gap.kind + ': ' + gap.detail, panel); }
  const actions = el('div', undefined, panel); actions.className = 'workspace-actions';
  const handoff = el('button', t('Copy feature handoff', '复制功能复建材料'), actions);
  handoff.onclick = async () => {
    const text = '# ' + feature.label + '\\n\\n' + t('Reimplement this feature in my own architecture. Keep observed source facts separate from design choices.','在我的新架构中重新实现此功能，区分源码事实与设计选择。') + '\\n\\n' + feature.files.map(file => '- source/' + file).join('\\n') + '\\n\\n' + feature.edgeIndexes.slice(0, 80).map(index => { const edge = edges[index]; return byId.get(edge.from)?.label + ' -> ' + edge.kind + ' -> ' + byId.get(edge.to)?.label + ' (' + edge.file + ':' + edge.line + ')'; }).join('\\n') + '\\n\\n' + gaps.map(gap => 'Unverified: ' + gap.detail).join('\\n');
    try { await navigator.clipboard.writeText(text); handoff.textContent = t('Copied', '已复制'); } catch { const output = el('textarea', undefined, panel); output.value = text; output.setAttribute('aria-label', t('Feature handoff to copy', '待复制功能材料')); }
  };
}
function renderFeatures() {
  const list = document.getElementById('feature-list'); list.replaceChildren();
  for (const feature of reconstruction.features.slice(0, 300)) { const button = el('button', feature.label, list); button.onclick = () => renderFeature(feature); }
  if (activeFeature) renderFeature(activeFeature); else if (reconstruction.features[0]) renderFeature(reconstruction.features[0]);
}
function el(tag, text, parent) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (parent) parent.append(node); return node; }
function link(node, parent) { if (location.protocol === 'file:' && /\.(?:html?|svg|xml|xhtml)$/i.test(node.file)) { el('span', node.file + ':' + node.line + t(' (use the local text viewer)', '（请使用本地纯文本查看器）'), parent); return; } const a = el('a', node.file + ':' + node.line, parent); a.href = 'source/' + node.file.split('/').map(encodeURIComponent).join('/'); a.target = '_blank'; a.rel = 'noopener'; }
let selected;
function choose(node) {
  selected = node;
  detail.replaceChildren(); el('div', label(node.kind) + ' · ' + label(node.evidence), detail).className = 'badge'; el('h2', node.label, detail); link(node, detail);
  el('p', t('Source location: line ', '源码位置：第 ') + node.line + t('. The source link opens plain text; use your editor to jump to this line.', ' 行。源码链接以纯文本打开，请在编辑器中跳转到对应行。'), detail);
  sourceLocation(node, detail);
  if (node.endLine) el('small', t('Implementation range: ', '实现范围：') + node.line + ':' + (node.column || 0) + '–' + node.endLine + ':' + (node.endColumn || 0), detail);
  if (node.initialStateKeys?.length) el('p', t('Initial state keys: ', '初始状态字段：') + node.initialStateKeys.join(', '), detail);
  if (node.parameters) el('small', t('Parameters: ', '参数：') + node.parameters.join(', '), detail);
  const excerpt = data.excerpts[node.file + ':' + node.line]; if (excerpt) el('pre', excerpt, detail);
  for (const direction of ['outgoing', 'incoming']) {
    el('h3', direction === 'outgoing' ? t('References from here', '引用关系') : t('Referenced by', '被引用关系'), detail);
    const related = edges.filter(edge => direction === 'outgoing' ? edge.from === node.id : edge.to === node.id);
    if (!related.length) el('p', t('No supported static relationships found.', '未发现受支持的静态关系。'), detail);
    for (const edge of related) {
      const other = byId.get(direction === 'outgoing' ? edge.to : edge.from); if (!other) continue;
      const row = el('div', undefined, detail); row.className = 'relation';
      const button = el('button', label(edge.kind) + ' → ' + other.label, row); button.onclick = () => choose(other);
      el('small', label(edge.evidence) + ' · ' + edge.file + ':' + edge.line, row);
    }
  }
}
function render() {
  list.replaceChildren(); const query = search.value.toLowerCase();
  const filtered = nodes.filter(node => (!kind.value || kind.value === node.kind) && (!evidence.value || evidence.value === node.evidence) && [node.label,node.file,node.kind,label(node.kind)].join(' ').toLowerCase().includes(query));
  document.getElementById('count').textContent = filtered.length + t(' matching items', ' 个匹配项');
  for (const node of filtered.slice(0, 600)) { const button = el('button', node.label, list); button.onclick = () => choose(node); el('small', label(node.kind) + ' · ' + node.file + ':' + node.line, button); }
  if (filtered.length > 600) el('p', t('Showing first 600 results. Narrow the search.', '仅显示前 600 项，请缩小搜索范围。'), list);
}
for (const name of [...new Set(nodes.map(node => node.kind))].sort()) { const option = el('option', label(name), kind); option.value = name; }
search.oninput = render; kind.onchange = render; evidence.onchange = render; render();
document.addEventListener('gillii-language-change', () => { translateLabels(); for (const option of kind.options) if (option.value) option.textContent = label(option.value); for (const option of evidence.options) if (option.value) option.textContent = label(option.value); render(); renderFiles(); renderArchitecture(); renderFeatures(); sourceTools.refreshLanguage(); if (selected) choose(selected); });
for (const option of evidence.options) if (option.value) option.textContent = label(option.value);
const initial = nodes.find(node => node.kind === 'page') || nodes[0]; if (initial) choose(initial);
renderArchitecture(); renderFeatures(); renderFiles();
`;

export function renderMiniReport(report, analysis = {}) {
  const table = (headers, rows) => '<div class="table"><table><thead><tr>' + headers.map(value => '<th>' + escape(value) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(value => '<td>' + escape(value) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  const appName = [report.appName, analysis.appName].find(value => typeof value === 'string' && value.trim());
  const identity = escape(appName ? appName.trim() + ' (' + report.appid + ')' : report.appid);
  const statusBadge = value => '<strong class="status-badge" data-status="' + escape(value || 'unknown') + '">' + escape(value || 'unknown') + '</strong>';
  const facts = [['Type', bilingual('Mini-program')], ['AppID', escape(report.appid)], ['Declared pages', String(analysis.pages?.length || 0)], ['Cached packages', String(report.packages?.length || 0)], ['Source files', String(report.analysis?.sourceFiles || 0)], ['Renderer', analysis.renderer ? escape(analysis.renderer) : bilingual('Not declared')]];
  const basicInfo = '<dl class="architecture-info">' + facts.map(([name, value]) => '<div><dt>' + bilingual(name) + '</dt><dd>' + value + '</dd></div>').join('') + '</dl>';
  const trusted = languageScript + '\n' + sourceScript + '\n' + blueprintScript + '\n' + script;
  const digest = createHash('sha256').update(trusted).digest('base64');
  const data = { relationships: analysis.relationships || { nodes: [], edges: [] }, excerpts: analysis.excerpts || {}, reconstruction: analysis.reconstruction, sourceRoot: report.sourceRoot };
  let html = '<!doctype html><html lang="en" data-system-language="' + (report.systemLanguage === 'zh' ? 'zh' : 'en') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'sha256-' + digest + '\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'; connect-src \'self\'"><title>Gillii · Mini-program evidence</title>' +
    '<style>:root{color-scheme:light;--ink:#172831;--muted:#60727c;--line:#d6e0e3;--accent:#076b68}*{box-sizing:border-box}body{margin:0;background:#f3f6f5;color:var(--ink);font:15px/1.6 system-ui}header{padding:38px max(24px,5vw);background:#143b40;color:#fff}header p{max-width:960px;color:#c9e0df}h1{font-size:34px;line-height:1.15;letter-spacing:-1px}main{max-width:1400px;margin:auto;padding:28px}h2{font-size:22px}h3{font-size:16px}a{color:var(--accent)}section{margin-bottom:28px;padding:24px;background:white;border:1px solid var(--line);border-radius:12px}.metrics{display:flex;gap:24px;flex-wrap:wrap}.metrics b{display:block;font-size:25px}.metrics span{color:var(--muted)}.filters{display:flex;gap:12px;flex-wrap:wrap}input,select,button{font:inherit;border:1px solid var(--line);border-radius:6px;padding:9px;background:white;color:var(--ink)}input{flex:1;min-width:0}button{cursor:pointer;text-align:left}button:hover,button:focus-visible{border-color:var(--accent);background:#edf8f5}.browser{display:grid;grid-template-columns:minmax(0,34%) minmax(0,1fr);border-top:1px solid var(--line);margin-top:12px}.results{max-height:680px;overflow:auto;padding:15px 15px 15px 0}.results button{display:block;width:100%;margin:5px 0;overflow-wrap:anywhere}small{display:block;color:var(--muted);font-size:12px}#detail{padding:22px;min-width:0;border-left:1px solid var(--line);overflow-wrap:anywhere}.badge{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--accent)}.relation{padding:9px 0}.relation button{border:0;padding:0;color:var(--accent)}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#eef3f3;max-height:450px;overflow:auto;font:12px/1.6 ui-monospace,monospace}.table{overflow:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line);overflow-wrap:anywhere;vertical-align:top}.steps li{padding:8px 0}.steps b{color:var(--accent)}@media(max-width:720px){main{padding:12px}section{padding:15px}.browser{grid-template-columns:1fr}.results{max-height:300px}#detail{border-left:0;border-top:1px solid var(--line);padding:15px 0}}' + workbenchStyle + controlsStyle + '</style></head><body>' +
    '<header><div class="badge" style="color:#9fdad2">GILLII / LOCAL CODE EVIDENCE</div><h1>Mini-program developer workbench</h1><p class="report-identity">' + identity + ' · ' + bilingual('Recovery') + ': ' + statusBadge(report.status) + ' · ' + bilingual('Coverage') + ': ' + statusBadge(report.coverage?.status) + '</p><p>Explore recovered pages, events, functions and dependencies. Static relationships describe source evidence; runtime behavior and backend implementation remain unverified.</p></header><main>' +
    '<nav class="workbench-nav" aria-label="Workspace"><a href="#architecture">' + bilingual('Architecture') + '</a><a href="#features">' + bilingual('Feature traces') + '</a><a href="#relationships">' + bilingual('Symbols & references') + '</a><a href="#source-workspace">' + bilingual('Source workspace') + '</a><a href="#recovery">' + bilingual('Recovery & evidence') + '</a><a class="advanced-tab" href="#blueprint">' + bilingual('Rebuild blueprint') + '</a><select id="report-language" aria-label="Language / 语言"><option value="en">English</option><option value="zh">中文</option></select></nav>' +
    '<section id="architecture"><h2>' + bilingual('Architecture') + '</h2>' + basicInfo + '<p>' + bilingual('Recovered structure grouped for reading. Choose a source entry to inspect its references; the rebuild blueprint proposes boundaries for your new project.') + '</p><input id="architecture-search" type="search"><div id="architecture-layers" class="architecture-layers"></div></section>' +
    '<section id="blueprint"><h2>' + bilingual('Rebuild blueprint') + '</h2><article class="blueprint-content"></article><pre id="blueprint-data" hidden>' + escape(analysis.reconstruction ? renderRebuildMarkdown(analysis) : 'No reconstruction evidence available.') + '</pre></section>' +
    '<section id="features"><h2>' + bilingual('Feature traces') + '</h2><div class="workbench-grid"><nav id="feature-list" class="workbench-files" aria-label="Features"></nav><article id="feature-detail"></article></div></section>' +
    '<section id="source-workspace"><h2>' + bilingual('Source workspace') + '</h2><div class="workbench-grid"><nav><input id="file-search" type="search"><div id="file-list" class="workbench-files"></div></nav><article id="source-panel"></article></div></section>' +
    '<section id="recovery"><div class="metrics"><div><b>' + (report.analysis?.sourceFiles || 0) + '</b><span>source files</span></div><div><b>' + (analysis.pages?.length || 0) + '</b><span>main page declarations</span></div><div><b>' + (analysis.apis?.length || 0) + '</b><span>direct API calls</span></div><div><b>' + (analysis.gaps?.length || 0) + '</b><span>evidence gaps</span></div></div><p><b>local-observed</b>: ' + bilingual('present in recovered files') + ' · <b>static-inferred</b>: ' + bilingual('linked by static syntax') + ' · <b>unverified</b>: ' + bilingual('needs missing source or runtime evidence.') + '</p></section>' +
    '<section id="relationships"><h2>Feature relationships</h2><div class="filters"><input id="search" aria-label="Search source evidence" placeholder="Search page, function, API or file…" data-en="Search page, function, API or file…" data-zh="搜索页面、函数、API 或文件…" data-i18n-attr="placeholder"><select id="kind" aria-label="Node kind"><option value="">All kinds</option></select><select id="evidence" aria-label="Evidence class"><option value="">All evidence</option><option value="local-observed">local-observed</option><option value="static-inferred">static-inferred</option><option value="unverified">unverified</option></select></div><p id="count"></p><div class="browser"><nav class="results" id="results" aria-label="Evidence results"></nav><article id="detail"><p>Select an item to inspect its relationships.</p></article></div><noscript>Enable JavaScript for local filtering. All analysis remains available in evidence/analysis.json.</noscript></section>' +
    '<section class="recovery-details"><h2>Prioritized next steps</h2><ol class="steps">' + (analysis.nextSteps || []).map(item => '<li><b>P' + escape(item.priority) + ' · ' + bilingual(item.kind) + '</b> ' + escape(item.detail || '') + '<br>' + bilingual(item.action) + (item.file ? '<small>' + escape(item.file) + ':' + escape(item.line) + ' · ' + escape(item.evidence) + '</small>' : '') + '</li>').join('') + '</ol></section>' +
    '<section class="recovery-details"><h2>Stages and coverage</h2>' + table(['Stage', 'Status', 'Duration ms', 'Error'], (report.stages || []).map(stage => [stage.name, stage.status, stage.durationMs, stage.error])) + '<pre>' + escape(JSON.stringify(report.validation || { status: 'not_run', reason: report.error }, null, 2)) + '</pre></section>' +
    '<section class="recovery-details"><h2>Evidence & reproduction</h2><ul>' + (report.artifacts || []).filter(path => path !== 'index.html').map(path => '<li><a href="' + escape(path) + '">' + escape(path) + '</a></li>').join('') + '</ul><p>' + bilingual('Input') + ': ' + escape(report.input) + '<br>SHA-256: ' + escape(report.inputSha256) + '</p><h3>Limits of this analysis</h3><ul>' + (analysis.limitations || []).map(item => '<li>' + bilingual(item) + '</li>').join('') + '</ul><details><summary>API counts, sanitized URLs and configuration</summary><pre>' + escape(JSON.stringify({ apiCounts: analysis.apiCounts, urls: analysis.urls, components: analysis.components, pages: analysis.pages, subPackages: analysis.subPackages, permissions: analysis.permissions, plugins: analysis.plugins }, null, 2)) + '</pre></details><details><summary>Complete recovery report</summary><pre>' + escape(JSON.stringify(report, null, 2)) + '</pre></details></section>' +
    '<pre id="data" hidden>' + escape(JSON.stringify(data)) + '</pre></main><script type="text/javascript">' + trusted + '</script></body></html>';
  for (const [en, zh] of Object.entries(translations)) {
    for (const tag of ['h1', 'h2', 'h3', 'span', 'p', 'th', 'summary']) html = html.split('<' + tag + '>' + en + '</' + tag + '>').join('<' + tag + ' data-en="' + escape(en) + '" data-zh="' + escape(zh) + '">' + escape(en) + '</' + tag + '>');
    html = html.split('<option value="">' + en + '</option>').join('<option value="" data-en="' + escape(en) + '" data-zh="' + escape(zh) + '">' + escape(en) + '</option>');
  }
  return html;
}
