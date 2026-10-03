/* Shared helpers bundled into every contribution. Each artifact runs alone in
 * its own sandboxed, opaque-origin frame and talks to Catalog only through the
 * mediated `catalog` object passed to `mount(root, catalog)`. */

export const EXTENSION_ID = 'attricat-extension-example';

/* Invokes a declared server command (`client.commands`). */
export const command = async (catalog, commandId, payload) => {
  if (!catalog?.command) throw new Error('Server commands are not available here.');
  const response = await catalog.command({ command_id: commandId, payload });
  if (typeof response?.payload === 'string') return JSON.parse(response.payload);
  return response?.payload ?? response;
};

/* Reads extension storage (`storage.extension`). Read-only panels use it to
 * show state the server component precomputed. */
export const storageGet = async (catalog, key) => {
  if (!catalog?.storage) return null;
  const entry = await catalog.storage.get({ key });
  return entry && typeof entry === 'object' && 'value' in entry ? entry.value : null;
};

export const formulaIndexKey = (blueprintId, blueprintVersion) =>
  `formulas:${blueprintId}:${blueprintVersion}`;

export const loadFormulaIndex = (catalog, blueprintId, blueprintVersion) =>
  storageGet(catalog, formulaIndexKey(blueprintId, blueprintVersion));

export const formatNumber = (value, settings = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const precision = Number.isInteger(settings.precision) ? settings.precision : undefined;
  const text = value.toLocaleString(undefined, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision ?? 6,
  });
  return settings.unit ? `${text} ${settings.unit}` : text;
};

export const shortId = (id) => (typeof id === 'string' ? id.slice(0, 8) : '—');

/* Light/dark tokens follow `catalog.theme`, which the host updates in place. */
const css = `
:root { --fg:#1f2937; --muted:#6b7280; --bg:transparent; --card:#ffffff; --border:#d1d5db;
  --accent:#1565c0; --accent-fg:#ffffff; --danger:#b91c1c; --ok:#047857; --code:#f3f4f6; }
:root[data-mode="dark"] { --fg:#e5e7eb; --muted:#9ca3af; --card:#111827; --border:#374151;
  --accent:#60a5fa; --accent-fg:#0b1220; --danger:#f87171; --ok:#34d399; --code:#1f2937; }
#root { display:flow-root; }
html, body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui,sans-serif; }
h2 { font-size:1rem; margin:0 0 8px; } h3 { font-size:.9rem; margin:12px 0 4px; }
p { margin:6px 0; } .muted { color:var(--muted); } .error { color:var(--danger); } .ok { color:var(--ok); }
code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--code);
  border-radius:4px; padding:1px 4px; overflow-wrap:anywhere; }
pre { padding:10px; overflow-x:auto; }
.card { border:1px solid var(--border); border-radius:8px; padding:12px; background:var(--card); }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.stack > * + * { margin-top:8px; }
button { border:1px solid var(--accent); border-radius:6px; background:var(--accent);
  color:var(--accent-fg); cursor:pointer; font:inherit; padding:5px 10px; }
button.secondary { background:transparent; color:var(--accent); }
button:disabled { cursor:default; opacity:.6; }
input, select { font:inherit; color:inherit; background:var(--card); border:1px solid var(--border);
  border-radius:6px; padding:4px 6px; }
table { border-collapse:collapse; width:100%; }
th, td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--border); vertical-align:top; }
.badge { display:inline-block; border-radius:999px; padding:0 8px; font-size:12px; font-weight:600;
  color:var(--accent); border:1px solid var(--accent); }
`;

export const installStyles = (root, catalog) => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const apply = () => {
    document.documentElement.dataset.mode = catalog.theme?.color_mode ?? 'light';
  };
  root.addEventListener('catalog:theme-changed.v1', apply);
  apply();
  return () => {
    root.removeEventListener('catalog:theme-changed.v1', apply);
    style.remove();
  };
};

/* Minimal DOM builder: el('p', {class: 'muted'}, 'text', child). */
export const el = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      node.addEventListener(name.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

/* Mounts a render function that reruns on every host context update and
 * ignores results from renders superseded by a newer context. */
export const mountRenderer = (root, catalog, render) => {
  const removeStyles = installStyles(root, catalog);
  let generation = 0;
  let disposed = false;
  const run = async () => {
    const current = ++generation;
    const isCurrent = () => !disposed && current === generation;
    try {
      const content = await render(catalog.context ?? {}, isCurrent);
      if (isCurrent()) root.replaceChildren(...[content].flat().filter(Boolean));
    } catch (error) {
      if (isCurrent()) root.replaceChildren(el('p', { class: 'error' }, error?.message || String(error)));
    }
  };
  // The host may re-send an unchanged context; re-rendering then would discard
  // in-progress UI state such as a pending save message.
  let lastContext = JSON.stringify(catalog.context ?? {});
  const onContext = () => {
    const next = JSON.stringify(catalog.context ?? {});
    if (next === lastContext) return;
    lastContext = next;
    void run();
  };
  root.addEventListener('catalog:context-changed.v1', onContext);
  void run();
  return {
    rerender: run,
    cleanup: () => {
      disposed = true;
      root.removeEventListener('catalog:context-changed.v1', onContext);
      removeStyles();
      root.replaceChildren();
    },
  };
};
