// ENS trust shield + popover, driven through the real chrome (#68).
//
// `buildTrustRows` (navigation-utils.js) is unit-tested for the row *data*;
// this spec pins what the user actually sees once navigation.js has built the
// DOM from it: the status sentence and the two row sequences for every trust
// level, the click-to-copy path (the copied text is the full value even when
// the displayed one is middle-truncated to fit), the one-click gesture from an
// open hamburger / Nodes menu to the popover, and the shield giving way to the
// neutral globe on an internal page.
//
// Names resolve through the harness' stubbed `ens:resolve` (`setEnsFixture`),
// so nothing here touches a real RPC. Each fixture's trust object has the
// shape `ens-resolver.js`'s `buildTrust` emits for that verdict — a conflict,
// for instance, has nobody in `agreed` and every queried host in `dissented`.

const { test, expect, clickOverGuest, waitForPopoverFrame } = require('./fixtures');

const LONG_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
// Too long for one popover line, so the popover middle-truncates it — which is
// what makes the copy assertion below prove the *untruncated* value is copied.
const LONG_HOST = 'ethereum-mainnet.an-rpc-provider-with-a-rather-long-hostname.example.test';

const LEVELS = {
  verified: {
    name: 'verified-trust.eth',
    fixture: {
      type: 'ok',
      protocol: 'ipfs',
      decoded: LONG_CID,
      uri: `ipfs://${LONG_CID}`,
      trust: {
        level: 'verified',
        system: 'ens',
        method: 'quorum',
        block: { number: 21000000 },
        queried: ['a.rpc.test', LONG_HOST, 'c.rpc.test'],
        agreed: ['a.rpc.test', LONG_HOST],
        dissented: [],
      },
    },
    shieldLabel: 'Ethereum name resolution trust: verified',
    status: 'ENS resolution verified',
    trustRows: [
      { label: 'Verified by', value: '2 of 3 public RPCs', copy: null },
      { label: 'Evidence', value: 'Matching RPC responses', copy: null },
      { label: 'Block', value: '21000000', copy: '21000000' },
      { label: 'RPC 1', value: 'a.rpc.test', copy: 'a.rpc.test' },
      { label: 'RPC 2', value: LONG_HOST, copy: LONG_HOST },
    ],
    contentRows: [
      { label: 'Network', value: 'IPFS', copy: null },
      { label: 'CID', value: LONG_CID, copy: LONG_CID },
    ],
  },
  'user-configured': {
    name: 'configured-trust.eth',
    fixture: {
      type: 'ok',
      protocol: 'ipfs',
      decoded: 'QmConfiguredTrust',
      uri: 'ipfs://QmConfiguredTrust',
      trust: {
        level: 'user-configured',
        system: 'ens',
        method: 'direct',
        block: { number: 21000001 },
        queried: ['rpc.mine.test'],
        agreed: ['rpc.mine.test'],
        dissented: [],
      },
    },
    shieldLabel: 'Ethereum name resolution trust: user-configured',
    status: 'Resolved with your configured RPC',
    trustRows: [
      { label: 'Resolved by', value: 'Your configured RPC', copy: null },
      { label: 'Evidence', value: 'Trusted endpoint response', copy: null },
      { label: 'Block', value: '21000001', copy: '21000001' },
      { label: 'Server', value: 'rpc.mine.test', copy: 'rpc.mine.test' },
    ],
    contentRows: [
      { label: 'Network', value: 'IPFS', copy: null },
      { label: 'CID', value: 'QmConfiguredTrust', copy: 'QmConfiguredTrust' },
    ],
  },
  unverified: {
    name: 'unverified-trust.eth',
    fixture: {
      type: 'ok',
      protocol: 'ipfs',
      decoded: 'QmUnverifiedTrust',
      uri: 'ipfs://QmUnverifiedTrust',
      trust: {
        level: 'unverified',
        system: 'ens',
        block: { number: 21000002 },
        queried: ['solo.rpc.test'],
        agreed: ['solo.rpc.test'],
        dissented: [],
      },
    },
    shieldLabel: 'Ethereum name resolution trust: unverified',
    status: 'ENS resolution not verified',
    trustRows: [
      { label: 'Resolved by', value: 'A single public RPC', copy: null },
      {
        label: 'Evidence',
        value: 'Single response (not independently verified)',
        copy: null,
      },
      { label: 'Block', value: '21000002', copy: '21000002' },
      { label: 'RPC 1', value: 'solo.rpc.test', copy: 'solo.rpc.test' },
    ],
    contentRows: [
      { label: 'Network', value: 'IPFS', copy: null },
      { label: 'CID', value: 'QmUnverifiedTrust', copy: 'QmUnverifiedTrust' },
    ],
  },
  conflict: {
    name: 'conflict-trust.eth',
    fixture: {
      type: 'conflict',
      reason: 'RPC providers disagree',
      groups: [
        { value: 'ipfs://QmConflictA', urls: ['a.rpc.test'] },
        { value: 'ipfs://QmConflictB', urls: ['b.rpc.test', 'c.rpc.test'] },
      ],
      trust: {
        level: 'conflict',
        system: 'ens',
        block: { number: 21000003 },
        queried: ['a.rpc.test', 'b.rpc.test', 'c.rpc.test'],
        agreed: [],
        dissented: ['a.rpc.test', 'b.rpc.test', 'c.rpc.test'],
      },
    },
    shieldLabel: 'Ethereum name resolution trust: conflict',
    status: 'Verification failed: RPCs disagree',
    trustRows: [
      { label: 'Checked by', value: '3 public RPCs', copy: null },
      { label: 'Evidence', value: 'Conflicting RPC responses', copy: null },
      { label: 'Block', value: '21000003', copy: '21000003' },
      { label: 'Dissenting RPC 1', value: 'a.rpc.test', copy: 'a.rpc.test' },
      { label: 'Dissenting RPC 2', value: 'b.rpc.test', copy: 'b.rpc.test' },
      { label: 'Dissenting RPC 3', value: 'c.rpc.test', copy: 'c.rpc.test' },
    ],
    // Nothing resolved, so there is nothing to say it resolves to: the
    // section is hidden rather than left with a stale or bare row.
    contentRows: null,
  },
};

