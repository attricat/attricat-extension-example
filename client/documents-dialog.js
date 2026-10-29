/* action_dialog "Generate documents": opened by the record, row and selection
 * actions with the records they captured; starts the document run. */
import { mountDialog } from './dialog-frame.js';
import { mountDocuments } from './dialog-documents.js';

export const mount = (root, attricat) => mountDialog(root, attricat, mountDocuments);
