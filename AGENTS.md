# Agent instructions

## Extension verification

Test this extension against the **currently running Attricat development server**.
Unit tests and packaging checks are necessary but are not sufficient to validate
host integration.

1. Run `just check` and `just pack`.
2. Side-load the generated `dist/*.tar.zst` archive into the running Catalog via
   **Manage → Extensions → Upload archive**.
3. Grant every requested capability and enable the installed release. Repeat
   this after each new side-loaded release; upgrades/replacements clear grants.
4. Use the Playwright CLI against the running dev UI/API to verify installation,
   enablement, extension UI/runtime contributions, and the target feature.
5. For formulas, publish a blueprint revision with:

   ```toml
   [extensions.attricat-extension-example.formulas]
   price_gross = "price_net * (1 + vat_rate)"
   ```

   Then create or migrate an entity to that exact revision, update a dependency
   in a non-default context, and assert that the target is written in that same
   context.

When modifying the host blueprint parser, restart the running Catalog API before
performing the side-load and Playwright verification.
