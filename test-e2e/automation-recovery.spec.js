'use strict';

const path = require('path');
const { test, expect } = require('./fixtures');

const FIXTURE_URL = 'https://browser-recovery.test/unchanged';
const MAIN_PATH = path.resolve(__dirname, '../src/main');

test('repeated real clicks produce a recovery hint while retaining every approval and side effect', async ({
  electronApp,
  window,
  harness,
}) => {
  await expect(window.locator('body')).toBeVisible();
  await harness.setContentFixture(FIXTURE_URL, {
    body: `<!doctype html><title>Stable page</title>
    <p>Visible content stays unchanged after this button is clicked.</p>
    <button onclick="globalThis.receivedClicks.push(event.isTrusted)">Continue</button>
    <script>globalThis.receivedClicks = [];</script>`,
  });
  await electronApp.evaluate(
    (_electron, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
    FIXTURE_URL
  );
  const result = await electronApp.evaluate(
    async ({ webContents }, payload) => {
      const owner = webContents.getAllWebContents().find((entry) => entry.getURL() === payload.url);
      const requireModule = (file) => process.mainModule.require(`${payload.mainPath}/${file}`);
      const { WebContentsPageAdapter } = requireModule(
        'automation/adapters/web-contents-page-adapter'
      );
      const { AutomationController } = requireModule('automation/automation-controller');
      const { createInitialAutomationPolicy } = requireModule('automation/policy-controller');
      const { createOriginScopedAutomationController } = requireModule(
        'automation/origin-scoped-controller'
      );
      const { createFreedomBrowserTools } = requireModule('agent/pi-browser-tools');
      const adapter = new WebContentsPageAdapter(owner);
      let approvals = 0;
      const controller = new AutomationController({
        policyController: createInitialAutomationPolicy(),
      });
      const tabId = controller.registerPage(adapter);
      const scoped = await createOriginScopedAutomationController({
        controller,
        tabId,
        approvalMode: 'every_interaction',
        requestApproval: async () => {
          approvals += 1;
          return 'approved';
        },
      });
      const tools = await createFreedomBrowserTools({ controller: scoped, tabId });
      const read = tools.find((tool) => tool.name === 'browser_snapshot');
      const click = tools.find((tool) => tool.name === 'browser_click');
      const stop = tools.find((tool) => tool.name === 'browser_stop_loading');
      const hints = [];
      let clicks = [];
      try {
        for (let index = 1; index <= 5; index += 1) {
          const observation = await read.execute(`read_${index}`, {});
          hints.push(
            observation.content
              .filter(
                (entry) =>
                  entry.type === 'text' && entry.text.startsWith('Freedom browser recovery:')
              )
              .map((entry) => entry.text)
          );
          const ref = observation.details.envelope.result.elements.find(
            (element) => element.name === 'Continue'
          ).ref;
          await click.execute(`click_${index}`, { ref });
          // Native input is queued independently of JS; wait for the actual receipt.
          const deadline = Date.now() + 1000;
          do {
            clicks = await owner.executeJavaScript('globalThis.receivedClicks.slice()');
            if (clicks.length >= index) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          } while (Date.now() < deadline);
          if (clicks.length !== index) throw new Error('Unexpected native click count');
        }
        await stop.execute('stop', {});
        const afterStop = await read.execute('new_observation', {});
        // Drop live tool results; recall remains independent of the prompt context.
        const recall = tools.find((tool) => tool.name === 'browser_recall_evidence');
        await owner.executeJavaScript(
          "document.querySelector('p').textContent='Replacement content'"
        );
        const index = JSON.parse(
          (await recall.execute('find_old', { query: 'Visible content stays unchanged' }))
            .content[0].text
        );
        const historical = JSON.parse(
          (await recall.execute('read_old', { id: index.entries[0].id })).content[0].text
        );
        const freshTools = await createFreedomBrowserTools({ controller: scoped, tabId });
        const isolated = JSON.parse(
          (
            await freshTools
              .find((tool) => tool.name === 'browser_recall_evidence')
              .execute('foreign', { id: index.entries[0].id })
          ).content[0].text
        );
        return {
          approvals,
          clicks,
          hints,
          afterStopContentCount: afterStop.content.length,
          historical,
          isolated,
        };
      } finally {
        adapter.dispose();
      }
    },
    { url: FIXTURE_URL, mainPath: MAIN_PATH }
  );
  expect(result.historical.text).toContain('Visible content stays unchanged');
  expect(result.historical.text).not.toContain('ref_');
  expect(result.historical.live).toBe(false);
  expect(result.isolated.found).toBe(false);
  expect(result.approvals).toBe(5);
  expect(result.clicks).toEqual([true, true, true, true, true]);
  // The first click changes focus; the next four observations match.
  expect(result.hints.slice(0, 4)).toEqual([[], [], [], []]);
  expect(result.hints[4][0]).toContain('same returned browser observation has appeared 4 times');
  expect(result.hints[4][0]).toContain(
    'does not establish whether an interaction had side effects'
  );
  expect(result.afterStopContentCount).toBe(2);
});
