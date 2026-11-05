'use strict';

const path = require('node:path');
const { test, expect } = require('./fixtures');

test('preview tabs use the isolated session and retain modules, storage and interactions', async ({ electronApp, window }) => {
  const root = path.resolve(__dirname, '..');
  const url = `freedom-preview://${'b'.repeat(40)}/index.html`;
  await expect(window.locator('body')).toBeVisible();
  await electronApp.evaluate(async ({ session }, directory) => {
    const { PREVIEW_CSP } = process.mainModule.require(`${directory}/src/main/agent/workspace-preview-controller`);
    const target = session.fromPartition('freedom-workspace-preview');
    await target.protocol.unhandle('freedom-preview');
    target.protocol.handle('freedom-preview', request => request.url.endsWith('/app.js')
      ? new Response("localStorage.setItem('fixture','stored');document.querySelector('h1').textContent='Module ready';", { headers: { 'Content-Type': 'text/javascript', 'Content-Security-Policy': PREVIEW_CSP } })
      : new Response('<!doctype html><h1>Loading</h1><button onclick="this.textContent=\'Clicked\'">Try it</button><script type="module" src="/app.js"></script>',
        { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': PREVIEW_CSP } }));
  }, root);
  const tabId = await window.evaluate(async target => (await import('./lib/tabs.js')).createTab(target).id, url);
  await expect.poll(() => electronApp.evaluate(({ webContents }, target) => {
    const page = webContents.getAllWebContents().find(contents => contents.getURL() === target);
    return page?.executeJavaScript("document.querySelector('h1')?.textContent").catch(() => null);
  }, url)).toBe('Module ready');
  const result = await electronApp.evaluate(async ({ session, webContents }, target) => {
    const page = webContents.getAllWebContents().find(contents => contents.getURL() === target);
    return { isolated: page.session === session.fromPartition('freedom-workspace-preview'),
      rtcPolicy: page.getWebRTCIPHandlingPolicy(),
      content: await page.executeJavaScript("document.querySelector('button').click();({storage:localStorage.getItem('fixture'),button:document.querySelector('button').textContent,rtc:typeof RTCPeerConnection})") };
  }, url);
  expect(result).toEqual({ isolated: true, rtcPolicy: 'disable_non_proxied_udp', content: { storage: 'stored', button: 'Clicked', rtc: 'undefined' } });
  expect(await window.locator(`webview[data-tab-id="${tabId}"]`).getAttribute('partition')).toBe('freedom-workspace-preview');
});
