/* record_action (version 2): receives the preview's one-record selection
 * context. "Recalculate formulas" is a one-click server command followed by
 * `attricat.refresh` so host views show new values; "Generate document…"
 * opens the host-managed action dialog on its documents task. */
import { command, el, mountRenderer } from './lib.js';

export const mount = (root, attricat) => {
  const view = mountRenderer(root, attricat, async (context) => {
    const recordId = context.record_ids?.[0];
    if (!recordId) return null;
    const generate = el('button', { type: 'button', class: 'secondary', onclick: () => void attricat.dialog.open() }, 'Generate document…');
    const described = await command(attricat, 'describe-formulas', { record_id: recordId, context_id: null });
    if (!described.formulas?.length) return el('div', { class: 'row' }, generate);
    const recalculate = el('button', { type: 'button', disabled: !context.context_id, title: context.context_id ? undefined : 'Select a context first' }, 'Recalculate formulas');
    recalculate.addEventListener('click', async () => {
      recalculate.disabled = true;
      try {
        const { results } = await command(attricat, 'recalculate-formulas', {
          record_id: recordId,
          context_id: context.context_id,
        });
        const written = results.filter((result) => result.written).length;
        await attricat.notify({ message: written ? `Updated ${written} computed value(s).` : 'Computed values are up to date.' });
        await attricat.refresh({ target: 'current_record' });
      } catch (error) {
        await attricat.notify({ message: error.message || 'Recalculation failed.', severity: 'error' });
      } finally {
        recalculate.disabled = false;
      }
    });
    return el('div', { class: 'row' }, recalculate, generate);
  });
  return view.cleanup;
};
