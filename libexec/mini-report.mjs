import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function inventory(root) {
  const files = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push({ path: relative(root, file).split('\\').join('/'), bytes: statSync(file).size, sha256: hash(readFileSync(file)) });
    }
  }
  visit(root);
  return files;
}

export function analyzeMiniProgram(source, files) {
  const result = { scope: 'Static local evidence, not runtime behavior. API calls are direct wx/uni/tt member calls only; aliases and computed expressions may be missed. URLs are string literals, not verified endpoints.',
    pages: [], subPackages: [], permissions: {}, requiredPrivateInfos: [], components: [], plugins: {}, apis: [], urls: [], errors: [] };
  const configFile = ['app.json', 'plugin.json'].find(name => existsSync(join(source, name)));
  if (configFile) {
    try {
      const config = JSON.parse(readFileSync(join(source, configFile), 'utf8'));
      result.config = configFile;
      result.pages = Array.isArray(config.pages) ? config.pages : Object.values(config.pages || {});
      result.subPackages = config.subPackages || config.subpackages || [];
      result.permissions = config.permission || {};
      result.requiredPrivateInfos = config.requiredPrivateInfos || [];
      result.plugins = config.plugins || {};
      result.renderer = config.renderer || null;
    } catch (error) { result.errors.push({ file: configFile, error: error.message }); }
  } else result.errors.push({ file: 'app.json/plugin.json', error: 'Restored configuration unavailable.' });
  for (const file of files.filter(file => file.path.endsWith('.json'))) {
    try {
      const config = JSON.parse(readFileSync(join(source, file.path), 'utf8'));
      if (config.usingComponents && typeof config.usingComponents === 'object') {
        for (const [name, target] of Object.entries(config.usingComponents)) result.components.push({ file: file.path, name, target });
      }
    } catch (error) { result.errors.push({ file: file.path, error: error.message }); }
  }
  let acorn, walk;
  try {
    acorn = require('./tools/wxappUnpacker/node_modules/acorn');
    walk = require('./tools/wxappUnpacker/node_modules/acorn-walk');
  } catch (error) {
    result.errors.push({ stage: 'javascript-analysis', error: 'Parser dependency unavailable; API and URL analysis not performed.' });
    return result;
  }
  for (const file of files.filter(file => file.path.endsWith('.js') && !/(?:^|\/)(?:app-service|appservice|page-frame|pageframe|app-wxss)\.js$/.test(file.path))) {
    try {
      const tree = acorn.parse(readFileSync(join(source, file.path), 'utf8'), { ecmaVersion: 'latest', allowReturnOutsideFunction: true, locations: true });
      walk.simple(tree, {
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || !['wx', 'uni', 'tt'].includes(callee.object.name)) return;
          const method = callee.computed ? callee.property.value : callee.property.name;
          if (typeof method === 'string') result.apis.push({ api: callee.object.name + '.' + method, file: file.path, line: node.loc.start.line });
        },
        Literal(node) {
          if (typeof node.value !== 'string' || !/^https?:\/\//i.test(node.value)) return;
          try {
            const url = new URL(node.value);
            // Keep route evidence without copying credentials, query tokens or fragments into reports.
            result.urls.push({ url: url.origin + url.pathname, file: file.path, line: node.loc.start.line });
          } catch (error) { /* A non-URL literal is not endpoint evidence. */ }
        }
      });
    } catch (error) { result.errors.push({ file: file.path, error: error.message }); }
  }
  result.apiCounts = Object.fromEntries([...new Set(result.apis.map(item => item.api))].sort().map(api => [api, result.apis.filter(item => item.api === api).length]));
  result.domains = [...new Set(result.urls.map(item => new URL(item.url).hostname))].sort();
  return result;
}

