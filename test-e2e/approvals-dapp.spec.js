// dApp prompts in the approvals document, in real Electron (freedom-core
// design 0011, step APS-2), with FREEDOM_APPROVALS_DOCUMENT=1: every page
// prompt shows in the window's panel from its kind's template, the chrome
// shows only the badges and the count, and the page makes room for the
// panel beside the content.
//
// The first test runs main's waiting and switching (PRQ-4) with the prompt
// in the document, on the harness's test kind; the next ones run the real
// dApp kinds through their real dispatchers, and every kind's template with
// hostile data in every field a page chooses.

const { verifyMessage } = require('ethers');
const {
  test,
  expect,
  VAULT_PASSWORD,
  PAST_DELAY_MS,
  sleep,
  inGuest,
  approvalsState,
  approvalsTrace,
  promptState,
  chromeWindowId,
  approvalsPage,
  openTab,
  reportCount,
  nextReport,
  clickTooSoon,
  pageTrace,
} = require('./approvals-fixtures');

const A = `bzz://${'a'.repeat(64)}`;
const B = `bzz://${'b'.repeat(64)}`;

// A page that asks main for the harness's prompt, showing the view it chooses.
const testPage = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__asked = {};
    window.__ask = (tag, view) => {
      window.__asked[tag] = { pending: true };
      window.swarm.request({ method: 'swarm_readChunk', params: { tag, view } }).then(
        (ok) => { window.__asked[tag] = { ok }; },
        (e) => { window.__asked[tag] = { code: e && e.code, message: String((e && e.message) || e) }; }
      );
      return true;
    };
    window.__ready = true;
  </script><h1>${title}</h1>`,
});

const view = (title) => ({ title, message: `About ${title}`, rows: [] });
const outcome = (electronApp, guest, tag) => inGuest(electronApp, guest, `window.__asked[${JSON.stringify(tag)}] || null`);
const tabButton = (win, tabId) => win.locator(`[data-test="tab"][data-tab-id="${tabId}"]`);
const count = (win) => win.locator('[data-test="wallet-prompt-count"]');
const space = (win) => win.locator('[data-test="approvals-space"]');

async function routeTestPrompts(electronApp) {
  await electronApp.evaluate(() => {
    const hooks = globalThis.__FREEDOM_TEST_PAGE_REQUESTS__;
    hooks.setRoutes(['swarm:swarm_readChunk']);
    hooks.setDispatch(async (context) => {
      const { tag, view: shown } = context.params || {};
      const decision = await context.prompt({ kind: 'test.prompt', view: shown });
      if (decision.approve === true) return { result: `approved:${tag}` };
      return { error: { code: 4001, message: decision.closed ? `closed:${decision.closed}` : 'User rejected the request' } };
    });
  });
}

test('a background tab\'s prompt waits, switching hides and shows it in the panel, and the page makes room (0011 APS-2)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(180_000);
  await harness.setContentFixture(`${A}/`, testPage('dapp a'));
  await harness.setContentFixture(`${B}/`, testPage('dapp b'));
  await routeTestPrompts(electronApp);
  const windowId = await chromeWindowId(electronApp);
  const docPage = await approvalsPage(electronApp);
  // The chrome knows the panel is on, and no room is taken yet.
  expect(await win.evaluate(() => window.pagePrompts.approvalsDocument)).toBe(true);
  await expect(space(win)).not.toHaveClass(/open/);

  const guestA = await openTab(electronApp, win, `${A}/`);
  const guestB = await openTab(electronApp, win, `${B}/`);
  // Tab B is in front (tab 3); A waits in the background (tab 2).
  const widthBefore = await win.evaluate(() => document.querySelector('webview:not(.hidden)').getBoundingClientRect().width);

  // A background tab's request: a badge and the count, no panel, no room.
  await inGuest(electronApp, guestA, `window.__ask('a1', ${JSON.stringify(view('a1'))})`);
  await expect(count(win)).toHaveText('1');
  await expect(tabButton(win, 2)).toHaveClass(/has-wallet-prompt/);
  expect((await approvalsState(electronApp))[windowId]).toMatchObject({ visible: false, shown: null });
  await expect(space(win)).not.toHaveClass(/open/);

  // The tab in front asks: its prompt shows, and the page makes room.
  let after = await reportCount(electronApp, windowId);
  await inGuest(electronApp, guestB, `window.__ask('b1', ${JSON.stringify(view('b1'))})`);
  const b1 = (await nextReport(electronApp, windowId, after)).handle;
  await expect(count(win)).toHaveText('2');
  await expect(space(win)).toHaveClass(/open/);
  await expect
    .poll(() => win.evaluate(() => document.querySelector('webview:not(.hidden)').getBoundingClientRect().width))
    .toBe(widthBefore - 320);
  const [contentWidth] = await electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getContentSize(), windowId);
  const spaceBox = await space(win).boundingBox();
  const bounds = (await approvalsState(electronApp))[windowId].bounds;
  // The room the page made is where main put the panel.
  expect(Math.round(spaceBox.x)).toBe(bounds.x);
  expect(bounds.x + bounds.width).toBe(contentWidth);
  await expect(docPage.locator('#body .field-value').first()).toHaveText('b1');

  // Switching to A: B's prompt is hidden and keeps its place, A's shows,
  // and a decision for B sent late, after the switch, is refused.
  await sleep(PAST_DELAY_MS);
  after = await reportCount(electronApp, windowId);
  await tabButton(win, 2).click();
  await expect.poll(async () => (await approvalsState(electronApp))[windowId].shown).not.toBe(b1);
  expect(await docPage.evaluate((h) => window.approvals.decide(h, true, undefined), b1)).toEqual({ ok: false, reason: 'not-shown' });
  const a1 = await clickTooSoon(electronApp, docPage, windowId, after);
  await expect(docPage.locator('#body .field-value').first()).toHaveText('a1');
  expect((await promptState(electronApp))[windowId].open).toEqual([a1, b1]);
  await expect(space(win)).toHaveClass(/open/);
  await docPage.click('#reject');
  await expect.poll(() => outcome(electronApp, guestA, 'a1')).toEqual({ code: 4001, message: 'User rejected the request' });
  await expect(count(win)).toHaveText('1');
  await expect(tabButton(win, 2)).not.toHaveClass(/has-wallet-prompt/);
  // A has nothing more to show: the panel goes and the page takes its room back.
  await expect.poll(async () => (await approvalsState(electronApp))[windowId]).toMatchObject({ visible: false, shown: null });
  await expect(space(win)).not.toHaveClass(/open/);

  // Back on B: it shows again, and a decision counts only once the delay
  // has started again.
  after = await reportCount(electronApp, windowId);
  await tabButton(win, 3).click();
  expect(await clickTooSoon(electronApp, docPage, windowId, after)).toBe(b1);
  await docPage.click('#approve');
  await expect.poll(() => outcome(electronApp, guestB, 'b1')).toEqual({ ok: 'approved:b1' });
  await expect(count(win)).toBeHidden();
  await expect(space(win)).not.toHaveClass(/open/);
  await expect
    .poll(() => win.evaluate(() => document.querySelector('webview:not(.hidden)').getBoundingClientRect().width))
    .toBe(widthBefore);

  // The chrome never rendered a prompt: its sidebar stayed shut.
  await expect(win.locator('#sidebar')).toHaveClass(/collapsed/);
  expect((await approvalsTrace(electronApp)).filter((e) => e.kind === 'request-refused')).toEqual([]);
});

// A dApp page that keeps every provider answer it hears.
const dappPage = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__asked = {};
    window.__ask = (id, method, params) => {
      window.__asked[id] = { pending: true };
      window.ethereum.request({ method, params }).then(
        (ok) => { window.__asked[id] = { ok }; },
        (e) => { window.__asked[id] = { code: e && e.code, message: String((e && e.message) || e) }; }
      );
      return true;
    };
    window.__ready = true;
  </script><h1>${title}</h1>`,
});
const MESSAGE = '0x48656c6c6f2c2046726565646f6d'; // "Hello, Freedom"

