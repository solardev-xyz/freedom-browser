'use strict';

const path = require('path');
const { test, expect } = require('./fixtures');
const MAIN = path.resolve(__dirname, '../src/main');
const ROOT = 'https://frame-action-owner.test/root';
const CHILD = 'https://frame-action-content.test/form';
const NESTED = 'https://frame-action-nested.test/inner';

async function setup({ electronApp, window, harness }, zoom = 1, mode = 'hidden') {
  await expect(window.locator('body')).toBeVisible();
  await harness.setContentFixture(NESTED, {
    body: '<!doctype html><button onclick="globalThis.clicked=event.isTrusted">Nested button</button>',
  });
  await harness.setContentFixture(`${CHILD}?replacement`, {
    body: '<!doctype html><button>Replacement</button>',
  });
  await harness.setContentFixture(CHILD, {
    body: `<!doctype html><title>Embedded form</title>
    <form action="https://frame-action-content.test/submit" onsubmit="event.preventDefault(); globalThis.submits.push(event.isTrusted)">
    <label for="message">Message</label><input id="message" name="message" onfocus="if(globalThis.redirectFocus) queueMicrotask(()=>document.querySelector('#decoy').focus())">
    <label for="decoy">Decoy</label><input id="decoy"><button>Send form</button></form>
    <iframe src="${NESTED}" style="width:280px;height:100px;border:4px solid"></iframe>
    <div style="height:1800px">Long child document</div>
    <script>globalThis.submits=[];globalThis.clicks=[];document.addEventListener('click',event=>globalThis.clicks.push([event.target.tagName,event.clientX,event.clientY,event.isTrusted])); globalThis.inputs=[]; document.addEventListener('input',event=>globalThis.inputs.push(event.isTrusted)); globalThis.keys=[]; document.addEventListener('keydown', event=>globalThis.keys.push([event.key,event.isTrusted]));</script>`,
  });
  await harness.setContentFixture(ROOT, {
    body: `<!doctype html><title>Owner</title><input id="outside" aria-label="Outside">
    <iframe name="Target" src="${CHILD}" style="display:block;width:450px;height:350px;margin:20px 0 0 35px;border:7px solid"></iframe>`,
  });
  if (mode === 'hidden') {
    await electronApp.evaluate(
      (_electron, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
      ROOT
    );
  } else {
    await window.locator('[data-test="address-input"]').fill(ROOT);
    await window.locator('[data-test="address-input"]').press('Enter');
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ webContents }, url) =>
            webContents
              .getAllWebContents()
              .some((entry) => entry.getURL() === url && !entry.isLoading()),
          ROOT
        )
      )
      .toBe(true);
  }
  await electronApp.evaluate(
    async ({ webContents }, args) => {
      const requireModule = (file) => process.mainModule.require(`${args.main}/${file}`);
      const { WebContentsPageAdapter } = requireModule(
        'automation/adapters/web-contents-page-adapter'
      );
      const { AutomationController } = requireModule('automation/automation-controller');
      const { createInitialAutomationPolicy } = requireModule('automation/policy-controller');
      const { createOriginScopedAutomationController } = requireModule(
        'automation/origin-scoped-controller'
      );
      const owner = webContents.getAllWebContents().find((entry) => entry.getURL() === args.root);
      owner.setZoomFactor(args.zoom);
      const adapter = new WebContentsPageAdapter(owner);
      const controller = new AutomationController({
        policyController: createInitialAutomationPolicy(),
      });
      const tabId = controller.registerPage(adapter);
      const state = { owner, adapter, controller, tabId, approvals: [], mutation: null };
      state.scoped = await createOriginScopedAutomationController({
        controller,
        tabId,
        approvalMode: 'every_interaction',
        requestApproval: async (request) => {
          state.approvals.push(request);
          if (state.mutation === 'overlay')
            await owner.executeJavaScript(
              "const cover=document.createElement('div');cover.id='cover';cover.style='position:fixed;inset:0;z-index:9999';document.body.append(cover)"
            );
          if (state.mutation === 'payload') {
            const child = owner.mainFrame.framesInSubtree.find((frame) => frame.url === args.child);
            await child.executeJavaScript(
              "document.querySelector('#message').value='changed during approval'"
            );
          }
          if (state.mutation === 'navigate') {
            await owner.executeJavaScript(
              `document.querySelector('iframe').src=${JSON.stringify(args.child + '?replacement')}`
            );
            const deadline = Date.now() + 2000;
            while (
              !owner.mainFrame.framesInSubtree.some(
                (frame) => frame.url === args.child + '?replacement'
              )
            ) {
              if (Date.now() > deadline) throw new Error('Fixture navigation deadline');
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return state.mutation === 'decline' ? 'declined' : 'approved';
        },
      });
      globalThis.__FRAME_ACTION_TEST__ = state;
    },
    { main: MAIN, root: ROOT, child: CHILD, zoom }
  );
}

function execute(electronApp, operation, input = {}) {
  return electronApp.evaluate(
    (_electron, payload) => {
      const state = globalThis.__FRAME_ACTION_TEST__;
      return state.scoped.execute(payload.operation, { tabId: state.tabId, ...payload.input });
    },
    { operation, input }
  );
}

async function readChild(electronApp, url = CHILD) {
  const listed = await execute(electronApp, 'browser_list_frames');
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  const frameRef = listed.result.frames.find((frame) => frame.url === url).ref;
  const read = await execute(electronApp, 'browser_read_frame', { frameRef });
  expect(read.ok, JSON.stringify(read)).toBe(true);
  return read.result;
}

function fixtureState(electronApp) {
  return electronApp.evaluate(async (_electron, url) => {
    const { owner, approvals } = globalThis.__FRAME_ACTION_TEST__;
    const child = owner.mainFrame.framesInSubtree.find((frame) => frame.url === url);
    return {
      approvals,
      attached: owner.debugger.isAttached(),
      outside: await owner.executeJavaScript("document.querySelector('#outside').value"),
      child: child
        ? await child.executeJavaScript(
            "({value:document.querySelector('#message').value,decoy:document.querySelector('#decoy').value,submits:globalThis.submits,clicks:globalThis.clicks,inputs:globalThis.inputs,keys:globalThis.keys,y:scrollY})"
          )
        : null,
    };
  }, CHILD);
}

for (const [mode, zoom] of [
  ['hidden', 1],
  ['hidden', 1.5],
  ['desktop', 1.5],
]) {
  test(`${mode} cross-origin native typing, keys, clicks, nested controls and scrolling at zoom ${zoom}`, async ({
    electronApp,
    window,
    harness,
  }) => {
    const context = { electronApp, window, harness };
    await setup(context, zoom, mode);
    const page = await readChild(electronApp);
    expect(page.readOnly).toBe(false);
    const message = page.elements.find((element) => element.name === 'Message').ref;
    const typed = await execute(electronApp, 'browser_type', {
      ref: message,
      text: 'Frame message',
    });
    expect(typed.ok, JSON.stringify(typed)).toBe(true);
    expect((await fixtureState(electronApp)).child.value).toBe('Frame message');
    const pressed = await execute(electronApp, 'browser_press', { ref: message, key: 'ArrowLeft' });
    expect(pressed.ok, JSON.stringify(pressed)).toBe(true);
    const send = page.elements.find((element) => element.name === 'Send form').ref;
    const clicked = await execute(electronApp, 'browser_click', { ref: send });
    expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
    await expect.poll(async () => (await fixtureState(electronApp)).child.submits.length).toBe(1);
    const nested = await readChild(electronApp, NESTED);
    const nestedClicked = await execute(electronApp, 'browser_click', {
      ref: nested.elements.find((element) => element.name === 'Nested button').ref,
    });
    expect(nestedClicked.ok, JSON.stringify(nestedClicked)).toBe(true);
    await expect
      .poll(() =>
        electronApp.evaluate(async (_electron, url) => {
          const frame = globalThis.__FRAME_ACTION_TEST__.owner.mainFrame.framesInSubtree.find(
            (entry) => entry.url === url
          );
          return frame.executeJavaScript('globalThis.clicked');
        }, NESTED)
      )
      .toBe(true);
    const current = await readChild(electronApp);
    const scrolled = await execute(electronApp, 'browser_scroll', {
      ref: current.frames[0].viewport.ref,
      direction: 'down',
      pages: 0.5,
    });
    expect(scrolled.ok, JSON.stringify(scrolled)).toBe(true);
    expect(scrolled.result.moved).toBe(true);
    const state = await fixtureState(electronApp);
    expect(state.child.y).toBeGreaterThan(0);
    expect(state.child.submits).toEqual([true]);
    expect(state.child.inputs).toEqual([true]);
    expect(state.child.keys).toContainEqual(['ArrowLeft', true]);
    expect(state.outside).toBe('');
    expect(state.attached).toBe(true);
    expect(state.approvals).toHaveLength(5);
    expect(
      state.approvals.every(
        (request) =>
          request.origin.startsWith('https://frame-action-') &&
          request.origin !== 'https://frame-action-owner.test'
      )
    ).toBe(true);
  });
}

for (const mutation of ['overlay', 'payload', 'navigate', 'decline']) {
  test(`frame action rejects ${mutation} during approval without submitting`, async ({
    electronApp,
    window,
    harness,
  }) => {
    const context = { electronApp, window, harness };
    await setup(context);
    const page = await readChild(context.electronApp);
    const ref = page.elements.find((element) => element.name === 'Send form').ref;
    await context.electronApp.evaluate((_electron, mutation) => {
      globalThis.__FRAME_ACTION_TEST__.mutation = mutation;
    }, mutation);
    const result = await execute(context.electronApp, 'browser_click', { ref });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect([
      'ELEMENT_NOT_INTERACTABLE',
      'STALE_ELEMENT_REFERENCE',
      'USER_CANCELLED',
      'CAPABILITY_UNAVAILABLE',
    ]).toContain(result.error.code);
    const state = await fixtureState(context.electronApp);
    if (state.child) expect(state.child.submits).toEqual([]);
    expect(state.attached).toBe(true);
  });
}

test('frame typing rejects redirected focus and transformed ancestor frames', async ({
  electronApp,
  window,
  harness,
}) => {
  const context = { electronApp, window, harness };
  await setup(context);
  const page = await readChild(electronApp);
  const ref = page.elements.find((element) => element.name === 'Message').ref;
  await electronApp.evaluate(async (_electron, url) => {
    const child = globalThis.__FRAME_ACTION_TEST__.owner.mainFrame.framesInSubtree.find(
      (frame) => frame.url === url
    );
    await child.executeJavaScript('globalThis.redirectFocus=true');
  }, CHILD);
  expect(await execute(electronApp, 'browser_type', { ref, text: 'Must not type' })).toMatchObject({
    ok: false,
  });
  let state = await fixtureState(electronApp);
  expect(state.child.value).toBe('');
  expect(state.child.decoy).toBe('');
  await electronApp.evaluate(async () => {
    await globalThis.__FRAME_ACTION_TEST__.owner.executeJavaScript(
      "document.querySelector('iframe').style.transform='rotate(2deg)'"
    );
  });
  expect(
    await execute(electronApp, 'browser_click', {
      ref: page.elements.find((element) => element.name === 'Send form').ref,
    })
  ).toMatchObject({ ok: false });
  state = await fixtureState(electronApp);
  expect(state.child.submits).toEqual([]);
});

test('frame references cannot bypass authorization or become file and scroll-only controls', async ({
  electronApp,
  window,
  harness,
}) => {
  await setup({ electronApp, window, harness });
  const page = await readChild(electronApp);
  const message = page.elements.find((element) => element.name === 'Message').ref;
  const raw = await electronApp.evaluate((_electron, ref) => {
    const { controller, tabId } = globalThis.__FRAME_ACTION_TEST__;
    return controller.execute('browser_type', { tabId, ref, text: 'unauthorized' });
  }, message);
  expect(raw).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
  const viewport = page.frames[0].viewport.ref;
  expect(await execute(electronApp, 'browser_click', { ref: viewport })).toMatchObject({
    ok: false,
  });
  expect(
    await execute(electronApp, 'browser_type', { ref: 'frame_element_foreign', text: 'wrong page' })
  ).toMatchObject({ ok: false });
  await electronApp.evaluate(async (_electron, url) => {
    const child = globalThis.__FRAME_ACTION_TEST__.owner.mainFrame.framesInSubtree.find(
      (frame) => frame.url === url
    );
    await child.executeJavaScript("document.querySelector('#message').type='file'");
  }, CHILD);
  expect(await execute(electronApp, 'browser_click', { ref: message })).toMatchObject({
    ok: false,
    error: { code: 'CAPABILITY_UNAVAILABLE' },
  });
  const state = await fixtureState(electronApp);
  expect(state.approvals).toHaveLength(0);
  expect(state.child.inputs).toEqual([]);
});


test('cross-origin multiple selections retain approval and reject changed choices', async ({ electronApp, window, harness }) => {
  await setup({ electronApp, window, harness });
  await electronApp.evaluate(async (_e, url) => {
    const state = globalThis.__FRAME_ACTION_TEST__;
    const child = state.owner.mainFrame.framesInSubtree.find((f) => f.url === url);
    await child.executeJavaScript(`document.body.innerHTML='<label>Choices<select multiple size="3"><option value="a">A</option><option value="b">B</option><option disabled value="c">C</option></select></label>';globalThis.events=[];document.querySelector('select').addEventListener('change',e=>events.push(e.isTrusted));`);
  }, CHILD);
  const read = await readChild(electronApp);
  const ref = read.elements.find((e) => e.name === 'Choices').ref;
  expect(read.supportedActions).toContain('select');
  const selected = await execute(electronApp, 'browser_select', { ref, values: ['a', 'b'] });
  expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true, result: { selected: true, trusted: false } });
  await electronApp.evaluate((_e, url) => {
    const state = globalThis.__FRAME_ACTION_TEST__;
    state.scoped.requestApproval = async () => {
      const child = state.owner.mainFrame.framesInSubtree.find((f) => f.url === url);
      await child.executeJavaScript("document.querySelector('option').textContent='Changed during approval'");
      return 'approved';
    };
  }, CHILD);
  expect((await execute(electronApp, 'browser_select', { ref, values: ['b'] })).error.code).toBe('STALE_ELEMENT_REFERENCE');
  const after = await readChild(electronApp);
  expect(after.elements.find((e) => e.name === 'Choices').options.filter((o) => o.selected).map((o) => o.value)).toEqual(['a', 'b']);
  const events = await electronApp.evaluate((_e, url) => globalThis.__FRAME_ACTION_TEST__.owner.mainFrame.framesInSubtree.find((f) => f.url === url).executeJavaScript('globalThis.events'), CHILD);
  expect(events).toEqual([false]);
});
