import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { start } from '../services/backend/server.mjs';

const capture = process.argv.includes('--capture');
const images = fileURLToPath(new URL('../docs/images/', import.meta.url));
const readPaymentsSample = name => readFile(new URL('../examples/payments/' + name, import.meta.url), 'utf8');
const scopeName = 'Payments service';
const model = 'fixture:review';
const email = 'operator@example.test';
const password = 'Local-2026';
const company = 'Northstar Payments';
const advice = {
  'code-review': 'reader.js:3 returns with the file handle still open. Wrap the read in try/finally and await handle.close() in finally so both successful reads and errors release the handle.',
  compliance: 'The change record names a reviewer and records approval. Verify that the record covers this release.',
};
const seen = [];
const artifactIds = new Map();
const adapter = {
  async listModels({ provider, apiKey }) {
    if (provider === 'anthropic') assert.equal(apiKey, 'fixture-claude-api-key');
    if (provider === 'openai') assert.equal(apiKey, 'fixture-openai-api-key');
    return { provider, models: [model] };
  },
  async reviewFindings(input) {
    assert.equal(input.model, model);
    if (input.evidence[0]?.id === 'test-note') return { provider: input.provider, model, text: 'Connection test' };
    assert.equal(input.provider, 'ollama');
    assert.ok(input.evidence.length || input.findings.length);
    if (input.workflow === 'compliance') {
      assert.deepEqual(input.evidence.map(note => note.title), ['change-approval.md']);
      assert.equal(input.findings.length, 0);
    }
    if (input.workflow === 'code-review') {
      assert.ok(input.evidence.some(note => note.title === 'reader.js' && note.excerpt.includes('handle.read()')));
      assert.ok(input.findings.some(finding => finding.location?.startLine === 3));
    }
    seen.push(input.workflow);
    return {
      provider: 'ollama', model,
      text: advice[input.workflow],
    };
  },
};

async function configureModel(page) {
  await page.getByRole('combobox', {name:/^Provider\b/}).selectOption('ollama');
  await page.getByRole('button', {name:'Connect provider', exact:true}).click();
  await page.getByText('Provider connected.', {exact:true}).waitFor();
  assert.equal(await page.getByLabel('Model', {exact:true}).inputValue(), model);
}

function planFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  return async (request, init) => {
    const url = new URL(request);
    if (url.href === 'https://auth.openai.com/api/accounts/oauth/token') {
      const body = init.body;
      assert.equal(body.get('client_id'), 'oaiapp_fixture');
      assert.equal(body.get('resource'), 'https://api.openai.com/v1');
      const nonce = body.get('code').split('.').at(-1);
      const unsigned = encode({ alg: 'RS256', kid: 'fixture' }) + '.' + encode({
        aud: 'oaiapp_fixture', iss: 'https://auth.openai.com', sub: 'fixture-owner', nonce,
        exp: Math.floor(Date.now() / 1000) + 300, email,
      });
      return Response.json({
        id_token: unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url'),
        access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600,
        scope: 'openid resource.invoke chatgpt.tokens.use.direct',
      });
    }
    if (url.href === 'https://auth.openai.com/.well-known/jwks.json') {
      return Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture' }] });
    }
    if (url.hostname === 'api.openai.com') {
      assert.equal(init.headers.Authorization, 'Bearer fixture-token');
      if (url.pathname === '/v1/models') {
        return Response.json({ models: [{ slug: 'plan-fixture', display_name: 'Plan fixture', visibility: 'list' }] });
      }
      if (url.pathname === '/v1/responses') {
        assert.deepEqual(JSON.parse(init.body), {
          model: 'plan-fixture', input: [{ role: 'user', content: 'Reply with the word Ready.' }], stream: true, store: false,
        });
        return new Response('data: {"type":"response.output_text.delta","delta":"Ready"}\n\ndata: {"type":"response.completed"}\n\n');
      }
    }
    throw new Error('Unexpected provider request in fixture.');
  };
}

