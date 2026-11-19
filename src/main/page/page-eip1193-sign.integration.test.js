/**
 * Page signatures through the real freedom-cored's eip1193.request (freedom-core
 * design 0012, APB-4b): `personal_sign` and `eth_signTypedData_v4` go to the
 * core, which shows its `eth.sign` prompt through main (page-eip1193.js) and
 * signs a vault account's itself, answers a site's rule with no prompt (a
 * locked vault's `vault.unlock` first), and gives a Ledger's, a phone's or a
 * Safe's back as `{ device }`, which main spends (page-devices.js). Here a
 * Ledger is a stand-in device that spends the core's token through the real
 * core first (`approval.spend`), a phone's job is the real core's
 * (`phone.job`), and a Safe's message spends its token for the real core's
 * Safe approval. A test seam on the core client's handlers crosses main's
 * answers: each is refused, with nothing signed.
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/page/page-eip1193-sign.integration
 * or FREEDOM_CORED_APPROVALS_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { HDNodeWallet, Wallet, getBytes, verifyMessage, verifyTypedData } = require('ethers');

const required = process.env.FREEDOM_CORED_APPROVALS_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH || (required ? require('../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_APPROVALS_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VAULT_ACCOUNT = HDNodeWallet.fromPhrase(ABANDON, undefined, "m/44'/60'/0'/0/0").address;
// A device's key: what the Ledger and the phone stand-ins sign with.
const DEVICE = new Wallet('0x' + '42'.repeat(32));
const LEDGER_INDEX = 1000000;
const PHONE_INDEX = 1000001;
const SAFE_INDEX = 5000;
const SAFE_ADDRESS = '0x' + 'aa'.repeat(20);
const PHONE_CHROME = 7;
const CHROME_URL = 'file:///app/src/renderer/index.html';
const MESSAGE = '0x48656c6c6f2c2046726565646f6d'; // "Hello, Freedom"
const TYPED = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    Mail: [{ name: 'contents', type: 'string' }],
  },
  domain: { name: 'Freedom Signing Fixture', chainId: 100 },
  primaryType: 'Mail',
  message: { contents: 'Signed through the core' },
};
const MAIL_TYPES = { Mail: TYPED.types.Mail };
const NO_ADDRESS = { code: 4100, message: 'This page has no address to connect from yet' };
const REJECTED = { code: 4001, message: 'User rejected the request' };
const UNLOCK_CANCELLED = { code: 4001, message: 'User cancelled unlock' };
const PENDING = { code: -32002, message: 'Another wallet request is already pending' };
const key = (c) => `bzz://${c.repeat(64)}`;

let nextGuest = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextGuest++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.events = [];
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return {
      url,
      frameTreeNodeId: 1000 + this.id,
      processId: 1,
      routingId: this.id,
      detached: false,
      send: (_channel, message) => this.events.push([message.event, message.data]),
    };
  }

  isDestroyed() {
    return this.destroyed;
  }

  getType() {
    return 'webview';
  }

  getURL() {
    return this.mainFrame.url;
  }

  commit(url) {
    this.mainFrame.detached = true;
    this.mainFrame = this.frame(url);
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
  }
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });
const parsed = (typedData) => (typeof typedData === 'string' ? JSON.parse(typedData) : typedData);
const typesOf = (typedData) => {
  const { EIP712Domain: _domain, ...types } = parsed(typedData).types;
  return types;
};
// A phone wallet's JSON-RPC answer to the core's relayed request.
function phoneAnswer({ method, params }) {
  if (method === 'personal_sign') return DEVICE.signMessage(getBytes(params[0]));
  const view = JSON.parse(params[1]);
  return DEVICE.signTypedData(view.domain, typesOf(view), view.message);
}

describeIfBinary('page signatures through the real freedom-cored\'s eip1193.request (0012 APB-4b)', () => {
  let root;
  let core;
  let sc;
  let vaultBackend;
  let env;
  // Test seams on main's handlers for the core's requests: `before(method,
  // params)` runs first, `cross(method, params, answer)` may change main's
  // answer.
  const seams = { before: null, cross: null };
  // What the device stand-ins did: each spend main presented (its token
  // left out), each device signature, each Safe session started.
  const devices = { spends: [], signed: [], safes: [], alter: null };
  const wallets = [
    { index: 0, name: 'Main Wallet', address: VAULT_ACCOUNT, type: 'mnemonic' },
    { index: LEDGER_INDEX, name: 'Ledger', address: DEVICE.address, type: 'ledger' },
    { index: PHONE_INDEX, name: 'Phone', address: DEVICE.address, type: 'remote' },
    // A Safe serves a dApp once it is deployed on Gnosis.
    { index: SAFE_INDEX, name: 'Safe', address: SAFE_ADDRESS, type: 'safe', deployed: { 100: true } },
  ];

  const grants = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'dapp-permissions.json'), 'utf8'));
    } catch {
      return {};
    }
  };
  const withoutToken = ({ token, ...rest }) => (expect(typeof token).toBe('string'), rest);

  // A Ledger stand-in: the core's token spent through the core first, with
  // the payload main presents, and the device asked only after.
  const ledger = (confirmation) => {
    const spend = async () => {
      devices.spends.push(withoutToken(confirmation));
      await sc.spendConfirmation(devices.alter ? devices.alter(confirmation) : confirmation);
    };
    return {
      signMessage: async (message) => {
        await spend();
        devices.signed.push('message');
        return DEVICE.signMessage(getBytes(message));
      },
      signTypedData: async (typedData, { expectedHash }) => {
        const data = parsed(typedData);
        const hash = require('ethers').TypedDataEncoder.hash(data.domain, typesOf(data), data.message);
        if (hash !== expectedHash) throw new Error('The typed data changed after it was confirmed');
        await spend();
        devices.signed.push('typed');
        return DEVICE.signTypedData(data.domain, typesOf(data), data.message);
      },
    };
  };
  // A phone: the core's job, opened with the token, its answer checked by
  // the core.
  const phone = (confirmation) => {
    const job = async (method, payload) => {
      devices.spends.push(withoutToken(confirmation));
      const { authorization, page } = sc.signingAuthorization(confirmation);
      const opened = await vaultBackend.phone.job(
        { account: confirmation.account, address: DEVICE.address, method, payload, target: PHONE_CHROME, authorization },
        page
      );
      await vaultBackend.phone.sent({ job: opened.job, sender: PHONE_CHROME });
      const result = await phoneAnswer(opened.request);
      devices.signed.push(method);
      return (await vaultBackend.phone.result({ job: opened.job, sender: PHONE_CHROME, result })).signature;
    };
    return {
      signMessage: () => job('message', confirmation.payload),
      signTypedData: (_typedData, { expectedHash }) => job('typed_data', { ...confirmation.payload, expected_hash: expectedHash }),
    };
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eip1193-sign-'));
    jest.resetModules();
    const { CoreClient } = require('../core/core-client');
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    sc = require('../wallet/signing-confirmation');
    ({ vaultBackend } = require('../core/vault-backend'));
    const { createEip1193Relay } = require('./page-eip1193');
    const relay = createEip1193Relay({
      coreClient: () => core,
      identityWalletEnabled: () => true,
      selectedChainOf: () => 100,
      getDerivedWallets: async () => wallets,
      networks: () => ({ 1: { name: 'Ethereum', nativeSymbol: 'ETH' }, 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } }),
      isChainAvailable: (chainId) => [1, 100].includes(Number(chainId)),
      getActiveWalletIndex: () => 0,
      rulePaused: async () => false,
      selectChainForPage: () => {},
      isVaultUnlocked: async () => (await vaultBackend.status()).unlocked === true,
      discardToken: (token) => sc.discardConfirmation(token),
    });
    relay.attach({
      handle: (method, handler) =>
        core.handle(method, async (params, options) => {
          await seams.before?.(method, params);
          const answer = await handler(params, options);
          return seams.cross ? seams.cross(method, params, answer) : answer;
        }),
    });
    env = { relay };
    await core.start();
    await vaultBackend.importVault('testpass1', ABANDON);
  });

  afterAll(async () => {
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    seams.before = null;
    seams.cross = null;
    Object.assign(devices, { spends: [], signed: [], safes: [], alter: null });
    if (!(await vaultBackend.status()).unlocked) await vaultBackend.unlock('testpass1');
    const { createPageDocuments } = require('./page-documents');
    const { createPageRequests } = require('./page-requests');
    const { createEthereumDispatchers } = require('./page-ethereum');
    const guests = new Map();
    const documents = createPageDocuments({
      isPrivateWebContents: () => false,
      isChromeIndexUrl: (url) => url === CHROME_URL,
      isAgentPage: () => false,
      windowIdOf: (contents) => contents.window,
      resolveEnsContent: async () => ({ type: 'not_found' }),
    });
    const sent = [];
    const requests = createPageRequests({
      documents,
      webContentsFromId: (id) => guests.get(id),
      dispatchers: createEthereumDispatchers({
        relay: env.relay,
        identityWalletEnabled: () => true,
        permissionsLoaded: async () => {},
        agentWalletRequest: async () => ({ handled: false }),
        signing: { inCustody: () => false },
        deviceDeps: {
          walletList: async () => wallets,
          getSigner: (index, { confirmation }) => (index === LEDGER_INDEX ? ledger(confirmation) : phone(confirmation)),
          // A Safe's token, spent for the core's Safe approval.
          spendSafe: (confirmation) => {
            devices.spends.push(withoutToken(confirmation));
            return sc.spendSafeConfirmation(confirmation);
          },
          discardToken: (token) => sc.discardConfirmation(token),
          startSafeMessage: async (options) => {
            devices.safes.push(options);
            return { complete: true, token: 'session' };
          },
          completeSafeMessage: async () => ({ signature: '0x' + 'ab'.repeat(65) }),
          cancelSafeMessage: async () => {},
          safeBoards: () => null,
        },
      }),
      setTimer: () => ({}),
      clearTimer: () => {},
      chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
      sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
      watchWindow: () => {},
      isAgentGuest: () => false,
    });
    const tab = (url) => {
      const guest = new Guest({ window: 1 });
      guests.set(guest.id, guest);
      requests.track(guest);
      guest.commit(url);
      const n = nonce();
      expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
      requests.foreground({ sender: { id: 501 } }, { guest: guest.id });
      return {
        guest,
        ask: (method, params = []) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
      };
    };
    const prompts = () => sent.filter(([w, c]) => w === 1 && c === 'page:prompt').map(([, , p]) => p);
    const decide = (handle, approve, choices) => requests.decide({ sender: { id: 501 } }, { handle, approve, choices });
    // A page's request, and the prompt main shows for it, once it is up.
    const asking = (page, method, params) => {
      const seen = prompts().length;
      const answer = page.ask(method, params);
      return {
        answer,
        prompt: async () => {
          await until(() => prompts().length > seen);
          return prompts()[seen];
        },
      };
    };
    // A connected page: the core's grant for `walletIndex`.
    const connected = async (url, walletIndex) => {
      const page = tab(url);
      const seen = prompts().length;
      const asked = page.ask('eth_requestAccounts');
      await until(() => prompts().length > seen);
      expect(await decide(prompts()[seen].handle, true, { walletIndex })).toEqual({ ok: true });
      expect((await asked).result).toHaveLength(1);
      return page;
    };
    Object.assign(env, { requests, tab, prompts, decide, asking, connected, sent });
  });

  test('a vault account\'s signature: main\'s prompt from the core\'s view, the core\'s signature, and "Always allow" the core\'s rule, which answers the next with no prompt', async () => {
    const site = key('a');
    const page = await env.connected(`${site}/app`, 0);
    const message = env.asking(page, 'personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    const shown = await message.prompt();
    expect(shown).toMatchObject({
      kind: 'eth.sign',
      site: { key: site },
      view: {
        method: 'personal_sign',
        account: { index: 0, name: 'Main Wallet', address: VAULT_ACCOUNT, type: 'mnemonic' },
        chain: { id: 100, name: 'Gnosis Chain' },
        message: { hex: MESSAGE, rawHash: false },
        alwaysAllow: true,
      },
    });
    expect(await env.decide(shown.handle, true, { alwaysAllow: false })).toEqual({ ok: true });
    expect(verifyMessage('Hello, Freedom', (await message.answer).result)).toBe(VAULT_ACCOUNT);
    expect(grants()[site].autoApprove?.limited?.signing).toBeUndefined();

    const typed = env.asking(page, 'eth_signTypedData_v4', [VAULT_ACCOUNT, JSON.stringify(TYPED)]);
    const typedShown = await typed.prompt();
    expect(typedShown.view).toMatchObject({ method: 'eth_signTypedData_v4', typedData: { warnings: [] }, alwaysAllow: true });
    expect(await env.decide(typedShown.handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    expect(verifyTypedData(TYPED.domain, MAIL_TYPES, TYPED.message, (await typed.answer).result)).toBe(VAULT_ACCOUNT);
    expect(grants()[site].autoApprove.limited.signing.grantedAt).toBeGreaterThan(0);

    // The rule answers: no prompt, and the core's signature.
    const prompted = env.prompts().length;
    expect(verifyMessage('Hello, Freedom', (await page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT])).result)).toBe(VAULT_ACCOUNT);
    expect(env.prompts()).toHaveLength(prompted);
    expect(devices.spends).toEqual([]);
  });

  test('a rule\'s signature with the vault locked: main\'s unlock prompt, whose rejection, close and busy sign nothing; an approve with the vault still locked gets the core\'s "Vault is locked"', async () => {
    const site = key('b');
    const page = await env.connected(`${site}/app`, 0);
    const ruled = env.asking(page, 'personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    expect(await env.decide((await ruled.prompt()).handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    expect((await ruled.answer).result).toMatch(/^0x/);

    await vaultBackend.lock();
    const rejected = env.asking(page, 'personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    const unlock = await rejected.prompt();
    expect(unlock).toMatchObject({
      kind: 'vault.unlock',
      view: { account: { index: 0, address: VAULT_ACCOUNT, type: 'mnemonic' }, reason: 'sign' },
    });
    expect(await env.decide(unlock.handle, false)).toEqual({ ok: true });
    expect(await rejected.answer).toEqual({ error: UNLOCK_CANCELLED });

    // Approved, but the vault is still locked: main passes the approve on,
    // and the core refuses the signature as the reference did.
    const stillLocked = env.asking(page, 'personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    expect(await env.decide((await stillLocked.prompt()).handle, true, {})).toEqual({ ok: true });
    expect(await stillLocked.answer).toEqual({ error: { code: -32603, message: 'Vault is locked' } });

    // Two from one document: the second's unlock is up first, and the core
    // hears busy for the first, which gets -32002.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    seams.before = async (method) => {
      if (method === 'approval.request' && calls++ === 0) await held;
    };
    const prompted = env.prompts().length;
    const first = page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    await until(() => calls === 1);
    const second = env.asking(page, 'personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    const secondUnlock = await second.prompt();
    release();
    expect(await first).toEqual({ error: PENDING });
    expect(env.prompts()).toHaveLength(prompted + 1);

    // An approve once the vault is open signs.
    await vaultBackend.unlock('testpass1');
    expect(await env.decide(secondUnlock.handle, true, {})).toEqual({ ok: true });
    expect(verifyMessage('Hello, Freedom', (await second.answer).result)).toBe(VAULT_ACCOUNT);

    // A navigation closes the unlock: the page is gone, nothing signed.
    await vaultBackend.lock();
    const closing = env.asking(page, 'personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    await closing.prompt();
    page.guest.commit(`${site}/next`);
    expect(await closing.answer).toEqual({ gone: true });
  });

  test('a crossed eth.sign answer signs nothing: another prompt\'s id, or "Always allow" on a device\'s prompt', async () => {
    const page = await env.connected(`${key('c')}/app`, 0);
    seams.cross = (method, params, answer) =>
      method === 'approval.request' && answer.approve ? { ...answer, prompt: 'f'.repeat(32) } : answer;
    const crossed = env.asking(page, 'personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    expect(await env.decide((await crossed.prompt()).handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    expect((await crossed.answer).error.code).toBe(-32603);
    expect(grants()[key('c')].autoApprove?.limited?.signing).toBeUndefined();

    seams.cross = null;
    const device = await env.connected(`${key('d')}/app`, LEDGER_INDEX);
    seams.cross = (method, params, answer) =>
      method === 'approval.request' && answer.approve ? { ...answer, choices: { alwaysAllow: true } } : answer;
    const ticked = env.asking(device, 'personal_sign', [MESSAGE, DEVICE.address]);
    expect(await env.decide((await ticked.prompt()).handle, true, { alwaysAllow: false })).toEqual({ ok: true });
    expect((await ticked.answer).error.code).toBe(-32603);
    expect(devices.spends).toEqual([]);
    expect(devices.signed).toEqual([]);
  });

  test('a Ledger\'s signature: no "Always allow" offered and a ticked one refused, then the core\'s { device } spent through the core with its payload before the device signs', async () => {
    const site = key('e');
    const page = await env.connected(`${site}/app`, LEDGER_INDEX);
    const message = env.asking(page, 'personal_sign', [MESSAGE, DEVICE.address]);
    const shown = await message.prompt();
    expect(shown.view).toMatchObject({ account: { index: LEDGER_INDEX, type: 'ledger' }, alwaysAllow: false });
    expect(await env.decide(shown.handle, true, { alwaysAllow: true })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(shown.handle, true, { alwaysAllow: false })).toEqual({ ok: true });
    expect(verifyMessage('Hello, Freedom', (await message.answer).result)).toBe(DEVICE.address);
    const page0 = { origin: site, top_origin: site, frame: expect.any(Number), navigation: expect.any(Number), agent: false };
    expect(devices.spends).toEqual([
      { kind: 'sign-message', account: LEDGER_INDEX, payload: { message: MESSAGE }, handle: shown.handle, page: page0 },
    ]);

    const typed = env.asking(page, 'eth_signTypedData_v4', [DEVICE.address, JSON.stringify(TYPED)]);
    const typedShown = await typed.prompt();
    expect(await env.decide(typedShown.handle, true, {})).toEqual({ ok: true });
    expect(verifyTypedData(TYPED.domain, MAIL_TYPES, TYPED.message, (await typed.answer).result)).toBe(DEVICE.address);
    expect(devices.spends[1]).toMatchObject({ kind: 'sign-typed-data', account: LEDGER_INDEX, handle: typedShown.handle });
    expect(devices.spends[1].payload.typed_data).toMatchObject({ domain: TYPED.domain, message: TYPED.message });

    // The spend binds the request's payload: another one is refused by the
    // core, and the device never asked.
    devices.alter = (confirmation) => ({ ...confirmation, payload: { message: '0x00' } });
    const altered = env.asking(page, 'personal_sign', [MESSAGE, DEVICE.address]);
    expect(await env.decide((await altered.prompt()).handle, true, {})).toEqual({ ok: true });
    const refused = await altered.answer;
    expect(refused.error.code).toBe(-32603);
    expect(devices.signed).toEqual(['message', 'typed']);
    // No rule: the core never writes one for a device's account.
    expect(grants()[site].autoApprove?.limited?.signing).toBeUndefined();
  });

  test('a phone\'s signature: the core\'s job opened with the token, the phone\'s answer checked by the core', async () => {
    const page = await env.connected(`${key('f')}/app`, PHONE_INDEX);
    const message = env.asking(page, 'personal_sign', [MESSAGE, DEVICE.address]);
    const shown = await message.prompt();
    expect(shown.view).toMatchObject({ account: { index: PHONE_INDEX, type: 'remote' }, alwaysAllow: false });
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    expect(verifyMessage('Hello, Freedom', (await message.answer).result)).toBe(DEVICE.address);
    const typed = env.asking(page, 'eth_signTypedData_v4', [DEVICE.address, TYPED]);
    expect(await env.decide((await typed.prompt()).handle, true, {})).toEqual({ ok: true });
    expect(verifyTypedData(TYPED.domain, MAIL_TYPES, TYPED.message, (await typed.answer).result)).toBe(DEVICE.address);
    expect(devices.signed).toEqual(['message', 'typed_data']);
    expect(devices.spends.map((spend) => [spend.kind, spend.account, spend.handle])).toEqual([
      ['sign-message', PHONE_INDEX, shown.handle],
      ['sign-typed-data', PHONE_INDEX, expect.stringMatching(/^[0-9a-f]{64}$/)],
    ]);
  });

  test('a Safe\'s message: its token spent for the core\'s Safe approval, and the session started with the core\'s payload', async () => {
    const site = key('9');
    const page = await env.connected(`${site}/app`, SAFE_INDEX);
    const message = env.asking(page, 'personal_sign', [MESSAGE, SAFE_ADDRESS]);
    const shown = await message.prompt();
    expect(shown.view).toMatchObject({ account: { index: SAFE_INDEX, type: 'safe' }, alwaysAllow: false });
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    expect(await message.answer).toEqual({ result: '0x' + 'ab'.repeat(65) });
    expect(devices.spends).toEqual([
      {
        kind: 'safe-message',
        account: SAFE_INDEX,
        payload: { safe: SAFE_ADDRESS, chain_id: '100', method: 'personal_sign', params: [MESSAGE, SAFE_ADDRESS] },
        handle: shown.handle,
        page: expect.objectContaining({ origin: site }),
      },
    ]);
    expect(devices.safes).toHaveLength(1);
    expect(devices.safes[0]).toMatchObject({
      safeIndex: SAFE_INDEX,
      request: { method: 'personal_sign', params: [MESSAGE, SAFE_ADDRESS] },
      owner: 'main',
      approval: { id: expect.stringMatching(/^[0-9a-f]{32}$/), page: expect.objectContaining({ origin: site }) },
    });
  });

  test('a keyless document gets the core\'s 4100 for a signature, with no prompt', async () => {
    const keyless = env.tab('data:text/html,<h1>keyless</h1>');
    expect(await keyless.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT])).toEqual({ error: NO_ADDRESS });
    expect(env.prompts()).toEqual([]);
  });

  test('a rejected signature answers 4001, with nothing signed', async () => {
    const page = await env.connected(`${key('8')}/app`, 0);
    const rejected = env.asking(page, 'personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    expect(await env.decide((await rejected.prompt()).handle, false)).toEqual({ ok: true });
    expect(await rejected.answer).toEqual({ error: REJECTED });
  });
});
