/* audit_event_panel (read-only panel): inside the audit event drawer. The
 * frame receives only the event ID, never its actor, target or metadata, so
 * it shows this extension's own recent activity beside the event. */
import { el, mountRenderer, shortId, storageGet } from './lib.js';

export const mount = (root, attricat) =>
  mountRenderer(root, attricat, async (context) => {
    const activity = (await storageGet(attricat, 'activity')) ?? { stats: {}, entries: [] };
    const recent = (activity.entries ?? []).slice(0, 3);
    return el('div', { class: 'stack' },
      el('h2', {}, 'Formula activity'),
      el('p', { class: 'muted' }, `Audit event ${shortId(context.event_id)}. Recent computed-attribute activity:`),
      recent.length
        ? el('ul', {}, recent.map((entry) =>
            el('li', { class: entry.error ? 'error' : '' },
              entry.at ? `${new Date(entry.at * 1000).toLocaleTimeString()} · ` : '',
              `${entry.source} · ${entry.target_code ?? 'run'} · `,
              entry.error ?? (entry.written ? 'written' : 'unchanged'))))
        : el('p', { class: 'muted' }, 'None yet.'));
  }).cleanup;
