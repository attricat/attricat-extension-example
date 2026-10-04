/* action_dialog: starts the interactive `recalculate-selection` operation for
 * the captured selection, follows the run, and downloads its CSV report.
 * Demonstrates `catalog.operations.*` and `catalog.dialog.close`. */
import { command, el, installStyles, loadFormulaIndex } from './lib.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const mount = (root, catalog) => {
  const removeStyles = installStyles(root, catalog);
  let disposed = false;
  const context = catalog.context ?? {};
  const ids = context.entity_ids ?? [];
  const close = () => void catalog.dialog.close();
  const onKey = (event) => event.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  const status = el('p', { 'aria-live': 'polite', class: 'muted' });
  const body = el('div', { class: 'stack' }, el('p', { class: 'muted' }, 'Loading formulas…'));
  root.replaceChildren(body);

  const follow = async (runId) => {
    for (;;) {
      if (disposed) return null;
      const run = await catalog.operations.get({ run_id: runId });
      const progress = run.progress ?? {};
      status.textContent = `${run.status} · ${progress.completed ?? 0}/${progress.total ?? ids.length}`;
      if (TERMINAL.has(run.status)) return run;
      await sleep(1000);
    }
  };

  const showResult = (run) => {
    const outcome = run.progress?.outcome ?? {};
    status.className = run.status === 'completed' ? 'ok' : 'error';
    status.textContent =
      run.status === 'completed'
        ? `Completed: ${outcome.succeeded ?? 0} succeeded, ${outcome.failed ?? 0} failed, ${outcome.skipped ?? 0} skipped.`
        : `Run ${run.status}${run.failure ? `: ${run.failure.message ?? run.failure}` : ''}.`;
    const actions = el('div', { class: 'row' });
    for (const artifact of run.artifacts ?? []) {
      const artifactId = artifact.id ?? artifact.artifact_id;
      actions.append(
        el('button', { type: 'button', onclick: () => catalog.operations.download({ run_id: run.id, artifact_id: artifactId }) }, `Download ${artifact.name ?? 'report'}`),
      );
    }
    actions.append(el('button', { type: 'button', class: 'secondary', onclick: close }, 'Close'));
    body.append(actions);
  };

  const render = (index) => {
    const formulas = index?.formulas ?? [];
    if (index?.error || !formulas.length) {
      body.replaceChildren(
        el('p', { class: index?.error ? 'error' : 'muted' }, index?.error ?? 'This blueprint revision declares no formulas.'),
        el('button', { type: 'button', class: 'secondary', onclick: close }, 'Close'),
      );
      return;
    }
    const mode = el('select', { 'aria-label': 'Mode' },
      el('option', { value: 'write' }, 'Update stale computed values'),
      el('option', { value: 'report' }, 'Report only (no writes)'));
    const start = el('button', { type: 'button' }, 'Start');
    start.addEventListener('click', async () => {
      start.disabled = true;
      mode.disabled = true;
      try {
        const { run_id: runId } = await catalog.operations.start({
          operation_id: 'recalculate-selection',
          input: { mode: mode.value },
          idempotency_key: `recalc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        });
        const run = await follow(runId);
        if (run) {
          controls.remove();
          showResult(run);
        }
      } catch (error) {
        status.className = 'error';
        status.textContent = error.message || 'The run could not be started.';
        start.disabled = false;
        mode.disabled = false;
      }
    });
    const controls = el('div', { class: 'row' }, mode, start, el('button', { type: 'button', class: 'secondary', onclick: close }, 'Cancel'));
    body.replaceChildren(
      el('p', {}, `${ids.length} selected ${ids.length === 1 ? 'entity' : 'entities'} · context ${context.context_id ? context.context_id.slice(0, 8) : 'default'}`),
      el('ul', {}, formulas.map((formula) => el('li', {}, el('code', {}, `${formula.target_code} = ${formula.expression}`)))),
      controls,
      status,
    );
  };

  (async () => {
    try {
      // The run reads formulas from the stored index; make sure it exists.
      let index = await loadFormulaIndex(catalog, context.blueprint_id, context.blueprint_version);
      if (!index && ids[0]) index = await command(catalog, 'describe-formulas', { entity_id: ids[0], context_id: null });
      if (!disposed) render(index);
    } catch (error) {
      body.replaceChildren(el('p', { class: 'error' }, error.message), el('button', { type: 'button', onclick: close }, 'Close'));
    }
  })();

  return () => {
    disposed = true;
    document.removeEventListener('keydown', onKey);
    removeStyles();
    root.replaceChildren();
  };
};
