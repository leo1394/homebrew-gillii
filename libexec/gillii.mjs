#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, copyFileSync, existsSync, statSync, lstatSync, unlinkSync, realpathSync, constants } from 'node:fs';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decryptPackage, inspectPackage } from './decrypt.mjs';
import { moduleEntries, pluginPrefix } from './restore-js.mjs';
import { finishMiniReport, hash } from './mini-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, 'tools/wxappUnpacker');
const require = createRequire(import.meta.url);
function highlight(text, color, stream = process.stdout) {
  return stream.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' ? `\x1b[1;${color}m${text}\x1b[0m` : text;
}
const usage = `Usage:
  node gillii.mjs list [--appid wx...] [--root <copied-cache-directory>]
  node gillii.mjs clean [--appid wx...] [--root <cache-directory>] [--dry-run]
  node gillii.mjs setup
  node gillii.mjs info <AppID>
  node gillii.mjs chase <AppID|path/to/app.apk>

list: locate packages, sorted by modification time; cannot identify app names.
clean: delete discovered .wxapkg packages; quit WeChat first, then reopen the target.
setup: install pinned npm dependencies with lifecycle scripts disabled.
chase: copy, decrypt, extract, restore and verify one main package.
chase automatically selects the newest main package and creates an output directory.
macOS privacy restrictions: copy the displayed cache folder in Finder, then use --input.
`;

function parse(args) {
  const command = args.shift();
  const options = {};
  if (['chase', 'info'].includes(command) && args.length && !args[0].startsWith('--')) {
    const target = args.shift();
    options[command === 'chase' && (existsSync(target) || /[\\/]|\.apk$/i.test(target)) ? 'input' : 'appid'] = target;
  }
  const allowed = ['list', 'info'].includes(command) ? ['appid', 'root'] : command === 'clean' ? ['appid', 'root', 'dry-run'] : command === 'chase' ? ['appid', 'input', 'output'] : [];
  while (args.length) {
    const name = args.shift();
    if (!name.startsWith('--') || !allowed.includes(name.slice(2))) throw new Error(`Unknown option: ${name}`);
    const key = name.slice(2);
    if (key === 'dry-run') {
      if (options[key]) throw new Error(`Duplicate option: ${name}`);
      options[key] = true; continue;
    }
    const value = args.shift();
    if (!value || value.startsWith('--') || options[key]) throw new Error(`Missing or duplicate option: ${name}`);
    options[key] = value;
  }
  if (options.appid && !/^wx[0-9a-f]{16}$/.test(options.appid)) throw new Error('Invalid AppID.');
  return { command, options };
}

export function findPackages(root, denied = []) {
  const files = [];
  function visit(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (['EACCES', 'EPERM'].includes(error.code)) { denied.push(dir); return; }
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.wxapkg')) {
        const parts = path.split(sep);
        const appid = parts.findLast(part => /^wx[0-9a-f]{16}$/.test(part)) || null;
        files.push({ path, appid, cacheVersion: /^\d+$/.test(basename(dir)) ? basename(dir) : null,
          bytes: statSync(path).size, modified: statSync(path).mtime.toISOString() });
      }
    }
  }
  visit(resolve(root));
  return files.sort((a, b) => b.modified.localeCompare(a.modified));
}

function discover(options, canonical = false) {
  const home = homedir(), denied = [];
  // Scan application cache containers only; symlinks are deliberately not followed.
  let roots = options.root ? [resolve(options.root)] : [
    join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium'),
    join(home, 'Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat'),
    join(home, 'Library/Containers/com.tencent.xinWeChat.MiniProgram/Data'),
    join(home, 'Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat')
  ];
  if (canonical) roots = roots.map(root => {
    try { return realpathSync(root); }
    catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return root; throw error; }
  });
  const packages = roots.flatMap(root => findPackages(root, denied)).filter(file => !options.appid || file.appid === options.appid);
  return { packages, denied, roots };
}

