/* route: Document templates. Lists, creates, edits and deletes the templates
 * the generate-documents operation renders, through the list-templates,
 * save-template and delete-template commands. Each save bumps a template's
 * version; the action dialog starts runs of the version it shows, and a run
 * snapshots that version, so edits never change a started run. */
import { Fragment, h, render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { command, installStyles } from './lib.js';

const LAYOUTS = {
  summary: 'Summary: the chosen saved values, one per line',
  label: 'Label: title, record ID and content fingerprint',
};

const blank = () => ({ id: '', name: '', layout: 'summary', heading: '', attributes: [] });

const Editor = ({ attricat, template, onSaved, onCancel }) => {
  const isNew = template.version === undefined;
  const [draft, setDraft] = useState({ ...template, attributes: template.attributes.join(', ') });
  const [status, setStatus] = useState(null);
  const field = (key) => (event) => setDraft({ ...draft, [key]: event.currentTarget.value });

  const save = async () => {
    setStatus({ saving: true });
    const attributes = draft.layout === 'label'
      ? []
      : draft.attributes.split(',').map((code) => code.trim()).filter(Boolean);
    try {
      const { templates } = await command(attricat, 'save-template', {
        template: {
          id: draft.id.trim(),
          name: draft.name.trim(),
          layout: draft.layout,
          heading: draft.heading.trim(),
          attributes,
        },
        expected_version: isNew ? null : template.version,
      });
      onSaved(templates, `Saved ${draft.name.trim()}.`);
    } catch (error) {
      setStatus({ error: error.message || 'The template could not be saved.' });
    }
  };

  return (
    <section class="card stack" aria-label={isNew ? 'New template' : `Edit ${template.name}`}>
      <h2>{isNew ? 'New template' : `Edit ${template.name} (version ${template.version})`}</h2>
      <label class="stack">
        <span>Template ID</span>
        <input value={draft.id} disabled={!isNew} onInput={field('id')} aria-describedby="template-id-help" />
        <span id="template-id-help" class="muted">Lowercase letters, digits, - or _. Cannot change later.</span>
      </label>
      <label class="stack">
        <span>Name</span>
        <input value={draft.name} onInput={field('name')} />
      </label>
      <label class="stack">
        <span>Layout</span>
        <select value={draft.layout} onChange={field('layout')}>
          {Object.entries(LAYOUTS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </label>
      <label class="stack">
        <span>Heading</span>
        <input value={draft.heading} onInput={field('heading')} placeholder="Printed above every page" />
      </label>
      {draft.layout === 'summary' && (
        <label class="stack">
          <span>Attributes</span>
          <input value={draft.attributes} onInput={field('attributes')} placeholder="title, price_net, price_gross" />
          <span class="muted">Attribute codes in print order, separated by commas. Empty prints every saved value.</span>
        </label>
      )}
      <div class="row">
        <button type="button" disabled={status?.saving} onClick={save}>Save template</button>
        <button type="button" class="secondary" onClick={onCancel}>Discard changes</button>
      </div>
      {status?.error && <p class="error" role="alert">{status.error}</p>}
    </section>
  );
};

const App = ({ attricat }) => {
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => {
    command(attricat, 'list-templates', {}).then(
      (result) => setTemplates(result.templates),
      (failure) => setError(failure.message || String(failure)),
    );
  }, [attricat]);
  useEffect(load, [load]);

  const saved = (next, message) => {
    setTemplates(next);
    setEditing(null);
    setNotice(message);
  };

  const remove = async (template) => {
    try {
      saved((await command(attricat, 'delete-template', { id: template.id })).templates, `Deleted ${template.name}.`);
    } catch (failure) {
      setNotice(null);
      setError(failure.message || 'The template could not be deleted.');
    }
  };

  return (
    <main class="stack" style="max-width:960px;padding:16px 20px" aria-labelledby="templates-title">
      <h1 id="templates-title" style="font-size:1.4rem;margin:0">Document templates</h1>
      <p class="muted">
        Templates for <strong>Generate documents</strong> in the record and Explorer actions. A run uses
        the template version it was started with.
      </p>
      {error && <p class="error" role="alert">{error}</p>}
      {notice && <p class="ok" role="status">{notice}</p>}
      {!templates ? (
        !error && <p class="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr><th>Name</th><th>ID</th><th>Layout</th><th>Prints</th><th>Version</th><th><span class="muted">Actions</span></th></tr>
          </thead>
          <tbody>
            {templates.map((template) => (
              <tr key={template.id}>
                <td>{template.name}{template.builtin && <> <span class="badge">built-in</span></>}</td>
                <td><code>{template.id}</code></td>
                <td>{template.layout}</td>
                <td>{template.layout === 'label' ? 'title, ID, fingerprint' : template.attributes.length ? template.attributes.join(', ') : 'every saved value'}</td>
                <td>{template.version}</td>
                <td class="row">
                  <button type="button" class="secondary" aria-label={`Edit ${template.name}`} onClick={() => { setNotice(null); setEditing(template); }}>Edit</button>
                  {!template.builtin && (
                    <button type="button" class="secondary" aria-label={`Delete ${template.name}`} onClick={() => remove(template)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <Editor key={editing.id || 'new'} attricat={attricat} template={editing} onSaved={saved} onCancel={() => setEditing(null)} />
      ) : (
        templates && <div class="row"><button type="button" onClick={() => { setNotice(null); setEditing(blank()); }}>New template</button></div>
      )}
    </main>
  );
};

export const mount = (root, attricat) => {
  const removeStyles = installStyles(root, attricat);
  render(<App attricat={attricat} />, root);
  return () => {
    render(null, root);
    removeStyles();
  };
};
