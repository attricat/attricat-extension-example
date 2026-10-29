// End-to-end verification against a running Attricat development server.
//
// Prerequisites (see AGENTS.md): the current release is side-loaded, every
// requested capability plus the `formula-recalculated` event_publish grant is
// granted, and the extension is enabled. Authenticate once with the CLI:
//
//   acli --session-file .acli-session auth login default.local --email … --password-stdin
//
// Then run:
//
//   ATTRICAT_WEB_URL=http://127.0.0.1:5173 ATTRICAT_SESSION_FILE=.acli-session just e2e
//
// The script creates its own uniquely named context, blueprint revision and
// records through the API, then exercises every server feature and UI
// contribution of the extension in a real browser.

import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const EXTENSION = 'attricat-extension-example';
const WEB = (process.env.ATTRICAT_WEB_URL ?? '').replace(/\/$/, '');
const SESSION_FILE = process.env.ATTRICAT_SESSION_FILE;
if (!WEB || !SESSION_FILE) {
  console.error('Set ATTRICAT_WEB_URL and ATTRICAT_SESSION_FILE (an acli --session-file).');
  process.exit(2);
}
const session = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
const suffix = Date.now().toString(36);
let failures = 0;

const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const api = async (method, path, body) => {
  const response = await fetch(`${WEB}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: `attricat_session=${session.session}; attricat_csrf=${session.csrf}`,
      'x-attricat-csrf': session.csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const poll = async (label, read, accept, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${label} timed out; last value ${JSON.stringify(last)?.slice(0, 300)}`);
};

const scalar = (code, value, contextId) => ({ kind: 'scalar', attribute_code: code, value, context_id: contextId });

// ---------------------------------------------------------------- fixtures --
const blueprintCode = `formula_e2e_${suffix}`;
const definition = `format_version = 1
code = "${blueprintCode}"
name = "Formula e2e ${suffix}"
kind = "record"

[views.dropdown_option]
type = "dropdown_option"
fields = ["title"]

[views.table]
type = "table"

[[views.table.columns]]
field = "title"

[[views.table.columns]]
field = "price_gross"
label = "Gross"
renderer = { id = "${EXTENSION}.computed-number", version = 1, props = { precision = 2, unit = "EUR" } }

[[attributes]]
code = "title"
value_type = "string"

[[attributes]]
code = "price_net"
value_type = "number"

[[attributes]]
code = "vat_rate"
value_type = "number"

[[attributes]]
code = "price_gross"
value_type = "number"

[[attributes]]
code = "price_deposit"
value_type = "number"

[[attributes]]
code = "datasheet"
value_type = "file"

[extensions.${EXTENSION}.formulas]
price_gross = "price_net * (1 + vat_rate)"
price_deposit = "price_gross * 0.2"
`;

const installation = (await api('GET', `/extensions/${EXTENSION}`)).installation;
check('extension is enabled', installation.state === 'enabled', installation.state);
const command = (commandId, payload, contribution = 'formula-inspector') =>
  api('POST', `/extensions/${EXTENSION}/${contribution}/command`, {
    release_id: installation.installed_release_id,
    command_id: commandId,
    payload,
  });

const context = await api('POST', '/contexts', { code: `e2e-${suffix}`, data: {}, parent_id: null });
const defaultContext = (await api('GET', '/contexts')).find((item) => item.code === 'default');
const created = await api('POST', '/blueprints', { definition });
const blueprint = created.blueprint ?? created;
await api('POST', `/blueprints/${blueprint.id}/versions/${blueprint.version}/publish`);
const revision = await api('GET', `/blueprints/${blueprint.id}/versions/${blueprint.version}`);
const gross = revision.attributes.find((attribute) => attribute.code === 'price_gross');
const deposit = revision.attributes.find((attribute) => attribute.code === 'price_deposit');
const records = [];
for (const title of ['Alpha', 'Beta', 'Gamma']) {
  records.push(
    (await api('POST', '/v1/records', {
      blueprint: { code: blueprintCode, version: blueprint.version },
      values: [scalar('title', title, defaultContext.id)],
    })).id,
  );
}
const [alpha, beta, gamma] = records;
// A datasheet file on Alpha, beneath which the file_panel contribution mounts.
{
  const form = new FormData();
  form.append('file', new Blob(['Alpha datasheet\n'], { type: 'text/plain' }), 'alpha-datasheet.txt');
  const response = await fetch(`${WEB}/api/records/${alpha}/file-attributes/datasheet/uploads`, {
    method: 'POST',
    headers: {
      cookie: `attricat_session=${session.session}; attricat_csrf=${session.csrf}`,
      'x-attricat-csrf': session.csrf,
    },
    body: form,
  });
  if (!response.ok) throw new Error(`datasheet upload → ${response.status} ${(await response.text()).slice(0, 300)}`);
}
console.log(`fixtures: context ${context.code}, blueprint ${blueprintCode}, records ${records.join(' ')}`);

