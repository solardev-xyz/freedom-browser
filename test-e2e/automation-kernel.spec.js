'use strict';

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const PAGE_URL = `bzz://${SAMPLE_BZZ_HASH}/automation`;
const NEXT_URL = `bzz://${SAMPLE_BZZ_HASH}/next`;
const HIDDEN_URL = `bzz://${SAMPLE_BZZ_HASH}/hidden`;

function executeAutomation(electronApp, operation, input = {}) {
  return electronApp.evaluate(
    async ({ ipcMain: _ipcMain }, payload) =>
      globalThis.__FREEDOM_TEST_HARNESS__.automationExecute(payload.operation, payload.input),
    { operation, input }
  );
}

async function tabForUrl(electronApp, url) {
  const result = await executeAutomation(electronApp, 'browser_list_tabs');
  return result.result.tabs.find((tab) => tab.url === url) || null;
}

async function automationTabs(electronApp) {
  const result = await executeAutomation(electronApp, 'browser_list_tabs');
  return result.result.tabs;
}

test('one automation contract drives desktop and hidden Electron pages', async ({
  electronApp,
  window,
  harness,
}) => {
  await harness.setContentFixture(PAGE_URL, {
    body: `<!doctype html>
      <title>Automation fixture</title>
      <label for="name">Name</label>
      <input id="name" aria-label="Name">
      <button id="submit">Submit</button>
      <p id="output">Waiting</p>
      <script>
        let inputTrusted = false;
        document.querySelector('#name').addEventListener('input', (event) => {
          inputTrusted = event.isTrusted;
        });
        document.querySelector('#submit').addEventListener('click', (event) => {
          const value = document.querySelector('#name').value;
          document.querySelector('#output').textContent =
            value + ' clickTrusted=' + event.isTrusted + ' inputTrusted=' + inputTrusted;
          setTimeout(() => {
            document.querySelector('#output').textContent += ' Ready';
          }, 150);
        });
      </script>`,
  });
  await harness.setContentFixture(NEXT_URL, {
    body: '<!doctype html><title>Next fixture</title><h1>Next page</h1>',
  });
  await harness.setContentFixture(HIDDEN_URL, {
    body: `<!doctype html><title>Hidden fixture</title>
      <button id="run">Run hidden</button><p id="hidden-output">Waiting</p>
      <script>
        document.querySelector('#run').addEventListener('click', (event) => {
          document.querySelector('#hidden-output').textContent = 'Hidden trusted=' + event.isTrusted;
        });
      </script>`,
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_URL);
  await input.press('Enter');
  await expect
    .poll(() => automationTabs(electronApp), { timeout: 5_000 })
    .toEqual(expect.arrayContaining([expect.objectContaining({ url: PAGE_URL })]));
  const desktopTab = await tabForUrl(electronApp, PAGE_URL);

  const snapshot = await executeAutomation(electronApp, 'browser_snapshot', {
    tabId: desktopTab.tabId,
  });
  expect(snapshot.ok).toBe(true);
  const nameRef = snapshot.result.elements.find((element) => element.name === 'Name')?.ref;
  const submitRef = snapshot.result.elements.find((element) => element.name === 'Submit')?.ref;
  expect(nameRef).toBeTruthy();
  expect(submitRef).toBeTruthy();

  await expect(
    executeAutomation(electronApp, 'browser_type', {
      tabId: desktopTab.tabId,
      ref: nameRef,
      text: 'Freedom',
    })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    executeAutomation(electronApp, 'browser_click', {
      tabId: desktopTab.tabId,
      ref: submitRef,
    })
  ).resolves.toMatchObject({ ok: true });
  await expect
    .poll(
      async () =>
        (await executeAutomation(electronApp, 'browser_snapshot', { tabId: desktopTab.tabId }))
          .result.text
    )
    .toContain('Freedom clickTrusted=true inputTrusted=true');
  await expect(
    executeAutomation(electronApp, 'browser_wait', {
      tabId: desktopTab.tabId,
      condition: 'text',
      text: 'Ready',
      timeoutMs: 2_000,
    })
  ).resolves.toMatchObject({ ok: true, result: { matched: true, condition: 'text' } });

  const pendingWait = executeAutomation(electronApp, 'browser_wait', {
    tabId: desktopTab.tabId,
    condition: 'text',
    text: 'Never appears',
    timeoutMs: 5_000,
  });
  await window.waitForTimeout(100);
  await expect(
    executeAutomation(electronApp, 'browser_stop_loading', { tabId: desktopTab.tabId })
  ).resolves.toMatchObject({ ok: true, result: { stopped: true, cancelledWaits: 1 } });
  await expect(pendingWait).resolves.toMatchObject({
    ok: false,
    error: { code: 'USER_CANCELLED' },
  });

  await input.click();
  await input.fill(NEXT_URL);
  await input.press('Enter');
  await expect
    .poll(() => automationTabs(electronApp), { timeout: 5_000 })
    .toEqual(expect.arrayContaining([expect.objectContaining({ url: NEXT_URL })]));
  await expect(
    executeAutomation(electronApp, 'browser_click', {
      tabId: desktopTab.tabId,
      ref: submitRef,
    })
  ).resolves.toMatchObject({
    ok: false,
    error: { code: 'STALE_ELEMENT_REFERENCE' },
  });

  const hiddenTabId = await electronApp.evaluate(
    async ({ ipcMain: _ipcMain }, url) =>
      globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
    HIDDEN_URL
  );
  try {
    const hiddenSnapshot = await executeAutomation(electronApp, 'browser_snapshot', {
      tabId: hiddenTabId,
    });
    expect(hiddenSnapshot).toMatchObject({
      ok: true,
      result: { title: 'Hidden fixture' },
    });
    const hiddenRef = hiddenSnapshot.result.elements.find(
      (element) => element.name === 'Run hidden'
    )?.ref;
    expect(hiddenRef).toBeTruthy();
    await expect(
      executeAutomation(electronApp, 'browser_click', { tabId: hiddenTabId, ref: hiddenRef })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executeAutomation(electronApp, 'browser_wait', {
        tabId: hiddenTabId,
        condition: 'text',
        text: 'Hidden trusted=true',
        timeoutMs: 2_000,
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executeAutomation(electronApp, 'browser_screenshot', { tabId: hiddenTabId })
    ).resolves.toMatchObject({
      ok: true,
      result: { mediaType: 'image/png', base64: expect.any(String) },
    });
  } finally {
    await electronApp.evaluate(
      ({ ipcMain: _ipcMain }, tabId) =>
        globalThis.__FREEDOM_TEST_HARNESS__.closeHiddenAutomationPage(tabId),
      hiddenTabId
    );
  }
});
