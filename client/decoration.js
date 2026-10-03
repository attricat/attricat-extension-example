/* entity_attribute_decoration: marks formula targets. Reads the formula index
 * the server keeps in extension storage, so it needs no TOML parsing; when the
 * index is missing it falls back to the describe-formulas command, which also
 * stores the index. */
import { command, el, loadFormulaIndex, mountRenderer } from './lib.js';

export const mount = (root, catalog) =>
  mountRenderer(root, catalog, async (context) => {
    if (!context.attribute_id || !context.blueprint_id) return null;
    let index = await loadFormulaIndex(catalog, context.blueprint_id, context.blueprint_version);
    if (!index && context.entity_id) {
      index = await command(catalog, 'describe-formulas', { entity_id: context.entity_id, context_id: null });
    }
    const formula = index?.formulas?.find((item) => item.target_attribute_id === context.attribute_id);
    if (!formula) return null;
    return el(
      'span',
      { class: 'badge', title: `${formula.target_code} = ${formula.expression}`, 'aria-label': `Computed: ${formula.expression}` },
      '⚡ Computed',
    );
  }).cleanup;
