import { Fragment, h, render } from 'preact';
import { useState } from 'preact/hooks';

const routes = {
  '/overview': {
    title: 'Formula workbench',
    render: () => (
      <>
        <p>
          This extension keeps computed numeric attributes in sync whenever an
          input value changes.
        </p>
        <section class="card" aria-labelledby="start-heading">
          <h2 id="start-heading">Get started</h2>
          <ol>
            <li>Publish a blueprint revision with a formulas table.</li>
            <li>Create or migrate an entity to that revision.</li>
            <li>Update an input value in a context to recalculate its target.</li>
          </ol>
        </section>
      </>
    ),
  },
  '/formulas': {
    title: 'Formula configuration',
    render: () => (
      <>
        <p>
          Formulas are immutable blueprint metadata. The table key is the
          target attribute code and the value is its expression.
        </p>
        <pre aria-label="Example formula configuration"><code>{`[extensions.attricat-extension-example.formulas]
price_gross = "price_net * (1 + vat_rate)"`}</code></pre>
        <section class="card" aria-labelledby="syntax-heading">
          <h2 id="syntax-heading">Supported syntax</h2>
          <p>
            Numeric literals, attribute codes, <code>+</code>, <code>-</code>,
            <code>*</code>, <code>/</code>, unary minus, and parentheses.
          </p>
        </section>
      </>
    ),
  },
};

const App = () => {
  const [path, setPath] = useState('/overview');
  const route = routes[path];

  return (
    <main class="app" aria-labelledby="app-title">
      <style>{`
        :root { color: #1f2937; font: 16px/1.5 system-ui, sans-serif; }
        .app { max-width: 720px; padding: 24px; }
        h1 { margin: 0; font-size: 1.5rem; }
        h2 { font-size: 1.05rem; }
        .tabs { display: flex; gap: 8px; margin: 20px 0; border-bottom: 1px solid #d1d5db; }
        .tabs button { border: 0; border-bottom: 3px solid transparent; background: transparent; color: #374151; cursor: pointer; font: inherit; padding: 8px 10px; }
        .tabs button[aria-current="page"] { border-bottom-color: #1565c0; color: #0f4c81; font-weight: 700; }
        .card { border: 1px solid #d1d5db; border-radius: 8px; padding: 16px; }
        pre { overflow-x: auto; border-radius: 8px; background: #111827; color: #f9fafb; padding: 16px; }
        code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      `}</style>
      <h1 id="app-title">{route.title}</h1>
      <nav class="tabs" aria-label="Formula workbench">
        {Object.entries(routes).map(([routePath, item]) => (
          <button
            type="button"
            aria-current={routePath === path ? 'page' : undefined}
            onClick={() => setPath(routePath)}
          >
            {item.title}
          </button>
        ))}
      </nav>
      {route.render()}
    </main>
  );
};

export const mount = (root) => {
  render(<App />, root);
  return () => render(null, root);
};
