// Recover declarative template trees from Skyline render factories without executing them.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const acorn = require('./tools/wxappUnpacker/node_modules/acorn');
const walk = require('./tools/wxappUnpacker/node_modules/acorn-walk');
const xml = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function modernTemplates(original, wanted = () => true) {
  const templates = new Map();
  walk.simple(acorn.parse(original, { ecmaVersion: 'latest' }), {
    CallExpression(node) {
      if (node.callee.type !== 'MemberExpression' || node.callee.property.name !== 'batchAddCompiledTemplate') return;
      const outer = node.arguments[0];
      const returned = outer?.body?.body?.find(statement => statement.type === 'ReturnStatement')?.argument;
      if (returned?.type !== 'ObjectExpression') throw new Error('Unsupported compiled template batch.');
      for (const property of returned.properties) {
        const name = property.key.value || property.key.name;
        if (!wanted(name)) continue;
        if (property.value.type !== 'CallExpression') throw new Error(`Unsupported template factory: ${name}`);
        const container = property.value.callee;
        let factory;
        walk.simple(container, {
          AssignmentExpression(assignment) {
            if (assignment.left.type === 'MemberExpression' && assignment.left.object.name === 'H' && assignment.left.property.value === '') factory = assignment.right;
          }
        });
        if (!factory) throw new Error(`Missing root template factory: ${name}`);
        templates.set(name, renderFactory(factory, original, name));
      }
    }
  });
  return templates;
}

