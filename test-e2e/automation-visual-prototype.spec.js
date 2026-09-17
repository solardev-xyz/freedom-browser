'use strict';

// Test-only geometry/freshness experiment. No product tool accepts coordinates.
const { test, expect } = require('./fixtures');

const URL = 'https://visual-binding.test/canvas';

for (const scenario of [
  'scale-1',
  'scale-1.5',
  'scroll',
  'zoom',
  'layout',
  'overlay',
  'transparent-overlay',
  'paint',
  'resize',
  'navigation',
]) {
  test(`visual prototype: ${scenario}`, async ({ electronApp, window, harness }) => {
    await expect(window.locator('body')).toBeVisible();
    await harness.setContentFixture(URL, {
      body: `<!doctype html>
      <style>body { margin:0; height:2000px } canvas { position:absolute; left:50px; top:60px; width:200px; height:100px }</style>
      <canvas width="200" height="100"></canvas><script>
        const canvas = document.querySelector('canvas');
        const context = canvas.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0,0,200,100);
        globalThis.receipts = [];
        document.addEventListener('click', event => receipts.push({ x:event.clientX, y:event.clientY, trusted:event.isTrusted, target:event.target.tagName }));
      </script>`,
    });
    await harness.setContentFixture(`${URL}?new`, { body: '<!doctype html><p>New document</p>' });
    await electronApp.evaluate(
      (_electron, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
      URL
    );
    const result = await electronApp.evaluate(
      async ({ webContents, BrowserWindow }, { url, scenario }) => {
        const crypto = process.mainModule.require('crypto');
        const owner = webContents.getAllWebContents().find((entry) => entry.getURL() === url);
        let generation = 0;
        const onNavigate = () => {
          generation += 1;
        };
        owner.on('did-start-navigation', onNavigate);
        const viewport = () =>
          owner.executeJavaScriptInIsolatedWorld(1002, [
            {
              code: '({ width:innerWidth, height:innerHeight, x:scrollX, y:scrollY, dpr:devicePixelRatio, scale:visualViewport.scale })',
            },
          ]);
        const capture = async () => {
          const before = await viewport();
          const documentGeneration = generation;
          const image = await owner.capturePage();
          const png = image.toPNG();
          const after = await viewport();
          if (documentGeneration !== generation || JSON.stringify(before) !== JSON.stringify(after))
            throw new Error('capture_changed');
          return {
            token: crypto.randomUUID(),
            ownerId: owner.id,
            documentGeneration,
            viewport: after,
            zoom: owner.getZoomFactor(),
            width: png.readUInt32BE(16),
            height: png.readUInt32BE(20),
            digest: crypto.createHash('sha256').update(png).digest('hex'),
            bitmap: image.toBitmap(),
            consumed: false,
          };
        };
        const validate = async (binding, point) => {
          if (
            binding.consumed ||
            binding.ownerId !== owner.id ||
            binding.documentGeneration !== generation
          )
            throw new Error('stale_binding');
          if (
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y) ||
            point.x < 0 ||
            point.y < 0 ||
            point.x >= binding.width ||
            point.y >= binding.height
          )
            throw new Error('outside_capture');
          const sameTarget = await owner.executeJavaScriptInIsolatedWorld(1002, [
            {
              code: `(() => {
            const element = globalThis.__visualTargets?.get(${JSON.stringify(binding.token)});
            return Boolean(element?.isConnected && element === document.elementFromPoint(
              ${(point.x * binding.viewport.width) / binding.width}, ${(point.y * binding.viewport.height) / binding.height}));
          })()`,
            },
          ]);
          if (!sameTarget) throw new Error('stale_binding');
          const current = await capture();
          if (
            binding.zoom !== current.zoom ||
            JSON.stringify(binding.viewport) !== JSON.stringify(current.viewport) ||
            binding.digest !== current.digest
          )
            throw new Error('stale_binding');
        };
        try {
          owner.setZoomFactor(scenario === 'scale-1.5' ? 1.5 : 1);
          owner.focus();
          const binding = await capture();
          // Known red canvas centre calibrates screenshot pixels against CSS
          // coordinates. The production model has not selected a point here.
          const point = {
            x: Math.round((150 * binding.width) / binding.viewport.width),
            y: Math.round((110 * binding.height) / binding.viewport.height),
          };
          const bitmapMatchesPng = binding.bitmap.length === binding.width * binding.height * 4;
          const pixelOffset = (point.y * binding.width + point.x) * 4;
          const pixel = Array.from(binding.bitmap.subarray(pixelOffset, pixelOffset + 4));
          await owner.executeJavaScriptInIsolatedWorld(1002, [
            {
              code: `(() => {
            globalThis.__visualTargets ||= new Map();
            globalThis.__visualTargets.set(${JSON.stringify(binding.token)}, document.elementFromPoint(
              ${(point.x * binding.viewport.width) / binding.width}, ${(point.y * binding.viewport.height) / binding.height}));
          })()`,
            },
          ]);
          await validate(binding, point);
          // Simulate changes while an approval is pending, after initial targeting.
          if (scenario === 'scroll') await owner.executeJavaScript('scrollTo(0, 300)');
          if (scenario === 'zoom') owner.setZoomFactor(1.25);
          if (scenario === 'layout')
            await owner.executeJavaScript("document.querySelector('canvas').style.left='90px'");
          if (scenario === 'overlay')
            await owner.executeJavaScript(
              "document.body.insertAdjacentHTML('beforeend', '<div style=\"position:fixed;inset:0;background:white;z-index:10\">Overlay</div>')"
            );
          if (scenario === 'transparent-overlay')
            await owner.executeJavaScript(
              "document.body.insertAdjacentHTML('beforeend', '<div style=\"position:fixed;inset:0;z-index:10\"></div>')"
            );
          if (scenario === 'paint')
            await owner.executeJavaScript(
              "const ctx=document.querySelector('canvas').getContext('2d'); ctx.fillStyle='blue';ctx.fillRect(0,0,200,100)"
            );
          if (scenario === 'resize') BrowserWindow.fromWebContents(owner).setSize(900, 650);
          if (scenario === 'navigation') await owner.loadURL(`${url}?new`);
          let rejected = false;
          let dispatched = false;
          try {
            await validate(binding, point);
            binding.consumed = true;
            const x = Math.round(
              ((point.x * binding.viewport.width) / binding.width) * binding.zoom
            );
            const y = Math.round(
              ((point.y * binding.viewport.height) / binding.height) * binding.zoom
            );
            owner.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            owner.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
            dispatched = true;
          } catch (error) {
            if (error.message !== 'stale_binding') throw error;
            rejected = true;
          }
          // Dispatch and script evaluation use different queues. Wait for the
          // actual fixture event, not merely completion of sendInputEvent().
          const receipts = await owner.executeJavaScript(
            dispatched
              ? `(async () => {
            const deadline = Date.now() + 1000;
            while (Date.now() < deadline && !globalThis.receipts?.length) {
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            return globalThis.receipts || [];
          })()`
              : 'globalThis.receipts || []'
          );
          let replayRejected = false;
          if (dispatched) {
            try {
              await validate(binding, point);
            } catch (error) {
              replayRejected = error.message === 'stale_binding';
            }
          }
          return {
            bitmapMatchesPng,
            pixel,
            rejected,
            dispatched,
            receipts,
            replayRejected,
            imageSize: { width: binding.width, height: binding.height },
            viewport: binding.viewport,
            zoom: binding.zoom,
          };
        } finally {
          owner.removeListener('did-start-navigation', onNavigate);
        }
      },
      { url: URL, scenario }
    );
    expect(result.bitmapMatchesPng).toBe(true);
    expect(result.pixel).toEqual([0, 0, 255, 255]);
    if (scenario.startsWith('scale')) {
      expect(result.dispatched).toBe(true);
      expect(result.replayRejected).toBe(true);
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]).toMatchObject({ trusted: true, target: 'CANVAS' });
      expect(Math.abs(result.receipts[0].x - 150)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.receipts[0].y - 110)).toBeLessThanOrEqual(1);
    } else {
      expect(result.rejected).toBe(true);
      expect(result.dispatched).toBe(false);
      expect(result.receipts).toEqual([]);
    }
  });
}
