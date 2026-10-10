import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inventory, analyzeMiniProgram, finishMiniReport } from './mini-report.mjs';
const cli = fileURLToPath(new URL('../../gillii.mjs', import.meta.url));
const appid = 'wx0123456789abcdef';

function bundle(files) {
  const entries = Object.entries(files).map(([name, body]) => [Buffer.from(name), Buffer.from(body)]);
  const size = 4 + entries.reduce((sum, [name]) => sum + 12 + name.length, 0);
  const header = Buffer.alloc(14), index = Buffer.alloc(size);
  header[0] = 0xbe; header[13] = 0xed; header.writeUInt32BE(size, 5);
  header.writeUInt32BE(entries.reduce((sum, [, body]) => sum + body.length, 0), 9);
  index.writeUInt32BE(entries.length); let cursor = 4, offset = 14 + size;
  for (const [name, body] of entries) {
    index.writeUInt32BE(name.length, cursor); cursor += 4; name.copy(index, cursor); cursor += name.length;
    index.writeUInt32BE(offset, cursor); index.writeUInt32BE(body.length, cursor + 4); cursor += 8; offset += body.length;
  }
  return Buffer.concat([header, index, ...entries.map(([, body]) => body)]);
}

test('analysis records static API evidence and sanitized URL literals without evaluating code', () => {
  const root = mkdtempSync(join(tmpdir(), 'mini-analysis-'));
  try {
    writeFileSync(join(root, 'app.json'), JSON.stringify({ appName: '皇爷拉新平台', pages: ['home'], permission: { location: {} }, usingComponents: { card: '/card' } }));
    writeFileSync(join(root, 'app.js'), `// wx.fake();\nconst text='wx.notACall()'; wx.request({url:'https://user:secret@example.com/api?token=secret#private'}); wx['getLocation'](); throw new Error('never run');`);
    symlinkSync(root, join(root, 'loop'));
    const files = inventory(root), result = analyzeMiniProgram(root, files);
    assert.equal(files.length, 2);
    assert.equal(result.appName, '皇爷拉新平台');
    assert.deepEqual(result.apiCounts, { 'wx.getLocation': 1, 'wx.request': 1 });
    assert.deepEqual(result.domains, ['example.com']);
    assert.equal(result.urls[0].url, 'https://example.com/api');
    assert.equal(result.apis[0].line, 2);
    assert.equal(result.components[0].name, 'card');
    assert.deepEqual(result.errors, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fresh failed report escapes package text and retains evidence and reproduction links', () => {
  const root = mkdtempSync(join(tmpdir(), 'mini-report-'));
  try {
    const report = { appid, input: '</pre><script>alert(1)</script>', started: new Date().toISOString(), status: 'failed', error: '<img src=x onerror=alert(1)>', stages: [], commands: [], reproductionCommand: ['node', "a'$(touch not-run)\n```sh"] };
    finishMiniReport(root, report);
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    assert.ok(html.includes('href="docs/reproduction.md"'));
    assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(!html.includes('<script>') && !html.includes('<img'));
    assert.equal(report.coverage.status, 'failed');
    assert.equal(report.sourceRoot, join(root, 'source'));
    assert.equal(report.analysis.status, 'partial');
    assert.ok(existsSync(join(root, 'evidence/source-files.json')));
    assert.ok(existsSync(join(root, 'evidence/reconstruction.json')));
    assert.match(readFileSync(join(root, 'docs/rebuild.md'), 'utf8'), /Migration checklist/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI reports cached coverage, selected package snapshots and repeatable recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'mini e2e '));
  try {
    const cache = join(root, appid); mkdirSync(cache);
    const input = join(cache, 'main.wxapkg'), output = join(root, 'result');
    writeFileSync(input, bundle({
      'app-service.js': `define('app.js',function(){App({});});define('home.js',function(){wx.request({url:'https://example.com/api'});Page({});});`,
      'app-config.json': JSON.stringify({ pages: ['home', 'uncached'], page: { 'home.html': { window: {} } } }),
      'home.wxml': '<view/>', 'home.wxss': '', 'home.json': '{}', 'page-frame.html': '<!-- already preserved template -->'
    }));
    writeFileSync(join(cache, 'sub.wxapkg'), bundle({ 'sub/data.json': '{"value":1}' }));
    const run = spawnSync(process.execPath, [cli, 'chase', appid, '--input', input, '--output', output], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(root, 'state') } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const report = JSON.parse(readFileSync(join(output, 'report.json')));
    assert.equal(report.status, 'complete_cached');
    assert.equal(JSON.parse(readFileSync(join(root, 'state/gillii/recent-report.json'))).directory, realpathSync(output));
    assert.equal(report.coverage.status, 'partial');
    assert.deepEqual(report.coverage.uncachedPages, ['uncached']);
    assert.equal(report.packages.length, 2);
    assert.equal(report.inputSha256, report.originalCopySha256);
    assert.ok(report.packages.every(item => existsSync(item.retained)));
    assert.equal(report.analysis.directApiCalls, 1);
    assert.ok(report.commands.every(command => command.returncode === 0 && existsSync(join(output, command.log))));
    assert.equal(report.stages.find(stage => stage.name === 'verification').status, 'partial');
    const replay = join(root, 'replay');
    const second = spawnSync(report.reproductionCommand[0], [...report.reproductionCommand.slice(1), '--output', replay], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(root, 'state') } });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const again = JSON.parse(readFileSync(join(replay, 'report.json')));
    assert.deepEqual(again.packages.map(item => item.originalSha256), report.packages.map(item => item.originalSha256));
    assert.deepEqual(JSON.parse(readFileSync(join(replay, 'evidence/source-files.json'))), JSON.parse(readFileSync(join(output, 'evidence/source-files.json'))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid package still produces a failed offline report and does not overwrite output', () => {
  const root = mkdtempSync(join(tmpdir(), 'mini-bad-'));
  try {
    const input = join(root, 'bad.wxapkg'), output = join(root, 'result');
    writeFileSync(input, 'invalid');
    const run = spawnSync(process.execPath, [cli, 'chase', appid, '--input', input, '--output', output], { encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: join(root, 'state') } });
    assert.equal(run.status, 1);
    const bytes = readFileSync(join(output, 'report.json'));
    const report = JSON.parse(bytes);
    assert.equal(report.status, 'failed');
    assert.equal(report.stages[0].status, 'failed');
    assert.ok(report.stages.some(stage => stage.status === 'not_run'));
    assert.ok(existsSync(join(output, 'index.html')));
    assert.equal(readFileSync(join(output, 'original.wxapkg'), 'utf8'), 'invalid');
    assert.equal(spawnSync(process.execPath, [cli, 'chase', appid, '--input', input, '--output', output]).status, 1);
    assert.deepEqual(readFileSync(join(output, 'report.json')), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dependency preparation failure preserves raw evidence and marks subsequent stages not run', () => {
  const root = mkdtempSync(join(tmpdir(), 'mini-deps-'));
  try {
    const tools = join(root, 'libexec/providers/miniprogram/tools/wxappUnpacker'); mkdirSync(tools, { recursive: true });
    for (const name of ['gillii.mjs', 'cli-output.mjs', 'providers/index.mjs', 'providers/workbench/index.mjs', 'providers/apk/index.mjs', 'providers/miniprogram/index.mjs', 'providers/miniprogram/decrypt.mjs', 'providers/miniprogram/restore-js.mjs', 'providers/miniprogram/mini-report.mjs', 'providers/miniprogram/mini-analysis.mjs', 'providers/miniprogram/mini-reconstruction.mjs', 'providers/miniprogram/mini-report-ui.mjs', 'providers/workbench/report-language.js', 'providers/workbench/report-controls.css', 'providers/workbench/report-viewer.mjs', 'providers/workbench/report-ide.mjs', 'providers/workbench/report-workbench.css', 'providers/workbench/report-source-tools.js', 'providers/workbench/report-blueprint.js']) {
      mkdirSync(join(root, 'libexec', name, '..'), { recursive: true });
      writeFileSync(join(root, 'libexec', name), readFileSync(fileURLToPath(new URL('../../' + name, import.meta.url))));
    }
    writeFileSync(join(tools, 'package-lock.json'), '{}');
    const mock = join(root, 'bin'); mkdirSync(mock);
    writeFileSync(join(mock, 'npm'), '#!/bin/sh\necho deliberate-install-failure >&2\nexit 9\n', { mode: 0o755 });
    const input = join(root, 'main.wxapkg'), output = join(root, 'result');
    writeFileSync(input, bundle({ 'app-service.js': '', 'app-config.json': '{"pages":[]}', 'page-frame.html': '' }));
    const run = spawnSync(process.execPath, [join(root, 'libexec/gillii.mjs'), 'chase', appid, '--input', input, '--output', output], { encoding: 'utf8', env: { ...process.env, PATH: mock, XDG_STATE_HOME: join(root, 'state') } });
    assert.equal(run.status, 1);
    const report = JSON.parse(readFileSync(join(output, 'report.json')));
    assert.equal(report.stages.find(stage => stage.name === 'dependencies').status, 'failed');
    assert.equal(report.stages.find(stage => stage.name === 'javascript').status, 'not_run');
    assert.equal(report.commands[0].returncode, 9);
    assert.match(readFileSync(join(output, report.commands[0].log), 'utf8'), /deliberate-install-failure/);
    assert.ok(existsSync(join(output, 'raw/app-service.js')));
    assert.ok(existsSync(join(output, 'index.html')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