const webviewUrl = (window) =>
  window.evaluate(() => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    return wv?.getURL?.() || '';
  });

const inGuest = (window, source) =>
  window.evaluate(async (js) => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    if (!wv?.executeJavaScript) return null;
    try {
      return await wv.executeJavaScript(js, true);
    } catch {
      return null;
    }
  }, source);

const navigateTo = async (window, value) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(value);
  await input.press('Enter');
};

// Load `level`'s name the way a user reaches that shield: straight through for
// verified / user-configured, through the soft block's own "Continue once"
// button for unverified, and onto the hard-block interstitial for a conflict
// (whose address bar keeps the bare name, which is what carries the shield).
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const loadLevel = async (window, harness, level) => {
  const { name, fixture } = LEVELS[level];
  await harness.setEnsFixture(name, fixture);
  if (fixture.uri) {
    await harness.setContentFixture(`ipfs://${name}/`, {
      body: `<!doctype html><title>${name}</title><h1>${name}</h1>`,
    });
  }

  await navigateTo(window, name);

  if (level === 'conflict') {
    await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toMatch(/ens-conflict\.html/);
  } else {
    if (level === 'unverified') {
      await expect
        .poll(() => webviewUrl(window), { timeout: 15_000 })
        .toMatch(/ens-unverified\.html/);
      await expect
        .poll(() => inGuest(window, 'Boolean(document.getElementById("continue-btn"))'), {
          timeout: 15_000,
        })
        .toBe(true);
      await inGuest(window, 'document.getElementById("continue-btn").click()');
    }
    await expect
      .poll(() => webviewUrl(window), { timeout: 15_000 })
      .toMatch(new RegExp(`^ipfs://${escapeRegExp(name)}`));
  }

  const shield = window.locator('#trust-shield');
  await expect(shield).toBeVisible({ timeout: 15_000 });
  await expect(shield).toHaveAttribute('data-trust', level);
  return shield;
};

