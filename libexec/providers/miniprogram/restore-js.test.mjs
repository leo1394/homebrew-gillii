import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleEntries, restoreJavaScript } from './restore-js.mjs';

test('extracts nested plugin modules without executing code or mistaking nested AMD for application modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'gillii-js-'));
  try {
    const code = `definePlugin('plugin://wx0123456789abcdef', function(define) {
      define('common.js', function(require, module) { module.exports = { ok: true }; });
    });
    define('app.js', function(require, module) {
      if (typeof define === 'function') define('innerAMD', [], function() { return 1; });
      module.exports = () => ({ ok: true });
    });
    require('node:fs').writeFileSync('executed', 'unsafe');`;
    assert.deepEqual(moduleEntries(code).map(entry => entry.name), ['__plugin__/wx0123456789abcdef/common.js', 'app.js']);
    assert.equal(restoreJavaScript(root, code), 2);
    assert.match(readFileSync(join(root, 'app.js'), 'utf8'), /innerAMD/);
    assert.match(readFileSync(join(root, '__plugin__/wx0123456789abcdef/common.js'), 'utf8'), /module.exports/);
    assert.equal(existsSync(join(root, 'executed')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects module traversal and duplicate output paths before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'gillii-js-path-'));
  try {
    assert.throws(() => restoreJavaScript(root, `define('ok.js', function() {}); define('../escape.js', function() {});`), /Unsafe/);
    assert.equal(existsSync(join(root, 'ok.js')), false);
    assert.throws(() => restoreJavaScript(root, `define('app.js', function() {}); define('app.js', function() {});`), /duplicate/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
