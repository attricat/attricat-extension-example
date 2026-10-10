/* blueprint_attribute_configuration: per-attribute rounding and unit stored as
 * attribute-scoped extension configuration (`scoped_configuration`). The event
 * handler, commands and the interactive run all round with these settings. */
import { command, el, loadFormulaIndex, mountRenderer } from './lib.js';

export const mount = (root, attricat) =>
  mountRenderer(root, attricat, async (context) => {
    if (!context.attribute_id) return null;
    const scope = {
      blueprint_id: context.blueprint_id,
      blueprint_version: context.blueprint_version,
      attribute_id: context.attribute_id,
    };
    const [index, { settings }] = await Promise.all([
      loadFormulaIndex(attricat, context.blueprint_id, context.blueprint_version),
      command(attricat, 'get-attribute-settings', scope),
    ]);
    const formula = index?.formulas?.find((item) => item.target_attribute_id === context.attribute_id);
    if (!formula && settings.precision == null && !settings.unit) return null;

    const precision = el('select', { 'aria-label': 'Decimal places' },
      el('option', { value: '' }, 'Unrounded'),
      [0, 1, 2, 3, 4, 5, 6].map((digits) => el('option', { value: digits, selected: settings.precision === digits }, `${digits} decimals`)));
    const unit = el('input', { 'aria-label': 'Unit', maxlength: 12, size: 6, placeholder: 'Unit', value: settings.unit ?? '' });
    const status = el('span', { class: 'muted', 'aria-live': 'polite' });
    // Frames are sandboxed without `allow-forms`, so forms never submit;
    // actions are plain button handlers.
    const save = async () => {
      status.className = 'muted';
      status.textContent = 'Saving…';
      try {
        await command(attricat, 'save-attribute-settings', {
          ...scope,
          settings: {
            precision: precision.value === '' ? null : Number(precision.value),
            unit: unit.value.trim() || null,
          },
        });
        status.className = 'ok';
        status.textContent = 'Saved for this revision.';
      } catch (error) {
        status.className = 'error';
        status.textContent = error.message;
      }
    };
    return el('div', { class: 'row', role: 'group', 'aria-label': 'Formula settings' },
      el('span', { class: 'badge' }, '⚡'),
      formula ? el('code', {}, formula.expression) : el('span', { class: 'muted' }, 'Formula settings'),
      precision, unit, el('button', { type: 'button', class: 'secondary', onclick: save }, 'Save'), status);
  }).cleanup;
