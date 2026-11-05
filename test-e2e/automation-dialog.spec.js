'use strict';
const path = require('path');
const { test, expect } = require('./fixtures');
const URL = 'https://dialog-recovery.test/modal';
const MAIN = path.resolve(__dirname, '../src/main/automation');

test('modal dialog observations identify context and preserve approval and background blocking', async ({
  electronApp,
  window,
  harness,
}) => {
  await expect(window.locator('body')).toBeVisible();
  await harness.setContentFixture(URL, {
    body: `<!doctype html><button onclick="globalThis.background++">Background action</button>
    <button onclick="document.querySelector('dialog').showModal()">Open confirmation</button>
    <dialog aria-label="Confirm change"><p>This action needs your decision.</p><button onclick="document.querySelector('dialog').close()">Cancel</button></dialog>
    <script>globalThis.background=0</script>`,
  });
  await electronApp.evaluate(
    (_e, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
    URL
  );
  const result = await electronApp.evaluate(
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
      let approvals = 0;
      const scoped = await createOriginScopedAutomationController({
        controller,
        tabId,
        approvalMode: 'every_interaction',
        requestApproval: async () => {
          approvals++;
          return 'approved';
        },
      });
      const execute = (operation, input = {}) => scoped.execute(operation, { tabId, ...input });
      const initial = await execute('browser_snapshot');
      await execute('browser_click', {
        ref: initial.result.elements.find((e) => e.name === 'Open confirmation').ref,
      });
      const deadline = Date.now() + 1000;
      while (!(await owner.executeJavaScript("document.querySelector('dialog').open"))) {
        if (Date.now() > deadline) throw new Error('Dialog did not open');
        await new Promise((r) => setTimeout(r, 10));
      }
      const modal = await execute('browser_snapshot');
      const blocked = await execute('browser_click', {
        ref: initial.result.elements.find((e) => e.name === 'Background action').ref,
      });
      const cancelled = await execute('browser_click', {
        ref: modal.result.elements.find((e) => e.name === 'Cancel').ref,
      });
      await new Promise((r) => setTimeout(r, 50));
      const after = await execute('browser_snapshot');
      const background = await owner.executeJavaScript('globalThis.background');
      adapter.dispose();
      return { initial, modal, blocked, cancelled, after, background, approvals };
    },
    { main: MAIN, url: URL }
  );
  expect(result.initial.result.dialogs).toEqual([]);
  expect(result.modal.result.dialogs).toEqual([
    { frameId: 'frame_main', role: 'dialog', name: 'Confirm change', modal: true },
  ]);
  expect(result.modal.result.elements.find((e) => e.name === 'Cancel').inDialog).toBe(true);
  expect(result.blocked.ok).toBe(false);
  expect(result.cancelled.ok).toBe(true);
  expect(result.after.result.dialogs).toEqual([]);
  expect(result.background).toBe(0);
  expect(result.approvals).toBe(3);
});