// ------------------------------------------------------------- server side --
const settings = await command(
  'save-attribute-settings',
  { blueprint_id: blueprint.id, blueprint_version: blueprint.version, attribute_id: gross.id, settings: { precision: 2, unit: 'EUR' } },
  'formula-settings',
);
check('scoped configuration saved through a command', settings.settings?.precision === 2);

const update = (recordId, values) =>
  api('PUT', `/v1/records/${recordId}`, { values, relationships: [], remove_values: [] });
const valueIn = async (attribute, recordId, contextId) => {
  const values = await api('GET', `/records/${recordId}/values/current`);
  return values.find((value) => value.attribute_id === attribute.id && value.context_id === contextId)?.value;
};
const grossIn = (recordId, contextId) => valueIn(gross, recordId, contextId);

await update(alpha, [scalar('price_net', 99.99, context.id), scalar('vat_rate', 0.23, context.id)]);
const alphaGross = await poll('alpha price_gross', () => grossIn(alpha, context.id), (value) => value !== undefined);
check('event handler writes the target in the non-default context, rounded', alphaGross === 122.99, alphaGross);
// The handler skips the events its own writes cause (1.1 delivery source), so
// a chained formula must be completed within the same delivery.
const alphaDeposit = await poll('alpha price_deposit', () => valueIn(deposit, alpha, context.id), (value) => value !== undefined);
check('event handler completes a chained formula in the same delivery', Math.abs(alphaDeposit - 24.598) < 1e-9, alphaDeposit);
// The handler annotates the record it wrote, through an annotation-only
// attricat.command.v1 batch made from the event handler itself.
const lastRecalculated = await poll(
  'alpha last_recalculated annotation',
  async () => (await api('GET', `/records/${alpha}`)).system_metadata?.[EXTENSION]?.last_recalculated,
  (value) => value?.targets?.includes('price_deposit'),
);
check(
  'event handler annotates the record in its own namespace',
  lastRecalculated.targets.join(',') === 'price_deposit,price_gross' && lastRecalculated.context_ids.includes(context.id) && typeof lastRecalculated.at === 'number',
  JSON.stringify(lastRecalculated),
);
await update(beta, [scalar('price_net', 10, context.id), scalar('vat_rate', 0.5, context.id)]);
await update(gamma, [scalar('price_net', 50, defaultContext.id), scalar('vat_rate', 0.1, defaultContext.id)]);
check('event handler writes the default context too', (await poll('gamma price_gross', () => grossIn(gamma, defaultContext.id), (value) => value !== undefined)) === 55);

const described = await command('describe-formulas', { record_id: alpha, context_id: context.id });
check('describe-formulas evaluates and reports up to date', described.formulas?.[0]?.up_to_date === true, JSON.stringify(described.formulas?.[0]));
const activity = await command('recent-activity', {});
check('activity log records event writes', activity.stats.writes >= 3, JSON.stringify(activity.stats));

// ---------------------------------------------------------------- browser --
const browser = await chromium.launch();
const page = await (async () => {
  const browserContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const { hostname } = new URL(WEB);
  await browserContext.addCookies([
    { name: 'attricat_session', value: session.session, domain: hostname, path: '/' },
    { name: 'attricat_csrf', value: session.csrf, domain: hostname, path: '/' },
  ]);
  return browserContext.newPage();
})();

const frameWith = async (text, timeout = 90_000, target = page) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of target.frames()) {
      if (frame === target.mainFrame()) continue;
      try {
        const body = await frame.locator('body').innerText({ timeout: 500 });
        if (typeof text === 'string' ? body.includes(text) : text.test(body)) return frame;
      } catch {
        // Frames come and go while the host mounts contributions.
      }
    }
    await target.waitForTimeout(500);
  }
  throw new Error(`no extension frame contains ${text}`);
};