test.describe('with a vault', () => {
  test.use({ withVault: true });

  test('connecting, unlocking and signing in the panel; only its decisions mint (0011 APS-2)', async ({
    electronApp,
    window: win,
    harness,
  }) => {
    test.setTimeout(180_000);
    await harness.setContentFixture(`${A}/`, dappPage('dapp'));
    const windowId = await chromeWindowId(electronApp);
    const docPage = await approvalsPage(electronApp);
    const guest = await openTab(electronApp, win, `${A}/`);
    const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
    const ask = (id, method, params = []) =>
      inGuest(electronApp, guest, `window.__ask(${JSON.stringify(id)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})`);
    const answer = (id) => inGuest(electronApp, guest, `window.__asked[${JSON.stringify(id)}] || null`);

    // Connect: main's template, the account picked in the panel, main's grant.
    let after = await reportCount(electronApp, windowId);
    await ask('connect', 'eth_requestAccounts');
    const connect = (await nextReport(electronApp, windowId, after)).handle;
    await expect(docPage.locator('#heading')).toHaveText('Connect');
    await expect(docPage.locator('#site')).toHaveText(A);
    await expect(docPage.locator('#body')).toContainText('Main Wallet');
    await expect(docPage.locator('#body')).toContainText(account);
    await expect(docPage.locator('#approve')).toHaveText('Connect');
    expect(await win.evaluate((h) => window.pagePrompts.decide(h, true, { walletIndex: 0 }), connect)).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    await sleep(PAST_DELAY_MS);
    await docPage.click('#approve');
    await expect.poll(() => answer('connect')).toEqual({ ok: [account] });
    expect(await win.evaluate((k) => window.dappPermissions.getPermission(k), A)).toMatchObject({ origin: A, walletIndex: 0 });

    // A signature from a locked vault: the vault unlock comes first, in the
    // panel; a wrong password shows it again, saying so.
    expect((await win.evaluate(() => window.identity.getStatus())).isUnlocked).not.toBe(true);
    after = await reportCount(electronApp, windowId);
    await ask('message', 'personal_sign', [MESSAGE, account]);
    await nextReport(electronApp, windowId, after);
    await expect(docPage.locator('#heading')).toHaveText('Unlock Vault');
    await sleep(PAST_DELAY_MS);
    await docPage.fill('input[type="password"]', 'not the password');
    // Enter in the password field never approves.
    await docPage.press('input[type="password"]', 'Enter');
    await sleep(300);
    expect((await pageTrace(electronApp)).filter((e) => e.kind === 'unlock-failed')).toEqual([]);
    after = await reportCount(electronApp, windowId);
    await docPage.click('#approve');
    await nextReport(electronApp, windowId, after);
    await expect(docPage.locator('#body')).toContainText('Incorrect password');
    await sleep(PAST_DELAY_MS);
    await docPage.fill('input[type="password"]', VAULT_PASSWORD);
    after = await reportCount(electronApp, windowId);
    await docPage.click('#approve');
    // Then the signature's own prompt, with main's message.
    const sign = (await nextReport(electronApp, windowId, after)).handle;
    await expect(docPage.locator('#heading')).toHaveText('Sign Message');
    await expect(docPage.locator('#body')).toContainText('Hello, Freedom');
    expect((await win.evaluate(() => window.identity.getStatus())).isUnlocked).toBe(true);
    // The chrome's decision is refused here too; the panel's counts.
    expect(await win.evaluate((h) => window.pagePrompts.decide(h, true, { alwaysAllow: false }), sign)).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    await docPage.screenshot({ path: test.info().outputPath('approvals-sign.png') });
    await sleep(PAST_DELAY_MS);
    await docPage.click('#approve');
    await expect.poll(async () => (await answer('message'))?.ok || null, { timeout: 15_000 }).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(verifyMessage('Hello, Freedom', (await answer('message')).ok)).toBe(account);
    // One token, minted on the panel's approval, and spent.
    const trace = await pageTrace(electronApp);
    const record = trace.filter((e) => e.kind === 'recorded' && e.guest === guest && e.method === 'personal_sign').at(-1).id;
    expect(trace.filter((e) => e.id === record && e.kind.startsWith('token-')).map((e) => [e.kind, e.token])).toEqual([
      ['token-minted', 'sign-message'],
      ['token-spent', 'sign-message'],
    ]);
    // Connect, the wrong password, the right one, the signature.
    expect(trace.filter((e) => e.kind === 'decide' && e.ok === true).map((e) => e.from)).toEqual([
      'approvals',
      'approvals',
      'approvals',
      'approvals',
    ]);
    // The chrome rendered none of it.
    await expect(win.locator('#sidebar')).toHaveClass(/collapsed/);
  });
});

