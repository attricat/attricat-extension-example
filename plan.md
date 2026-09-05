# Completion plan

## 1. Finish server configuration API

Update `server/component/src/lib.rs` and `manifest.json`.

- `get-formulas`: accept `{ blueprint_id, blueprint_version }`; return blueprint-scoped `{ formulas }` configuration.
- `save-formulas`: validate syntax, exact-blueprint target/dependency IDs, numeric attributes, extracted dependencies, and direct/transitive cycles; persist normalized configuration with `scoped_configuration_set`.
- `preview-formula`: use the shared evaluator; return result, resolved inputs, and dependencies.
- `recalculate-formulas`: load formulas for the entity's pinned blueprint, evaluate in the selected context, and skip writes when the direct target value is unchanged.

## 2. Add server tests

Cover evaluator sharing, configuration normalization, cycle rejection, missing/non-numeric values, context-aware reads/writes, no-op behavior, and recalculation only for affected dependency events.

## 3. Replace client placeholders

Update `client/index.js` with shared helpers for `catalog.request` and `catalog.command`.

### Formula configurator

1. Fetch its exact blueprint revision using host-provided `blueprint_id` and `blueprint_version`.
2. Load formulas with `get-formulas`.
3. Edit the formula for the current target attribute.
4. Parse references, map blueprint attribute codes to stable IDs, show validation/dependencies, call `preview-formula`, and save via `save-formulas`.

### Computed indicator

Load configuration and render `⚡ Computed` only when the current `attribute_id` is a configured formula target.

### Formula inspector

Load entity, blueprint, and formula configuration; show target, expression, resolved dependency values, selected context, result/error, and a Recalculate action.

### Recalculate action

Invoke `recalculate-formulas`, surface success/error, and refresh entity data after success. Render it only for blueprints containing formulas.

## 4. Shared schema and documentation

Update `shared/formula-config.schema.json`, `shared/types.ts`, and `README.md` to document blueprint-scoped configuration:

```ts
type BlueprintFormulaConfiguration = {
  formulas: FormulaConfig[];
};
```

Document that expression references use codes, persisted dependencies use stable IDs, evaluation follows host context fallback semantics, and derived writes use extension provenance.

## 5. Build and install

```sh
just check
just pack
```

For a side-loaded update: increment `manifest.json` SemVer and the archive version in `justfile`, build, replace/upgrade the local installation, re-grant capabilities, and enable it.

## 6. Playwright E2E

Add an E2E spec that builds/installs/enables the archive, creates a numeric product blueprint, configures:

```text
price_gross = price_net * (1 + vat_rate)
```

Then create/open an entity in a non-default context, set `price_net = 100` and `vat_rate = 0.23`, wait for event processing, and assert `price_gross = 123` in the same context.

Also assert that only the formula target shows the indicator; the iframe inspector shows formula, inputs, context, and result; preview/recalculate work; unrelated updates do not recalculate; and no-op recalculation does not append a value. Use frame-scoped Playwright locators for extension UI.

## 7. Final verification

```sh
just check
just pack
wasm-tools component wit dist/server.wasm
```

Confirm the component imports only `catalog:host/api@1.1.0`, then run the isolated Playwright E2E suite and report archive/install/enablement, event result, iframe assertions, and command outcomes.
