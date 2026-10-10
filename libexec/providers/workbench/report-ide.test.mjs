import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editors, projectDirectory, openProject } from './report-ide.mjs';

test('project selection uses mini source directory, APK output root, and rejects linked source', () => {
  const root = mkdtempSync(join(tmpdir(), 'gillii-ide-project-'));
  try {
    assert.equal(projectDirectory(root), root);
    mkdirSync(join(root, 'source')); assert.equal(projectDirectory(root), join(root, 'source'));
    rmSync(join(root, 'source'), {recursive:true}); symlinkSync(tmpdir(), join(root, 'source'));
    assert.equal(projectDirectory(root), root);
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('only the five named editors can be requested', async () => {
  assert.deepEqual(editors.map(editor => editor.name), ['VS Code', 'Sublime Text', 'Android Studio', 'Cursor', 'Antigravity']);
  await assert.rejects(openProject('sh', tmpdir()), /unknown editor/);
});
