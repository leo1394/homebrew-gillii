import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const literal = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
const key = node => node?.computed ? literal(node.property) : node?.property?.name;
const functionNode = node => /^(FunctionExpression|FunctionDeclaration|ArrowFunctionExpression)$/.test(node?.type);
const cleanUrl = value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : null; } catch { return null; } };

export function analyzeRelationships(source, files, result, unavailablePages = []) {
  const nodes = [], edges = [], gaps = [], ids = new Set(), nodeById = new Map(), paths = new Set(files.map(file => file.path));
  const add = (kind, label, file, line = 1, evidence = 'local-observed', suffix = '') => {
    const id = kind + ':' + file + ':' + line + ':' + label + suffix;
    if (nodes.length >= 20000 && !ids.has(id)) { if (!result.errors.some(item => item.stage === 'resource-limit')) { result.errors.push({ stage: 'resource-limit', error: 'Static graph limit reached; relationships are partial.' }); gaps.push({ kind: 'resource-limit', file, line, detail: 'Graph truncated at 20000 nodes or 50000 edges.', evidence: 'unverified' }); } return null; }
    if (!ids.has(id)) { ids.add(id); const node = { id, kind, label, file, line, evidence }; nodes.push(node); nodeById.set(id, node); }
    return id;
  };
  const edge = (from, to, kind, file, line = 1, evidence = 'static-inferred') => { if (!from || !to) return; if (edges.length >= 50000) { if (!result.errors.some(item => item.stage === 'resource-limit')) { result.errors.push({ stage: 'resource-limit', error: 'Static graph limit reached; relationships are partial.' }); gaps.push({ kind: 'resource-limit', file, line, detail: 'Graph truncated at 50000 edges.', evidence: 'unverified' }); } return; } edges.push({ from, to, kind, file, line, evidence }); };
  const gap = (kind, file, line, detail) => gaps.push({ kind, file, line, detail, evidence: 'unverified' });
  const modules = new Map(files.map(file => [file.path, add('module', file.path, file.path)]));
  const resolve = (file, target, extensions) => {
    if (typeof target !== 'string' || /:\/\//.test(target) || (!target.startsWith('.') && !target.startsWith('/'))) return null;
    const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(file), target));
    if (path.startsWith('../')) return null;
    return [path, ...extensions.map(ext => path + ext)].find(path => paths.has(path)) || null;
  };
  const pagePaths = [...result.pages.filter(page => typeof page === 'string')];
  for (const pkg of Array.isArray(result.subPackages) ? result.subPackages : []) {
    if (pkg && typeof pkg.root === 'string' && Array.isArray(pkg.pages)) for (const page of pkg.pages) if (typeof page === 'string') pagePaths.push(posix.join(pkg.root, page));
  }
  const pages = new Map();
  for (const page of pagePaths) {
    const id = add('page', page, result.config || 'app.json'); pages.set(page, id);
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) if (modules.has(page + ext)) edge(id, modules.get(page + ext), 'page-file', result.config || 'app.json');
    if (unavailablePages.includes(page) || !paths.has(page + '.js')) gap('uncached-page', result.config || 'app.json', 1, page);
  }
  for (const item of result.components) {
    const owner = modules.get(item.file), target = resolve(item.file, item.target, ['.js', '/index.js']);
    const id = add('component', item.name, item.file);
    edge(owner, id, 'declares-component', item.file, 1, 'local-observed');
    if (target) edge(id, modules.get(target), 'component-module', item.file);
    else gap('unresolved-component', item.file, 1, String(item.target));
  }
  let acorn;
  try { acorn = require('./tools/wxappUnpacker/node_modules/acorn'); }
  catch { result.errors.push({ stage: 'javascript-analysis', error: 'Parser dependency unavailable; API and URL analysis not performed.' }); }
  const handlers = new Map();
  result.evidenceClasses = { 'local-observed': 'Present in recovered local files; not runtime observation.', 'static-inferred': 'Relationship inferred from supported static syntax.', unverified: 'Requires additional source or runtime evidence.' };
  result.excerpts = {};
  let excerptBytes = 0;
  for (const file of files.filter(file => file.path.endsWith('.js') && !/(?:^|\/)(?:app-service|appservice|page-frame|pageframe|app-wxss)\.js$/.test(file.path))) {
    if (!acorn) break;
    try {
      if (file.bytes > 4 * 1024 * 1024) throw new Error('Static analysis file limit reached (4 MiB).');
      const code = readFileSync(join(source, file.path), 'utf8');
      let tree;
      try { tree = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
      catch { tree = acorn.parse(code, { ecmaVersion: 'latest', allowReturnOutsideFunction: true, locations: true }); }
      // Bindings are collected before calls are inspected, including hoisted declarations.
      const scopes = new WeakMap(), owners = new WeakMap(), functions = new WeakMap();
      const makeScope = (parent, isFunction = false) => ({ parent, isFunction, bindings: new Map() });
      const bind = (pattern, scope, value = null) => {
        if (!pattern) return;
        if (pattern.type === 'Identifier') scope.bindings.set(pattern.name, scope.bindings.has(pattern.name) ? null : value);
        else if (pattern.type === 'RestElement') bind(pattern.argument, scope);
        else if (pattern.type === 'AssignmentPattern') bind(pattern.left, scope);
        else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(item => bind(item, scope));
        else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(item => bind(item.value || item.argument, scope));
      };
      const children = node => Object.entries(node).filter(([name]) => !['loc', 'start', 'end'].includes(name)).flatMap(([, value]) => Array.isArray(value) ? value.filter(item => item?.type) : value?.type ? [value] : []);
      function collect(node, scope, owner, parent) {
        if (node.type === 'FunctionDeclaration') bind(node.id, scope, node);
        if (functionNode(node)) {
          const label = node.id?.name || (parent?.type === 'Property' && !parent.computed ? parent.key.name || parent.key.value : parent?.type === 'VariableDeclarator' ? parent.id.name : null) || '(callback)';
          owner = add('function', String(label), file.path, node.loc.start.line, 'local-observed', ':' + node.start); functions.set(node, owner);
          const record = nodeById.get(owner);
          if (record) { record.column = node.loc.start.column; record.endLine = node.loc.end.line; record.endColumn = node.loc.end.column; record.start = node.start; record.end = node.end;
            record.parameters = node.params.map(param => param.type === 'Identifier' ? param.name : param.type === 'RestElement' && param.argument.type === 'Identifier' ? '...' + param.argument.name : null); }
          edge(modules.get(file.path), owner, 'defines-function', file.path, node.loc.start.line, 'local-observed');
          scope = makeScope(scope, true); bind(node.id, scope, node); node.params.forEach(param => bind(param, scope));
        } else if (['BlockStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'ClassExpression'].includes(node.type)) scope = makeScope(scope);
        scopes.set(node, scope); owners.set(node, owner);
        if (node.type === 'VariableDeclaration') for (const decl of node.declarations) { let destination = scope; if (node.kind === 'var') while (destination.parent && !destination.isFunction) destination = destination.parent; bind(decl.id, destination, functionNode(decl.init) ? decl.init : null); }
        if (node.type === 'ImportDeclaration') node.specifiers.forEach(spec => bind(spec.local, scope));
        if (node.type === 'ClassDeclaration') bind(node.id, scope);
        if (node.type === 'ClassExpression') bind(node.id, scope);
        if (node.type === 'CatchClause') bind(node.param, scope);
        children(node).forEach(child => collect(child, scope, owner, node));
      }
      collect(tree, makeScope(null, true), modules.get(file.path), null);
      const lookup = (scope, name) => { for (; scope; scope = scope.parent) if (scope.bindings.has(name)) return { found: true, value: scope.bindings.get(name) }; return { found: false }; };
      function invalidateWrites(node) {
        if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression' || node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
          const target = node.left || node.argument;
          const invalidate = target => {
            if (target.type === 'Identifier') for (let scope = scopes.get(node); scope; scope = scope.parent) if (scope.bindings.has(target.name)) { scope.bindings.set(target.name, null); break; }
            if (target.type === 'ObjectPattern') target.properties.forEach(prop => invalidate(prop.value || prop.argument));
            if (target.type === 'ArrayPattern') target.elements.filter(Boolean).forEach(invalidate);
            if (target.type === 'AssignmentPattern') invalidate(target.left);
            if (target.type === 'RestElement') invalidate(target.argument);
          }; invalidate(target);
        }
        children(node).forEach(invalidateWrites);
      }
      invalidateWrites(tree);
      let registrationCount = 0;
      const mutatedMethods = new Set();
      const fileHandlers = new Map(), thisOwners = new WeakMap(), pendingThis = [];
      function ownThis(node, id, root = true) {
        if (root && node.type === 'ArrowFunctionExpression') return;
        if (!root && functionNode(node) && node.type !== 'ArrowFunctionExpression') return;
        thisOwners.set(node, id); children(node).forEach(child => ownThis(child, id, false));
      }
      function inspect(node) {
        const line = node.loc.start.line, owner = owners.get(node), scope = scopes.get(node);
        if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && node.left.object.type === 'ThisExpression') mutatedMethods.add(key(node.left));
        if (node.type === 'Literal' && typeof node.value === 'string' && /^https?:\/\//i.test(node.value)) {
          const url = cleanUrl(node.value); if (url) result.urls.push({ url, file: file.path, line });
        }
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
          const value = literal(node.source), target = resolve(file.path, value, ['.js', '/index.js']);
          if (target) edge(owner, modules.get(target), 'imports', file.path, line);
          else gap('unresolved-import', file.path, line, value || 'Dynamic import target');
        }
        if (node.type === 'CallExpression') {
          const callee = node.callee;
          if (callee.type === 'MemberExpression' && callee.object.type === 'ThisExpression') pendingThis.push({ node, owner, method: key(callee) });
          if (callee.type === 'Identifier' && ['Page', 'Component'].includes(callee.name) && !lookup(scope, callee.name).found && node.arguments[0]?.type === 'ObjectExpression') {
            registrationCount++;
            if (callee.name === 'Page') {
              const state = node.arguments[0].properties.filter(prop => prop.type === 'Property' && !prop.computed && (prop.key.name || prop.key.value) === 'data' && prop.value.type === 'ObjectExpression');
              if (state.length === 1 && state[0].value.properties.every(prop => prop.type === 'Property' && !prop.computed && ['Identifier', 'Literal'].includes(prop.key.type))) {
                const keys = state[0].value.properties.map(prop => String(prop.key.name ?? prop.key.value));
                const page = nodes.find(item => item.kind === 'page' && item.label === file.path.replace(/\.js$/, ''));
                if (page) { page.initialStateKeys = keys.slice(0, 200); page.initialStateLocation = { file: file.path, line: state[0].loc.start.line, column: state[0].loc.start.column }; }
              }
            }
            const register = (object, callable, componentRoot = false) => { for (const prop of object.properties) {
              if (prop.type !== 'Property' || prop.computed) { mutatedMethods.add(null); continue; }
              const name = prop.key.name || prop.key.value;
              if (callable && fileHandlers.has(name)) fileHandlers.set(name, null);
              if (functionNode(prop.value)) {
                if (callable) fileHandlers.set(name, fileHandlers.has(name) ? null : functions.get(prop.value));
                ownThis(prop.value, functions.get(prop.value));
                edge(modules.get(file.path), functions.get(prop.value), 'registers-handler', file.path, prop.loc.start.line);
              } else if (componentRoot && ['methods', 'lifetimes', 'pageLifetimes'].includes(name) && prop.value.type === 'ObjectExpression') register(prop.value, name === 'methods');
            } }; register(node.arguments[0], callee.name === 'Page', callee.name === 'Component');
          }
          if (callee.type === 'Identifier' && callee.name === 'require' && !lookup(scope, 'require').found) {
            const value = literal(node.arguments[0]), target = resolve(file.path, value, ['.js', '/index.js']);
            if (target) edge(owner, modules.get(target), 'requires', file.path, line);
            else gap('unresolved-import', file.path, line, value || 'Dynamic require target');
          } else if (callee.type === 'Identifier') {
            const binding = lookup(scope, callee.name);
            if (binding.value && functions.has(binding.value)) edge(owner, functions.get(binding.value), 'calls', file.path, line);
          }
          if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && ['wx', 'uni', 'tt'].includes(callee.object.name) && !lookup(scope, callee.object.name).found) {
            const method = key(callee);
            if (!method) gap('dynamic-api', file.path, line, callee.object.name + '[expression]');
            else {
              const api = callee.object.name + '.' + method;
              result.apis.push({ api, file: file.path, line });
              const id = add('api', api, file.path, line, 'local-observed', ':' + node.start); edge(owner, id, 'calls-api', file.path, line);
              if (['request', 'uploadFile', 'downloadFile', 'connectSocket', 'navigateTo', 'redirectTo', 'switchTab', 'reLaunch'].includes(method)) {
                let property = null;
                if (node.arguments[0]?.type === 'ObjectExpression') for (const prop of node.arguments[0].properties) {
                  if (prop.type !== 'Property' || prop.computed) property = null;
                  else if ((prop.key.name || prop.key.value) === 'url') property = prop.kind === 'init' ? prop : null;
                }
                const value = literal(property?.value), navigation = !['request', 'uploadFile', 'downloadFile', 'connectSocket'].includes(method);
                const target = value && (navigation ? value.split(/[?#]/)[0] : cleanUrl(value));
                if (target) {
                  const route = navigation ? posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(file.path), target)) : null;
                  const targetId = navigation && pages.get(route) || add(navigation ? 'navigation-target' : 'endpoint', target, file.path, line, 'unverified');
                  edge(id, targetId, navigation ? 'navigation-target' : 'request-target', file.path, line);
                  if (navigation && !pages.has(route)) gap('unresolved-navigation', file.path, line, target);
                } else gap('dynamic-target', file.path, line, api + ' URL is not a supported literal');
              }
            }
          }
        }
        children(node).forEach(inspect);
      }
      inspect(tree);
      if (registrationCount !== 1) { const page = nodes.find(item => item.kind === 'page' && item.label === file.path.replace(/\.js$/, '')); if (page) { delete page.initialStateKeys; delete page.initialStateLocation; } }
      for (const call of pendingThis) {
        const target = fileHandlers.get(call.method);
        if (registrationCount === 1 && thisOwners.has(call.node) && target && !mutatedMethods.has(call.method) && !mutatedMethods.has(null)) edge(call.owner, target, 'calls-method', file.path, call.node.loc.start.line);
        else gap('unresolved-method', file.path, call.node.loc.start.line, call.method || 'Dynamic this method');
      }
      const lines = code.split('\n');
      for (const node of nodes.filter(node => node.file === file.path)) {
        if (excerptBytes >= 1024 * 1024) break;
        const start = Math.max(0, node.line - 2);
        result.excerpts[file.path + ':' + node.line] = lines.slice(start, start + 5).map((line, index) => (start + index + 1) + '  ' + line.slice(0, 500).replace(/https?:\/\/[^\s\"'`<>]+/gi, value => cleanUrl(value) || '[URL redacted]')).join('\n');
        excerptBytes += result.excerpts[file.path + ':' + node.line].length;
      }
      handlers.set(file.path.replace(/\.js$/, ''), registrationCount === 1 && !mutatedMethods.has(null) ? fileHandlers : new Map());
    } catch (error) { result.errors.push({ file: file.path, error: error.message }); gap(/analysis .*limit reached/i.test(error.message) ? 'resource-limit' : 'parse-error', file.path, error.loc?.line || 1, error.message); }
  }
  for (const file of files.filter(file => file.path.endsWith('.wxml'))) {
    if (file.bytes > 4 * 1024 * 1024) { gap('resource-limit', file.path, 1, 'WXML exceeds 4 MiB analysis limit.'); result.errors.push({ file: file.path, error: 'WXML analysis limit reached.' }); continue; }
    const text = readFileSync(join(source, file.path), 'utf8').replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ' '));
    const base = file.path.replace(/\.wxml$/, ''), owner = pages.get(base) || modules.get(file.path);
    const declarations = new Map(result.components.filter(item => item.file === 'app.json').map(item => [item.name, item]));
    for (const item of result.components.filter(item => item.file === base + '.json')) declarations.set(item.name, item);
    for (const match of text.matchAll(/<([\w-]+)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
      const line = text.slice(0, match.index).split('\n').length, item = declarations.get(match[1]);
      if (item) edge(owner, add('component', item.name, item.file), 'uses-component', file.path, line);
      if (['include', 'import', 'template'].includes(match[1])) gap('template-expansion', file.path, line, 'Template/include expansion is not resolved.');
    }
    for (const tag of text.matchAll(/<[\w-]+\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
      const attributes = tag[0].slice(tag[0].match(/^<[\w-]+/)[0].length);
      for (const attribute of attributes.matchAll(/([^\s=<>]+)\s*=\s*(["'])(.*?)\2/g)) {
        if (!/^(?:capture-)?(?:bind|catch):?[\w-]+$/.test(attribute[1])) continue;
        const line = text.slice(0, tag.index + tag[0].indexOf(attributes) + attribute.index).split('\n').length, name = attribute[3];
        const id = add('event', attribute[1] + ' → ' + name, file.path, line, 'local-observed', ':' + tag.index + ':' + attribute.index); edge(owner, id, 'binds-event', file.path, line, 'local-observed');
        const handler = handlers.get(base)?.get(name);
        if (handler) edge(id, handler, 'event-handler', file.path, line);
        else gap('unresolved-handler', file.path, line, name);
      }
    }
  }
  result.relationships = { nodes, edges };
  result.gaps = gaps;
  result.limitations = ['Source excerpts show up to five lines of 500 characters each, with a 1 MiB overall excerpt budget. Source files above 4 MiB are not parsed.','Local-observed means recovered file evidence, never observed runtime execution.', 'Static-inferred relationships do not prove reachability, event dispatch or successful network access.', 'Only direct lexical functions, literal module paths and simple WXML event bindings are linked. Aliases, template expansion and dynamic dispatch require review.', 'Nested callbacks own their calls; they are not attributed to enclosing handlers. Import/export symbol flow is not resolved.', 'No recovered code is executed and no business endpoint is contacted. Runtime behavior and backend implementation remain unverified.'];
  for (const error of result.errors) if (!gaps.some(item => item.file === error.file && ['parse-error', 'resource-limit'].includes(item.kind))) gap('analysis-error', error.file || 'app.json', 1, error.error);
  result.nextSteps = gaps.map(item => ({ priority: item.kind === 'uncached-page' ? 1 : 2, action: item.kind === 'uncached-page' ? 'Open this page in the authorized app, refresh the local cache and recover again.' : 'Inspect this source location and resolve the missing or dynamic reference with runtime evidence.', ...item }));
  const counts = new Map();
  for (const edge of edges) if (['calls-api', 'requires', 'imports', 'calls', 'calls-method'].includes(edge.kind)) counts.set(edge.from, (counts.get(edge.from) || 0) + 1);
  const importance = nodes.filter(node => node.kind === 'function').map(node => ({ ...node, count: counts.get(node.id) || 0 })).filter(node => node.count).sort((a, b) => b.count - a.count).slice(0, 10);
  for (const node of importance) result.nextSteps.push({ priority: 3, kind: 'important-function', file: node.file, line: node.line, detail: node.label, evidence: 'unverified', action: 'Review this function and verify its trigger, inputs and effects in an authorized runtime session.' });
  result.nextSteps.push({ priority: 3, kind: 'runtime-evidence', evidence: 'unverified', action: 'Record the exact page, user action, application version and observed result. Correlate authorized runtime traces with static locations; do not infer backend behavior from URL strings.' });
  result.nextSteps.sort((a, b) => a.priority - b.priority);
  return result;
}