function renderFactory(factory, original, filename) {
  const functions = new Map(), bindings = new Map();
  for (const statement of factory.body.body) if (statement.type === 'VariableDeclaration') {
    for (const declaration of statement.declarations) {
      if (declaration.init?.type === 'ArrowFunctionExpression') functions.set(declaration.id.name, declaration.init);
      else if (declaration.init) bindings.set(declaration.id.name, declaration.init);
    }
  }
  walk.simple(factory.body, {
    AssignmentExpression(node) {
      if (node.left.type === 'Identifier' && !['C', 'U', 'K'].includes(node.left.name)) bindings.set(node.left.name, node.right);
    }
  });
  const returned = factory.body.body.find(statement => statement.type === 'ReturnStatement')?.argument;
  const entry = returned?.properties?.find(property => (property.key.name || property.key.value) === 'C')?.value;
  if (entry?.type !== 'Identifier') throw new Error(`Missing template entry: ${filename}`);

  function expression(node, locals = bindings, seen = new Set()) {
    if (!node) throw new Error('Missing template expression.');
    if (node.type === 'Literal') return JSON.stringify(node.value);
    if (node.type === 'Identifier') {
      if (locals.has(node.name) && !seen.has(node.name) && !['C', 'U', 'K', 'R', 'D'].includes(node.name)) return expression(locals.get(node.name), locals, new Set([...seen, node.name]));
      return node.name;
    }
    if (node.type === 'MemberExpression') {
      if (node.object.name === 'D') return node.computed ? `[${expression(node.property, locals, seen)}]` : node.property.name;
      return `${expression(node.object, locals, seen)}${node.computed ? `[${expression(node.property, locals, seen)}]` : '.' + node.property.name}`;
    }
    if (node.type === 'UnaryExpression') return `${node.operator}(${expression(node.argument, locals, seen)})`;
    if (['BinaryExpression', 'LogicalExpression'].includes(node.type)) {
      const value = node.left.type === 'Identifier' ? locals.get(node.left.name) : null;
      if (node.operator === '===' && node.right.value === 1 && value?.type === 'ConditionalExpression' && value.consequent.value === 1 && value.alternate.value === 0) return expression(value.test, locals, seen);
      return `(${expression(node.left, locals, seen)} ${node.operator} ${expression(node.right, locals, seen)})`;
    }
    if (node.type === 'ConditionalExpression') return `(${expression(node.test, locals, seen)} ? ${expression(node.consequent, locals, seen)} : ${expression(node.alternate, locals, seen)})`;
    if (node.type === 'CallExpression' && ['Y', 'Z'].includes(node.callee.name)) return expression(node.arguments[0], locals, seen);
    throw new Error(`Unsupported template binding: ${node.type}`);
  }
  function value(node, locals) {
    return node.type === 'Literal' ? (typeof node.value === 'string' ? xml(node.value) : `{{${xml(JSON.stringify(node.value))}}}`) : `{{${xml(expression(node, locals))}}}`;
  }
  function attributes(callback) {
    const attrs = new Map(), locals = new Map(bindings);
    if (!callback || callback.type !== 'ArrowFunctionExpression') throw new Error('Unsupported element update callback.');
    walk.simple(callback.body, {
      VariableDeclarator(node) { if (node.init) locals.set(node.id.name, node.init); },
      CallExpression(node) {
        const call = node.callee, args = node.arguments;
        if (call.name === 'L') attrs.set('class', value(args[1], locals));
        else if (call.name === 'O') attrs.set(args[1].value, value(args[2], locals));
        else if (call.type === 'MemberExpression' && call.object.name === 'R') {
          if (call.property.name === 'y') attrs.set('style', value(args[1], locals));
          else if (call.property.name === 'd') attrs.set('data-' + args[1].value, value(args[2], locals));
          else if (call.property.name === 'v') attrs.set(`${args[3].type === 'Literal' && args[3].value ? 'catch' : 'bind'}:${args[1].value}`, value(args[2], locals));
          else throw new Error(`Unsupported element operation: R.${call.property.name}`);
        }
      }
    });
    return [...attrs].map(([name, val]) => ` ${name}="${val}"`).join('');
  }
  const active = new Set();
  function render(name) {
    if (active.has(name)) throw new Error(`Recursive template closure: ${name}`);
    const fn = functions.get(name);
    if (!fn) throw new Error(`Unknown template closure: ${name}`);
    active.add(name);
    const result = statements(fn.body.type === 'BlockStatement' ? fn.body.body : [{ type: 'ExpressionStatement', expression: fn.body }]);
    active.delete(name);
    return result;
  }
  function statements(body) { return body.map(statement).join(''); }
  function statement(node) {
    if (!node) return '';
    if (node.type === 'BlockStatement') return statements(node.body);
    if (node.type === 'VariableDeclaration' || node.type === 'EmptyStatement') return '';
    if (node.type === 'IfStatement') {
      if (node.test.name === 'C') return statement(node.consequent);
      if (node.test.type === 'Identifier' && node.test.name.startsWith('$')) return statement(node.consequent);
      const content = statement(node.consequent), alternate = statement(node.alternate);
      return `<block wx:if="{{${xml(expression(node.test))}}}">${content}</block>${alternate ? `<block wx:else>${alternate}</block>` : ''}`;
    }
    if (node.type !== 'ExpressionStatement') throw new Error(`Unsupported template statement: ${node.type}`);
    const call = node.expression;
    if (call.type === 'AssignmentExpression') return '';
    if (call.type === 'ConditionalExpression' && (call.test.name === 'C' || (call.consequent.callee?.name === 'T' && call.alternate.callee?.name === 'T' && call.alternate.arguments.length === 0))) return statement({ type: 'ExpressionStatement', expression: call.consequent });
    if (call.type !== 'CallExpression') throw new Error(`Unsupported template operation in ${filename}: ${call.type}: ${original.slice(call.start, call.end)}`);
    const args = call.arguments;
    if (call.callee.name === 'E') {
      if (args[0].type !== 'Literal' || args[3].type !== 'Identifier') throw new Error('Unsupported element declaration.');
      const tag = args[0].value;
      return `<${tag}${attributes(args[2])}>${render(args[3].name)}</${tag}>`;
    }
    if (call.callee.name === 'T') return args.length ? value(args[0], bindings) : '';
    if (call.callee.name === 'B') return render(args[1].name);
    if (call.callee.name === 'S') return `<slot${args[0]?.value === '' ? '' : ` name="${value(args[0], bindings)}"`}/>`;
    if (call.callee.name === 'J') return render(args[0].name);
    if (call.callee.type === 'MemberExpression' && call.callee.property.name === 'C') {
      let include;
      const fn = functions.get([...active].at(-1));
      walk.simple(fn.body, { VariableDeclarator(node) { if (node.init?.type === 'MemberExpression' && node.init.object.name === 'G' && node.init.property.type === 'Literal') include = node.init.property.value; } });
      if (!include) throw new Error('Unsupported template include.');
      return `<include src="${xml(relative(dirname(filename), include + '.wxml').split(sep).join('/'))}"/>`;
    }
    throw new Error(`Unsupported template call: ${call.callee.name || call.callee.type}`);
  }
  return render(entry.name) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const root = resolve(process.argv[2]);
    const templates = modernTemplates(readFileSync(process.argv[3], 'utf8'), name => !existsSync(resolve(root, name + '.wxml')));
    for (const [name, content] of templates) {
      const out = resolve(root, name + '.wxml');
      if (name.includes('\\') || !out.startsWith(root + sep)) throw new Error(`Unsafe template path: ${name}`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, content);
    }
    console.log(`Restored ${templates.size} Skyline templates.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
