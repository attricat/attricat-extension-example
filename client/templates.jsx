/* route: Document templates. Every template has its own embedded editor: a
 * title line and a body in which `{{ attribute_code }}` marks are replaced
 * with the record's saved values when a document is rendered, plus the
 * `{{ record.id }}`, `{{ record.fingerprint }}` and `{{ record.values }}`
 * marks. Saving goes through the save-template command, which validates the
 * marks again and bumps the template's version; the action dialog starts runs
 * of the version it shows, and a run snapshots that version. */
import { Fragment, h, render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { command, installStyles } from './lib.js';

const RECORD_MARKS = {
  'record.id': 'the record ID',
  'record.fingerprint': 'a fingerprint of the printed content',
  'record.values': 'every saved value, one per line',
};
const CODE = /^[a-z0-9_-]{1,64}$/;
const FIELD = 'display:grid;gap:4px';
const WIDE = 'width:100%;box-sizing:border-box';

/* Mirrors the server's parser (documents/templates.rs) for live feedback. */
const parse = (text) => {
  const parts = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf('{{');
    if (start < 0) break;
    if (start > 0) parts.push({ text: rest.slice(0, start) });
    const end = rest.indexOf('}}', start + 2);
    if (end < 0) return { parts, error: 'A {{ mark is not closed with }}.' };
    const name = rest.slice(start + 2, end).trim();
    if (!CODE.test(name) && !(name in RECORD_MARKS)) {
      return { parts, error: `{{ ${name} }} is not an attribute code or a record.* mark.` };
    }
    parts.push({ mark: name });
    rest = rest.slice(end + 2);
  }
  if (rest) parts.push({ text: rest });
  return { parts, error: null };
};

const Preview = ({ parts }) => (
  <>
    {parts.map((part, index) =>
      part.mark ? <mark key={index} title={RECORD_MARKS[part.mark] ?? `the saved ${part.mark} value`}>{part.mark}</mark> : part.text,
    )}
  </>
);

