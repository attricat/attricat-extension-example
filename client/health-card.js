/* data_health_card (read-only panel): formula activity counters maintained by
 * the server component in extension storage. */
import { el, mountRenderer, storageGet } from './lib.js';

export const mount = (root, catalog) =>
  mountRenderer(root, catalog, async () => {
    const activity = (await storageGet(catalog, 'activity')) ?? { stats: {}, entries: [] };
    const stats = activity.stats ?? {};
    const lastError = activity.entries?.find((entry) => entry.error);
    return el('div', { class: 'stack' },
      el('h2', {}, 'Computed attributes'),
      el('div', { class: 'row' },
        el('span', {}, el('strong', {}, stats.evaluations ?? 0), ' evaluations'),
        el('span', {}, el('strong', {}, stats.writes ?? 0), ' writes'),
        el('span', { class: stats.errors ? 'error' : '' }, el('strong', {}, stats.errors ?? 0), ' errors'),
        el('span', {}, el('strong', {}, stats.runs ?? 0), ' runs')),
      lastError ? el('p', { class: 'error' }, `Last error: ${lastError.error}`) : null);
  }).cleanup;
