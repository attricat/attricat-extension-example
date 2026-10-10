/* explorer_row_action and explorer_bulk_action (version 2): selection-aware
 * actions. They receive the host's selection context and only open the
 * host-managed action dialog, which captures that selection. */
import { el, installStyles } from './lib.js';

export const mount = (root, attricat) => {
  const removeStyles = installStyles(root, attricat);
  const count = () => attricat.context?.record_ids?.length ?? 0;
  const button = el('button', { type: 'button', class: 'secondary' });
  const label = () => {
    button.textContent = count() > 1 ? `Recalculate formulas (${count()})…` : 'Recalculate formulas…';
  };
  button.addEventListener('click', () => void attricat.dialog.open());
  root.addEventListener('attricat:context-changed.v1', label);
  label();
  root.replaceChildren(button);
  return () => {
    root.removeEventListener('attricat:context-changed.v1', label);
    removeStyles();
    root.replaceChildren();
  };
};
