/* Context-aware formula UI. The host exposes only mediated catalog APIs. */
const contextOf = (element) => element.catalogContext ?? globalThis.catalog?.context ?? {};
const request = (path) => {
  if (!globalThis.catalog?.request) throw new Error('Catalog read access is unavailable.');
  return globalThis.catalog.request(path);
};
const command = async (commandId, payload) => {
  if (!globalThis.catalog?.command) throw new Error('Catalog command access is unavailable.');
  const response = await globalThis.catalog.command({ command_id: commandId, payload });
  // Hosts may return a decoded command payload or the handler envelope.
  if (typeof response?.payload === 'string') return JSON.parse(response.payload);
  return response;
};
const notify = (message, severity = 'success') => globalThis.catalog?.notify?.({ message, severity });
const blueprintPath = (id, version) =>
  `/api/blueprints/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`;
const entityPath = (id) => `/api/v1/entities/${encodeURIComponent(id)}`;
const formulaReferences = (expression) =>
  [...new Set((expression.match(/\b[A-Za-z_][A-Za-z0-9_-]*\b/g) ?? []).filter((token) =>
    !['Infinity', 'NaN'].includes(token)
  ))].sort();
const isNumeric = (attribute) => ['number', 'integer'].includes(attribute?.value_type);
// The host stores the immutable TOML verbatim. This deliberately small reader
// handles the extension's string-only formula table; server validation remains
// authoritative before any formula is evaluated or written.
const formulasFromBlueprint = (blueprint) => {
  const source = blueprint?.blueprint?.definition ?? blueprint?.definition ?? '';
  const header = '[extensions.attricat-extension-example.formulas]';
  const start = source.indexOf(header);
  // A TOML table continues until the next table header. Do not use a multiline
  // `$` terminator here: it also matches immediately at the header line end.
  const section = start < 0 ? '' : source.slice(start + header.length).split(/\n(?=\[)/, 1)[0];
  const attributes = new Map((blueprint?.attributes ?? []).map((attribute) => [attribute.code, attribute]));
  return [...section.matchAll(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"\s*$/gm)].flatMap(([, targetCode, expression]) => {
    const target = attributes.get(targetCode);
    if (!target) return [];
    return [{ targetAttributeId: target.id, expression, dependencies: formulaReferences(expression).map((code) => attributes.get(code)?.id).filter(Boolean) }];
  });
};
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

class ComputedValueIndicator extends HTMLElement {
  connectedCallback() { void this.load(); }
  async load() {
    const context = contextOf(this);
    if (!context.attribute_id) return;
    try {
      const entity = context.entity_id ? await request(entityPath(context.entity_id)) : null;
      const blueprint = entity?.blueprint?.attributes ? entity.blueprint : await request(blueprintPath(context.blueprint_id, context.blueprint_version));
      if (formulasFromBlueprint(blueprint).some((formula) => formula.targetAttributeId === context.attribute_id)) {
        this.textContent = '⚡ Computed'; this.setAttribute('aria-label', 'Computed attribute');
        this.style.cssText = 'color:#1565c0;font:600 12px system-ui,sans-serif';
      }
    } catch { /* Decorations must not disrupt the host attribute editor. */ }
  }
}

class FormulaInspector extends HTMLElement {
  connectedCallback() { this.attachShadow({ mode: 'open' }); void this.load(); }
  async load() {
    const context = contextOf(this);
    if (!context.entity_id) return this.message('No entity context is available.', true);
    try {
      const entity = await request(entityPath(context.entity_id));
      const blueprintId = entity.blueprint?.blueprint?.id ?? entity.blueprint_id;
      const blueprintVersion = entity.blueprint?.blueprint?.version ?? entity.blueprint_version;
      const blueprint = entity.blueprint?.attributes ? entity.blueprint : await request(blueprintPath(blueprintId, blueprintVersion));
      const formulas = formulasFromBlueprint(blueprint);
      const section = el('section'); section.append(el('h2', 'Computed attributes'));
      if (!formulas.length) section.append(el('p', 'This blueprint has no formulas.'));
      for (const formula of formulas) {
        const target = blueprint.attributes?.find((attribute) => attribute.id === formula.targetAttributeId);
        const row = el('div'); row.append(el('h3', target?.code ?? formula.targetAttributeId), el('code', formula.expression));
        const details = el('p', `Context: ${context.context_id ?? 'default'}`); row.append(details);
        if (context.context_id) {
          try {
            const preview = await command('preview-formula', { entity_id: context.entity_id, context_id: context.context_id, expression: formula.expression });
            row.append(el('p', `Inputs: ${Object.entries(preview.resolvedInputs ?? {}).map(([key, value]) => `${key}=${value}`).join(', ')}`), el('p', `Result: ${preview.result}`));
          } catch (error) { row.append(Object.assign(el('p', error.message || 'Evaluation failed.'), { className: 'error' })); }
        }
        section.append(row);
      }
      if (formulas.length && context.context_id) section.append(this.recalculate(context));
      this.shadowRoot.replaceChildren(style(), section);
    } catch (error) { this.message(error.message || 'Unable to load formulas.', true); }
  }
  recalculate(context) {
    const button = el('button', 'Recalculate formulas'); button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await command('recalculate-formulas', { entity_id: context.entity_id, context_id: context.context_id }); await notify('Formulas recalculated.'); await this.load(); }
      catch (error) { await notify(error.message || 'Unable to recalculate formulas.', 'error'); }
      finally { button.disabled = false; }
    });
    return button;
  }
  message(text, error = false) { this.shadowRoot.replaceChildren(style(), Object.assign(el('p', text), { className: error ? 'error' : '' })); }
}

class RecalculateFormulas extends HTMLElement {
  connectedCallback() { this.attachShadow({ mode: 'open' }); void this.load(); }
  async load() {
    const context = contextOf(this);
    if (!context.entity_id || !context.context_id) return;
    try {
      const entity = await request(entityPath(context.entity_id));
      const blueprintId = entity.blueprint?.blueprint?.id ?? entity.blueprint_id;
      const blueprintVersion = entity.blueprint?.blueprint?.version ?? entity.blueprint_version;
      const blueprint = entity.blueprint?.attributes ? entity.blueprint : await request(blueprintPath(blueprintId, blueprintVersion));
      if (!formulasFromBlueprint(blueprint).length) return;
      const button = el('button', 'Recalculate formulas'); button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await command('recalculate-formulas', { entity_id: context.entity_id, context_id: context.context_id }); await notify('Formulas recalculated.'); }
        catch (error) { await notify(error.message || 'Unable to recalculate formulas.', 'error'); }
        finally { button.disabled = false; }
      });
      this.shadowRoot.append(style(), button);
    } catch { /* The action remains absent when configuration cannot be read. */ }
  }
}

function style() {
  const node = document.createElement('style');
  node.textContent = ':host{display:block;color:#1f2937;font:14px/1.45 system-ui,sans-serif}section{border:1px solid #d1d5db;border-radius:6px;padding:16px}h2,h3{margin:0 0 8px}p{margin:8px 0}textarea{box-sizing:border-box;width:100%;font:inherit}button{margin:4px;border:1px solid #1565c0;border-radius:4px;background:#1565c0;color:#fff;cursor:pointer;padding:6px 10px}button:disabled{cursor:wait;opacity:.65}.error{color:#b91c1c}code{overflow-wrap:anywhere}';
  return node;
}

customElements.define('attricat-formula-inspector', FormulaInspector);
customElements.define('attricat-computed-value-indicator', ComputedValueIndicator);
customElements.define('attricat-recalculate-formulas', RecalculateFormulas);
