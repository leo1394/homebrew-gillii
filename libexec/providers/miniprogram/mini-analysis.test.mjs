import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { analyzeMiniProgram, inventory } from './mini-report.mjs';
function fixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'mini-deep-'));
  try { for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); } run(analyzeMiniProgram(root, inventory(root), ['uncached'])); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
test('page events connect same-instance methods, imports, APIs and components with provenance', () => {
  fixture({ 'app.json': JSON.stringify({ pages: ['home', 'next', 'uncached'], subPackages: [null], usingComponents: { card: '/card' } }), 'card.js': 'Component({})', 'helper.js': 'export const value = 1;', 'home.wxml': '<card bind:tap="onTap"/>', 'home.js': `import {value} from './helper';\nPage({onTap(){this.load(); (() => this.load())(); function nested(){this.load(); wx.getLocation()}},load(){wx.request({url:'https://user:secret@example.com/api?token=private'});wx.navigateTo({url:'/next?x=1'})}});`, 'next.js': 'Page({})' }, result => {
    assert.deepEqual(result.errors, []);
    const { nodes, edges } = result.relationships;
    assert.equal(edges.filter(edge => edge.kind === 'calls-method').length, 2);
    for (const kind of ['event-handler', 'uses-component', 'imports', 'request-target', 'navigation-target']) assert.ok(edges.some(edge => edge.kind === kind), kind);
    assert.ok(nodes.every(node => node.file && node.line && node.evidence));
    const location = nodes.find(node => node.label === 'wx.getLocation'), nested = nodes.find(node => node.label === 'nested');
    assert.ok(edges.some(edge => edge.from === nested.id && edge.to === location.id));
    assert.ok(result.gaps.some(gap => gap.kind === 'uncached-page' && gap.detail === 'uncached'));
    assert.ok(!JSON.stringify(result).includes('token=private'));
    assert.ok(!JSON.stringify(result).includes('user:secret'));
  });
});
test('shadowed APIs, reassigned functions, dynamic references and plugin imports stay unresolved', () => {
  fixture({ 'app.json': '{"pages":["home"]}', 'home.wxml': '<view bindtap="{{dynamic}}"/>', 'home.js': `function f(wx){wx.request({})} function g(){wx.getLocation(); var wx;} {let uni; uni.request({})} import tt from 'plugin://remote'; tt.request({}); function helper(){} helper = other; helper(); Page({onTap(){this.load();this[method]();},load(){wx[method]();wx.request({url:dynamic});require('./missing');import(dynamic);}});` }, result => {
    assert.deepEqual(result.apiCounts, { 'wx.request': 1 });
    for (const kind of ['dynamic-api', 'dynamic-target', 'unresolved-import', 'unresolved-handler', 'unresolved-method']) assert.ok(result.gaps.some(gap => gap.kind === kind), kind);
    assert.ok(!result.relationships.edges.some(edge => edge.kind === 'calls'));
    assert.ok(result.gaps.some(gap => gap.detail === 'plugin://remote'));
  });
});
test('duplicate registration and overwritten methods do not invent handler ownership', () => {
  fixture({ 'app.json': '{"pages":["home"]}', 'home.wxml': '<view bindtap="tap"/>', 'home.js': `Page({tap(){this.load()},load(){}});Page({tap(){this.load()},load(){}});` }, result => {
    assert.ok(!result.relationships.edges.some(edge => ['calls-method', 'event-handler'].includes(edge.kind)));
  });
  fixture({ 'app.json': '{"pages":["home"]}', 'home.js': `Page({tap(){this.load = other;this.load()},load(){}});` }, result => assert.ok(!result.relationships.edges.some(edge => edge.kind === 'calls-method')));
});
test('parse errors survive as actionable gaps', () => {
  fixture({ 'app.json': '{}', 'broken.js': 'const =', 'valid.js': 'wx.request({url:"https://example.com"})' }, result => {
    assert.equal(result.errors.length, 1); assert.ok(result.nextSteps.some(step => step.kind === 'parse-error')); assert.equal(result.apis.length, 1);
  });
});

