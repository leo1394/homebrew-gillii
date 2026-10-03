// Isolate each compiled template closure before passing it to the legacy WXML decoder.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const acorn = require('./tools/wxappUnpacker/node_modules/acorn');
const walk = require('./tools/wxappUnpacker/node_modules/acorn-walk');
const root = path.resolve(process.argv[2]), frame = process.argv[3];
const text = fs.readFileSync(frame, 'utf8');
const scripts = frame.endsWith('.html') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]) : [text];
let count = 0;
for (const script of scripts) {
  const closures = [];
  walk.ancestor(acorn.parse(script, { ecmaVersion: 'latest', allowReturnOutsideFunction: true }), {
    FunctionExpression(node, ancestors) {
      if (node.params[0]?.name !== 'path' || node.body.type !== 'BlockStatement') return;
      if (node.body.body.some(statement => statement.type === 'VariableDeclaration' && statement.declarations.some(declaration => ['x', 'nv_require'].includes(declaration.id.name)))) {
        const assignment = ancestors.findLast(parent => parent.type === 'AssignmentExpression' && /^\$gwx_wx[0-9a-f]{16}$/.test(parent.left.name || ''));
        closures.push({ node, prefix: assignment ? `__plugin__/${assignment.left.name.slice(5)}` : '' });
      }
    }
  });
  for (const { node: closure, prefix } of closures) {
    const directory = path.join(root, prefix);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.gillii-frame-${count++}.js`);
    let code = script.slice(closure.start, closure.end).replace(/\$gwx_wx[0-9a-f]{16}/g, '$gwx').replace(/(\$gwx\d*)_XC_\d+/g, '$1').replace(/plugin-private:\/\/(wx[0-9a-f]{16})\//g, '__plugin__/$1/');
    if (!/var\s+nv_require\s*=/.test(code)) {
      code = code.replace(/var\s+x\s*=/, '\nvar nv_require=function(){var nnm={};return function(){}}()\nvar x=');
    }
    fs.writeFileSync(temporary, `var $gwx = ${code};`);
    try {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'tools/wxappUnpacker/wuWxml.js'), temporary], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      if (result.error || result.status !== 0 || /error on |Decompile failed/i.test(result.stdout || '')) throw new Error('WXML closure restoration failed.');
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
console.log(`Restored ${count} compiled template closures.`);
