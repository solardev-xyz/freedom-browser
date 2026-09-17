'use strict';

const path = require('path');
const { test, expect } = require('./fixtures');

const ROOT_URL = 'https://frame-reader-owner.test/root';
const CHILD_URL = 'https://frame-reader-content.test/child';
const NESTED_URL = 'https://frame-reader-nested.test/content';
const AUTOMATION_PATH = path.resolve(__dirname, '../src/main/automation');

function execute(electronApp, operation, input = {}) {
  return electronApp.evaluate(
    async (_electron, payload) => {
      const state = globalThis.__FRAME_OBSERVATION_TEST__;
      return state.scoped.execute(payload.operation, { tabId: state.tabId, ...payload.input });
    },
    { operation, input }
  );
}

for (const mode of ['desktop', 'hidden']) {
  test(`${mode} frame reads use owned document identities, isolated worlds and actual origin policy`, async ({
    electronApp,
    window,
    harness,
  }) => {
    await expect(window.locator('body')).toBeVisible();
    await harness.setContentFixture(NESTED_URL, {
      body: '<!doctype html><p>Nested receipt NEST-63</p>',
    });
    await harness.setContentFixture(CHILD_URL, {
      body: `<!doctype html><title>Embedded document</title>
      <label for="name">Framed name</label><input id="name"><p>${'x'.repeat(13000)} CHILD-RECEIPT-42</p>
      <script>globalThis.pageMarker = true; Document.prototype.querySelector = () => { throw new Error('Page override') };</script>`,
    });
    await harness.setContentFixture(`${CHILD_URL}?replacement`, {
      body: '<!doctype html><p>Replacement content</p>',
    });
    await harness.setContentFixture(`${CHILD_URL}?container`, {
      body: `<!doctype html><iframe src="${NESTED_URL}"></iframe>`,
    });
    await harness.setContentFixture(ROOT_URL, {
      body: `<!doctype html><h1>Owner page</h1>
      <iframe name="First copy" src="${CHILD_URL}"></iframe>
      <iframe name="Second copy" src="${CHILD_URL}"></iframe>
      <iframe name="Opaque sandbox" sandbox src="${CHILD_URL}"></iframe>
      <iframe name="Nested container" src="${CHILD_URL}?container"></iframe>`,
    });
    if (mode === 'hidden') {
      await electronApp.evaluate(
        (_electron, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
        ROOT_URL
      );
    } else {
      await window.locator('[data-test="address-input"]').fill(ROOT_URL);
      await window.locator('[data-test="address-input"]').press('Enter');
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ webContents }, url) =>
              webContents
                .getAllWebContents()
                .some((entry) => entry.getURL() === url && !entry.isLoading()),
            ROOT_URL
          )
        )
        .toBe(true);
    }
    await electronApp.evaluate(
      async ({ webContents }, payload) => {
        const owner = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL() === payload.url);
        const requireModule = (file) =>
          process.mainModule.require(`${payload.automationPath}/${file}`);
        const { WebContentsPageAdapter } = requireModule('adapters/web-contents-page-adapter');
        const { AutomationController } = requireModule('automation-controller');
        const { createInitialAutomationPolicy } = requireModule('policy-controller');
        const { createOriginScopedAutomationController } = requireModule(
          'origin-scoped-controller'
        );
        const adapter = new WebContentsPageAdapter(owner);
        const controller = new AutomationController({
          policyController: createInitialAutomationPolicy(),
        });
        const tabId = controller.registerPage(adapter);
        const scoped = await createOriginScopedAutomationController({
          controller,
          tabId,
          approvalMode: 'allow_website_interactions',
        });
        globalThis.__FRAME_OBSERVATION_TEST__ = {
          owner,
          adapter,
          controller,
          tabId,
          scoped,
          WebContentsPageAdapter,
        };
      },
      { url: ROOT_URL, automationPath: AUTOMATION_PATH }
    );
    try {
      const ordinary = await execute(electronApp, 'browser_snapshot');
      expect(ordinary.ok).toBe(true);
      expect(ordinary.result.elements.some((element) => element.name === 'Framed name')).toBe(
        false
      );
      const listed = await execute(electronApp, 'browser_list_frames');
      expect(listed.ok, JSON.stringify(listed)).toBe(true);
      const frames = listed.result.frames;
      const copies = frames.filter((frame) => frame.url === CHILD_URL && frame.origin !== 'null');
      expect(copies).toHaveLength(2);
      expect(copies[0].ref).not.toBe(copies[1].ref);
      const child = copies.find((frame) => frame.name === 'First copy');
      expect(child).toBeTruthy();
      const opaque = frames.find((frame) => frame.name === 'Opaque sandbox');
      expect(opaque.origin).toBe('null');
      expect(
        await execute(electronApp, 'browser_read_frame', { frameRef: opaque.ref })
      ).toMatchObject({ ok: false, error: { code: 'POLICY_DENIED' } });
      const read = await execute(electronApp, 'browser_read_frame', { frameRef: child.ref });
      expect(read.ok, JSON.stringify(read)).toBe(true);
      expect(read.result).toMatchObject({
        readOnly: true,
        title: 'Embedded document',
        frame: { origin: 'https://frame-reader-content.test' },
        textTruncated: true,
      });
      expect(
        read.result.elements.find((element) => element.name === 'Framed name')
      ).not.toHaveProperty('ref');
      expect(read.result.frames.every((frame) => !frame.viewport?.ref)).toBe(true);
      const found = await execute(electronApp, 'browser_read_frame', {
        frameRef: child.ref,
        textQuery: 'CHILD-RECEIPT-42',
      });
      expect(found.result.text).toContain('CHILD-RECEIPT-42');
      const nested = frames.find((frame) => frame.url === NESTED_URL);
      expect(nested).toBeTruthy();
      expect(
        (await execute(electronApp, 'browser_read_frame', { frameRef: nested.ref })).result.text
      ).toContain('NEST-63');
      await electronApp.evaluate(
        (_electron, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
        CHILD_URL
      );
      const guards = await electronApp.evaluate(async ({ webContents }, childUrl) => {
        const { owner, adapter, controller, tabId, WebContentsPageAdapter } =
          globalThis.__FRAME_OBSERVATION_TEST__;
        const refs = await adapter.listFrames();
        const ref = refs.frames.find((frame) => frame.name === 'First copy').ref;
        const raw = await controller.execute('browser_read_frame', { tabId, frameRef: ref });
        const foreignOwner = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL() === childUrl);
        const otherAdapter = new WebContentsPageAdapter(foreignOwner);
        const foreignTabId = controller.registerPage(otherAdapter);
        const foreignScope = await globalThis.__FRAME_OBSERVATION_TEST__.scoped.execute(
          'browser_list_frames',
          { tabId: foreignTabId }
        );
        let foreignRejected = false;
        try {
          await otherAdapter.readFrame(ref, {}, () => true);
        } catch {
          foreignRejected = true;
        } finally {
          otherAdapter.dispose();
        }
        owner.debugger.attach('1.3');
        let busyRejected = false;
        try {
          await adapter.listFrames();
        } catch {
          busyRejected = true;
        }
        const retainedDebugger = owner.debugger.isAttached();
        owner.debugger.detach();
        return { raw, foreignRejected, busyRejected, retainedDebugger, foreignScope };
      }, CHILD_URL);
      expect(guards).toMatchObject({
        raw: { ok: false, error: { code: 'POLICY_DENIED' } },
        foreignScope: { ok: false, error: { code: 'POLICY_DENIED' } },
        foreignRejected: true,
        busyRejected: true,
        retainedDebugger: true,
      });
      await electronApp.evaluate(async (_electron, url) => {
        const { owner } = globalThis.__FRAME_OBSERVATION_TEST__;
        await owner.mainFrame.executeJavaScript(
          `document.querySelector('iframe').src = ${JSON.stringify(url)}`
        );
      }, `${CHILD_URL}?replacement`);
      await expect
        .poll(async () => {
          const result = await execute(electronApp, 'browser_list_frames');
          return result.result?.frames.some((frame) => frame.url === `${CHILD_URL}?replacement`);
        })
        .toBe(true);
      expect(
        await execute(electronApp, 'browser_read_frame', { frameRef: child.ref })
      ).toMatchObject({ ok: false, error: { code: 'STALE_ELEMENT_REFERENCE' } });
      const remaining = (await execute(electronApp, 'browser_list_frames')).result.frames.find(
        (frame) => frame.name === 'Second copy'
      );
      await electronApp.evaluate(async () => {
        await globalThis.__FRAME_OBSERVATION_TEST__.owner.mainFrame.executeJavaScript(
          'document.querySelector(\'iframe[name="Second copy"]\').remove()'
        );
      });
      expect(
        await execute(electronApp, 'browser_read_frame', { frameRef: remaining.ref })
      ).toMatchObject({ ok: false });
      expect(
        await electronApp.evaluate(() =>
          globalThis.__FRAME_OBSERVATION_TEST__.owner.debugger.isAttached()
        )
      ).toBe(false);
    } finally {
      await electronApp.evaluate(() => globalThis.__FRAME_OBSERVATION_TEST__.adapter.dispose());
    }
  });
}
