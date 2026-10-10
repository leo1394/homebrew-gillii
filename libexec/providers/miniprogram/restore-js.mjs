import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);

export function pluginPrefix(ancestors) {
  const plugin = ancestors.findLast(node => node.type === 'CallExpression' && node.callee.name === 'definePlugin');
  const id = plugin?.arguments[0]?.value;
  return typeof id === 'string' && /^plugin:\/\/wx[0-9a-f]{16}$/.test(id) ? `__plugin__/${id.slice(9)}/` : '';
}

export function moduleEntries(original) {
  const acorn = require('./tools/wxappUnpacker/node_modules/acorn');
  const walk = require('./tools/wxappUnpacker/node_modules/acorn-walk');
  const modules = [];
  walk.ancestor(acorn.parse(original, { ecmaVersion: 'latest' }), {
    CallExpression(node, ancestors) {
      if (node.callee.name !== 'define' || node.arguments[0]?.type !== 'Literal') return;
      if (ancestors.slice(0, -1).some(parent => parent.type === 'CallExpression' && parent.callee.name === 'define')) return;
      const factory = node.arguments[1];
      if (!['FunctionExpression', 'ArrowFunctionExpression'].includes(factory?.type) || factory.body.type !== 'BlockStatement') throw new Error('Unsupported module factory.');
      let name = node.arguments[0].value;
      if (typeof name !== 'string') throw new Error('Invalid module name.');
      const prefix = pluginPrefix(ancestors);
      if (prefix && !name.startsWith('__plugin__/')) name = prefix + name.replace(/^\/+/, '');
      modules.push({ name, code: original.slice(factory.body.start + 1, factory.body.end - 1) });
    }
  });
  return modules;
}

export function restoreJavaScript(root, original) {
  const beautify = require('./tools/wxappUnpacker/node_modules/js-beautify').js;
  const modules = moduleEntries(original), outputs = new Map();
  for (const module of modules) {
    const out = resolve(root, module.name.replace(/^\/+/, ''));
    if (module.name.includes('\\') || !out.startsWith(resolve(root) + sep) || outputs.has(out)) throw new Error(`Unsafe or duplicate module path: ${module.name}`);
    outputs.set(out, beautify(module.code, { indent_size: 4 }) + '\n');
  }
  for (const [out, code] of outputs) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, code);
  }
  return modules.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { console.log(`Restored ${restoreJavaScript(process.argv[2], readFileSync(process.argv[3], 'utf8'))} JavaScript modules.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