// APS-4: a view over 256 KiB (here a 300 KiB message) is no longer only
// rejectable: main sends it in parts the panel asks for, the panel checks
// the joined view and shows it in full, and only then reports it shown.
test.describe('with a vault, a view over 256 KiB', () => {
  test.use({ withVault: true });

  test('a 300 KiB message shows in full in the panel, from parts, and its approval signs it (0011 APS-4)', async ({
    electronApp,
    window: win,
    harness,
  }) => {
    test.setTimeout(180_000);
    await harness.setContentFixture(`${A}/`, dappPage('dapp'));
    const windowId = await chromeWindowId(electronApp);
    const docPage = await approvalsPage(electronApp);
    const guest = await openTab(electronApp, win, `${A}/`);
    const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
    const ask = (id, method, params = []) =>
      inGuest(electronApp, guest, `window.__ask(${JSON.stringify(id)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})`);
    const answer = (id) => inGuest(electronApp, guest, `window.__asked[${JSON.stringify(id)}] || null`);

    let after = await reportCount(electronApp, windowId);
    await ask('connect', 'eth_requestAccounts');
    await nextReport(electronApp, windowId, after);
    await sleep(PAST_DELAY_MS);
    await docPage.click('#approve');
    await expect.poll(() => answer('connect')).toEqual({ ok: [account] });

    const lines = [];
    for (let i = 0; lines.join('\n').length < 300 * 1024; i += 1) lines.push(`Freedom large message, line ${i}: the panel shows every line.`);
    const text = lines.join('\n');
    const hex = `0x${Buffer.from(text, 'utf8').toString('hex')}`;
    after = await reportCount(electronApp, windowId);
    await ask('large', 'personal_sign', [hex, account]);
    await nextReport(electronApp, windowId, after);
    await expect(docPage.locator('#heading')).toHaveText('Unlock Vault');
    await sleep(PAST_DELAY_MS);
    await docPage.fill('input[type="password"]', VAULT_PASSWORD);
    after = await reportCount(electronApp, windowId);
    await docPage.click('#approve');
    const sign = (await nextReport(electronApp, windowId, after)).handle;
    await expect(docPage.locator('#heading')).toHaveText('Sign Message');
    // Shown in full: the cut line, and every character in the scrolling box.
    await expect(docPage.locator('#body')).toContainText('more characters below');
    const full = await docPage.evaluate(() => {
      const box = document.querySelector('#body .field-full');
      return { length: box.textContent.length, head: box.textContent.slice(0, 60), tail: box.textContent.slice(-60) };
    });
    expect(full).toEqual({ length: text.length, head: text.slice(0, 60), tail: text.slice(-60) });
    await expect(docPage.locator('#error')).toBeHidden();
    // The view came in parts, each asked for before the prompt was reported.
    const trace = await approvalsTrace(electronApp);
    const parts = trace.filter((e) => e.kind === 'view-part' && e.handle === sign);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((e) => e.index)).toEqual(parts.map((_e, i) => i));
    const shownAt = trace.findIndex((e) => e.kind === 'shown' && e.handle === sign);
    expect(trace.findIndex((e) => e.kind === 'view-part' && e.handle === sign && e.index === parts.length - 1)).toBeLessThan(shownAt);
    const prompt = trace.find((e) => e.kind === 'prompt' && e.handle === sign);
    expect(prompt).toBeTruthy();
    // The chrome still can't decide it; the panel's approval signs the whole message.
    expect(await win.evaluate((h) => window.pagePrompts.decide(h, true, { alwaysAllow: false }), sign)).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    await docPage.screenshot({ path: test.info().outputPath('approvals-large-view.png') });
    await sleep(PAST_DELAY_MS);
    await docPage.click('#approve');
    await expect.poll(async () => (await answer('large'))?.ok || null, { timeout: 15_000 }).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(verifyMessage(text, (await answer('large')).ok)).toBe(account);
  });
});

