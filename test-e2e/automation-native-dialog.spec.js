'use strict';
const path = require('path');
const { test, expect } = require('./fixtures');
const MAIN = path.resolve(__dirname, '../src/main/automation');
const URL = 'https://native-dialog.test/';

async function setup({ electronApp, window, harness }, mode = 'hidden') {
  await expect(window.locator('body')).toBeVisible();
  // Playwright otherwise auto-dismisses guest dialogs before the product can inspect them.
  electronApp.context().on('dialog', () => {});
  await harness.setContentFixture(`${URL}next`, { body: '<h1>Next page</h1>' });
  await harness.setContentFixture(URL, {
    body: `<!doctype html>
    <button onclick="alert('Notice');globalThis.receipt='acknowledged'">Alert</button>
    <button onclick="globalThis.receipt=confirm('Apply change?')">Confirm</button>
    <button onclick="globalThis.receipt=prompt('Name?', 'default')">Prompt</button>
    <button onclick="window.onbeforeunload=e=>{e.preventDefault();e.returnValue='leave'};globalThis.receipt='armed'">Arm leave</button>
    <label>Attachment<input type="file"></label><iframe src="${URL}next"></iframe><script>globalThis.receipt='untouched'</script>`,
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
      const adapter = new WebContentsPageAdapter(owner);
      const controller = new AutomationController({
        policyController: createInitialAutomationPolicy(),
      });
      const tabId = controller.registerPage(adapter);
      const state = {
        owner,
        adapter,
        controller,
        tabId,
        approvals: [],
        decision: 'approved',
        events: [],
      };
      owner.debugger.on('message', (_e, method, params) => {
        if (method.startsWith('Page.javascript') || method === 'Page.frameNavigated')
          state.events.push({ method, params });
      });
      state.scoped = await createOriginScopedAutomationController({
        controller,
        tabId,
        approvalMode: 'allow_website_interactions',
        requestApproval: async (request) => {
          state.approvals.push(request);
          if (state.decision === 'stop') {
            await adapter.stopLoading();
            return 'approved';
          }
          return state.decision;
        },
      });
      globalThis.__NATIVE_DIALOG_TEST__ = state;
    },
    { main: MAIN, url: URL }
  );
}
function execute(app, operation, input = {}, raw = false) {
  return app.evaluate(
    (_e, args) => {
      const s = globalThis.__NATIVE_DIALOG_TEST__;
      return (args.raw ? s.controller : s.scoped).execute(args.operation, {
        tabId: s.tabId,
        ...args.input,
      });
    },
    { operation, input, raw }
  );
}
async function openDialog(app, name) {
  const snapshot = await execute(app, 'browser_snapshot');
  // Task interactions must arm observation even when the model did not predict a dialog.
  const clicked = await execute(app, 'browser_click', {
    ref: snapshot.result.elements.find((e) => e.name === name).ref,
  });
  expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
  let result;
  await expect
    .poll(async () => {
      result = await execute(app, 'browser_get_dialog');
      return Boolean(result.result?.dialog);
    })
    .toBe(true);
  return result.result.dialog;
}

test.afterEach(async ({ electronApp }) => {
  await electronApp.evaluate(() => globalThis.__NATIVE_DIALOG_TEST__?.adapter.dispose());
});

for (const [name, accept, text, expected] of [
  ['Alert', true, undefined, 'acknowledged'],
  ['Confirm', false, undefined, false],
  ['Confirm', true, undefined, true],
]) {
  test(`native ${name} ${accept ? 'accept' : 'dismiss'} requires approval and returns control`, async ({
    electronApp,
    window,
    harness,
  }) => {
    await setup({ electronApp, window, harness });
    const app = electronApp;
    const dialog = await openDialog(app, name);
    const blocked = await execute(app, 'browser_snapshot');
    expect(blocked.ok).toBe(false);
    const input = {
      dialogRef: dialog.dialogRef,
      accept,
      ...(text !== undefined && { promptText: text }),
    };
    const raw = await execute(app, 'browser_handle_dialog', input, true);
    expect(raw.error.code).toBe('POLICY_DENIED');
    const handled = await execute(app, 'browser_handle_dialog', input);
    expect(handled.ok, JSON.stringify(handled)).toBe(true);
    await expect
      .poll(() =>
        app.evaluate(() =>
          globalThis.__NATIVE_DIALOG_TEST__.owner.executeJavaScript('globalThis.receipt')
        )
      )
      .toBe(expected);
    const state = await app.evaluate(() => ({
      approvals: globalThis.__NATIVE_DIALOG_TEST__.approvals,
    }));
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0].label).toContain(accept ? 'Accept' : 'Dismiss');
    expect((await execute(app, 'browser_handle_dialog', input)).error.code).toBe(
      'STALE_ELEMENT_REFERENCE'
    );
    expect((await execute(app, 'browser_snapshot')).ok).toBe(true);
  });
}

