import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('./report-source-tools.js', import.meta.url), 'utf8');

function sourcePage(files, ide = false) {
  const requested = [], downloads = [], blobs = [];
  let confirmed = false;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.disabled = false; this.hidden = false; }
    append(child) { this.children.push(child); }
    insertBefore(child, before) { this.children = this.children.filter(item => item !== child); this.children.splice(this.children.indexOf(before), 0, child); }
    contains(child) { return this === child || this.children.some(item => item.contains(child)); }
    remove() {}
    setAttribute(name, value) { this[name] = value; }
    focus() {}
    setSelectionRange(start, end) { this.selection = [start, end]; }
    click() { downloads.push(this); }
    get selectedOptions() { return this.children.filter(child => child.value === this.value); }
  }
  const container = new Element('container');
  const context = {
    document: { createElement: tag => new Element(tag) },
    window: { gilliiI18n: { t: en => en }, confirm: () => confirmed, addEventListener() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { protocol: 'http:', hostname: ide ? '127.0.0.1' : '' },
    AbortController, TextDecoder, Uint8Array, Blob,
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:source'; }, revokeObjectURL() {} },
    setTimeout(callback) { callback(); },
    fetch: async (url, options) => {
      if (url === '__ide') {
        requested.push({url, options});
        return {ok:true, json:async () => [{id:'cursor',available:true},{id:'vscode',available:false}]};
      }
      requested.push(url);
      const bytes = typeof files[url] === 'string' ? new TextEncoder().encode(files[url]) : files[url];
      let sent = false;
      return { ok: true, body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }) }) } };
    }
  };
  runInNewContext(script, context);
  const tools = context.window.gilliiSourceTools.mount(container, { files: [
    { path: 'pages/one.js', bytes: 100 }, { path: 'pages/two.js', bytes: 100 },
    { path: '../outside.js', bytes: 100 }, { path: 'pages//bad.js', bytes: 100 },
    { path: 'assets/image.png', bytes: 100 }, { path: 'pages/invalid.js', bytes: 100 },
    { path: 'pages/main.dart', bytes: 100 }, { path: 'pages/nul.js', bytes: 100 }, { path: 'pages/crlf.js', bytes: 100 }
  ], basePath: 'source/' });
  const all = container.children;
  const buffer = all.find(element => element.className === 'source-buffer');
  const status = all.find(element => element.role === 'status');
  const toolbar = all.find(element => element.className === 'source-toolbar');
  const button = label => toolbar.children.find(element => element.textContent === label);
  return { tools, buffer, status, button, projectBar: all.find(element => element.className === 'source-project-toolbar source-toolbar'), requested, downloads, blobs, confirm: value => { confirmed = value; } };
}

test('source workspace loads inventory paths as editable text and guards unsaved changes', async () => {
  const page = sourcePage({ 'source/pages/one.js': '<script>window.evil()</script>\nnext', 'source/pages/two.js': 'second' });
  await page.tools.open('../outside.js');
  await page.tools.open('pages//bad.js');
  assert.deepEqual(page.requested, []);
  await page.tools.open('pages/one.js', 2);
  assert.deepEqual(page.requested, ['source/pages/one.js']);
  assert.equal(page.buffer.value, '<script>window.evil()</script>\nnext');
  assert.equal(page.buffer.disabled, false);
  assert.deepEqual(page.buffer.selection, [31, 35]);
  page.buffer.value = 'edited'; page.buffer.oninput();
  await page.tools.open('pages/two.js');
  assert.deepEqual(page.requested, ['source/pages/one.js']);
  assert.equal(page.buffer.value, 'edited');
  page.confirm(true); await page.tools.open('pages/two.js');
  assert.deepEqual(page.requested, ['source/pages/one.js', 'source/pages/two.js']);
  assert.equal(page.buffer.value, 'second');
  page.buffer.value = 'changed'; page.buffer.oninput();
  page.button('Reset buffer').onclick();
  assert.equal(page.buffer.value, 'second');
  assert.equal(page.status.textContent, 'Buffer reset.');
});

test('source workspace rejects binary assets and invalid UTF-8 before enabling editing', async () => {
  const page = sourcePage({
    'source/pages/invalid.js': Uint8Array.of(0xff, 0xfe),
    'source/pages/nul.js': Uint8Array.of(97, 0, 98)
  });
  await page.tools.open('assets/image.png');
  assert.deepEqual(page.requested, []);
  assert.equal(page.buffer.disabled, true);
  await page.tools.open('pages/invalid.js');
  assert.equal(page.buffer.disabled, true);
  assert.equal(page.buffer.value, '');
  await page.tools.open('pages/nul.js');
  assert.equal(page.buffer.disabled, true);
  assert.equal(page.buffer.value, '');
  page.button('Download edited file').onclick();
  assert.equal(page.blobs.length, 0);
});

test('source downloads preserve original bytes and use original CRLF convention for edits', async () => {
  const original = new TextEncoder().encode('first\r\n雪\r\n');
  const page = sourcePage({ 'source/pages/crlf.js': original });
  await page.tools.open('pages/crlf.js', 2);
  assert.equal(page.buffer.value, 'first\n雪\n');
  assert.deepEqual(page.buffer.selection, [6, 7]);
  page.button('Download edited file').onclick();
  assert.deepEqual(new Uint8Array(await page.blobs[0].arrayBuffer()), original);
  page.buffer.value = 'first\n雪!\n'; page.buffer.oninput();
  page.button('Download edited file').onclick();
  assert.deepEqual(new Uint8Array(await page.blobs[1].arrayBuffer()), new TextEncoder().encode('first\r\n雪!\r\n'));
  assert.equal(page.downloads.length, 2);
});

test('Dart assembly opens as inert editable text at its evidence line', async () => {
  const page = sourcePage({ 'source/pages/main.dart': '// retained assembly\n// 0x1234: bl #0x5678' });
  await page.tools.open('pages/main.dart', 2);
  assert.equal(page.buffer.disabled, false);
  assert.match(page.buffer.value, /0x1234/);
  assert.deepEqual(page.buffer.selection, [21, 42]);
});


test('IDE project launcher discovers availability and sends only the selected fixed identifier', async () => {
  const page = sourcePage({}, true);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const selector = page.projectBar.children.find(element => element.tag === 'select');
  const button = page.projectBar.children.find(element => element.tag === 'button');
  assert.equal(selector.children.length, 5); assert.equal(selector.value, 'cursor'); assert.equal(button.disabled, false);
  await button.onclick();
  const request = page.requested[1];
  assert.equal(request.url, '__ide'); assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-Gillii-Action'], 'open-project');
  assert.equal(request.options.body, '{"editor":"cursor"}');
  const picker = page.projectBar.children.find(element => element.className === 'ide-picker');
  const [summary, menu] = picker.children;
  assert.equal(summary.children[1].textContent, 'Cursor');
  assert.equal(menu.children.length, 5);
  for (const choice of menu.children) assert.match(choice.children[0].src, /^data:image\/svg\+xml;base64,/);
  picker.open = true; menu.children[0].onclick();
  assert.equal(selector.value, 'vscode'); assert.equal(button.disabled, true); assert.equal(picker.open, false);
  assert.equal(summary.children[1].textContent, 'VS Code');
  assert.equal(menu.children[0]['aria-pressed'], 'true');
  picker.open = true; picker.onkeydown({key:'Escape',preventDefault() {}}); assert.equal(picker.open, false);
});
