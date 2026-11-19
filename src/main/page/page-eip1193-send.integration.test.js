/**
 * Page sends through the real freedom-cored's eip1193.request (freedom-core
 * design 0012, APB-4c): `eth_sendTransaction` goes to the core, which
 * prepares it through its own chain machine (`eth_estimateGas` x 120 / 100,
 * its own fee quote and fee check, here from a local JSON-RPC node behind
 * chain 100's two endpoints), shows its `eth.send` prompt through main
 * (page-eip1193.js) or answers it by the site's rule, and answers main
 * `{ send }` for a vault account or `{ device }` for a Ledger's, a phone's
 * or a Safe's. Main adds the nonce, and only the nonce
 * (page-core-sends.js). Here main's signing step is a stand-in that
 * presents the transaction to the real core's `sign.transaction` with the
 * token or `{ standing }`; a Ledger is a stand-in device that spends the
 * core's token through the real core first (`approval.spend`) and presents
 * its receipt (`approval.remember`); a phone's job is the real core's
 * (`phone.job`); and a Safe's send spends its token for the real core's
 * Safe approval. A test seam on the core client's handlers crosses main's
 * answers, and one in the signing stand-in changes the transaction: each is
 * refused, with nothing signed.
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/page/page-eip1193-send.integration
 * or FREEDOM_CORED_APPROVALS_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { HDNodeWallet, Wallet, Transaction, getAddress } = require('ethers');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
// A real core reads its chain on real timers.
jest.setTimeout(30_000);

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
// A device's key: what the Ledger stand-in signs with, and the phone's address.
const DEVICE = new Wallet('0x' + '42'.repeat(32));
const LEDGER_INDEX = 1000000;
const PHONE_INDEX = 1000001;
const SAFE_INDEX = 5000;
const SAFE_ADDRESS = '0x' + 'aa'.repeat(20);
const PHONE_CHROME = 7;
const CHROME_URL = 'file:///app/src/renderer/index.html';
const GWEI = 1_000_000_000n;
// The node's legacy gas price (no priority fee): the core's headroom and
// least tip make the 20 gwei it quotes, as in the core's own daemon test.
const NODE_PRICE = 15_960_000_000n;
const QUOTED_PRICE = (20n * GWEI).toString();
// The node's estimate, 17,500: x 120 / 100 is the gas limit 21,000.
const ESTIMATE = '0x445c';
const GAS_LIMIT = '21000';
// The nonce main adds, the only field it may.
const NONCE = 7;
// The page's contract call: an ERC-20 approve, with value.
const CONTRACT = '0x' + 'ab'.repeat(20);
const SELECTOR = '0x095ea7b3';
const APPROVE_DATA = SELECTOR + '55'.repeat(20).padStart(64, '0') + (1000).toString(16).padStart(64, '0');
const CALL = { to: CONTRACT, value: '0x5', data: APPROVE_DATA };
const NO_ADDRESS = { code: 4100, message: 'This page has no address to connect from yet' };
const REJECTED = { code: 4001, message: 'User rejected the request' };
const MISMATCH = { code: -32603, message: 'Signing was not confirmed: request differs from what was confirmed' };
// The core's refusal of a crossed approval.request answer, as the page gets it.
const CROSSED = { code: -32603, message: "main's answer isn't the decision on this request's prompt" };
const HASH = /^0x[0-9a-f]{64}$/;
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

/**
 * Chain 100's node: the estimate, a legacy gas price (`eth_maxPriorityFeePerGas`
 * unknown, so the core quotes type 0) and the chain's id; every other method
 * is unknown. The price can change between requests. Every method asked is
 * recorded.
 */
