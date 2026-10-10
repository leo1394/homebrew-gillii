// Render retained Markdown as inert document content, including offline reports.
(() => {
  const source = document.getElementById('blueprint-data');
  const root = document.querySelector('.blueprint-content');
  if (!source || !root) return;
  function inline(parent, text) {
    for (const [index, part] of text.split('`').entries()) {
      if (index % 2) { const code = document.createElement('code'); code.textContent = part; parent.appendChild(code); }
      else parent.appendChild(document.createTextNode(part));
    }
  }
  let list;
  for (const line of source.textContent.split('\n')) {
    if (!line.trim()) { list = undefined; continue; }
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    const item = /^(?:- |\d+\. )(.*)$/.exec(line);
    if (item) {
      const ordered = /^\d/.test(line);
      if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) { list = document.createElement(ordered ? 'ol' : 'ul'); root.appendChild(list); }
      const row = document.createElement('li'); inline(row, item[1].replace(/^\[ \] /, '☐ ')); list.appendChild(row);
    } else {
      list = undefined;
      const block = document.createElement(heading ? 'h' + Math.min(4, heading[1].length + 1) : 'p');
      inline(block, heading ? heading[2] : line); root.appendChild(block);
    }
  }
})();
