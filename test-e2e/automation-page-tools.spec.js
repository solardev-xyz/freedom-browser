'use strict';

const path = require('path');
const { test, expect } = require('./fixtures');
const MAIN = path.resolve(__dirname, '../src/main/automation');
const URL = 'https://page-tools.test/';

async function setup({ electronApp, window, harness }, mode = 'hidden') {
  await expect(window.locator('body')).toBeVisible();
  await harness.setContentFixture(`${URL}next`, { body: '<h1>Next document</h1>' });
  await harness.setContentFixture(`${URL}frame`, {
    body: `<!doctype html><script>
    document.modelContext.registerTool({name:'child_only', description:'Frame tool', execute:()=>({child:true})});
  </script>`,
  });
  await harness.setContentFixture(URL, {
    body: `<!doctype html><title>Native page tools</title>
    <p id="receipt">Untouched</p>
    <form toolname="automatic_form" tooldescription="Automatic echo" toolautosubmit>
      <label>Value<input name="value" required></label><button>Automatic submit</button>
    </form>
    <form toolname="manual_form" tooldescription="Manual echo">
      <label>Value<input name="value" required></label><button>Manual submit</button>
    </form>
    <iframe src="${URL}frame"></iframe>
    <script>
      window.calls = 0;
      window.ready = (async () => {
        await document.modelContext.registerTool({name:'echo', description:'Echo the value', annotations:{readOnlyHint:true},
          inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},
          execute:({value})=>{ calls++; document.querySelector('#receipt').textContent=value; return {value}; }});
        await document.modelContext.registerTool({name:'slow', description:'Wait for cancellation',
          execute:(_args, options)=>new Promise(resolve=>{ calls++; window.executeOptions=options ? Object.keys(options) : null; options?.signal?.addEventListener('abort',()=>{
            document.querySelector('#receipt').textContent='Aborted'; resolve({aborted:true}); }); })});
        await document.modelContext.registerTool({name:'route', description:'Change SPA route',
          execute:async ()=>{ calls++; history.pushState({},'', '#results'); await new Promise(resolve=>setTimeout(resolve,100)); return {routed:true}; }});
        await document.modelContext.registerTool({name:'leave', description:'Navigate away',
          execute:()=>{ calls++; location.href='${URL}next'; return new Promise(()=>{}); }});
        await document.modelContext.registerTool({name:'fail', description:'Throw an error',
          execute:()=>{ calls++; throw new Error('Page-controlled exception body'); }});
        for (const form of document.forms) form.addEventListener('submit', event => {
          event.preventDefault();
          if (event.agentInvoked) event.respondWith(Promise.resolve({value:form.elements.value.value, agentInvoked:true}));
          document.querySelector('#receipt').textContent=form.elements.value.value;
        });
      })();
    </script>`,
  });
  if (mode === 'desktop') {
    await window.locator('[data-test="address-input"]').fill(URL);
    await window.locator('[data-test="address-input"]').press('Enter');
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ webContents }, url) =>
            webContents.getAllWebContents().some((w) => w.getURL() === url && !w.isLoading()),
          URL
        )
      )
      .toBe(true);
  } else {
    await electronApp.evaluate(
      (_e, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
      URL
    );
  }
  await electronApp.evaluate(
    async ({ webContents }, { main, url }) => {
      const req = (file) => process.mainModule.require(`${main}/${file}`);
      const { WebContentsPageAdapter } = req('adapters/web-contents-page-adapter');
      const { AutomationController } = req('automation-controller');
      const { createInitialAutomationPolicy } = req('policy-controller');
      const { createOriginScopedAutomationController } = req('origin-scoped-controller');
      const owner = webContents.getAllWebContents().find((w) => w.getURL() === url);
      await owner.executeJavaScript('window.ready');
      const adapter = new WebContentsPageAdapter(owner);
      const controller = new AutomationController({
        policyController: createInitialAutomationPolicy(),
      });
      const tabId = controller.registerPage(adapter);
      const state = { owner, adapter, controller, tabId, approvals: [], decision: 'approved' };
      state.scoped = await createOriginScopedAutomationController({
        controller,
        tabId,
        approvalMode: 'allow_website_interactions',
        requestApproval: async (request) => {
          state.approvals.push(request);
          if (state.decision === 'navigate') await owner.loadURL(`${url}next`);
          if (state.decision === 'stop') await adapter.stopLoading();
          return ['navigate', 'stop'].includes(state.decision) ? 'approved' : state.decision;
        },
      });
      globalThis.__PAGE_TOOLS_TEST__ = state;
    },
    { main: MAIN, url: URL }
  );
}