test('report embeds only hash-authorized trusted code and escaped recovered text', async () => {
  const { renderMiniReport } = await import('./mini-report-ui.mjs');
  const { createHash } = await import('node:crypto');
  const { Script } = await import('node:vm');
  const malicious = '</pre><script>alert(1)</script><img src=x onerror=alert(1)>';
  const html = renderMiniReport({ input: malicious, artifacts: [], stages: [] }, { relationships: { nodes: [{ id: 'x', kind: 'page', file: 'evil.html', line: 1, label: malicious }], edges: [] }, excerpts: { 'evil.html:1': malicious } });
  const scripts = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const source = scripts[0][1];
  assert.ok(html.includes("'sha256-" + createHash('sha256').update(source).digest('base64') + "'"));
  assert.ok(!html.includes(malicious));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(source.includes("location.protocol === 'file:'"));
  assert.ok(!source.includes('innerHTML'));
  new Script(source);
});

test('destructuring writes and event-looking text do not create false edges', () => {
  fixture({ 'app.json': '{"pages":["home"]}', 'home.js': 'function f(){}; ({f}=other); f(); Page({tap(){}});', 'home.wxml': `<view title='bindtap="tap"'/> text bindtap="tap" <!-- <view bindtap="tap"/> -->` }, result => {
    assert.ok(!result.relationships.edges.some(edge => ['calls', 'event-handler'].includes(edge.kind)));
  });
});

test('overwritten registrations, loop writes and tag-looking attribute values remain unresolved', () => {
  for (const object of ['tap(){},tap:null', 'tap(){},...other']) fixture({ 'app.json': '{"pages":["home"]}', 'home.js': 'function f(){}; for(f of xs){}; f(); Page({' + object + '});', 'home.wxml': '<view bindtap="tap"/>' }, result => assert.ok(!result.relationships.edges.some(edge => ['calls', 'event-handler'].includes(edge.kind))));
  fixture({ 'app.json': '{"pages":["home"],"usingComponents":{"card":"/card"}}', 'card.js': 'Component({})', 'home.wxml': '<view title="<card/>"/>' }, result => assert.ok(!result.relationships.edges.some(edge => edge.kind === 'uses-component')));
});

test('root arrow handlers do not inherit the page instance but method-local arrows do', () => {
  fixture({ 'app.json': '{"pages":["home"]}', 'home.js': 'Page({tap:()=>this.load(),other(){(()=>this.load())()},load(){}});' }, result => {
    const calls = result.relationships.edges.filter(edge => edge.kind === 'calls-method');
    assert.equal(calls.length, 1);
    const tap = result.relationships.nodes.find(node => node.kind === 'function' && node.label === 'tap');
    assert.ok(!calls.some(edge => edge.from === tap.id));
    assert.ok(result.gaps.some(gap => gap.kind === 'unresolved-method'));
  });
});

test('request and navigation targets use the last effective literal URL only', () => {
  fixture({ 'app.json': '{"pages":["home","next"]}', 'home.js': `wx.request({url:'https://wrong.example',...options});
wx.request({url:'https://wrong.example',url:'https://right.example'});
wx.request({...options,url:'https://last.example'});
wx.request({url:'https://wrong.example',[key]:value});
wx.navigateTo({url:'/wrong',url:'/next'});
wx.navigateTo({url:'/next',...options});
wx.request({get url(){return 'https://wrong.example'}});`, 'next.js': 'Page({})' }, result => {
    const { nodes, edges } = result.relationships;
    const targets = edges.filter(edge => ['request-target', 'navigation-target'].includes(edge.kind)).map(edge => nodes.find(node => node.id === edge.to).label);
    assert.deepEqual(targets, ['https://right.example/', 'https://last.example/', 'next']);
    assert.equal(result.gaps.filter(gap => gap.kind === 'dynamic-target').length, 4);
  });
});

test('component lifecycle callbacks can call methods but are not instance or WXML methods', () => {
  fixture({ 'app.json': '{}', 'card.js': `Component({attached(){this.load()},lifetimes:{ready(){this.load()},attached(){this.load()}},pageLifetimes:{show(){this.load()}},methods:{tap(){this.attached();this.ready();this.show();this.load()},load(){}}});`, 'card.wxml': '<view bindtap="tap"/><view bindtap="attached"/><view bindtap="ready"/><view bindtap="show"/>' }, result => {
    const { nodes, edges } = result.relationships;
    assert.equal(edges.filter(edge => edge.kind === 'calls-method').length, 5);
    assert.ok(edges.filter(edge => edge.kind === 'calls-method').every(edge => nodes.find(node => node.id === edge.to).label === 'load'));
    assert.equal(edges.filter(edge => edge.kind === 'event-handler').length, 1);
    assert.equal(result.gaps.filter(gap => gap.kind === 'unresolved-handler').length, 3);
    assert.equal(result.gaps.filter(gap => gap.kind === 'unresolved-method').length, 3);
  });
});
