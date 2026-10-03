/* explorer_table_cell: the `attricat-extension-example.computed-number` cell
 * renderer. Blueprint table columns opt in and pass `precision`/`unit` props:
 *   renderer = { id = "attricat-extension-example.computed-number", version = 1,
 *                props = { precision = 2, unit = "EUR" } } */
import { formatNumber, installStyles } from './lib.js';

export const mount = (root, catalog) => {
  const removeStyles = installStyles(root, catalog);
  const render = () => {
    const context = catalog.context ?? {};
    const props = context.column?.renderer?.props ?? {};
    root.textContent = formatNumber(context.primary_value, {
      precision: Number.isInteger(props.precision) ? props.precision : undefined,
      unit: typeof props.unit === 'string' ? props.unit : undefined,
    });
    root.style.cssText = 'font-variant-numeric:tabular-nums;text-align:right';
  };
  root.addEventListener('catalog:context-changed.v1', render);
  render();
  return () => {
    root.removeEventListener('catalog:context-changed.v1', render);
    removeStyles();
  };
};