export function cleanPackages(options) {
  // Canonicalize root aliases such as macOS /var before rechecking descendant paths.
  const found = discover(options, true), deleted = [], errors = [];
  found.packages = [...new Map(found.packages.map(file => [file.path, file])).values()];
  if (!options['dry-run']) {
    for (const file of found.packages) {
      try {
        // Recheck each component so a replaced directory cannot redirect deletion through a symlink.
        const parts = resolve(file.path).split(sep);
        let path = sep;
        for (const part of parts.filter(Boolean)) {
          path = join(path, part);
          if (lstatSync(path).isSymbolicLink()) throw new Error('Refusing symlink path.');
        }
        if (!lstatSync(file.path).isFile()) throw new Error('Package is no longer a regular file.');
        unlinkSync(file.path);
        deleted.push(file.path);
      } catch (error) { errors.push({ path: file.path, error: error.message }); }
    }
  }
  return { ...found, dryRun: !!options['dry-run'], deleted, errors };
}

export function extractPackage(data, directory, merge = false) {
  const root = resolve(directory), files = inspectPackage(data), destinations = new Set();
  const entries = files.map(file => {
    const name = file.name.replace(/^\/+/, '');
    const out = resolve(root, name);
    if (!name || name.includes('\\') || !out.startsWith(root + sep) || destinations.has(out)) throw new Error(`Unsafe or duplicate package path: ${file.name}`);
    destinations.add(out);
    return { ...file, out };
  });
  mkdirSync(root, { recursive: true });
  for (const file of entries) {
    mkdirSync(dirname(file.out), { recursive: true });
    const content = data.subarray(file.offset, file.offset + file.size);
    if (merge && existsSync(file.out)) {
      if (!readFileSync(file.out).equals(content)) throw new Error(`Conflicting cached package file: ${file.name}`);
      continue;
    }
    writeFileSync(file.out, content, { flag: 'wx', mode: 0o600 });
  }
  return files;
}

function runNode(script, args, log, report) {
  const started = Date.now();
  if (report) log = join(dirname(log), String(report.commands.length + 1).padStart(3, '0') + '-' + basename(log));
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(log, (result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.message : ''));
  if (report) report.commands.push({ argv: [process.execPath, script, ...args], cwd: process.cwd(), log: log.slice(report.output.length + 1), returncode: result.status, signal: result.signal, error: result.error?.message, durationMs: Date.now() - started });
  if (result.error || result.status !== 0) throw new Error(`Stage failed: ${basename(script)}. See ${log}`);
}

