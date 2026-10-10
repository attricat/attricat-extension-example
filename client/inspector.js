/* record_preview_panel: every formula of the record's revision evaluated in the
 * selected context, an expression preview, and recalculation. Demonstrates
 * `attricat.command`, `attricat.refresh`, `attricat.notify` and context events. */
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

const previewForm = (attricat, context) => {
  const input = el('input', { 'aria-label': 'Expression to preview', placeholder: 'price_net * 2', size: 24 });
  const output = el('span', { class: 'muted', 'aria-live': 'polite' });
  // Frames are sandboxed without `allow-forms`: no form submission, so the
  // preview runs from the button or the Enter key.
  const run = async () => {
    output.className = 'muted';
    output.textContent = 'Evaluating…';
    try {
      const preview = await command(attricat, 'preview-formula', {
        record_id: context.record_id,
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

export const mount = (root, attricat) => {
  const view = mountRenderer(root, attricat, async (context, isCurrent) => {
    if (!context.record_id) return el('p', { class: 'muted' }, 'No record is selected.');
    const described = await command(attricat, 'describe-formulas', {
      record_id: context.record_id,
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
          const { results } = await command(attricat, 'recalculate-formulas', {
            record_id: context.record_id,
            context_id: context.context_id,
          });
          const written = results.filter((result) => result.written).length;
          await attricat.notify({ message: written ? `Updated ${written} computed value(s).` : 'Computed values are up to date.' });
          await attricat.refresh({ target: 'current_record' });
          await view.rerender();
        } catch (error) {
          await attricat.notify({ message: error.message || 'Recalculation failed.', severity: 'error' });
          button.disabled = false;
        }
      });
      section.append(previewForm(attricat, context), button);
    }
    return section;
  });
  return view.cleanup;
};
