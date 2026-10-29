# attricat-extension-example

`attricat-extension-example` is the reference Attricat extension. It implements
two features end to end, **context-aware computed numeric attributes** and
**PDF document generation** for a record or an Explorer selection, and uses
them to show nearly every part of the extension system in a single release on
the **`attricat:host@1.1.0`** ABI.

```toml
[extensions.attricat-extension-example.formulas]
price_gross = "price_net * (1 + vat_rate)"
```

When `price_net` or `vat_rate` changes in a context, `price_gross` is
recalculated and written **in that same context**.

## What it demonstrates

| Surface | How the extension uses it | Code |
| --- | --- | --- |
| One component, 1.1 world | One `server.wasm` exports `event-handler`, `command-handler` and `deferrable-operations` (`outcome-extension`) | `server/component/src/lib.rs` |
| `server.event_handlers` | `record.updated.v1` recalculates formulas whose inputs changed, completing chains in dependency order, and skips the events its own writes cause by the delivery's `source-name` | `handler.rs` |
| Typed outcomes | Invalid formulas and payloads are `rejected` (recorded, never retried); host call failures `retry` with backoff instead of quarantining | `handler.rs`, `operation.rs`, `documents/` |
| `clock` | Activity entries carry the host's wall-clock time | `activity.rs` |
| `server.commands` | describe, preview, recalculate, attribute settings, activity | `handler.rs` |
| Interactive `server.operations` | `recalculate-selection` reads the frozen selection, writes through `attricat-data.batch`, annotates records, streams a CSV report | `operation.rs` |
| Streamed output artifacts | `generate-documents` renders separate PDFs, a stored ZIP or one combined PDF across checkpointed batches, plus a `report.json` | `documents/` |
| `scoped_configuration` | Per-attribute rounding and unit for each blueprint revision | `host.rs`, `attribute-settings.js` |
| `storage.extension` | A per-revision formula index and an activity log, written by the server and read by clients | `activity.rs`, `client/lib.js` |
| `event_contracts` + `events.emit` | Publishes `plugin.attricat-extension-example.formula_recalculated.v1` | `handler.rs` |
| `attricat.annotations.write` | Tags checked records `formulas-checked`, and documented records `document-generated` with `last_document` metadata, from runs; the event handler records `last_recalculated` metadata with an annotation-only `attricat.command.v1` batch | `operation.rs`, `documents/`, `handler.rs`, `host.rs` |
| `logging.write` | Operation failures are logged; the host redacts persisted diagnostics | `operation.rs` |
| `route` + `navigation` | **Formula workbench** app: feature tour, activity, your runs, syntax | `client/app.jsx` |
| `route` + `navigation` | **Document templates**: a list page and one page per template (in-frame screens; the host URL stays fixed) with its editor, where `{{ attribute_code }}` marks are replaced with saved values; versioned saves through commands | `client/templates.jsx`, `documents/templates.rs` |
| `record_preview_panel` | Formulas evaluated in the selected context, ad-hoc preview, recalculation | `client/inspector.js` |
| `record_attribute_decoration` | ⚡ Computed badge on formula targets | `client/decoration.js` |
| `record_action` (action) | **Recalculate formulas** calls a command whose notification and `refresh` the host applies; **Generate document…** opens the documents dialog | `manifest.json`, `handler.rs` |
| `explorer_row_action` / `explorer_bulk_action` (action) | **Recalculate formulas…** and **Generate documents…** open the matching dialog for the row or selection | `manifest.json` |
| `action_dialog` | Two dialogs, one per task: recalculate formulas or generate documents; each starts, follows and cancels runs and downloads outputs; the host renders the title and close control | `client/*-dialog.js`, `client/dialog-*.js` |
| `explorer_table_cell` + `cell_renderers` | `computed-number` renderer with `precision`/`unit` props | `client/table-cell.js` |
| `blueprint_attribute_configuration` | Rounding/unit editor in the blueprint editor | `client/attribute-settings.js` |
| `record_attribute_panel` (panel) | Shows what an attribute feeds and how a target is computed | `client/attribute-panel.js` |
| `blueprint_detail_panel` (panel) | The revision's validated formulas | `client/blueprint-panel.js` |
| `data_health_card` (panel) | Evaluation, write, error and run counters | `client/health-card.js` |
| `record_header_action` (action) | **Check formulas**: a command that validates the record's revision and reports its formulas | `manifest.json`, `handler.rs` |
| `explorer_action` (action) | **Show formulas**: a command listing the displayed revision's formulas | `manifest.json`, `handler.rs` |
| `blueprint_panel` (panel) | Formula dependency summary, marking chained formulas | `client/blueprint-summary.js` |
| `blueprint_publish_check` (panel) | Informational: the formulas to expect and when they are validated | `client/publish-check.js` |
| `file_panel` (panel) | The record's last generated document and formula check, read with `attricat.request` | `client/file-panel.js` |
| `audit_event_panel` (panel) | The extension's recent activity beside an audit event | `client/audit-panel.js` |
| Client runtime | `command`, `request`, `storage`, `refresh`, `notify`, `navigate`, `operations.*`, `dialog.*`, context and theme events | `client/*` |