async function runReviews(page) {
  const previousCalls = seen.length;
  for (const workflow of ['compliance', 'code-review']) {
    await page.getByLabel('Review type').selectOption(workflow);
    const files = page.getByRole('group', {name:'Evidence to review'});
    const run = page.getByRole('button', {name:'Run review'});
    for (const check of await files.getByRole('checkbox').all()) await check.uncheck();
    assert.equal(await run.isDisabled(), true);
    const selected = workflow === 'compliance' ? ['change-approval.md'] : ['reader.js','review-results.json'];
    for (const name of selected) await files.getByRole('checkbox', {name,exact:true}).check();
    const [request] = await Promise.all([
      page.waitForRequest(r => r.method() === 'POST' && /\/review$/.test(r.url())),
      run.click(),
    ]);
    assert.deepEqual(request.postDataJSON().artifactIds.sort(), selected.map(name => artifactIds.get(name)).sort());
    await page.getByText(advice[workflow], {exact:true}).waitFor();
  }
  assert.deepEqual(seen.slice(previousCalls), ['compliance','code-review']);
}

async function verifyRestored(page) {
  await page.getByRole('button', {name:'Open History phase'}).click();
  for (const workflow of ['compliance', 'code-review']) {
    const saved = page.locator('details').filter({has:page.locator('summary').filter({hasText:workflow})}).first();
    await saved.locator('summary').click();
    await saved.getByText(advice[workflow], {exact:true}).waitFor();
  }
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nullsquare-browser-'));
let server;
let browser;
let page;
const unexpected = [];
const modelTransport = planFixture();
const selectFolder = async () => dataDir;
try {
  server = await start({ port: 0, dataDir, adapter, modelTransport, selectFolder });
  const origin = server.url;
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce', locale: 'en-US',
    timezoneId: 'UTC', serviceWorkers: 'block', acceptDownloads: true,
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    unexpected.push('Remote request to ' + url.origin);
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('console', event => { if (event.type() === 'error') unexpected.push(event.text()); });
  page.on('pageerror', error => unexpected.push(error.message));
  page.on('response', response => { if (response.status() >= 400) unexpected.push(response.status() + ' ' + response.url()); });
  const nav = async name => {
    await page.getByRole('button', { name, exact: true }).click();
    await page.mouse.move(800, 32);
  };
  const button = name => page.getByRole('button', { name, exact: true });
  async function screenshot(name) {
    if (!capture) return;
    await mkdir(images, { recursive: true });
    await page.mouse.move(1200, 24);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(images, name + '.png'), animations: 'disabled' });
  }
  async function upload(name, content, control) {
    await button('Upload evidence').click();
    if (control) await page.getByLabel('Link to control').selectOption(control);
    await page.getByLabel('Evidence file', {exact:true}).setInputFiles({name, mimeType: 'text/plain', buffer: Buffer.from(content)});
    const [changed] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST' && /\/artifacts(?:\/file)?$/.test(new URL(r.url()).pathname)),
      button('Upload').click(),
    ]);
    assert.equal(changed.status(), 201);
    const project = await changed.json();
    artifactIds.set(name, project.artifacts.find(file => file.name === name).id);
    await page.getByText(name, {exact:true}).first().waitFor();
  }

  assert.equal((await context.request.get(origin + '/api/projects')).status(), 401);
  await page.goto(origin);
  await page.getByRole('heading', {name:'Sign up', exact:true}).waitFor();
  await page.getByLabel('Email', {exact:true}).fill(email);
  await page.getByLabel('Password', {exact:true}).fill(password);
  await button('Continue').click();
  await page.getByRole('heading', {name:'Create your organization', exact:true}).waitFor();
  await page.getByLabel('Organization name').fill(company);
  await button('Continue').click();
  await page.getByLabel('Target value').fill('https://workspace.example.test/path');
  await button('Continue').click();
  await page.getByRole('heading', {name:'Authorize the assessment', exact:true}).waitFor();
  await button('I authorize').click();
  await page.getByRole('heading', {name:'Setup complete', exact:true}).waitFor();
  await page.getByRole('link', {name:'Go to Console', exact:true}).click();
  await page.getByRole('heading', {name:'Scopes', exact:true}).waitFor();
  const primaryNav = page.getByRole('navigation', {name:'Primary', exact:true});
  assert.deepEqual(
    await primaryNav.getByRole('button').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))),
    ['Agent', 'Dashboard', 'Assets', 'Risks', 'Compliance', 'Assessments', 'Scopes', 'Models', 'Settings'],
  );
  await button('Open scope: ' + company).click();
  await page.getByText('workspace.example.test', {exact:true}).waitFor();
  await button('Select folder').click();
  await page.getByText(await realpath(dataDir), {exact:true}).waitFor();
  await nav('Profile');
  await page.getByRole('heading', {name:'Profile', exact:true}).waitFor();
  await page.getByLabel('Full name').fill('Casey Operator');
  await button('Save changes').click();
  await page.getByText('Profile saved.', {exact:true}).waitFor();
  await nav('Assets');
  await page.getByText('No assets in this scope', {exact:true}).waitFor();
  await nav('Scopes');
  await button('New scope').click();
  await page.getByLabel('Scope name').fill(scopeName);
  await page.getByLabel('Description').fill('Review change approval and file handling for the payments release.');
  await button('Create scope').click();
  await page.waitForURL(/\/scopes\/[^/]+$/);
  const scopeUrl = page.url();
  const objective = 'Review evidence for the payments release.';
  await page.getByLabel('Description').fill(objective);
  await button('Save changes').click();
  await page.getByText('Scope saved.', {exact:true}).waitFor();
  await page.getByRole('link', {name:'Open assessment', exact:true}).click();
  await page.waitForURL(/\/runs\/[^/]+$/);
  const assessmentUrl = page.url();
  await nav('Compliance');
  await page.getByRole('heading', {name:'Control Readiness'}).waitFor();
  // Open the actual control detail so the uploaded note has a control identity.
  const group = page.getByRole('button', {name:/^Govern\b/}).first();
  if (await group.getAttribute('aria-expanded') === 'false') await group.click();
  await page.getByLabel(/^Open control GV\.OC:/).click();
  await page.getByRole('tab', {name:'Evidence',exact:true}).click();
  await upload('change-approval.md', await readPaymentsSample('change-approval.md'));
  await screenshot('control-evidence');
  await nav('Compliance');
  await page.getByRole('tab', {name:'Evidence Library'}).click();
  const demoFindings = await readFile(new URL('../examples/payments-findings.jsonl', import.meta.url), 'utf8');
  await upload('payments-findings.jsonl', demoFindings);
  await upload('risk-register.md', await readPaymentsSample('risk-register.md'), 'GV.RM');
  const attachedBytes = Buffer.from([0, 122, 255, 10]);
  await upload('control-record.bin', attachedBytes, 'GV.OC');
  const attachedId = artifactIds.get('control-record.bin');
  const downloadURL = origin + '/api/projects/' + new URL(scopeUrl).pathname.split('/').at(-1) + '/artifacts/' + attachedId;
  await button('Edit evidence control-record.bin').click();
  await page.getByLabel('Linked control', {exact:true}).selectOption('GV.RM');
  await page.getByRole('dialog', {name:'Edit evidence'}).getByRole('button', {name:'Save changes', exact:true}).click();
  await page.getByRole('dialog', {name:'Edit evidence'}).waitFor({state:'hidden'});
  const relinked = (await (await context.request.get(downloadURL.split('/artifacts/')[0])).json()).artifacts.find(a => a.id === attachedId);
  assert.equal(relinked.controlId, 'GV.RM');
  assert.deepEqual(await (await context.request.get(downloadURL)).body(), attachedBytes);
  await button('Delete evidence control-record.bin').click();
  await page.getByRole('dialog', {name:'Remove evidence'}).getByRole('button', {name:'Remove', exact:true}).click();
  await page.getByRole('dialog', {name:'Remove evidence'}).waitFor({state:'hidden'});
  assert.equal((await context.request.get(downloadURL)).status(), 404);
  await upload('reader.js', await readPaymentsSample('reader.js'));
  await upload('review-results.json', await readPaymentsSample('review-results.json'));
  await page.getByLabel('View reader.js', {exact:true}).click();
  const sourceDownload = page.waitForEvent('download');
  await page.getByRole('link', {name:'Download original',exact:true}).click();
  assert.match(await readFile(await (await sourceDownload).path(), 'utf8'), /handle\.read\(\)/);
  await screenshot('evidence-library');
  await page.getByRole('tab', {name:'Controls',exact:true}).click();
  await page.getByPlaceholder('Search controls').waitFor();
  if (await group.getAttribute('aria-expanded') === 'false') await group.click();
  await screenshot('control-readiness');
  await nav('Dashboard');
  await page.getByRole('heading', {name:'Top risks', exact:true}).waitFor();
  const coverage = page.getByRole('progressbar', {name:/controls with linked evidence$/});
  await coverage.waitFor();
  assert.equal(await coverage.getAttribute('max'), '22');
  assert.ok(Number(await coverage.getAttribute('value')) > 0);
  if (capture) {
    const viewport = page.viewportSize();
    await page.setViewportSize({width:1088,height:1180});
    const topRisks = page.getByRole('heading',{name:'Top risks',exact:true});
    await topRisks.evaluate(el => el.closest('section').parentElement.scrollIntoView({block:'start'}));
    const sectionBox = title => page.getByRole('heading',{name:title,exact:true})
      .evaluate(el => el.closest('section').getBoundingClientRect().toJSON());
    const top = await sectionBox('Top risks');
    const bottom = await sectionBox('Severity breakdown');
    const clip = {x:top.left-12,y:top.top-12,width:bottom.right-top.left+24,height:bottom.bottom-top.top+24};
    await page.screenshot({path:path.join(images,'dashboard.png'),animations:'disabled',clip});
    await page.setViewportSize(viewport);
  }
  await page.getByRole('link', {name:'payments.example.test', exact:true}).click();
  await page.getByRole('heading', {name:'payments.example.test', exact:true}).waitFor();
  await page.getByRole('link', {name:'review-results.json', exact:true}).waitFor();
  await screenshot('asset-detail');
  const assetUrl = page.url();
  await page.getByRole('tab', {name:/Risks/}).click();
  await page.getByRole('button', {name:/Open risk: .*file-handle-cleanup/}).waitFor();
  await page.getByRole('tab', {name:/Assessments/}).click();
  await page.getByRole('link', {name:scopeName, exact:true}).click();
  assert.equal(page.url(), assessmentUrl);
  await nav('Assets');
  const assetSearch = page.getByPlaceholder('Search assets', {exact:true});
  await page.getByRole('button', {name:'Open asset: payments.example.test', exact:true}).waitFor();
  await screenshot('assets');
  await assetSearch.fill('unrecorded');
  await page.getByText('No assets match this query', {exact:true}).waitFor();
  await assetSearch.fill('payments');
  await page.getByRole('button', {name:'Open asset: payments.example.test', exact:true}).click();
  assert.equal(page.url(), assetUrl);
  await nav('Risks');
  const filter = page.getByPlaceholder('Search risks, assets, rules or files');
  await filter.fill('absent-from-this-scope');
  assert.equal(await page.getByRole('button', {name:/^Open risk:/}).count(), 0);
  await filter.fill('');
  const riskRow = page.getByRole('button', {name:/Open risk: .*file-handle-cleanup/});
  await riskRow.waitFor();
  await screenshot('risks-inbox');
  await riskRow.click();
  const findingUrl = page.url();
  await page.getByRole('tab', {name:'Evidence', exact:true}).click();
  await page.getByRole('link', {name:'Download review-results.json'}).waitFor();
  await page.getByRole('tab', {name:'Remediation', exact:true}).click();
  await page.getByText('Close the handle in a finally block.', {exact:true}).waitFor();
  await page.getByLabel('Current status').selectOption('confirmed');
  await page.getByRole('tab', {name:'History', exact:true}).click();
  await page.getByText('Status changed', {exact:true}).waitFor();
  await page.getByRole('tab', {name:'Remediation', exact:true}).click();
  await screenshot('finding-detail');

  // Remaining journeys exercise the rendered application, including real SQLite
  // persistence and real HTTP exports. Only the provider is deterministic.
  await nav('Assessments');
  await page.getByRole('heading', {name:'Assessment History'}).waitFor();
  const assessment = page.getByRole('button', {name:/Open assessment: Payments service/i});
  await assessment.waitFor();
  await screenshot('assessment-history');
  await assessment.click();
  assert.equal(page.url(), assessmentUrl);
  await page.getByRole('heading', {name:scopeName, exact:true}).waitFor();
  await screenshot('assessment-overview');
  await page.getByRole('tab', {name:'Plan',exact:true}).click();
  await page.getByText(objective, {exact:true}).waitFor();
  await page.getByRole('tab', {name:/^Assets/}).click();
  await page.getByRole('button', {name:'Open asset: payments.example.test', exact:true}).waitFor();
  await page.getByRole('tab', {name:/Risks/}).click();
  await page.getByText('example.file-handle-cleanup', {exact:true}).first().waitFor();
  await page.getByRole('tab', {name:'Activity',exact:true}).click();
  await page.getByRole('heading', {name:'Assessment timeline',exact:true}).waitFor();
  await page.getByText('change-approval.md', {exact:true}).first().waitFor();
  const extra = await context.request.post(origin + '/api/projects', {
    data: { name: 'Empty secondary scope', scope: 'Verifies assessment links use their own scope.' },
  });
  assert.equal(extra.status(), 201);
  const other = await extra.json();
  await page.goto(origin + '/runs/' + encodeURIComponent(other.id));
  await page.getByRole('heading', {name:other.name, exact:true}).waitFor();
  await nav('Assets');
  await page.getByText('No assets in this scope', {exact:true}).waitFor();
  await page.goto(assessmentUrl);
  await page.getByRole('heading', {name:scopeName, exact:true}).waitFor();
  await page.getByRole('link', {name:'Open compliance', exact:true}).click();
  await page.getByRole('tab', {name:'Evidence Library'}).click();
  await page.getByText('change-approval.md', {exact:true}).first().waitFor();
  await nav('Models');
  await page.getByRole('heading', {name:'Models', exact:true}).waitFor();
  const claude = page.getByRole('link', {name:'Continue with Claude', exact:true});
  assert.equal(await claude.getAttribute('href'), 'https://platform.claude.com/settings/keys');
  const consoleURL = await claude.getAttribute('href');
  await context.route(consoleURL, route => route.fulfill({contentType:'text/html', body:'Claude Console fixture'}));
  const [consolePage] = await Promise.all([page.waitForEvent('popup'), claude.click()]);
  await consolePage.waitForURL(consoleURL);
  await consolePage.close();
  await context.unroute(consoleURL);
  assert.equal(await page.getByLabel('Provider', {exact:true}).inputValue(), 'anthropic');
  await page.getByLabel('API key', {exact:true}).fill('fixture-claude-api-key');
  await button('Connect provider').click();
  await page.getByText('Provider connected.', {exact:true}).waitFor();
  await button('Test connection').click();
  await page.getByText(/Connection test passed/).waitFor();
  await button('Disconnect').click();
  await page.getByText('Model disconnected.', {exact:true}).waitFor();
  await page.getByLabel('Provider', {exact:true}).selectOption('openai');
  await page.getByLabel('API key', {exact:true}).fill('fixture-openai-api-key');
  await button('Connect provider').click();
  await page.getByText('Provider connected.', {exact:true}).waitFor();
  await button('Test connection').click();
  await page.getByText(/Connection test passed/).waitFor();
  await page.route('https://auth.openai.com/api/accounts/authorize?*', route => {
    const params = new URL(route.request().url()).searchParams;
    assert.equal(params.get('client_id'), 'dynamic_agent_client');
    assert.equal(params.get('code_challenge_method'), 'S256');
    const callback = new URL(params.get('redirect_uri'));
    assert.equal(callback.origin, origin);
    callback.searchParams.set('code', 'fixture.' + params.get('nonce'));
    callback.searchParams.set('client_id', 'oaiapp_fixture');
    callback.searchParams.set('state', params.get('state'));
    return route.fulfill({status:302, headers:{Location:callback.href}});
  });
  await button('Continue with ChatGPT').click();
  await page.getByText(/ChatGPT is connected/).waitFor();
  await page.getByRole('link', {name:'Return to Models', exact:true}).click();
  await page.getByRole('heading', {name:'Active connection', exact:true}).waitFor();
  assert.equal(await page.getByLabel('Model', {exact:true}).inputValue(), 'plan-fixture');
  await button('Test connection').click();
  await page.getByText(/Connection test passed/).waitFor();
  await configureModel(page);
  await screenshot('model-settings');
  await page.goto(assessmentUrl);
  await page.getByRole('link', {name:'Open workbench',exact:true}).click();
  await page.waitForURL('**/workbench');
  const workbenchUrl = page.url();
  if (process.argv.includes('--record')) {
    const { recordAssessment } = await import('./record-assessment.mjs');
    await recordAssessment(page, images, advice['code-review']);
    await page.goto(workbenchUrl);
  }
  await runReviews(page);
  await screenshot('code-review');
  await page.getByRole('link', {name:'Back to assessment',exact:true}).click();
  await button('View report').click();
  const reportDialog = page.getByRole('dialog', {name:'Assessment report',exact:true});
  await reportDialog.getByText(/reader\.js/).first().waitFor();
  const downloadPromise = page.waitForEvent('download');
  await reportDialog.getByRole('link', {name:/markdown/i}).click();
  const file = await downloadPromise;
  const exported = await readFile(await file.path(), 'utf8');
  assert.ok(exported.includes(scopeName) && exported.includes('reader.js') && exported.includes('change-approval.md'));
  const sarif = page.waitForEvent('download');
  await reportDialog.getByRole('link', {name:'Download SARIF',exact:true}).click();
  const exportedSarif = JSON.parse(await readFile(await (await sarif).path(), 'utf8'));
  assert.equal(exportedSarif.version, '2.1.0');
  assert.equal(exportedSarif.runs[0].results.length, 1 + demoFindings.trim().split('\n').length);

  await page.goto('about:blank');
  await server.close();
  server = undefined;
  server = await start({ port: Number(new URL(origin).port), dataDir, adapter, modelTransport, selectFolder });
  await page.goto(assetUrl);
  await page.getByRole('heading', {name:'payments.example.test', exact:true}).waitFor();
  await page.goto(findingUrl);
  await page.getByLabel('Current status').waitFor();
  assert.equal(await page.getByLabel('Current status').inputValue(), 'confirmed');
  await page.goto(origin + '/compliance');
  await page.getByRole('tab', {name:'Evidence Library'}).click();
  await page.getByText('change-approval.md', {exact:true}).first().waitFor();
  await page.goto(workbenchUrl);
  await verifyRestored(page);
  await page.goto(scopeUrl);
  await page.getByLabel('Description').waitFor();
  assert.equal(await page.getByLabel('Description').inputValue(), objective);
  await button('Profile').click();
  await page.getByLabel('Full name').waitFor();
  assert.equal(await page.getByLabel('Full name').inputValue(), 'Casey Operator');
  await nav('Models');
  await button('Connect provider').waitFor();
  assert.equal(await button('Disconnect').count(), 0);
  await configureModel(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await button('Open menu').click();
  await nav('Scopes');
  await page.getByText(scopeName, {exact:true}).last().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile viewport overflows');
  await page.setViewportSize({ width: 1440, height: 960 });
  await button('Profile').click();
  await button('Sign out').click();
  await page.getByRole('heading', {name:'Sign in', exact:true}).waitFor();
  assert.equal((await context.request.get(origin + '/api/projects')).status(), 401);
  await page.getByLabel('Email', {exact:true}).fill(email);
  await page.getByLabel('Password', {exact:true}).fill(password);
  await button('Continue').click();
  await page.getByRole('heading', {name:'Scopes', exact:true}).waitFor();
  assert.deepEqual(unexpected, []);
  console.log('Browser passed: local signup and onboarding, folder association, Models connections, evidence relinking and removal, original workspace views, both review workflows, restart and sign-in.');
} catch (error) {
  if (unexpected.length) console.error('Browser diagnostics:', unexpected);
  if (page && !page.isClosed()) console.error('Visible text:', (await page.locator('body').innerText()).slice(0, 1200));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  if (path.dirname(dataDir) === os.tmpdir()) await rm(dataDir, { recursive: true, force: true });
}
