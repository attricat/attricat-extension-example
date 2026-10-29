/* explorer_action (action): a toolbar button for the Explorer's blueprint
 * revision. Its context has no search state or rows, so it reads the stored
 * formula index and lists the revision's formulas with `attricat.notify`. */
import { el, loadFormulaIndex, mountRenderer } from './lib.js';

export const mount = (root, attricat) =>
  mountRenderer(root, attricat, async (context) => {
    const index = await loadFormulaIndex(attricat, context.blueprint_id, context.blueprint_version);
    const count = index?.formulas?.length ?? 0;
    if (!index || index.error || !count) {
      return el('button', { type: 'button', class: 'secondary', disabled: true, title: index?.error ?? 'Open a record of this revision to index its formulas.' },
        index?.error ? 'Formulas invalid' : 'No formulas indexed');
    }
    return el('button', {
      type: 'button',
      class: 'secondary',
      onclick: () => void attricat.notify({ message: index.formulas.map((formula) => `${formula.target_code} = ${formula.expression}`).join(' · ') }),
    }, `ƒ ${count} ${count === 1 ? 'formula' : 'formulas'}`);
  }).cleanup;