function execute(app, operation, input = {}) {
  return app.evaluate(
    (_e, args) => {
      const s = globalThis.__PAGE_TOOLS_TEST__;
      return s.scoped.execute(args.operation, { tabId: s.tabId, ...args.input });
    },
    { operation, input }
  );
}
async function tool(app, name) {
  const result = await execute(app, 'browser_list_page_tools');
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.result.available).toBe(true);
  const entry = result.result.tools.find((candidate) => candidate.name === name);
  expect(entry, JSON.stringify(result)).toBeTruthy();
  return entry.toolRef;
}
function script(app, code) {
  return app.evaluate(
    (_e, source) => globalThis.__PAGE_TOOLS_TEST__.owner.executeJavaScript(source),
    code
  );
}

test.afterEach(async ({ electronApp }) => {
  await electronApp.evaluate(() => globalThis.__PAGE_TOOLS_TEST__?.adapter.dispose());
});

for (const mode of ['hidden', 'desktop'])
  test(`native WebMCP works in ${mode} pages with approvals and isolated discovery`, async ({
    electronApp,
    window,
    harness,
  }) => {
    const fixtures = { electronApp, window, harness };
    await setup(fixtures, mode);
    const discovery = await execute(electronApp, 'browser_list_page_tools');
    expect(discovery.result.tools.some((entry) => entry.name === 'child_only')).toBe(false);
    expect(
      discovery.result.tools.find((entry) => entry.name === 'echo').inputSchema.required
    ).toEqual(['value']);
    expect((await execute(electronApp, 'browser_snapshot')).result.pageToolsAvailable).toBe(true);
    await script(
      electronApp,
      "document.modelContext.getTools = () => { throw new Error('Main-world override'); }; void 0"
    );
    const toolRef = await tool(electronApp, 'echo');
    const result = await execute(electronApp, 'browser_call_page_tool', {
      toolRef,
      arguments: { value: 'Native success' },
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      result: { status: 'completed', output: '{"value":"Native success"}' },
    });
    expect(await script(electronApp, 'window.calls')).toBe(1);
    const approvals = await electronApp.evaluate(() => globalThis.__PAGE_TOOLS_TEST__.approvals);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      pageTool: { name: 'echo', argumentsJSON: '{"value":"Native success"}' },
    });
  });

