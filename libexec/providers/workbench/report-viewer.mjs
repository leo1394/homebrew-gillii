import { createServer } from 'node:http';
import { openSync, closeSync, fstatSync, readFileSync, realpathSync, lstatSync, constants, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, sep, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { availableEditors, openProject } from './report-ide.mjs';

const idleLifetime = 10 * 60 * 1000, maximumLifetime = 60 * 60 * 1000;

export async function startReportServer(directory, { idleMs = idleLifetime, lifetimeMs = maximumLifetime, listEditors = availableEditors, launchEditor = openProject } = {}) {
  const root = realpathSync(directory), token = randomBytes(24).toString('hex');
  let idle, deadline, port;
  const close = () => { clearTimeout(idle); clearTimeout(deadline); server.close(); server.closeAllConnections(); };
  const refresh = () => { clearTimeout(idle); idle = setTimeout(close, idleMs); };
  const server = createServer(async (request, response) => {
    let fd;
    try {
      if (request.headers.host !== `127.0.0.1:${port}` || !['GET', 'HEAD', 'POST'].includes(request.method)) throw new Error('denied');
      const raw = (request.url || '').split('?')[0];
      if (!raw.startsWith(`/${token}/`)) throw new Error('denied');
      const relative = decodeURIComponent(raw.slice(token.length + 2)) || 'index.html';
      if (relative === '__ide') {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'GET') { refresh(); response.end(JSON.stringify(await listEditors())); return; }
        if (request.method !== 'POST' || request.headers.origin !== `http://127.0.0.1:${port}` || request.headers['x-gillii-action'] !== 'open-project' || request.headers['content-type'] !== 'application/json') throw new Error('denied');
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error('denied'); }
        const { editor } = JSON.parse(body);
        if (!['vscode', 'sublime', 'android-studio', 'cursor', 'antigravity'].includes(editor)) throw new Error('denied');
        try { await launchEditor(editor, root); refresh(); response.end(JSON.stringify({ opened: true })); }
        catch { response.writeHead(409); response.end(JSON.stringify({ opened: false })); }
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new Error('denied');
      const segments = relative.split('/');
      if (segments.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) throw new Error('denied');
      let path = root;
      for (const part of segments) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) throw new Error('denied'); }
      if (!realpathSync(path).startsWith(root + sep)) throw new Error('denied');
      const expected = lstatSync(path);
      if (!expected.isFile()) throw new Error('denied');
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (stat.dev !== expected.dev || stat.ino !== expected.ino || !stat.isFile() || stat.size > (relative === 'evidence/dart-functions.json' ? 128 : 32) * 1024 * 1024) throw new Error('denied');
      const body = readFileSync(fd), index = relative === 'index.html';
      const text = index || ['.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.html', '.xml', '.wxml', '.wxss', '.css', '.java', '.kt', '.cs', '.dart', '.smali', '.log', '.yaml', '.yml', '.py', '.ts', '.jsx', '.tsx'].includes(extname(path).toLowerCase());
      // Only generated report HTML is rendered. Recovered HTML/JS is inert text.
      const hashes = index ? [...body.toString('utf8').matchAll(/'sha256-[A-Za-z0-9+/=]+'/g)].map(match => match[0]) : [];
      response.setHeader('Content-Type', index ? 'text/html; charset=utf-8' : text ? 'text/plain; charset=utf-8' : 'application/octet-stream');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src ${hashes.length ? hashes.join(' ') : "'none'"}; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cache-Control', 'no-store');
      if (!text) response.setHeader('Content-Disposition', 'attachment');
      response.setHeader('Content-Length', body.length);
      refresh();
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
      response.end('Not found');
    } finally { if (fd !== undefined) closeSync(fd); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  port = server.address().port;
  refresh(); deadline = setTimeout(close, lifetimeMs);
  server.once('close', () => { clearTimeout(idle); clearTimeout(deadline); });
  return { server, close, url: `http://127.0.0.1:${port}/${token}/` };
}

function recentReportFile() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'gillii', 'recent-report.json');
}

export function rememberReport(directory, stateFile = recentReportFile()) {
  const root = realpathSync(directory);
  if (!lstatSync(join(root, 'index.html')).isFile() || !lstatSync(join(root, 'report.json')).isFile()) throw new Error('Report is unavailable.');
  mkdirSync(resolve(stateFile, '..'), { recursive: true, mode: 0o700 });
  const temporary = stateFile + '.' + randomBytes(8).toString('hex');
  writeFileSync(temporary, JSON.stringify({ directory: root }), { mode: 0o600 });
  renameSync(temporary, stateFile);
}

export function latestReport(stateFile = recentReportFile()) {
  let directory;
  try { directory = JSON.parse(readFileSync(stateFile, 'utf8')).directory; }
  catch { throw new Error('No recent workbench recorded. Run gillii chase first.'); }
  if (typeof directory !== 'string' || !existsSync(join(directory, 'index.html')) || !existsSync(join(directory, 'report.json'))) throw new Error('The recent workbench was moved or deleted. Run gillii chase again.');
  return directory;
}

export function maybeOpenReport(directory, { force = false, remember = true } = {}) {
  if (remember && existsSync(join(directory, 'index.html')) && existsSync(join(directory, 'report.json'))) {
    try { rememberReport(directory); }
    catch { console.error('Could not record the recent workbench.'); }
  }
  if ((!force && (!process.stdin.isTTY || !process.stdout.isTTY || process.env.GILLII_REPORT_OPEN === '0')) || !existsSync(join(directory, 'index.html'))) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', resolve(directory)], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let ready = false;
  const timeout = setTimeout(() => { child.kill(); console.error('Local report viewer could not start; open the retained index.html.'); }, 3000);
  child.once('error', () => { clearTimeout(timeout); console.error('Local report viewer unavailable; open the retained index.html.'); });
  child.once('exit', () => clearTimeout(timeout));
  child.once('message', message => {
    if (ready || typeof message?.url !== 'string') return;
    ready = true; clearTimeout(timeout); child.disconnect(); child.unref();
    console.log(`Local report: ${message.url}\nViewer stops after 10 minutes idle or 1 hour. Offline report: ${join(directory, 'index.html')}`);
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? null : 'xdg-open';
    if (command) {
      const opener = spawn(command, [message.url], { detached: true, stdio: 'ignore' });
      opener.once('error', () => console.error('Open the local report URL in your browser.'));
      opener.unref();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.argv[2] === '--serve') {
  try {
    const viewer = await startReportServer(process.argv[3]);
    // An orphaned startup must not survive a parent that never receives readiness.
    const handshake = setTimeout(() => { viewer.close(); process.disconnect?.(); }, 4000);
    process.once('disconnect', () => clearTimeout(handshake));
    if (process.send) process.send({ url: viewer.url });
    else { clearTimeout(handshake); viewer.close(); }
  } catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
}
