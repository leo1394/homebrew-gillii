import { extname } from 'node:path';

const MAX_FEATURES = 500, MAX_NODES = 300, MAX_EDGES = 600, MAX_GAPS = 40;
const continuation = new Set(['page-file', 'binds-event', 'event-handler', 'defines-function', 'registers-handler', 'calls', 'calls-method', 'calls-api', 'request-target', 'navigation-target', 'uses-component', 'component-module', 'imports', 'requires', 'declares-component']);
const text = value => String(value ?? '').replace(/https?:\/\/[^\s"'`<>]+/gi, match => { try { const url = new URL(match); return url.origin.replace(/\/\/[^/]*@/, '//') + url.pathname; } catch { return '[URL redacted]'; } }).replace(/[\r\n\t]/g, ' ').replace(/([\\`*_[\]<>|])/g, '\\$1').slice(0, 300);
const kindOf = path => /(?:^|\/)(?:app-service|appservice|page-frame|pageframe|app-wxss)\.js$/.test(path) ? 'compiled-bundle' : ({ '.js': 'javascript', '.json': 'configuration', '.wxml': 'view', '.wxss': 'style' }[extname(path)] || 'asset');

export function deriveReconstruction(analysis, inventory = []) {
  const nodes = analysis.relationships?.nodes || [], edges = analysis.relationships?.edges || [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const outgoing = new Map();
  edges.forEach((edge, index) => { if (continuation.has(edge.kind) && byId.has(edge.from) && byId.has(edge.to)) { if (!outgoing.has(edge.from)) outgoing.set(edge.from, []); outgoing.get(edge.from).push(index); } });
  const pages = nodes.filter(node => node.kind === 'page');
  const eventNodes = nodes.filter(node => node.kind === 'event');
  const features = [];
  function trace(entry, pagePath = null) {
    const queue = [entry.id], seen = new Set([entry.id]), edgeIndexes = [], files = new Set(); let truncated = false;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = byId.get(queue[cursor]); if (node?.file) files.add(node.file);
      for (const index of outgoing.get(queue[cursor]) || []) {
        const edge = edges[index], target = byId.get(edge.to);
        const terminalPage = target.kind === 'page' && target.id !== entry.id;
        if (terminalPage && edge.kind !== 'navigation-target') continue;
        if (pagePath && target.kind === 'module' && target.file.endsWith('.js') && pages.some(page => page.label !== pagePath && page.label + '.js' === target.file)) continue;
        if (edgeIndexes.length >= MAX_EDGES || (!seen.has(target.id) && seen.size >= MAX_NODES)) { truncated = true; continue; }
        edgeIndexes.push(index);
        if (!seen.has(target.id)) { seen.add(target.id); if (!terminalPage) queue.push(target.id); }
      }
    }
    const gapList = (analysis.gaps || []).filter(gap => files.has(gap.file) && (gap.kind !== 'uncached-page' || gap.detail === pagePath));
    return { id: entry.id, label: entry.label, entryId: entry.id, nodeIds: [...seen], edgeIndexes, files: [...files].sort(), gaps: gapList.slice(0, MAX_GAPS), truncated: truncated || gapList.length > MAX_GAPS };
  }
  for (const page of pages) { if (features.length >= MAX_FEATURES) break; features.push(trace(page, page.label)); }
  for (const event of eventNodes) { if (features.length >= MAX_FEATURES) break; const parentPage = pages.find(page => event.file === page.label + '.wxml'); features.push(trace(event, parentPage?.label || null)); }
  const pageUse = new Map();
  for (const feature of features.filter(feature => byId.get(feature.entryId)?.kind === 'page')) for (const path of feature.files) {
    if (!pageUse.has(path)) pageUse.set(path, new Set()); pageUse.get(path).add(feature.entryId);
  }
  const shared = new Set([...pageUse].filter(([, owners]) => owners.size > 1).map(([path]) => path));
  for (const feature of features) feature.sharedModules = feature.files.filter(path => shared.has(path) && kindOf(path) === 'javascript');
  const groups = new Map();
  const put = (id, label, nodeId) => { if (!groups.has(id)) groups.set(id, { id, label, nodeIds: [] }); groups.get(id).nodeIds.push(nodeId); };
  for (const node of nodes) {
    const ownPage = pages.find(page => node.id === page.id || node.file === page.label + '.js' || node.file === page.label + '.wxml' || node.file === page.label + '.json' || node.file === page.label + '.wxss');
    if (node.kind === 'api' || node.kind === 'endpoint' || node.kind === 'navigation-target') put('platform', 'Platform calls and targets', node.id);
    else if (ownPage) put('page:' + ownPage.label, 'Page: ' + ownPage.label, node.id);
    else if (node.kind === 'component' || /(?:^|\/)components?\//.test(node.file)) put('components', 'Components', node.id);
    else if (shared.has(node.file)) put('shared', 'Shared modules', node.id);
    else put('other', 'Other recovered modules', node.id);
  }
  const files = inventory.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, kind: kindOf(file.path) }));
  const dependencies = edges.flatMap((edge, index) => ['imports', 'requires', 'component-module'].includes(edge.kind) ? [{ edgeIndex: index, from: byId.get(edge.from)?.file, to: byId.get(edge.to)?.file, kind: edge.kind }] : []).slice(0, 5000);
  return { version: 1, layers: [...groups.values()], features, files, dependencies, sharedModules: [...shared].filter(path => kindOf(path) === 'javascript').sort(),
    suggestedTargetBoundaries: [
      { id: 'views', label: 'Views and page state', sourceLayerIds: [...groups.keys()].filter(id => id.startsWith('page:')), rationale: 'Recreate declared pages, templates, styles and initial state from local evidence.' },
      { id: 'shared', label: 'Reusable client modules', sourceLayerIds: ['shared', 'components'].filter(id => groups.has(id)), rationale: 'Extract modules used across pages and declared components after verifying their contracts.' },
      { id: 'platform', label: 'Platform adapters', sourceLayerIds: groups.has('platform') ? ['platform'] : [], rationale: 'Wrap observed platform calls and validate behavior in an authorized runtime.' }
    ], limits: { maxFeatures: MAX_FEATURES, maxNodesPerFeature: MAX_NODES, maxEdgesPerFeature: MAX_EDGES, maxGapsPerFeature: MAX_GAPS, featureInventoryTruncated: pages.length + eventNodes.length > MAX_FEATURES },
    scope: 'Static recovered client evidence only. Suggested boundaries are a migration plan, not observed architecture or backend implementation.' };
}

