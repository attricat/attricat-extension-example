# Agent instructions

## Host ABI

The extension targets the additive `attricat:host@1.1.0` ABI (`host_api`
`>=1.1.0, <2.0.0`; WIT vendored in `server/component/wit`). It is the single
reference extension and should showcase as much of the ABI and as many
extension points as it reasonably can; add new surfaces here rather than in a
separate extension. The component targets the `outcome-extension` world
(1.1 `event-handler`, `command-handler` and `deferrable-operations`). Copy WIT
updates from the host's `crates/extension-runtime/wit-host/`; never edit the
vendored file by hand.
`just build-server` fails if the component imports anything other than
`attricat:host@1.1.0`.

## Client UI

Most client contributions are Frame UI (`client_frame` artifacts built by
`scripts/build-client.mjs`). The blueprint attribute settings
(`formula-settings`) and the formula attribute editor (`formula-editor`) are
Native UI: Preact components in `client/native/` composed from the Attricat UI
kit and built by the SDK's Vite preset into `dist/ui.js` with its
`ui.js.build.json` record. `package.json` installs the SDK packages from an
[attricat-extension-sdk](https://github.com/attricat/attricat-extension-sdk)
release; to try SDK changes, switch both to `link:` paths to a built local
checkout. `pnpm typecheck` checks the native sources.

## Extension verification

Test this extension against a **running Attricat development server that
provides host API 1.1**. Unit tests and packaging checks are necessary but are
not sufficient to validate host integration.

1. Run `just check` and `just pack`.
2. Side-load the generated `dist/attricat-extension-example-<version>.tar.zst`
   via **Manage → Extensions → Upload archive** (or `acli extension sideload`;
   remove the previous installation first if the host rejects a duplicate).
3. Grant every capability in `manifest.json`, plus the event publish grant
   (`--grant-kind event_publish --grant-id formula-recalculated`), and enable
   the release. Repeat after each new side-loaded release; upgrades and
   replacements clear grants, and removal clears scoped configuration.
4. Run `just e2e` with `ATTRICAT_WEB_URL` and `ATTRICAT_SESSION_FILE` (an
   authenticated `acli --session-file`). The `file_panel` check signs in as
   the server's sample viewer (`/api/auth/sample-logins`), because the host
   shows file panels only beneath read-only file values. It drives the API and
   the UI with Playwright and must report `All checks passed`. Extend `e2e/verify.mjs`
   whenever you add or change a contribution, command, or operation.
5. The suite publishes a blueprint revision with:

   ```yaml
   extensions:
     attricat-extension-example:
       formulas:
         price_gross: price_net * (1 + vat_rate)
   ```

   creates records on that exact revision, updates dependencies in a
   non-default context, and asserts that the target is written in that same
   context. Keep that assertion.

The first invocation of a newly installed release compiles the component in
the host; on a debug-built API this can take over a minute and briefly time
out commands or lose an operation lease. Retry rather than changing the
extension.

When modifying the host blueprint parser, restart the running Attricat API before
performing the side-load and Playwright verification.
