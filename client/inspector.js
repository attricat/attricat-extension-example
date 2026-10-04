/* entity_preview_panel: every formula of the entity's revision evaluated in the
 * selected context, an expression preview, and recalculation. Demonstrates
 * `catalog.command`, `catalog.refresh`, `catalog.notify` and context events. */
import { command, el, formatNumber, mountRenderer } from './lib.js';

const formulaCard = (formula) => {
  const evaluation = formula.evaluation;
  const inputs = Object.entries(evaluation?.inputs ?? {})
    .map(([code, value]) => `${code} = ${value ?? '—'}`)
    .join(', ');
  const status = formula.error
    ? el('p', { class: 'error' }, formula.error)
    : evaluation?.missing?.length
      ? el('p', { class: 'muted' }, `Waiting for: ${evaluation.missing.join(', ')}`)
      : evaluation
        ? el(
            'p',
            {},
            'Result ',
            el('strong', {}, formatNumber(evaluation.result, formula.settings)),
            formula.up_to_date
              ? el('span', { class: 'ok' }, ' · up to date')
              : el('span', { class: 'error' }, ` · stored ${formatNumber(formula.current, formula.settings)}`),
          )
        : null;
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, formula.target_code, ' ', el('span', { class: 'badge' }, '⚡ computed')),
    el('code', {}, formula.expression),
    inputs && el('p', { class: 'muted' }, inputs),
    status,
  );
};

const previewForm = (catalog, context) => {
  const input = el('input', { 'aria-label': 'Expression to preview', placeholder: 'price_net * 2', size: 24 });
  const output = el('span', { class: 'muted', 'aria-live': 'polite' });
  // Frames are sandboxed without `allow-forms`: no form submission, so the
  // preview runs from the button or the Enter key.
  const run = async () => {
    output.className = 'muted';
    output.textContent = 'Evaluating…';
    try {
      const preview = await command(catalog, 'preview-formula', {
        entity_id: context.entity_id,
        context_id: context.context_id,
        expression: input.value,
      });
      output.textContent = preview.missing?.length
        ? `Waiting for: ${preview.missing.join(', ')}`
        : `= ${formatNumber(preview.result)}`;
    } catch (error) {
      output.className = 'error';
      output.textContent = error.message;
    }
  };
  input.addEventListener('keydown', (event) => event.key === 'Enter' && void run());
  return el('div', { class: 'row' }, input, el('button', { type: 'button', class: 'secondary', onclick: run }, 'Preview'), output);
};

export const mount = (root, catalog) => {
  const view = mountRenderer(root, catalog, async (context, isCurrent) => {
    if (!context.entity_id) return el('p', { class: 'muted' }, 'No entity is selected.');
    const described = await command(catalog, 'describe-formulas', {
      entity_id: context.entity_id,
      context_id: context.context_id ?? null,
    });
    if (!isCurrent()) return null;
    const section = el('section', { class: 'stack', 'aria-labelledby': 'formulas-heading' }, el('h2', { id: 'formulas-heading' }, 'Computed attributes'));
    if (described.error) section.append(el('p', { class: 'error' }, described.error));
    if (!described.formulas.length) {
      section.append(el('p', { class: 'muted' }, 'This blueprint revision declares no formulas.'));
      return section;
    }
    if (!context.context_id) {
      section.append(el('p', { class: 'muted' }, 'Select a context to evaluate formulas.'));
    }
    section.append(...described.formulas.map(formulaCard));
    if (context.context_id) {
      const button = el('button', { type: 'button' }, 'Recalculate formulas');
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
          await view.rerender();
        } catch (error) {
          await catalog.notify({ message: error.message || 'Recalculation failed.', severity: 'error' });
          button.disabled = false;
        }
      });
      section.append(previewForm(catalog, context), button);
    }
    return section;
  });
  return view.cleanup;
};
