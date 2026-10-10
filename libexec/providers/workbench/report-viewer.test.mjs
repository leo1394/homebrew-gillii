import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { startReportServer, maybeOpenReport, rememberReport, latestReport } from './report-viewer.mjs';

function get(url, options = {}) {
  return new Promise((accept, reject) => {
    const req = request(url, options, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', part => { body += part; });
      response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject); req.end(options.body);
  });
}

test('viewer isolates report, rejects traversal and symlinks, and renders recovered content as text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-viewer-'));
  const report = join(root, 'report'); mkdirSync(report); mkdirSync(join(report, 'source'));
  writeFileSync(join(root, 'secret'), 'private');
  writeFileSync(join(report, 'index.html'), '<h1>Report</h1>');
  writeFileSync(join(report, 'source', 'evil.html'), '<script>throw new Error("never execute")</script>');
  writeFileSync(join(report, 'payload.apk'), Buffer.from([0, 1, 2]));
  symlinkSync(join(root, 'secret'), join(report, 'link'));
  symlinkSync(root, join(report, 'escape'));
  const viewer = await startReportServer(report);
  try {
    const index = await get(viewer.url);
    assert.equal(index.status, 200); assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.headers['content-security-policy'], /script-src 'none'/);
    const source = await get(viewer.url + 'source/evil.html');
    assert.match(source.headers['content-type'], /text\/plain/); assert.equal(source.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(viewer.url + 'payload.apk')).headers['content-disposition'], 'attachment');
    for (const path of ['%2e%2e/secret', 'source%2f..%2f..%2fsecret', '%2fetc/passwd', 'link', 'escape/secret', 'source/', 'source%5cevil.html', '%00', '%ZZ']) {
      const result = await get(viewer.url, { path: new URL(viewer.url).pathname + path });
      assert.equal(result.status, 404, path); assert.ok(!result.body.includes('private'));
    }
    assert.equal((await get(viewer.url, { headers: { host: 'attacker.example' } })).status, 404);
    assert.equal((await get(viewer.url, { method: 'POST' })).status, 404);
    assert.equal((await get(new URL('/', viewer.url))).status, 404);
  } finally { viewer.close(); rmSync(root, { recursive: true, force: true }); }
});

test('viewer expires and closes its listener', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-expiry-'));
  const viewer = await startReportServer(root, { idleMs: 30, lifetimeMs: 100 });
  await new Promise(accept => viewer.server.once('close', accept));
  assert.equal(viewer.server.listening, false);
  rmSync(root, { recursive: true, force: true });
});

test('noninteractive viewer call is a no-op and standalone worker does not leak', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-no-tty-'));
  writeFileSync(join(root, 'index.html'), 'Report');
  assert.equal(maybeOpenReport(root), undefined);
  rmSync(root, { recursive: true, force: true });
  const child = spawnSync(process.execPath, [new URL('./report-viewer.mjs', import.meta.url).pathname, '--serve', tmpdir()], { timeout: 2000, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.error, undefined);
});

test('hard deadline closes viewer even while requests keep it active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-deadline-'));
  writeFileSync(join(root, 'index.html'), 'Report');
  const viewer = await startReportServer(root, { idleMs: 1000, lifetimeMs: 80 });
  const traffic = setInterval(() => { get(viewer.url).catch(() => {}); }, 10);
  await new Promise(accept => viewer.server.once('close', accept));
  clearInterval(traffic);
  assert.equal(viewer.server.listening, false);
  rmSync(root, { recursive: true, force: true });
});

test('interactive opt-out does not launch a viewer', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-optout-'));
  writeFileSync(join(root, 'index.html'), 'Report');
  const module = new URL('./report-viewer.mjs', import.meta.url).href;
  const code = `import { maybeOpenReport } from ${JSON.stringify(module)}; process.stdin.isTTY = true; process.stdout.isTTY = true; maybeOpenReport(${JSON.stringify(root)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 2000, encoding: 'utf8', env: { ...process.env, GILLII_REPORT_OPEN: '0' } });
  rmSync(root, { recursive: true, force: true });
  assert.equal(child.status, 0); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
});


test('IDE launch requires same origin, action header and fixed editor; client cannot supply paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-ide-')), opened = [];
  const viewer = await startReportServer(root, {
    listEditors: async () => [{id:'cursor', name:'Cursor', available:true}],
    launchEditor: async (editor, directory) => { opened.push([editor, directory]); }
  });
  const origin = new URL(viewer.url).origin;
  const headers = {origin, 'content-type':'application/json', 'x-gillii-action':'open-project'};
  const post = (editor, overrides = {}) => get(viewer.url + '__ide', {method:'POST', headers, body:JSON.stringify({editor, path:'/tmp/untrusted'}), ...overrides});
  try {
    assert.equal((await get(viewer.url + '__ide')).status, 200);
    assert.deepEqual(opened, []);
    assert.equal((await post('cursor', {headers:{...headers, origin:'https://attacker.example'}})).status, 404);
    assert.equal((await post('cursor', {headers:{origin, 'content-type':'application/json'}})).status, 404);
    assert.equal((await post('sh')).status, 404);
    assert.equal((await post('cursor')).status, 200);
    assert.deepEqual(opened, [['cursor', realpathSync(root)]]);
    assert.equal((await post('vscode', {body:'x'.repeat(1025)})).status, 404);
  } finally { viewer.close(); rmSync(root, {recursive:true, force:true}); }
});


test('recent workbench survives command runs and reports missing results clearly', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-recent-'));
  try {
    const state = join(root, 'state', 'recent.json'), first = join(root, 'first'), last = join(root, 'last');
    assert.throws(() => latestReport(state), /Run gillii chase first/);
    for (const directory of [first, last]) {
      mkdirSync(directory); writeFileSync(join(directory, 'index.html'), '<!doctype html>'); writeFileSync(join(directory, 'report.json'), '{}');
      rememberReport(directory, state);
      assert.equal(latestReport(state), realpathSync(directory));
    }
    rmSync(last, {recursive:true});
    assert.throws(() => latestReport(state), /moved or deleted/);
    assert.throws(() => rememberReport(last, state));
  } finally { rmSync(root, {recursive:true,force:true}); }
});
