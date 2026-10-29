/* file_panel (read-only panel): beneath each file link of a record. The panel
 * gets IDs only, so it reads the record with `attricat.request` and shows this
 * extension's annotations on it: the last generated document and formula check. */
import { EXTENSION_ID, el, mountRenderer } from './lib.js';

const OUTPUTS = { individual: 'separate PDF', zip: 'ZIP archive', combined: 'combined PDF' };

export const mount = (root, attricat) =>
  mountRenderer(root, attricat, async (context) => {
    const { record } = await attricat.request(`/api/v1/records/${context.record_id}`);
    const metadata = record?.system_metadata?.[EXTENSION_ID] ?? {};
    const last = metadata.last_document;
    return el('p', { class: 'muted' },
      last
        ? `Last document: ${last.template} template, ${OUTPUTS[last.output] ?? last.output}${last.generated_at ? `, ${new Date(last.generated_at).toLocaleString()}` : ''}.`
        : 'No document generated for this record yet.',
      metadata.last_run_id !== undefined ? ` Formulas checked: ${metadata.stale_targets ?? 0} stale.` : '');
  }).cleanup;