The release does not use webhooks (declared by the host but not delivered yet),
outbound HTTPS (`network.request` needs a public endpoint), secrets, OAuth
connections, connector jobs and exports (including the `export_mapping`
outlet), `resume-after-ms` deferral, or the client capabilities that have no
`attricat.*` method yet.

## How it works

### Formulas

Formulas are immutable blueprint metadata in the namespaced table above: the
key is a numeric target attribute code, the value its expression. Expressions
use numeric literals, numeric attribute codes, `+ - * /`, unary minus and
parentheses (`server/formula-core`). The server rejects unknown, non-numeric,
self-referencing and cyclic formulas.

Values are always read already resolved by the host, so context fallback keeps
Attricat's semantics; the extension never resolves contexts itself. A target is
written only when its direct value in that context differs from the result.
Comparison uses a relative tolerance, because Attricat stores decimals
(`99.99 * 1.23` computes as `122.98769999999999` and reads back as `122.9877`).
Writes carry the extension's provenance (`extension:attricat-extension-example`).

### One component, three exports

`server.wasm` targets the `outcome-extension` world of `attricat:host@1.1.0`
(`server/component/wit`). An extension contributes at
most once to each UI outlet and has one action dialog, so both interactive
operations share the record, row and bulk actions and the dialog, which
dispatches by task; the `operations` export dispatches by operation ID.

- **`event-handler`** and **`command-handler`**: the event handler and client
  commands use the typed `api` imports (`read`, `write`, scoped configuration)
  and `call` for storage, events and logging.
