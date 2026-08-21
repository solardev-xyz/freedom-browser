'use strict';

const { test, expect, SAMPLE_BZZ_HASH, SAMPLE_IPFS_CID } = require('./fixtures');

const PAGE_URL = `bzz://${SAMPLE_BZZ_HASH}/automation`;
const NEXT_URL = `bzz://${SAMPLE_BZZ_HASH}/next`;
const HIDDEN_URL = `bzz://${SAMPLE_BZZ_HASH}/hidden`;
const PROTOCOL_CASES = [
  { label: 'HTTPS', url: 'https://automation.example.test/protocol' },
  { label: 'Swarm', url: `bzz://${SAMPLE_BZZ_HASH}/protocol` },
  { label: 'IPFS', url: `ipfs://${SAMPLE_IPFS_CID}/protocol` },
];

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

function protocolFixture(label) {
  return {
    body: `<!doctype html>
      <title>${label} automation fixture</title>
      <button id="run">Run ${label}</button>
      <p id="result">Waiting</p>
      <script>
        document.querySelector('#run').addEventListener('click', (event) => {
          document.querySelector('#result').textContent =
            '${label} trusted=' + event.isTrusted;
        });
      </script>`,
  };
}

async function exerciseProtocolPage(electronApp, tabId, protocolCase) {
  const { label, url } = protocolCase;
  await expect(
    executeAutomation(electronApp, 'browser_navigate', { tabId, url })
  ).resolves.toMatchObject({ ok: true, result: { url } });
  const snapshot = await executeAutomation(electronApp, 'browser_snapshot', { tabId });
  expect(snapshot).toMatchObject({ ok: true, result: { title: `${label} automation fixture` } });
  const runRef = snapshot.result.elements.find((element) => element.name === `Run ${label}`)?.ref;
  expect(runRef).toBeTruthy();
  await expect(
    executeAutomation(electronApp, 'browser_click', { tabId, ref: runRef })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    executeAutomation(electronApp, 'browser_wait', {
      tabId,
      condition: 'text',
      text: `${label} trusted=true`,
      timeoutMs: 2_000,
    })
  ).resolves.toMatchObject({ ok: true });
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
      <input id="redirect-input" aria-label="Redirected input">
      <input id="redirect-sink" aria-label="Redirect sink">
      <p id="redirect-output">Redirect waiting</p>
      <button id="submit">Submit</button>
      <p id="output">Waiting</p>
      <button id="replace-target">Replace target</button>
      <button id="dynamic-target">Dynamic target</button>
      <p id="dynamic-output">Dynamic waiting</p>
      <button id="open-popup">Open popup</button>
      <iframe id="child-frame" name="automation-child"></iframe>
      <script>
        let inputTrusted = false;
        document.querySelector('#name').addEventListener('input', (event) => {
          inputTrusted = event.isTrusted;
        });
        document.querySelector('#redirect-input').addEventListener('focus', () => {
          document.querySelector('#redirect-sink').focus();
        });
        document.querySelector('#redirect-sink').addEventListener('input', () => {
          document.querySelector('#redirect-output').textContent = 'Unexpected redirected input';
        });
        document.querySelector('#submit').addEventListener('click', (event) => {
          const value = document.querySelector('#name').value;
          document.querySelector('#output').textContent =
            value + ' clickTrusted=' + event.isTrusted + ' inputTrusted=' + inputTrusted;
          setTimeout(() => {
            document.querySelector('#output').textContent += ' Ready';
          }, 150);
        });
        const wireDynamicTarget = (target) => {
          target.addEventListener('click', (event) => {
            document.querySelector('#dynamic-output').textContent =
              'Dynamic trusted=' + event.isTrusted;
          });
        };
        wireDynamicTarget(document.querySelector('#dynamic-target'));
        document.querySelector('#replace-target').addEventListener('click', () => {
          const current = document.querySelector('#dynamic-target');
          const replacement = current.cloneNode(true);
          current.replaceWith(replacement);
          wireDynamicTarget(replacement);
        });
        document.querySelector('#open-popup').addEventListener('click', () => {
          window.open('${NEXT_URL}', '_blank');
        });
        document.querySelector('#child-frame').srcdoc =
          '<button id="frame-run">Run frame</button>' +
          '<p id="frame-output">Frame waiting</p>' +
          '<scr' + 'ipt>' +
          'document.querySelector("#frame-run").addEventListener("click", (event) => {' +
          'document.querySelector("#frame-output").textContent = "Frame trusted=" + event.isTrusted;' +
          '});' +
          '</scr' + 'ipt>';
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
  const desktopIdentity = await window.evaluate(() => {
    const webview = document.querySelector('webview:not(.hidden)');
    return {
      rendererTabId: Number(webview?.dataset?.tabId),
      guestWebContentsId: webview?.getWebContentsId?.() || null,
    };
  });
  const boundAutomationTabId = await electronApp.evaluate(
    ({ ipcMain: _ipcMain }, identity) =>
      globalThis.__FREEDOM_TEST_HARNESS__.automationTabForRenderer(
        identity.rendererTabId,
        identity.guestWebContentsId
      ),
    desktopIdentity
  );
  expect(boundAutomationTabId).toBe(desktopTab.tabId);

  const snapshot = await executeAutomation(electronApp, 'browser_snapshot', {
    tabId: desktopTab.tabId,
  });
  expect(snapshot.ok).toBe(true);
  const nameRef = snapshot.result.elements.find((element) => element.name === 'Name')?.ref;
  const redirectedInputRef = snapshot.result.elements.find(
    (element) => element.name === 'Redirected input'
  )?.ref;
  const submitRef = snapshot.result.elements.find((element) => element.name === 'Submit')?.ref;
  const replaceRef = snapshot.result.elements.find(
    (element) => element.name === 'Replace target'
  )?.ref;
  const dynamicRef = snapshot.result.elements.find(
    (element) => element.name === 'Dynamic target'
  )?.ref;
  expect(nameRef).toBeTruthy();
  expect(redirectedInputRef).toBeTruthy();
  expect(submitRef).toBeTruthy();
  expect(replaceRef).toBeTruthy();
  expect(dynamicRef).toBeTruthy();

  await expect(
    executeAutomation(electronApp, 'browser_type', {
      tabId: desktopTab.tabId,
      ref: redirectedInputRef,
      text: 'must-not-land',
    })
  ).resolves.toMatchObject({
    ok: false,
    error: { code: 'ELEMENT_NOT_INTERACTABLE' },
  });
  await expect(
    executeAutomation(electronApp, 'browser_snapshot', { tabId: desktopTab.tabId })
  ).resolves.toMatchObject({
    ok: true,
    result: { text: expect.stringContaining('Redirect waiting') },
  });

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

  let frameSnapshot;
  await expect
    .poll(async () => {
      frameSnapshot = await executeAutomation(electronApp, 'browser_snapshot', {
        tabId: desktopTab.tabId,
      });
      return frameSnapshot.result.elements.some((element) => element.name === 'Run frame');
    })
    .toBe(true);
  const childFrame = frameSnapshot.result.frames.find((frame) => frame.name === 'automation-child');
  const frameRef = frameSnapshot.result.elements.find(
    (element) => element.name === 'Run frame'
  )?.ref;
  expect(childFrame).toMatchObject({ parentFrameId: 'frame_main', depth: 1, accessible: true });
  expect(frameSnapshot.result.elements.find((element) => element.ref === frameRef)?.frameId).toBe(
    childFrame.frameId
  );
  await expect(
    executeAutomation(electronApp, 'browser_click', { tabId: desktopTab.tabId, ref: frameRef })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    executeAutomation(electronApp, 'browser_wait', {
      tabId: desktopTab.tabId,
      condition: 'text',
      text: 'Frame trusted=true',
      timeoutMs: 2_000,
    })
  ).resolves.toMatchObject({ ok: true });

  await expect(
    executeAutomation(electronApp, 'browser_click', {
      tabId: desktopTab.tabId,
      ref: replaceRef,
    })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    executeAutomation(electronApp, 'browser_click', {
      tabId: desktopTab.tabId,
      ref: dynamicRef,
    })
  ).resolves.toMatchObject({ ok: false, error: { code: 'STALE_ELEMENT_REFERENCE' } });
  const postMutationSnapshot = await executeAutomation(electronApp, 'browser_snapshot', {
    tabId: desktopTab.tabId,
  });
  const replacementRef = postMutationSnapshot.result.elements.find(
    (element) => element.name === 'Dynamic target'
  )?.ref;
  expect(replacementRef).toBeTruthy();
  expect(replacementRef).not.toBe(dynamicRef);
  await expect(
    executeAutomation(electronApp, 'browser_click', {
      tabId: desktopTab.tabId,
      ref: replacementRef,
    })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    executeAutomation(electronApp, 'browser_wait', {
      tabId: desktopTab.tabId,
      condition: 'text',
      text: 'Dynamic trusted=true',
      timeoutMs: 2_000,
    })
  ).resolves.toMatchObject({ ok: true });

  const popupRef = postMutationSnapshot.result.elements.find(
    (element) => element.name === 'Open popup'
  )?.ref;
  const tabCountBeforePopup = (await automationTabs(electronApp)).length;
  await expect(
    executeAutomation(electronApp, 'browser_click', {
      tabId: desktopTab.tabId,
      ref: popupRef,
    })
  ).resolves.toMatchObject({ ok: true });
  await expect
    .poll(() => automationTabs(electronApp), { timeout: 5_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: NEXT_URL, kind: 'desktop', available: true }),
      ])
    );
  expect((await automationTabs(electronApp)).length).toBe(tabCountBeforePopup + 1);

  const pendingWait = executeAutomation(electronApp, 'browser_wait', {
    tabId: desktopTab.tabId,
    condition: 'text',
    text: 'Never appears',
    timeoutMs: 5_000,
  });
  await window.waitForTimeout(100);
  const cancellationStartedAt = Date.now();
  const stopResult = await executeAutomation(electronApp, 'browser_stop_loading', {
    tabId: desktopTab.tabId,
  });
  expect(stopResult).toMatchObject({
    ok: true,
    result: { stopped: true, cancelledWaits: 1 },
  });
  const pendingResult = await pendingWait;
  expect(pendingResult).toMatchObject({
    ok: false,
    error: { code: 'USER_CANCELLED' },
  });
  expect(Date.now() - cancellationStartedAt).toBeLessThan(1_000);

  await expect(
    executeAutomation(electronApp, 'browser_navigate', {
      tabId: desktopTab.tabId,
      url: NEXT_URL,
    })
  ).resolves.toMatchObject({ ok: true });
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

