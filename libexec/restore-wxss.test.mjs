import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const frame of ['page-frame.html', 'app-wxss.js']) {
  test(`restores string-keyed stylesheets from ${frame} without executing package code`, () => {
    const root = mkdtempSync(join(tmpdir(), 'gillii-wxss-'));
    try {
      const code = `var _C = __COMMON_STYLESHEETS__;
__COMMON_STYLESHEETS__['shared.wxss'] = ['.shared{width:', [0, 12], ';}'];
__wxAppCode__['pages/index.wxss'] = setCssToHead([[2, 'shared.wxss'], '.page{height:', [0, 8], ';}']);
setCssToHead(['page{margin:0;}'])();
require('node:fs').writeFileSync('executed', 'unsafe');`;
      writeFileSync(join(root, frame), frame.endsWith('.html') ? `<script>${code}</script>` : code);
      const script = fileURLToPath(new URL('./restore-wxss.cjs', import.meta.url));
      const result = spawnSync(process.execPath, [script, root], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(join(root, 'shared.wxss'), 'utf8'), /12rpx/);
      assert.match(readFileSync(join(root, 'pages/index.wxss'), 'utf8'), /@import "\.\.\/shared.wxss"/);
      assert.match(readFileSync(join(root, 'pages/index.wxss'), 'utf8'), /8rpx/);
      assert.match(readFileSync(join(root, 'app.wxss'), 'utf8'), /margin: 0/);
      assert.equal(existsSync(join(root, 'executed')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
