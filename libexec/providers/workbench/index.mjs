import { maybeOpenReport, latestReport } from './report-viewer.mjs';

export { maybeOpenReport } from './report-viewer.mjs';

export const workbenchProvider = {
  id: 'workbench',
  execute: () => maybeOpenReport(latestReport(), { force: true, remember: false })
};
