/* blueprint_detail_panel (read-only panel): the formulas of this blueprint
 * revision as validated by the server component, read from extension storage. */
import { el, loadFormulaIndex, mountRenderer } from './lib.js';

export const mount = (root, attricat) =>
  mountRenderer(root, attricat, async (context) => {
    const index = await loadFormulaIndex(attricat, context.blueprint_id, context.blueprint_version);
    const heading = el('h2', {}, 'Formulas');
    if (!index) {
      return [heading, el('p', { class: 'muted' }, 'Not indexed yet. The extension validates a revision when one of its records is updated or inspected.')];
    }
    if (index.error) return [heading, el('p', { class: 'error' }, index.error)];
    if (!index.formulas.length) return [heading, el('p', { class: 'muted' }, 'This revision declares no formulas.')];
    return [
      heading,
      el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Target'), el('th', {}, 'Expression'), el('th', {}, 'Inputs'))),
        el('tbody', {}, index.formulas.map((formula) =>
          el('tr', {}, el('td', {}, formula.target_code), el('td', {}, el('code', {}, formula.expression)), el('td', {}, formula.dependency_codes.join(', ')))))),
    ];
  }).cleanup;