// Codex, #1216 round 1: a prompt's view replaced under the same handle
// (`page-prompts.update()`) while the panel reads its parts. As main hands
// out the old view's first part, the new view goes in, and main holds the
// new prompt's message back a moment, as a slow delivery would: the panel's
// next read of the old view reaches main after the new view is in. Main
// gives it nothing (that revision is stale), the panel joins nothing and
// shows nothing of it, then reads the new view and shows it whole.
test('a view replaced under the same handle while the panel reads its parts is never joined across revisions (0011 APS-4)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(180_000);
  await harness.setContentFixture(`${A}/`, testPage('dapp a'));
  const windowId = await chromeWindowId(electronApp);
  const docPage = await approvalsPage(electronApp);
  await electronApp.evaluate(({ webContents }) => {
    const hooks = globalThis.__FREEDOM_TEST_PAGE_REQUESTS__;
    const approvals = globalThis.__FREEDOM_TEST_APPROVALS__;
    // Over 256 KiB of the test kind's JSON (a control character is six
    // bytes there), and A and B the same shape: A's first part joined to
    // B's others would parse and fit the schema.
    const large = (name, code) => {
      const fill = String.fromCharCode(code).repeat(4096);
      return {
        title: `Large ${name}`,
        message: fill,
        rows: Array.from({ length: 16 }, (_v, i) => ({ label: `Row ${i}`, value: fill })),
      };
    };
    const doc = webContents.getAllWebContents().find((contents) => contents.getURL() === approvals.url);
    const send = doc.send.bind(doc);
    const state = { replaced: false, held: 0 };
    globalThis.__APS4_REPLACED__ = state;
    hooks.setRoutes(['swarm:swarm_readChunk']);
    hooks.setDispatch(async (context) => {
      const { tag } = context.params || {};
      approvals.trace.push = function replaceOnFirstPart(entry, ...rest) {
        const out = Array.prototype.push.call(this, entry, ...rest);
        if (!state.replaced && entry?.kind === 'view-part' && entry.index === 0) {
          state.replaced = true;
          delete approvals.trace.push;
          doc.send = (channel, ...args) => {
            if (channel !== 'page:prompt') return send(channel, ...args);
            state.held += 1;
            setTimeout(() => send(channel, ...args), 1500);
            return undefined;
          };
          context.updatePrompt(large('B', 2));
          delete doc.send;
        }
        return out;
      };
      const decision = await context.prompt({ kind: 'test.prompt', view: large('A', 1) });
      if (decision.approve === true) return { result: `approved:${tag}` };
      return { error: { code: 4001, message: decision.closed ? `closed:${decision.closed}` : 'User rejected the request' } };
    });
  });
  const guest = await openTab(electronApp, win, `${A}/`);
  const after = await reportCount(electronApp, windowId);
  await inGuest(electronApp, guest, `window.__ask('large', ${JSON.stringify(view('large'))})`);
  const { handle } = await nextReport(electronApp, windowId, after);
  expect(await electronApp.evaluate(() => globalThis.__APS4_REPLACED__)).toEqual({ replaced: true, held: 1 });

  const trace = (await approvalsTrace(electronApp)).filter((e) => e.handle === handle);
  const prompts = trace.filter((e) => e.kind === 'prompt');
  expect(prompts.length).toBe(2);
  const [a, b] = prompts.map((e) => e.revision);
  expect(b).toBeGreaterThan(a);
  expect(prompts[1].parts).toBeGreaterThan(1);
  // A's read went on after B was in, and got nothing: stale.
  const stale = trace.filter((e) => e.kind === 'view-part-stale');
  expect(stale.length).toBeGreaterThan(0);
  expect(stale.every((e) => e.revision === a)).toBe(true);
  // Every part main gave once B was in is B's, each once, in order; A had
  // its first part only.
  const sinceB = trace.slice(trace.indexOf(prompts[1]));
  const given = sinceB.filter((e) => e.kind === 'view-part');
  expect(given.map((e) => [e.revision, e.index])).toEqual(Array.from({ length: prompts[1].parts }, (_v, i) => [b, i]));
  expect(trace.filter((e) => e.kind === 'view-part' && e.revision === a).map((e) => e.index)).toEqual([0]);
  // Reported shown once, for B, after its last part; nothing of A was.
  expect(trace.filter((e) => e.kind === 'shown').map((e) => e.revision)).toEqual([b]);
  expect(sinceB.findIndex((e) => e.kind === 'shown')).toBeGreaterThan(sinceB.indexOf(given.at(-1)));

  // The panel shows B, whole: its title and every row, nothing of A.
  const escapeOf = (code) => `${String.fromCharCode(92)}u{${code.toString(16).toUpperCase().padStart(4, '0')}}`;
  const shown = await docPage.evaluate(() => document.querySelector('#body').textContent);
  expect(shown).toContain('Large B');
  expect(shown).not.toContain('Large A');
  expect(shown).toContain(escapeOf(2));
  expect(shown).not.toContain(escapeOf(1));
  await expect(docPage.locator('#error')).toBeHidden();
  await expect(docPage.locator('#approve')).toBeVisible();

  // Straight from the document: a read of A now gets no part; B's does.
  const read = (revision, index) =>
    docPage.evaluate(([h, r, i]) => window.approvals.viewPart(h, r, i), [handle, revision, index]);
  expect(await read(a, 1)).toEqual({ ok: false, reason: 'stale' });
  const partOfB = await read(b, 1);
  expect(partOfB.ok).toBe(true);
  const jsonEscape = (code) => `${String.fromCharCode(92)}u000${code}`;
  expect(partOfB.part).toContain(jsonEscape(2));
  expect(partOfB.part).not.toContain(jsonEscape(1));

  // B's approval stands.
  await sleep(PAST_DELAY_MS);
  await docPage.click('#approve');
  await expect.poll(() => outcome(electronApp, guest, 'large')).toEqual({ ok: 'approved:large' });
});

