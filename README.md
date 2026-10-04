# attricat-extension-example

`attricat-extension-example` is the reference Attricat extension. It implements
one feature end to end, **context-aware computed numeric attributes**, and
uses it to show nearly every part of the extension system in a single release
on the unified **`catalog:host@1.6.0`** ABI.

```toml
[extensions.attricat-extension-example.formulas]
price_gross = "price_net * (1 + vat_rate)"
```

When `price_net` or `vat_rate` changes in a context, `price_gross` is
recalculated and written **in that same context**.

## What it demonstrates

| Surface | How the extension uses it | Code |
| --- | --- | --- |
| Unified 1.6 component | One `server.wasm` exports both `handler` and `operations` | `server/component/src/lib.rs` |
| `server.event_handlers` | `entity.updated.v1` recalculates formulas whose inputs changed | `handler.rs` |
| `server.commands` | describe, preview, recalculate, attribute settings, activity | `handler.rs` |
| Interactive `server.operations` | `recalculate-selection` reads the frozen selection, writes through `catalog-data.batch`, annotates entities, streams a CSV report | `operation.rs` |
| `scoped_configuration` | Per-attribute rounding and unit for each blueprint revision | `host.rs`, `attribute-settings.js` |
| `storage.extension` | A per-revision formula index and an activity log, written by the server and read by clients | `activity.rs`, `client/lib.js` |
| `event_contracts` + `events.emit` | Publishes `plugin.attricat-extension-example.formula_recalculated.v1` | `handler.rs` |
| `catalog.annotations.write` | Tags checked entities `attricat-extension-example:formulas-checked` | `operation.rs` |
| `logging.write` | Operation failures are logged; the host redacts persisted diagnostics | `operation.rs` |
| `route` + `navigation` | **Formula workbench** app: feature tour, activity, your runs, syntax | `client/app.jsx` |
| `entity_preview_panel` | Formulas evaluated in the selected context, ad-hoc preview, recalculation | `client/inspector.js` |
| `entity_attribute_decoration` | ⚡ Computed badge on formula targets | `client/decoration.js` |
| `entity_action` (v1) | One-click recalculation followed by `catalog.refresh` | `client/entity-action.js` |
| `explorer_row_action` / `explorer_bulk_action` (v2) | Selection-aware actions that open the host dialog | `client/selection-action.js` |
| `action_dialog` | Starts and follows the run, downloads the report | `client/dialog.js` |
| `explorer_table_cell` + `cell_renderers` | `computed-number` renderer with `precision`/`unit` props | `client/table-cell.js` |
| `blueprint_attribute_configuration` | Rounding/unit editor in the blueprint editor | `client/attribute-settings.js` |
| `entity_attribute_panel` (panel) | Shows what an attribute feeds and how a target is computed | `client/attribute-panel.js` |
| `blueprint_detail_panel` (panel) | The revision's validated formulas | `client/blueprint-panel.js` |
| `data_health_card` (panel) | Evaluation, write, error and run counters | `client/health-card.js` |
| Client runtime | `command`, `storage`, `refresh`, `notify`, `navigate`, `operations.*`, `dialog.*`, context and theme events | `client/*` |

The release does not use webhooks (declared by the host but not delivered yet),
outbound HTTPS (`network.request` needs a public endpoint), secrets, connector
jobs, or the client capabilities that have no `catalog.*` method yet.

## How it works

### Formulas

Formulas are immutable blueprint metadata in the namespaced table above: the
key is a numeric target attribute code, the value its expression. Expressions
use numeric literals, numeric attribute codes, `+ - * /`, unary minus and
parentheses (`server/formula-core`). The server rejects unknown, non-numeric,
self-referencing and cyclic formulas.

Values are always read already resolved by the host, so context fallback keeps
Catalog's semantics; the extension never resolves contexts itself. A target is
written only when its direct value in that context differs from the result.
Comparison uses a relative tolerance, because Catalog stores decimals
(`99.99 * 1.23` computes as `122.98769999999999` and reads back as `122.9877`).
Writes carry the extension's provenance (`extension:attricat-extension-example`).

### One component, two exports

`server.wasm` targets the combined `catalog-extension` world of
`catalog:host@1.6.0` (`server/component/wit`):

- **`handler`**: the event handler and client commands use the typed `api`
  imports (`read`, `write`, scoped configuration) and `call` for storage,
  events and logging.
