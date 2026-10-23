// D12 through main's real handlers: the renderer's question
// (`dapp:is-tx-auto-approved`, which picks the prompt or the silent send) and
// an auto-approved send (`wallet:dapp-send-transaction`), with the real
// permissions store, intent store, payment history and transaction service.
// Chain data and signers are mocked.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet, keccak256 } = require('ethers');

let mockUserData;
let mockSigners;
const mockRequest = jest.fn();
const mockBroadcast = jest.fn();
const mockFeeQuote = jest.fn();
// The fee check's evidence (design 0005, A): B's combined quote, as the
// fee quote's own, from two endpoints.
const mockFeeReference = jest.fn();
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  webContents: {
    getAllWebContents: () => [],
    // Each site's tab (#764: an auto-approve is checked against the
    // requesting guest's own page), a guest of the chrome window (id 1).
    fromId: (id) => {
      const url = mockGuestUrls[id];
      return url
        ? { id, hostWebContents: { id: 1 }, getURL: () => url, isDestroyed: () => false }
        : null;
    },
  },
}));
const mockGuestUrls = {
  21: 'https://swap.example/app',
  22: 'https://other.example/app',
  23: 'https://plain.example/app',
};
// The chrome window's IPC event, and each site's guest.
const CHROME_EVENT = { sender: { id: 1 } };
const GUEST_OF = {
  'https://swap.example': 21,
  'https://other.example': 22,
  'https://plain.example': 23,
};
// An auto-approve as the renderer sends it: the site, and its tab.
const fromTab = (authorization) =>
  authorization?.autoApprove !== undefined
    ? { ...authorization, webContentsId: GUEST_OF[authorization.autoApprove] }
    : authorization;