// --- Hostile data, in every field a page chooses, for every dApp kind ---------

const cp = (code) => String.fromCodePoint(code);
const HOSTILE = [
  '<script>window.__xss=1</script>',
  '<img src=x onerror="window.__xss=1">',
  '<svg onload="window.__xss=1">',
  'javascript:alert(1)',
  'data:text/html,<b>x</b>',
  '</style><style>*{display:none}</style>',
  `rev${cp(0x202e)}erse ${cp(0x2066)}iso${cp(0x2069)} zero${cp(0x200b)}width`,
].join(' ');
const hexOf = (text) => `0x${Buffer.from(text, 'utf8').toString('hex')}`;
const ADDR = '0x1111111111111111111111111111111111111111';
const ACCOUNT = { index: 0, name: 'Main Wallet', address: ADDR, type: 'mnemonic' };
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const IDENTITY = { id: 'app-scoped:3', mode: 'app-scoped', label: 'App identity 3', owner: ADDR, shared: false, stored: false, unavailable: false };
const HOSTILE_PROMPTS = [
  ['eth.connect', { accounts: [ACCOUNT], defaultIndex: 0, chain: { id: 100, name: 'Gnosis Chain' } }],
  ['eth.sign', { method: 'personal_sign', account: ACCOUNT, chain: { id: 100, name: 'Gnosis Chain' }, message: { hex: hexOf(HOSTILE), rawHash: false } }],
  [
    'eth.sign',
    {
      method: 'eth_signTypedData_v4',
      account: ACCOUNT,
      chain: { id: 100, name: 'Gnosis Chain' },
      typedData: {
        hash: `0x${'b'.repeat(64)}`,
        view: {
          types: { EIP712Domain: [{ name: 'name', type: 'string' }], Mail: [{ name: 'contents', type: 'string' }] },
          domain: { name: HOSTILE },
          primary_type: 'Mail',
          message: { contents: HOSTILE.repeat(4) },
          ignored: [HOSTILE.slice(0, 200)],
          named_type: 'match',
          chain: 'absent',
        },
        warnings: ['chain-absent'],
      },
      chains: {},
    },
  ],
  [
    'eth.send',
    {
      account: ACCOUNT,
      chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
      tx: { to: ADDR, value: '0', data: hexOf(HOSTILE) },
      fee: null,
      feeCheck: null,
      feeAskAgain: false,
      alwaysAllow: true,
    },
  ],
  ['vault.unlock', { reason: 'feeds' }],
  ['swarm.connect', {}],
  ['swarm.publish', { method: 'swarm_publishFiles', kind: 'files', count: 4, size: 10, paths: [HOSTILE.slice(0, 100), HOSTILE.slice(100, 200), 'x'] }],
  ['swarm.publish', { method: 'swarm_publishData', kind: 'data', size: 10, contentType: HOSTILE.slice(0, 256), name: HOSTILE.slice(0, 256) }],
  ['swarm.messaging', { method: 'swarm_sendPss', grantMode: false, topic: HOSTILE.slice(0, 256), size: 5 }],
  ['swarm.feed', { method: 'swarm_updateFeed', mode: 'feeds', name: HOSTILE.slice(0, 64), identities: [], newIdentity: IDENTITY, activeIdentityId: IDENTITY.id }],
  [
    'swarm.manifest',
    {
      model: {
        origin: A,
        name: HOSTILE.slice(0, 32),
        description: HOSTILE.slice(0, 160),
        changed: [{ key: 'publish', label: 'Publish', detail: 'Publish through your node', why: HOSTILE.slice(0, 140) }],
        removed: [],
        createsIdentity: false,
        preservedIdentity: false,
        isUpdate: false,
      },
    },
  ],
  ['radicle.connect', {}],
  ['radicle.node', { method: 'radicle_seed', rid: RID }],
  ['radicle.sign', { mode: 'grant', method: 'radicle_getIdentity' }],
  [
    'radicle.sign',
    {
      mode: 'write',
      method: 'radicle_createIssue',
      rid: RID,
      title: HOSTILE.slice(0, 200),
      description: HOSTILE.repeat(10),
      labels: [HOSTILE.slice(0, 100)],
      agentHeld: false,
      alwaysAllow: false,
    },
  ],
];