export function finishMiniReport(output, report) {
  const evidence = join(output, 'evidence'), docs = join(output, 'docs');
  mkdirSync(evidence, { recursive: true }); mkdirSync(docs, { recursive: true });
  report.finished = new Date().toISOString();
  report.durationMs = Date.parse(report.finished) - Date.parse(report.started);
  report.reportingErrors = [];
  const inventories = {};
  for (const name of ['raw', 'source']) {
    try {
      inventories[name] = inventory(join(output, name));
      writeFileSync(join(evidence, name + '-files.json'), JSON.stringify(inventories[name], null, 2));
    } catch (error) { report.reportingErrors.push({ stage: name + '-inventory', error: error.message }); }
  }
  let analysis;
  const analysisStarted = Date.now();
  try {
    analysis = analyzeMiniProgram(join(output, 'source'), inventories.source || []);
    writeFileSync(join(evidence, 'analysis.json'), JSON.stringify(analysis, null, 2));
    const extensions = {};
    for (const file of inventories.source || []) { const extension = extname(file.path) || '(none)'; extensions[extension] = (extensions[extension] || 0) + 1; }
    report.analysis = { status: analysis.errors.length ? 'partial' : 'complete', evidence: 'evidence/analysis.json',
      sourceFiles: inventories.source?.length || 0, rawFiles: inventories.raw?.length || 0, extensions,
      directApiCalls: analysis.apis.length, domains: analysis.domains || [], components: analysis.components.length, errors: analysis.errors };
  } catch (error) { report.reportingErrors.push({ stage: 'analysis', error: error.message }); }
  report.stages.push({ name: 'analysis', status: report.analysis?.status || 'failed', durationMs: Date.now() - analysisStarted });
  report.coverage = { status: ['failed', 'incomplete'].includes(report.status) ? report.status :
    report.status === 'complete_cached' || report.analysis?.status === 'partial' || report.reportingErrors.length ? 'partial' : 'complete',
    scope: 'Static recovery and local analysis only; original source, backend code and runtime/rendering equivalence are not guaranteed.',
    uncachedPages: report.validation?.unavailablePages || [] };
  report.artifacts = ['index.html', 'report.json', 'docs/reproduction.md', 'docs/analysis.md', 'evidence/raw-files.json', 'evidence/source-files.json', 'evidence/analysis.json'];
  const lines = ['# Reproduction', '', 'These commands refer to the retained package snapshot and the recorded Gillii installation.',
    'Keep all selected packages together; do not use an existing output directory. Tool paths may need updating on another machine.', '',
    '## Full recovery into a new output directory', '', '```sh', (report.reproductionCommand || []).map(quote).join(' '), '```', '',
    '## Recorded subprocesses', '', 'These commands used the original output paths and can modify generated files. They are records, not an automatic rerun script.', ''];
  for (const command of report.commands || []) lines.push('```sh', 'cd ' + quote(command.cwd), command.argv.map(quote).join(' '), '```', '',
    'Exit: ' + command.returncode + '; log: ' + command.log, '');
  // A longer Markdown fence prevents package-derived backticks from closing a command block.
  const text = lines.join('\n');
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  writeFileSync(join(docs, 'reproduction.md'), text.replace(/^```sh$/gm, fence + 'sh').replace(/^```$/gm, fence) + '\n');
  const analysisText = JSON.stringify(analysis || { errors: report.reportingErrors }, null, 2);
  const analysisFence = '`'.repeat(Math.max(3, ...[...analysisText.matchAll(/`+/g)].map(match => match[0].length + 1)));
  writeFileSync(join(docs, 'analysis.md'), '# 小程序静态分析\n\n恢复状态：' + report.status + '；覆盖状态：' + report.coverage.status + '\n\n页面、分包、权限和组件来自恢复配置；API 来自直接调用表达式；域名来自字符串常量。不会访问这些地址。别名调用、动态拼接、条件分支和运行时行为不能据此确认。源码目录同时保留编译产物，文件数量不是独立业务模块数量。\n\n' + analysisFence + 'json\n' + analysisText + '\n' + analysisFence + '\n');
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const table = (headers, rows) => '<table><thead><tr>' + headers.map(value => '<th>' + escape(value) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(value => '<td>' + escape(value) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
  const links = report.artifacts.filter(path => path !== 'index.html' && existsSync(join(output, path))).map(path => '<li><a href="' + escape(path) + '">' + escape(path) + '</a></li>').join('');
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
    '<title>Gillii 小程序分析报告</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#202631}h1,h2{line-height:1.3}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{text-align:left;padding:10px;border-bottom:1px solid #ddd;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f8;padding:18px}a{color:#145db0}code{overflow-wrap:anywhere}</style></head><body>' +
    '<h1>小程序分析报告</h1><p>AppID：' + escape(report.appid) + ' · 恢复状态：<b>' + escape(report.status) + '</b> · 覆盖状态：' + escape(report.coverage.status) + '</p>' +
    '<p>仅基于本地文件的静态证据；不代表可以直接构建、运行或完全复原。未缓存页面与恢复失败分别列出。</p>' +
    '<p>输入：' + escape(report.input) + '<br>SHA-256：<code>' + escape(report.inputSha256) + '</code></p>' +
    '<h2>概览</h2>' + table(['项目', '数量'], [['选择的包', report.packages?.length || 0], ['原始文件', report.analysis?.rawFiles || 0], ['源码目录文件', report.analysis?.sourceFiles || 0], ['已缓存页面', report.validation?.pages ?? '未验证'], ['声明页面', report.validation?.declaredPages ?? '未验证'], ['直接 API 调用', report.analysis?.directApiCalls || 0]]) +
    '<h2>阶段</h2>' + table(['阶段', '状态', '耗时 ms', '错误'], (report.stages || []).map(stage => [stage.name, stage.status, stage.durationMs ?? '', stage.error || ''])) +
    '<h2>证据与复现</h2><ul>' + links + '</ul>' +
    '<h2>完整性校验</h2><pre>' + escape(JSON.stringify(report.validation || { status: 'not_run', reason: report.error }, null, 2)) + '</pre>' +
    '<h2>API 调用（静态）</h2>' + table(['API', '调用点数量'], Object.entries(analysis?.apiCounts || {})) +
    '<h2>URL 常量（未验证）</h2>' + table(['地址（省略凭据与查询参数）', '文件', '行'], (analysis?.urls || []).map(item => [item.url, item.file, item.line])) +
    '<h2>组件引用</h2>' + table(['配置文件', '组件', '目标'], (analysis?.components || []).map(item => [item.file, item.name, item.target])) +
    '<h2>页面与权限声明</h2><pre>' + escape(JSON.stringify({ pages: analysis?.pages, subPackages: analysis?.subPackages, permissions: analysis?.permissions, requiredPrivateInfos: analysis?.requiredPrivateInfos, plugins: analysis?.plugins }, null, 2)) + '</pre>' +
    '<h2>静态分析摘要</h2><pre>' + escape(JSON.stringify(report.analysis || {}, null, 2)) + '</pre>' +
    '<details><summary>完整报告</summary><pre>' + escape(JSON.stringify(report, null, 2)) + '</pre></details></body></html>';
  writeFileSync(join(output, 'index.html'), html);
}