jest.mock('qrcode', () => ({}));
jest.mock('./balance-service', () => ({}));
jest.mock('./rpc-manager', () => ({ getEffectiveRpcUrls: () => [] }));
jest.mock('./chains', () => ({
  getChain: () => null,
  getAllChains: () => [],
  getTxExplorerUrl: (chainId, hash) => `https://explorer.test/${chainId}/${hash}`,
}));
jest.mock('../networks/chain-data', () => ({
  request: (...args) => mockRequest(...args),
  broadcastRawTransaction: (...args) => mockBroadcast(...args),
  getFeeQuote: (...args) => mockFeeQuote(...args),
  getFeeReference: (...args) => mockFeeReference(...args),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../core/chain', () => ({ chainDriver: () => ({ client: { state: 'ready' } }) }));
jest.mock('./signers', () => ({ getSigner: (index) => mockSigners[index] }));
jest.mock('../identity-manager', () => ({
  getWalletRecord: () => null,
  getActiveWalletIndex: () => 0,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('./provider-manager', () => ({ testProvider: jest.fn() }));
jest.mock('better-sqlite3', () => require('../../../test/helpers/fake-better-sqlite3-payments'));

jest.setTimeout(20000);

// Deterministic test keys (not real wallets).
const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const BOB = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SWAP = 'https://swap.example'; // "Always allow", account 0
const OTHER = 'https://other.example'; // "Always allow", account 1
const PLAIN = 'https://plain.example'; // connected, no "Always allow"
const CONTRACT = '0x' + '66'.repeat(20);
const SELECTOR = '0xabcdef12';
const CHAIN = 1;

const signerFor = (wallet) => ({
  getAddress: jest.fn(async () => wallet.address),
  signTransaction: jest.fn((tx) => wallet.signTransaction(tx)),
  signMessage: jest.fn(async (message) => wallet.signMessage(message)),
});
const signed = () =>
  Object.values(mockSigners).reduce((n, s) => n + s.signTransaction.mock.calls.length, 0);

// Receipts the chain has, by hash: none until a test mines one.
let mined;

beforeEach(() => {
  // Payment history polls for receipts every 2 s: those timers run only
  // when a test advances them, and none outlives its test.
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-approve-pause-'));
  mockSigners = { 0: signerFor(ALICE), 1: signerFor(BOB) };
  mined = new Set();
  mockRequest.mockReset().mockImplementation(async (_chainId, method, params) => {
    if (method === 'eth_getTransactionReceipt') {
      return {
        result: mined.has(params[0])
          ? { status: '0x1', blockNumber: '0x1', gasUsed: '0x5208' }
          : null,
        source: 'direct',
      };
    }
    if (method === 'eth_getTransactionCount') return { result: '0x7', source: 'direct' };
    throw new Error(`unexpected read ${method}`);
  });
  mockFeeQuote.mockReset().mockResolvedValue({ type: 'legacy', gasPrice: '1000000000' });
  mockFeeReference.mockReset().mockImplementation(async (chainId) => {
    const quote = await mockFeeQuote(chainId).catch(() => null);
    return {
      header: null,
      lowest_priority: null,
      quote: quote && { ...quote, source: 'direct', verified: false, answered: 2 },
    };
  });
  require('./fee-check')._shared.clear();
  mockBroadcast.mockReset().mockImplementation(async (_chainId, raw) => ({
    result: keccak256(raw),
    source: 'direct',
  }));
});

afterEach(() => {
  jest.useRealTimers();
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

function start() {
  jest.resetModules();
  const { ipcMain } = require('electron');
  ipcMain.handle.mockClear();
  const permissions = require('./dapp-permissions');
  permissions.registerDappPermissionsIpc();
  require('./wallet-ipc').registerWalletIpc();
  const handlers = Object.fromEntries(ipcMain.handle.mock.calls);

  permissions.grantPermission(SWAP, 0, CHAIN);
  permissions.addTransactionAutoApprove(SWAP, CONTRACT, SELECTOR, CHAIN);
  permissions.grantPermission(OTHER, 1, CHAIN);
  permissions.addTransactionAutoApprove(OTHER, CONTRACT, SELECTOR, CHAIN);
  permissions.grantPermission(PLAIN, 0, CHAIN);

  const tx = {
    chainId: CHAIN,
    to: CONTRACT,
    value: '0',
    data: SELECTOR,
    gasLimit: '50000',
    gasPrice: '1000000000',
  };
  const index = { [SWAP]: 0, [OTHER]: 1, [PLAIN]: 0 };
  return {
    tx,
    permissions,
    handlers,
    store: require('./intent-store').getIntentStore(),
    // The renderer's question: true sends silently, false shows the prompt.
    autoApproves: (site) =>
      handlers['dapp:is-tx-auto-approved']({}, site, CONTRACT, SELECTOR, CHAIN),
    // A send the renderer made as auto-approved.
    autoSend: (site) =>
      handlers['wallet:dapp-send-transaction'](
        CHROME_EVENT,
        tx,
        index[site],
        { origin: site },
        fromTab({ autoApprove: site })
      ),
    // A send the user confirmed on the prompt.
    // A send the user confirmed on the prompt (by default on the site's
    // account and chain).
    confirmedSend: async (site, { account = index[site], chainId = CHAIN } = {}) => {
      const payment = { ...tx, chainId };
      const { token } = await handlers['wallet:confirm-signing']({}, 'dapp-send', account, {
        ...payment,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
        origin: site,
      });
      return handlers['wallet:dapp-send-transaction'](
        CHROME_EVENT,
        payment,
        account,
        { origin: site },
        {
          confirmation: token,
        }
      );
    },
  };
}

const refusedOnce = () =>
  mockBroadcast.mockImplementationOnce(async () => {
    throw Object.assign(new Error('insufficient funds for gas * price + value'), {
      outcome: 'rejected',
    });
  });

// Mine `hash`, then wait until payment history's next poll has seen it.
async function mine(hash) {
  mined.add(hash);
  const history = require('../payment-history');
  for (let i = 0; i < 100; i += 1) {
    if (history.getRecent({}).some((row) => row.txHash === hash && row.status === 'confirmed')) {
      return;
    }
    jest.advanceTimersByTime(2000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`no receipt recorded for ${hash}`);
}

describe('"Always allow" while a payment of the site is in Payments waiting (D12)', () => {
  test('the prompt shows while it waits, and the rule applies again once it settles', async () => {
    const running = start();
    await expect(running.autoApproves(SWAP)).resolves.toBe(true);

    // The site's auto-approved payment is refused: it waits, held at its nonce.
    refusedOnce();
    const refused = await running.autoSend(SWAP);
    expect(refused).toMatchObject({ success: false, outcome: 'rejected' });
    expect(running.store.get(refused.intentId).state).toBe('held');

    // The site asks again: the renderer is told to show the prompt…
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);
    // …and a send claiming auto-approve anyway is refused, with nothing signed.
    const before = signed();
    await expect(running.autoSend(SWAP)).resolves.toMatchObject({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
      error: expect.stringContaining('paused while a payment this site requested is waiting'),
    });
    expect(signed()).toBe(before);
    // The prompt's Confirm still sends: the user decided. That payment
    // waits too, until it is mined.
    const confirmed = await running.confirmedSend(SWAP);
    expect(confirmed).toMatchObject({ success: true, outcome: 'sent' });
    await mine(confirmed.hash);
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);

    // The refused payment settles: the rule applies again.
    await running.store.settle({
      intentId: refused.intentId,
      label: 'taken',
      hash: null,
      block: 100,
    });
    await expect(running.autoApproves(SWAP)).resolves.toBe(true);
    await expect(running.autoSend(SWAP)).resolves.toMatchObject({ success: true });
  });

  test('a payment sent and not yet mined waits too; once mined, the rule applies again', async () => {
    const running = start();
    const sent = await running.autoSend(SWAP);
    expect(sent).toMatchObject({ success: true, outcome: 'sent' });

    await expect(running.autoApproves(SWAP)).resolves.toBe(false);

    await mine(sent.hash);
    // Mined, though not final: no longer waiting, and still held.
    expect(running.store.get(sent.intentId).state).toBe('held');
    await expect(running.autoApproves(SWAP)).resolves.toBe(true);
    await expect(running.autoSend(SWAP)).resolves.toMatchObject({ success: true });
  });

  test('other sites are unaffected', async () => {
    const running = start();
    refusedOnce();
    await running.autoSend(SWAP);
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);

    await expect(running.autoApproves(OTHER)).resolves.toBe(true);
    await expect(running.autoSend(OTHER)).resolves.toMatchObject({
      success: true,
      from: BOB.address,
    });
  });

  test('a site without "Always allow" is unchanged: the prompt, waiting or not', async () => {
    const running = start();
    await expect(running.autoApproves(PLAIN)).resolves.toBe(false);
    await expect(running.autoSend(PLAIN)).resolves.toMatchObject({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
      error: expect.stringContaining("not covered by the site's auto-approve rules"),
    });

    refusedOnce();
    const refused = await running.confirmedSend(PLAIN);
    expect(refused).toMatchObject({ success: false, outcome: 'rejected' });
    await expect(running.autoApproves(PLAIN)).resolves.toBe(false);
    await expect(running.confirmedSend(PLAIN)).resolves.toMatchObject({ success: true });
  });

  // Review of #788, finding 1: the pause can't be passed twice at once.
  // Review of #788, round 2, finding 2: a dApp payment always has a site.
  test('codex r2: a dapp confirmation without a site is refused', async () => {
    const running = start();
    for (const origin of [undefined, null, '']) {
      const minted = await running.handlers['wallet:confirm-signing']({}, 'dapp-send', 0, {
        ...running.tx,
        origin,
      });
      expect(minted).toMatchObject({ success: false });
      expect(minted.token).toBeUndefined();
    }
    expect(signed()).toBe(0);
  });

  // Review of #788, round 2, finding 1: every dApp send of a site takes the
  // site's turn until its payment is committed, so no payment of the site
  // can be committed between a silent send's read and its own commit.
  async function holdRecordsRead() {
    const intentIpc = require('./intent-ipc');
    const real = intentIpc.waitingIntents;
    let finish;
    const started = new Promise((resolve) => {
      intentIpc.waitingIntents = jest.fn(async () => {
        resolve();
        await new Promise((go) => {
          finish = go;
        });
        intentIpc.waitingIntents = real;
        return real();
      });
    });
    return { started, finish: () => finish() };
  }

  function holdSigner(account, wallet) {
    let sign;
    const atSigner = new Promise((reached) => {
      mockSigners[account].signTransaction.mockImplementationOnce(
        (transaction) =>
          new Promise((resolve) => {
            sign = () => resolve(wallet.signTransaction(transaction));
            reached();
          })
      );
    });
    return { atSigner, sign: () => sign() };
  }

  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  test('codex r2: a confirmed payment cannot cross a silent send between its read and its commit', async () => {
    const running = start();
    const read = await holdRecordsRead();
    const silent = running.autoSend(SWAP);
    await read.started;

    // The user confirms another payment of the site meanwhile: it waits for
    // the silent send's turn, and commits nothing yet.
    const confirmed = running.confirmedSend(SWAP);
    await settle();
    await running.store.ready;
    expect(running.store.held()).toEqual([]);

    read.finish();
    const [first, second] = [await silent, await confirmed];
    expect(first).toMatchObject({ success: true, nonce: 7 });
    // The confirmed payment, never refused by the pause, commits after.
    expect(second).toMatchObject({ success: true, nonce: 8 });
    expect(signed()).toBe(2);
  });

  test('codex r2: a silent send waiting behind a confirmed one is refused once it commits', async () => {
    const running = start();
    const device = holdSigner(0, ALICE);
    const confirmed = running.confirmedSend(SWAP);
    await device.atSigner;

    const silent = running.autoSend(SWAP);
    await settle();
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);

    device.sign();
    await expect(confirmed).resolves.toMatchObject({ success: true });
    await expect(silent).resolves.toMatchObject({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
      error: expect.stringContaining('auto-approve is paused'),
    });
    expect(signed()).toBe(1);
  });

  test('the turn is left at the commit: a slow broadcast holds no one up', async () => {
    const running = start();
    let broadcast;
    const atBroadcast = new Promise((reached) => {
      mockBroadcast.mockImplementationOnce((_chainId, raw) => {
        reached();
        return new Promise((resolve) => {
          broadcast = () => resolve({ result: keccak256(raw), source: 'direct' });
        });
      });
    });
    const first = running.confirmedSend(SWAP);
    await atBroadcast;
    // The first payment is committed, its broadcast still out: the next one
    // of the site commits and sends meanwhile.
    await expect(running.confirmedSend(SWAP)).resolves.toMatchObject({ success: true, nonce: 8 });
    broadcast();
    await expect(first).resolves.toMatchObject({ success: true, nonce: 7 });
  });

  test("codex r2: the turn is the site's, across accounts and chains", async () => {
    const running = start();
    // Confirmed on account 1 (Bob) on chain 100; silent on account 0 (Alice)
    // on chain 1. Their account locks are separate; the site's turn is not.
    const device = holdSigner(1, BOB);
    const confirmed = running.confirmedSend(SWAP, { account: 1, chainId: 100 });
    await device.atSigner;
    const silent = running.autoSend(SWAP);
    await settle();

    device.sign();
    await expect(confirmed).resolves.toMatchObject({ success: true, from: BOB.address });
    await expect(silent).resolves.toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(mockSigners[0].signTransaction).not.toHaveBeenCalled();
  });

  test('codex: concurrent silent sends of one site: one signs, the other is refused', async () => {
    const running = start();
    const [first, second] = await Promise.all([running.autoSend(SWAP), running.autoSend(SWAP)]);
    expect([first.success, second.success].filter(Boolean)).toHaveLength(1);
    expect(first.success ? second : first).toMatchObject({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
      error: expect.stringContaining('auto-approve is paused'),
    });
    expect(signed()).toBe(1);
  });

  test('a send in flight pauses its site until it settles; other sites go on', async () => {
    const running = start();
    // Admitted, and waiting on its signature: nothing is in the records yet.
    let sign;
    const atSigner = new Promise((reached) => {
      mockSigners[0].signTransaction.mockImplementationOnce(
        (transaction) =>
          new Promise((resolve) => {
            sign = () => resolve(ALICE.signTransaction(transaction));
            reached();
          })
      );
    });
    const inFlight = running.autoSend(SWAP);
    await atSigner;
    expect(running.store.held()).toEqual([]);

    await expect(running.autoApproves(SWAP)).resolves.toBe(false);
    await expect(running.autoApproves(OTHER)).resolves.toBe(true);
    await expect(running.autoSend(OTHER)).resolves.toMatchObject({ success: true });

    sign();
    const sent = await inFlight;
    expect(sent).toMatchObject({ success: true, outcome: 'sent' });
    // Settled, and now waiting in the records until it is mined.
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);
    await mine(sent.hash);
    await expect(running.autoApproves(SWAP)).resolves.toBe(true);
  });

  test('a send that fails before it signs leaves its site free', async () => {
    const running = start();
    mockSigners[0].signTransaction.mockRejectedValueOnce(new Error('The vault is locked'));
    await expect(running.autoSend(SWAP)).resolves.toMatchObject({ success: false });
    await expect(running.autoApproves(SWAP)).resolves.toBe(true);
    await expect(running.autoSend(SWAP)).resolves.toMatchObject({ success: true });
  });

  // Review of #788, finding 2: the pause reads the site a payment is
  // recorded under, so that is the site that authorized it.
  test('codex: main binds a payment to the site that authorized it', async () => {
    const running = start();
    const send = (context, authorization, index = 0) =>
      running.handlers['wallet:dapp-send-transaction'](
        CHROME_EVENT,
        running.tx,
        index,
        context,
        fromTab(authorization)
      );

    // Signed under swap's rule, recorded as another site's: refused.
    await expect(send({ origin: OTHER }, { autoApprove: SWAP })).resolves.toMatchObject({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
      error: expect.stringContaining("the request's site is not the one its auto-approve names"),
    });
    expect(signed()).toBe(0);

    // Swap's refused payment is swap's, and pauses swap.
    refusedOnce();
    const refused = await send({ origin: SWAP }, { autoApprove: SWAP });
    expect(running.store.get(refused.intentId)).toMatchObject({
      state: 'held',
      context: { origin: SWAP },
    });
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);
    await expect(send({ origin: SWAP }, { autoApprove: SWAP })).resolves.toMatchObject({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
    });

    // A confirmation is for one site: confirmed for another, it can't record
    // the payment under swap's name, nor swap's under another's.
    const mint = async (origin, index = 0) =>
      (
        await running.handlers['wallet:confirm-signing']({}, 'dapp-send', index, {
          ...running.tx,
          origin,
        })
      ).token;
    await expect(
      send({ origin: OTHER }, { confirmation: await mint(SWAP) })
    ).resolves.toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    await expect(
      send({ origin: SWAP }, { confirmation: await mint(PLAIN) })
    ).resolves.toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(signed()).toBe(1);
  });

  test("message signing isn't paused: it pays nothing", async () => {
    const running = start();
    running.permissions.setSigningAutoApprove(SWAP, true);
    refusedOnce();
    await running.autoSend(SWAP);
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);

    await expect(
      running.handlers['wallet:sign-message'](
        CHROME_EVENT,
        'hello',
        0,
        fromTab({ autoApprove: SWAP })
      )
    ).resolves.toMatchObject({ success: true, signature: expect.stringMatching(/^0x/) });
  });
});
