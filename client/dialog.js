/* action_dialog: the extension's single host-managed dialog, opened by its
 * version 2 selection actions with the selection they captured. An extension
 * has one dialog, so it offers both interactive operations as tasks: opened
 * from the record preview it starts on documents (recalculation has a
 * one-click button there), from the Explorer on recalculation.
 * Demonstrates `attricat.operations.*` and `attricat.dialog.close`. */
import { el, installStyles } from './lib.js';
import { mountDocuments } from './dialog-documents.js';
import { mountRecalculation } from './dialog-recalculate.js';

const TASKS = [
  { id: 'recalculate', label: 'Recalculate formulas', mount: mountRecalculation },
  { id: 'documents', label: 'Generate documents', mount: mountDocuments },
];

export const mount = (root, attricat) => {
  const removeStyles = installStyles(root, attricat);
  const close = () => void attricat.dialog.close();
  // Key presses inside this sandboxed frame never reach the host page, so the
  // host dialog cannot see Escape. Close it explicitly.
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey);

  const body = el('div', { class: 'stack', role: 'tabpanel' });
  const tabs = TASKS.map((task) => el('button', { type: 'button', role: 'tab', onclick: () => show(task) }, task.label));
  let cleanup = () => {};
  const show = (task) => {
    cleanup();
    TASKS.forEach((item, index) => {
      const selected = item === task;
      tabs[index].setAttribute('aria-selected', String(selected));
      tabs[index].className = selected ? '' : 'secondary';
    });
    cleanup = task.mount(body, attricat, close);
  };

  root.replaceChildren(el('div', { class: 'stack' }, el('div', { class: 'row', role: 'tablist', 'aria-label': 'Task' }, tabs), body));
  show(TASKS[attricat.context?.selection_source === 'record_preview' ? 1 : 0]);

  return () => {
    cleanup();
    document.removeEventListener('keydown', onKey);
    removeStyles();
    root.replaceChildren();
  };
};
