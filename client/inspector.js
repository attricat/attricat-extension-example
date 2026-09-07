/* Entity-preview embedded contribution for context-aware formulas. */
const request = (catalog, path) => {
  if (!catalog?.request) throw new Error('Catalog read access is unavailable.');
  return catalog.request(path);
};
const command = async (catalog, commandId, payload) => {
  if (!catalog?.command) throw new Error('Catalog command access is unavailable.');
  const response = await catalog.command({ command_id: commandId, payload });
  return typeof response?.payload === 'string' ? JSON.parse(response.payload) : response;
};
const blueprintPath = (id, version) =>
  `/api/blueprints/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`;
const entityPath = (id) => `/api/v1/entities/${encodeURIComponent(id)}`;
const formulaReferences = (expression) =>
  [...new Set((expression.match(/\b[A-Za-z_][A-Za-z0-9_-]*\b/g) ?? []).filter((token) =>
    !['Infinity', 'NaN'].includes(token)
  ))].sort();
const formulasFromBlueprint = (blueprint) => {
  const source = blueprint?.blueprint?.definition ?? blueprint?.definition ?? '';
  const header = '[extensions.attricat-extension-example.formulas]';
  const start = source.indexOf(header);
  const section = start < 0 ? '' : source.slice(start + header.length).split(/\n(?=\[)/, 1)[0];
  const attributes = new Map((blueprint?.attributes ?? []).map((attribute) => [attribute.code, attribute]));
  return [...section.matchAll(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"\s*$/gm)].flatMap(([, targetCode, expression]) => {
    const target = attributes.get(targetCode);
    return target ? [{ targetAttributeId: target.id, expression, dependencies: formulaReferences(expression).map((code) => attributes.get(code)?.id).filter(Boolean) }] : [];
  });
};
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const style = () => {
  const node = document.createElement('style');
  node.textContent = ':host{display:block;color:#1f2937;font:14px/1.45 system-ui,sans-serif}section{border:1px solid #d1d5db;border-radius:6px;padding:16px}h2,h3{margin:0 0 8px}p{margin:8px 0}button{margin:4px;border:1px solid #1565c0;border-radius:4px;background:#1565c0;color:#fff;cursor:pointer;padding:6px 10px}button:disabled{cursor:wait;opacity:.65}.error{color:#b91c1c}code{overflow-wrap:anywhere}';
  return node;
};

export const mount = (root, catalog) => {
  let disposed = false;
  const render = async () => {
    const context = catalog.context ?? {};
    if (!context.entity_id) return replace('No entity context is available.', true);
    try {
      const entity = await request(catalog, entityPath(context.entity_id));
      const blueprintId = entity.blueprint?.blueprint?.id ?? entity.blueprint_id;
      const blueprintVersion = entity.blueprint?.blueprint?.version ?? entity.blueprint_version;
      const blueprint = entity.blueprint?.attributes ? entity.blueprint : await request(catalog, blueprintPath(blueprintId, blueprintVersion));
      const formulas = formulasFromBlueprint(blueprint);
      const section = el('section'); section.append(el('h2', 'Computed attributes'));
      if (!formulas.length) section.append(el('p', 'This blueprint has no formulas.'));
      for (const formula of formulas) {
        const target = blueprint.attributes?.find((attribute) => attribute.id === formula.targetAttributeId);
        const row = el('div'); row.append(el('h3', target?.code ?? formula.targetAttributeId), el('code', formula.expression));
        row.append(el('p', `Context: ${context.context_id ?? 'default'}`));
        if (context.context_id) {
          try {
            const preview = await command(catalog, 'preview-formula', { entity_id: context.entity_id, context_id: context.context_id, expression: formula.expression });
            row.append(el('p', `Inputs: ${Object.entries(preview.resolvedInputs ?? {}).map(([key, value]) => `${key}=${value}`).join(', ')}`), el('p', `Result: ${preview.result}`));
          } catch (error) { row.append(Object.assign(el('p', error.message || 'Evaluation failed.'), { className: 'error' })); }
        }
        section.append(row);
      }
      if (formulas.length && context.context_id) {
        const button = el('button', 'Recalculate formulas'); button.type = 'button';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await command(catalog, 'recalculate-formulas', { entity_id: context.entity_id, context_id: context.context_id }); await catalog.notify?.({ message: 'Formulas recalculated.' }); await render(); }
          catch (error) { await catalog.notify?.({ message: error.message || 'Unable to recalculate formulas.', severity: 'error' }); }
          finally { button.disabled = false; }
        });
        section.append(button);
      }
      if (!disposed) root.replaceChildren(style(), section);
    } catch (error) { replace(error.message || 'Unable to load formulas.', true); }
  };
  const replace = (text, error = false) => !disposed && root.replaceChildren(style(), Object.assign(el('p', text), { className: error ? 'error' : '' }));
  const onContextChange = () => void render();
  root.addEventListener('catalog:context-changed.v1', onContextChange);
  void render();
  return () => { disposed = true; root.removeEventListener('catalog:context-changed.v1', onContextChange); root.replaceChildren(); };
};
