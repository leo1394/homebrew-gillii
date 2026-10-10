import { accessSync, constants, existsSync, lstatSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const editors = [
  { id: 'vscode', name: 'VS Code', app: 'Visual Studio Code', command: 'code' },
  { id: 'sublime', name: 'Sublime Text', app: 'Sublime Text', command: 'subl' },
  { id: 'android-studio', name: 'Android Studio', app: 'Android Studio', command: 'studio' },
  { id: 'cursor', name: 'Cursor', app: 'Cursor', command: 'cursor' },
  { id: 'antigravity', name: 'Antigravity', app: 'Antigravity', command: 'antigravity' },
];

async function executable(editor) {
  if (process.platform === 'darwin') {
    try { await run('/usr/bin/open', ['-Ra', editor.app], { timeout: 3000 }); return '/usr/bin/open'; }
    catch { return null; }
  }
  if (process.platform !== 'linux') return null;
  const commands = editor.id === 'android-studio' ? ['studio', 'android-studio', 'studio.sh'] : [editor.command];
  const paths = (process.env.PATH || '').split(delimiter).filter(Boolean).flatMap(base => commands.map(command => join(base, command)));
  if (editor.id === 'android-studio') paths.push('/opt/android-studio/bin/studio.sh');
  for (const path of paths) {
    try { if (lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) { accessSync(path, constants.X_OK); return path; } }
    catch { /* Try the next PATH entry. */ }
  }
  return null;
}

export async function availableEditors() {
  return Promise.all(editors.map(async editor => ({ id: editor.id, name: editor.name, available: Boolean(await executable(editor)) })));
}

export function projectDirectory(root) {
  const source = join(root, 'source');
  return existsSync(source) && lstatSync(source).isDirectory() && !lstatSync(source).isSymbolicLink() ? source : root;
}

export async function openProject(id, root) {
  const editor = editors.find(item => item.id === id);
  if (!editor) throw new Error('unknown editor');
  const command = await executable(editor);
  if (!command) throw new Error('editor unavailable');
  const directory = projectDirectory(root);
  if (process.platform === 'darwin') await run(command, ['-a', editor.app, directory], { timeout: 5000 });
  else await new Promise((accept, reject) => {
    const child = spawn(command, [directory], {detached:true, stdio:'ignore'});
    child.once('error', reject); child.once('spawn', () => { child.unref(); accept(); });
  });
}