export function restoreCompiledConfigs(root, original, compiled) {
  const acorn = require('./tools/wxappUnpacker/node_modules/acorn');
  const walk = require('./tools/wxappUnpacker/node_modules/acorn-walk');
  function value(node) {
    if (node.type === 'Literal') return node.value;
    if (node.type === 'ArrayExpression') return node.elements.map(value);
    if (node.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(property => {
      if (property.type !== 'Property' || property.computed || property.kind !== 'init') throw new Error('Unsupported config property.');
      return [property.key.name || property.key.value, value(property.value)];
    }));
    if (node.type === 'UnaryExpression' && node.operator === '!') return !value(node.argument);
    if (node.type === 'UnaryExpression' && node.operator === '-') return -value(node.argument);
    throw new Error(`Unsupported config expression: ${node.type}`);
  }
  const configs = new Map();
  walk.ancestor(acorn.parse(original, { ecmaVersion: 'latest' }), {
    AssignmentExpression(node, ancestors) {
      const left = node.left;
      if (left.type === 'MemberExpression' && left.object.name === '__wxAppCode__' && left.computed && left.property.type === 'Literal' && String(left.property.value).endsWith('.json')) {
        const prefix = pluginPrefix(ancestors);
        const name = String(left.property.value).replace(/^\/+/, '');
        configs.set(prefix && !name.startsWith('__plugin__/') ? prefix + name : name, value(node.right));
      }
    }
  });
  const app = { pages: compiled.pages, window: compiled.global?.window };
  for (const key of ['tabBar', 'subPackages', 'permission', 'requiredPrivateInfos', 'renderer', 'componentFramework', 'networkTimeout', 'navigateToMiniProgramAppIdList']) {
    if (compiled[key] !== undefined) app[key] = compiled[key];
  }
  for (const [name, page] of Object.entries(compiled.page || {})) {
    const filename = name.replace(/\.html$/, '.json').replace(/^\/+/, '');
    if (!configs.has(filename)) configs.set(filename, page.window || {});
  }
  if (Array.isArray(compiled.pages)) configs.set('app.json', { ...app, ...configs.get('app.json') });
  else configs.set('plugin.json', compiled);
  for (const [name, data] of configs) {
    const out = resolve(root, name);
    if (!out.startsWith(resolve(root) + sep)) throw new Error(`Unsafe config path: ${name}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(data, null, 4));
  }
}

export function verifyRecovery(root, original, cache = null) {
  const acorn = require('./tools/wxappUnpacker/node_modules/acorn');
  const walk = require('./tools/wxappUnpacker/node_modules/acorn-walk');
  const config = JSON.parse(readFileSync(join(root, existsSync(join(root, 'app.json')) ? 'app.json' : 'plugin.json'), 'utf8'));
  const files = [];
  function visit(dir) { for (const item of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, item.name); item.isDirectory() ? visit(p) : files.push(p);
  } }
  visit(root);
  const modules = moduleEntries(original).map(module => module.name);
  const syntaxFailures = [];
  const javascript = files.filter(file => file.endsWith('.js') && !['app-service.js', 'page-frame.js'].includes(basename(file)));
  for (const file of javascript) try {
    acorn.parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', allowReturnOutsideFunction: true });
  } catch (error) { syntaxFailures.push({ file, error: error.message }); }
  const jsonFailures = [];
  for (const file of files.filter(file => file.endsWith('.json'))) try { JSON.parse(readFileSync(file, 'utf8')); } catch (error) { jsonFailures.push({ file, error: error.message }); }
  const missingModules = modules.filter(name => !existsSync(join(root, name)));
  const pagePaths = Array.isArray(config.pages) ? [...config.pages] : Object.values(config.pages || {});
  for (const group of config.subPackages || []) for (const page of group.pages || []) pagePaths.push(join(group.root, page));
  const declaredPages = [...new Set(pagePaths)];
  const cachedPages = cache ? declaredPages.filter(page => {
    const relative = cache.plugin ? page.replace(new RegExp(`^__plugin__/${cache.appid}/`), '') : page;
    return ['.html', '.json', '.js', '.wxss'].some(extension => existsSync(join(cache.raw, relative + extension))) || modules.includes(page + '.js');
  }) : declaredPages;
  const unavailablePages = declaredPages.filter(page => !cachedPages.includes(page));
  const missingPageFiles = cachedPages.flatMap(page => ['.js', '.json', '.wxml', '.wxss'].filter(ext => !existsSync(join(root, page + ext))).map(ext => page + ext));
  const missingStylesheetImports = [];
  for (const file of files.filter(file => file.endsWith('.wxss'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/@import\s+["']([^"']+)/g)) {
      if (!existsSync(resolve(dirname(file), match[1]))) missingStylesheetImports.push({ file, target: match[1] });
    }
  }
  const emptyPageFiles = cachedPages.flatMap(page => ['.js', '.json', '.wxml'].filter(ext => existsSync(join(root, page + ext)) && statSync(join(root, page + ext)).size === 0).map(ext => page + ext));
  const missingTemplates = [];
  if (cache) {
    function templates(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) templates(file);
        else if (entry.isFile() && file.endsWith('.html') && basename(file) !== 'page-frame.html' && /\$gwx|__wxAppCode__/.test(readFileSync(file, 'utf8'))) {
          const relative = file.slice(resolve(cache.raw).length + 1).replace(/\.html$/, '.wxml');
          const name = cache.plugin ? join('__plugin__', cache.appid, relative) : relative;
          if (!existsSync(join(root, name))) missingTemplates.push(name);
        }
      }
    }
    templates(cache.raw);
  }
  return { pages: cachedPages.length, declaredPages: declaredPages.length, unavailablePages, missingTemplates, modules: modules.length, javascript: javascript.length,
    wxml: files.filter(file => file.endsWith('.wxml')).length, wxss: files.filter(file => file.endsWith('.wxss')).length,
    wxs: files.filter(file => file.endsWith('.wxs')).length, totalFiles: files.length,
    syntaxFailures, jsonFailures, missingModules, missingPageFiles, emptyPageFiles, missingStylesheetImports,
    passed: ![syntaxFailures, jsonFailures, missingModules, missingPageFiles, emptyPageFiles, missingStylesheetImports, missingTemplates].some(list => list.length),
    scope: 'Static completeness and syntax only; runtime/rendering equivalence is unverified.' };
}

function setup() {
  if (!existsSync(join(tool, 'package-lock.json'))) throw new Error('Bundled tool or lockfile missing. Restore tools/wxappUnpacker first.');
  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: tool, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('npm ci failed. Check npm/network availability.');
}

export function selectMainPackage(packages, appid) {
  for (const file of [...packages].sort((a, b) => b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path))) {
    try {
      const bytes = readFileSync(file.path);
      const plaintext = bytes.subarray(0, 6).toString() === 'V1MMWX' ? decryptPackage(bytes, appid) : bytes;
      const names = inspectPackage(plaintext).map(entry => entry.name.replace(/^\/+/, ''));
      if ((names.includes('app-service.js') && names.includes('app-config.json')) || (names.includes('appservice.js') && names.includes('plugin.json'))) return file.path;
    } catch (error) { continue; }
  }
  throw new Error('No readable main package found. Open the target mini-program in WeChat, then retry.');
}

function recover(options) {
  if (!options.appid) throw new Error('Usage: gillii chase <AppID|path/to/app.apk>');
  let input;
  if (options.input) {
    const p = resolve(options.input);
    const candidates = statSync(p).isDirectory() ? findPackages(p).filter(file => !file.appid || file.appid === options.appid) : [{ path: p }];
    input = statSync(p).isDirectory() ? selectMainPackage(candidates, options.appid) : p;
  } else {
    const found = discover(options);
    if (!found.packages.length) throw new Error(`No cached package for ${options.appid}. Open the mini-program in WeChat, then retry. Privacy-blocked paths: ${found.denied.join(', ') || 'none'}`);
    input = selectMainPackage(found.packages, options.appid);
  }
  // Never overwrite previous runs, originals or existing directories.
  const output = options.output ? resolve(options.output) : mkdtempSync(resolve(`${options.appid}-`));
  if (options.output) mkdirSync(output, { recursive: false, mode: 0o700 });
  console.log(`${highlight('Package:', 36)} ${highlight(input, 36)}\n${highlight('Output:', 36)} ${highlight(output, 36)}`);
  const report = { schemaVersion: 2, appid: options.appid, input, output, started: new Date().toISOString(), status: 'in_progress',
    stages: [], commands: [], tools: { node: process.version, executable: process.execPath, dependencyLockSha256: hash(readFileSync(join(tool, 'package-lock.json'))) } };
  let active;
  function step(name) {
    if (active) { active.status = 'complete'; active.durationMs = Date.now() - active.startedMs; }
    active = { name, status: 'running', startedMs: Date.now() };
    report.stages.push(active);
  }
  const reportFile = join(output, 'report.json');
  try {
    step('preserve-and-decrypt');
    const inputCopy = join(output, 'original.wxapkg');
    copyFileSync(input, inputCopy, constants.COPYFILE_EXCL);
    const bytes = readFileSync(inputCopy);
    report.inputSha256 = createHash('sha256').update(bytes).digest('hex');
    report.originalCopySha256 = hash(readFileSync(inputCopy));
    const snapshot = join(output, 'packages', options.appid);
    mkdirSync(snapshot, { recursive: true });
    report.reproductionInput = join(snapshot, basename(input));
    copyFileSync(inputCopy, report.reproductionInput, constants.COPYFILE_EXCL);
    report.reproductionCommand = [process.execPath, fileURLToPath(import.meta.url), 'chase', '--appid', options.appid, '--input', report.reproductionInput];
    const plaintext = bytes.subarray(0, 6).toString() === 'V1MMWX' ? decryptPackage(bytes, options.appid) : bytes;
    report.rawFileCount = inspectPackage(plaintext).length;
    writeFileSync(join(output, `${options.appid}.decrypted.wxapkg`), plaintext, { flag: 'wx', mode: 0o600 });
    const raw = join(output, 'raw'), source = join(output, 'source'), logs = join(output, 'logs');
    mkdirSync(logs);
    const bundles = [{ path: input, retained: report.reproductionInput, originalSha256: hash(bytes), bytes: plaintext, entries: inspectPackage(plaintext) }];
    // Include cached subpackages from exactly the selected version directory.
    for (const file of findPackages(dirname(input)).filter(file => dirname(file.path) === dirname(input) && file.path !== input && (file.appid === options.appid || /^_[^/]*_\.wxapkg$/.test(basename(file.path))))) {
      const copy = join(snapshot, basename(file.path));
      mkdirSync(dirname(copy), { recursive: true });
      copyFileSync(file.path, copy, constants.COPYFILE_EXCL);
      const data = readFileSync(copy);
      const decoded = data.subarray(0, 6).toString() === 'V1MMWX' ? decryptPackage(data, options.appid) : data;
      bundles.push({ path: file.path, retained: copy, originalSha256: hash(data), bytes: decoded, entries: inspectPackage(decoded) });
    }
    report.packages = bundles.map(bundle => ({ path: bundle.path, retained: bundle.retained, originalSha256: bundle.originalSha256, files: bundle.entries.length, sha256: createHash('sha256').update(bundle.bytes).digest('hex') }));
    step('extract');
    for (const bundle of bundles) {
      extractPackage(bundle.bytes, raw, true);
      extractPackage(bundle.bytes, source, true);
    }
    const plugin = existsSync(join(raw, 'appservice.js')) && !existsSync(join(raw, 'app-service.js'));
    report.kind = plugin ? 'plugin' : 'mini-program';
    const service = plugin ? 'appservice.js' : 'app-service.js';
    if (!existsSync(join(raw, service))) throw new Error('No supported application or plugin service script found.');
    step('dependencies');
    if (!existsSync(join(tool, 'node_modules/acorn'))) {
      console.log('Preparing dependencies for first run...');
      const started = Date.now();
      const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
      const result = spawnSync('npm', args, { cwd: tool, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
      writeFileSync(join(logs, 'dependencies.log'), (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''));
      report.commands.push({ argv: ['npm', ...args], cwd: tool, log: 'logs/dependencies.log', returncode: result.status, error: result.error?.message, durationMs: Date.now() - started });
      if (result.error || result.status !== 0) throw new Error('npm ci failed. See logs/dependencies.log.');
    }
    step('javascript');
    const originals = [];
    console.log('Restoring JavaScript, JSON and WXML...');
    for (const [index, bundle] of bundles.entries()) {
      for (const entry of bundle.entries.filter(entry => /(?:^|\/)(?:app-service|appservice)\.js$/.test(entry.name))) {
        const name = entry.name.replace(/^\/+/, '');
        const original = readFileSync(join(raw, name), 'utf8');
        originals.push(original);
        runNode(join(here, 'restore-js.mjs'), [source, join(raw, name)], join(logs, `javascript-${index}.log`), report);
      }
    }
    step('configuration');
    const compiled = JSON.parse(readFileSync(join(raw, plugin ? 'plugin.json' : 'app-config.json'), 'utf8'));
    restoreCompiledConfigs(source, originals.join('\n'), compiled);
    step('templates-and-styles');
    const frames = [...new Set(bundles.flatMap(bundle => bundle.entries.map(entry => entry.name.replace(/^\/+/, '')).filter(name => /(?:^|\/)(?:page-frame\.html|app-wxss\.js|page-frame\.js|pageframe\.js)$/.test(name))))];
    if (!frames.length) throw new Error('No supported page frame found. Raw files preserved.');
    for (const [index, name] of frames.entries()) {
      const frame = join(raw, name);
      if (!readFileSync(frame, 'utf8').includes('setCssToHead') && !readFileSync(frame, 'utf8').includes('var x=')) continue;
      runNode(join(here, 'restore-wxml.cjs'), [source, frame], join(logs, `wxml-${index}.log`), report);
      if (readFileSync(frame, 'utf8').includes('batchAddCompiledTemplate')) runNode(join(here, 'restore-modern-wxml.mjs'), [source, frame], join(logs, `skyline-${index}.log`), report);
      console.log('Restoring WXSS...');
      if (/var\s+_C\s*=\s*__COMMON_STYLESHEETS__/.test(readFileSync(frame, 'utf8'))) {
        runNode(join(here, 'restore-wxss.cjs'), [source, frame], join(logs, `wxss-${index}.log`), report);
      } else {
        const directory = dirname(join(source, name));
        if (plugin) copyFileSync(frame, join(directory, 'app-wxss.js'));
        runNode(join(tool, 'wuWxss.js'), [directory], join(logs, `wxss-${index}.log`), report);
      }
    }
    step('verification');
    report.validation = verifyRecovery(source, originals.join('\n'), { raw, plugin, appid: options.appid });
    report.status = report.validation.passed ? (report.validation.unavailablePages.length ? 'complete_cached' : 'complete') : 'incomplete';
    if (!report.validation.passed) throw new Error(`Static verification failed.\nSource: ${source}\nReport: ${reportFile}\nCached files could not all be restored; see validation details in the report.`);
    active.status = report.validation.unavailablePages.length ? 'partial' : 'complete';
    active.durationMs = Date.now() - active.startedMs;
    active = null;
    if (report.validation.unavailablePages.length) console.error(highlight(`Cached recovery complete. ${report.validation.unavailablePages.length} declared pages are not cached; visit them in WeChat and retry for full coverage.`, 33, process.stderr));
    console.log(`${highlight(`${report.status === 'complete_cached' ? 'Complete (cached)' : 'Complete'}: ${source}`, report.status === 'complete_cached' ? 33 : 32)}\n${report.validation.modules} JS modules, ${report.validation.pages} pages. Report: ${highlight(reportFile, 36)}`);
  } catch (error) {
    if (report.status === 'in_progress') report.status = 'failed';
    report.error = error.message;
    if (active) { active.status = 'failed'; active.error = error.message; active.durationMs = Date.now() - active.startedMs; }
    throw error;
  } finally {
    for (const name of ['preserve-and-decrypt', 'extract', 'dependencies', 'javascript', 'configuration', 'templates-and-styles', 'verification']) {
      if (!report.stages.some(stage => stage.name === name)) report.stages.push({ name, status: 'not_run' });
    }
    try {
      finishMiniReport(output, report);
      console.log('Analysis: ' + join(output, 'index.html'));
    } catch (error) {
      report.reportingError = error.message;
      writeFileSync(reportFile, JSON.stringify(report, null, 2));
      console.error('Report generation failed: ' + error.message);
      process.exitCode = 1;
    }
  }
}

function recoverApk(options) {
  const python = process.env.GILLII_APK_LAUNCHER_PYTHON || 'python3';
  const args = [join(here, 'apk/pipeline.py'), '--input', resolve(options.input)];
  if (options.output) args.push('--output', resolve(options.output));
  const result = spawnSync(python, args, { stdio: 'inherit' });
  if (result.error) throw new Error(`Cannot run APK analyzer: ${result.error.message}. Python 3.10+ is required; set GILLII_APK_LAUNCHER_PYTHON if needed.`);
  if (result.signal) throw new Error(`APK analyzer stopped by ${result.signal}; retained output may contain diagnostics.`);
  process.exitCode = result.status ?? 1;
}

function formatModified(value) {
  const date = new Date(value), pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function packageJson(key, value) {
  return key === 'modified' ? formatModified(value) : value;
}

function printSummary(packages) {
  const latest = new Map();
  for (const file of packages) {
    const key = file.appid || '(unknown)';
    if (!latest.has(key) || file.modified > latest.get(key)) latest.set(key, file.modified);
  }
  console.log('appid               modified');
  for (const [appid, modified] of [...latest].sort((a, b) => Number(a[0] === '(unknown)') - Number(b[0] === '(unknown)') || b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]))) {
    console.log(`${appid.padEnd(19)} ${formatModified(modified)}`);
  }
}

function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  const { command, options } = parse(args);
  if (command === 'list') {
    const found = discover(options);
    printSummary(found.packages);
    if (found.denied.length) console.error('Some cache paths are inaccessible. Grant terminal access in macOS settings.');
  } else if (command === 'info') {
    if (!options.appid) throw new Error('Usage: gillii info <AppID>');
    const found = discover(options);
    console.log(JSON.stringify({ appid: options.appid, ...found }, packageJson, 2));
    if (!found.packages.length) {
      console.error('No cached package found for this AppID.');
      process.exitCode = 1;
    }
  } else if (command === 'clean') {
    const result = cleanPackages(options);
    if (result.dryRun) printSummary(result.packages);
    else console.log(JSON.stringify(result, packageJson, 2));
    if (result.denied.length || result.errors.length) {
      console.error(result.dryRun ? 'Cache preview incomplete. Grant terminal access in macOS settings.' : 'Cache cleanup incomplete. Check denied paths and errors; grant terminal access if needed.');
      process.exitCode = 1;
    }
  } else if (command === 'setup') setup();
  else if (command === 'chase') {
    if (!options.appid && options.input) recoverApk(options);
    else recover(options);
  }
  else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(highlight(error.message, 31, process.stderr)); process.exitCode = 1; }
}
