import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const script = readFileSync(new URL('./report-language.js', import.meta.url), 'utf8');

function languagePage(systemLanguage, browserLanguage, saved, blocked = false) {
  const text = { dataset: { en: 'Evidence', zh: '证据' }, textContent: 'Evidence' };
  const input = { dataset: { en: 'Search', zh: '搜索', i18nAttr: 'placeholder' }, setAttribute(name, value) { this[name] = value; } };
  const selector = { addEventListener(name, handler) { this.change = handler; } };
  const document = { documentElement: { dataset: { systemLanguage } }, querySelectorAll: () => [text, input],
    getElementById: () => selector, dispatchEvent(event) { this.lastEvent = event.type; } };
  const context = { document, navigator: { languages: [browserLanguage] }, window: {}, Event: class { constructor(type) { this.type = type; } },
    localStorage: { getItem() { if (blocked) throw new Error('storage disabled'); return saved; }, setItem(key, value) { if (blocked) throw new Error('storage disabled'); saved = value; } } };
  runInNewContext(script, context);
  return { document, text, input, selector, api: context.window.gilliiI18n, saved: () => saved };
}

test('report language follows host locale, falls back to English and translates attributes', () => {
  const page = languagePage('zh-Hans-CN', 'en-US');
  assert.equal(page.api.language, 'zh'); assert.equal(page.text.textContent, '证据'); assert.equal(page.input.placeholder, '搜索');
  assert.equal(page.document.documentElement.lang, 'zh-CN');
  assert.equal(languagePage('fr-FR', 'zh-CN').api.language, 'en');
  assert.equal(languagePage(undefined, 'zh-CN').api.language, 'zh');
  assert.equal(languagePage(undefined, undefined).api.language, 'en');
});

test('manual language switching is saved when possible and works without browser storage', () => {
  const page = languagePage('zh', 'en-US', 'invalid', true);
  page.selector.value = 'en'; page.selector.change();
  assert.equal(page.api.language, 'en'); assert.equal(page.text.textContent, 'Evidence'); assert.equal(page.input.placeholder, 'Search');
  assert.equal(page.document.lastEvent, 'gillii-language-change');
  const remembered = languagePage('en-US', 'en-US', 'zh');
  assert.equal(remembered.api.language, 'zh');
  remembered.selector.value = 'en'; remembered.selector.change(); assert.equal(remembered.saved(), 'en');
});
