// window.swarm.openAct (#648), driven from a real page call in real Electron:
// the page's request goes through the chrome's ACT prompt to main, and main
// asks a fake Ant (a loopback HTTP server standing in for the node) with the
// ACT headers. What this pins beyond the unit suites: the prompt really opens
// for a page call and names the publisher; "always allow" covers that one
// publisher on later calls and no other; Reject is 4001 with no node request;
// and the rule shows, and can be removed, on the site's Swarm permissions
// screen.

const fs = require('fs');
const path = require('path');
const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');
const { evalInWebview } = require('./permission-fixtures');
const { startFakeHttpNode } = require('../test/helpers/fake-http-node');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const identity = require(path.join(MAIN, 'identity'));

const ORIGIN = `bzz://${SAMPLE_BZZ_HASH}`;
const PAGE = `${ORIGIN}/`;
const REFERENCE = 'aa'.repeat(32);
const HISTORY = 'bb'.repeat(32);
const CONTENT = 'a letter shared through ACT';

// Real secp256k1 points, so main's normaliser accepts them.
const { SigningKey } = require('ethers');
const PUB_A = SigningKey.computePublicKey(`0x${'11'.repeat(32)}`, true).slice(2);
const PUB_B = SigningKey.computePublicKey(`0x${'22'.repeat(32)}`, true).slice(2);

test.describe('swarm_openAct', () => {
  test.use({
    seedSettings: {
      enableIdentityWallet: true,
      startAntAtLaunch: false,
      startIpfsAtLaunch: false,
      startRadicleAtLaunch: false,
    },
  });

  let node;

  test.beforeEach(async ({ userDataDir }) => {
    // A vault on disk, so the app boots past onboarding.
    const identityDir = path.join(userDataDir, 'identity');
    fs.mkdirSync(identityDir, { recursive: true });
    const mnemonic = await identity.createVault(identityDir, 'swarm-open-act-e2e');
    const keys = identity.deriveAllKeys(mnemonic);
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({ addresses: { userWallet: keys.userWallet.address }, activeWalletIndex: 0 }),
      'utf-8'
    );

    // The node holds a grantee entry for this browser under PUB_A only.
    node = await startFakeHttpNode({
      prelude: (req, res) => {
        if (req.url !== '/node') return false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return true;
      },
      handler: (req, res) => {
        if (req.headers['swarm-act-publisher'] === PUB_A && req.headers['swarm-act-history-address'] === HISTORY) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(CONTENT);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'act or history entry not found' }));
      },
    });
  });

  test.afterEach(async () => {
    await node?.close();
  });

  // Start an openAct call in the page; its outcome lands in window.__act[n].
  function startOpen(window, n, publisher) {
    const params = JSON.stringify({ reference: REFERENCE, publisher, historyAddress: HISTORY });
    return evalInWebview(
      window,
      `(window.__act ||= {}, window.swarm.openAct(${params}).then(
         (r) => { window.__act[${n}] = { data: atob(r.data), contentType: r.contentType }; },
         (e) => { window.__act[${n}] = { code: e.code, reason: e.data?.reason ?? null }; }
       ), true)`
    );
  }

  const outcome = (window, n) =>
    evalInWebview(window, `JSON.stringify(window.__act?.[${n}] ?? null)`).then((v) => JSON.parse(v));

  // Prompts ignore clicks for their first 500 ms (prompt-queue.js).
  async function clickWhenArmed(window, selector) {
    await expect(window.locator(selector)).toBeEnabled();
    await window.locator(selector).click();
  }

  test('asks per publisher, remembers "always allow" for that one, and lists it for removal', async ({
    electronApp,
    window,
    harness,
  }) => {
    test.setTimeout(90_000);
    await electronApp.evaluate(({ ipcMain }, { main, api }) => {
      // Point the node registry at the fake Ant.
      process.mainModule.require(`${main}/service-registry`).updateService('ant', { api, gateway: api });
      // The manifest lookup needs a node of its own; report "no manifest".
      ipcMain.removeHandler('swarm:manifest-check');
      ipcMain.handle('swarm:manifest-check', () => ({ kind: 'legacy', reason: 'e2e' }));
    }, { main: MAIN, api: node.origin });

    await harness.setContentFixture(PAGE, { body: '<!doctype html><title>Inbox</title><h1>Inbox</h1>' });
    await window.evaluate((origin) => window.swarmPermissions.grantPermission(origin), ORIGIN);
    const input = window.locator('[data-test="address-input"]');
    await input.click();
    await input.fill(PAGE);
    await input.press('Enter');
    await expect
      .poll(() => evalInWebview(window, 'window.swarm?.isFreedomBrowser === true'), { timeout: 15_000 })
      .toBe(true);

    // First call: the prompt names the site and the publisher.
    await startOpen(window, 1, `0x${PUB_A.toUpperCase()}`);
    const prompt = window.locator('#sidebar-swarm-act-approve');
    await expect(prompt).toBeVisible();
    await expect(window.locator('#swarm-act-site')).toHaveText(ORIGIN);
    await expect(window.locator('#swarm-act-publisher')).toHaveText(PUB_A);
    await expect(window.locator('#swarm-act-publisher-address')).toHaveText(/^0x[0-9a-fA-F]{40}$/);

    await window.locator('#swarm-act-auto-approve').check();
    await clickWhenArmed(window, '#swarm-act-confirm');
    await expect.poll(() => outcome(window, 1)).toEqual({ data: CONTENT, contentType: 'text/plain' });
    expect(node.requests).toHaveLength(1);
    expect(node.requests[0].url).toBe(`/bytes/${REFERENCE}`);
    expect(node.requests[0].headers['swarm-act-publisher']).toBe(PUB_A);

    // Second call from the same publisher: the rule answers, no prompt.
    await startOpen(window, 2, PUB_A);
    await expect.poll(() => outcome(window, 2)).toEqual({ data: CONTENT, contentType: 'text/plain' });
    await expect(prompt).toBeHidden();
    expect(node.requests).toHaveLength(2);

    // Another publisher is asked about; Reject is 4001 and the node is not asked.
    await startOpen(window, 3, PUB_B);
    await expect(prompt).toBeVisible();
    await expect(window.locator('#swarm-act-publisher')).toHaveText(PUB_B);
    await expect(window.locator('#swarm-act-auto-approve')).not.toBeChecked();
    await clickWhenArmed(window, '#swarm-act-reject');
    await expect.poll(() => outcome(window, 3)).toEqual({ code: 4001, reason: null });
    expect(node.requests).toHaveLength(2);

    // The site's Swarm permissions list the rule, with a Remove. The screen
    // asks for the vault first (it shows the publisher identity too).
    const unlock = await window.evaluate((pw) => window.identity.unlock(pw), 'swarm-open-act-e2e');
    expect(unlock?.success ?? unlock).toBeTruthy();
    await window.evaluate(async (origin) => {
      const pm = await import('./lib/wallet/permission-manage.js');
      await pm.showSwarmPermissions(origin);
    }, ORIGIN);
    const rules = window.locator('#swarm-perms-act-list');
    await expect(rules.locator('.perms-act-key')).toHaveText([PUB_A]);
    await rules.locator('.perms-tx-remove').click();
    await expect(rules).toHaveText('No publishers allowed without asking');

    // With the rule gone, the publisher is asked about again.
    await window.locator('#swarm-perms-back').click();
    await startOpen(window, 4, PUB_A);
    await expect(prompt).toBeVisible();
    await clickWhenArmed(window, '#swarm-act-reject');
    await expect.poll(() => outcome(window, 4)).toEqual({ code: 4001, reason: null });
  });
});
