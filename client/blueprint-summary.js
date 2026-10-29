/* blueprint_panel (read-only panel): a compact dependency summary that stays
 * visible across the blueprint page's tabs. It receives the newest revision,
 * often an unindexed draft, so it falls back to the closest indexed one.
 * Formulas fed by another formula's target are marked as chained; the server
 * evaluates them in dependency order. */
import { el, loadClosestFormulaIndex, mountRenderer } from './lib.js';

export const mount = (root, attricat) =>
  mountRenderer(root, attricat, async (context) => {
    const { index, version } = await loadClosestFormulaIndex(attricat, context.blueprint_id, context.blueprint_version);
    if (!index) return el('p', { class: 'muted' }, 'ƒ Formulas not indexed yet.');
    if (index.error) return el('p', { class: 'error' }, `ƒ ${index.error}`);
    if (!index.formulas.length) return el('p', { class: 'muted' }, 'ƒ No formulas.');
    const targets = new Set(index.formulas.map((formula) => formula.target_code));
    const count = index.formulas.length;
    return el('div', { class: 'stack' },
      el('h2', {}, `ƒ ${count} computed ${count === 1 ? 'attribute' : 'attributes'}`,
        version === context.blueprint_version ? '' : ` (revision ${version})`),
      el('ul', {}, index.formulas.map((formula) =>
        el('li', {},
          el('code', {}, formula.target_code), ' ← ', formula.dependency_codes.join(', '),
          formula.dependency_codes.some((code) => targets.has(code)) ? [' ', el('span', { class: 'badge' }, 'chained')] : null))));
  }).cleanup;
