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
/** `extraAttributes` are further items of the `attributes` list, which comes last. */
const blueprintDefinition = (extraAttributes = '') => `format_version: 1
code: ${blueprintCode}
name: Formula e2e ${suffix}
kind: record

views:
  dropdown_option:
    type: dropdown_option
    fields: [title]
  table:
    type: table
    columns:
      - field: title
      - field: price_gross
        label: Gross
        renderer:
          id: ${EXTENSION}.computed-number
          version: 1
          props: { precision: 2, unit: EUR }
      - field: price_net
        label: Net
        renderer:
          id: ${EXTENSION}.computed-number
          version: 1
          props: { unit: net }

extensions:
  ${EXTENSION}:
    formulas:
      price_gross: price_net * (1 + vat_rate)
      price_deposit: price_gross * 0.2

attributes:
  - code: title
    value_type: string
  - code: price_net
    value_type: number
  - code: vat_rate
    value_type: number
  - code: price_gross
    value_type: number
  - code: price_deposit
    value_type: number
  - code: datasheet
    value_type: file
${extraAttributes}`;
const definition = blueprintDefinition();

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
// A datasheet file on Alpha, beneath which the host shows a file note.
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

  await step('route + navigation: each document template opens its own page', async () => {
    await page.goto(`${WEB}/extensions/${EXTENSION}/document-templates`);
    const app = await frameWith('Summary sheet');
    if (!(await page.getByRole('link', { name: 'Document templates' }).count())) throw new Error('navigation entry missing');
    // The suite reuses one workspace: start from a clean slate.
    if (await app.getByRole('button', { name: 'Edit Price sheet' }).count()) {
      await app.getByRole('button', { name: 'Edit Price sheet' }).click();
      await app.getByRole('button', { name: 'Delete template' }).click();
      await app.getByText('Deleted Price sheet.').waitFor({ timeout: 30_000 });
    }
    await app.getByRole('button', { name: 'New template' }).click();
    await app.getByRole('heading', { name: 'New template', level: 1 }).waitFor({ timeout: 10_000 });
    const created = app.getByRole('region', { name: 'New template' });
    await created.getByLabel('Template ID').fill('price-sheet');
    await created.getByLabel('Name').fill('Price sheet');
    await created.getByLabel('Body').fill('Gross: {{ price_gross }} EUR\nDeposit: {{ price_deposit }}\nColour: ');
    // The editor inserts marks at the caret and checks them as you type.
    await created.getByLabel('Body').press('End');
    await created.getByLabel('Attribute code to insert').fill('colour');
    await created.getByRole('button', { name: 'Insert attribute' }).click();
    await created.getByText('Marks used: title, price_gross, price_deposit, colour').waitFor({ timeout: 10_000 });
    await created.getByLabel('Title').fill('{{ title');
    await created.getByText('Title: A {{ mark is not closed with }}.').waitFor({ timeout: 10_000 });
    await created.getByLabel('Title').fill('{{ title }}');
    await created.getByRole('button', { name: 'Create template' }).click();
    // Creating opens the new template's own page; a second save is version 2.
    await app.getByRole('heading', { name: 'Price sheet', level: 1 }).waitFor({ timeout: 30_000 });
    const editor = app.getByRole('region', { name: 'Template Price sheet' });
    await editor.getByLabel('Body').fill(`E2E ${suffix}\n${await editor.getByLabel('Body').inputValue()}`);
    await editor.getByRole('button', { name: 'Save template' }).click();
    await app.getByRole('region', { name: 'Template Price sheet' }).getByText('version 2').waitFor({ timeout: 30_000 });
    await app.getByRole('button', { name: '← All templates' }).click();
    const row = app.getByRole('row', { name: /Price sheet/ });
    if (!/title, price_gross, price_deposit, colour\s*2/.test(await row.innerText())) throw new Error(await row.innerText());
  });

  await step('blueprint_detail_panel lists the validated formula', async () => {
    await page.goto(`${WEB}/manage/blueprints/${blueprint.id}`);
    await frameWith('price_net, vat_rate');
  });

  await step('blueprint_panel summarizes dependencies and marks the chain', async () => {
    await frameWith(/price_deposit ← price_gross\s*chained/);
  });

  await step('blueprint_attribute_configuration edits rounding in native UI', async () => {
    await page.goto(`${WEB}/manage/blueprints/${blueprint.id}/revisions/${blueprint.version}/new`);
    // Native UI is drawn in Attricat's own page, not in a frame.
    const settings = page.getByRole('region').filter({ hasText: 'price_net * (1 + vat_rate)' });
    await settings.waitFor({ timeout: 90_000 });
    for (const frame of page.frames())
      if (frame !== page.mainFrame() && (await frame.content().catch(() => '')).includes('price_net * (1 + vat_rate)'))
        throw new Error('the settings were drawn in a frame');
    await settings.getByRole('combobox', { name: 'Decimal places' }).click();
    await page.getByRole('option', { name: '2 decimals' }).click();
    await settings.getByRole('button', { name: 'Save' }).click();
    await settings.getByText('Saved for this revision.').waitFor({ timeout: 60_000 });
  });

  await step('attribute_editor: the formula editor suggests, saves on Enter and restores on Escape', async () => {
    const editorCode = `formula_editor_e2e_${suffix}`;
    const created = await api('POST', '/blueprints', {
      definition: `format_version: 1
code: ${editorCode}
name: Formula editor e2e ${suffix}
kind: record
views:
  dropdown_option:
    type: dropdown_option
    fields: [title]
  detail:
    type: stack
    children:
      - {type: field, field: title}
      - type: field
        field: margin_formula
        editor: {id: formula-editor, version: 1}
attributes:
  - code: title
    value_type: string
  - code: price_net
    value_type: number
  - code: vat_rate
    value_type: number
  - code: margin_formula
    value_type: string
`,
    });
    const editorBlueprint = created.blueprint ?? created;
    await api('POST', `/blueprints/${editorBlueprint.id}/versions/${editorBlueprint.version}/publish`);
    const record = (await api('POST', '/v1/records', {
      blueprint: { code: editorCode, version: editorBlueprint.version },
      values: [scalar('title', 'Editor', defaultContext.id)],
    })).id;
    await page.goto(`${WEB}/records/${record}`);
    const field = page.getByRole('group', { name: 'margin formula' });
    const input = field.getByRole('combobox', { name: 'margin formula' });
    await input.waitFor({ timeout: 90_000 });
    await input.click();
    await input.pressSequentially('price_n', { delay: 30 });
    await page.getByRole('option', { name: 'price_net' }).click();
    await input.pressSequentially(' * (1 + vat_rate)', { delay: 20 });
    const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/v1/records/${record}`));
    await page.waitForTimeout(400);
    await input.press('Enter');
    if ((await saved).status() !== 200) throw new Error('the formula was not saved');
    const values = await api('GET', `/records/${record}/values/current`);
    const stored = values.find((value) => value.value === 'price_net * (1 + vat_rate)');
    if (!stored) throw new Error(`stored values: ${JSON.stringify(values.map((value) => value.value))}`);
    // An unknown name is flagged, and Escape restores the saved formula.
    await input.pressSequentially(' + bogus', { delay: 20 });
    await field.getByText('Unknown attribute: bogus').waitFor({ timeout: 10_000 });
    await input.press('Escape');
    await page.waitForFunction(
      () => [...document.querySelectorAll('input')].some((element) => element.value === 'price_net * (1 + vat_rate)'),
      null,
      { timeout: 10_000 },
    );
  });

  await step('data_health_card shows counters', async () => {
    await page.goto(`${WEB}/manage/data-health`);
    await frameWith(/\d+\s*evaluations/);
  });

  await step('record_field_notes: badges and notes beside the fields', async () => {
    await page.goto(`${WEB}/records/${alpha}`);
    // The host renders the notes itself; no frame runs beside a field.
    await page.getByText('Feeds price_gross').first().waitFor({ timeout: 90_000 });
    // The context bar shows the first few contexts as tabs and the rest in a
    // "More contexts" combobox.
    const contextTab = page.getByRole('tab', { name: context.code });
    if (await contextTab.count()) await contextTab.click();
    else {
      await page.getByRole('combobox', { name: 'More contexts' }).click();
      await page.getByRole('option', { name: context.code }).click();
    }
    await page.getByText('price_gross = price_net * (1 + vat_rate)').first().waitFor({ timeout: 30_000 });
    // A Computed badge opens the recalculation dialog for this record.
    await page.getByRole('button', { name: 'Computed' }).first().click();
    await frameWith('1 selected record');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  });

  await step('record_tab evaluates, previews and recalculates', async () => {
    await page.getByRole('tab', { name: 'Formulas', exact: true }).click();
    const inspector = await frameWith(/Result\s+122\.99 EUR/);
    await inspector.getByLabel('Expression to preview').fill('price_net * 2');
    await inspector.getByRole('button', { name: 'Preview' }).click();
    await inspector.getByText('= 199.98').waitFor({ timeout: 30_000 });
    await inspector.getByRole('button', { name: 'Recalculate formulas' }).click();
    await frameWith('up to date');
    // The open tab is part of the record's address, so a link opens it. A
    // second page keeps this one's selected context for the next steps.
    await page.waitForURL((url) => url.searchParams.get('tab') === `${EXTENSION}:formula-inspector`);
    const linked = await page.context().newPage();
    try {
      await linked.goto(page.url());
      await linked.getByRole('tab', { name: 'Formulas', exact: true, selected: true }).waitFor({ timeout: 30_000 });
      await frameWith('Computed attributes', 90_000, linked);
    } finally {
      await linked.close();
    }
  });

  await step('record_action + action_dialog generate one combined PDF', async () => {
    // Record actions are host-rendered buttons at the end of the Data tab.
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await page.getByRole('button', { name: 'Generate document…' }).click();
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
    // The PDF has the marks replaced with Alpha's saved values in the run's
    // context; a missing value prints as "-".
    const response = await fetch(`${WEB}/api/extension-operation-runs/${last.run_id}/artifacts/${last.artifact_id}/download`, {
      headers: { cookie: `attricat_session=${session.session}; attricat_csrf=${session.csrf}` },
    });
    if (!response.ok) throw new Error(`PDF download → ${response.status}`);
    const pdf = Buffer.from(await response.arrayBuffer()).toString('latin1');
    for (const text of [`E2E ${suffix}`, '(Alpha)', 'Gross: 122.99 EUR', 'Deposit: 24.598', 'Colour: -']) {
      if (!pdf.includes(text)) throw new Error(`the PDF does not contain ${JSON.stringify(text)}`);
    }
  });

  await step('a template whose marks all resolve completes its run', async () => {
    // No result field is left empty here, so the run must still read back its
    // own checkpoint through to the report batch.
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await page.getByRole('button', { name: 'Generate document…' }).click();
    const dialog = await frameWith(/Product label \(v\d+\)/);
    await dialog.getByLabel('Template').selectOption('label');
    await dialog.getByLabel('Output').selectOption('individual');
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
    await frameWith('Run Completed · 1 generated', 180_000);
    if (!(await dialog.getByRole('button', { name: 'Download document-1.pdf' }).count())) throw new Error('no document-1.pdf download');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const last = (await api('GET', `/records/${alpha}`)).system_metadata?.[EXTENSION]?.last_document;
    if (last?.template !== 'label') throw new Error(JSON.stringify(last));
  });

  await step('record_action recalculates through its server command', async () => {
    await page.getByRole('tab', { name: 'Data', exact: true }).click();
    await page.getByRole('button', { name: 'Recalculate formulas', exact: true }).click();
    // The host shows the command's notification.
    await page.getByText(/Computed values are up to date\.|Updated \d+ computed value\(s\)\./).first().waitFor({ timeout: 90_000 });
  });

  await step('record_header_action checks the formulas', async () => {
    // Header actions are items of the record's Actions menu.
    await page.getByRole('navigation', { name: 'Record' }).getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Check formulas' }).click();
    await page.getByText('2 valid formulas: price_gross, price_deposit.').waitFor({ timeout: 30_000 });
  });

  await step('command palette runs a page action (Ctrl+K)', async () => {
    await page.keyboard.press('Control+k');
    await page.getByLabel('Search actions').fill('check');
    await page.getByRole('button', { name: /Check formulas/ }).click();
    await page.getByText('2 valid formulas: price_gross, price_deposit.').first().waitFor({ timeout: 30_000 });
  });

  await step('a command result navigates to the extension page', async () => {
    await page.getByRole('navigation', { name: 'Record' }).getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open formula workbench' }).click();
    await page.waitForURL(/\/extensions\/attricat-extension-example\/formula-workbench$/, { timeout: 30_000 });
    await page.goto(`${WEB}/records/${alpha}`);
  });

  await step('record_field_notes: the last generated document beneath a file', async () => {
    // The host renders file notes beneath read-only file values only; a
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
      await viewerPage.getByText(/Last document: label template, separate PDF/).waitFor({ timeout: 90_000 });
    } finally {
      await viewerContext.close();
    }
  });

  await step('explorer_table_cell draws the declared computed-number cell', async () => {
    // The host draws the cell from the manifest's declaration, so its text is
    // in the page itself rather than in an extension frame.
    await page.goto(`${WEB}/?blueprint=${blueprintCode}&version=${blueprint.version}&context=${context.code}`);
    const table = page.getByRole('table');
    await table.getByText('55.00 EUR', { exact: true }).waitFor({ timeout: 30_000 });
    // Without a precision prop the value keeps its own decimals.
    await table.getByText('99.99 net', { exact: true }).first().waitFor({ timeout: 30_000 });
  });

  await step('explorer_action lists the revision formulas', async () => {
    // Toolbar actions sit behind one host-owned button.
    await page.getByRole('button', { name: 'Extension actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Show formulas' }).click();
    await page.getByText(/price_gross = price_net \* \(1 \+ vat_rate\) · price_deposit = price_gross \* 0\.2/).waitFor({ timeout: 30_000 });
  });

  await step('explorer_row_action opens the recalculation dialog for one record', async () => {
    await page.getByRole('button', { name: `Record actions for ${alpha}` }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Recalculate formulas…' }).click();
    await frameWith('1 selected record');
    // The host dialog owns the close control; the frame renders none.
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  });

  await step('explorer_bulk_action + action_dialog run the interactive operation', async () => {
    await page.goto(`${WEB}/?blueprint=${blueprintCode}&version=${blueprint.version}&context=${context.code}`);
    await page.getByRole('button', { name: 'Select records' }).click();
    const boxes = page.getByRole('checkbox');
    for (let index = 1; index < (await boxes.count()); index += 1) await boxes.nth(index).check();
    // Bulk actions are items of the selection's Actions menu.
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Recalculate formulas…' }).click();
    const dialog = await frameWith('3 selected records');
    await dialog.getByLabel('Mode').selectOption('write');
    await dialog.getByRole('button', { name: 'Start' }).click();
    await frameWith('Completed: 3 succeeded', 180_000);
    if (!(await dialog.getByRole('button', { name: /Download formula-report\.csv/ }).count())) throw new Error('no report download');
  });

  await step('an operation action asks first, then starts its run', async () => {
    await page.goto(`${WEB}/?blueprint=${blueprintCode}&version=${blueprint.version}&context=${context.code}`);
    await page.getByRole('button', { name: 'Select records' }).click();
    const boxes = page.getByRole('checkbox');
    for (let index = 1; index < (await boxes.count()); index += 1) await boxes.nth(index).check();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Recalculate formulas now' }).click();
    // The host asks with the manifest's message before starting anything.
    const confirm = page.getByRole('dialog');
    await confirm.getByText('Write recalculated values to the selected records?', { exact: false }).waitFor();
    await confirm.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Extension run started.', { exact: false }).first().waitFor({ timeout: 30_000 });
    await page.getByText('Extension run completed.').first().waitFor({ timeout: 180_000 });
  });

  await step('Polish viewers see translated titles and notes', async () => {
    const polish = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'pl-PL' });
    try {
      await polish.request.post(`${WEB}/api/auth/login`, {
        data: { login_identifier: 'default.local', email: 'admin@example.test', password: 'test' },
      });
      const polishPage = await polish.newPage();
      await polishPage.goto(`${WEB}/records/${alpha}`);
      await polishPage.getByRole('button', { name: 'Przelicz formuły', exact: true }).waitFor({ timeout: 60_000 });
      await polishPage.getByText(/Zasila price_gross/).first().waitFor({ timeout: 60_000 });
    } finally {
      await polish.close();
    }
  });

  await step('interactive run annotated the selection', async () => {
    const record = await api('GET', `/records/${beta}`);
    if (!record.system_tags?.includes(`${EXTENSION}:formulas-checked`)) throw new Error(JSON.stringify(record.system_tags));
  });

  await step('blueprint_publish_check shows the formulas to expect', async () => {
    await api('POST', `/blueprints/${blueprint.id}/versions`, {
      definition: blueprintDefinition('  - code: note\n    value_type: string\n'),
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
