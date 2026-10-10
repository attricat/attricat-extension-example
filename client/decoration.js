/* record_attribute_decoration: marks formula targets. Reads the formula index
 * the server keeps in extension storage, so it needs no TOML parsing; when the
 * index is missing it falls back to the describe-formulas command, which also
 * stores the index. */
import { command, el, loadFormulaIndex, mountRenderer } from './lib.js';

export const mount = (root, attricat) =>
  mountRenderer(root, attricat, async (context) => {
    if (!context.attribute_id || !context.blueprint_id) return null;
    let index = await loadFormulaIndex(attricat, context.blueprint_id, context.blueprint_version);
    if (!index && context.record_id) {
      index = await command(attricat, 'describe-formulas', { record_id: context.record_id, context_id: null });
    }
    const formula = index?.formulas?.find((item) => item.target_attribute_id === context.attribute_id);
    if (!formula) return null;
    return el(
      'span',
      { class: 'badge', title: `${formula.target_code} = ${formula.expression}`, 'aria-label': `Computed: ${formula.expression}` },
      '⚡ Computed',
    );
  }).cleanup;
