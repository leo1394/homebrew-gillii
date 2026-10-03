import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPackages, extractPackage, restoreCompiledConfigs, verifyRecovery } from './gillii.mjs';

function packageFor(name) {
  const filename = Buffer.from(name), body = Buffer.from('example');
  const header = Buffer.alloc(14), index = Buffer.alloc(16 + filename.length);
  header[0] = 0xbe; header[13] = 0xed;
  header.writeUInt32BE(index.length, 5); header.writeUInt32BE(body.length, 9);
  index.writeUInt32BE(1); index.writeUInt32BE(filename.length, 4); filename.copy(index, 8);
  index.writeUInt32BE(14 + index.length, 8 + filename.length);
  index.writeUInt32BE(body.length, 12 + filename.length);
  return Buffer.concat([header, index, body]);
}

test('finds AppID/version packages without following symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'gillii-find-'));
  const directory = join(root, 'wxc879ed7b2efd35e3', '53');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '__APP__.wxapkg'), 'test');
  symlinkSync(root, join(root, 'loop'));
  const files = findPackages(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].appid, 'wxc879ed7b2efd35e3');
  assert.equal(files[0].cacheVersion, '53');
});

test('extracts exact content and refuses to overwrite it', () => {
  const root = mkdtempSync(join(tmpdir(), 'gillii-extract-'));
  const data = packageFor('/pages/index.js');
  extractPackage(data, root);
  assert.equal(readFileSync(join(root, 'pages/index.js'), 'utf8'), 'example');
  assert.throws(() => extractPackage(data, root), /EEXIST/);
});

test('rejects traversal before writing files', () => {
  const base = mkdtempSync(join(tmpdir(), 'gillii-path-'));
  assert.throws(() => extractPackage(packageFor('/../escape.js'), join(base, 'raw')), /Unsafe/);
  assert.equal(existsSync(join(base, 'escape.js')), false);
  assert.equal(existsSync(join(base, 'raw')), false);
});

test('CLI rejects unknown options and incomplete chase arguments', () => {
  const cli = fileURLToPath(new URL('./gillii.mjs', import.meta.url));
  for (const args of [['chase', '--force'], ['chase', '--appid', 'wxc879ed7b2efd35e3']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option|No cached package/);
  }
});


test('restores app config without losing permission/components or racing writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'gillii-config-'));
  writeFileSync(join(root, 'app.json'), '{broken concurrent output');
  const code = `__wxAppCode__['app.json'] = {"pages":["pages/main"],"usingComponents":{"container":"/components/container"},"requiredPrivateInfos":["getLocation"]};`;
  restoreCompiledConfigs(root, code, { pages: ['pages/main'], permission: { 'scope.userLocation': { desc: 'Location' } } });
  const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
  assert.equal(app.usingComponents.container, '/components/container');
  assert.equal(app.permission['scope.userLocation'].desc, 'Location');
  assert.deepEqual(app.requiredPrivateInfos, ['getLocation']);
  assert.throws(() => restoreCompiledConfigs(root, `__wxAppCode__['../escape.json'] = {};`, { pages: [] }), /Unsafe/);
});


test('keeps uncached declared pages separate from missing cached output', () => {
  const root = mkdtempSync(join(tmpdir(), 'gillii-coverage-'));
  const source = join(root, 'source'), raw = join(root, 'raw');
  mkdirSync(source); mkdirSync(raw);
  writeFileSync(join(source, 'app.json'), JSON.stringify({ pages: ['cached', 'unavailable'], subPackages: [] }));
  writeFileSync(join(raw, 'cached.html'), '<script>$gwx("cached.wxml")</script>');
  writeFileSync(join(source, 'cached.js'), 'Page({});');
  writeFileSync(join(source, 'cached.json'), '{}');
  writeFileSync(join(source, 'cached.wxss'), '');
  const options = { raw, plugin: false };
  let result = verifyRecovery(source, `define('cached.js', function() {});`, options);
  assert.equal(result.passed, false);
  assert.deepEqual(result.unavailablePages, ['unavailable']);
  assert.deepEqual(result.missingTemplates, ['cached.wxml']);
  writeFileSync(join(source, 'cached.wxml'), '<view/>');
  result = verifyRecovery(source, `define('cached.js', function() {});`, options);
  assert.equal(result.passed, true);
  assert.equal(result.pages, 1);
  assert.equal(result.declaredPages, 2);
});

test('merges identical cached files but refuses conflicting subpackage contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'gillii-merge-'));
  const data = packageFor('/pages/index.js');
  extractPackage(data, root);
  extractPackage(data, root, true);
  writeFileSync(join(root, 'pages/index.js'), 'different');
  assert.throws(() => extractPackage(data, root, true), /Conflicting/);
});