const TemplateEditor = ({ attricat, template, onSaved, onDeleted, onDiscard }) => {
  const isNew = template.version === undefined;
  const [draft, setDraft] = useState(template);
  const [status, setStatus] = useState(null);
  const [code, setCode] = useState('');
  const body = useRef(null);
  const set = (key) => (event) => setDraft({ ...draft, [key]: event.currentTarget.value });

  const title = parse(draft.title);
  const parsedBody = parse(draft.body);
  const markError = title.error ? `Title: ${title.error}` : parsedBody.error ? `Body: ${parsedBody.error}` : null;
  const changed = ['id', 'name', 'title', 'body'].some((key) => draft[key] !== template[key]);
  const codes = [...new Set([...title.parts, ...parsedBody.parts].filter((part) => part.mark).map((part) => part.mark))];

  // Inserts a mark at the body's caret, so marks need not be typed by hand.
  const insert = (name) => {
    const element = body.current;
    const mark = `{{ ${name} }}`;
    const at = element ? element.selectionStart : draft.body.length;
    const to = element ? element.selectionEnd : at;
    setDraft({ ...draft, body: draft.body.slice(0, at) + mark + draft.body.slice(to) });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(at + mark.length, at + mark.length);
    });
  };

  const save = async () => {
    setStatus({ busy: true });
    try {
      const { templates } = await command(attricat, 'save-template', {
        template: { id: draft.id.trim(), name: draft.name.trim(), title: draft.title, body: draft.body },
        expected_version: isNew ? null : template.version,
      });
      onSaved(templates, `Saved ${draft.name.trim()}.`);
    } catch (error) {
      setStatus({ error: error.message || 'The template could not be saved.' });
    }
  };

  const remove = async () => {
    setStatus({ busy: true });
    try {
      onDeleted((await command(attricat, 'delete-template', { id: template.id })).templates, `Deleted ${template.name}.`);
    } catch (error) {
      setStatus({ error: error.message || 'The template could not be deleted.' });
    }
  };

  const field = (key) => `template-${template.id || 'new'}-${key}`;
  return (
    <section class="card stack" aria-label={isNew ? 'New template' : `Template ${template.name}`}>
      <div class="row">
        <h2 style="margin:0">{isNew ? 'New template' : template.name}</h2>
        {!isNew && <span class="muted"><code>{template.id}</code> · version {template.version}</span>}
        {template.builtin && <span class="badge">built-in</span>}
      </div>
      {isNew && (
        <label style={FIELD} for={field('id')}>
          <span>Template ID</span>
          <input id={field('id')} value={draft.id} onInput={set('id')} placeholder="price-sheet" style={WIDE} />
        </label>
      )}
      <label style={FIELD} for={field('name')}>
        <span>Name</span>
        <input id={field('name')} value={draft.name} onInput={set('name')} style={WIDE} />
      </label>
      <label style={FIELD} for={field('title')}>
        <span>Title</span>
        <input id={field('title')} value={draft.title} onInput={set('title')} placeholder="{{ title }}" style={`${WIDE};font-family:ui-monospace,monospace`} />
      </label>
      <label style={FIELD} for={field('body')}>
        <span>Body</span>
        <textarea
          id={field('body')}
          ref={body}
          rows={8}
          value={draft.body}
          onInput={set('body')}
          spellcheck={false}
          style="font:13px/1.5 ui-monospace,monospace;width:100%;box-sizing:border-box;color:inherit;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:6px"
        />
      </label>
      <div class="row" role="group" aria-label="Insert a mark">
        <span class="muted">Insert:</span>
        {Object.keys(RECORD_MARKS).map((name) => (
          <button key={name} type="button" class="secondary" title={`Inserts ${RECORD_MARKS[name]}`} onClick={() => insert(name)}>{`{{ ${name} }}`}</button>
        ))}
        <input aria-label="Attribute code to insert" value={code} onInput={(event) => setCode(event.currentTarget.value.trim())} placeholder="attribute_code" size={16} />
        <button type="button" class="secondary" disabled={!CODE.test(code)} onClick={() => { insert(code); setCode(''); }}>Insert attribute</button>
      </div>
      {markError ? (
        <p class="error" role="alert">{markError}</p>
      ) : (
        <div class="stack">
          <span class="muted">Preview — highlighted marks are replaced with each record's saved values; a missing value prints as “-”.</span>
          <pre aria-label="Preview" style="white-space:pre-wrap"><strong><Preview parts={title.parts} /></strong>{'\n\n'}<Preview parts={parsedBody.parts} /></pre>
          <span class="muted">Marks used: {codes.length ? codes.join(', ') : 'none'}</span>
        </div>
      )}
      <div class="row">
        <button type="button" disabled={status?.busy || !changed || Boolean(markError)} onClick={save}>{isNew ? 'Create template' : 'Save template'}</button>
        <button type="button" class="secondary" disabled={!changed && !isNew} onClick={() => (isNew ? onDiscard() : setDraft(template))}>Discard changes</button>
        {!isNew && !template.builtin && (
          <button type="button" class="secondary" disabled={status?.busy} onClick={remove}>Delete template</button>
        )}
      </div>
      {status?.error && <p class="error" role="alert">{status.error}</p>}
    </section>
  );
};

const App = ({ attricat }) => {
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    command(attricat, 'list-templates', {}).then(
      (result) => setTemplates(result.templates),
      (failure) => setError(failure.message || String(failure)),
    );
  }, [attricat]);
  useEffect(load, [load]);

  const changed = (next, message) => {
    setTemplates(next);
    setCreating(false);
    setNotice(message);
  };

  return (
    <main class="stack" style="max-width:960px;padding:16px 20px" aria-labelledby="templates-title">
      <h1 id="templates-title" style="font-size:1.4rem;margin:0">Document templates</h1>
      <p class="muted">
        Templates for <strong>Generate documents</strong> in the record and Explorer actions. Type{' '}
        <code>{'{{ attribute_code }}'}</code> where a record's saved value should appear. A run uses the
        template version it was started with.
      </p>
      {error && <p class="error" role="alert">{error}</p>}
      {notice && <p class="ok" role="status">{notice}</p>}
      {!templates && !error && <p class="muted">Loading…</p>}
      {templates?.map((template) => (
        <TemplateEditor key={`${template.id}@${template.version}`} attricat={attricat} template={template} onSaved={changed} onDeleted={changed} />
      ))}
      {templates && (creating ? (
        <TemplateEditor
          attricat={attricat}
          template={{ id: '', name: '', title: '{{ title }}', body: '' }}
          onSaved={changed}
          onDeleted={changed}
          onDiscard={() => setCreating(false)}
        />
      ) : (
        <div class="row"><button type="button" onClick={() => { setNotice(null); setCreating(true); }}>New template</button></div>
      ))}
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