test('desktop and hidden adapters preserve HTTPS, Swarm, and IPFS behavior', async ({
  electronApp,
  window,
  harness,
}) => {
  await expect(window.locator('[data-test="address-input"]')).toBeVisible();
  for (const protocolCase of PROTOCOL_CASES) {
    await harness.setContentFixture(protocolCase.url, protocolFixture(protocolCase.label));
  }

  const addressInput = window.locator('[data-test="address-input"]');
  await addressInput.click();
  await addressInput.fill(PROTOCOL_CASES[0].url);
  await addressInput.press('Enter');
  await expect(addressInput).toHaveValue(PROTOCOL_CASES[0].url);
  await expect
    .poll(() => automationTabs(electronApp), { timeout: 5_000 })
    .toEqual(expect.arrayContaining([expect.objectContaining({ url: PROTOCOL_CASES[0].url })]));
  const desktopTab = await tabForUrl(electronApp, PROTOCOL_CASES[0].url);

  for (const protocolCase of PROTOCOL_CASES) {
    await exerciseProtocolPage(electronApp, desktopTab.tabId, protocolCase);

    const hiddenTabId = await electronApp.evaluate(
      async ({ ipcMain: _ipcMain }, url) =>
        globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
      protocolCase.url
    );
    try {
      await exerciseProtocolPage(electronApp, hiddenTabId, protocolCase);
    } finally {
      await electronApp.evaluate(
        ({ ipcMain: _ipcMain }, tabId) =>
          globalThis.__FREEDOM_TEST_HARNESS__.closeHiddenAutomationPage(tabId),
        hiddenTabId
      );
    }
  }
});