- **`operations`**: the interactive run reads only its frozen selection
  (values already resolved in the run's context) and writes only through
  `catalog-data.batch`. Direct `api` catalog access is refused inside a run.

Formula problems (an invalid expression, a non-numeric value) are recorded in
the activity log and the event delivery succeeds; retrying cannot fix them and
a failed delivery quarantines the extension. Host failures are returned so the
host retries the delivery.

### Shared state in extension storage

| Key | Writer | Readers |
| --- | --- | --- |
| `formulas:<blueprint_id>:<version>` | handler and commands, whenever they read an entity of the revision | decoration, attribute panel, blueprint panel, attribute settings, dialog, interactive run |
| `activity` | handler, commands, interactive run (optimistic concurrency with retries) | workbench, health card |

The index lets read-only panels (which cannot call commands) and interactive
runs (which cannot read blueprints) work with validated formulas without
parsing TOML themselves. A revision is indexed the first time one of its
entities is updated or inspected.

### Client contributions

Every artifact is a self-contained ES module bundled by
`scripts/build-client.mjs`, one per manifest artifact. Catalog mounts each in
its own `sandbox="allow-scripts"` iframe with an opaque origin and no network.
That has practical consequences that the code follows:

- **Forms never submit.** There is no `allow-forms`, so the `submit` event
  never fires; use button and key handlers.
- **Renders are context-driven.** Re-render on `catalog:context-changed.v1`
  only when the context actually changed, so a pending save or preview isn't
  discarded.
- **Theme follows the host.** Read `catalog.theme` and restyle on
  `catalog:theme-changed.v1`; frames stay mounted.

## Build, test, and package

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-tools --locked
pnpm install

just check   # fmt + Rust unit tests (formula core, server, documents)
just pack    # dist/attricat-extension-example-<version>.tar.zst
```

`just pack` builds the client bundles and the component, fails if
`server.wasm` imports anything other than `catalog:host@1.6.0`, and packages
exactly the files the manifest declares. The release profile optimizes for
size because the host compiles the component on first use.

## Test against the running development server

Unit tests are not sufficient; verify against a running Attricat (1.6 or
later) as described in [AGENTS.md](AGENTS.md):

1. Side-load the archive (**Manage → Extensions → Upload archive**, or
   `acli extension sideload`). Remove the previous installation first if the
   host refuses a duplicate; removal also clears scoped configuration.
2. Grant every capability in `manifest.json` and the event publish grant:
   `acli extension grant --grant-kind event_publish --grant-id formula-recalculated attricat-extension-example`.
3. Enable the extension, then run the browser + API suite:

   ```sh
   acli --session-file .acli-session auth login default.local --email "$EMAIL" --password-stdin
   CATALOG_WEB_URL=http://127.0.0.1:<web-port> CATALOG_SESSION_FILE=.acli-session just e2e
   ```

`e2e/verify.mjs` creates its own context, blueprint revision (with the formula
table and a `computed-number` column) and entities, then checks every server
feature and every UI contribution listed above in Chromium.

## Reference documents extension (`documents/`)

`attricat.reference-documents` is the reference workflow for selection-aware
extension actions and interactive operations on the **legacy**
`catalog:host@1.5.0` operation world. It is kept on 1.5 on purpose, as a
compatibility reference for releases built before the unified ABI; new
extensions should follow the main extension above. It adds a
**Generate document(s)** action to the entity preview, the Explorer row menu
and the Explorer selection toolbar. Each opens the host-managed dialog, which
captures the selection and starts the `generate-documents` operation with a
template (`summary` or `label`) and an output mode (separate PDFs, a stored ZIP
archive, or one combined PDF).

The server component reads the run's frozen selection one entity per batch,
captures each entity's rendering input once (with a SHA-256 fingerprint),
renders a PDF from that capture, and checkpoints every step so a retried batch
appends identical bytes. Successfully finalized entities receive the
`attricat.reference-documents:document-generated` tag and
`last_document` metadata in the extension's own namespace; combined outputs
annotate only after the archive or PDF is finalized. Every run also produces a
`report.json` with per-entity results, including annotation failures.

Intentional failure: the `summary` template fails an entity that has no saved
values, and the `label` template fails an entity without a `title`/`name`
string. These entities are reported as failed in the run outcome and report;
the run itself still completes.

`just check` tests the crate and checks it for `wasm32-unknown-unknown`;
`just pack` also writes `dist/reference-documents.tar.zst`.
