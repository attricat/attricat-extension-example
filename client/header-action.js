/* record_header_action (action): "Check formulas" before the record toolbar.
 * Its context names the record but no value context, so the command only
 * validates the revision's formulas (refreshing the stored index that panels
 * and runs read) and reports them with `attricat.notify`. */
import { command, el, installStyles } from './lib.js';

export const mount = (root, attricat) => {
  const removeStyles = installStyles(root, attricat);
  const button = el('button', { type: 'button', class: 'secondary' }, 'Check formulas');
  button.addEventListener('click', async () => {
    const recordId = attricat.context?.record_id;
    if (!recordId) return;
    button.disabled = true;
    try {
      const { formulas = [], error } = await command(attricat, 'describe-formulas', { record_id: recordId, context_id: null });
      await attricat.notify(
        error
          ? { message: `Formulas are invalid: ${error}`, severity: 'error' }
          : {
              message: formulas.length
                ? `${formulas.length} valid ${formulas.length === 1 ? 'formula' : 'formulas'}: ${formulas.map((formula) => formula.target_code).join(', ')}.`
                : 'This blueprint revision declares no formulas.',
            },
      );
    } catch (failure) {
      await attricat.notify({ message: failure.message || 'The formulas could not be checked.', severity: 'error' });
    } finally {
      button.disabled = false;
    }
  });
  root.replaceChildren(button);
  return () => {
    removeStyles();
    root.replaceChildren();
  };
};
