/* Attribute-decoration embedded contribution for context-aware formulas. */
const request = (catalog, path) => {
  if (!catalog?.request) throw new Error('Catalog read access is unavailable.');
  return catalog.request(path);
};
const blueprintPath = (id, version) =>
  `/api/blueprints/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`;
const entityPath = (id) => `/api/v1/entities/${encodeURIComponent(id)}`;
const formulaTargetIds = (blueprint) => {
  const source = blueprint?.blueprint?.definition ?? blueprint?.definition ?? '';
  const header = '[extensions.attricat-extension-example.formulas]';
  const start = source.indexOf(header);
  const section = start < 0 ? '' : source.slice(start + header.length).split(/\n(?=\[)/, 1)[0];
  const attributes = new Map((blueprint?.attributes ?? []).map((attribute) => [attribute.code, attribute.id]));
  return new Set([...section.matchAll(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"[^"]*"\s*$/gm)].map(([, code]) => attributes.get(code)).filter(Boolean));
};

export const mount = (root, catalog) => {
  let disposed = false;
  const render = async () => {
    root.replaceChildren();
    const context = catalog.context ?? {};
    if (!context.attribute_id || !context.entity_id) return;
    try {
      const entity = await request(catalog, entityPath(context.entity_id));
      const blueprint = entity?.blueprint?.attributes ? entity.blueprint : await request(catalog, blueprintPath(context.blueprint_id, context.blueprint_version));
      if (disposed || !formulaTargetIds(blueprint).has(context.attribute_id)) return;
      const badge = document.createElement('span');
      badge.textContent = '⚡ Computed'; badge.setAttribute('aria-label', 'Computed attribute');
      badge.style.cssText = 'color:#1565c0;font:600 12px system-ui,sans-serif';
      root.replaceChildren(badge);
    } catch { /* Decorations must not disrupt the host attribute editor. */ }
  };
  const onContextChange = () => void render();
  root.addEventListener('catalog:context-changed.v1', onContextChange);
  void render();
  return () => { disposed = true; root.removeEventListener('catalog:context-changed.v1', onContextChange); root.replaceChildren(); };
};
