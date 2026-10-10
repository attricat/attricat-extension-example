/* explorer_table_cell: the `attricat-extension-example.computed-number` cell
 * renderer. Blueprint table columns opt in and pass `precision`/`unit` props:
 *   renderer = { id = "attricat-extension-example.computed-number", version = 1,
 *                props = { precision = 2, unit = "EUR" } } */
import { formatNumber, installStyles } from './lib.js';

export const mount = (root, attricat) => {
  const removeStyles = installStyles(root, attricat);
  const render = () => {
    const context = attricat.context ?? {};
    const props = context.column?.renderer?.props ?? {};
    root.textContent = formatNumber(context.primary_value, {
      precision: Number.isInteger(props.precision) ? props.precision : undefined,
      unit: typeof props.unit === 'string' ? props.unit : undefined,
    });
    root.style.cssText = 'font-variant-numeric:tabular-nums;text-align:right';
  };
  root.addEventListener('attricat:context-changed.v1', render);
  render();
  return () => {
    root.removeEventListener('attricat:context-changed.v1', render);
    removeStyles();
  };
};