test('declarative automatic and manual submission retain native behavior', async ({
  electronApp,
  window,
  harness,
}) => {
  const fixtures = { electronApp, window, harness };
  await setup(fixtures);
  let toolRef = await tool(electronApp, 'automatic_form');
  let result = await execute(electronApp, 'browser_call_page_tool', {
    toolRef,
    arguments: { value: 'Automatic' },
  });
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    result: { status: 'completed' },
  });
  expect(JSON.parse(result.result.output)).toEqual({ value: 'Automatic', agentInvoked: true });
  toolRef = await tool(electronApp, 'manual_form');
  result = await execute(electronApp, 'browser_call_page_tool', {
    toolRef,
    arguments: { value: 'Manual' },
  });
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    result: { status: 'awaiting_user' },
  });
  expect(await script(electronApp, 'document.forms[1].elements.value.value')).toBe('Manual');
  expect(await script(electronApp, "document.querySelector('#receipt').textContent")).toBe(
    'Automatic'
  );
  // Simulate the user's trusted click, not another agent tool invocation.
  await electronApp.evaluate(async () => {
    const { owner } = globalThis.__PAGE_TOOLS_TEST__;
    const point = await owner.executeJavaScript(
      `(() => {const r=document.forms[1].querySelector('button').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
    );
    owner.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    owner.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  });
  await expect
    .poll(
      async () => (await execute(electronApp, 'browser_list_page_tools')).result.execution?.status
    )
    .toBe('completed');
});

for (const decision of ['declined', 'navigate', 'stop'])
  test(`${decision} while approval is open prevents invocation`, async ({
    electronApp,
    window,
    harness,
  }) => {
    const fixtures = { electronApp, window, harness };
    await setup(fixtures);
    const toolRef = await tool(electronApp, 'echo');
    await electronApp.evaluate((_e, value) => {
      globalThis.__PAGE_TOOLS_TEST__.decision = value;
    }, decision);
    const result = await execute(electronApp, 'browser_call_page_tool', {
      toolRef,
      arguments: { value: 'Should not run' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: decision === 'declined' ? 'USER_CANCELLED' : 'STALE_ELEMENT_REFERENCE' },
    });
    if (decision !== 'navigate') expect(await script(electronApp, 'window.calls')).toBe(0);
  });

test('Stop cancels invocation without claiming to undo website work; errors and navigation are not retried', async ({
  electronApp,
  window,
  harness,
}) => {
  const fixtures = { electronApp, window, harness };
  await setup(fixtures);
  let toolRef = await tool(electronApp, 'slow');
  // Start asynchronously so the test can press Stop during the native promise.
  await electronApp.evaluate((_e, ref) => {
    const s = globalThis.__PAGE_TOOLS_TEST__;
    s.pending = s.scoped.execute('browser_call_page_tool', {
      tabId: s.tabId,
      toolRef: ref,
      arguments: {},
    });
  }, toolRef);
  await expect.poll(() => script(electronApp, 'window.calls')).toBe(1);
  await execute(electronApp, 'browser_stop_loading');
  expect(await electronApp.evaluate(() => globalThis.__PAGE_TOOLS_TEST__.pending)).toMatchObject({
    result: { status: 'cancelled', mayHaveChanged: true },
  });
  expect(await script(electronApp, 'window.executeOptions')).toBeNull();
  expect(await script(electronApp, "document.querySelector('#receipt').textContent")).toBe(
    'Untouched'
  );
  const cancelled = await execute(electronApp, 'browser_list_page_tools');
  expect(cancelled.result.execution).toMatchObject({
    status: 'cancelled',
    cancellationAcknowledged: true,
  });
  toolRef = await tool(electronApp, 'fail');
  const failed = await execute(electronApp, 'browser_call_page_tool', { toolRef, arguments: {} });
  expect(failed).toMatchObject({ result: { status: 'failed' } });
  expect(JSON.stringify(failed)).not.toContain('Page-controlled exception body');
  expect(await script(electronApp, 'window.calls')).toBe(2);
  toolRef = await tool(electronApp, 'leave');
  expect(
    await execute(electronApp, 'browser_call_page_tool', { toolRef, arguments: {} })
  ).toMatchObject({ result: { status: 'outcome_unknown' } });
});

test('schema validation and replaced registrations fail before invoking website code', async ({
  electronApp,
  window,
  harness,
}) => {
  const fixtures = { electronApp, window, harness };
  await setup(fixtures);
  let toolRef = await tool(electronApp, 'echo');
  expect(
    await execute(electronApp, 'browser_call_page_tool', { toolRef, arguments: { value: 123 } })
  ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  expect(await script(electronApp, 'window.calls')).toBe(0);
  expect(await electronApp.evaluate(() => globalThis.__PAGE_TOOLS_TEST__.approvals.length)).toBe(0);
  await script(
    electronApp,
    `(async () => {
    window.registration = new AbortController();
    await document.modelContext.registerTool({name:'volatile',description:'Same definition',execute:()=>{calls++;return 'old'}}, {signal:registration.signal});
  })()`
  );
  toolRef = await tool(electronApp, 'volatile');
  await script(
    electronApp,
    `(async () => {
    registration.abort();
    await document.modelContext.registerTool({name:'volatile',description:'Same definition',execute:()=>{calls++;return 'new'}});
  })()`
  );
  expect(
    await execute(electronApp, 'browser_call_page_tool', { toolRef, arguments: {} })
  ).toMatchObject({ ok: false, error: { code: 'STALE_ELEMENT_REFERENCE' } });
  expect(await script(electronApp, 'window.calls')).toBe(0);
});

test('SPA navigation preserves the native result but invalidates old tool references', async ({
  electronApp,
  window,
  harness,
}) => {
  await setup({ electronApp, window, harness });
  const toolRef = await tool(electronApp, 'route');
  expect(
    await execute(electronApp, 'browser_call_page_tool', { toolRef, arguments: {} })
  ).toMatchObject({ result: { status: 'completed', output: '{"routed":true}' } });
  expect(
    await execute(electronApp, 'browser_call_page_tool', { toolRef, arguments: {} })
  ).toMatchObject({ ok: false, error: { code: 'STALE_ELEMENT_REFERENCE' } });
  expect(await script(electronApp, 'window.calls')).toBe(1);
});

test('page actions are discoverable from the toolbar and hand off to chat without execution', async ({ electronApp, window, harness }, testInfo) => {
  await setup({ electronApp, window, harness }, 'desktop');
  await window.evaluate(() => document.documentElement.dataset.theme = 'dark');
  const hint = window.locator('#agent-page-actions-hint');
  await expect(hint).toBeVisible({ timeout: 15000 });
  await window.screenshot({ path: testInfo.outputPath('page-actions-hint-dark.png') });
  await hint.locator('[data-page-actions-explore]').click();
  await expect(hint).toBeHidden();
  // Connect a test-only credential without making any inference request.
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'OpenAI', exact: true }).click();
  await window.locator('#agent-provider-api').click();
  await window.locator('#agent-api-key').fill('test-only-not-a-credential');
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await window.locator('#agent-sidebar-back').click();
  const actions = window.locator('#agent-page-actions');
  await expect(actions).toBeVisible();
  await expect(actions.locator('.agent-page-action')).toHaveCount(3);
  await actions.getByRole('button', { name: /^Show all/ }).click();
  await expect(actions.locator('.agent-page-action')).toHaveCount(7);
  await window.screenshot({ path: testInfo.outputPath('page-actions-dark.png') });
  await window.evaluate(() => document.documentElement.dataset.theme = 'light');
  await window.screenshot({ path: testInfo.outputPath('page-actions-light.png') });
  await window.locator('#agent-first-toggle').click();
  await expect(window.locator('body')).toHaveClass(/agent-first-mode/);
  await expect(actions).toBeVisible();
  await window.screenshot({ path: testInfo.outputPath('page-actions-agent-first-light.png') });
  await window.locator('#agent-mode-toggle').click();
  await window.locator('#agent-mode-browser').click();
  await expect(window.locator('body')).not.toHaveClass(/agent-first-mode/);
  // Intercept the run at the IPC seam: this test must not contact a model.
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:start');
    ipcMain.handle('agent:start', (_event, payload) => {
      globalThis.__PAGE_ACTION_HANDOFF__ = payload;
      return { ok: false, error: { message: 'Captured test handoff' } };
    });
  });
  await actions.getByRole('button', { name: 'Echo', exact: true }).click();
  await expect.poll(() => electronApp.evaluate(() => globalThis.__PAGE_ACTION_HANDOFF__?.prompt)).toContain('"echo"');
  const state = await electronApp.evaluate(async () => ({
    calls: await globalThis.__PAGE_TOOLS_TEST__.owner.executeJavaScript('window.calls'),
    handoff: globalThis.__PAGE_ACTION_HANDOFF__,
  }));
  expect(state.calls).toBe(0);
  expect(state.handoff.prompt).toContain('Ask what');
  expect(state.handoff.rendererTabId).toBeGreaterThan(0);
  await window.locator('#agent-sidebar-close').click();
  await expect(hint).toBeHidden();
  await window.locator('#agent-toggle-btn').click();
  await expect(actions).toBeVisible();
  await electronApp.evaluate(async () => globalThis.__PAGE_TOOLS_TEST__.owner.loadURL('https://page-tools.test/next'));
  await expect(actions).toBeHidden({ timeout: 15000 });
});
