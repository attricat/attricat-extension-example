/* route: the Formula workbench application. One host route
 * (/extensions/attricat-extension-example/formula-workbench) mounts this
 * Preact app; its screens are in-memory routes, so the host URL never changes. */
import { Fragment, h, render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { command, formatNumber, installStyles, shortId } from './lib.js';

const FEATURES = [
  ['Event handler', 'entity.updated.v1 recalculates formulas in the context that changed', 'server.event_handlers'],
  ['Commands', 'describe, preview, recalculate, attribute settings, activity', 'server.commands · client.commands'],
  ['Interactive operation', 'recalculate a selection, write or report, CSV output, annotations', 'server.operations · selection · catalog-data · artifacts'],
  ['Scoped configuration', 'per-attribute rounding and unit for each blueprint revision', 'scoped_configuration'],
  ['Extension storage', 'formula index and activity log shared by server and panels', 'storage.extension'],
  ['Event contract', 'publishes plugin.attricat-extension-example.formula_recalculated.v1', 'event_contracts · events.emit'],
  ['Route + navigation', 'this workbench', 'route · navigation'],
  ['Entity preview panel', 'formulas evaluated in the selected context, preview, recalculate', 'entity_preview_panel'],
  ['Attribute decoration', '⚡ Computed badge on formula targets', 'entity_attribute_decoration'],
  ['Entity action', 'one-click recalculation with host refresh', 'entity_action · client.refresh'],
  ['Selection actions + dialog', 'row and bulk actions open the host dialog that starts the run', 'explorer_row_action v2 · explorer_bulk_action v2 · action_dialog'],
  ['Table cell renderer', 'computed-number with precision/unit props', 'explorer_table_cell · cell_renderers'],
  ['Attribute settings', 'rounding/unit editor in the blueprint editor', 'blueprint_attribute_configuration'],
  ['Read-only panels', 'attribute inputs, blueprint formulas, health counters', 'entity_attribute_panel · blueprint_detail_panel · data_health_card'],
];

const Overview = () => (
  <>
    <p>
      Computed numeric attributes declared in blueprint TOML, recalculated in the context where an
      input changes. Every part of this extension exists to show one piece of the{' '}
      <code>catalog:host@1.6.0</code> extension surface.
    </p>
    <table>
      <thead>
        <tr><th>Feature</th><th>What it does</th><th>Surface</th></tr>
      </thead>
      <tbody>
        {FEATURES.map(([name, what, surface]) => (
          <tr key={name}><td>{name}</td><td>{what}</td><td><code>{surface}</code></td></tr>
        ))}
      </tbody>
    </table>
  </>
);

const useLoad = (load) => {
  const [state, setState] = useState({ loading: true });
  const reload = useCallback(() => {
    setState((current) => ({ ...current, loading: true }));
    load().then(
      (data) => setState({ data }),
      (error) => setState({ error: error.message || String(error) }),
    );
  }, [load]);
  useEffect(reload, [reload]);
  return [state, reload];
};

const Activity = ({ catalog }) => {
  const [{ data, error, loading }, reload] = useLoad(
    useCallback(() => command(catalog, 'recent-activity', {}), [catalog]),
  );
  if (error) return <p class="error">{error}</p>;
  if (!data) return <p class="muted">Loading…</p>;
  const { stats, entries } = data;
  return (
    <div class="stack">
      <div class="row">
        <span><strong>{stats.evaluations}</strong> evaluations</span>
        <span><strong>{stats.writes}</strong> writes</span>
        <span class={stats.errors ? 'error' : ''}><strong>{stats.errors}</strong> errors</span>
        <span><strong>{stats.runs}</strong> runs</span>
        <button type="button" class="secondary" disabled={loading} onClick={reload}>Refresh</button>
      </div>
      {entries.length === 0 ? (
        <p class="muted">No activity yet. Update a formula input on an entity.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Source</th><th>Entity</th><th>Target</th><th>Context</th><th>Result</th></tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={index}>
                <td>{entry.source}</td>
                <td>
                  {entry.entity_id ? (
                    <button type="button" class="secondary" onClick={() => catalog.navigate({ entity_id: entry.entity_id })}>
                      {shortId(entry.entity_id)}
                    </button>
                  ) : '—'}
                </td>
                <td>{entry.target_code ?? '—'}</td>
                <td>{shortId(entry.context_id)}</td>
                <td class={entry.error ? 'error' : ''}>
                  {entry.error ?? (entry.source === 'run'
                    ? `${entry.result ?? 0} updated`
                    : `${formatNumber(entry.result)}${entry.written ? ' · written' : ''}`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const Runs = ({ catalog }) => {
  const [{ data, error, loading }, reload] = useLoad(
    useCallback(async () => {
      const listed = await catalog.operations.list();
      return Array.isArray(listed) ? listed : listed?.runs ?? listed?.items ?? [];
    }, [catalog]),
  );
  const download = async (runId) => {
    try {
      const run = await catalog.operations.get({ run_id: runId });
      const artifact = run.artifacts?.[0];
      if (!artifact) return catalog.notify({ message: 'This run has no downloadable output.' });
      await catalog.operations.download({ run_id: runId, artifact_id: artifact.id ?? artifact.artifact_id });
    } catch (failure) {
      await catalog.notify({ message: failure.message, severity: 'error' });
    }
  };
  if (error) return <p class="error">{error}</p>;
  if (!data) return <p class="muted">Loading…</p>;
  return (
    <div class="stack">
      <div class="row">
        <span class="muted">Your recent recalculation runs.</span>
        <button type="button" class="secondary" disabled={loading} onClick={reload}>Refresh</button>
      </div>
      {data.length === 0 ? (
        <p class="muted">No runs yet. Select entities in Explorer and choose “Recalculate formulas…”.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Run</th><th>Status</th><th>Entities</th><th>Outcome</th><th /></tr>
          </thead>
          <tbody>
            {data.map((run) => {
              const outcome = run.progress?.outcome;
              return (
                <tr key={run.id}>
                  <td><code>{shortId(run.id)}</code></td>
                  <td>{run.status}</td>
                  <td>{run.selection_count ?? '—'}</td>
                  <td>{outcome ? `${outcome.succeeded} ok · ${outcome.failed} failed · ${outcome.skipped} skipped` : '—'}</td>
                  <td>
                    {run.status === 'completed' && (
                      <button type="button" class="secondary" onClick={() => download(run.id)}>Report</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};

const Syntax = () => (
  <>
    <p>Formulas are immutable blueprint metadata. The key is the numeric target attribute code; the value is its expression.</p>
    <pre aria-label="Example formula configuration"><code>{`[extensions.attricat-extension-example.formulas]
price_gross = "price_net * (1 + vat_rate)"`}</code></pre>
    <p>
      Expressions use numeric literals, numeric attribute codes, <code>+ - * /</code>, unary minus and
      parentheses. Cycles, self-references and non-numeric attributes are rejected. Rounding and units
      are configured per attribute in the blueprint editor.
    </p>
    <p>Show computed values in Explorer tables with the cell renderer:</p>
    <pre><code>{`[[views.table.columns]]
field = "price_gross"
renderer = { id = "attricat-extension-example.computed-number", version = 1, props = { precision = 2, unit = "EUR" } }`}</code></pre>
  </>
);

const SCREENS = {
  overview: ['Overview', Overview],
  activity: ['Activity', Activity],
  runs: ['Runs', Runs],
  syntax: ['Formula syntax', Syntax],
};

const App = ({ catalog }) => {
  const [screen, setScreen] = useState('overview');
  const [title, Screen] = SCREENS[screen];
  return (
    <main class="stack" style="max-width:960px;padding:16px 20px" aria-labelledby="app-title">
      <h1 id="app-title" style="font-size:1.4rem;margin:0">Formula workbench</h1>
      <nav class="row" aria-label="Formula workbench">
        {Object.entries(SCREENS).map(([key, [label]]) => (
          <button
            key={key}
            type="button"
            class={key === screen ? '' : 'secondary'}
            aria-current={key === screen ? 'page' : undefined}
            onClick={() => setScreen(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      <section aria-label={title}>
        <Screen catalog={catalog} />
      </section>
    </main>
  );
};

export const mount = (root, catalog) => {
  const removeStyles = installStyles(root, catalog);
  render(<App catalog={catalog} />, root);
  return () => {
    render(null, root);
    removeStyles();
  };
};
