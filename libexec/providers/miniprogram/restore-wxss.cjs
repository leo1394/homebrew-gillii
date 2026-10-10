// Restore the newer string-keyed stylesheet format without running package code.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('./tools/wxappUnpacker/node_modules/acorn');
const walk = require('./tools/wxappUnpacker/node_modules/acorn-walk');
const beautify = require('./tools/wxappUnpacker/node_modules/cssbeautify');

const root = path.resolve(process.argv[2]);
const frame = process.argv[3] || ['page-frame.html', 'app-wxss.js'].map(name => path.join(root, name)).find(fs.existsSync);
if (!frame) throw new Error('No supported page frame found.');
const code = fs.readFileSync(frame, 'utf8');
const scripts = frame.endsWith('.html') ? [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]) : [code];
const common = new Map();
const styles = new Map();

function literal(node) {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value;
  if (node.type === 'ArrayExpression') return node.elements.filter(Boolean).map(literal);
  throw new Error(`Unsupported stylesheet expression: ${node.type}`);
}

for (const source of scripts) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', allowReturnOutsideFunction: true });
  walk.simple(ast, {
    AssignmentExpression(node) {
      const left = node.left;
      if (left.type !== 'MemberExpression' || !left.computed || left.property.type !== 'Literal') return;
      if (left.object.name === '__COMMON_STYLESHEETS__') {
        common.set(left.property.value, literal(node.right));
      }
      if (left.object.name === '__wxAppCode__' && String(left.property.value).endsWith('.wxss')) {
        if (node.right.type !== 'CallExpression' || node.right.callee.name !== 'setCssToHead') return;
        styles.set(left.property.value, literal(node.right.arguments[0]));
      }
    },
    ExpressionStatement(node) {
      const outer = node.expression;
      if (outer.type !== 'CallExpression' || outer.callee.type !== 'CallExpression') return;
      if (outer.callee.callee.name === 'setCssToHead') {
        styles.set('app.wxss', literal(outer.callee.arguments[0]));
      }
    }
  });
}

function outputPath(name) {
  name = name.replace(/^plugin-private:\/\/(wx[0-9a-f]{16})\//, '__plugin__/$1/');
  const out = path.resolve(root, name.replace(/^(?:\.\/|\/)+/, ''));
  if (!out.startsWith(root + path.sep)) throw new Error(`Unsafe stylesheet path: ${name}`);
  return out;
}

function render(data, filename) {
  if (typeof data === 'string') {
    if (!common.has(data)) throw new Error(`Missing shared stylesheet: ${data}`);
    data = common.get(data);
  }
  return data.map(part => {
    if (typeof part === 'string') return part;
    if (part[0] === 0) return `${part[1]}rpx`;
    if (part[0] === 1) return '';
    if (part[0] === 2) {
      const target = outputPath(part[1]);
      return `@import "${path.relative(path.dirname(outputPath(filename)), target).split(path.sep).join('/')}";\n`;
    }
    throw new Error(`Unsupported stylesheet token: ${JSON.stringify(part)}`);
  }).join('');
}

const rendered = [];
for (const [name, data] of new Map([...common, ...styles])) {
  rendered.push([outputPath(name), beautify(render(data, name), { indent: '    ', autosemicolon: true })]);
}
for (const [out, css] of rendered) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, css);
}
console.log(`Restored ${rendered.length} WXSS files (${common.size} shared, ${styles.size} app/page/component).`);