// Every row of one popover section, read the way a user reads it plus the
// copy wiring behind it. `value` is the *full* value: a row the popover
// middle-truncates to fit keeps the untruncated text in `data-auto-fit`, and
// `displayed` (what is painted) is reported separately so a caller can see
// the truncation happen.
const readRows = (window, containerId) =>
  window.evaluate((id) => {
    return [...document.querySelectorAll(`#${id} .trust-popover-field`)].map((row) => {
      const valueEl = row.querySelector('.trust-popover-field-value');
      return {
        label: row.querySelector('.trust-popover-field-label')?.textContent.replace(/:\s*$/, ''),
        value: row.dataset.autoFit || valueEl?.textContent,
        displayed: valueEl?.textContent,
        copy: valueEl?.dataset.copy ?? null,
        uncopyable: row.classList.contains('trust-popover-field-uncopyable'),
      };
    });
  }, containerId);

const withoutDisplay = (rows) => rows.map(({ label, value, copy }) => ({ label, value, copy }));

// Record every `electronAPI.copyText` the chrome makes. The preload exposes it
// as a thin `ipcRenderer.invoke('clipboard:copy-text', text)`, so replacing the
// main-process handler captures exactly what the renderer asked to copy —
// without touching the host's real clipboard.
const recordCopies = async (electronApp) => {
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__trustCopies = [];
    ipcMain.removeHandler('clipboard:copy-text');
    ipcMain.handle('clipboard:copy-text', (_event, text) => {
      globalThis.__trustCopies.push(text);
      return true;
    });
  });
  return () => electronApp.evaluate(() => globalThis.__trustCopies);
};

const menuState = (window) =>
  window.evaluate(() => ({
    hamburger: document.getElementById('menu-dropdown')?.classList.contains('open') === true,
    nodes: document.getElementById('bee-menu-dropdown')?.classList.contains('open') === true,
    backdrop: document.getElementById('menu-backdrop')?.classList.contains('hidden') === false,
    popover: document.getElementById('trust-popover')?.hidden === false,
    expanded: document.getElementById('trust-shield')?.getAttribute('aria-expanded'),
  }));

for (const level of Object.keys(LEVELS)) {
  test(`the ${level} shield opens a popover with its status and row sequences`, async ({
    window,
    harness,
  }, testInfo) => {
    const expected = LEVELS[level];
    const shield = await loadLevel(window, harness, level);
    await expect(shield).toHaveAttribute('aria-label', expected.shieldLabel);

    await clickOverGuest(
      window,
      () => shield.click(),
      async () => (await menuState(window)).popover
    );
    const popover = window.locator('#trust-popover');
    await expect(popover).toHaveAttribute('data-trust', level);
    await expect(shield).toHaveAttribute('aria-expanded', 'true');
    await expect(window.locator('#trust-popover-title')).toHaveText(expected.name);
    await expect(window.locator('#trust-popover-status')).toHaveText(expected.status);

    const trustRows = await readRows(window, 'trust-popover-trust-fields');
    expect(withoutDisplay(trustRows)).toEqual(expected.trustRows);

    const content = window.locator('#trust-popover-content');
    const contentRows = await readRows(window, 'trust-popover-content-fields');
    if (expected.contentRows) {
      await expect(content).toBeVisible();
      await expect(window.locator('#trust-popover-content-title')).toHaveText('Resolves to');
      expect(withoutDisplay(contentRows)).toEqual(expected.contentRows);
    } else {
      await expect(content).toBeHidden();
      expect(contentRows).toEqual([]);
    }
    // A row with nothing to copy reads as plain text: no copy target, and
    // the class that drops the pointer cursor. Checked for every level,
    // including conflict, whose rows are all trust-section summaries.
    for (const row of [...trustRows, ...contentRows]) {
      expect(row.uncopyable).toBe(row.copy === null);
    }

    await window.screenshot({ path: testInfo.outputPath(`${level}-popover.png`) });

    // A second click on the shield is the toggle's other half.
    await shield.click();
    await expect(popover).toBeHidden();
    await expect(shield).toHaveAttribute('aria-expanded', 'false');
  });
}

