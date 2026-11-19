// D13, end to end: what a site hears about a phone account's payment whose
// answer was lost. A phone signs and broadcasts the payment itself, so once
// the request reached it the payment may have been sent. A site told
// "rejected" (EIP-1193 4001) may send the request again, and the phone could
// pay twice, so the site must hear that the outcome is unknown.
//
// Real on both sides of IPC: main's step for the identity core's `{ device }`
// answer to a phone account's send (freedom-core design 0012, APB-4c:
// page/page-core-sends.js), transaction service, phone signer and bridge;
// the renderer's session broker (over a scripted openlv session). Mocked:
// chain data, permissions, and the phone itself; simulated: the core's
// decision (the transaction it prepared, and the token it minted once the
// user approved its prompt) and its phone jobs (design 0012, PHN-2), whose
// judgement of the answer decides (the real core's runs in
// main/wallet/remote/phone-jobs.integration.test.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet, toQuantity } = require('ethers');

// Main's IPC registry, a fresh one per test (startPhone).
const mockMain = { handle: new Map(), on: new Map() };
// The chrome window's webContents, a fresh one per test (startPhone).
const mockWindow = { webContents: null };
// The wallet's records (intent store, payment history) live in a scratch
// profile per test.
let mockUserData;
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: {
    handle: (channel, handler) => mockMain.handle.set(channel, handler),
    on: (channel, handler) => mockMain.on.set(channel, handler),
    removeHandler: () => {},
  },
  BrowserWindow: {
    getFocusedWindow: () => mockWindow,
    getAllWindows: () => [],
  },
  webContents: {
    getAllWebContents: () => [],
    // The site's tab (#764): guest 31 of the chrome window (id 7).
    fromId: (id) =>
      id === 31
        ? {
            id,
            hostWebContents: { id: 7 },
            getURL: () => 'https://app.example/',
            isDestroyed: () => false,
          }
        : null,
  },
}));
jest.mock('qrcode', () => ({}));
jest.mock('../../../main/wallet/balance-service', () => ({}));
jest.mock('../../../main/wallet/rpc-manager', () => ({
  getEffectiveRpcUrls: () => [],
  getKeylessRpcUrls: () => [],
}));
jest.mock('../../../main/wallet/chains', () => ({
  getChain: () => null,
  getAllChains: () => [],
  getTxExplorerUrl: () => null,
}));
jest.mock('../../../main/networks/chain-data', () => ({
  request: jest.fn(async (_chainId, method) => {
    throw new Error(`unexpected read ${method}`);
  }),
  broadcastRawTransaction: jest.fn(),
  getFeeQuote: jest.fn(),
}));
jest.mock('../../../main/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../../main/wallet/signers', () => ({ getSigner: (index) => mockSigners[index] }));
// The identity core's approval tokens (design 0012, APB-1), simulated: the
// core mints the send's token as it decides, and main discards it once the
// send ends.
const mockApprovals = require('../../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../../../main/core/vault-backend', () => ({
  vaultBackend: {
    get approval() {
      return mockApprovals.approval;
    },
    get phone() {
      return mockPhoneCore;
    },
  },
}));
// The identity core's phone jobs (design 0012, PHN-2), as far as these tests
// reach: a payment's job, relayed as the phone wallet's eth_sendTransaction;
// the chrome's "sent" mark; and the core's judgement of the answer. The
// phone wallet's explicit refusals (EIP-1193 4001, 4100, 4200) are answers;
// any other end of a payment that may have gone (an error, the user's
// cancel, main's timeout) is unknown; before it went, a failure as reported.
const mockPhoneCore = (() => {
  const jobs = new Map();
  let next = 0;
  const refused = (reason) =>
    Object.assign(new Error(`not authorized: ${reason}`), { code: 'not_authorized', data: { reason } });
  const REFUSALS = { 4001: 'REMOTE_USER_REJECTED', 4100: 'REMOTE_WRONG_ACCOUNT', 4200: 'REMOTE_UNSUPPORTED' };
  return {
    jobs,
    async job({ address, method, payload }) {
      if (method !== 'transaction') throw refused('unsupported');
      const { tx } = payload;
      const job = `core-job-${(next += 1)}`;
      jobs.set(job, { sent: false, settled: false });
      const params = { from: address, to: tx.to, value: toQuantity(tx.value), chainId: toQuantity(tx.chain_id) };
      if (tx.data && tx.data !== '0x') params.data = tx.data;
      return { job, expires_in_ms: 5 * 60 * 1000, request: { method: 'eth_sendTransaction', params: [params] } };
    },
    async sent({ job }) {
      const entry = jobs.get(job);
      if (!entry || entry.settled) throw refused('settled');
      entry.sent = true;
      return {};
    },
    async result({ job, result, error }) {
      const entry = jobs.get(job);
      if (!entry || entry.settled) throw refused('settled');
      entry.settled = true;
      if (!error) return typeof result === 'string' ? { outcome: 'unverified', hash: result } : { outcome: 'unknown' };
      const code = REFUSALS[error.rpc_code];
      if (code) return { outcome: 'failed', code, ...(code !== 'REMOTE_USER_REJECTED' && error.message ? { message: error.message } : {}) };
      if (entry.sent) return { outcome: 'unknown' };
      return { outcome: 'failed', code: error.code || 'REMOTE_UNKNOWN', ...(error.message ? { message: error.message } : {}) };
    },
  };
})();
jest.mock('../../../main/identity-manager', () => ({
  getWalletRecord: () => null,
  getActiveWalletIndex: () => 0,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('../../../main/wallet/provider-manager', () => ({ testProvider: jest.fn() }));
jest.mock('better-sqlite3', () => require('../../../../test/helpers/fake-better-sqlite3-payments'));
jest.mock('../../../main/wallet/dapp-permissions', () => ({
  getPermission: (site) => (site === 'https://app.example' ? { walletIndex: 4 } : null),
}));

let mockSigners;

// Anvil/Hardhat-default test key: well known, never funded on mainnet.
const PHONE = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PHONE_INDEX = 4;
const SITE = 'https://app.example';
const SITE_UNKNOWN = {
  code: -32603,
  message:
    "The payment's outcome is unknown: it may have been sent. Check the wallet before retrying.",
  data: { outcome: 'unknown' },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};
// Until `condition` holds. The flows read the wallet's records from disk
// on the way, so a fixed number of turns of the event loop isn't enough;
// a flow that outlived its test would also run on into the next one.
const until = async (condition, what) => {
  for (let i = 0; i < 20000; i += 1) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
};

// The phone's side of openlv: links at once, answers the network switch,
// and answers the payment only as `answer` says (by default, never).
function scriptedOpenlv(answer = () => new Promise(() => {})) {
  const listeners = new Set();
  let status = 'created';
  const session = {
    status: {
      get: () => status,
      subscribe(listener) {
        listeners.add(listener);
        listener(status);
        return () => listeners.delete(listener);
      },
      until: async (isMatch) => {
        // The phone scans the code: the link comes up.
        status = 'connected';
        for (const listener of listeners) listener(status);
        return isMatch(status) ? status : undefined;
      },
    },
    error: { get: () => undefined },
    connect: jest.fn(async () => {}),
    send: jest.fn(async ({ method }) =>
      method === 'wallet_switchEthereumChain' ? { result: null } : answer()
    ),
    close: jest.fn(async () => {}),
    getHandshakeParameters: () => ({ version: 1, sessionId: 'abcdef1234567890' }),
  };
  return {
    session,
    sdk: {
      createSession: jest.fn(async () => session),
      webrtc: () => 'WEBRTC',
      encodeConnectionURL: () => 'openlv://abcdef1234567890@1',
    },
  };
}

/**
 * Main (signer, bridge, wallet handlers) and the renderer's session broker,
 * wired as the preload wires them. `holdRequestSent: 'question'` keeps the
 * broker's question to main (may the request go?) from reaching main until
 * the test delivers it; `'answer'` lets main answer at once and holds the
 * answer on its way back. `holdAbort` holds main's abort to the renderer.
 */
async function startPhone({ answer, holdRequestSent = null, holdAbort = false } = {}) {
  jest.resetModules();
  // Each test's main gets its own IPC registry: a flow of an earlier test
  // can only ever reach that test's handlers.
  const registry = { handle: new Map(), on: new Map() };
  mockMain.handle = registry.handle;
  mockMain.on = registry.on;

  mockPhoneCore.jobs.clear();
  const { createRemoteBackend } = require('../../../main/wallet/remote/signer');
  const backend = createRemoteBackend({ index: PHONE_INDEX, address: PHONE.address });
  // The signer factory's part (signers.js, tested in signers.test.js): the
  // job's payload, the send in the core's form.
  const jobOf = (tx) => ({
    page: null,
    payload: {
      tx: { to: tx.to, value: BigInt(tx.value ?? 0).toString(), data: tx.data ?? '0x', chain_id: String(tx.chainId) },
    },
  });
  mockSigners = {
    [PHONE_INDEX]: { ...backend, sendTransaction: (tx) => backend.sendTransaction(tx, jobOf(tx)) },
  };
  require('../../../main/wallet/remote/bridge').registerRemoteSignerIpc();
  require('../../../main/wallet/wallet-ipc').registerWalletIpc();
  const chrome = { sender: { id: 7 } };
  const invoke = (channel, ...args) => registry.handle.get(channel)(chrome, ...args);
  const fromChrome = (channel, payload) => registry.on.get(channel)(chrome, payload);

  const held = { requestSent: [], abort: [] };
  const toRenderer = {};
  const webContents = { id: 7, isDestroyed: () => false, send: jest.fn() };
  mockWindow.webContents = webContents;
  webContents.send.mockImplementation((channel, payload) => {
    const deliver = () => setImmediate(() => toRenderer[channel]?.(payload));
    if (holdAbort && channel === 'remote-signer:abort') held.abort.push(deliver);
    else deliver();
  });
  const openlv = scriptedOpenlv(answer);
  const { createRemoteSessionBroker } = await import('./remote-session.js');
  const broker = createRemoteSessionBroker({
    openlv: openlv.sdk,
    remoteSigner: {
      onRequest: (callback) => {
        toRenderer['remote-signer:request'] = callback;
        return () => {};
      },
      onAbort: (callback) => {
        toRenderer['remote-signer:abort'] = callback;
        return () => {};
      },
      respond: (payload) => fromChrome('remote-signer:response', payload),
      requestSent: (jobId) => {
        const ask = () => invoke('remote-signer:request-sent', { jobId });
        if (holdRequestSent === 'question') {
          return new Promise((resolve) => held.requestSent.push(() => resolve(ask())));
        }
        const answered = ask();
        if (holdRequestSent === 'answer') {
          return new Promise((resolve) => held.requestSent.push(() => resolve(answered)));
        }
        return Promise.resolve(answered);
      },
    },
    signaling: { p: 'mqtt', s: 'wss://relay.test/mqtt' },
    bridgeOrigin: 'https://bridge.test',
  });
  broker.start();
  const jobs = [];
  broker.onJobEvent((event) => jobs.push(event));

  return {
    invoke,
    broker,
    jobs,
    // What reached the phone, by method.
    phoneGot: () => openlv.session.send.mock.calls.map(([message]) => message.method),
    deliver: {
      requestSent: () => held.requestSent.splice(0).forEach((deliver) => deliver()),
      abort: () => held.abort.splice(0).forEach((deliver) => deliver()),
    },
  };
}

/**
 * The site asks for a payment, and the identity core decides it (design
 * 0012, APB-4c): the user approved the core's prompt, so the core hands main
 * `{ device }` for the phone account, with the transaction it prepared and
 * the token it minted for it. Main's `page-core-sends.js` runs the send: the
 * site's turn, the name, the grant and the document's key, then the core's
 * phone job, which spends the token, before the phone is asked. `call` makes
 * the payment a contract call. `answer` is the page's answer, once main has
 * one.
 */
async function start({ call = false, ...options } = {}) {
  const phone = await startPhone(options);
  const { createCoreSends } = require('../../../main/page/page-core-sends');
  const permissions = require('../../../main/wallet/dapp-permissions');
  const sends = createCoreSends(
    {
      getPermission: permissions.getPermission,
      updateLastUsed: jest.fn(),
      walletList: async () => [{ index: PHONE_INDEX, name: 'Phone', address: PHONE.address, type: 'remote' }],
    },
    { inCustody: () => false }
  );
  const page = { origin: SITE, top_origin: SITE, frame: 1, navigation: 1, agent: false };
  const asked = call
    ? { to: '0x' + '22'.repeat(20), data: '0x095ea7b3' + '00'.repeat(64) }
    : { to: '0x' + '22'.repeat(20), value: '0x1' };
  const context = {
    requester: { key: SITE, guest: 31, window: 7, navigation: 1, chain: null },
    method: 'eth_sendTransaction',
    params: [asked],
    nameHolds: async () => true,
    holdsKey: () => true,
    pageContext: () => page,
    signal: new AbortController().signal,
    leaveWalletSlot: () => {},
  };
  // The core's prepared transaction, in `sign.transaction`'s form with no
  // nonce: the page's fields on Gnosis, with the core's gas limit and fee.
  // The phone picks its own nonce and fee all the same.
  const tx = {
    type: 0,
    chain_id: '100',
    to: asked.to,
    value: BigInt(asked.value ?? 0).toString(),
    data: asked.data ?? '0x',
    gas_limit: '21000',
    gas_price: '1000000000',
  };
  const handle = 'a'.repeat(64);
  const { token } = await mockApprovals.approval.issue(
    { kind: 'dapp-send', account: PHONE_INDEX, payload: { tx }, handle },
    page
  );
  // As page-eip1193.js hands it on, checked against the request: "Always
  // allow" unticked.
  const device = {
    type: 'remote',
    kind: 'dapp-send',
    account: PHONE_INDEX,
    payload: { tx },
    handle,
    token,
    remember: false,
  };
  const site = { state: 'pending' };
  const answer = sends
    .device(context, device, page)
    .then((value) => Object.assign(site, { state: 'answered', value }));
  if (options.holdRequestSent) {
    await until(() => phone.phoneGot().length === 1, 'the network switch');
    await settle();
  } else {
    // The payment request is on the phone now.
    await until(() => phone.phoneGot().length === 2, 'the payment request on the phone');
    expect(phone.phoneGot()).toEqual(['wallet_switchEthereumChain', 'eth_sendTransaction']);
  }
  return { ...phone, site, answer };
}

beforeEach(() => {
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-unknown-'));
  for (const level of ['log', 'warn', 'error'])
    jest.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  delete global.window;
  delete global.document;
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

// From PRQ-5b main answers the page itself once the phone has answered, or
// hasn't: the outcome reaches the site as main reads it, with no screen left
// for the user to dismiss first. A payment that may have been sent is in the
// wallet's records.
const REJECTED = { code: 4001, message: 'User rejected the request' };
const answeredWith = async (ctx) => {
  await ctx.answer;
  return ctx.site.value;
};

describe("a site's answer when its phone payment's outcome is unknown (D13)", () => {
  test('the user stops waiting: the site hears the outcome is unknown, never 4001', async () => {
    const ctx = await start();
    ctx.broker.cancelJob(ctx.jobs.find((event) => event.phase === 'qr').jobId);
    expect(await answeredWith(ctx)).toEqual({ error: SITE_UNKNOWN });
  });

  test("main's own timeout: the site hears the same", async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const ctx = await start();
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(await answeredWith(ctx)).toEqual({ error: SITE_UNKNOWN });
  });

  test("the phone's own refusal is an answer: nothing was sent, so 4001 stands", async () => {
    const ctx = await start({ answer: async () => ({ error: { code: 4001, message: 'User denied.' } }) });
    expect(await answeredWith(ctx)).toEqual({ error: REJECTED });
  });
});

// Review of #787, M1: main allows the request before it goes, in one turn,
// so its timeout can't land between the request going out and main knowing.
describe("the request goes only with main's leave (787-M1)", () => {
  const FIVE_MINUTES = 5 * 60 * 1000 + 1;

  test('the question reaches main after its timeout: nothing goes to the phone, and the timeout stands', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const ctx = await start({ holdRequestSent: 'question' });
    expect(ctx.phoneGot()).toEqual(['wallet_switchEthereumChain']);

    jest.advanceTimersByTime(FIVE_MINUTES);
    await settle();
    ctx.deliver.requestSent();
    // Main had given up, so it refused: the payment never reached the phone,
    // and the site hears that it failed, not that its outcome is unknown.
    expect(await answeredWith(ctx)).toEqual({
      error: { code: -32603, message: 'Your phone did not respond in time. Try again with a new QR code.' },
    });
    expect(ctx.phoneGot()).toEqual(['wallet_switchEthereumChain']);
  });

  test('main allowed it, and its abort is late: the payment went, so the outcome is unknown', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const ctx = await start({ holdAbort: true });
    jest.advanceTimersByTime(FIVE_MINUTES);
    expect(await answeredWith(ctx)).toEqual({ error: SITE_UNKNOWN });
    ctx.deliver.abort();
    await settle();
  });

  test('main allowed it, then timed out before it went: nothing goes, and the outcome stays unknown', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    // Main marks the payment and allows it at once; its answer is held on
    // the way back while main times out and its abort lands first.
    const ctx = await start({ holdRequestSent: 'answer' });
    jest.advanceTimersByTime(FIVE_MINUTES);
    await until(() => ctx.jobs.some((event) => event.phase === 'aborted'), "main's abort");
    ctx.deliver.requestSent();
    await settle();

    expect(ctx.phoneGot()).toEqual(['wallet_switchEthereumChain']);
    expect(await answeredWith(ctx)).toEqual({ error: SITE_UNKNOWN });
  });
});

// Review of #787, M2: once the payment is on the phone, only the phone's
// explicit refusals say it wasn't sent.
describe("the phone's error answers to a payment on it (787-M2)", () => {
  const INTERNAL = { error: { code: -32603, message: 'No response after submitting the payment' } };

  test.each([
    ['an internal error', INTERNAL],
    ['an unrecognised code', { error: { code: -32000, message: 'something went wrong' } }],
    ['an error with no code', { error: { message: 'oops' } }],
  ])(
    '%s leaves the outcome unknown: no second request, and the site hears unknown',
    async (_name, reply) => {
      let requests = 0;
      const ctx = await start({
        answer: async () => {
          requests += 1;
          return reply;
        },
      });
      expect(await answeredWith(ctx)).toEqual({ error: SITE_UNKNOWN });
      await settle();
      expect(requests).toBe(1);
    }
  );

  test.each([[4100], [4200]])(
    'the explicit refusal %s is an answer: nothing was sent',
    async (code) => {
      const ctx = await start({ answer: async () => ({ error: { code, message: 'refused' } }) });
      expect(await answeredWith(ctx)).toEqual({ error: { code: -32603, message: 'refused' } });
    }
  );

  // A contract call, which the site's rule answered on main's own route
  // before APB-4d. The core's rule answers no device's send (design 0012,
  // APR-5e-2), so a phone's contract call is prompted and comes as
  // `{ device }` too: the same answers hold for a payment that carries data.
  test('a contract call: the page hears unknown from an internal error', async () => {
    const ctx = await start({ call: true, answer: async () => INTERNAL });
    expect(ctx.phoneGot()).toEqual(['wallet_switchEthereumChain', 'eth_sendTransaction']);
    expect(await answeredWith(ctx)).toEqual({ error: SITE_UNKNOWN });
  });

  test("a contract call: the phone's own rejection is the user's", async () => {
    const ctx = await start({
      call: true,
      answer: async () => ({ error: { code: 4001, message: 'User denied.' } }),
    });
    expect(await answeredWith(ctx)).toEqual({ error: REJECTED });
  });
});
