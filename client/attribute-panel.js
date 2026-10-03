/* entity_attribute_panel (read-only panel): explains how an attribute takes
 * part in formulas. Panels cannot invoke commands, so it reads the formula
 * index the server component keeps in extension storage. */
import { el, loadFormulaIndex, mountRenderer } from './lib.js';

export const mount = (root, catalog) =>
  mountRenderer(root, catalog, async (context) => {
    if (!context.attribute_id) return null;
    const index = await loadFormulaIndex(catalog, context.blueprint_id, context.blueprint_version);
    const formulas = index?.formulas ?? [];
    const target = formulas.find((formula) => formula.target_attribute_id === context.attribute_id);
    const feeds = formulas.filter((formula) => formula.dependencies.includes(context.attribute_id));
    if (!target && !feeds.length) return null;
    return el('p', { class: 'muted' },
      target ? ['⚡ ', el('code', {}, `${target.target_code} = ${target.expression}`)] : null,
      target && feeds.length ? ' · ' : null,
      feeds.length ? `Feeds ${feeds.map((formula) => formula.target_code).join(', ')}` : null);
  }).cleanup;