async function node() {
  const state = { gasPrice: NODE_PRICE, seen: [] };
  const answerOf = (method) => {
    if (method === 'eth_chainId') return { result: '0x64' };
    if (method === 'eth_estimateGas') return { result: ESTIMATE };
    if (method === 'eth_gasPrice') return { result: `0x${state.gasPrice.toString(16)}` };
    return { error: { code: -32601, message: 'the method does not exist' } };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const { id, method } = JSON.parse(body);
      state.seen.push(method);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id, ...answerOf(method) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}

/**
 * Chain 100's snapshot (design 0005, Configuration): read Direct from two
 * endpoints, so the fee evidence isn't one endpoint's word, as a rule's fee
 * check needs (the core's daemon test's quorum).
 */
const gnosis = () => ({
  chain_id: 100,
  display_name: 'Gnosis Chain',
  read_order: ['direct'],
  broadcast_order: ['direct'],
  quorum: { k: 3, m: 2, timeout_ms: 5000 },
  rpc: [
    { endpoint: 'e100a', user_configured: false },
    { endpoint: 'e100b', user_configured: false },
  ],
  prover: null,
  myotis: false,
  blockscout: null,
});

describeIfBinary('page sends through the real freedom-cored\'s eip1193.request (0012 APB-4c)', () => {
  let root;
  let core;
  let sc;
  let vaultBackend;
  let rpc;
  let env;
  const chain = { generation: 0 };
  // D12's pause, as main's `transactionAutoApprovePaused` would read it.
  const state = { paused: false };
  // Test seams on main's handlers for the core's requests: `before(method,
  // params)` runs first, `cross(method, params, answer)` may change main's
  // answer.
  const seams = { before: null, cross: null };
  // What main did after the core's answer: the core's `{ send }` and
  // `{ device }` answers (the token left out), each transaction presented to
  // `sign.transaction` and its authorization (the token left out), each
  // signature made, each refusal's reason, each token spent (the token left
  // out), each phone job opened, each Safe send started, each receipt
  // presented, each last use written, each signed send main's guard let
  // through to the journal and broadcast (`committed`), and each answer of
  // the core's `approval.check` to main's rule read for a rule's send.
  // `edit` changes the transaction main presents; `alter` the confirmation
  // a device spends; `afterSign` runs once a signature is made, before
  // main's guard after it.
  const paid = {
    replies: [],
    turns: [],
    presented: [],
    signed: [],
    committed: [],
    ruleChecks: [],
    afterSign: null,
    refused: [],
    spends: [],
    jobs: [],
    safes: [],
    remembered: [],
    touched: [],
    edit: null,
    alter: null,
  };
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
  // The core's answer to main, as recorded: a `{ send }` or `{ device }`
  // without its token.
  const recorded = (reply) => {
    for (const form of ['send', 'device']) {
      if (reply?.[form]?.token !== undefined) return { [form]: withoutToken(reply[form]) };
    }
    return reply;
  };
  // The core's client as the relay holds it, its answers to the sends'
  // `eip1193.request` recorded.
  const recording = (client) => ({
    request: async (method, params, ...rest) => {
      const reply = await client.request(method, params, ...rest);
      if (method === 'eip1193.request' && params?.method === 'eth_sendTransaction') paid.replies.push(recorded(reply));
      return reply;
    },
    holdWatchdog: (generation, id) => client.holdWatchdog(generation, id),
  });
  // Main's own `chain.fee_reference` for chain 100, which the core keeps as
  // its fee evidence.
  const feeReference = () =>
    core.request('chain.fee_reference', { chain_id: 100, deadline_ms: 30_000 }, { caller: 'chrome' }, { watchdogMs: 60_000 });

  /**
   * Main's signing and recording step (tx-recorder.js's `signAndRecord`), as
   * a stand-in: the transaction built with the nonce, as main builds every
   * send, then by the signer's account a vault signature from the real
   * core, a Ledger's spend and device signature, or a phone's job. The
   * signed bytes are "recorded" (`guardCommit`, then `onCommitted`) and the
   * hash returned.
   */
  async function signAndRecord(tx, signer, _context, options) {
    const { index, authorized } = signer;
    const { buildTransaction } = require('../wallet/signing-utils');
    const built = buildTransaction({ ...tx, nonce: NONCE });
    if (index === PHONE_INDEX) return phoneJob(authorized);
    let signed;
    if (index === LEDGER_INDEX) signed = await ledgerSigned(built, authorized);
    else signed = await vaultSigned(index, built, authorized);
    paid.signed.push(signed);
    await paid.afterSign?.();
    const commit = async () => {
      paid.committed.push(signed.hash);
    };
    await (options.guardCommit ? options.guardCommit(commit) : commit());
    options.onCommitted?.();
    return { hash: signed.hash, recorded: true };
  }

  // A vault account's signature: the core's form, changed by `edit` if a
  // test says so, presented with the token (`signingAuthorization`) or
  // under the site's rule (`{ standing }`), as signers.js presents it.
  async function vaultSigned(index, built, authorized) {
    const { toCoreTransaction } = require('../wallet/signing-utils');
    const { tx } = toCoreTransaction(built);
    paid.edit?.(tx);
    const options = authorized.confirmation
      ? sc.signingAuthorization(authorized.confirmation)
      : { authorization: { standing: { ...authorized.standing } }, page: authorized.page };
    const { token, ...authorization } = options.authorization;
    if (authorized.confirmation) expect(typeof token).toBe('string');
    paid.presented.push({ tx: { ...tx }, authorization, page: options.page });
    let reply;
    try {
      reply = await vaultBackend.sign.transaction({ kind: 'account', index }, tx, options);
    } catch (err) {
      const refusal = sc.confirmationError(err);
      paid.refused.push(refusal.reason || refusal.code || 'error');
      throw refusal;
    }
    const signed = Transaction.from(reply.raw);
    expect(signed.from).toBe(VAULT_ACCOUNT);
    expect(signed.hash).toBe(reply.hash);
    authorized.onRule?.(reply.rule ?? null);
    return signed;
  }

  // A Ledger stand-in: the core's token spent through the core first, with
  // the payload main presents (or `alter`'s), its finalize receipt handed to
  // main, and the device asked only after.
  async function ledgerSigned(built, authorized) {
    const { confirmation } = authorized;
    paid.spends.push(withoutToken(confirmation));
    let spent;
    try {
      spent = await sc.spendConfirmation(paid.alter ? paid.alter(confirmation) : confirmation);
    } catch (err) {
      paid.refused.push(err.reason || err.code || 'error');
      throw err;
    }
    authorized.onReceipt?.(sc.finalizeReceiptOf(spent, confirmation.page));
    return Transaction.from(await DEVICE.signTransaction(built));
  }

  // A phone: the core's job opened with the token and the payload main
  // presents (or `alter`'s); the stand-in's phone then declines, and the job
  // ends in the core with nothing sent.
  async function phoneJob(authorized) {
    const { confirmation } = authorized;
    paid.spends.push(withoutToken(confirmation));
    const presented = paid.alter ? paid.alter(confirmation) : confirmation;
    const { authorization, page } = sc.signingAuthorization(presented);
    let opened;
    try {
      opened = await vaultBackend.phone.job(
        {
          account: presented.account,
          address: DEVICE.address,
          method: 'transaction',
          payload: presented.payload,
          target: PHONE_CHROME,
          authorization,
        },
        page
      );
    } catch (err) {
      paid.refused.push(err.data?.reason || err.code || 'error');
      throw sc.confirmationError(err);
    }
    paid.jobs.push(opened.request);
    await vaultBackend.phone.result({ job: opened.job, sender: PHONE_CHROME, error: { code: 4001 } }).catch(() => {});
    throw Object.assign(new Error('The phone declined'), { code: 'REMOTE_USER_REJECTED' });
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eip1193-send-'));
    rpc = await node();
    jest.resetModules();
    const { CoreClient } = require('../core/core-client');
    const { registerChainShell } = require('../core/chain-shell');
    const { makeHop } = require('../core/naming-shell');
    core = new CoreClient({
      spawn,
      command: binary,
      args: [
        'serve',
        '--data-dir',
        path.join(root, 'identity'),
        '--lock-dir',
        path.join(root, 'locks'),
        '--parent-pid',
        String(process.pid),
      ],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    sc = require('../wallet/signing-confirmation');
    ({ vaultBackend } = require('../core/vault-backend'));
    // Chain 100's two endpoints, both the local node.
    const urls = { e100a: `${rpc.base}/a`, e100b: `${rpc.base}/b` };
    registerChainShell(
      core,
      {
        endpoint: (ref) => (urls[ref] ? { url: urls[ref], chainId: 100 } : null),
        generation: () => chain.generation,
      },
      { hop: makeHop({ fetch }) }
    );
    const { createEip1193Relay } = require('./page-eip1193');
    const relay = createEip1193Relay({
      coreClient: () => recording(core),
      identityWalletEnabled: () => true,
      selectedChainOf: () => 100,
      getDerivedWallets: async () => wallets,
      networks: () => ({ 1: { name: 'Ethereum', nativeSymbol: 'ETH' }, 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } }),
      isChainAvailable: (chainId) => [1, 100].includes(Number(chainId)),
      getActiveWalletIndex: () => 0,
      rulePaused: async () => state.paused,
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
    const { generations } = await core.request(
      'chain.configure',
      { chains: [gnosis()] },
      { caller: 'chrome' },
      { watchdogMs: 60_000 }
    );
    chain.generation = generations['100'];
    await vaultBackend.importVault('testpass1', ABANDON);
  });

  afterAll(async () => {
    await core?.stop();
    await rpc?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    seams.before = null;
    seams.cross = null;
    state.paused = false;
    for (const [name, value] of Object.entries(paid)) paid[name] = Array.isArray(value) ? [] : null;
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
        getDerivedWallets: async () => wallets,
        // Main's copy of the grants: the core's file, read now.
        getPermission: (site) => grants()[site] || null,
        // A page's last use, written by the core under its PageContext.
        updateLastUsed: (site, chainId, page) => {
          const reply = vaultBackend.approval.touch(
            { store: 'dapp', ...(chainId !== undefined ? { chain_id: chainId } : {}) },
            page
          );
          paid.touched.push({ site, reply });
          return reply;
        },
        signing: { inCustody: () => false },
        sends: { inCustody: () => false },
        deviceDeps: { walletList: async () => wallets },
        coreSendDeps: {
          takeSiteTurn: async (site, { wait }) => {
            paid.turns.push([site, wait]);
            return () => {};
          },
          sitePaymentWaiting: async () => false,
          getSigner: (index, authorized) => ({ index, authorized }),
          signAndRecord,
          // The real core's reading of the site's rule.
          checkStanding: async (page, request) => {
            const answer = await sc.checkStanding(page, request);
            paid.ruleChecks.push(answer);
            return answer;
          },
          rememberDeviceSend: (held) => {
            paid.remembered.push(held.page);
            return sc.rememberDeviceSend(held);
          },
          discardToken: (token) => sc.discardConfirmation(token),
          // A Safe's token, spent for the core's Safe approval.
          spendSafe: (confirmation) => {
            paid.spends.push(withoutToken(confirmation));
            return sc.spendSafeConfirmation(confirmation);
          },
          reserveSafeSend: () => ({ release: () => {} }),
          // The Safe stand-in stops once it has its approval.
          startSafeSend: async (options) => {
            paid.safes.push(options);
            throw new Error('The Safe stand-in stops here');
          },
          onSafeSendSettled: () => () => {},
          guardSiteSafeSend: () => () => {},
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
    // A send asked and decided: its prompt and the page's answer.
    const send = async (page, choices = {}, params = [CALL]) => {
      const asked = asking(page, 'eth_sendTransaction', params);
      const shown = await asked.prompt();
      expect(await decide(shown.handle, true, choices)).toEqual({ ok: true });
      return { shown, answer: await asked.answer };
    };
    Object.assign(env, { requests, tab, prompts, decide, asking, connected, send, sent });
  });

  // The transaction the core prepares for CALL, in sign.transaction's form
  // without a nonce: the page's call as the page wrote it, the estimate
  // plus 20%, the quote.
  const PREPARED = {
    type: 0,
    chain_id: '100',
    to: CONTRACT,
    value: '5',
    data: APPROVE_DATA,
    gas_limit: GAS_LIMIT,
    gas_price: QUOTED_PRICE,
  };
  // As main presents it: the nonce added. Main's build writes `to`
  // checksummed, the same address, which the core binds as bytes.
  const PRESENTED = { ...PREPARED, to: getAddress(CONTRACT), nonce: String(NONCE) };

  test('a vault send: main\'s eth.send prompt from the core\'s view (its gas limit, its quote, the chain\'s symbol); the approve gets { send }, which the core signs with only the nonce added; the page gets the hash; "Always allow" on a contract call writes Q9\'s limited rule', async () => {
    const site = key('a');
    const page = await env.connected(`${site}/app`, 0);
    const asked = env.asking(page, 'eth_sendTransaction', [CALL]);
    const shown = await asked.prompt();
    expect(shown).toMatchObject({
      kind: 'eth.send',
      site: { key: site },
      view: {
        account: { index: 0, name: 'Main Wallet', address: VAULT_ACCOUNT, type: 'mnemonic' },
        chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
        tx: { to: getAddress(CONTRACT), value: '5', data: APPROVE_DATA },
        fee: { gasLimit: GAS_LIMIT, gasPrice: QUOTED_PRICE, estimate: (21000n * 20n * GWEI).toString() },
        // The core's verdict on its own evidence, two endpoints' word.
        feeCheck: { comparable: true, ratio: '1', above: false, oneEndpoint: false, basis: 'quote', autoApprove: true },
        feeAskAgain: false,
        alwaysAllow: true,
      },
    });
    expect(rpc.seen).toEqual(expect.arrayContaining(['eth_estimateGas', 'eth_gasPrice']));
    expect(grants()[site].autoApprove?.limited?.transactions ?? []).toEqual([]);
    expect(await env.decide(shown.handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    const { result } = await asked.answer;
    expect(result).toMatch(HASH);

    // The core's { send }: the prepared transaction, no nonce, for the
    // approve's handle.
    expect(paid.replies.at(-1)).toEqual({
      send: { kind: 'dapp-send', account: 0, tx: PREPARED, handle: shown.handle },
    });
    // Main presented it with the nonce, and only the nonce, added, with the
    // token for that kind and handle, under the request's PageContext.
    expect(paid.turns).toEqual([[site, true]]);
    expect(paid.presented).toEqual([
      {
        tx: PRESENTED,
        authorization: { kind: 'dapp-send', handle: shown.handle },
        page: expect.objectContaining({ origin: site, top_origin: site, agent: false }),
      },
    ]);
    const [signed] = paid.signed;
    expect(signed).toMatchObject({
      hash: result,
      from: VAULT_ACCOUNT,
      type: 0,
      chainId: 100n,
      nonce: NONCE,
      gasLimit: 21000n,
      gasPrice: 20n * GWEI,
      value: 5n,
      data: APPROVE_DATA,
    });
    expect(signed.to.toLowerCase()).toBe(CONTRACT);

    // "Always allow" on a contract call: the core wrote Q9's limited rule as
    // it signed.
    expect(grants()[site].autoApprove.limited.transactions).toEqual([
      { to: CONTRACT, selector: SELECTOR, chainId: 100, maxValue: '5', grantedAt: expect.any(Number) },
    ]);
  });

  test('main can add only the nonce: any other field of { send } changed is the core\'s mismatch, nothing signed and the page\'s -32603; with only the nonce it signs', async () => {
    const page = await env.connected(`${key('b')}/app`, 0);
    const edits = {
      type: (tx) => {
        tx.type = 2;
        tx.max_fee_per_gas = tx.gas_price;
        tx.max_priority_fee_per_gas = tx.gas_price;
        delete tx.gas_price;
      },
      chain_id: (tx) => {
        tx.chain_id = '1';
      },
      to: (tx) => {
        tx.to = getAddress('0x' + '55'.repeat(20));
      },
      value: (tx) => {
        tx.value = '6';
      },
      data: (tx) => {
        tx.data = '0x095ea7b4' + tx.data.slice(10);
      },
      gas_limit: (tx) => {
        tx.gas_limit = '21001';
      },
      gas_price: (tx) => {
        tx.gas_price = (BigInt(tx.gas_price) + 1n).toString();
      },
    };
    for (const [field, edit] of Object.entries(edits)) {
      paid.edit = edit;
      const { answer } = await env.send(page);
      expect([field, answer]).toEqual([field, { error: MISMATCH }]);
    }
    expect(paid.refused).toEqual(Array(7).fill('mismatch'));
    expect(paid.presented).toHaveLength(7);
    expect(paid.signed).toEqual([]);

    paid.edit = null;
    const { answer } = await env.send(page);
    expect(answer.result).toBe(paid.signed[0].hash);
    const { tx } = paid.replies.at(-1).send;
    expect(paid.presented.at(-1).tx).toEqual({ ...tx, to: getAddress(tx.to), nonce: String(NONCE) });
  });

  test('a crossed eth.send answer sends nothing and the core mints no token: another prompt\'s id, or a handle an earlier answer named; a reject answers 4001', async () => {
    const site = key('c');
    const page = await env.connected(`${site}/app`, 0);
    // A reject: 4001, and its handle is named.
    const rejected = env.asking(page, 'eth_sendTransaction', [CALL]);
    const rejectedShown = await rejected.prompt();
    expect(await env.decide(rejectedShown.handle, false)).toEqual({ ok: true });
    expect(await rejected.answer).toEqual({ error: REJECTED });

    seams.cross = (method, params, answer) =>
      method === 'approval.request' && answer.approve ? { ...answer, prompt: 'f'.repeat(32) } : answer;
    const crossed = await env.send(page, { alwaysAllow: true });
    expect(crossed.answer).toEqual({ error: CROSSED });

    seams.cross = (method, params, answer) =>
      method === 'approval.request' && answer.approve ? { ...answer, handle: rejectedShown.handle } : answer;
    const reused = await env.send(page, { alwaysAllow: true });
    expect(reused.answer).toEqual({ error: CROSSED });

    // No { send } reached main: nothing presented, signed or written.
    expect(paid.replies).toEqual([{ error: REJECTED }]);
    expect(paid.turns).toEqual([]);
    expect(paid.presented).toEqual([]);
    expect(paid.signed).toEqual([]);
    expect(grants()[site].autoApprove?.limited?.transactions ?? []).toEqual([]);
  });

  test('a fee asked again: the core\'s evidence lowered while the prompt is open, the approve gets the core\'s new prompt with feeAskAgain; its approve with feeAcknowledged sends', async () => {
    const page = await env.connected(`${key('d')}/app`, 0);
    const asked = env.asking(page, 'eth_sendTransaction', [CALL]);
    const first = await asked.prompt();
    expect(first.view).toMatchObject({ feeAskAgain: false, feeCheck: expect.objectContaining({ above: false }) });
    try {
      // The node's price falls, and main's own fee reference, taken while
      // the prompt is open, becomes the core's evidence.
      rpc.gasPrice = GWEI;
      await feeReference();
      const seen = env.prompts().length;
      // The first decision is answered with the request, once the second is.
      const firstDecided = env.decide(first.handle, true, {});
      await until(() => env.prompts().length > seen);
      const again = env.prompts()[seen];
      expect(again.kind).toBe('eth.send');
      expect(again.handle).not.toBe(first.handle);
      expect(again.view).toMatchObject({
        feeAskAgain: true,
        fee: first.view.fee,
        feeCheck: { ratio: '15', above: true, oneEndpoint: false, autoApprove: false, askAgain: true },
      });
      // A pick the core doesn't offer is refused, with the prompt still open.
      expect(await env.decide(again.handle, true, { feeAcknowledged: 'yes' })).toMatchObject({ ok: false });
      expect(await env.decide(again.handle, true, { feeAcknowledged: true })).toEqual({ ok: true });
      expect(await firstDecided).toEqual({ ok: true });
      const { result } = await asked.answer;
      expect(result).toBe(paid.signed[0].hash);
      expect(paid.replies.at(-1)).toEqual({
        send: { kind: 'dapp-send', account: 0, tx: PREPARED, handle: again.handle },
      });
      expect(paid.presented).toHaveLength(1);
      expect(paid.presented[0].authorization).toEqual({ kind: 'dapp-send', handle: again.handle });
    } finally {
      // The evidence back at the node's usual price, for the tests after.
      rpc.gasPrice = NODE_PRICE;
      await feeReference();
    }
  });

  test('a rule\'s send: the call "Always allow" covers is answered { send, standing } with no prompt, signed under { standing: { paused: false } } in the site\'s turn without waiting, then the last use; with D12\'s pause (world.paused) it is asked', async () => {
    const site = key('e');
    const page = await env.connected(`${site}/app`, 0);
    const ticked = await env.send(page, { alwaysAllow: true });
    expect(ticked.answer.result).toMatch(HASH);
    expect(grants()[site].autoApprove.limited.transactions).toHaveLength(1);

    const prompted = env.prompts().length;
    const ruled = await page.ask('eth_sendTransaction', [CALL]);
    expect(ruled.result).toBe(paid.signed[1].hash);
    expect(env.prompts()).toHaveLength(prompted);
    expect(paid.replies.at(-1)).toEqual({ send: { kind: 'dapp-send', account: 0, tx: PREPARED, standing: true } });
    expect(paid.turns).toEqual([
      [site, true],
      [site, false],
    ]);
    expect(paid.presented[1]).toEqual({
      tx: PRESENTED,
      authorization: { standing: { paused: false } },
      page: expect.objectContaining({ origin: site, agent: false }),
    });
    expect(paid.touched.map((touch) => touch.site)).toEqual([site]);
    await expect(paid.touched[0].reply).resolves.toEqual(expect.any(Object));

    // Paused: the core reads world.paused and asks; a reject signs nothing.
    state.paused = true;
    const paused = env.asking(page, 'eth_sendTransaction', [CALL]);
    const shown = await paused.prompt();
    expect(shown).toMatchObject({ kind: 'eth.send', view: { alwaysAllow: true, tx: { to: getAddress(CONTRACT) } } });
    expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
    expect(await paused.answer).toEqual({ error: REJECTED });
    expect(paid.signed).toHaveLength(2);
    expect(paid.touched).toHaveLength(1);
  });

  test('a rule\'s send, its rule read again around the core\'s signature (approval.check): the burst\'s fifth goes out though its own slot spent the rate, and the sixth is asked; a rule revoked between the signature and the journal sends nothing', async () => {
    const site = key('g');
    const page = await env.connected(`${site}/app`, 0);
    expect((await env.send(page, { alwaysAllow: true })).answer.result).toMatch(HASH);
    // R-6's burst of five, each counted by its signature under { standing }.
    for (let sent = 0; sent < 5; sent += 1) {
      const ruled = await page.ask('eth_sendTransaction', [CALL]);
      expect(ruled.result).toBe(paid.signed.at(-1).hash);
    }
    expect(paid.committed).toHaveLength(6);
    expect(paid.touched).toHaveLength(5);
    // Before and after each signature: the fifth's after reads the rate its
    // own slot spent, which stands.
    expect(paid.ruleChecks).toHaveLength(10);
    expect(paid.ruleChecks.slice(0, 9)).toEqual(Array(9).fill({ covered: true, reason: null }));
    expect(paid.ruleChecks[9]).toEqual({ covered: false, reason: 'rate_limited' });
    // The sixth is past the rate: the core asks, and a reject signs nothing.
    const sixth = env.asking(page, 'eth_sendTransaction', [CALL]);
    const shown = await sixth.prompt();
    expect(shown.kind).toBe('eth.send');
    expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
    expect(await sixth.answer).toEqual({ error: REJECTED });
    expect(paid.signed).toHaveLength(6);

    // Another site's rule, revoked by the chrome while the core signs: the
    // signature is made, but main's read after it withholds it.
    const other = key('h');
    const otherPage = await env.connected(`${other}/app`, 0);
    expect((await env.send(otherPage, { alwaysAllow: true })).answer.result).toMatch(HASH);
    const committed = paid.committed.length;
    paid.afterSign = () =>
      vaultBackend.approval.revoke(
        { store: 'dapp', key: other, what: { transaction: { to: CONTRACT, selector: SELECTOR, chain_id: 100 } } },
        'chrome'
      );
    expect(await otherPage.ask('eth_sendTransaction', [CALL])).toEqual({
      error: { code: -32603, message: "Signing was not confirmed: this request is not covered by the site's auto-approve rules" },
    });
    expect(paid.signed).toHaveLength(8);
    expect(paid.committed).toHaveLength(committed);
    expect(paid.ruleChecks.at(-2)).toEqual({ covered: true, reason: null });
    expect(paid.ruleChecks.at(-1).covered).toBe(false);
    expect(paid.touched).toHaveLength(5);
  });

  test('a Ledger\'s send: { device } with the core\'s payload, spent through the core before the device signs, and its receipt presented with approval.remember writes the rule; an altered payload\'s spend is refused, nothing signed', async () => {
    const site = key('f');
    const page = await env.connected(`${site}/app`, LEDGER_INDEX);
    const asked = env.asking(page, 'eth_sendTransaction', [CALL]);
    const shown = await asked.prompt();
    expect(shown.view).toMatchObject({
      account: { index: LEDGER_INDEX, type: 'ledger' },
      fee: { gasLimit: GAS_LIMIT, gasPrice: QUOTED_PRICE },
      alwaysAllow: true,
    });
    expect(await env.decide(shown.handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    const { result } = await asked.answer;
    expect(paid.replies.at(-1)).toEqual({
      device: { type: 'ledger', kind: 'dapp-send', account: LEDGER_INDEX, payload: { tx: PREPARED }, handle: shown.handle },
    });
    const page0 = expect.objectContaining({ origin: site, top_origin: site, agent: false });
    expect(paid.spends).toEqual([
      { kind: 'dapp-send', account: LEDGER_INDEX, payload: { tx: PREPARED }, handle: shown.handle, page: page0 },
    ]);
    expect(paid.signed[0]).toMatchObject({ hash: result, from: DEVICE.address, nonce: NONCE, gasPrice: 20n * GWEI });
    // The receipt, under the PageContext the token was spent under: the rule.
    expect(paid.remembered).toEqual([page0]);
    expect(grants()[site].autoApprove.limited.transactions).toEqual([
      { to: CONTRACT, selector: SELECTOR, chainId: 100, maxValue: '5', grantedAt: expect.any(Number) },
    ]);
    expect(paid.presented).toEqual([]);

    // The spend binds the core's payload: another one is refused, and the
    // device is never asked.
    paid.alter = (confirmation) => ({
      ...confirmation,
      payload: { tx: { ...confirmation.payload.tx, value: '6' } },
    });
    const altered = await env.send(page);
    expect(altered.answer).toEqual({ error: MISMATCH });
    expect(paid.refused).toEqual(['mismatch']);
    expect(paid.signed).toHaveLength(1);
    expect(paid.remembered).toHaveLength(1);
  });

  test('a phone\'s send: no fee check, and the core\'s job opened with the token and the core\'s payload; an altered payload opens none', async () => {
    const site = key('7');
    const page = await env.connected(`${site}/app`, PHONE_INDEX);
    const asked = env.asking(page, 'eth_sendTransaction', [CALL]);
    const shown = await asked.prompt();
    expect(shown.view).toMatchObject({
      account: { index: PHONE_INDEX, type: 'remote' },
      fee: { gasLimit: GAS_LIMIT, gasPrice: QUOTED_PRICE },
      feeCheck: null,
    });
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    // The stand-in's phone declines once the job is open.
    expect(await asked.answer).toEqual({ error: REJECTED });
    expect(paid.replies.at(-1)).toEqual({
      device: { type: 'remote', kind: 'dapp-send', account: PHONE_INDEX, payload: { tx: PREPARED }, handle: shown.handle },
    });
    expect(paid.spends).toEqual([
      expect.objectContaining({ kind: 'dapp-send', account: PHONE_INDEX, payload: { tx: PREPARED }, handle: shown.handle }),
    ]);
    expect(paid.jobs).toHaveLength(1);
    expect(paid.jobs[0].method).toBe('eth_sendTransaction');
    expect(paid.jobs[0].params[0]).toMatchObject({ from: DEVICE.address, value: '0x5', data: APPROVE_DATA, chainId: '0x64' });
    expect(paid.jobs[0].params[0].to.toLowerCase()).toBe(CONTRACT);

    paid.alter = (confirmation) => ({
      ...confirmation,
      payload: { tx: { ...confirmation.payload.tx, to: getAddress('0x' + '55'.repeat(20)) } },
    });
    const altered = await env.send(page);
    expect(altered.answer).toEqual({ error: MISMATCH });
    expect(paid.refused).toEqual(['mismatch']);
    expect(paid.jobs).toHaveLength(1);
    expect(paid.signed).toEqual([]);
  });

  test('a Safe\'s send: unquoted, its safe-send token spent for the core\'s Safe approval, which starts its SafeTx', async () => {
    const site = key('9');
    const page = await env.connected(`${site}/app`, SAFE_INDEX);
    const asked = env.asking(page, 'eth_sendTransaction', [CALL]);
    const shown = await asked.prompt();
    expect(shown.view).toMatchObject({
      account: { index: SAFE_INDEX, type: 'safe' },
      fee: { paidBy: 'executor' },
      feeCheck: null,
      alwaysAllow: false,
    });
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    expect(await asked.answer).toEqual({ error: { code: -32603, message: 'The Safe stand-in stops here' } });
    const payload = { safe: expect.any(String), chain_id: '100', tx: { to: expect.any(String), value: '5', data: APPROVE_DATA } };
    expect(paid.replies.at(-1)).toEqual({
      device: { type: 'safe', kind: 'safe-send', account: SAFE_INDEX, payload, handle: shown.handle },
    });
    const { payload: spentPayload } = paid.replies.at(-1).device;
    expect(spentPayload.safe.toLowerCase()).toBe(SAFE_ADDRESS);
    expect(spentPayload.tx.to.toLowerCase()).toBe(CONTRACT);
    expect(paid.spends).toEqual([
      {
        kind: 'safe-send',
        account: SAFE_INDEX,
        payload: spentPayload,
        handle: shown.handle,
        page: expect.objectContaining({ origin: site }),
      },
    ]);
    expect(paid.safes).toEqual([
      expect.objectContaining({
        safeIndex: SAFE_INDEX,
        chainId: 100,
        tx: { to: spentPayload.tx.to, value: '5', data: APPROVE_DATA },
        approval: { id: expect.stringMatching(/^[0-9a-f]{32}$/), page: expect.objectContaining({ origin: site }) },
      }),
    ]);
    expect(paid.signed).toEqual([]);
  });

  test('a keyless document gets the core\'s 4100 for a send, with no prompt', async () => {
    const keyless = env.tab('data:text/html,<h1>keyless</h1>');
    expect(await keyless.ask('eth_sendTransaction', [CALL])).toEqual({ error: NO_ADDRESS });
    expect(env.prompts()).toEqual([]);
    expect(paid.turns).toEqual([]);
    expect(paid.signed).toEqual([]);
  });
});
