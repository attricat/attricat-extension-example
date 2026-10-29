/* blueprint_publish_check (read-only panel): informational only; it cannot
 * block publication and receives no draft contents. A draft has no records,
 * so it is rarely indexed: the panel shows the formulas of the closest indexed
 * revision and says when this revision's formulas will be validated. */
import { el, loadClosestFormulaIndex, mountRenderer } from './lib.js';

const list = (index) =>
  el('ul', {}, index.formulas.map((formula) => el('li', {}, el('code', {}, `${formula.target_code} = ${formula.expression}`))));

export const mount = (root, attricat) =>
  mountRenderer(root, attricat, async ({ blueprint_id: id, blueprint_version: version }) => {
    const heading = el('h2', {}, 'Formulas');
    const { index, version: indexed } = await loadClosestFormulaIndex(attricat, id, version);
    if (index && indexed === version) {
      if (index.error) return [heading, el('p', { class: 'error' }, `This revision's formulas are invalid: ${index.error}`)];
      return [heading, el('p', { class: 'ok' }, `${index.formulas.length} validated.`), list(index)];
    }
    const note = el('p', { class: 'muted' }, `Formulas of revision ${version} are validated when one of its records is first updated or inspected; problems appear in the Formula workbench.`);
    if (index && !index.error && index.formulas.length) {
      return [heading, el('p', {}, `Revision ${indexed} computes:`), list(index), note];
    }
    return [heading, note];
  }).cleanup;
