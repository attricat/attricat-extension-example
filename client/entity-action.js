/* entity_action (version 1): a one-click server command for the current entity
 * and context, followed by `catalog.refresh` so host views show new values. */
import { command, el, mountRenderer } from './lib.js';

export const mount = (root, catalog) => {
  const view = mountRenderer(root, catalog, async (context) => {
    if (!context.entity_id) return null;
    const described = await command(catalog, 'describe-formulas', { entity_id: context.entity_id, context_id: null });
    if (!described.formulas?.length) return null;
    const button = el('button', { type: 'button', disabled: !context.context_id, title: context.context_id ? undefined : 'Select a context first' }, 'Recalculate formulas');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const { results } = await command(catalog, 'recalculate-formulas', {
          entity_id: context.entity_id,
          context_id: context.context_id,
        });
        const written = results.filter((result) => result.written).length;
        await catalog.notify({ message: written ? `Updated ${written} computed value(s).` : 'Computed values are up to date.' });
        await catalog.refresh({ target: 'current_entity' });
      } catch (error) {
        await catalog.notify({ message: error.message || 'Recalculation failed.', severity: 'error' });
      } finally {
        button.disabled = false;
      }
    });
    return button;
  });
  return view.cleanup;
};

