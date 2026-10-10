import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('APK paths dispatch without AppID validation or npm setup, preserving argv and exit status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gillii apk cli '));
  try {
    const python = join(dir, 'python stub');
    writeFileSync(python, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit "${APK_TEST_EXIT:-0}"\n', { mode: 0o755 });
    const env = { ...process.env, XDG_CACHE_HOME: join(dir, 'cache'), GILLII_APK_LAUNCHER_PYTHON: python };
    const input = join(dir, 'input $(do-not-run).apk');
    const output = join(dir, 'new output');
    for (const entry of [['/bin/bash', join(root, 'bin/gillii')], [process.execPath, join(root, 'libexec/gillii.mjs')]]) {
      for (const args of [[input], ['--input', input]]) {
        const result = spawnSync(entry[0], [...entry.slice(1), 'chase', ...args, '--output', output], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /apk\/pipeline\.py\n/);
        assert.ok(result.stdout.endsWith(`--input\n${resolve(input)}\n--output\n${resolve(output)}\n`));
        assert.doesNotMatch(result.stdout, /Preparing dependencies/);
      }
      const partial = spawnSync(entry[0], [...entry.slice(1), 'chase', input], { env: { ...env, APK_TEST_EXIT: '2' }, encoding: 'utf8' });
      assert.equal(partial.status, 2);
      const invalidId = spawnSync(entry[0], [...entry.slice(1), 'chase', '--appid', 'invalid'], { env, encoding: 'utf8' });
      assert.equal(invalidId.status, 1);
      assert.match(invalidId.stderr, /Invalid AppID/);
    }
    const missing = spawnSync('/bin/bash', [join(root, 'bin/gillii'), 'chase', input], { env: { ...env, GILLII_APK_LAUNCHER_PYTHON: join(dir, 'missing') }, encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Python 3.10/);
    const complete = spawnSync('/bin/bash', [join(root, 'bin/gillii'), '__complete', 'chase', './input'], { encoding: 'utf8' });
    assert.equal(complete.stdout, '@paths\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
