/* The "Generate documents" dialog's task: starts the interactive
 * `generate-documents` operation (separate PDFs, a ZIP archive or one combined
 * PDF), follows the run and offers its downloads. The host dialog provides
 * the close control; closing never cancels a started run, which stays listed
 * under Profile → Extension runs. Demonstrates `attricat.operations.cancel`. */
import { command, el } from './lib.js';

const OPERATION = 'generate-documents';
const POLL_MS = 2000;
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const STATUS = {
  queued: 'Queued',
  running: 'Running',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
  completed: 'Completed',
  failed: 'Failed',
};

const newKey = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `doc-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const select = (id, label, options) => {
  const control = el('select', { id }, options.map(([value, text]) => el('option', { value }, text)));
  return el('div', { class: 'stack' }, el('label', { for: id }, label), control);
};

const outcomeText = (progress) => {
  const outcome = progress?.outcome;
  if (!outcome) return '';
  return ` · ${outcome.succeeded ?? 0} generated, ${outcome.failed ?? 0} failed, ${outcome.skipped ?? 0} skipped`;
};

export const mountDocuments = (body, attricat) => {
  let disposed = false;
  let timer;
  let pendingKey;
  let currentRun;

  const count = attricat.context?.record_ids?.length ?? 0;
  // Templates come from the Document templates route; a run renders the
  // version listed here.
  const templateField = select('template', 'Template', []);
  let versions = {};
  const outputField = select('output', 'Output', [
    ['individual', 'Separate PDFs'],
    ['zip', 'ZIP archive'],
    ['combined', 'One combined PDF'],
  ]);
  const template = templateField.querySelector('select');
  const output = outputField.querySelector('select');
  const generate = el('button', { type: 'button' }, 'Generate');
  const cancel = el('button', { type: 'button', class: 'secondary', hidden: true }, 'Cancel run');
  const status = el('p', { role: 'status', 'aria-live': 'polite', class: 'muted' });
  const downloads = el('ul', { hidden: true, 'aria-label': 'Generated files' });

  const showRun = (run) => {
    currentRun = run;
    status.textContent = `Run ${STATUS[run.status] ?? run.status}${outcomeText(run.progress)}`;
    cancel.hidden = !run.can_cancel;
    const files = run.status === 'completed' ? run.artifacts ?? [] : [];
    downloads.hidden = files.length === 0;
    downloads.replaceChildren(
      ...files.map((artifact) =>
        el('li', {}, el('button', {
          type: 'button',
          class: 'secondary',
          onclick: () =>
            attricat.operations.download({ run_id: run.id, artifact_id: artifact.id }).catch(() => {
              status.textContent = 'The download is no longer available.';
            }),
        }, `Download ${artifact.name ?? 'file'}`)),
      ),
    );
    if (run.status === 'completed' && run.outputs_expired) status.textContent += ' · downloads have expired';
  };

  const poll = async (runId) => {
    clearTimeout(timer);
    try {
      const run = await attricat.operations.get({ run_id: runId });
      if (disposed || currentRun?.id !== runId) return;
      showRun(run);
      if (ACTIVE.has(run.status)) timer = setTimeout(() => poll(runId), POLL_MS);
    } catch {
      if (!disposed) status.textContent = 'The run status could not be loaded.';
    }
  };

  const follow = (runId) => {
    currentRun = { id: runId };
    poll(runId);
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
      const { run_id } = await attricat.operations.start({
        operation_id: OPERATION,
        input: { template: template.value, template_version: versions[template.value], output: output.value },
        idempotency_key: pendingKey,
      });
      pendingKey = undefined;
      follow(run_id);
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
      await attricat.operations.cancel({ run_id: currentRun.id });
      poll(currentRun.id);
    } catch {
      status.textContent = 'The run could not be cancelled.';
    } finally {
      cancel.disabled = false;
    }
  });

  body.replaceChildren(
    el('p', { class: 'muted' },
      `${count} ${count === 1 ? 'record' : 'records'} captured. Closing this dialog does not cancel a started run; follow it under Profile → Extension runs.`),
    templateField,
    outputField,
    el('div', { class: 'row' }, generate, cancel),
    status,
    downloads,
  );
  generate.disabled = true;
  command(attricat, 'list-templates', {}).then(
    ({ templates }) => {
      if (disposed) return;
      versions = Object.fromEntries(templates.map((item) => [item.id, item.version]));
      template.replaceChildren(...templates.map((item) => el('option', { value: item.id }, `${item.name} (v${item.version})`)));
      generate.disabled = templates.length === 0;
    },
    () => {
      if (!disposed) status.textContent = 'Templates could not be loaded.';
    },
  );

  return () => {
    disposed = true;
    clearTimeout(timer);
  };
};
