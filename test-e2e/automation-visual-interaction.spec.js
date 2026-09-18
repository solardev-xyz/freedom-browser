'use strict';
const path = require('path');
const { test, expect } = require('./fixtures');
const MAIN = path.resolve(__dirname, '../src/main/automation');
const URL = 'https://visual-action.test/canvas';

for (const scenario of [
  'click',
  'zoom',
  'paint',
  'overlay',
  'transparent-overlay',
  'navigation',
  'scroll',
  'resize',
  'decline',
  'cancel',
  'raw',
  'pre-target-overlay',
]) {
  test(`production visual interaction: ${scenario}`, async ({ electronApp, window, harness }) => {
    await expect(window.locator('body')).toBeVisible();
    await harness.setContentFixture(URL, {
      body: `<!doctype html><style>body{margin:0;height:2000px}canvas{position:absolute;left:50px;top:60px;width:200px;height:100px}</style>
      <canvas width="200" height="100"></canvas><script>
      const canvas=document.querySelector('canvas');const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,200,100);
      globalThis.receipts=[];document.addEventListener('click',e=>receipts.push({trusted:e.isTrusted,target:e.target.tagName,x:e.clientX,y:e.clientY}));</script>`,
    });
    await harness.setContentFixture(`${URL}?new`, {
      body: '<!doctype html><p>Replacement</p><script>globalThis.receipts=[]</script>',
    });
    await electronApp.evaluate(
      (_e, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
      URL
    );
    const result = await electronApp.evaluate(
      async ({ webContents, BrowserWindow }, { main, url, scenario }) => {
        const req = (file) => process.mainModule.require(`${main}/${file}`);
        const { WebContentsPageAdapter } = req('adapters/web-contents-page-adapter');
        const { AutomationController } = req('automation-controller');
        const { createInitialAutomationPolicy } = req('policy-controller');
        const { createOriginScopedAutomationController } = req('origin-scoped-controller');
        const owner = webContents.getAllWebContents().find((w) => w.getURL() === url);
        owner.setZoomFactor(scenario === 'zoom' ? 1.5 : 1);
        const adapter = new WebContentsPageAdapter(owner);
        const controller = new AutomationController({
          policyController: createInitialAutomationPolicy(),
        });
        const tabId = controller.registerPage(adapter);
        const approvals = [];
        const scoped = await createOriginScopedAutomationController({
          controller,
          tabId,
          approvalMode: 'sensitive_actions',
          classifyInteraction: async () => ({ kind: 'ordinary', confidence: 1 }),
          requestApproval: async (request) => {
            approvals.push(request);
            if (scenario === 'paint')
              await owner.executeJavaScript("ctx.fillStyle='blue';ctx.fillRect(0,0,200,100)");
            if (scenario === 'overlay' || scenario === 'transparent-overlay')
              await owner.executeJavaScript(
                `document.body.insertAdjacentHTML('beforeend','<div style="position:fixed;inset:0;z-index:10;${scenario === 'overlay' ? 'background:white' : ''}"></div>')`
              );
            if (scenario === 'navigation') await owner.loadURL(url + '?new');
            if (scenario === 'scroll') await owner.executeJavaScript('scrollTo(0,300)');
            if (scenario === 'resize') BrowserWindow.fromWebContents(owner).setSize(900, 650);
            if (scenario === 'cancel') await adapter.stopLoading();
            return scenario === 'decline' ? 'declined' : 'approved';
          },
        });
        const execute = (op, input = {}) => scoped.execute(op, { tabId, ...input });
        const screenshot = await execute('browser_screenshot');
        const viewport = await owner.executeJavaScript('({width:innerWidth,height:innerHeight})');
        if (scenario === 'pre-target-overlay')
          await owner.executeJavaScript(
            `document.body.insertAdjacentHTML('beforeend','<div style="position:fixed;inset:0;z-index:10"></div>')`
          );
        const prepared = await execute('browser_target_point', {
          captureRef: screenshot.result.captureRef,
          x: 150 / viewport.width,
          y: 110 / viewport.height,
        });
        if (!prepared.ok)
          return {
            screenshot: { ...screenshot, result: { ...screenshot.result, base64: 'omitted' } },
            prepared,
          };
        const clicked =
          scenario === 'raw'
            ? await controller.execute('browser_click', { tabId, ref: prepared.result.ref })
            : await execute('browser_click', { ref: prepared.result.ref });
        const deadline = Date.now() + 700;
        let receipts;
        do {
          receipts = await owner.executeJavaScript('globalThis.receipts');
          if (receipts.length) break;
          await new Promise((r) => setTimeout(r, 20));
        } while (Date.now() < deadline);
        const replay = await execute('browser_click', { ref: prepared.result.ref });
        adapter.dispose();
        return { prepared, clicked, replay, receipts, approvals };
      },
      { main: MAIN, url: URL, scenario }
    );
    if (scenario === 'pre-target-overlay') {
      expect(result.prepared.ok).toBe(false);
      return;
    }
    expect(result.prepared.ok, JSON.stringify(result)).toBe(true);
    if (['click', 'zoom'].includes(scenario)) {
      expect(result.clicked.ok, JSON.stringify(result)).toBe(true);
      expect(result.receipts).toEqual([{ trusted: true, target: 'CANVAS', x: 150, y: 110 }]);
      expect(result.replay.ok).toBe(false);
      expect(result.approvals).toHaveLength(1);
      expect(result.approvals[0].interaction.kind).toBe('uncertain');
    } else {
      expect(result.clicked.ok, JSON.stringify(result)).toBe(false);
      expect(result.receipts).toEqual([]);
    }
  });
}
