/* explorer_row_action and explorer_bulk_action (version 2): selection-aware
 * actions. They receive the host's selection context and only open the
 * host-managed action dialog, which captures that selection. */
import { el, installStyles } from './lib.js';

export const mount = (root, catalog) => {
  const removeStyles = installStyles(root, catalog);
  const count = () => catalog.context?.record_ids?.length ?? 0;
  const button = el('button', { type: 'button', class: 'secondary' });
  const label = () => {
    button.textContent = count() > 1 ? `Recalculate formulas (${count()})…` : 'Recalculate formulas…';
  };
  button.addEventListener('click', () => void catalog.dialog.open());
  root.addEventListener('catalog:context-changed.v1', label);
  label();
  root.replaceChildren(button);
  return () => {
    root.removeEventListener('catalog:context-changed.v1', label);
    removeStyles();
    root.replaceChildren();
  };
};
