/**
 * The Agent's sheet answering the real freedom-cored's prompts (freedom-core
 * design 0012, "The Agent's answer", APB-5a). In a tab the Agent holds, a
 * page's connect, `personal_sign` and `eth_signTypedData_v4` go to the
 * core's `eip1193.request` with `agent: true`, and the core's `eth.connect`
 * or `eth.sign` prompt is answered by the Agent's sheet (a stand-in for the
 * agent service here) on a handle main opens for it: the core writes the
 * grant, or mints the token and signs, or hands main `{ device }` for a
 * Ledger. Custody that begins after the request was sent, or ends before its
 * prompt arrives, shows the user's prompt instead (A7-9). A spy on main's
 * core client finds no `approval.issue` and no `approval.grant`.
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/page/page-agent-answers.integration
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
const DEVICE = new Wallet('0x' + '42'.repeat(32));
const LEDGER_INDEX = 1000000;
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
const REJECTED = { code: 4001, message: 'User rejected the request' };
const CUSTODY_LOST = { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' };
const PROMPT_ID = /^[0-9a-f]{32}$/;
const HANDLE = /^[0-9a-f]{64}$/;
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
  constructor() {
    super();
    this.id = nextGuest++;
    this.window = 1;
    this.hostWebContents = { id: 501, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
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
const typesOf = (data) => {
  const { EIP712Domain: _domain, ...types } = data.types;
  return types;
};

describeIfBinary("the Agent's sheet answers the real freedom-cored's prompts (0012 APB-5a)", () => {
  let root;
  let core;
  let sc;
  let vaultBackend;
  let relay;
  let env;
  // Test seams on main's handlers for the core's requests: `before` runs
  // first, `cross` may change main's answer; `answers` keeps main's answers
  // to `approval.request`.
  const seams = { before: null, cross: null, answers: [], asked: [] };
  // Every call main's core client made: its method and caller.
  const calls = [];
  // The Agent's sheet: `answer(prompt, options)` gives the agent service's
  // outcome; each prompt it was asked is kept.
  const sheet = { answer: null, asked: [] };
  // The tabs the Agent holds.
  const custody = new Set();
  const devices = { spends: [], signed: [] };
  const wallets = [
    { index: 0, name: 'Main Wallet', address: VAULT_ACCOUNT, type: 'mnemonic' },
    { index: LEDGER_INDEX, name: 'Ledger', address: DEVICE.address, type: 'ledger' },
  ];

  const grants = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'dapp-permissions.json'), 'utf8'));
    } catch {
      return {};
    }
  };

  // A Ledger stand-in: the core's token spent through the core first, then
  // the caller's last check, and the device asked only after.
  const ledger = ({ confirmation, beforeSign }) => {
    const spend = async () => {
      devices.spends.push(confirmation.kind);
      await sc.spendConfirmation(confirmation);
      if (beforeSign) await beforeSign();
    };
    return {
      signMessage: async (message) => {
        await spend();
        devices.signed.push('message');
        return DEVICE.signMessage(getBytes(message));
      },
      signTypedData: async (typedData) => {
        const data = typeof typedData === 'string' ? JSON.parse(typedData) : typedData;
        await spend();
        devices.signed.push('typed');
        return DEVICE.signTypedData(data.domain, typesOf(data), data.message);
      },
    };
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-answers-'));
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
    const request = core.request.bind(core);
    core.request = (method, params, context, options) => {
      calls.push({ method, caller: context?.caller });
      return request(method, params, context, options);
    };
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    sc = require('../wallet/signing-confirmation');
    ({ vaultBackend } = require('../core/vault-backend'));
    const { createEip1193Relay } = require('./page-eip1193');
    relay = createEip1193Relay({
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
      agentPrompt: async (guestId, prompt, options) => {
        sheet.asked.push({ guestId, prompt, options });
        return sheet.answer ? sheet.answer(prompt, options) : { handled: false };
      },
    });
    relay.attach({
      handle: (method, handler) =>
        core.handle(method, async (params, options) => {
          if (method === 'approval.request') seams.asked.push(params);
          await seams.before?.(method, params);
          let answer = await handler(params, options);
          if (seams.cross) answer = await seams.cross(method, params, answer);
          if (method === 'approval.request') seams.answers.push(answer);
          return answer;
        }),
    });
    await core.start();
    await vaultBackend.importVault('testpass1', ABANDON);
  });

  afterAll(async () => {
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    Object.assign(seams, { before: null, cross: null, answers: [], asked: [] });
    Object.assign(sheet, { answer: null, asked: [] });
    Object.assign(devices, { spends: [], signed: [] });
    custody.clear();
    calls.length = 0;
    if (!(await vaultBackend.status()).unlocked) await vaultBackend.unlock('testpass1');
    const { createPageDocuments } = require('./page-documents');
    const { createPageRequests } = require('./page-requests');
    const { createEthereumDispatchers } = require('./page-ethereum');
    const guests = new Map();
    const timers = [];
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
        relay,
        identityWalletEnabled: () => true,
        permissionsLoaded: async () => {},
        deviceDeps: {
          walletList: async () => wallets,
          getSigner: (_index, authorized) => ledger(authorized),
          discardToken: (token) => sc.discardConfirmation(token),
        },
      }),
      setTimer: (fn) => {
        const timer = { fn, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        if (timer) timer.cleared = true;
      },
      chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
      sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
      watchWindow: () => {},
      isAgentGuest: (guestId) => custody.has(guestId),
    });
    const tab = (url) => {
      const guest = new Guest();
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
    // A page the Agent holds, connected through the sheet to `walletIndex`.
    const held = async (url, walletIndex = 0) => {
      const page = tab(url);
      custody.add(page.guest.id);
      sheet.answer = async () => ({ handled: true, decision: { approve: true, walletIndex } });
      expect((await page.ask('eth_requestAccounts')).result).toHaveLength(1);
      sheet.answer = null;
      sheet.asked.length = 0;
      seams.answers.length = 0;
      seams.asked.length = 0;
      return page;
    };
    // Main's deadline for every request still running.
    const expire = () => {
      for (const timer of timers.filter((t) => !t.cleared)) {
        timer.cleared = true;
        timer.fn();
      }
    };
    env = { requests, tab, prompts, decide, held, expire };
  });

  // Nothing main sent minted a page token or wrote a dApp grant itself.
  afterEach(() => {
    expect(calls.filter(({ method }) => method === 'approval.issue' || method === 'approval.grant')).toEqual([]);
  });

  test("a connect in custody: the core's eth.connect, answered by the sheet's account, and the core writes the grant", async () => {
    const site = key('a');
    const page = env.tab(`${site}/app`);
    custody.add(page.guest.id);
    sheet.answer = async () => ({ handled: true, decision: { approve: true, walletIndex: 0 } });
    expect(await page.ask('eth_requestAccounts')).toEqual({ result: [VAULT_ACCOUNT] });
    expect(calls.filter(({ method }) => method === 'eip1193.request')).toEqual([
      { method: 'eip1193.request', caller: 'page' },
    ]);
    expect(seams.asked[0]).toMatchObject({ kind: 'eth.connect', page: { origin: site, agent: true } });
    expect(sheet.asked).toHaveLength(1);
    expect(sheet.asked[0].prompt).toMatchObject({
      kind: 'eth.connect',
      method: 'eth_requestAccounts',
      view: { accounts: expect.arrayContaining([expect.objectContaining({ index: 0, address: VAULT_ACCOUNT })]) },
    });
    expect(sheet.asked[0].options.attested).toEqual({ key: site, transportKey: site });
    expect(seams.answers[0]).toMatchObject({
      prompt: seams.asked[0].prompt,
      handle: expect.stringMatching(HANDLE),
      approve: true,
      choices: { walletIndex: 0 },
    });
    expect(grants()[site]).toMatchObject({ walletIndex: 0 });
    expect(env.prompts()).toEqual([]);
    // The agent service hears the page's answer.
    await expect(sheet.asked[0].options.answered).resolves.toEqual({ result: [VAULT_ACCOUNT] });
    // A connected site's connect: its grant, no prompt (A7-1).
    expect(await page.ask('eth_requestAccounts')).toEqual({ result: [VAULT_ACCOUNT] });
    expect(sheet.asked).toHaveLength(1);
  });

  test("signatures in custody: the core's eth.sign, the core's view on the sheet, alwaysAllow false relayed, and the core's signature", async () => {
    const page = await env.held(`${key('b')}/app`);
    sheet.answer = async () => ({ handled: true, decision: { approve: true } });
    const signature = (await page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT])).result;
    expect(verifyMessage('Hello, Freedom', signature)).toBe(VAULT_ACCOUNT);
    expect(sheet.asked[0].prompt).toMatchObject({
      kind: 'eth.sign',
      view: { method: 'personal_sign', account: { index: 0, address: VAULT_ACCOUNT }, message: { hex: MESSAGE, rawHash: false } },
    });
    // A core before APR-7 offers "Always allow" in custody; the sheet never picks it.
    expect(seams.asked[0].choices).toEqual({ alwaysAllow: [false, true] });
    expect(seams.answers[0]).toMatchObject({
      prompt: seams.asked[0].prompt,
      handle: expect.stringMatching(HANDLE),
      approve: true,
      choices: { alwaysAllow: false },
    });
    expect(seams.asked[0].prompt).toMatch(PROMPT_ID);

    const typed = (await page.ask('eth_signTypedData_v4', [VAULT_ACCOUNT, JSON.stringify(TYPED)])).result;
    expect(verifyTypedData(TYPED.domain, MAIL_TYPES, TYPED.message, typed)).toBe(VAULT_ACCOUNT);
    expect(sheet.asked[1].prompt.view).toMatchObject({ method: 'eth_signTypedData_v4', typedData: { hash: expect.any(String) } });
    expect(seams.answers[1].choices).toEqual({ alwaysAllow: false });
    expect(env.prompts()).toEqual([]);
    expect(grants()[key('b')].autoApprove?.limited?.signing).toBeUndefined();
  });

  test("the sheet's decline answers approve false and the page gets 4001; a sheet withdrawn answers closed", async () => {
    const page = await env.held(`${key('c')}/app`);
    sheet.answer = async () => ({ handled: true, decision: { approve: false } });
    expect(await page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT])).toEqual({ error: REJECTED });
    expect(seams.answers[0]).toMatchObject({ approve: false, choices: {} });
    sheet.answer = async () => ({ handled: true, decision: { closed: true } });
    expect(await page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT])).toEqual({ error: REJECTED });
    expect(seams.answers[1]).toEqual({ prompt: seams.asked[1].prompt, closed: 'cancelled' });
  });

  test("the agent's own refusal: the page gets its error, the core a closed prompt, nothing signed (A7-3)", async () => {
    const page = await env.held(`${key('d')}/app`);
    const refusal = { code: -32603, message: 'Signature account does not match the connected wallet' };
    sheet.answer = async () => ({ handled: true, error: refusal });
    expect(await page.ask('personal_sign', [MESSAGE, DEVICE.address])).toEqual({ error: refusal });
    expect(seams.answers[0]).toEqual({ prompt: seams.asked[0].prompt, closed: 'cancelled' });
  });

  test('custody that begins after the request was sent, or ends before its prompt arrives, shows the user\'s prompt for the same prompt id (A7-9)', async () => {
    const site = key('e');
    const page = await env.held(`${site}/app`);
    sheet.answer = async () => ({ handled: true, decision: { approve: true } });
    // Sent in custody; custody ends before the prompt arrives.
    seams.before = (method) => {
      if (method === 'approval.request') custody.delete(page.guest.id);
    };
    const lost = page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    await until(() => env.prompts().length === 1);
    const [shown] = env.prompts();
    expect(seams.asked[0].page.agent).toBe(true);
    expect(await env.decide(shown.handle, true, { alwaysAllow: false })).toEqual({ ok: true });
    expect(verifyMessage('Hello, Freedom', (await lost).result)).toBe(VAULT_ACCOUNT);
    expect(seams.answers[0]).toMatchObject({ prompt: seams.asked[0].prompt, handle: shown.handle, approve: true });
    // Sent outside custody; custody begins before the prompt arrives.
    seams.before = (method) => {
      if (method === 'approval.request') custody.add(page.guest.id);
    };
    const begun = page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    await until(() => env.prompts().length === 2);
    expect(seams.asked[1].page.agent).toBe(false);
    expect(await env.decide(env.prompts()[1].handle, false)).toEqual({ ok: true });
    expect(await begun).toEqual({ error: REJECTED });
    expect(sheet.asked).toEqual([]);
  });

  test('the agent service not taking it shows the user\'s prompt for the same prompt id', async () => {
    const page = await env.held(`${key('f')}/app`);
    sheet.answer = async () => ({ handled: false });
    const asked = page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    await until(() => env.prompts().length === 1);
    expect(sheet.asked).toHaveLength(1);
    expect(await env.decide(env.prompts()[0].handle, true, { alwaysAllow: false })).toEqual({ ok: true });
    expect(verifyMessage('Hello, Freedom', (await asked).result)).toBe(VAULT_ACCOUNT);
    expect(seams.answers[0]).toMatchObject({ prompt: seams.asked[0].prompt, approve: true });
  });

  test("an answer with another prompt's id is the core's mismatch: nothing signed", async () => {
    const page = await env.held(`${key('g')}/app`);
    sheet.answer = async () => ({ handled: true, decision: { approve: true } });
    seams.cross = (method, _params, answer) =>
      method === 'approval.request' && answer.approve ? { ...answer, prompt: 'f'.repeat(32) } : answer;
    const answer = await page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    expect(answer.error).toMatchObject({ code: -32603 });
    expect(answer.result).toBeUndefined();
  });

  test("the record's deadline ends the sheet: the page hears \"Request timed out\", the core closed expired, nothing signed", async () => {
    const page = await env.held(`${key('h')}/app`);
    let withdrawn = null;
    sheet.answer = (_prompt, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          withdrawn = true;
          resolve({ handled: true, decision: { closed: true } });
        });
      });
    const asked = page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    await until(() => sheet.asked.length === 1);
    env.expire();
    expect(await asked).toEqual({ error: { message: 'Request timed out' } });
    await until(() => seams.answers.length === 1);
    expect(withdrawn).toBe(true);
    expect(seams.answers[0]).toEqual({ prompt: seams.asked[0].prompt, closed: 'expired' });
  });

  test("a Ledger's signature in custody: { device } spent through the core after the sheet's approve; custody ended before the device signs nothing", async () => {
    const page = await env.held(`${key('i')}/app`, LEDGER_INDEX);
    sheet.answer = async () => ({ handled: true, decision: { approve: true } });
    const signature = (await page.ask('personal_sign', [MESSAGE, DEVICE.address])).result;
    expect(verifyMessage('Hello, Freedom', signature)).toBe(DEVICE.address);
    expect(seams.asked[0].choices).toEqual({ alwaysAllow: [false] });
    expect(devices).toEqual({ spends: ['sign-message'], signed: ['message'] });

    // The Agent loses the tab once main has answered the approve, before
    // the device is asked (A7-6).
    seams.cross = (method, _params, answer) => {
      if (method === 'approval.request' && answer.approve === true) custody.delete(page.guest.id);
      return answer;
    };
    const lost = await page.ask('personal_sign', [MESSAGE, DEVICE.address]);
    expect(lost).toEqual({ error: CUSTODY_LOST });
    expect(devices.signed).toEqual(['message']);
  });
});
