#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { providerFor } from './providers/index.mjs';
import { highlight } from './cli-output.mjs';

const usage = `Usage:
  node gillii.mjs list [--appid wx...] [--root <copied-cache-directory>]
  node gillii.mjs clean [--appid wx...] [--root <cache-directory>] [--dry-run]
  node gillii.mjs setup
  node gillii.mjs info <AppID>
  node gillii.mjs chase <AppID|path/to/app.apk>
  node gillii.mjs open

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

function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  const { command, options } = parse(args);
  providerFor(command, options).execute(command, options);
}

if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(highlight(error.message, 31, process.stderr)); process.exitCode = 1; }
}
