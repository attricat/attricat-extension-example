// Document configuration and run follow-up inside the host-managed dialog.
// The selection is the host-captured context; closing the dialog never
// cancels a started run, which stays listed under Profile → Extension runs.
const OPERATION = 'generate-documents';
const POLL_MS = 2000;
const RECENT_RUNS = 5;
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const STATUS = {
  queued: 'Queued',
  running: 'Running',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
  completed: 'Completed',
  failed: 'Failed',
};
const palette = {
  light: { fg: '#1f2328', muted: '#59636e', border: '#d1d9e0', bg: '#ffffff', accent: '#0969da', accentFg: '#ffffff', danger: '#cf222e' },
  dark: { fg: '#e6edf3', muted: '#9198a1', border: '#3d444d', bg: '#0d1117', accent: '#4493f8', accentFg: '#0d1117', danger: '#f85149' },
};

const newKey = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `doc-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const element = (tag, properties = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
};

const select = (id, label, options) => {
  const control = element(
    'select',
    { id },
    options.map(([value, text]) => element('option', { value, textContent: text })),
  );
  return [element('label', { htmlFor: id, textContent: label }), control];
};

const outcomeText = (progress) => {
  const outcome = progress?.outcome;
  if (!outcome) return '';
  return ` · ${outcome.succeeded ?? 0} generated, ${outcome.failed ?? 0} failed, ${outcome.skipped ?? 0} skipped`;
};

export const mount = (root, catalog) => {
  let disposed = false;
  let timer;
  let pendingKey;
  let currentRun;

  const style = element('style');
  const applyTheme = () => {
    const c = palette[catalog.theme?.color_mode] ?? palette.light;
    style.textContent = `
      .doc { font: 14px/20px system-ui, sans-serif; color: ${c.fg}; display: grid; gap: 12px; }
      .doc p { margin: 0; color: ${c.muted}; }
      .doc .field { display: grid; gap: 4px; }
      .doc label { font-weight: 600; }
      .doc select, .doc button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid ${c.border}; background: ${c.bg}; color: ${c.fg}; }
      .doc button { cursor: pointer; }
      .doc button.primary { background: ${c.accent}; color: ${c.accentFg}; border-color: ${c.accent}; }
      .doc button.danger { color: ${c.danger}; }
      .doc button:disabled { opacity: .6; cursor: default; }
      .doc .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .doc ul { margin: 0; padding-left: 18px; }
      .doc h3 { margin: 4px 0 0; font-size: 14px; }
    `;
  };

  const count = catalog.context?.entity_ids?.length ?? 0;
  const [templateLabel, template] = select('template', 'Template', [
    ['summary', 'Summary sheet'],
    ['label', 'Product label'],
  ]);
  const [outputLabel, output] = select('output', 'Output', [
    ['individual', 'Separate PDFs'],
    ['zip', 'ZIP archive'],
    ['combined', 'One combined PDF'],
  ]);
  const generate = element('button', { type: 'button', className: 'primary', textContent: 'Generate' });
  const cancel = element('button', { type: 'button', className: 'danger', textContent: 'Cancel run', hidden: true });
  const close = element('button', { type: 'button', textContent: 'Close' });
  const status = element('p', { role: 'status' });
  status.setAttribute('aria-live', 'polite');
  const downloads = element('ul', { hidden: true });
  downloads.setAttribute('aria-label', 'Generated files');
  const recent = element('ul');
  recent.setAttribute('aria-label', 'Recent document runs');

  const showRun = (run) => {
    currentRun = run;
    status.textContent = `Run ${STATUS[run.status] ?? run.status}${outcomeText(run.progress)}`;
    cancel.hidden = !run.can_cancel;
    const files = run.status === 'completed' ? run.artifacts ?? [] : [];
    downloads.hidden = files.length === 0;
    downloads.replaceChildren(
      ...files.map((artifact) => {
        const download = element('button', {
          type: 'button',
          textContent: `Download ${artifact.name ?? 'file'}`,
        });
        download.addEventListener('click', () =>
          catalog.operations
            .download({ run_id: run.id, artifact_id: artifact.id })
            .catch(() => {
              status.textContent = 'The download is no longer available.';
            }),
        );
        return element('li', {}, [download]);
      }),
    );
    if (run.status === 'completed' && run.outputs_expired)
      status.textContent += ' · downloads have expired';
  };

  const poll = async (runId) => {
    clearTimeout(timer);
    try {
      const run = await catalog.operations.get({ run_id: runId });
      if (disposed || currentRun?.id !== runId) return;
      showRun(run);
      if (ACTIVE.has(run.status)) timer = setTimeout(() => poll(runId), POLL_MS);
      else refreshRecent();
    } catch {
      if (!disposed) status.textContent = 'The run status could not be loaded.';
    }
  };

  const follow = (runId) => {
    currentRun = { id: runId };
    poll(runId);
  };

  const refreshRecent = async () => {
    try {
      const runs = (await catalog.operations.list())
        .filter((run) => run.operation_id === OPERATION)
        .slice(0, RECENT_RUNS);
      if (disposed) return;
      recent.replaceChildren(
        ...runs.map((run) => {
          const open = element('button', {
            type: 'button',
            textContent: `${STATUS[run.status] ?? run.status} · ${run.selection_count} entities · ${new Date(run.created_at).toLocaleString()}`,
          });
          open.addEventListener('click', () => follow(run.id));
          return element('li', {}, [open]);
        }),
      );
    } catch {
      recent.replaceChildren();
    }
  };

  // A changed request must not reuse a key that may already name a run.
  const resetKey = () => {
    pendingKey = undefined;
  };
  template.addEventListener('change', resetKey);
  output.addEventListener('change', resetKey);

  generate.addEventListener('click', async () => {
    generate.disabled = true;
    pendingKey ??= newKey();
    status.textContent = 'Starting…';
    try {
      const { run_id } = await catalog.operations.start({
        operation_id: OPERATION,
        input: { template: template.value, template_version: 1, output: output.value },
        idempotency_key: pendingKey,
      });
      pendingKey = undefined;
      follow(run_id);
      refreshRecent();
    } catch {
      // Keep the key: retrying the same request returns the same run.
      status.textContent = 'The run could not be started. Try again.';
    } finally {
      generate.disabled = false;
    }
  });
  cancel.addEventListener('click', async () => {
    if (!currentRun) return;
    cancel.disabled = true;
    try {
      await catalog.operations.cancel({ run_id: currentRun.id });
      poll(currentRun.id);
    } catch {
      status.textContent = 'The run could not be cancelled.';
    } finally {
      cancel.disabled = false;
    }
  });
  close.addEventListener('click', () => catalog.dialog.close());
  // Key presses inside this sandboxed frame never reach the host page, so the
  // host dialog cannot see Escape. Close it explicitly.
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void catalog.dialog.close();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  root.addEventListener('catalog:theme-changed.v1', applyTheme);
  applyTheme();
  root.replaceChildren(
    style,
    element('div', { className: 'doc' }, [
      element('p', {
        textContent: `${count} ${count === 1 ? 'entity' : 'entities'} captured. Closing this dialog does not cancel a started run; follow it under Profile → Extension runs.`,
      }),
      element('div', { className: 'field' }, [templateLabel, template]),
      element('div', { className: 'field' }, [outputLabel, output]),
      element('div', { className: 'row' }, [generate, cancel, close]),
      status,
      downloads,
      element('h3', { textContent: 'Recent runs' }),
      recent,
    ]),
  );
  refreshRecent();

  return () => {
    disposed = true;
    document.removeEventListener('keydown', onKeyDown);
    clearTimeout(timer);
    root.removeEventListener('catalog:theme-changed.v1', applyTheme);
    root.replaceChildren();
  };
};