// Hosts that group Explorer extension contributions in a popover reveal a
// trigger once a frame renders; its frame stays mounted, so open the trigger
// when it exists (older hosts mount the frames inline) and act in the frame.
const openIfPresent = async (trigger) => {
  try {
    await trigger.waitFor({ timeout: 15_000 });
  } catch {
    return;
  }
  await trigger.click();
};

const step = async (label, run) => {
  try {
    await run();
    check(label, true);
  } catch (error) {
    check(label, false, error.message.split('\n')[0]);
  }
};

try {
  await step('route + navigation: workbench renders its feature tour', async () => {
    await page.goto(`${WEB}/extensions/${EXTENSION}/formula-workbench`);
    const app = await frameWith('Formula workbench');
    await app.getByText('Interactive operation').waitFor();
    if (!(await page.getByRole('link', { name: 'Formula workbench' }).count())) throw new Error('navigation entry missing');
    await app.getByRole('button', { name: 'Activity' }).click();
    await app.getByText('evaluations').first().waitFor({ timeout: 60_000 });
  });

  await step('route + navigation: document templates are created and versioned', async () => {
    await page.goto(`${WEB}/extensions/${EXTENSION}/document-templates`);
    const app = await frameWith('Summary sheet');
    if (!(await page.getByRole('link', { name: 'Document templates' }).count())) throw new Error('navigation entry missing');
    // The suite reuses one workspace: start from a clean slate.
    if (await app.getByRole('button', { name: 'Delete Price sheet' }).count()) {
      await app.getByRole('button', { name: 'Delete Price sheet' }).click();
      await app.getByText('Deleted Price sheet.').waitFor({ timeout: 30_000 });
    }
    await app.getByRole('button', { name: 'New template' }).click();
    await app.getByLabel('Template ID').fill('price-sheet');
    await app.getByLabel('Name').fill('Price sheet');
    await app.getByLabel('Attributes').fill('title, price_gross');
    await app.getByRole('button', { name: 'Save template' }).click();
    await app.getByText('Saved Price sheet.').waitFor({ timeout: 30_000 });
    await app.getByRole('button', { name: 'Edit Price sheet' }).click();
    await app.getByLabel('Heading').fill(`E2E ${suffix}`);
    await app.getByRole('button', { name: 'Save template' }).click();
    await app.getByText('Saved Price sheet.').waitFor({ timeout: 30_000 });
    const row = app.getByRole('row', { name: /Price sheet/ });
    if (!/title, price_gross\s*2/.test(await row.innerText())) throw new Error(await row.innerText());
  });

  await step('blueprint_detail_panel lists the validated formula', async () => {
    await page.goto(`${WEB}/manage/blueprints/${blueprint.id}`);
    await frameWith('price_net, vat_rate');
  });

  await step('blueprint_panel summarizes dependencies and marks the chain', async () => {
    await frameWith(/price_deposit ← price_gross\s*chained/);
  });

  await step('blueprint_attribute_configuration edits rounding', async () => {
    await page.goto(`${WEB}/manage/blueprints/${blueprint.id}/revisions/${blueprint.version}/new`);
    const editor = await frameWith('price_net * (1 + vat_rate)');
    await editor.getByLabel('Decimal places').selectOption('2');
    await editor.getByRole('button', { name: 'Save' }).click();
    await editor.getByText('Saved for this revision.').waitFor({ timeout: 60_000 });
  });

  await step('data_health_card shows counters', async () => {
    await page.goto(`${WEB}/manage/data-health`);
    await frameWith(/\d+\s*evaluations/);
  });

  await step('record_attribute_panel and record_attribute_decoration', async () => {
    await page.goto(`${WEB}/records/${alpha}`);
    await frameWith('Feeds price_gross');
    // The context bar shows the first few contexts as tabs and the rest in a
    // "More contexts" combobox.
    const contextTab = page.getByRole('tab', { name: context.code });
    if (await contextTab.count()) await contextTab.click();
    else {
      await page.getByRole('combobox', { name: 'More contexts' }).click();
      await page.getByRole('option', { name: context.code }).click();
    }
    await page.getByRole('button', { name: 'View extension content for price gross' }).click();
    await frameWith('⚡ Computed');
    await page.keyboard.press('Escape');
  });

  await step('record_preview_panel evaluates, previews and recalculates', async () => {
    // Newer hosts give record preview panels an Extensions tab; older ones a
    // drawer behind an "Extension contributions" button.
    const tab = page.getByRole('tab', { name: 'Extensions', exact: true });
    await (await tab.count() ? tab : page.getByRole('button', { name: 'Extension contributions' })).click();
    const inspector = await frameWith(/Result\s+122\.99 EUR/);
    await inspector.getByLabel('Expression to preview').fill('price_net * 2');
    await inspector.getByRole('button', { name: 'Preview' }).click();
    await inspector.getByText('= 199.98').waitFor({ timeout: 30_000 });
    await inspector.getByRole('button', { name: 'Recalculate formulas' }).click();
    await frameWith('up to date');
  });

  await step('record_action (v2) + action_dialog generate one combined PDF', async () => {
    // Record actions sit at the end of the Data tab.
    const dataTab = page.getByRole('tab', { name: 'Data', exact: true });
    if (await dataTab.count()) await dataTab.click();
    const action = await frameWith('Generate document…');
    await action.getByRole('button', { name: 'Generate document…' }).click();
    // Opened from the record preview, the dialog starts on its documents task.
    const dialog = await frameWith('Price sheet (v2)');
    await dialog.getByLabel('Template').selectOption('price-sheet');
    await dialog.getByLabel('Output').selectOption('combined');
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
    await frameWith('Run Completed · 1 generated', 180_000);
    if (!(await dialog.getByRole('button', { name: 'Download documents.pdf' }).count())) throw new Error('no documents.pdf download');
    if (!(await dialog.getByRole('button', { name: 'Download report.json' }).count())) throw new Error('no report.json download');
    if (await dialog.getByRole('button', { name: /^(Close|Cancel)$/ }).count()) throw new Error('the frame renders its own close button');
    // The host dialog owns the close control; the frame renders none.
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  });

  await step('document run annotated the record', async () => {
    const record = await api('GET', `/records/${alpha}`);
    if (!record.system_tags?.includes(`${EXTENSION}:document-generated`)) throw new Error(JSON.stringify(record.system_tags));
    const last = record.system_metadata?.[EXTENSION]?.last_document;
    if (last?.template !== 'price-sheet' || last?.template_version !== 2) throw new Error(JSON.stringify(last));
  });

  await step('record_header_action checks the formulas', async () => {
    const header = await frameWith('Check formulas');
    // Newer hosts offer header actions in the record's Actions menu, under a
    // "More actions…" item; older ones mount them beside the toolbar.
    const actions = page.getByRole('navigation', { name: 'Record' }).getByRole('button', { name: 'Actions', exact: true });
    // Visibility inside the frame says nothing about the host popover around it.
    if (!(await page.locator('iframe[title="formula-header-action"]').isVisible())) {
      await actions.click();
      await openIfPresent(page.getByRole('menu').getByRole('menuitem', { name: 'More actions…' }));
    }
    await header.getByRole('button', { name: 'Check formulas' }).click();
    await page.getByText('2 valid formulas: price_gross, price_deposit.').waitFor({ timeout: 30_000 });
  });

  await step('file_panel shows the last generated document', async () => {
    // The host renders file panels beneath read-only file values only; a
    // writer sees the file editor instead, so check as the sample viewer.
    const viewerContext = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    try {
      const samples = await (await viewerContext.request.get(`${WEB}/api/auth/sample-logins`)).json();
      const viewer = samples.accounts?.find((account) => account.role === 'viewer');
      if (!viewer) throw new Error('no sample viewer login on this server');
      const login = await viewerContext.request.post(`${WEB}/api/auth/login`, {
        data: { login_identifier: samples.login_identifier, email: viewer.email, password: samples.password },
      });
      if (!login.ok()) throw new Error(`viewer login → ${login.status()}`);
      const viewerPage = await viewerContext.newPage();
      await viewerPage.goto(`${WEB}/records/${alpha}`);
      await frameWith('Last document: price-sheet template, combined PDF', 90_000, viewerPage);
    } finally {
      await viewerContext.close();
    }
  });

  await step('explorer_table_cell renders computed-number with props', async () => {
    // The host falls back to its built-in cell when a renderer frame does not
    // start within 1.5 s, which a busy dev machine can miss; reload to retry.
    for (let attempt = 1; ; attempt += 1) {
      await page.goto(`${WEB}/?blueprint=${blueprintCode}&version=${blueprint.version}&context=${context.code}`);
      try {
        await frameWith(/55\.00\s*EUR/, 30_000);
        return;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
  });

  await step('explorer_action lists the revision formulas', async () => {
    const toolbar = await frameWith('ƒ 2 formulas');
    await openIfPresent(page.getByRole('button', { name: 'Extension actions', exact: true }));
    await toolbar.getByRole('button', { name: 'ƒ 2 formulas' }).click();
    await page.getByText(/price_gross = price_net \* \(1 \+ vat_rate\) · price_deposit = price_gross \* 0\.2/).waitFor({ timeout: 30_000 });
    // Close the toolbar popover, if any, by clicking its backdrop; keys
    // pressed in the focused frame never reach the host.
    if (await page.getByRole('presentation').count()) await page.mouse.click(5, 5);
  });

  await step('explorer_row_action (v2) opens the dialog for one record', async () => {
    await page.getByRole('button', { name: `Record actions for ${alpha}` }).click();
    // The row menu mounts its extension frames when it opens. Newer hosts then
    // show a "More actions…" item; older ones an extension button.
    const menu = page.getByRole('menu');
    const more = menu.getByRole('menuitem', { name: 'More actions…' }).or(menu.getByRole('button', { name: /extension/i }));
    await more.first().click({ timeout: 30_000 });
    const row = await frameWith('Formulas and documents…');
    await row.getByRole('button').click();
    const dialog = await frameWith('1 selected record');
    // The host dialog owns the close control; the frame renders none.
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  });

  await step('explorer_bulk_action (v2) + action_dialog run the interactive operation', async () => {
    await page.goto(`${WEB}/?blueprint=${blueprintCode}&version=${blueprint.version}&context=${context.code}`);
    await page.getByRole('button', { name: 'Select records' }).click();
    const boxes = page.getByRole('checkbox');
    for (let index = 1; index < (await boxes.count()); index += 1) await boxes.nth(index).check();
    // Newer hosts put bulk actions in the selection's Actions menu, which
    // mounts the frame when it opens; older hosts mount it below the toolbar.
    const actions = page.getByRole('button', { name: 'Actions', exact: true });
    if (await actions.count()) {
      await actions.click();
      await openIfPresent(page.getByRole('menu').getByRole('menuitem', { name: 'More actions…' }));
    }
    const bulk = await frameWith(/Formulas and documents \(3\)…/);
    await bulk.getByRole('button').click();
    const dialog = await frameWith('3 selected records');
    await dialog.getByLabel('Mode').selectOption('write');
    await dialog.getByRole('button', { name: 'Start' }).click();
    await frameWith('Completed: 3 succeeded', 180_000);
    if (!(await dialog.getByRole('button', { name: /Download formula-report\.csv/ }).count())) throw new Error('no report download');
  });

  await step('interactive run annotated the selection', async () => {
    const record = await api('GET', `/records/${beta}`);
    if (!record.system_tags?.includes(`${EXTENSION}:formulas-checked`)) throw new Error(JSON.stringify(record.system_tags));
  });

  await step('blueprint_publish_check shows the formulas to expect', async () => {
    await api('POST', `/blueprints/${blueprint.id}/versions`, {
      definition: `${definition}\n[[attributes]]\ncode = "note"\nvalue_type = "string"\n`,
    });
    await page.goto(`${WEB}/manage/blueprints/${blueprint.id}`);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await frameWith(`Revision ${blueprint.version} computes:`);
    await page.keyboard.press('Escape');
  });

  await step('audit_event_panel shows formula activity in the event drawer', async () => {
    await page.goto(`${WEB}/manage/audit-log`);
    await page.getByRole('button', { name: /^View details for / }).first().click();
    await frameWith('Formula activity');
  });

  await step('theme: frames follow dark mode', async () => {
    await page.goto(`${WEB}/extensions/${EXTENSION}/formula-workbench`);
    const app = await frameWith('Formula workbench');
    await page.getByRole('button', { name: 'Dark mode' }).click();
    await app.waitForFunction(() => document.documentElement.dataset.mode === 'dark', null, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Light mode' }).click();
  });
} finally {
  await browser.close();
}

console.log(failures ? `${failures} check(s) failed` : 'All checks passed');
process.exit(failures ? 1 : 0);
