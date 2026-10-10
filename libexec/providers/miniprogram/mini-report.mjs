import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { analyzeRelationships } from './mini-analysis.mjs';
import { deriveReconstruction, renderRebuildMarkdown } from './mini-reconstruction.mjs';
import { renderMiniReport } from './mini-report-ui.mjs';
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

export function analyzeMiniProgram(source, files, unavailablePages = []) {
  const result = { scope: 'Static local evidence, not runtime behavior. API calls are direct wx/uni/tt member calls only; aliases and computed expressions may be missed. URLs are string literals, not verified endpoints.',
    pages: [], subPackages: [], permissions: {}, requiredPrivateInfos: [], components: [], plugins: {}, apis: [], urls: [], errors: [] };
  const configFile = ['app.json', 'plugin.json'].find(name => existsSync(join(source, name)));
  if (configFile) {
    try {
      const config = JSON.parse(readFileSync(join(source, configFile), 'utf8'));
      result.config = configFile;
      const name = [config.appName, config.nickname, config.nickName].find(value => typeof value === 'string' && value.trim());
      if (name) result.appName = name.trim();
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
  analyzeRelationships(source, files, result, unavailablePages);
  result.reconstruction = deriveReconstruction(result, files);
  result.apiCounts = Object.fromEntries([...new Set(result.apis.map(item => item.api))].sort().map(api => [api, result.apis.filter(item => item.api === api).length]));
  result.domains = [...new Set(result.urls.map(item => new URL(item.url).hostname))].sort();
  return result;
}

export function systemLanguage() {
  let locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  if (process.platform === 'darwin') {
    const result = spawnSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 1000 });
    const match = result.stdout?.match(/"([^"]+)"/);
    if (match) locale = match[1];
  }
  return /^zh(?:[-_]|$)/i.test(locale) ? 'zh' : 'en';
}

export function finishMiniReport(output, report) {
  const evidence = join(output, 'evidence'), docs = join(output, 'docs');
  mkdirSync(evidence, { recursive: true }); mkdirSync(docs, { recursive: true });
  report.systemLanguage = systemLanguage();
  report.sourceRoot = resolve(output, 'source');
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
    analysis = analyzeMiniProgram(join(output, 'source'), inventories.source || [], report.validation?.unavailablePages || []);
    if (report.error || report.stages.some(stage => stage.status === 'failed')) analysis.nextSteps.unshift({ priority: 1, kind: 'recovery-failure', evidence: 'local-observed', action: 'Inspect the failed recovery stage and retained logs, resolve the reported cause and retry into a new output directory.', detail: report.error || 'Recovery stage failed' });
    writeFileSync(join(evidence, 'analysis.json'), JSON.stringify(analysis, null, 2));
    writeFileSync(join(evidence, 'reconstruction.json'), JSON.stringify(analysis.reconstruction, null, 2));
    writeFileSync(join(docs, 'rebuild.md'), renderRebuildMarkdown(analysis));
    const extensions = {};
    for (const file of inventories.source || []) { const extension = extname(file.path) || '(none)'; extensions[extension] = (extensions[extension] || 0) + 1; }
    report.analysis = { status: analysis.errors.length ? 'partial' : 'complete', evidence: 'evidence/analysis.json',
      sourceFiles: inventories.source?.length || 0, rawFiles: inventories.raw?.length || 0, extensions,
      relationshipNodes: analysis.relationships.nodes.length, relationshipEdges: analysis.relationships.edges.length, evidenceGaps: analysis.gaps.length, nextSteps: analysis.nextSteps.length,
      directApiCalls: analysis.apis.length, domains: analysis.domains || [], components: analysis.components.length, errors: analysis.errors };
  } catch (error) { report.reportingErrors.push({ stage: 'analysis', error: error.message }); }
  report.stages.push({ name: 'analysis', status: report.analysis?.status || 'failed', durationMs: Date.now() - analysisStarted });
  report.coverage = { status: ['failed', 'incomplete'].includes(report.status) ? report.status :
    report.status === 'complete_cached' || report.analysis?.status === 'partial' || report.reportingErrors.length ? 'partial' : 'complete',
    scope: 'Static recovery and local analysis only; original source, backend code and runtime/rendering equivalence are not guaranteed.',
    uncachedPages: report.validation?.unavailablePages || [] };
  report.artifacts = ['index.html', 'report.json', 'docs/reproduction.md', 'docs/analysis.md', 'docs/rebuild.md', 'evidence/raw-files.json', 'evidence/source-files.json', 'evidence/analysis.json', 'evidence/reconstruction.json'];
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
  writeFileSync(join(output, 'index.html'), renderMiniReport(report, analysis));
}