- **`deferrable-operations`**: the interactive runs read only their frozen selection
  (values already resolved in the run's context) and write only through
  `attricat-data.batch`. Direct `api` catalog access is refused inside a run.

A per-formula problem (a non-numeric value) is recorded in the activity log
and the delivery succeeds. Invalid formulas are recorded too and the delivery
is `rejected`, which the host records without retrying. Host failures are
returned as `retry`, so the host retries the delivery or batch with backoff;
only a `fault` (never returned here), a trap or a timeout quarantines the
installation.

Formulas are indexed in dependency order. The handler treats each target it
writes as a changed input for the formulas after it, and the interactive run
feeds each result into the values it evaluates next, so a chain such as
`price_deposit = "price_gross * 0.2"` completes in one delivery or batch. That
is what lets the handler skip the events its own writes cause.

### Documents

`generate-documents` (`server/component/src/documents/`) takes a template ID
and version and an output mode (separate PDFs, a stored ZIP archive, or one
combined PDF). Templates are managed on the **Document templates** route and
stored under the `document-templates` storage key; until the first save the
built-in `summary` and `label` apply (built-ins can be edited, not deleted).

A template is text: a one-line title and a body. Each `{{ attribute_code }}`
mark is replaced with the record's saved value in the run's context (with
context fallback), and a mark without a value prints as `-`. Three marks name
the record itself: `{{ record.id }}`, `{{ record.fingerprint }}` (the first 16
hex digits of the captured content's SHA-256) and `{{ record.values }}` (every
saved value, one `code: value` line each, body only). An empty title falls
back to the record ID. The route embeds an editor per template that checks
marks as you type, inserts them at the caret and previews the text with marks
highlighted; `save-template` validates them again. The list and each template's page are screens of the frame's in-memory router, because the host keeps a route's URL fixed and gives extensions no subpaths.

Every save bumps the template's version. The dialog starts a run of the
version it shows; the run rejects a version that changed meanwhile and
snapshots the template in its checkpoint, so later edits never change a
started or retried run. The run captures only the values the template's marks
name, and `report.json` lists each record's `missing_values`.

The server component reads the run's frozen selection one record per batch,
captures each record's rendering input once (with a SHA-256 fingerprint),
renders a PDF from that capture, and checkpoints every step so a retried batch
appends identical bytes. Successfully finalized records receive the
`attricat-extension-example:document-generated` tag and `last_document`
metadata in the extension's own namespace; combined outputs annotate only
after the archive or PDF is finalized. Every run also produces a
`report.json` with per-record results, including annotation failures.

Intentional failure: a template that names values fails a record that has
none of them saved. These records are reported as failed in the run outcome and report;
the run itself still completes.

### Shared state in extension storage

| Key | Writer | Readers |
| --- | --- | --- |
| `formulas:<blueprint_id>:<version>` | handler and commands, whenever they read a record of the revision | decoration, attribute panel, blueprint panel, attribute settings, dialog, interactive run |
| `activity` | handler, commands, interactive run (optimistic concurrency with retries) | workbench, health card |
| `templates` | `save-template` / `delete-template` commands (optimistic concurrency per template version) | templates route and dialog (`list-templates`), document runs |

The index lets read-only panels (which cannot call commands) and interactive
runs (which cannot read blueprints) work with validated formulas without
parsing TOML themselves. A revision is indexed the first time one of its
records is updated or inspected.

### Client contributions

Every artifact is a self-contained ES module bundled by
`scripts/build-client.mjs`, one per manifest artifact. Attricat mounts each in
its own `sandbox="allow-scripts"` iframe with an opaque origin and no network.
That has practical consequences that the code follows:

- **Forms never submit.** There is no `allow-forms`, so the `submit` event
  never fires; use button and key handlers.
- **Renders are context-driven.** Re-render on `attricat:context-changed.v1`
  only when the context actually changed, so a pending save or preview isn't
  discarded.
- **Theme follows the host.** Read `attricat.theme` and restyle on
  `attricat:theme-changed.v1`; frames stay mounted.

## Build, test, and package

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-tools --locked
pnpm install

just check   # fmt + Rust unit tests (formula core, server, PDF and ZIP writers)
just pack    # dist/attricat-extension-example-<version>.tar.zst
```

`just pack` builds the client bundles and the component, fails if
`server.wasm` imports anything other than `attricat:host@1.1.0`, and packages
exactly the files the manifest declares. The release profile optimizes for
size because the host compiles the component on first use.

## Test against the running development server

Unit tests are not sufficient; verify against a running Attricat as described
in [AGENTS.md](AGENTS.md):

1. Side-load the archive (**Manage → Extensions → Upload archive**, or
   `acli extension sideload`). Remove the previous installation first if the
   host refuses a duplicate; removal also clears scoped configuration.
2. Grant every capability in `manifest.json` and the event publish grant:
   `acli extension grant --grant-kind event_publish --grant-id formula-recalculated attricat-extension-example`.
3. Enable the extension, then run the browser + API suite:

   ```sh
   acli --session-file .acli-session auth login default.local --email "$EMAIL" --password-stdin
   ATTRICAT_WEB_URL=http://127.0.0.1:<web-port> ATTRICAT_SESSION_FILE=.acli-session just e2e
   ```

`e2e/verify.mjs` creates its own context, blueprint revision (with a chained
formula table, a file attribute and a `computed-number` column), records and a
datasheet upload, then checks every server feature and every UI contribution
listed above in Chromium. File panels appear only beneath read-only file
values, so that check signs in as the server's sample viewer.