test('clicking a value row copies its full, untruncated text', async ({
  electronApp,
  window,
  harness,
}) => {
  const copies = await recordCopies(electronApp);
  const shield = await loadLevel(window, harness, 'verified');
  await clickOverGuest(
    window,
    () => shield.click(),
    async () => (await menuState(window)).popover
  );

  // The long RPC host doesn't fit one line, so the popover paints it middle-
  // truncated — the premise that makes this copy assertion meaningful.
  const hostValue = window.locator(
    `#trust-popover-trust-fields .trust-popover-field-value[data-copy="${LONG_HOST}"]`
  );
  const displayed = await hostValue.textContent();
  expect(displayed).toContain('…');
  expect(displayed.length).toBeLessThan(LONG_HOST.length);

  await hostValue.click();
  await expect.poll(copies).toEqual([LONG_HOST]);
  // The "Copied" confirmation, and the popover stays open for another copy.
  await expect(window.locator('#trust-popover-tooltip')).toHaveText('Copied');
  await expect(window.locator('#trust-popover-tooltip')).toBeVisible();
  await expect(window.locator('#trust-popover')).toBeVisible();

  // A content-section row copies its full value too.
  await window
    .locator(`#trust-popover-content-fields .trust-popover-field-value[data-copy="${LONG_CID}"]`)
    .click();
  await expect.poll(copies).toEqual([LONG_HOST, LONG_CID]);

  // A summary row has no copy target: clicking it copies nothing. Rather than
  // wait an arbitrary beat for a copy that should never come, click a copyable
  // row afterwards as a barrier: clicks dispatch in order and the clipboard
  // IPC is handled in order, so any stray copy from the summary rows would
  // land in the recorder *before* the barrier's — once the barrier shows up,
  // the sequence is final.
  await window
    .locator('#trust-popover-content-fields .trust-popover-field-uncopyable')
    .first()
    .click();
  await window
    .locator('#trust-popover-trust-fields .trust-popover-field-uncopyable')
    .first()
    .click();
  await hostValue.click();
  await expect.poll(async () => (await copies()).length).toBeGreaterThanOrEqual(3);
  expect(await copies()).toEqual([LONG_HOST, LONG_CID, LONG_HOST]);
});

// The shield deliberately lets its click bubble (navigation.js), so with a
// menu open one click both closes the menu and opens the popover — never a
// first click that is only spent dismissing the menu.
for (const [menu, button] of [
  ['hamburger', '#menu-button'],
  ['nodes', '#bee-menu-button'],
]) {
  test(`one click on the shield closes the open ${menu} menu and opens the popover`, async ({
    window,
    harness,
  }, testInfo) => {
    const shield = await loadLevel(window, harness, 'verified');

    await window.locator(button).click();
    await expect.poll(() => menuState(window)).toMatchObject({ [menu]: true, backdrop: true });
    await waitForPopoverFrame(window);

    // A real pointer click at the shield's position, exactly once — not a
    // retrying helper, which could hide a first click that only dismissed the
    // menu.
    const box = await shield.boundingBox();
    await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect
      .poll(() => menuState(window))
      .toMatchObject({
        hamburger: false,
        nodes: false,
        backdrop: false,
        popover: true,
        expanded: 'true',
      });
    await expect(window.locator('#trust-popover-status')).toHaveText(LEVELS.verified.status);
    await window.screenshot({ path: testInfo.outputPath(`${menu}-then-shield.png`) });
  });
}

test('an internal page from an ENS page hides the shield and shows the neutral globe', async ({
  window,
  harness,
}, testInfo) => {
  const shield = await loadLevel(window, harness, 'verified');
  const protocolIcon = window.locator('#protocol-icon');
  await expect(protocolIcon).toHaveAttribute('data-protocol', 'ipfs');

  // Settings opens in (or focuses) a tab of its own, so the ENS tab stays
  // where it was underneath.
  const ensTabId = await window.locator('[data-test="tab"].active').getAttribute('data-tab-id');
  await navigateTo(window, 'freedom://settings');
  await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toMatch(/pages\/settings\.html/);
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(/^freedom:\/\/settings/);

  await expect(shield).toBeHidden();
  await expect(shield).not.toHaveAttribute('data-trust', /.*/);
  await expect(window.locator('#trust-popover')).toBeHidden();
  await expect(protocolIcon).toHaveAttribute('data-protocol', 'http');
  await expect(protocolIcon.locator('.icon-http')).toBeVisible();
  await window.screenshot({ path: testInfo.outputPath('settings-neutral-globe.png') });

  // The shield belongs to the ENS tab, not to the window: back on that tab it
  // is repainted from the stored verdict.
  await window.locator(`[data-test="tab"][data-tab-id="${ensTabId}"]`).click();
  await expect(shield).toBeVisible();
  await expect(shield).toHaveAttribute('data-trust', 'verified');
  await expect(protocolIcon).toHaveAttribute('data-protocol', 'ipfs');
});
