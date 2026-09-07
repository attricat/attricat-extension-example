/* Entity-action embedded contribution for context-aware formulas. */
const request = (catalog, path) => {
  if (!catalog?.request) throw new Error('Catalog read access is unavailable.');
  return catalog.request(path);
};
const command = async (catalog, commandId, payload) => {
  if (!catalog?.command) throw new Error('Catalog command access is unavailable.');
  const response = await catalog.command({ command_id: commandId, payload });
  return typeof response?.payload === 'string' ? JSON.parse(response.payload) : response;
};
const entityPath = (id) => `/api/v1/entities/${encodeURIComponent(id)}`;
const blueprintPath = (id, version) =>
  `/api/blueprints/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`;
const hasFormulas = (blueprint) => {
  const source = blueprint?.blueprint?.definition ?? blueprint?.definition ?? '';
  const header = '[extensions.attricat-extension-example.formulas]';
  const start = source.indexOf(header);
  return start >= 0 && /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"[^"]*"\s*$/m.test(source.slice(start + header.length).split(/\n(?=\[)/, 1)[0]);
};

export const mount = (root, catalog) => {
  let disposed = false;
  const render = async () => {
    root.replaceChildren();
    const context = catalog.context ?? {};
    if (!context.entity_id || !context.context_id) return;
    try {
      const entity = await request(catalog, entityPath(context.entity_id));
      const blueprintId = entity.blueprint?.blueprint?.id ?? entity.blueprint_id;
      const blueprintVersion = entity.blueprint?.blueprint?.version ?? entity.blueprint_version;
      const blueprint = entity?.blueprint?.attributes ? entity.blueprint : await request(catalog, blueprintPath(blueprintId, blueprintVersion));
      if (disposed || !hasFormulas(blueprint)) return;
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Recalculate formulas';
      button.style.cssText = 'margin:4px;border:1px solid #1565c0;border-radius:4px;background:#1565c0;color:#fff;cursor:pointer;padding:6px 10px';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await command(catalog, 'recalculate-formulas', { entity_id: context.entity_id, context_id: context.context_id }); await catalog.notify?.({ message: 'Formulas recalculated.' }); }
        catch (error) { await catalog.notify?.({ message: error.message || 'Unable to recalculate formulas.', severity: 'error' }); }
        finally { button.disabled = false; }
      });
      root.replaceChildren(button);
    } catch { /* The action remains absent when configuration cannot be read. */ }
  };
  const onContextChange = () => void render();
  root.addEventListener('catalog:context-changed.v1', onContextChange);
  void render();
  return () => { disposed = true; root.removeEventListener('catalog:context-changed.v1', onContextChange); root.replaceChildren(); };
};
