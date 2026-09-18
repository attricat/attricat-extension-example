# attricat-extension-example

`attricat-extension-example` is a complete Attricat extension example for
**context-aware computed numeric attributes**. A formula such as
`price_gross = price_net * (1 + vat_rate)` is evaluated after an input changes
and written to the same context as the input.

## How it works

The server component uses only the public `catalog:host/api@1.1.0` Component
ABI. It reads host-resolved values, so fallback and context selection retain
Attricat semantics; it does not implement context fallback itself. Derived
writes have the host's extension provenance (`extension:<extension-id>`), and
writes are skipped when the target's direct resolved value is already equal to
the calculated value.

Formula text permits numeric literals, attribute **codes**, `+`, `-`, `*`, `/`,
unary minus, and parentheses. Formulas live in the immutable blueprint TOML,
under this extension's namespace:

```toml
[extensions.attricat-extension-example.formulas]
price_gross = "price_net * (1 + vat_rate)"
```

The table key is the target attribute code and its value is the expression.
When the saved blueprint revision is evaluated, the extension resolves these
codes to stable attribute IDs, validates numeric inputs/targets and dependency
cycles, and uses the entity's pinned revision. The core host preserves
namespaced `[extensions.<extension-id>]` TOML metadata while retaining strict
validation of its own blueprint fields. Formula recalculation is triggered by
Catalog's `entity.updated.v1` value-change event, so saving a dependency value
recomputes its targets in the same context.

## UI contributions

The package follows the current extension authoring contract. Every client
artifact exports `mount(root, catalog)` and runs in its own sandboxed,
opaque-origin iframe. It has no host DOM, browser routing, cookies, storage, or
network access; Catalog mediates only the capabilities declared in the
manifest. Contributions neither register custom elements in the host document
nor choose DOM selectors.

**Formula workbench** is a `route` contribution at Catalog's host-owned URL:

```text
/extensions/attricat-extension-example/formula-workbench
```

Inside that one host route, its bundled Preact application has two in-memory
routes: **Formula workbench** (`/overview`) and **Formula configuration**
(`/formulas`). The iframe keeps the host URL unchanged, as required by the
extension route contract; the application owns only its internal screen state.

- Add formulas directly in the blueprint TOML under
  `[extensions.attricat-extension-example.formulas]`; no separate extension
  configuration panel is used. The Formula configuration app screen documents
  this exact metadata shape.
- **Attribute decoration** renders `⚡ Computed` only for TOML-configured targets.
- **Entity inspector** shows every target, expression, resolved inputs, selected
  context, result/error, and provides recalculation.
- **Entity action** is rendered only when that entity's blueprint has formulas.

Each mounted client listens for `catalog:context-changed.v1` on its supplied
root and rerenders from the mediated `catalog.context`, so it does not retain
stale entity or context data.

## Test against the running Attricat development server

End-to-end extension testing must use the currently running Attricat development
server, not only Rust unit tests. Build a fresh archive, side-load it through
**Manage → Extensions → Upload archive**, grant every requested capability, and
enable it. A new side-loaded release replaces the active local installation, so
repeat the grant/enable steps after each update.

Use Playwright against that running server to verify installation, enabled state,
and the feature behavior. For this extension, create/publish a blueprint revision
containing the TOML formula metadata, migrate or create an entity pinned to that
revision, write a dependency value in a context, and assert the formula target is
written in the same context. Do not treat `just check` or `just pack` as an
end-to-end verification.

## Build, test, and package

Install the prerequisites once:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-tools --locked
```

Then run:

```sh
just check
just pack
wasm-tools component wit dist/server.wasm
```

`just pack` creates `dist/attricat-extension-example-0.1.14.tar.zst`. It uses
`pnpm` to bundle the self-contained Preact route artifact. For a
side-loaded update, replace the prior sideloaded release with that archive,
re-grant the manifest capabilities (updates clear grants), then enable the
release. Restart the Catalog API after deploying host-side blueprint-parser
changes. The archive contains only the manifest, icon, README, and declared
server/client artifacts.
