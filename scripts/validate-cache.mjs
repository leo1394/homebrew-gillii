#!/usr/bin/env node
// Run actual cached packages through the public CLI and retain per-AppID evidence.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findPackages } from '../libexec/gillii.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!process.argv[2]) { console.error('Usage: node scripts/validate-cache.mjs <copied-cache-directory> [new-results-directory]'); process.exit(1); }
const cache = resolve(process.argv[2]), output = resolve(process.argv[3] || 'runs-validation');
mkdirSync(output, { recursive: false });
const files = findPackages(cache), appids = [...new Set(files.map(file => file.appid).filter(Boolean))].sort();
const results = [];
for (const appid of appids) {
  const directory = join(output, appid);
  const input = existsSync(join(cache, appid)) && statSync(join(cache, appid)).isDirectory() ? join(cache, appid) : cache;
  const result = spawnSync(join(root, 'bin/gillii'), ['chase', appid, '--input', input, '--output', directory], { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(join(output, appid + '.log'), (result.stdout || '') + (result.stderr || ''));
  const report = existsSync(join(directory, 'report.json')) ? JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) : {};
  const row = { appid, exitCode: result.status, status: report.status || 'failed', packages: report.packages?.length || 0, validation: report.validation || null, error: report.error || result.error?.message || (result.status ? result.stderr : null) };
  results.push(row);
  console.log(`${appid} ${row.status}`);
  writeFileSync(join(output, 'summary.json'), JSON.stringify(results, null, 2));
}
console.log(`Validated ${results.length} AppIDs. Report: ${join(output, 'summary.json')}`);
process.exitCode = results.length && results.every(result => result.exitCode === 0 && result.validation?.passed) ? 0 : 1;
