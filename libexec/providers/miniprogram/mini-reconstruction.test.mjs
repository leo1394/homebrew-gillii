import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { analyzeMiniProgram, inventory } from './mini-report.mjs';
import { deriveReconstruction } from './mini-reconstruction.mjs';

function fixture(files, run, unavailable = []) {
  const root = mkdtempSync(join(tmpdir(), 'mini-rebuild-'));
  try {
    for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
    run(analyzeMiniProgram(root, inventory(root), unavailable));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('page and event traces terminate across cycles and page navigation', () => {
  fixture({ 'app.json': '{"pages":["home","other"]}', 'home.js': "import './shared'; Page({data:{count:0},tap(value){this.load(value)},load(x){wx.navigateTo({url:'/other'})}});", 'home.wxml': '<button bindtap="tap"/>', 'other.js': 'Page({})', 'shared.js': "import './home'" }, result => {
    const graph = result.relationships, model = result.reconstruction;
    const page = model.features.find(feature => feature.label === 'home');
    const event = model.features.find(feature => graph.nodes.find(node => node.id === feature.entryId)?.kind === 'event');
    assert.ok(page && event);
    assert.ok(page.nodeIds.length < 30);
    const destination = graph.nodes.find(node => node.kind === 'page' && node.label === 'other');
    assert.ok(page.nodeIds.includes(destination.id));
    assert.ok(page.edgeIndexes.some(index => graph.edges[index].to === destination.id && graph.edges[index].kind === 'navigation-target'));
    assert.ok(!page.nodeIds.includes(graph.nodes.find(node => node.kind === 'module' && node.file === 'other.js').id));
    assert.ok(event.nodeIds.some(id => graph.nodes.find(node => node.id === id)?.label === 'load'));
    assert.equal(page.truncated, false);
    const tap = graph.nodes.find(node => node.kind === 'function' && node.label === 'tap');
    assert.deepEqual([tap.line, tap.column, tap.endLine, tap.endColumn, tap.start, tap.end, tap.parameters], [1, 43, 1, 68, 43, 68, ['value']]);
    const home = graph.nodes.find(node => node.kind === 'page' && node.label === 'home');
    assert.deepEqual(home.initialStateKeys, ['count']);
    assert.deepEqual(home.initialStateLocation, { file: 'home.js', line: 1, column: 25 });
    const configModule = graph.nodes.find(node => node.kind === 'module' && node.file === 'app.json');
    assert.ok(!model.layers.find(layer => layer.id === 'page:home').nodeIds.includes(configModule.id));
  });
});

test('shared dependencies and unavailable pages remain explicit', () => {
  fixture({ 'app.json': '{"pages":["a","b","missing"]}', 'a.js': "import './shared';Page({tap(){}})", 'a.wxml': '<view bindtap="tap"/>', 'b.js': "import './shared';Page({})", 'shared.js': 'export const value = 1;' }, result => {
    const model = result.reconstruction;
    assert.ok(model.layers.find(layer => layer.id === 'shared')?.nodeIds.length);
    assert.ok(!model.features.find(feature => feature.label === 'a')?.gaps.some(gap => gap.kind === 'uncached-page'));
    const event = model.features.find(feature => result.relationships.nodes.find(node => node.id === feature.entryId)?.kind === 'event');
    assert.ok(event && !event.gaps.some(gap => gap.kind === 'uncached-page'));
    assert.ok(model.features.find(feature => feature.label === 'missing')?.gaps.some(gap => gap.kind === 'uncached-page'));
    assert.ok(model.files.every(file => file.sha256 && file.bytes >= 0 && file.kind));
    assert.ok(model.suggestedTargetBoundaries.length);
  }, ['missing']);
});

test('large feature slices are capped and marked truncated', () => {
  const nodes = [{ id: 'page', kind: 'page', label: 'home', file: 'app.json', line: 1 }];
  const edges = [];
  for (let index = 0; index < 400; index++) { nodes.push({ id: 'n' + index, kind: 'function', label: 'f' + index, file: 'home.js', line: 1 }); edges.push({ from: index ? 'n' + (index - 1) : 'page', to: 'n' + index, kind: 'calls' }); }
  const result = deriveReconstruction({ relationships: { nodes, edges }, gaps: [] });
  assert.equal(result.features[0].nodeIds.length, result.limits.maxNodesPerFeature);
  assert.equal(result.features[0].truncated, true);
});
