(() => {
  const supported = value => /^zh(?:-|$)/i.test(value || '') ? 'zh' : 'en';
  let language = supported(document.documentElement.dataset.systemLanguage || (navigator.languages || [navigator.language])[0]);
  try { const saved = localStorage.getItem('gillii-report-language'); if (['en', 'zh'].includes(saved)) language = saved; } catch {}
  const apply = (root = document) => {
    const elements = [...(root.matches?.('[data-en]') ? [root] : []), ...root.querySelectorAll('[data-en]')];
    for (const element of elements) { const value = element.dataset[language] || element.dataset.en; if (element.dataset.i18nAttr) element.setAttribute(element.dataset.i18nAttr, value); else if (element.textContent !== value) element.textContent = value; }
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  };
  const api = { get language() { return language; }, t(en, zh) { return language === 'zh' ? zh : en; }, apply };
  window.gilliiI18n = api;
  const select = document.getElementById('report-language');
  if (select) { select.value = language; select.addEventListener('change', () => { language = supported(select.value); try { localStorage.setItem('gillii-report-language', language); } catch {} apply(); document.dispatchEvent(new Event('gillii-language-change')); }); }
  apply();
})();
