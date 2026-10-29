/* route: Document templates. A list page links to one page per template (and
 * one for a new template) with its editor. The pages are screens of this
 * frame's in-memory router: the host keeps the route's URL fixed and gives
 * extensions no subpaths. A template is a title line and a body in which `{{ attribute_code }}` marks are replaced
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
      onSaved(templates, `Saved ${draft.name.trim()}.`, draft.id.trim());
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
      {!isNew && (
        <div class="row">
          <span class="muted"><code>{template.id}</code> · version {template.version}</span>
          {template.builtin && <span class="badge">built-in</span>}
        </div>
      )}
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

const summary = (template) => {
  const marks = [...parse(template.title).parts, ...parse(template.body).parts].filter((part) => part.mark);
  return marks.length ? [...new Set(marks.map((part) => part.mark))].join(', ') : 'no marks';
};

const List = ({ templates, open }) => (
  <>
    <table>
      <thead>
        <tr><th>Name</th><th>ID</th><th>Marks</th><th>Version</th><th><span class="muted">Actions</span></th></tr>
      </thead>
      <tbody>
        {templates.map((template) => (
          <tr key={template.id}>
            <td>{template.name}{template.builtin && <> <span class="badge">built-in</span></>}</td>
            <td><code>{template.id}</code></td>
            <td>{summary(template)}</td>
            <td>{template.version}</td>
            <td>
              <button type="button" class="secondary" aria-label={`Edit ${template.name}`} onClick={() => open({ id: template.id })}>Edit</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    <div class="row"><button type="button" onClick={() => open({ id: null })}>New template</button></div>
  </>
);

const NEW_TEMPLATE = { id: '', name: '', title: '{{ title }}', body: '' };

const App = ({ attricat }) => {
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // `null` is the list page; `{ id }` a template's page (`id: null` a new one).
  const [page, setPage] = useState(null);
  const heading = useRef(null);

  const load = useCallback(() => {
    command(attricat, 'list-templates', {}).then(
      (result) => setTemplates(result.templates),
      (failure) => setError(failure.message || String(failure)),
    );
  }, [attricat]);
  useEffect(load, [load]);
  // Move focus to the new page's heading, as a host page change would.
  useEffect(() => heading.current?.focus(), [page?.id, page === null]);

  const open = (next, message = null) => {
    setNotice(message);
    setError(null);
    setPage(next);
  };
  const template = page?.id ? templates?.find((item) => item.id === page.id) : null;
  const title = page === null ? 'Document templates' : template ? template.name : 'New template';

  return (
    <main class="stack" style="max-width:960px;padding:16px 20px" aria-labelledby="templates-title">
      {page !== null && (
        <nav aria-label="Breadcrumb">
          <button type="button" class="secondary" onClick={() => open(null)}>← All templates</button>
        </nav>
      )}
      <h1 id="templates-title" ref={heading} tabIndex={-1} style="font-size:1.4rem;margin:0;outline:none">{title}</h1>
      {page === null && (
        <p class="muted">
          Templates for <strong>Generate documents</strong> in the record and Explorer actions. Type{' '}
          <code>{'{{ attribute_code }}'}</code> where a record's saved value should appear. A run uses the
          template version it was started with.
        </p>
      )}
      {error && <p class="error" role="alert">{error}</p>}
      {notice && <p class="ok" role="status">{notice}</p>}
      {!templates && !error && <p class="muted">Loading…</p>}
      {templates && page === null && <List templates={templates} open={open} />}
      {templates && page !== null && (page.id && !template ? (
        <p class="error" role="alert">This template no longer exists.</p>
      ) : (
        <TemplateEditor
          key={template ? `${template.id}@${template.version}` : 'new'}
          attricat={attricat}
          template={template ?? NEW_TEMPLATE}
          onSaved={(next, message, id) => {
            setTemplates(next);
            open({ id }, message);
          }}
          onDeleted={(next, message) => {
            setTemplates(next);
            open(null, message);
          }}
          onDiscard={() => open(null)}
        />
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