export function renderRebuildMarkdown(analysis) {
  const reconstruction = analysis.reconstruction;
  const byId = new Map((analysis.relationships?.nodes || []).map(node => [node.id, node]));
  const lines = ['# Client reconstruction blueprint', '', reconstruction.scope, '', '## Observed source inventory', ''];
  for (const layer of reconstruction.layers) lines.push('- ' + text(layer.label) + ': ' + layer.nodeIds.length + ' graph nodes.');
  lines.push('', '## Page and event features', '');
  for (const feature of reconstruction.features) {
    const entry = byId.get(feature.entryId);
    lines.push('### ' + text(feature.label), '', 'Entry: ' + text(entry?.file) + ':' + (entry?.line || 1) + ' (`' + text(entry?.kind) + '`).',
      'Trace: ' + feature.nodeIds.length + ' nodes, ' + feature.edgeIndexes.length + ' edges; ' + feature.files.length + ' files' + (feature.truncated ? '; truncated by analysis limits.' : '.'), '');
    const functions = feature.nodeIds.map(id => byId.get(id)).filter(node => node?.kind === 'function').slice(0, 20);
    if (functions.length) lines.push('Functions: ' + functions.map(node => text(node.label) + ' (' + text(node.file) + ':' + node.line + ')').join(', ') + '.', '');
    if (feature.gaps.length) lines.push('Open evidence: ' + feature.gaps.slice(0, 10).map(gap => text(gap.kind) + ' at ' + text(gap.file) + ':' + gap.line).join('; ') + '.', '');
  }
  if (reconstruction.limits.featureInventoryTruncated) lines.push('Feature inventory truncated at ' + reconstruction.limits.maxFeatures + ' entries.', '');
  lines.push('## Technical details', '', 'Recovered files: ' + reconstruction.files.length + '. Declared pages: ' + (analysis.pages || []).length + '. Direct platform calls: ' + (analysis.apis || []).length + '.', '');
  const statePages = (analysis.relationships?.nodes || []).filter(node => node.kind === 'page' && node.initialStateKeys?.length);
  for (const page of statePages) lines.push('- ' + text(page.label) + ' initial state keys (' + text(page.initialStateLocation?.file || page.file) + ':' + (page.initialStateLocation?.line || page.line) + '): ' + page.initialStateKeys.map(text).join(', ') + '.');
  if (statePages.length) lines.push('');
  if (reconstruction.sharedModules.length) lines.push('Shared client modules: ' + reconstruction.sharedModules.map(text).join(', ') + '.', '');
  for (const dependency of reconstruction.dependencies.slice(0, 100)) lines.push('- ' + text(dependency.from) + ' → ' + text(dependency.to) + ' (' + dependency.kind + '; graph edge ' + dependency.edgeIndex + ').');
  if (reconstruction.dependencies.length > 100) lines.push('- Additional dependencies are available in `evidence/reconstruction.json`.');
  if (reconstruction.dependencies.length) lines.push('');
  lines.push('## Suggested target boundaries', '');
  for (const boundary of reconstruction.suggestedTargetBoundaries) lines.push('- ' + boundary.label + ': ' + boundary.rationale);
  lines.push('', '## Migration checklist', '', '- [ ] Confirm recovered page routes and cache coverage against an authorized runtime.', '- [ ] Rebuild page views, state and handler flows from the cited source locations.', '- [ ] Verify shared module and component contracts before extracting them.', '- [ ] Replace each platform call with a tested adapter or supported equivalent.', '- [ ] Define backend contracts from authorized API documentation or traces; URLs alone do not establish server behavior.', '', '## Missing-source tasks', '');
  for (const gap of (analysis.gaps || []).slice(0, 100)) lines.push('- ' + text(gap.kind) + ': ' + text(gap.file) + ':' + gap.line + ' — ' + text(gap.detail));
  if ((analysis.gaps || []).length > 100) lines.push('- Further gaps are available in `evidence/analysis.json`.');
  lines.push('', '## Testable acceptance suggestions', '', '- Compare every declared page route with the authorized application and record missing pages.', '- Exercise each observed WXML event and compare visible state transitions.', '- Verify each platform call with controlled fixtures, including dynamic and unresolved targets.', '- Compare navigation destinations and network request shapes against authorized runtime traces.', '', 'All traces are static and bounded. Missing, dynamic or compiled-only source requires further investigation.');
  return lines.join('\n') + '\n';
}
