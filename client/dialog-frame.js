/* action_dialog: shared frame for the extension's dialogs. Each dialog does
 * one task for the records its action captured; the host dialog renders the
 * title and close control. Key presses inside this sandboxed frame never
 * reach the host page, so the frame closes the dialog itself on Escape. */
import { el, installStyles } from './lib.js';

export const mountDialog = (root, attricat, mountTask) => {
  const removeStyles = installStyles(root, attricat);
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void attricat.dialog.close();
    }
  };
  document.addEventListener('keydown', onKey);
  const body = el('div', { class: 'stack' });
  root.replaceChildren(body);
  const cleanup = mountTask(body, attricat);
  return () => {
    cleanup?.();
    document.removeEventListener('keydown', onKey);
    removeStyles();
    root.replaceChildren();
  };
};