async function routeKindPrompts(electronApp) {
  await electronApp.evaluate(() => {
    const hooks = globalThis.__FREEDOM_TEST_PAGE_REQUESTS__;
    hooks.setRoutes(['swarm:swarm_readChunk']);
    hooks.setDispatch(async (context) => {
      const { kind, view: shown } = context.params || {};
      const decision = await context.prompt({ kind, view: shown });
      return decision.approve === true ? { result: 'approved' } : { error: { code: 4001, message: 'User rejected the request' } };
    });
  });
}

test('every dApp kind shows a page\'s hostile data as literal text, runs nothing and loads nothing (0011 APS-2)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(240_000);
  await harness.setContentFixture(`${A}/`, testPage('dapp'));
  await routeKindPrompts(electronApp);
  const windowId = await chromeWindowId(electronApp);
  const docPage = await approvalsPage(electronApp);
  const guest = await openTab(electronApp, win, `${A}/`);
  const requestsSeen = async () => (await approvalsTrace(electronApp)).filter((e) => e.kind === 'request' || e.kind === 'request-refused').length;
  const requestsBefore = await requestsSeen();
  const BACKSLASH = String.fromCharCode(92);

  let n = 0;
  for (const [kind, shown] of HOSTILE_PROMPTS) {
    n += 1;
    const tag = `k${n}`;
    const after = await reportCount(electronApp, windowId);
    await inGuest(
      electronApp,
      guest,
      `window.swarm.request({ method: 'swarm_readChunk', params: ${JSON.stringify({ kind, view: shown })} }).then((ok) => { window.__asked[${JSON.stringify(tag)}] = { ok }; }, (e) => { window.__asked[${JSON.stringify(tag)}] = { code: e.code }; }); true`
    );
    await nextReport(electronApp, windowId, after);
    // It fits its kind's schema: no error, and Approve is offered.
    await expect(docPage.locator('#error'), kind).toBeHidden();
    await expect(docPage.locator('#approve'), kind).toBeVisible();
    const seen = await docPage.evaluate(() => ({
      text: document.getElementById('body').textContent,
      elements: [...document.querySelectorAll('#panel *')].map((el) => el.tagName.toLowerCase()),
      xss: window.__xss,
    }));
    // Nothing a value names became an element, and nothing ran.
    for (const tag of ['script', 'img', 'svg', 'style', 'a', 'iframe', 'object', 'form']) {
      expect(seen.elements, `${kind}: <${tag}>`).not.toContain(tag);
    }
    expect(seen.xss, kind).toBeUndefined();
    // The markup is there as text, and the bidi controls as escapes.
    const raw = JSON.stringify(shown);
    if (raw.includes('<script>') || kind === 'eth.sign') expect(seen.text, kind).toContain('<script>window.__xss=1</script>');
    if (raw.includes('<img') || (kind === 'eth.sign' && raw.includes('personal_sign'))) {
      expect(seen.text, kind).toContain('<img src=x onerror=');
    }
    expect(seen.text, kind).not.toContain(cp(0x202e));
    expect(seen.text, kind).not.toContain(cp(0x200b));
    if (raw.includes(cp(0x202e)) || (kind === 'eth.sign' && raw.includes('personal_sign'))) {
      expect(seen.text, kind).toContain(`${BACKSLASH}u{202E}`);
    }
    await sleep(PAST_DELAY_MS);
    await docPage.click('#reject');
    await expect.poll(() => inGuest(electronApp, guest, `window.__asked[${JSON.stringify(tag)}] || null`), { message: kind }).toEqual({ code: 4001 });
  }
  // The partition saw no request while any of them showed.
  expect(await requestsSeen()).toBe(requestsBefore);

  // A view off its kind's schema: the fixed error, and only Reject.
  const after = await reportCount(electronApp, windowId);
  await inGuest(
    electronApp,
    guest,
    `window.swarm.request({ method: 'swarm_readChunk', params: ${JSON.stringify({ kind: 'radicle.node', view: { method: 'radicle_seed', rid: '<img src=x onerror=alert(1)>' } })} }).then((ok) => { window.__asked.off = { ok }; }, (e) => { window.__asked.off = { code: e.code }; }); true`
  );
  await nextReport(electronApp, windowId, after);
  await expect(docPage.locator('#error')).toBeVisible();
  await expect(docPage.locator('#approve')).toBeHidden();
  await expect(docPage.locator('#body')).toHaveText('');
  await sleep(PAST_DELAY_MS);
  await docPage.click('#reject');
  await expect.poll(() => inGuest(electronApp, guest, 'window.__asked.off || null')).toEqual({ code: 4001 });
});
