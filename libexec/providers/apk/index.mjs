import { spawnSync } from 'node:child_process';
import { resolve, dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { maybeOpenReport } from '../workbench/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function chase(options) {
  let python = process.env.GILLII_APK_LAUNCHER_PYTHON || 'python3';
  if (!process.env.GILLII_APK_LAUNCHER_PYTHON) {
    const probe = spawnSync(python, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) {
      if (process.env.GILLII_APK_OFFLINE === '1') throw new Error('APK Python runtime unavailable offline; install Python 3.10+ before retrying.');
      if (process.platform !== 'darwin') throw new Error('APK analysis needs Python 3.10+. Install python3 and retry; mini-program recovery does not require it.');
      console.error('[apk] Preparing Python runtime');
      const install = spawnSync('brew', ['install', 'python@3.13'], { stdio: 'inherit', env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } });
      if (install.error || install.status !== 0) throw new Error('Cannot prepare APK Python runtime; install Python 3.10+ and retry.');
      const prefix = spawnSync('brew', ['--prefix', 'python@3.13'], { encoding: 'utf8' });
      if (prefix.status !== 0) throw new Error('Cannot locate APK Python runtime.');
      python = join(prefix.stdout.trim(), 'bin/python3.13');
    }
  }
  const args = [join(here, 'pipeline.py'), '--input', resolve(options.input)];
  const slug = basename(options.input).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60) || 'application';
  const output = options.output ? resolve(options.output) : resolve(`${slug}-apk-${randomBytes(6).toString('hex')}`);
  args.push('--output', output);
  const result = spawnSync(python, args, { stdio: 'inherit' });
  if (result.error) throw new Error(`Cannot run APK analyzer: ${result.error.message}. Python 3.10+ is required; set GILLII_APK_LAUNCHER_PYTHON if needed.`);
  if (result.signal) throw new Error(`APK analyzer stopped by ${result.signal}; retained output may contain diagnostics.`);
  process.exitCode = result.status ?? 1;
  maybeOpenReport(output);
}


export const apkProvider = { id: 'apk', execute: (command, options) => chase(options) };
