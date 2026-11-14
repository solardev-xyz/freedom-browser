// D12 through main's real paths: the identity core's reading of a site's
// contract rule (Q9's limited rule, then the pause main reads, for
// page/page-sends.js, simulated here from the dApp store the core holds
// from APB-2), a page's
// send as main makes it (page/page-sends.js: the silent send a rule answers,
// and one the user confirmed), and main's dispatcher with its prompt, with
// the real permissions store, intent store, payment history and transaction
// service. Chain data and signers are mocked.

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
  webContents: { getAllWebContents: () => [], fromId: () => null },
}));
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
// The identity core's approval tokens (design 0012, APB-1), simulated: main's
// issuer mints through it, and each signer presents its confirmation to it.
const mockApprovals = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => ({
  vaultBackend: {
    get approval() {
      return mockApprovals.approval;
    },
  },
}));
jest.mock('./signers', () => ({
  getSigner: (index, authorized) =>
    mockSigners[index] &&
    require('../../../test/helpers/simulated-approvals').coreCheckedSigner(mockApprovals, mockSigners[index], index, authorized),
}));
const pageOf = (site) => ({ origin: site, top_origin: site, frame: 1, navigation: 1, agent: false });
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

// The transaction a page asks for: no gas or fees of its own.
const PAGE_TX = { to: CONTRACT, data: SELECTOR };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };

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
  mockApprovals.reset();
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
    // The quote a page's send gets on main's prompt: 50,000 gas.
    if (method === 'eth_estimateGas') return { result: '0xc350', source: 'direct' };
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

// What a send answers, as the chrome's handler answered it: the payment, or
// why not (the intent it got as far as, if any).
async function asHandler(sending) {
  try {
    return { success: true, ...(await sending) };
  } catch (err) {
    return { success: false, error: err.message, ...require('./intent-ipc').intentFailure(err) };
  }
}

