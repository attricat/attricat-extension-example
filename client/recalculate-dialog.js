/* action_dialog "Recalculate formulas": opened by the row and selection
 * actions with the records they captured; starts the recalculation run. */
import { mountDialog } from './dialog-frame.js';
import { mountRecalculation } from './dialog-recalculate.js';

export const mount = (root, attricat) => mountDialog(root, attricat, mountRecalculation);