test('declined response leaves the native dialog open and Stop invalidates the approved handle', async ({
  electronApp,
  window,
  harness,
}) => {
  await setup({ electronApp, window, harness });
  const app = electronApp;
  const dialog = await openDialog(app, 'Confirm');
  await app.evaluate(() => {
    globalThis.__NATIVE_DIALOG_TEST__.decision = 'declined';
  });
  const input = { dialogRef: dialog.dialogRef, accept: true };
  expect((await execute(app, 'browser_handle_dialog', input)).error.code).toBe('USER_CANCELLED');
  expect((await execute(app, 'browser_get_dialog')).result.dialog.dialogRef).toBe(dialog.dialogRef);
  await app.evaluate(() => {
    globalThis.__NATIVE_DIALOG_TEST__.decision = 'stop';
  });
  const stop = await execute(app, 'browser_handle_dialog', { ...input, accept: false });
  expect(stop.error.code).toBe('STALE_ELEMENT_REFERENCE');
  const stillOpen = (await execute(app, 'browser_get_dialog')).result.dialog;
  expect(stillOpen.dialogRef).not.toBe(dialog.dialogRef);
  await app.evaluate(() => {
    globalThis.__NATIVE_DIALOG_TEST__.decision = 'approved';
  });
  expect(
    (await execute(app, 'browser_handle_dialog', { dialogRef: stillOpen.dialogRef, accept: false }))
      .ok
  ).toBe(true);
  expect(
    await app.evaluate(() =>
      globalThis.__NATIVE_DIALOG_TEST__.owner.executeJavaScript('globalThis.receipt')
    )
  ).toBe(false);
});

for (const accept of [false, true])
  test(`beforeunload ${accept ? 'leave' : 'stay'} and frame reads coexist with monitoring`, async ({
    electronApp,
    window,
    harness,
  }) => {
    await setup({ electronApp, window, harness });
    const app = electronApp;
    const snapshot = await execute(app, 'browser_snapshot');
    expect((await execute(app, 'browser_get_dialog')).ok).toBe(true);
    // Repeat to verify a reused debugger connection receives fresh contexts.
    for (let i = 0; i < 2; i++) {
      const frames = await execute(app, 'browser_list_frames');
      expect(frames.ok, JSON.stringify(frames)).toBe(true);
      const child = frames.result.frames.find((f) => f.url === `${URL}next`);
      expect((await execute(app, 'browser_read_frame', { frameRef: child.ref })).ok).toBe(true);
    }
    await execute(app, 'browser_click', {
      ref: snapshot.result.elements.find((e) => e.name === 'Arm leave').ref,
    });
    const nav = await execute(app, 'browser_navigate', { url: `${URL}next` });
    expect(nav.ok).toBe(false);
    const dialog = (await execute(app, 'browser_get_dialog')).result.dialog;
    expect(
      dialog,
      JSON.stringify({
        nav,
        events: await app.evaluate(() => globalThis.__NATIVE_DIALOG_TEST__.events),
      })
    ).toBeTruthy();
    expect(dialog.type).toBe('beforeunload');
    const handled = await execute(app, 'browser_handle_dialog', {
      dialogRef: dialog.dialogRef,
      accept,
    });
    expect(handled.ok, JSON.stringify(handled)).toBe(true);
    expect(await app.evaluate(() => globalThis.__NATIVE_DIALOG_TEST__.owner.getURL())).toBe(
      accept ? `${URL}next` : URL
    );
    expect((await execute(app, 'browser_snapshot')).ok).toBe(true);
  });

test('Electron page prompt is reported as unsupported, without a synthetic replacement', async ({
  electronApp,
  window,
  harness,
}) => {
  await setup({ electronApp, window, harness });
  const result = await electronApp.evaluate(async () => {
    const s = globalThis.__NATIVE_DIALOG_TEST__;
    const monitored = await s.scoped.execute('browser_get_dialog', { tabId: s.tabId });
    const message = await s.owner.executeJavaScript(
      "(()=>{try {prompt('Name?');return 'unexpected'}catch(e){return e.message}})()"
    );
    return { monitored, message, pending: s.adapter.nativeDialogs.current() };
  });
  expect(result.message).toContain('prompt() is not supported');
  expect(result.pending).toBe(null);
  expect(result.monitored.result.pagePromptSupported).toBe(false);
});

test('native monitoring coexists with file attachment and refuses an external debugger', async ({
  electronApp,
  window,
  harness,
}) => {
  await setup({ electronApp, window, harness });
  const result = await electronApp.evaluate(
    async (_e, file) => {
      const s = globalThis.__NATIVE_DIALOG_TEST__;
      const snapshot = await s.adapter.snapshot();
      await s.adapter.getDialog();
      const ref = snapshot.elements.find((e) => e.name === 'Attachment').ref;
      const attached = await s.adapter.upload(ref, file);
      const monitoring = s.adapter.nativeDialogs.ownsConnection();
      await s.adapter.stopLoading();
      const released = !s.owner.debugger.isAttached();
      s.owner.debugger.attach('1.3');
      let refused = false;
      try {
        await s.adapter.getDialog();
      } catch (e) {
        refused = e.code === 'CAPABILITY_UNAVAILABLE';
      }
      const externalRetained = s.owner.debugger.isAttached();
      s.owner.debugger.detach();
      return { attached, monitoring, released, refused, externalRetained };
    },
    path.resolve(__dirname, '../assets/icon.png')
  );
  expect(result.attached).toMatchObject({ attached: true, filename: 'icon.png', fileCount: 1 });
  expect(result).toMatchObject({
    monitoring: true,
    released: true,
    refused: true,
    externalRetained: true,
  });
});

test('desktop task click arms native observation automatically', async ({
  electronApp,
  window,
  harness,
}) => {
  await setup({ electronApp, window, harness }, 'desktop');
  const dialog = await openDialog(electronApp, 'Confirm');
  const result = await execute(electronApp, 'browser_handle_dialog', {
    dialogRef: dialog.dialogRef,
    accept: false,
  });
  expect(result).toMatchObject({ ok: true, result: { handled: true, accepted: false } });
  expect(
    await electronApp.evaluate(() =>
      globalThis.__NATIVE_DIALOG_TEST__.owner.executeJavaScript('globalThis.receipt')
    )
  ).toBe(false);
});