async function start() {
  jest.resetModules();
  const { ipcMain } = require('electron');
  ipcMain.handle.mockClear();
  const permissions = require('./dapp-permissions');
  const { transactionAutoApprovePaused } = require('./auto-approve-pause');
  require('./wallet-ipc').registerWalletIpc();
  const handlers = Object.fromEntries(ipcMain.handle.mock.calls);
  const { sendDappPayment, createSendDispatchers } = require('../page/page-sends');
  const confirmations = require('./signing-confirmation');

  // The site's contract rule, as the identity core judges it from the dApp
  // store it holds (design 0012, APB-2): the grant exposing the account,
  // Q9's limited rule for the call, and main's D12 reading (`paused`). Fees
  // and Q9's rate aren't judged here (the real core's, in
  // signing-confirmation.integration.test.js).
  mockApprovals.setStanding(null);
  // The grants, and the limited rules "Always allow" gave on each site's
  // prompt, as the core holds them; main's copy read from it.
  mockApprovals.dapp.connect(SWAP, 0, CHAIN);
  mockApprovals.dapp.allowTransaction(SWAP, CONTRACT, SELECTOR, CHAIN, '0');
  mockApprovals.dapp.connect(OTHER, 1, CHAIN);
  mockApprovals.dapp.allowTransaction(OTHER, CONTRACT, SELECTOR, CHAIN, '0');
  mockApprovals.dapp.connect(PLAIN, 0, CHAIN);
  await permissions.refreshPermissions();

  const tx = {
    chainId: CHAIN,
    to: CONTRACT,
    value: '0',
    data: SELECTOR,
    gasLimit: '50000',
    gasPrice: '1000000000',
  };
  const index = { [SWAP]: 0, [OTHER]: 1, [PLAIN]: 0 };
  const wallets = [
    { index: 0, name: 'Alice', address: ALICE.address, type: 'mnemonic' },
    { index: 1, name: 'Bob', address: BOB.address, type: 'mnemonic' },
  ];

  // Main's dispatcher, with a request record of its own: the site's key, a
  // name that holds, a document that holds its key, main's issuer for the
  // approval, and the prompt's decision the test gives.
  const dispatch = createSendDispatchers(
    {
      getPermission: permissions.getPermission,
      updateLastUsed: (context, chainId) =>
        permissions.updateLastUsed(context.requester.key, chainId, context.pageContext()),
      walletList: async () => wallets,
      chainIdOf: () => CHAIN,
      chainName: () => 'Ethereum',
      networks: () => ({ [CHAIN]: { name: 'Ethereum', nativeSymbol: 'ETH' } }),
      agentAnswer: async () => null,
    },
    { inCustody: () => false, isVaultUnlocked: async () => true }
  )['ethereum:eth_sendTransaction'];
  const prompts = [];
  function pageAsks(site, txParams, decision = { approve: true, choices: {} }) {
    let approved = null;
    const handle = (n) => n.toString(16).padStart(64, '0');
    const context = {
      requester: { key: site, guest: 1, window: 1, navigation: 1, chain: null },
      method: 'eth_sendTransaction',
      params: [txParams],
      nameHolds: async () => true,
      holdsKey: () => true,
      prompt: async (spec) => {
        prompts.push({ site, ...spec });
        approved = decision.approve ? handle(prompts.length) : null;
        return decision;
      },
      pageContext: () => pageOf(site),
      // Main's issuer, with the dispatcher's options ("Always allow" among them).
      confirm: (kind, accountIndex, payload, options) =>
        confirmations.issuePageConfirmation(kind, accountIndex, payload, { handle: approved, context: pageOf(site) }, options),
      spend: (confirmation) => confirmation,
      signal: new AbortController().signal,
      leaveWalletSlot: () => {},
    };
    return dispatch(context);
  }

  return {
    tx,
    permissions,
    handlers,
    prompts,
    pageAsks,
    store: require('./intent-store').getIntentStore(),
    // Main's own reading of the site's rule (page/page-sends.js: its match,
    // then the pause): true sends silently, false shows the prompt.
    autoApproves: async (site, { to = CONTRACT, value } = {}) =>
      mockApprovals.dapp.transactionRule(site, to, SELECTOR, CHAIN, value) &&
      !(await transactionAutoApprovePaused(site)),
    // The site's limited contract rule for a call, as the core holds it.
    ruled: (site, to, value = '0') => mockApprovals.dapp.transactionRule(site, to, SELECTOR, CHAIN, value),
    // A send the site's rule answered, as main makes it.
    autoSend: (site) =>
      asHandler(sendDappPayment({ walletIndex: index[site], tx, site, silent: true })),
    // A send the user confirmed on main's prompt (by default on the site's
    // account and chain).
    confirmedSend: (site, { account = index[site], chainId = CHAIN } = {}) =>
      asHandler(sendDappPayment({ walletIndex: account, tx: { ...tx, chainId }, site, silent: false })),
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
    const running = await start();
    await expect(running.autoApproves(SWAP)).resolves.toBe(true);

    // The site's auto-approved payment is refused: it waits, held at its nonce.
    refusedOnce();
    const refused = await running.autoSend(SWAP);
    expect(refused).toMatchObject({ success: false, outcome: 'rejected' });
    expect(running.store.get(refused.intentId).state).toBe('held');

    // The site asks again: main reads its rule as paused, and shows its
    // prompt instead…
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);
    const before = signed();
    await expect(running.pageAsks(SWAP, PAGE_TX, { approve: false })).resolves.toEqual(REJECTED);
    expect(running.prompts.map((prompt) => prompt.kind)).toEqual(['eth.send']);
    expect(signed()).toBe(before);
    // …and a silent send that read the rule before the pause is refused in
    // its turn, with nothing signed.
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
    // Main's dispatcher sends under it again, with no prompt.
    await expect(running.pageAsks(SWAP, PAGE_TX)).resolves.toEqual({ result: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(running.prompts).toHaveLength(1);
  });

  test('a payment sent and not yet mined waits too; once mined, the rule applies again', async () => {
    const running = await start();
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
    const running = await start();
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
    const running = await start();
    await expect(running.autoApproves(PLAIN)).resolves.toBe(false);
    await expect(running.pageAsks(PLAIN, PAGE_TX, { approve: false })).resolves.toEqual(REJECTED);
    expect(running.prompts.map((prompt) => prompt.kind)).toEqual(['eth.send']);
    expect(signed()).toBe(0);

    refusedOnce();
    const refused = await running.confirmedSend(PLAIN);
    expect(refused).toMatchObject({ success: false, outcome: 'rejected' });
    await expect(running.autoApproves(PLAIN)).resolves.toBe(false);
    await expect(running.confirmedSend(PLAIN)).resolves.toMatchObject({ success: true });
  });

  // Review of #788, finding 1: the pause can't be passed twice at once.
  // Review of #788, round 2, finding 2: a dApp payment always has a site.
  // From freedom-core design 0011 PRQ-5b, main's own issuer mints it, for
  // the requester's key; the chrome gets none at all.
  test('codex r2: a dapp confirmation without a site is refused', async () => {
    const running = await start();
    const confirmations = require('./signing-confirmation');
    for (const origin of [undefined, null, '']) {
      await expect(
        confirmations.issuePageConfirmation('dapp-send', 0, { ...running.tx, origin }, { handle: 'c'.repeat(64), context: pageOf(SWAP) })
      ).rejects.toThrow('A dApp payment needs the site it is for');
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
    const running = await start();
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
    const running = await start();
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
    const running = await start();
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
    const running = await start();
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
    const running = await start();
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
    const running = await start();
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
    const running = await start();
    mockSigners[0].signTransaction.mockRejectedValueOnce(new Error('The vault is locked'));
    await expect(running.autoSend(SWAP)).resolves.toMatchObject({ success: false });
    await expect(running.autoApproves(SWAP)).resolves.toBe(true);
    await expect(running.autoSend(SWAP)).resolves.toMatchObject({ success: true });
  });

  // Review of #788, finding 2: the pause reads the site a payment is
  // recorded under, so that is the site that authorized it: from freedom-core
  // design 0011 PRQ-5b, the requester's attested key, which main sends for.
  test('codex: main binds a payment to the site that authorized it', async () => {
    const running = await start();
    // Swap's refused payment, sent under swap's rule, is swap's, and pauses
    // swap alone.
    refusedOnce();
    const refused = await running.autoSend(SWAP);
    expect(running.store.get(refused.intentId)).toMatchObject({
      state: 'held',
      context: { origin: SWAP },
    });
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);
    await expect(running.autoApproves(OTHER)).resolves.toBe(true);
    // The chrome can't confirm a send for it.
    await expect(
      running.handlers['wallet:confirm-signing']({}, 'dapp-send', 0, { ...running.tx, origin: SWAP })
    ).resolves.toMatchObject({ success: false });
    // A page token is for one site: minted for swap, it can't send for plain.
    const confirmations = require('./signing-confirmation');
    const confirmation = await confirmations.issuePageConfirmation('dapp-send', 0, { ...running.tx, origin: SWAP }, {
      handle: 'd'.repeat(64),
      context: pageOf(SWAP),
    });
    const { getSigner } = require('./signers');
    const { buildTransaction } = require('./signing-utils');
    await expect(
      getSigner(0, { confirmation: { ...confirmation, page: pageOf(PLAIN) } }).signTransaction(
        buildTransaction({ ...running.tx, nonce: 0 })
      )
    ).rejects.toThrow('Signing was not confirmed');
    expect(signed()).toBe(1);
  });

  // The core reads a page's signing rule (design 0012, APB-2: Q9's limited
  // rule, page/page-signing.js), which the pause never touches.
  test("message signing isn't paused: it pays nothing", async () => {
    const running = await start();
    await running.permissions.setSigningAutoApprove(SWAP, true, pageOf(SWAP));
    refusedOnce();
    await running.autoSend(SWAP);
    await expect(running.autoApproves(SWAP)).resolves.toBe(false);
    expect(mockApprovals.dapp.signingRule(SWAP)).toBe(true);
    expect(running.permissions.getSigningAutoApprove(SWAP)).toBe(true);
  });

  // Q9 (design 0012, APB-2): today's rule, with no time, answers nothing
  // once the core writes the dApp file; "Always allow" at the prompt it
  // shows writes the limited rule, which answers, and the pause still holds.
  test("today's unlimited rule prompts; the limited rule its prompt gives answers, paused as any", async () => {
    const running = await start();
    const TODAY = 'https://today.example';
    mockApprovals.dapp.seed(TODAY, {
      origin: TODAY,
      connectedAt: 1,
      lastUsed: 1,
      walletIndex: 0,
      chainId: CHAIN,
      autoApprove: { signing: false, transactions: [{ to: CONTRACT, selector: SELECTOR, chainId: CHAIN, maxValue: '0' }] },
    });
    await running.permissions.refreshPermissions();
    await expect(running.autoApproves(TODAY)).resolves.toBe(false);
    const confirmed = await running.pageAsks(TODAY, PAGE_TX, { approve: true, choices: { alwaysAllow: true } });
    expect(confirmed).toEqual({ result: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(running.prompts).toHaveLength(1);
    // The limited rule, and today's for the same call cleared in the same write.
    expect(mockApprovals.dapp.entry(TODAY).autoApprove.transactions).toEqual([]);
    expect(mockApprovals.dapp.entry(TODAY).autoApprove.limited.transactions).toEqual([
      { to: CONTRACT, selector: SELECTOR, chainId: CHAIN, maxValue: '0', grantedAt: expect.any(Number) },
    ]);
    // Its own payment waits: paused until it is mined; then the rule answers.
    await expect(running.autoApproves(TODAY)).resolves.toBe(false);
    await mine(confirmed.result);
    await expect(running.autoApproves(TODAY)).resolves.toBe(true);
    await expect(running.pageAsks(TODAY, PAGE_TX)).resolves.toEqual({ result: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(running.prompts).toHaveLength(1);
  });
});

// "Always allow" for a transaction, through main's dispatcher
// (page/page-sends.js): the rule is recorded for the requester's key, from
// the send the user confirmed on main's prompt, and covers its call with no
// more value than that send's.
describe('"Always allow" binds the confirmed send\'s value and site', () => {
  const PAYABLE = '0x' + '77'.repeat(20);
  const CENT = '0x2386f26fc10000'; // 0.01 ETH
  const TWO_CENTS = '0x470de4df820000';
  const ALWAYS = { approve: true, choices: { alwaysAllow: true, feeAcknowledged: false } };

  test('a rule from a send of 0.01 ETH signs that call for 0.01 ETH, and asks for more', async () => {
    const running = await start();
    const payment = { to: PAYABLE, value: CENT, data: SELECTOR };
    // PLAIN has no rule: main prompts, and "always allow" records one.
    const confirmed = await running.pageAsks(PLAIN, payment, ALWAYS);
    expect(confirmed).toEqual({ result: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(running.prompts).toHaveLength(1);
    await mine(confirmed.result);

    const ask = (value) => running.autoApproves(PLAIN, { to: PAYABLE, value });
    await expect(ask(CENT)).resolves.toBe(true);
    await expect(ask(TWO_CENTS)).resolves.toBe(false);

    // The same call for 0.01 ETH: sent under the rule, with no prompt.
    const same = await running.pageAsks(PLAIN, payment);
    expect(same).toEqual({ result: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(running.prompts).toHaveLength(1);
    await mine(same.result);
    // For more: main's prompt again.
    await expect(running.pageAsks(PLAIN, { ...payment, value: TWO_CENTS }, { approve: false })).resolves.toEqual(REJECTED);
    expect(running.prompts).toHaveLength(2);
    expect(signed()).toBe(2);
  });

  test("a confirmed send for one site records no rule for another site", async () => {
    const running = await start();
    const payment = { to: PAYABLE, data: SELECTOR };
    await expect(running.pageAsks(PLAIN, payment, ALWAYS)).resolves.toEqual({ result: expect.any(String) });
    // The rule is the requester's: PLAIN's, never SWAP's, on the same account.
    expect(running.ruled(PLAIN, PAYABLE)).toBe(true);
    expect(running.ruled(SWAP, PAYABLE)).toBe(false);
    // Without "always allow", none.
    await expect(running.pageAsks(SWAP, payment, { approve: true, choices: { alwaysAllow: false } })).resolves.toEqual({
      result: expect.any(String),
    });
    expect(running.ruled(SWAP, PAYABLE)).toBe(false);
  });
});
