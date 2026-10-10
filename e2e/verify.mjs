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
//   CATALOG_WEB_URL=http://127.0.0.1:5173 CATALOG_SESSION_FILE=.acli-session just e2e
//
// The script creates its own uniquely named context, blueprint revision and
// records through the API, then exercises every server feature and UI
// contribution of the extension in a real browser.

import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const EXTENSION = 'attricat-extension-example';
const WEB = (process.env.CATALOG_WEB_URL ?? '').replace(/\/$/, '');
const SESSION_FILE = process.env.CATALOG_SESSION_FILE;
if (!WEB || !SESSION_FILE) {
  console.error('Set CATALOG_WEB_URL and CATALOG_SESSION_FILE (an acli --session-file).');
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
      cookie: `catalog_session=${session.session}; catalog_csrf=${session.csrf}`,
      'x-catalog-csrf': session.csrf,
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

[extensions.${EXTENSION}.formulas]
price_gross = "price_net * (1 + vat_rate)"
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
const grossIn = async (recordId, contextId) => {
  const values = await api('GET', `/records/${recordId}/values/current`);
  return values.find((value) => value.attribute_id === gross.id && value.context_id === contextId)?.value;
};

await update(alpha, [scalar('price_net', 99.99, context.id), scalar('vat_rate', 0.23, context.id)]);
const alphaGross = await poll('alpha price_gross', () => grossIn(alpha, context.id), (value) => value !== undefined);
check('event handler writes the target in the non-default context, rounded', alphaGross === 122.99, alphaGross);
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
    { name: 'catalog_session', value: session.session, domain: hostname, path: '/' },
    { name: 'catalog_csrf', value: session.csrf, domain: hostname, path: '/' },
  ]);
  return browserContext.newPage();
})();

const frameWith = async (text, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const body = await frame.locator('body').innerText({ timeout: 500 });
        if (typeof text === 'string' ? body.includes(text) : text.test(body)) return frame;
      } catch {
        // Frames come and go while the host mounts contributions.
      }
    }
    await page.waitForTimeout(500);
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

  await step('blueprint_detail_panel lists the validated formula', async () => {
    await page.goto(`${WEB}/manage/blueprints/${blueprint.id}`);
    await frameWith('price_net, vat_rate');
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
    await page.getByRole('tab', { name: context.code }).click();
    await page.getByRole('button', { name: 'View extension content for price gross' }).click();
    await frameWith('⚡ Computed');
    await page.keyboard.press('Escape');
  });

  await step('record_preview_panel evaluates, previews and recalculates', async () => {
    await page.getByRole('button', { name: 'Extension contributions' }).click();
    const inspector = await frameWith(/Result\s+122\.99 EUR/);
    await inspector.getByLabel('Expression to preview').fill('price_net * 2');
    await inspector.getByRole('button', { name: 'Preview' }).click();
    await inspector.getByText('= 199.98').waitFor({ timeout: 30_000 });
    await inspector.getByRole('button', { name: 'Recalculate formulas' }).click();
    await frameWith('up to date');
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

  await step('explorer_row_action (v2) opens the dialog for one record', async () => {
    await page.getByRole('button', { name: `Record actions for ${alpha}` }).click();
    await page.getByRole('menu').getByRole('button', { name: /extension/i }).click();
    const row = await frameWith('Recalculate formulas…');
    await row.getByRole('button').click();
    const dialog = await frameWith('1 selected record');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  await step('explorer_bulk_action (v2) + action_dialog run the interactive operation', async () => {
    await page.goto(`${WEB}/?blueprint=${blueprintCode}&version=${blueprint.version}&context=${context.code}`);
    await page.getByRole('button', { name: 'Select records' }).click();
    const boxes = page.getByRole('checkbox');
    for (let index = 1; index < (await boxes.count()); index += 1) await boxes.nth(index).check();
    const bulk = await frameWith(/Recalculate formulas \(3\)…/);
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
