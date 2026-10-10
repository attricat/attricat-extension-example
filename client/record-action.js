/* record_action (version 1): a one-click server command for the current record
 * and context, followed by `attricat.refresh` so host views show new values. */
import { command, el, mountRenderer } from './lib.js';

export const mount = (root, attricat) => {
  const view = mountRenderer(root, attricat, async (context) => {
    if (!context.record_id) return null;
    const described = await command(attricat, 'describe-formulas', { record_id: context.record_id, context_id: null });
    if (!described.formulas?.length) return null;
    const button = el('button', { type: 'button', disabled: !context.context_id, title: context.context_id ? undefined : 'Select a context first' }, 'Recalculate formulas');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const { results } = await command(attricat, 'recalculate-formulas', {
          record_id: context.record_id,
          context_id: context.context_id,
        });
        const written = results.filter((result) => result.written).length;
        await attricat.notify({ message: written ? `Updated ${written} computed value(s).` : 'Computed values are up to date.' });
        await attricat.refresh({ target: 'current_record' });
      } catch (error) {
        await attricat.notify({ message: error.message || 'Recalculation failed.', severity: 'error' });
      } finally {
        button.disabled = false;
      }
    });
    return button;
  });
  return view.cleanup;
};

