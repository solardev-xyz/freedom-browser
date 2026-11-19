/**
 * Approval tokens through the real freedom-cored (freedom-core design 0012,
 * APB-1): signing-confirmation.test.js's cases for the core's kinds, against
 * the pinned binary. Main mints its own wallet kinds with `approval.issue`
 * as `shell`; a page kind is the core's, minted on an approve answer to its
 * own prompt (APB-4, APB-5; only so from cored 0.22.0, APR-7), so the
 * cases of the core's page-token checks take theirs from a test fixture
 * that answers the core's prompt through main's relay, past the spy. A
 * signature the core makes presents its token to `sign.*`, and
 * the kinds that sign nothing here spend theirs with `approval.spend`. A spy
 * on the core's requests checks the caller of each, that main calls none of
 * the permission files' write methods, and that it mints no page kind and
 * writes no dApp grant under `page`. In a tab the Agent holds (APB-1d), a
 * signature or a send is the core's eth.sign or eth.send prompt, answered
 * by the Agent's sheet (APB-5a, APB-5b), and signed by the core, or by
 * main's own steps and signers with the core's token, under `page` with
 * `agent: true`, never as `shell`. Skipped unless
 * FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/wallet/signing-confirmation.integration
 * or FREEDOM_CORED_APPROVALS_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { HDNodeWallet, Wallet, Transaction, TypedDataEncoder } = require('ethers');

const required = process.env.FREEDOM_CORED_APPROVALS_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH || (required ? require('../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_APPROVALS_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
// A real core quotes a send from its chain on real timers.
jest.setTimeout(30_000);
const quietLog = { info() {}, warn() {}, error() {} };
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ABANDON_KEY = '0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727';

const SITE = 'https://app.example';
const OTHER_SITE = 'https://other.example';
const HANDLE = 'c'.repeat(64);
const OTHER_HANDLE = 'd'.repeat(64);
const SAFE_INDEX = 5000;
const SAFE_ADDRESS = '0x' + 'aa'.repeat(20);
// A Ledger's and a phone's accounts. A phone's backend is a test's fake
// (`devices.phone`); a Ledger's is main's real backend and transport, over
// a fake HID device (`devices.ledger`: its open, its address and its
// signing APDUs), so its device queue, open and address check run as they
// do in the app.
const LEDGER_INDEX = 1000000;
const PHONE_INDEX = 1000001;
const DEVICE_ADDRESS = new Wallet(ABANDON_KEY).address;
// The chrome's webContents a phone job is sent to.
const PHONE_CHROME = 7;
// A phone wallet's JSON-RPC answer to the core's relayed request, signed with `key`.
function phoneAnswer(key, { method, params }) {
  if (method === 'personal_sign') return key.signMessage(require('ethers').getBytes(params[0]));
  if (method === 'eth_signTypedData_v4') {
    const view = JSON.parse(params[1]);
    const { EIP712Domain: _domain, ...types } = view.types;
    return key.signTypedData(view.domain, types, view.message);
  }
  // A payment the phone reports sent: not visible to the core yet.
  return '0x' + 'ab'.repeat(32);
}
const DEVICE_RECORDS = Object.freeze({
  [LEDGER_INDEX]: { index: LEDGER_INDEX, type: 'ledger', address: DEVICE_ADDRESS, path: "44'/60'/0'/0/0" },
  [PHONE_INDEX]: { index: PHONE_INDEX, type: 'remote', address: DEVICE_ADDRESS },
});
const devices = { ledger: {}, phone: {} };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const PAGE = Object.freeze({ origin: SITE, top_origin: SITE, frame: 4, navigation: 9, agent: false });

const TX = Object.freeze({
  chainId: 100,
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  value: '1000000000000000',
  data: '0x095ea7b3' + '00'.repeat(64),
  gasLimit: '21000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
});
const DAPP_TX = Object.freeze({ ...TX, origin: SITE });

const TYPED_DATA = Object.freeze({
  domain: { name: 'Permit', chainId: 100, verifyingContract: '0x' + '11'.repeat(20) },
  types: { Permit: [{ name: 'value', type: 'uint256' }] },
  primaryType: 'Permit',
  message: { value: '1' },
});

// The core's write methods for the four permission files: main calls them
// for a moved file only (`dapp` from APB-2; Swarm and Radicle from APB-3,
// x402 from X402-2).
const WRITE_METHODS = ['approval.grant', 'approval.revoke', 'approval.touch', 'approval.forget_account'];
const MOVED = new Set(['dapp', 'swarm', 'radicle', 'x402']);
const unmovedWrites = (calls) =>
  calls.filter(
    (call) =>
      WRITE_METHODS.includes(call.method) && call.method !== 'approval.forget_account' && !MOVED.has(call.params?.store)
  );

// Test fixtures, not main's calls (design 0012, APR-7): a page token, and a
// site's connect, account or signing rule, each from the core's own prompt,
// as cored 0.22.0 makes them only. The page's request goes to
// `eip1193.request` through main's relay (page-eip1193.js), past the suite's
// spy, and a prompt stand-in approves the core's prompt on a handle of its
// own with the choices asked; the relay's device or send step keeps the
// core's token instead of spending it, for the case to present. A vault
// account's signature the core makes itself: no token. A send is quoted by
// the core from a local chain node, configured for that request only; its
// quote leaves the core's fee evidence (see `freshCore`). The site's grant is put back
// as it was: a token needs one exposing its account, which the fixture
// writes for the token and revokes again (as the chrome). Main's copy of a
// grant is read again from the core.
function coreFixtures(core, scOf, modulesOf) {
  // The fixtures' own calls, apart from main's: the client's request.
  const made = [];
  const send = (method, params, context, options) => {
    made.push({ method, params, context });
    return core(method, params, context, options);
  };
  const vault = HDNodeWallet.fromPhrase(ABANDON, undefined, "m/44'/60'/0'/0");
  const WALLETS = [
    ...[0, 1, 2].map((index) => ({ index, name: `Account ${index}`, address: vault.deriveChild(index).address, type: 'mnemonic' })),
    { index: LEDGER_INDEX, name: 'My Ledger', address: DEVICE_ADDRESS, type: 'ledger' },
    { index: PHONE_INDEX, name: 'My Phone', address: DEVICE_ADDRESS, type: 'remote' },
    { index: SAFE_INDEX, name: 'Safe', address: SAFE_ADDRESS, type: 'safe', deployed: { 100: true } },
  ];
  const addressOf = (index) => WALLETS.find((wallet) => wallet.index === index).address;
  const RELAYED = ['approval.request', 'approval.recheck', 'eip1193.select_chain'];
  let relay = null;
  let node = null;
  async function chainNode() {
    if (node) return node;
    const http = require('http');
    node = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const { id, method } = JSON.parse(body);
        const answers = { eth_chainId: '0x64', eth_estimateGas: '0x5208', eth_gasPrice: '0x3b9aca00' };
        const answer = answers[method] ? { result: answers[method] } : { error: { code: -32601, message: 'the method does not exist' } };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
      });
    });
    await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
    return node;
  }
  // Chain 100 for the core's quote while `run` runs, through main's chain
  // shell; then no chain in the core, as the suite's cases have none of
  // their own, and the client's chain routes as they were: the first route
  // a chain request finds takes it, and a case's own (APB-1d's node) must.
  const CHAIN_ROUTES = ['shell.rpc', 'shell.blockscout'];
  async function onChain(run) {
    const { client, chainShell } = modulesOf();
    const routes = CHAIN_ROUTES.map((name) => client.shapedHandlers.get(name)?.slice());
    try {
      await chain(client, chainShell);
      return await run();
    } finally {
      await send('chain.configure', { chains: [] }, { caller: 'chrome' }, { watchdogMs: 60_000 });
      CHAIN_ROUTES.forEach((name, i) => (routes[i] ? client.shapedHandlers.set(name, routes[i]) : client.shapedHandlers.delete(name)));
    }
  }
  async function chain(client, chainShell) {
    const base = `http://127.0.0.1:${(await chainNode()).address().port}`;
    const endpoints = { f100a: `${base}/a`, f100b: `${base}/b` };
    const state = { generation: 0 };
    chainShell.registerChainShell(
      client,
      { endpoint: (ref) => (endpoints[ref] ? { url: endpoints[ref], chainId: 100 } : null), generation: () => state.generation },
      { hop: chainShell.makeHop({ fetch }) }
    );
    const { generations } = await send(
      'chain.configure',
      {
        chains: [
          {
            chain_id: 100,
            display_name: 'Gnosis Chain',
            read_order: ['direct'],
            broadcast_order: ['direct'],
            quorum: { k: 3, m: 2, timeout_ms: 5000 },
            rpc: Object.keys(endpoints).map((endpoint) => ({ endpoint, user_configured: false })),
            prover: null,
            myotis: false,
            blockscout: null,
          },
        ],
      },
      { caller: 'chrome' },
      { watchdogMs: 60_000 }
    );
    state.generation = generations['100'];
  }
  function relayOf() {
    if (relay) return relay;
    const { createEip1193Relay } = require('../page/page-eip1193');
    relay = createEip1193Relay({
      coreClient: () => Object.assign(Object.create(modulesOf().client), { request: send }),
      identityWalletEnabled: () => true,
      selectedChainOf: () => 100,
      getDerivedWallets: async () => WALLETS,
      networks: () => ({ 1: { name: 'Ethereum', nativeSymbol: 'ETH' }, 10: { name: 'OP', nativeSymbol: 'ETH' }, 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } }),
      isChainAvailable: (chainId) => [1, 10, 100].includes(Number(chainId)),
      getActiveWalletIndex: () => 0,
      rulePaused: async () => false,
      selectChainForPage: () => {},
      isVaultUnlocked: async () => true,
      discardToken: (token) => scOf().discardConfirmation(token),
    });
    return relay;
  }
  // A page's request through main's relay, the core's prompts approved on
  // `handle` with `picks[kind]`; the device's or the send's checked token.
  // Each prompt's approve on a handle of its own: the core takes a handle once.
  const freshHandle = () => require('crypto').randomBytes(32).toString('hex');
  async function ask(page, method, params, picks, chainId = 100) {
    const handle = freshHandle();
    const { client } = modulesOf();
    // The relay's handlers on the client for this request, and a case's own after it.
    const before = RELAYED.map((name) => client.handlers.get(name));
    relayOf().attach(client);
    const record = { method: 'eip1193.request', context: { caller: 'page', page }, params: { method, params }, prompts: [], token: null };
    made.push(record);
    const keep = (checked) => {
      record.token = checked;
      return { result: '0x' };
    };
    const context = {
      method,
      requester: { key: page.origin, transportKey: page.origin, topKey: page.top_origin, chain: chainId, window: 1 },
      pageContext: () => ({ frame: page.frame, navigation: page.navigation, agent: page.agent === true }),
      signal: new AbortController().signal,
      isCurrent: () => true,
      nameHolds: async () => true,
      holdsKey: () => true,
      prompt: async ({ kind, view, choices }) => {
        const picked = choices(picks[kind] ?? {});
        record.prompts.push({ kind, choices: picked });
        record.view = view;
        return picked ? { approve: true, handle, choices: picked } : { closed: 'cancelled' };
      },
    };
    try {
      const answer = await relayOf().request(context, { params, device: keep, send: keep });
      return { answer, token: record.token, record };
    } finally {
      RELAYED.forEach((name, i) => (before[i] ? client.handlers.set(name, before[i]) : client.handlers.delete(name)));
    }
  }
  const grantOf = async (origin) =>
    (await send('approval.grants', { store: 'dapp' }, { caller: 'chrome' })).records.find((record) => record.origin === origin) ?? null;
  async function revoke(origin) {
    await send('approval.revoke', { store: 'dapp', key: origin, what: 'grant' }, { caller: 'chrome' });
  }
  // The core's connect prompt approved for `account`; a grant for another account revoked first.
  async function connect(account, chainId, page) {
    const held = await grantOf(page.origin);
    if (held?.walletIndex === account) return held;
    if (held) await revoke(page.origin);
    const { answer } = await ask(page, 'eth_requestAccounts', [], { 'eth.connect': { walletIndex: account } }, chainId);
    if (!Array.isArray(answer.result)) throw new Error(`no connect: ${JSON.stringify(answer)} ${JSON.stringify(made.slice(-3))}`);
    return grantOf(page.origin);
  }
  // A grant exposing `account` while `run` runs, then the site's grant as it was.
  async function exposing(account, page, run) {
    const held = await grantOf(page.origin);
    if (held?.walletIndex === account) return run();
    await connect(account, 100, page);
    try {
      return await run();
    } finally {
      if (held) await connect(held.walletIndex, held.chainId, page);
      else await revoke(page.origin);
    }
  }
  const quantity = (value) => '0x' + BigInt(value).toString(16);
  // The handle is the one main approved the core's prompt on (`_handle`, a
  // fixed one, is no longer the fixture's to choose).
  async function pageToken(kind, index, payload, page = PAGE, _handle = HANDLE, options = {}) {
    // Checked as main checks a request before the core is asked.
    scOf().corePayload(kind, index, payload, { chainId: options.chainId, remember: kind === 'dapp-send' && options.remember === true });
    const from = addressOf(index);
    let method;
    let params;
    const picks = {};
    if (kind === 'dapp-send' || kind === 'safe-send') {
      const tx = kind === 'safe-send' ? payload.tx : payload;
      method = 'eth_sendTransaction';
      params = [{ from, to: tx.to, value: quantity(tx.value), data: tx.data }];
      picks['eth.send'] = { alwaysAllow: options.remember === true, feeAcknowledged: true };
    } else if (kind === 'sign-message' || (kind === 'safe-message' && payload.method === 'personal_sign')) {
      const message = kind === 'safe-message' ? payload.params[0] : payload;
      method = 'personal_sign';
      params = [message.startsWith('0x') ? message : '0x' + Buffer.from(message, 'utf8').toString('hex'), from];
      picks['eth.sign'] = {};
    } else if (kind === 'sign-typed-data') {
      method = 'eth_signTypedData_v4';
      params = [from, JSON.stringify(toCoreTypedDataView(payload))];
      picks['eth.sign'] = {};
    } else {
      throw new Error(`no prompt gives a ${kind} token`);
    }
    const asked = () => ask(page, method, params, picks);
    const { token, answer, record } = await exposing(index, page, method === 'eth_sendTransaction' ? () => onChain(asked) : asked);
    if (!token) throw new Error(`the core gave no token for ${kind}: ${JSON.stringify(answer)}`);
    const confirmation = { token: token.token, kind: token.kind, payload: token.payload ?? { tx: token.tx }, handle: token.handle, page };
    if (token.account !== undefined) confirmation.account = token.account;
    // A device's typed data: the hash the core confirmed, and the view its prompt showed.
    if (token.expectedHash !== undefined) confirmation.hash = token.expectedHash;
    if (kind === 'sign-typed-data') confirmation.view = record.view;
    // The send as main signs it: the core's prepared transaction in main's form.
    const tx = token.tx ?? token.payload?.tx;
    if (tx && tx.chain_id !== undefined) confirmation.sent = modulesOf().mainTxOf(tx);
    if (token.remember === true) confirmation.remember = true;
    return confirmation;
  }
  return {
    calls: made,
    pageToken,
    // `approval.grant` asked under `page`, as cored 0.22.0 refuses it for the dApp store.
    grantAsPage: (params, page) => send('approval.grant', params, { caller: 'page', page }),
    // A page's request on `account`'s grant, its prompts approved with `picks`.
    pageRequest: (account, page, method, params, picks) => exposing(account, page, () => ask(page, method, params, picks)),
    coreConnect: async (permissions, account, chainId, page) => {
      const grant = await connect(account, chainId, page);
      await permissions.refreshGrant(page.origin);
      return grant;
    },
    // A grant can't change its account (A7-1): revoked and connected again.
    coreAccount: async (permissions, account, page) => {
      await revoke(page.origin);
      const grant = await connect(account, 100, page);
      await permissions.refreshGrant(page.origin);
      return grant;
    },
    // "Always allow" ticked on a vault signature's prompt.
    coreSigningRule: async (permissions, page) => {
      const { answer } = await ask(page, 'personal_sign', ['0x68656c6c6f', addressOf(0)], { 'eth.sign': { alwaysAllow: true } });
      if (typeof answer.result !== 'string') throw new Error(`no signature: ${JSON.stringify(answer)}`);
      await permissions.refreshGrant(page.origin);
      return grantOf(page.origin);
    },
    close: () => (node ? new Promise((resolve) => node.close(resolve)) : null),
  };
}

// Typed data as a page sends it, with its EIP712Domain type.
function toCoreTypedDataView(data) {
  const domainType = Object.keys(data.domain).map((name) => ({
    name,
    type: { name: 'string', version: 'string', chainId: 'uint256', verifyingContract: 'address', salt: 'bytes32' }[name],
  }));
  return { ...data, types: { EIP712Domain: domainType, ...data.types } };
}

// Main's own calls the core refuses under `page` from APR-7: `approval.issue`
// (a page kind is the core's to mint), and `approval.grant` for the dApp
// store (design 0012, APB-5's spy).
const pageMintsAndGrants = (calls) =>
  calls.filter(
    (call) =>
      call.context?.caller === 'page' &&
      (call.method === 'approval.issue' || (call.method === 'approval.grant' && call.params?.store === 'dapp'))
  );

describeIfBinary('approval tokens with the real freedom-cored (APB-1)', () => {
  let root;
  let core;
  let calls;
  let fixtures;
  let chainShell;
  let sc;
  let vaultBackend;
  let buildTransaction;
  let toCoreTransaction;
  let toCoreTypedData;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-tokens-'));
    const { CoreClient } = require('../core/core-client');
    // The chain shell a send's quote is read through, from the same module
    // registry as the core's client (its JsonText replies).
    chainShell = { ...require('../core/chain-shell'), makeHop: require('../core/naming-shell').makeHop };
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    calls = [];
    const request = core.request.bind(core);
    core.request = (method, params, context, options) => {
      const reply = request(method, params, context, options);
      calls.push({ method, context, params, reply });
      return reply;
    };
    fixtures = coreFixtures(request, () => sc, () => ({ client: core, chainShell, mainTxOf: require('../page/page-core-sends').mainTxOf }));
    jest.resetModules();
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../identity-manager', () => ({
      getWalletRecord: (index) =>
        index === SAFE_INDEX
          ? { index, type: 'safe', address: SAFE_ADDRESS, owners: [0], threshold: 1 }
          : DEVICE_RECORDS[index] ?? null,
      isHardwareWalletIndex: () => false,
      recordLedgerAddressCheck: () => {},
      recordRemoteAddressCheck: () => {},
      WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
    }));
    // Main's own signers (`signers.js`): the vault's through the core, a
    // device's through a test's fake device, asked after the core's spend.
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    jest.doMock('@ledgerhq/hw-transport-node-hid', () => ({ default: { open: (...args) => devices.ledger.open(...args) } }));
    jest.doMock('@ledgerhq/hw-app-eth', () => ({
      default: class FakeEth {
        getAddress(...args) {
          return devices.ledger.getAddress(...args);
        }
        signPersonalMessage(...args) {
          return devices.ledger.signPersonalMessage(...args);
        }
        signEIP712Message(...args) {
          return devices.ledger.signEIP712Message(...args);
        }
        signTransaction(...args) {
          return devices.ledger.signTransaction(...args);
        }
      },
    }));
    // A phone's signatures and payments are the core's jobs (design 0012,
    // PHN-2): main's real phone backend (`remote/signer.js`), whose bridge
    // here opens each job in the real core and answers it as a chrome would
    // (`devices.phone.answer`, the phone's JSON-RPC answer to the relayed
    // request, or a throw with its EIP-1193 `rpcCode`), checked by the core.
    jest.doMock('./remote/bridge', () => ({
      requestPhoneJob: async ({ walletIndex, address, method, payload, authorization, page, beforeRelay }) => {
        const backend = require('../core/vault-backend').vaultBackend;
        const opened = await backend.phone.job(
          { account: walletIndex, address, method, payload, target: PHONE_CHROME, ...(authorization ? { authorization } : {}) },
          page || null
        );
        const end = (error) => backend.phone.result({ job: opened.job, sender: PHONE_CHROME, error }, null);
        if (beforeRelay) {
          try {
            await beforeRelay();
          } catch (err) {
            await end({ code: 'REMOTE_USER_CANCELLED' });
            throw err;
          }
        }
        await backend.phone.sent({ job: opened.job, sender: PHONE_CHROME });
        let answer;
        try {
          answer = { result: await devices.phone.answer(opened.request) };
        } catch (err) {
          answer = { error: { rpc_code: err.rpcCode ?? 4001 } };
        }
        const reply = await backend.phone.result({ job: opened.job, sender: PHONE_CHROME, ...answer });
        if (typeof reply.signature === 'string') return reply.signature;
        if (typeof reply.hash === 'string') return { ...reply, job: opened.job };
        const { createRemoteError } = require('./remote/errors');
        throw Object.assign(createRemoteError(reply.code || 'REMOTE_OUTCOME_UNKNOWN'), { requestDelivered: true, otherAttemptDelivered: false });
      },
    }));
    jest.doMock('./rpc-manager', () => ({ getKeylessRpcUrls: () => [] }));
    // Main's dApp file, written where the core reads it (its grant root).
    jest.doMock('../freedom-root', () => ({ getFreedomDataPath: (name) => path.join(root, name) }));
    sc = require('./signing-confirmation');
    ({ vaultBackend } = require('../core/vault-backend'));
    ({ buildTransaction } = require('./transaction-service'));
    ({ toCoreTransaction, toCoreTypedData } = require('./signing-utils'));
    await core.start();
    await vaultBackend.importVault('testpass1', ABANDON);
  });

  afterAll(async () => {
    await fixtures.close();
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
    fixtures.calls.length = 0;
  });

  afterEach(() => {
    // Main calls none of the write methods of a file that hasn't moved, and
    // mints no page kind and writes no dApp grant under `page` (APB-5).
    expect(unmovedWrites(calls)).toEqual([]);
    expect(pageMintsAndGrants(calls)).toEqual([]);
  });

  // A send as main signs it: built as every send is, at the nonce main
  // chose, in the core's wire form (transaction-service, signers.js).
  const wire = (tx, nonce = 7) => toCoreTransaction(buildTransaction({ ...tx, nonce })).tx;
  const account = (index = 0) => ({ kind: 'account', index });

  async function refusal(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error('expected a refusal');
  }

  const reasonOf = async (promise) => {
    const err = await refusal(promise);
    expect(err.code).toBe('not_authorized');
    return err.data?.reason;
  };

  // A fresh core process, its vault unlocked again: what the core held in
  // memory gone (its tokens, receipts and fee evidence), its files kept. A
  // page's send is the core's own prompt since APR-7, whose quote leaves its
  // fee evidence (APR-5e-1) for 60 s; a case about a core with none takes
  // a fresh one after the fixture's send.
  async function freshCore() {
    await core.stop();
    await core.start();
    await vaultBackend.unlock('testpass1');
  }

  async function walletToken(kind, index, payload, options) {
    const { token } = await sc.issueConfirmation(kind, index, payload, options);
    return sc.confirmationFor(token, kind, index, payload);
  }

  const pageToken = (...args) => fixtures.pageToken(...args);

  // A page's send signs the transaction the core prepared (`sent`).
  const signSend = (confirmation, tx, index = 0) =>
    vaultBackend.sign.transaction(account(index), wire(confirmation.sent ?? tx), sc.signingAuthorization(confirmation));

  describe('wallet kinds, minted by main itself', () => {
    test('a token signs exactly the request it was issued for, once', async () => {
      const confirmation = await walletToken('wallet-send', 0, TX);
      expect(confirmation.token).toMatch(/^[0-9a-f]{64}$/);
      const { raw } = await signSend(confirmation, TX);
      const signed = Transaction.from(raw);
      expect(signed.from).toBe(new Wallet(ABANDON_KEY).address);
      expect(signed.to).toBe(TX.to);
      // Burnt by its first presentation.
      expect(await reasonOf(signSend(confirmation, TX))).toBe('unknown_token');
      const issue = calls.find((call) => call.method === 'approval.issue');
      expect(issue.context).toEqual({ caller: 'shell' });
      expect(issue.params).toMatchObject({ kind: 'wallet-send', account: 0 });
      expect(calls.find((call) => call.method === 'sign.transaction').context).toEqual({ caller: 'shell' });
    });

    test('a mismatched presentation also burns the token (no retry to probe)', async () => {
      const confirmation = await walletToken('wallet-send', 0, TX);
      expect(await reasonOf(signSend(confirmation, { ...TX, value: '1' }))).toBe('mismatch');
      expect(await reasonOf(signSend(confirmation, TX))).toBe('unknown_token');
    });

    test('no token, an empty token or an unknown token refuses', async () => {
      expect(() => sc.confirmationFor(undefined, 'wallet-send', 0, TX)).toThrow(/no confirmation token/);
      expect(() => sc.confirmationFor('', 'wallet-send', 0, TX)).toThrow(/no confirmation token/);
      expect(await reasonOf(signSend({ token: 'f'.repeat(64) }, TX))).toBe('unknown_token');
    });

    test('a discarded token no longer signs', async () => {
      const confirmation = await walletToken('wallet-send', 0, TX);
      await sc.discardConfirmation(confirmation.token);
      expect(await reasonOf(signSend(confirmation, TX))).toBe('unknown_token');
      // A second discard, of a token already gone, answers as the first.
      await expect(sc.discardConfirmation(confirmation.token)).resolves.toBeUndefined();
    });

    describe('every bound transaction field refuses on mismatch', () => {
      const changes = {
        chainId: 1,
        to: '0x' + '22'.repeat(20),
        value: '2000000000000000',
        data: '0x',
        gasLimit: '21001',
        maxFeePerGas: '2000000001',
        maxPriorityFeePerGas: '1000000001',
      };
      for (const [field, value] of Object.entries(changes)) {
        test(field, async () => {
          const confirmation = await walletToken('wallet-send', 0, TX);
          expect(await reasonOf(signSend(confirmation, { ...TX, [field]: value }))).toBe('mismatch');
        });
      }

      test('a gas field dropped after confirming (another type)', async () => {
        const confirmation = await walletToken('wallet-send', 0, TX);
        const legacy = { ...TX, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, gasPrice: '2000000000' };
        expect(await reasonOf(signSend(confirmation, legacy))).toBe('mismatch');
      });

      test('the signing account', async () => {
        const confirmation = await walletToken('wallet-send', 0, TX);
        expect(await reasonOf(signSend(confirmation, TX, 1))).toBe('mismatch');
      });

      test('the nonce is not bound: main chooses it after the confirmation', async () => {
        const confirmation = await walletToken('wallet-send', 0, TX);
        await expect(
          vaultBackend.sign.transaction(account(0), wire(TX, 41), sc.signingAuthorization(confirmation))
        ).resolves.toHaveProperty('raw');
      });
    });

    test('equivalent encodings of the same transaction match', async () => {
      const confirmation = await walletToken('wallet-send', 0, TX);
      const same = {
        ...TX,
        chainId: '100',
        to: TX.to.toLowerCase(),
        value: '0x38d7ea4c68000',
        data: TX.data.toUpperCase().replace(/^0X/, '0x'),
        gasLimit: 21000,
      };
      await expect(signSend(confirmation, same)).resolves.toHaveProperty('raw');
    });

    test('value and data default the same way at issue and at use', async () => {
      const bare = { ...TX, value: undefined, data: undefined };
      const confirmation = await walletToken('wallet-send', 0, bare);
      await expect(signSend(confirmation, { ...TX, value: '0', data: '0x' })).resolves.toHaveProperty('raw');
    });

    test("an executor-send binds the executor and the fee shown, and spends as no other kind's", async () => {
      const confirmation = await walletToken('executor-send', 1, TX);
      expect(await reasonOf(signSend(confirmation, { ...TX, maxFeePerGas: '3000000000' }, 1))).toBe('mismatch');
      const again = await walletToken('executor-send', 1, TX);
      // Spent as another kind through the core, it is refused and burnt.
      const asWallet = await refusal(sc.spendConfirmation({ ...again, kind: 'wallet-send' }));
      expect(asWallet.code).toBe('SIGNING_NOT_CONFIRMED');
      expect(await reasonOf(signSend(again, TX, 1))).toBe('unknown_token');
      const fresh = await walletToken('executor-send', 1, TX);
      await expect(signSend(fresh, TX, 1)).resolves.toHaveProperty('raw');
    });

    test("a token on another kind's route is refused before the core signs, and burnt (wallet-send, executor-send)", async () => {
      // Main checks the route's kind against the one it minted, as its JS
      // check did, before the core (which refuses another kind named) is asked.
      for (const [mintedAs, route] of [
        ['executor-send', 'wallet-send'],
        ['wallet-send', 'executor-send'],
      ]) {
        const { token } = await sc.issueConfirmation(mintedAs, 0, TX);
        calls.length = 0;
        expect(() => sc.confirmationFor(token, route, 0, TX)).toThrow(/request differs from what was confirmed/);
        // Nothing asked of the core but the burn.
        expect(calls.map((call) => call.method)).toEqual(['approval.discard']);
        await calls[0].reply;
        // Burnt in the core: not even its own kind's signature takes it now.
        expect(await reasonOf(signSend({ token }, TX))).toBe('unknown_token');
      }
    });

    test('a page kind is never minted by main itself', async () => {
      await expect(sc.issueConfirmation('dapp-send', 0, DAPP_TX)).rejects.toThrow(/issued for its page/);
      // The core refuses one under `shell` as well.
      const err = await refusal(vaultBackend.approval.issue({ kind: 'sign-message', account: 0, payload: { message: '0x68' } }));
      expect(err.code).toBe('forbidden');
    });

    test('malformed requests are not issued a token', async () => {
      await expect(sc.issueConfirmation('wallet-send', 0, { ...TX, chainId: 0 })).rejects.toThrow(/chainId/);
      await expect(sc.issueConfirmation('wallet-send', -1, TX)).rejects.toThrow(/wallet index/);
      await expect(sc.issueConfirmation('wallet-send', 0, { ...TX, to: 'nope' })).rejects.toThrow();
      await expect(sc.issueConfirmation('nonsense', 0, TX)).rejects.toThrow(/Unknown confirmation kind/);
      expect(calls.filter((call) => call.method === 'approval.issue')).toEqual([]);
    });

    test('outstanding tokens are capped: a 33rd drops the oldest', async () => {
      const first = await walletToken('wallet-send', 0, TX);
      for (let i = 0; i < 32; i += 1) await walletToken('wallet-send', 0, TX);
      expect(await reasonOf(signSend(first, TX))).toBe('unknown_token');
    });
  });

  describe('Safe requests: spent through the core, which gives a Safe approval', () => {
    const SAFE_TX = Object.freeze({ tx: { to: TX.to, value: '5', data: '0x' }, chainId: 100 });

    test("a wallet's safe-send binds the Safe, chain, to, value and data", async () => {
      const confirmation = await walletToken('safe-send', SAFE_INDEX, SAFE_TX);
      expect(confirmation.payload).toEqual({
        safe: SAFE_ADDRESS,
        chain_id: '100',
        tx: { to: TX.to.toLowerCase(), value: '5', data: '0x' },
      });
      const spent = await sc.spendSafeConfirmation(confirmation);
      expect(spent).toEqual({ bound: true, approval: { id: expect.stringMatching(/^[0-9a-f]{32}$/), page: null } });
      // The approval it gave is held for its signatures (APB-1c), not ended.
      const spend = calls.find((call) => call.method === 'approval.spend');
      expect(spend.context).toEqual({ caller: 'shell' });
      expect(calls.some((call) => call.method === 'approval.end')).toBe(false);
      await vaultBackend.approval.end(spent.approval.id);
      for (const change of [
        { chainId: 1 },
        { tx: { ...SAFE_TX.tx, to: '0x' + '33'.repeat(20) } },
        { tx: { ...SAFE_TX.tx, value: '6' } },
        { tx: { ...SAFE_TX.tx, data: '0x01' } },
      ]) {
        const token = (await sc.issueConfirmation('safe-send', SAFE_INDEX, SAFE_TX)).token;
        const other = sc.confirmationFor(token, 'safe-send', SAFE_INDEX, { ...SAFE_TX, ...change });
        await expect(sc.spendSafeConfirmation(other)).rejects.toThrow(/differs from what was confirmed/);
      }
    });

    test("a site's safe-send is a page kind: refused as a wallet's, and a wallet's as a site's", async () => {
      const site = await pageToken('safe-send', SAFE_INDEX, { ...SAFE_TX, origin: SITE });
      // Presented without its page, as main's own.
      await expect(sc.spendSafeConfirmation({ ...site, page: undefined, handle: undefined })).rejects.toThrow(
        /Signing was not confirmed/
      );
      const wallet = await walletToken('safe-send', SAFE_INDEX, SAFE_TX);
      await expect(sc.spendSafeConfirmation({ ...wallet, page: PAGE, handle: HANDLE })).rejects.toThrow(
        /Signing was not confirmed/
      );
      const fresh = await pageToken('safe-send', SAFE_INDEX, { ...SAFE_TX, origin: SITE });
      await expect(sc.spendSafeConfirmation(fresh)).resolves.toEqual({
        bound: true,
        approval: { id: expect.stringMatching(/^[0-9a-f]{32}$/), page: PAGE },
      });
      expect(calls.filter((call) => call.method === 'approval.spend').at(-1).context).toEqual({ caller: 'page', page: PAGE });
    });

    test('safe-message binds the Safe, the method and the params', async () => {
      const request = { method: 'personal_sign', params: ['0x68', SAFE_ADDRESS] };
      const confirmation = await pageToken('safe-message', SAFE_INDEX, request);
      expect(confirmation.payload).toEqual({ safe: SAFE_ADDRESS, chain_id: '100', ...request });
      await expect(sc.spendSafeConfirmation(confirmation)).resolves.toEqual({
        bound: true,
        approval: { id: expect.stringMatching(/^[0-9a-f]{32}$/), page: PAGE },
      });
      for (const other of [{ ...request, method: 'eth_signTypedData_v4' }, { ...request, params: ['0x69', SAFE_ADDRESS] }]) {
        const token = await pageToken('safe-message', SAFE_INDEX, request);
        const presented = { ...token, payload: { ...token.payload, method: other.method, params: other.params } };
        await expect(sc.spendSafeConfirmation(presented)).rejects.toThrow(/differs from what was confirmed/);
      }
    });
  });

  describe("a held intent's resend, replacement and close", () => {
    const SENDER = new Wallet(ABANDON_KEY).address.toLowerCase();
    const HASH = (n) => '0x' + n.repeat(64);
    const INTENT = Object.freeze({ intentId: 'intent-0001', chainId: 100, sender: SENDER, nonce: 7 });

    test('an intent-close binds the intent and each of its hashes, in order', async () => {
      const close = { ...INTENT, hashes: [HASH('a'), HASH('b')] };
      await expect(sc.spendConfirmation(await walletToken('intent-close', null, close))).resolves.toMatchObject({ bound: true });
      for (const other of [{ hashes: [HASH('b'), HASH('a')] }, { hashes: [HASH('a')] }, { nonce: 8 }, { intentId: 'intent-0002' }]) {
        const token = (await sc.issueConfirmation('intent-close', null, close)).token;
        await expect(sc.spendConfirmation(sc.confirmationFor(token, 'intent-close', null, { ...close, ...other }))).rejects.toThrow(
          /differs from what was confirmed/
        );
      }
    });

    test('an intent-resend binds the intent and the hash sent again', async () => {
      const resend = { ...INTENT, hash: HASH('a') };
      await expect(sc.spendConfirmation(await walletToken('intent-resend', null, resend))).resolves.toMatchObject({ bound: true });
      const token = (await sc.issueConfirmation('intent-resend', null, resend)).token;
      await expect(
        sc.spendConfirmation(sc.confirmationFor(token, 'intent-resend', null, { ...resend, hash: HASH('b') }))
      ).rejects.toThrow(/differs/);
    });

    test('an intent-replace signs again at its nonce, for its account and intent', async () => {
      const replace = { ...INTENT, ...TX, maxFeePerGas: '4000000000' };
      const present = async (index, nonce, id = INTENT.intentId) => {
        const confirmation = { ...(await walletToken('intent-replace', 0, replace)), intent: { id } };
        return vaultBackend.sign.transaction(account(index), wire(replace, nonce), sc.signingAuthorization(confirmation));
      };
      await expect(present(0, 7)).resolves.toHaveProperty('raw');
      // Its intent named, and no kind (cored 0.15.0, "Naming the kind").
      expect(calls.find((call) => call.method === 'sign.transaction').params.authorization).toEqual({
        token: expect.stringMatching(/^[0-9a-f]{64}$/),
        intent: { id: INTENT.intentId },
      });
      expect(await reasonOf(present(0, 8))).toBe('mismatch');
      expect(await reasonOf(present(1, 7))).toBe('mismatch');
      expect(await reasonOf(present(0, 7, 'intent-0002'))).toBe('mismatch');
    });
  });

  describe('a send names its kind (cored 0.15.0, design 0012 "Naming the kind")', () => {
    // The sends, each minted as main mints it, with what it signs and the key.
    const SENDS = [
      ['wallet-send', () => walletToken('wallet-send', 0, TX), TX, 0],
      ['executor-send', () => walletToken('executor-send', 1, TX), TX, 1],
      ['dapp-send', () => pageToken('dapp-send', 0, DAPP_TX), DAPP_TX, 0],
    ];
    const lastSigned = () => calls.filter((call) => call.method === 'sign.transaction').at(-1);

    test('each kind signs, named as the kind main minted it as, under its caller', async () => {
      for (const [kind, mint, tx, index] of SENDS) {
        const confirmation = await mint();
        await expect(signSend(confirmation, tx, index)).resolves.toHaveProperty('raw');
        const { context, params } = lastSigned();
        expect(params.authorization).toEqual({
          token: confirmation.token,
          kind,
          ...(kind === 'dapp-send' ? { handle: confirmation.handle } : {}),
        });
        expect(context).toEqual(kind === 'dapp-send' ? { caller: 'page', page: PAGE } : { caller: 'shell' });
      }
    });

    test('a send presented without its kind is refused and burnt', async () => {
      for (const [kind, mint, tx, index] of SENDS) {
        const confirmation = await mint();
        const { authorization, page } = sc.signingAuthorization(confirmation);
        const { kind: named, ...kindless } = authorization;
        expect(named).toBe(kind);
        const presented = vaultBackend.sign.transaction(account(index), wire(tx), { authorization: kindless, page });
        expect(await reasonOf(presented)).toBe('mismatch');
        // Burnt: not even named as its own kind does it sign now.
        expect(await reasonOf(signSend(confirmation, tx, index))).toBe('unknown_token');
      }
    });

    test('a send named as another kind is refused and burnt', async () => {
      for (const [kind, mint, tx, index] of SENDS) {
        for (const other of ['wallet-send', 'executor-send', 'dapp-send', 'intent-replace'].filter((k) => k !== kind)) {
          const confirmation = await mint();
          const { authorization, page } = sc.signingAuthorization(confirmation);
          const presented = vaultBackend.sign.transaction(account(index), wire(tx), {
            authorization: { ...authorization, kind: other },
            page,
          });
          expect(await reasonOf(presented)).toBe('mismatch');
          expect(await reasonOf(signSend(confirmation, tx, index))).toBe('unknown_token');
        }
      }
    });
  });

  describe('page kinds, minted by main for a page under `page`', () => {
    // cored 0.16.0 (design 0012, APR-4a): a page's signature needs its
    // authorization (its token, `{ standing }` or `{ safe }`), and the
    // chrome's a wallet-kind token. Without one each is refused `no_token`
    // before the key, while the vault is locked too. `{ standing }` answers
    // only a page: from main or the chrome it is `no_rule`.
    test("a page's or the chrome's signature without its authorization is refused no_token, locked or not", async () => {
      const typed = toCoreTypedData(TYPED_DATA);
      const { EIP712Domain: _domain, ...types } = TYPED_DATA.types;
      const hash = TypedDataEncoder.hash(TYPED_DATA.domain, types, TYPED_DATA.message);
      const unauthorized = (caller) => [
        vaultBackend.sign.message(account(), Buffer.from('hello'), { page: caller }),
        vaultBackend.sign.typedData(account(), typed, hash, { page: caller }),
        vaultBackend.sign.transaction(account(), wire(DAPP_TX), { page: caller }),
      ];
      for (const caller of [PAGE, 'chrome']) {
        for (const signed of unauthorized(caller)) expect(await reasonOf(signed)).toBe('no_token');
      }
      // `{ standing }` from main or the chrome.
      for (const caller of [null, 'chrome']) {
        const standing = { page: caller, authorization: { standing: {} } };
        expect(await reasonOf(vaultBackend.sign.message(account(), Buffer.from('hello'), standing))).toBe('no_rule');
      }
      // Locked: still the refusal, not vault_locked.
      await vaultBackend.lock();
      try {
        for (const signed of unauthorized(PAGE)) expect(await reasonOf(signed)).toBe('no_token');
      } finally {
        await vaultBackend.unlock('testpass1');
      }
      // Main's own, under `shell`, signs on its word.
      await expect(vaultBackend.sign.message(account(), Buffer.from('hello'))).resolves.toMatch(/^0x[0-9a-f]{130}$/);
    });

    test('a dApp send signs under its page, once, for its document and handle', async () => {
      const confirmation = await pageToken('dapp-send', 0, DAPP_TX);
      // The core's, on its own prompt for the page's request (APR-7).
      expect(fixtures.calls.find((call) => call.method === 'eip1193.request' && call.token)).toMatchObject({
        context: { caller: 'page', page: PAGE },
        params: { method: 'eth_sendTransaction' },
        prompts: [{ kind: 'eth.send' }],
        token: { kind: 'dapp-send', account: 0, handle: confirmation.handle, token: confirmation.token },
      });
      await expect(signSend(confirmation, DAPP_TX)).resolves.toHaveProperty('raw');
      expect(calls.find((call) => call.method === 'sign.transaction')).toMatchObject({
        context: { caller: 'page', page: PAGE },
        params: { authorization: { token: confirmation.token, kind: 'dapp-send', handle: confirmation.handle } },
      });
      expect(await reasonOf(signSend(confirmation, DAPP_TX))).toBe('unknown_token');
    });

    test('a page token is refused for another origin, frame, document, handle, or as main\'s own', async () => {
      const others = [
        { page: { ...PAGE, origin: OTHER_SITE } },
        { page: { ...PAGE, frame: 5 } },
        { page: { ...PAGE, navigation: 10 } },
        { handle: OTHER_HANDLE },
        { page: null, handle: undefined },
      ];
      for (const other of others) {
        const confirmation = await pageToken('dapp-send', 0, DAPP_TX);
        const presented = { ...confirmation, ...other };
        const err = await refusal(signSend(presented, DAPP_TX));
        expect(['not_authorized', 'invalid_argument']).toContain(err.code);
        // Burnt as it was presented.
        expect(await reasonOf(signSend(confirmation, DAPP_TX))).toBe('unknown_token');
      }
    });

    test("a dApp send without its site is refused before the core is asked", async () => {
      await expect(pageToken('dapp-send', 0, TX)).rejects.toThrow(/needs the site it is for/);
    });

    // cored 0.22.0 (APR-7): a page's signature token is the core's, on its
    // own prompt, and a vault account's signature the core makes itself,
    // answering the page with it; a device's account's is the one it hands
    // main, spent with `approval.spend` before the device is asked. Its
    // binding, the same `sign.*` checks, is checked at a Ledger's spend.
    const spendAs = (confirmation, kind, payload) =>
      vaultBackend.approval.spend(
        { token: confirmation.token, kind, account: confirmation.account, payload, handle: confirmation.handle },
        confirmation.page
      );
    const messagePayload = (text) => sc.corePayload('sign-message', LEDGER_INDEX, text).payload;
    // Every object's keys in the reverse order, at any depth.
    const reversed = (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reversed(value[key])]))
        : value;

    test("personal_sign: the exact message, its text and hex one message (a Ledger's token, at its spend)", async () => {
      const confirmation = await pageToken('sign-message', LEDGER_INDEX, 'hello');
      expect(confirmation).toMatchObject({ kind: 'sign-message', account: LEDGER_INDEX, payload: messagePayload('hello') });
      expect(await reasonOf(spendAs(confirmation, 'sign-message', messagePayload('hellp')))).toBe('mismatch');
      const again = await pageToken('sign-message', LEDGER_INDEX, '0x68656c6c6f');
      await expect(spendAs(again, 'sign-message', messagePayload('hello'))).resolves.toMatchObject({ bound: true });
    });

    test("typed data: the token carries the core hash, key order does not matter, content does (a Ledger's token, at its spend)", async () => {
      const confirmation = await pageToken('sign-typed-data', LEDGER_INDEX, TYPED_DATA, PAGE, HANDLE, { chainId: 100 });
      const { types, domain, message } = TYPED_DATA;
      expect(confirmation.hash).toBe(TypedDataEncoder.hash(domain, types, message));
      expect(confirmation.view).toBeTruthy();
      const spend = (c, change) => spendAs(c, 'sign-typed-data', { ...c.payload, ...change });
      await expect(spend(confirmation, { typed_data: reversed(confirmation.payload.typed_data) })).resolves.toMatchObject({ bound: true });
      const other = await pageToken('sign-typed-data', LEDGER_INDEX, TYPED_DATA, PAGE, HANDLE, { chainId: 100 });
      const changed = { ...other.payload.typed_data, message: { value: '2' } };
      const err = await refusal(spend(other, { typed_data: changed }));
      expect(err.code).toBe('not_authorized');
      // Told another chain beside the data, the view differs.
      const chained = await pageToken('sign-typed-data', LEDGER_INDEX, TYPED_DATA, PAGE, HANDLE, { chainId: 100 });
      const viewed = await refusal(spend(chained, { chain_id: '1' }));
      expect(viewed.code).toBe('not_authorized');
    });

    test("a message token cannot sign typed data, nor a typed-data token a message (a Ledger's tokens, at their spend)", async () => {
      const message = await pageToken('sign-message', LEDGER_INDEX, 'hello');
      const typedPayload = sc.corePayload('sign-typed-data', LEDGER_INDEX, TYPED_DATA, { chainId: 100 }).payload;
      const err = await refusal(spendAs(message, 'sign-typed-data', typedPayload));
      expect(err.code).toBe('not_authorized');
      const typed = await pageToken('sign-typed-data', LEDGER_INDEX, TYPED_DATA, PAGE, HANDLE, { chainId: 100 });
      expect(await reasonOf(spendAs(typed, 'sign-message', messagePayload('hello')))).toBe('mismatch');
    });

    // APR-7 itself: a vault account's signature is the core's, answering
    // the page; no token reaches main.
    test("a vault account's signature on the core's prompt: the page gets it, and main holds no token", async () => {
      const { answer, token, record } = await fixtures.pageRequest(0, PAGE, 'personal_sign', ['0x68656c6c6f', DEVICE_ADDRESS], {
        'eth.sign': {},
      });
      expect(require('ethers').verifyMessage('hello', answer.result)).toBe(DEVICE_ADDRESS);
      expect(record.prompts).toEqual([{ kind: 'eth.sign', choices: { alwaysAllow: false } }]);
      expect(token).toBeNull();
    });

    test('main has no issuer of its own for a page kind (APB-5b): the core mints one on its own prompt', () => {
      expect(sc.issuePageConfirmation).toBeUndefined();
      expect(Object.keys(sc).filter((name) => /page/i.test(name) && /issue|mint/i.test(name))).toEqual([]);
    });
  });

  describe("a site's standing rule: Q9's limited rule, written and judged by the core (APB-1b, APB-2)", () => {
    const SELECTOR = TX.data.slice(0, 10);
    const MESSAGE_SIGNER = new Wallet(ABANDON_KEY).address;
    let permissions;
    let getSigner;

    beforeAll(() => {
      permissions = require('./dapp-permissions');
      ({ getSigner } = require('./signers'));
    });

    afterEach(async () => {
      for (const site of [SITE, OTHER_SITE]) await permissions.revokePermission(site);
    });

    // The send main would sign under the rule: the page's call, quoted.
    const SEND = Object.freeze({
      to: TX.to,
      value: TX.value,
      data: TX.data,
      chainId: 100,
      gasLimit: TX.gasLimit,
      maxFeePerGas: TX.maxFeePerGas,
      maxPriorityFeePerGas: TX.maxPriorityFeePerGas,
    });
    const check = (request, page = PAGE) => sc.checkStanding(page, { account: 0, accountType: 'mnemonic', ...request });
    const ruled = (page) => getSigner(0, { page, standing: {}, chainId: 100 });
    const notConfirmed = async (promise) => {
      const err = await refusal(promise);
      expect(err.code).toBe('SIGNING_NOT_CONFIRMED');
      return err.reason;
    };
    // "Always allow" on a confirmed dApp send: the core signs it and writes
    // the contract rule (design 0012, The model, APB-2); its reply says so.
    async function flaggedSend(page = PAGE, send = SEND) {
      const confirmation = await pageToken('dapp-send', 0, { ...send, origin: page.origin }, page, HANDLE, { remember: true });
      const heard = [];
      const raw = await getSigner(0, { confirmation, onRule: (rule) => heard.push(rule) }).signTransaction(
        buildTransaction({ ...(confirmation.sent ?? send), nonce: 7 })
      );
      expect(Transaction.from(raw).from).toBe(MESSAGE_SIGNER);
      return heard;
    }

    test('a signature the signing rule answers: chosen by the core, and signed under `page` with `{ standing }`', async () => {
      await fixtures.coreConnect(permissions, 0, 100, PAGE);
      await fixtures.coreSigningRule(permissions, PAGE);
      expect(await check({ kind: 'message', payload: 'hello' })).toEqual({ covered: true, reason: null });
      expect(calls.at(-1)).toMatchObject({
        method: 'approval.check',
        context: { caller: 'page', page: PAGE },
        params: { request: { kind: 'message', account: 0, account_kind: 'vault', message: '0x68656c6c6f' } },
      });
      const signature = await ruled(PAGE).signMessage('hello');
      expect(require('ethers').verifyMessage('hello', signature)).toBe(MESSAGE_SIGNER);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.message',
        context: { caller: 'page', page: PAGE },
        params: { authorization: { standing: {} } },
      });

      // Typed data, viewed on the page's chain, as the core judges it.
      const { domain, types, message } = TYPED_DATA;
      const hash = TypedDataEncoder.hash(domain, types, message);
      expect(await check({ kind: 'typed_data', payload: TYPED_DATA, chainId: 100 })).toEqual({ covered: true, reason: null });
      expect(calls.at(-1).params).toMatchObject({ chain_id: 100, request: { kind: 'typed_data', primary_type: 'Permit' } });
      await expect(ruled(PAGE).signTypedData(TYPED_DATA, { expectedHash: hash })).resolves.toMatch(/^0x[0-9a-f]{130}$/);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.typed_data',
        context: { caller: 'page', page: PAGE },
        params: { chain_id: '100', primary_type: 'Permit', authorization: { standing: {} } },
      });
      // On another chain than the data's, the view warns: the prompt, and
      // no signature under the rule.
      expect(await check({ kind: 'typed_data', payload: TYPED_DATA, chainId: 1 })).toEqual({ covered: false, reason: 'warning' });
      const elsewhere = getSigner(0, { page: PAGE, standing: {}, chainId: 1 });
      expect(await notConfirmed(elsewhere.signTypedData(TYPED_DATA, { expectedHash: hash }))).toBe('warning');
      // Never 32 bytes (#89).
      const raw = '0x' + 'ab'.repeat(32);
      expect(await check({ kind: 'message', payload: raw })).toEqual({ covered: false, reason: 'warning' });
      expect(await notConfirmed(ruled(PAGE).signMessage(raw))).toBe('warning');
    });

    test('no rule answers another site, another account, a tab in custody, a rule turned off, or no grant', async () => {
      await fixtures.coreConnect(permissions, 0, 100, PAGE);
      await fixtures.coreSigningRule(permissions, PAGE);
      const message = { kind: 'message', payload: 'hello' };
      expect(await check(message, { ...PAGE, origin: OTHER_SITE, top_origin: OTHER_SITE })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await check({ ...message, account: 1 })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await check(message, { ...PAGE, agent: true })).toEqual({ covered: false, reason: 'custody' });
      expect(await notConfirmed(ruled({ ...PAGE, agent: true }).signMessage('hello'))).toBe('custody');
      expect(await notConfirmed(ruled({ ...PAGE, origin: OTHER_SITE }).signMessage('hello'))).toBe('no_rule');
      // Turned off (main's own, from the chrome), or revoked: the core's next
      // check reads it.
      expect(await permissions.setSigningAutoApprove(SITE, false)).toBe(true);
      expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
      expect(await notConfirmed(ruled(PAGE).signMessage('hello'))).toBe('no_rule');
      await fixtures.coreSigningRule(permissions, PAGE);
      expect(await permissions.revokePermission(SITE)).toBe(true);
      expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
      // A request the core can't judge reads as not covered, unasked.
      calls.length = 0;
      expect(await sc.checkStanding(PAGE, { kind: 'message', account: 0, accountType: 'hardware', payload: 'hello' })).toEqual({
        covered: false,
        reason: 'invalid',
      });
      expect(calls).toEqual([]);
    });

    test("a send the contract rule answers: the rule the core wrote from a confirmed send, with main's pause, its value cap and the core's own fee check", async () => {
      await fixtures.coreConnect(permissions, 0, 100, PAGE);
      expect(await flaggedSend()).toEqual([{ added: true }]);
      const send = (request) => check({ kind: 'transaction', payload: SEND, paused: false, ...request });
      // A phone picks its own fee: the rule, the account and the pause decide.
      expect(await send({ accountType: 'remote' })).toEqual({ covered: true, reason: null });
      expect(calls.at(-1).params).toMatchObject({
        chain_id: 100,
        paused: false,
        request: { kind: 'transaction', account_kind: 'phone', tx: { to: TX.to, value: TX.value, data: TX.data } },
      });
      expect(calls.at(-1).params.request.tx).not.toHaveProperty('nonce');
      // D12: paused, or a pause main didn't read, isn't covered.
      expect(await send({ accountType: 'remote', paused: true })).toEqual({ covered: false, reason: 'paused' });
      expect(await send({ accountType: 'remote', paused: undefined })).toEqual({ covered: false, reason: 'paused' });
      // More value than the confirmed send's, a plain transfer, another chain, a Safe.
      const more = { ...SEND, value: (BigInt(TX.value) + 1n).toString() };
      expect(await send({ accountType: 'remote', payload: more })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await send({ accountType: 'remote', payload: { ...SEND, data: '0x' } })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await send({ accountType: 'remote', payload: { ...SEND, chainId: 1 } })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await send({ accountType: 'safe' })).toEqual({ covered: false, reason: 'no_rule' });
      // A vault account's send needs the core's own fee evidence, which only
      // its `chain.fee_reference` gives: with none (a fresh core, past the
      // fixture's send), the prompt.
      await freshCore();
      expect(await send({ accountType: 'mnemonic' })).toEqual({ covered: false, reason: 'fee_check' });
      // The signature itself: judged again by the core under `{ standing }`.
      const built = buildTransaction({ ...SEND, nonce: 7 });
      const signer = getSigner(0, { page: PAGE, standing: { paused: false } });
      expect(await notConfirmed(signer.signTransaction(built))).toBe('fee_check');
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.transaction',
        context: { caller: 'page', page: PAGE },
        params: { authorization: { standing: { paused: false } } },
      });
      expect(await notConfirmed(getSigner(0, { page: PAGE, standing: {} }).signTransaction(built))).toBe('paused');
      expect(await notConfirmed(getSigner(0, { page: { ...PAGE, agent: true }, standing: { paused: false } }).signTransaction(built))).toBe(
        'custody'
      );
      // Removed (main's own, from the chrome), the rule answers nothing.
      expect(await permissions.removeTransactionAutoApprove(SITE, TX.to, SELECTOR, 100)).toBe(true);
      expect(await send({ accountType: 'remote' })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await flaggedSend()).toEqual([{ added: true }]);
      await permissions.revokePermission(SITE);
      expect(await notConfirmed(signer.signTransaction(built))).toBe('no_rule');
    });

    test('"Always allow": the core writes the rule as it signs and says so; not ticked, or not connected, none', async () => {
      // Not connected: the core signs the confirmed send, and writes no rule.
      expect(await flaggedSend()).toEqual([{ added: false, reason: 'not_exposed' }]);
      await fixtures.coreConnect(permissions, 0, 100, PAGE);
      // Not ticked on the core's prompt (APR-7): no flag, and no rule in the
      // reply. (Before the ticked one: the rule it writes answers the same
      // send with no prompt.)
      const minted = () => fixtures.calls.filter((call) => call.method === 'eip1193.request' && call.token).at(-1);
      const plain = await pageToken('dapp-send', 0, DAPP_TX);
      expect(minted()).toMatchObject({
        prompts: [{ kind: 'eth.send', choices: { alwaysAllow: false } }],
        token: { kind: 'dapp-send', tx: expect.any(Object), remember: false },
      });
      const heard = [];
      await getSigner(0, { confirmation: plain, onRule: (rule) => heard.push(rule) }).signTransaction(
        buildTransaction({ ...(plain.sent ?? SEND), nonce: 7 })
      );
      expect(heard).toEqual([null]);
      // Ticked: the core minted the token flagged, and writes the rule as it signs.
      expect(await flaggedSend()).toEqual([{ added: true }]);
      expect(minted()).toMatchObject({
        prompts: [{ kind: 'eth.send', choices: { alwaysAllow: true } }],
        token: { kind: 'dapp-send', tx: expect.any(Object), remember: true },
      });
      // The file holds Q9's limited rule, where an older build doesn't look.
      const file = JSON.parse(fs.readFileSync(path.join(root, 'dapp-permissions.json'), 'utf8'));
      expect(file[SITE].autoApprove).toEqual({
        signing: false,
        transactions: [],
        limited: {
          signing: null,
          transactions: [
            { to: TX.to.toLowerCase(), selector: SELECTOR, chainId: 100, maxValue: TX.value, grantedAt: expect.any(Number) },
          ],
        },
      });
    });
    // Design 0012, "A device send's rule" (cored 0.16.0): a Ledger's or a
    // phone's flagged dApp send is spent through the core before the device
    // is asked (main's real signers here, over a fake device). The spend
    // writes nothing and gives a finalize receipt, which main presents under
    // the page it was spent under once the device signed and the send is
    // recorded; only then is the rule written. A send the device refused
    // presents nothing, and leaves no rule.
    // Design 0012, "A phone payment's rule" (PHN-1, PHN-2): a phone's
    // flagged dApp send presents its token to the core's job, which holds
    // the rule in memory until the payment's transaction shows and matches.
    // No receipt, no approval.spend; a hash the core can't see yet, or a
    // send the phone refused, writes nothing.
    describe('"Always allow" on a phone\'s send: held by the core\'s job until verified', () => {
      const key = new Wallet(ABANDON_KEY);
      let refuse;
      const sendCheck = () =>
        sc.checkStanding(PAGE, { kind: 'transaction', account: PHONE_INDEX, accountType: 'remote', payload: SEND, paused: false });
      async function flaggedPhoneSend() {
        const confirmation = await pageToken('dapp-send', PHONE_INDEX, { ...SEND, origin: PAGE.origin }, PAGE, HANDLE, {
          remember: true,
          phone: true,
        });
        const rules = [];
        const receipts = [];
        const signer = getSigner(PHONE_INDEX, {
          confirmation,
          onRule: (rule) => rules.push(rule),
          onReceipt: (held) => receipts.push(held),
        });
        const sent = await signer.sendTransaction(buildTransaction({ ...(confirmation.sent ?? SEND), nonce: 7 })).catch((err) => err);
        return { sent, rules, receipts, confirmation };
      }
      beforeEach(() => {
        refuse = false;
        devices.phone = {
          answer: async (request) => {
            if (refuse) throw Object.assign(new Error('declined'), { rpcCode: 4001 });
            return phoneAnswer(key, request);
          },
        };
      });

      test("the token goes to the core's job under its page; an unverified payment writes no rule, and no receipt is given", async () => {
        await fixtures.coreConnect(permissions, PHONE_INDEX, 100, PAGE);
        const { sent, rules, receipts, confirmation } = await flaggedPhoneSend();
        expect(sent).toMatchObject({ hash: '0x' + 'ab'.repeat(32), outcome: 'unverified' });
        const job = calls.find((call) => call.method === 'phone.job');
        expect(job).toMatchObject({
          context: { caller: 'page', page: PAGE },
          params: { account: PHONE_INDEX, method: 'transaction', authorization: { kind: 'dapp-send', handle: confirmation.handle } },
        });
        expect(calls.filter((call) => call.method === 'approval.spend')).toEqual([]);
        expect(receipts).toEqual([]);
        expect(rules).toEqual([null]);
        expect(await sendCheck()).toEqual({ covered: false, reason: 'no_rule' });
        const file = JSON.parse(fs.readFileSync(path.join(root, 'dapp-permissions.json'), 'utf8'));
        expect(file[SITE].autoApprove.limited?.transactions ?? []).toEqual([]);
        // The core keeps the payment's record, never the rule.
        const phoneFile = fs.readFileSync(path.join(root, 'phone-payments.json'), 'utf8');
        expect(phoneFile).not.toContain('rule');
      });

      test('a send the phone refused writes no rule', async () => {
        await fixtures.coreConnect(permissions, PHONE_INDEX, 100, PAGE);
        refuse = true;
        const { sent, rules } = await flaggedPhoneSend();
        expect(sent).toMatchObject({ code: 'REMOTE_USER_REJECTED' });
        expect(rules).toEqual([]);
        expect(await sendCheck()).toEqual({ covered: false, reason: 'no_rule' });
      });
    });

    describe.each([
      ['a Ledger', LEDGER_INDEX, 'ledger'],
    ])('"Always allow" on %s\'s send: a finalize receipt', (_label, index, type) => {
      const key = new Wallet(ABANDON_KEY);
      let refuse;
      const deviceSend = (confirmation, onReceipt) => {
        const signer = getSigner(index, { confirmation, onReceipt });
        const built = buildTransaction({ ...(confirmation.sent ?? SEND), nonce: 7 });
        return type === 'remote' ? signer.sendTransaction(built) : signer.signTransaction(built);
      };
      // Minted flagged for the page, as main's issuer mints a confirmed
      // send, and spent by the device's signer; the receipt it handed on.
      async function spentForDevice(page = PAGE) {
        const confirmation = await pageToken('dapp-send', index, { ...SEND, origin: page.origin }, page, HANDLE, {
          remember: true,
          phone: type === 'remote',
        });
        let held = null;
        await deviceSend(confirmation, (receipt) => {
          held = receipt;
        }).catch((err) => {
          if (!refuse) throw err;
        });
        return held;
      }
      const sendCheck = () =>
        sc.checkStanding(PAGE, { kind: 'transaction', account: index, accountType: type, payload: SEND, paused: false });
      // A phone picks its own fee, so the rule alone covers its send; a
      // Ledger's also needs the core's own fee evidence, which this test has
      // none of (`fee_check`, past the rule).
      const COVERED = type === 'remote' ? { covered: true, reason: null } : { covered: false, reason: 'fee_check' };

      beforeEach(() => {
        refuse = false;
        devices.ledger = {
          open: async () => ({ close: async () => {} }),
          getAddress: async () => ({ address: DEVICE_ADDRESS }),
          signTransaction: async (_path, rawHex) => {
            if (refuse) throw Object.assign(new Error('Ledger device: Condition of use not satisfied (0x6985)'), { statusCode: 0x6985 });
            const signed = Transaction.from(await key.signTransaction(Transaction.from('0x' + rawHex)));
            const sig = signed.signature;
            return { r: sig.r.slice(2), s: sig.s.slice(2), v: sig.v };
          },
        };
      });

      test('the spend writes nothing; the receipt presented under its page writes the rule, and the next identical call is covered by it', async () => {
        await fixtures.coreConnect(permissions, index, 100, PAGE);
        const held = await spentForDevice();
        expect(held).toEqual({ receipt: expect.stringMatching(/^[0-9a-f]{32}$/), page: PAGE });
        const spend = calls.find((call) => call.method === 'approval.spend');
        expect(spend).toMatchObject({ context: { caller: 'page', page: PAGE }, params: { kind: 'dapp-send', account: index } });
        expect((await spend.reply).receipt).toBe(held.receipt);
        // Spent, signed and recorded: still no rule until main presents it.
        expect(await sendCheck()).toEqual({ covered: false, reason: 'no_rule' });
        expect(await sc.rememberDeviceSend(held)).toEqual({ added: true });
        expect(calls.find((call) => call.method === 'approval.remember')).toMatchObject({
          context: { caller: 'page', page: PAGE },
          params: { receipt: held.receipt },
        });
        // Presented once: taken at its first presentation.
        expect(await reasonOf(vaultBackend.approval.remember({ receipt: held.receipt }, PAGE))).toBe('unknown_token');
        // A Ledger's fee evidence: none in a fresh core, past the fixture's send.
        if (type !== 'remote') await freshCore();
        expect(await sendCheck()).toEqual(COVERED);
        // Q9's limited rule, as a vault send's "Always allow" writes it.
        const file = JSON.parse(fs.readFileSync(path.join(root, 'dapp-permissions.json'), 'utf8'));
        expect(file[SITE].autoApprove.limited.transactions).toEqual([
          { to: TX.to.toLowerCase(), selector: SELECTOR, chainId: 100, maxValue: TX.value, grantedAt: expect.any(Number) },
        ]);
      });

      test('a send the device refused presents nothing: no rule', async () => {
        await fixtures.coreConnect(permissions, index, 100, PAGE);
        refuse = true;
        const held = await spentForDevice();
        // The spend gave its receipt; the device refused, so main never
        // presents it, and nothing is written.
        expect(held).toEqual({ receipt: expect.stringMatching(/^[0-9a-f]{32}$/), page: PAGE });
        expect(calls.filter((call) => call.method === 'approval.remember')).toEqual([]);
        expect(await sendCheck()).toEqual({ covered: false, reason: 'no_rule' });
        const file = JSON.parse(fs.readFileSync(path.join(root, 'dapp-permissions.json'), 'utf8'));
        expect(file[SITE].autoApprove.limited?.transactions ?? []).toEqual([]);
      });

      test('another document, a narrowing, or no grant: nothing written', async () => {
        await fixtures.coreConnect(permissions, index, 100, PAGE);
        // Another document of the same site: refused, and the receipt gone.
        const other = await spentForDevice();
        expect(await reasonOf(vaultBackend.approval.remember({ receipt: other.receipt }, { ...PAGE, navigation: PAGE.navigation + 1 }))).toBe(
          'mismatch'
        );
        expect(await reasonOf(vaultBackend.approval.remember({ receipt: other.receipt }, PAGE))).toBe('unknown_token');
        // The chrome or main itself: refused by the method table, the receipt kept for its page.
        const kept = await spentForDevice();
        await expect(vaultBackend.approval.remember({ receipt: kept.receipt }, 'chrome')).rejects.toMatchObject({ code: 'forbidden' });
        await expect(vaultBackend.approval.remember({ receipt: kept.receipt }, null)).rejects.toMatchObject({ code: 'forbidden' });
        // A narrowing (the signing rule turned off, main's own) drops the
        // key's receipts.
        await permissions.setSigningAutoApprove(SITE, false);
        expect(calls.filter((call) => call.method === 'approval.revoke').at(-1)).toMatchObject({ params: { store: 'dapp', key: SITE, what: 'signing' } });
        expect(await reasonOf(vaultBackend.approval.remember({ receipt: kept.receipt }, PAGE))).toBe('unknown_token');
        expect(await sendCheck()).toEqual({ covered: false, reason: 'no_rule' });
        // A grant that no longer exposes the account (moved to another): not written.
        const moved = await spentForDevice();
        await permissions.revokePermission(SITE);
        await fixtures.coreConnect(permissions, 0, 100, PAGE);
        expect(await reasonOf(vaultBackend.approval.remember({ receipt: moved.receipt }, PAGE))).toBe('unknown_token');
        const fresh = await spentForDevice();
        expect(await sc.rememberDeviceSend(fresh)).toEqual({ added: false, reason: 'not_exposed' });
      });
    });
  });

  // Design 0012 (as amended by freedom-core #368), "A page request the Agent
  // answers": in a tab the Agent holds, its decision on a send mints the
  // request's page-kind token through main's issuer, under `page` with the
  // request's PageContext (`agent: true`) and a handle main drew, and the
  // signature presents it under `page` with the live PageContext, until
  // APB-5b. A signature there is the core's since APB-5a ("The Agent's
  // answer"): the core's eth.sign prompt, answered by the Agent's sheet, and
  // main mints nothing. No standing rule answers either, and none goes as
  // `shell`. Driven end to end: the page's request through main's page
  // dispatcher (`page-requests.js`, `page-ethereum.js`), the relay
  // (`page-eip1193.js`, `page-devices.js`), the real AgentWalletController
  // with main's signers, and the core.
  describe('a page request the Agent answers, in a tab it holds (APB-1d)', () => {
    const { EventEmitter } = require('events');
    const CHROME_URL = 'file:///app/src/renderer/index.html';
    const SIGNER = new Wallet(ABANDON_KEY).address;
    let permissions;
    let requests;
    let guests;
    let custody;
    let approvals;
    let answerWith;
    let nextId = 1;
    let nextNonce = 1;
    // The relay's runs, which outlive a request main answered (its document
    // gone): a test waits for them before it checks what was signed.
    let running;
    // Chain 100's node, from which the core prepares a send (its estimate
    // and quote, APB-4c), and its gas price, which a test may lower.
    let node;
    const NODE_PRICE = 15_960_000_000;
    let nodePrice = NODE_PRICE;
    // The transaction service's own waits before it asks the signer (the
    // fee, the nonce), held when a test sets one; and what each device was
    // asked.
    let serviceWait;
    let deviceAsked;
    // The Agent's sheet (APB-5a, APB-5b): its wait before it answers, held
    // when a test sets one; and the core's tokens main handed a signer.
    let sheetWait;
    let presented;
    // Each signed send main's guard let through to the journal and the
    // network.
    let committed;
    // DNS names over IPNS the page documents resolve: name -> IPNS key.
    const names = new Map();

    class Guest extends EventEmitter {
      constructor() {
        super();
        this.id = nextId++;
        this.hostWebContents = { id: 501, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
        this.mainFrame = this.frame('about:blank');
      }

      frame(url) {
        return { url, frameTreeNodeId: 1000 + this.id, processId: 1, routingId: this.id, detached: false, send: () => {} };
      }

      isDestroyed() {
        return false;
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

    beforeAll(async () => {
      // A core whose only fee evidence is from this node: the fixture's
      // sends before these left their own quote's.
      await freshCore();
      permissions = require('./dapp-permissions');
      const { getSigner } = require('./signers');
      const { createPageDocuments } = require('../page/page-documents');
      const { createPageRequests } = require('../page/page-requests');
      const { createEthereumDispatchers } = require('../page/page-ethereum');
      guests = new Map();
      custody = new Set();
      const wallets = async () => [
        { index: 0, name: 'Main Wallet', address: SIGNER, type: 'mnemonic' },
        { index: LEDGER_INDEX, name: 'My Ledger', address: DEVICE_ADDRESS, type: 'ledger' },
        { index: PHONE_INDEX, name: 'My Phone', address: DEVICE_ADDRESS, type: 'remote' },
      ];
      // Chain 100's node: the estimate and a legacy gas price, from which
      // the core quotes a send (APB-4c); every other method is unknown.
      const http = require('http');
      node = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const { id, method } = JSON.parse(body);
          const answers = { eth_chainId: '0x64', eth_estimateGas: '0x445c', eth_gasPrice: '0x' + nodePrice.toString(16) };
          const answer = answers[method]
            ? { result: answers[method] }
            : { error: { code: -32601, message: 'the method does not exist' } };
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
        });
      });
      await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${node.address().port}`;
      const endpoints = { e100a: `${base}/a`, e100b: `${base}/b` };
      const chain = { generation: 0 };
      chainShell.registerChainShell(
        core,
        { endpoint: (ref) => (endpoints[ref] ? { url: endpoints[ref], chainId: 100 } : null), generation: () => chain.generation },
        { hop: chainShell.makeHop({ fetch }) }
      );
      const { generations } = await core.request(
        'chain.configure',
        {
          chains: [
            {
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
            },
          ],
        },
        { caller: 'chrome' },
        { watchdogMs: 60_000 }
      );
      chain.generation = generations['100'];
      // The transaction service as it runs a send (tx-recorder.js): the
      // account's address, its own waits (held when a test sets
      // `serviceWait`), then signed at the nonce main chose and committed
      // past the caller's guard; a phone signs and broadcasts in one step.
      const signAndRecord = async (tx, signer, _record, options) => {
        await signer.getAddress();
        if (serviceWait) {
          serviceWait.reached.resolve();
          await serviceWait.promise;
        }
        if (typeof signer.sendTransaction === 'function') {
          // A phone's send answers the core's outcome (PHN-2), as the
          // transaction service takes it.
          return { hash: (await signer.sendTransaction(buildTransaction({ ...tx, nonce: 7 }))).hash };
        }
        const raw = await signer.signTransaction(buildTransaction({ ...tx, nonce: 7 }));
        await options.guardCommit(async () => {
          committed.push(raw);
        });
        options.onCommitted?.();
        return { hash: Transaction.from(raw).hash, recorded: true, paymentId: 'payment_1' };
      };
      const documents = createPageDocuments({
        isPrivateWebContents: () => false,
        isChromeIndexUrl: (url) => url === CHROME_URL,
        isAgentPage: () => false,
        windowIdOf: () => 1,
        resolveEnsContent: async (name) =>
          names.has(name) ? { type: 'ok', protocol: 'ipns', decoded: names.get(name) } : { type: 'not_found' },
      });
      const inCustody = (guestId) => custody.has(guestId);
      // The identity core's dispatcher (design 0012, APB-4), and its prompts
      // in a tab the Agent holds answered by the Agent's sheet (APB-5): a
      // connect, a signature and a send there are the core's, and the
      // test's sheet answers its eth.sign and eth.send prompts.
      const { createEip1193Relay } = require('../page/page-eip1193');
      const relay = createEip1193Relay({
        coreClient: () => core,
        identityWalletEnabled: () => true,
        selectedChainOf: () => 100,
        getDerivedWallets: wallets,
        networks: () => ({ 100: { name: 'Gnosis', nativeSymbol: 'xDAI' } }),
        isChainAvailable: (chainId) => Number(chainId) === 100,
        getActiveWalletIndex: () => 0,
        rulePaused: async () => false,
        selectChainForPage: () => {},
        isVaultUnlocked: async () => (await vaultBackend.status()).unlocked === true,
        discardToken: (token) => sc.discardConfirmation(token),
        agentPrompt: async (_guestId, prompt) => {
          approvals.push({ sheet: prompt.kind });
          if (sheetWait) {
            sheetWait.reached.resolve();
            await sheetWait.promise;
          }
          return { handled: true, decision: { approve: answerWith === 'approved' } };
        },
      });
      relay.attach(core);
      requests = createPageRequests({
        documents,
        webContentsFromId: (id) => guests.get(id),
        dispatchers: createEthereumDispatchers({
          identityWalletEnabled: () => true,
          selectedChainOf: () => 100,
          getPermission: (key) => permissions.getPermission(key),
          getDerivedWallets: wallets,
          chainName: () => 'Gnosis',
          networks: () => ({ 100: { name: 'Gnosis' } }),
          getActiveWalletIndex: () => 0,
          updateLastUsed: () => {},
          // Its runs kept: a device's step or a send's outlives a request
          // main answered (its document gone).
          relay: { ...relay, request: (...args) => track(relay.request(...args)) },
          permissionsLoaded: async () => {},
          // A device's signature after the sheet's approve: main's own
          // signers (`signers.js`), handed the core's token.
          deviceDeps: {
            walletList: wallets,
            discardToken: (token) => sc.discardConfirmation(token),
            getSigner: (index, authorized) => {
              presented.push(authorized.confirmation);
              return require('./signers').getSigner(index, authorized);
            },
          },
          // A send after the sheet's approve (APB-5b): main's own steps
          // (`page-core-sends.js`) and signers, handed the core's token.
          coreSendDeps: {
            getSigner: (index, authorized) => {
              presented.push(authorized.confirmation);
              return getSigner(index, authorized);
            },
            signAndRecord,
            discardToken: (token) => sc.discardConfirmation(token),
          },
          signing: { inCustody },
          sends: { inCustody },
        }),
        chromeWindowOf: (contents) => (contents?.id === 501 ? 1 : null),
        sendToWindow: () => {},
        watchWindow: () => {},
        // A PageContext's `agent`: the custody the dispatchers read.
        isAgentGuest: inCustody,
      });
    });

    // Chain 100's node closed, and a fresh core process for the cases after
    // these, with no chain and no fee evidence (the Safe executor's case
    // reads none): main's client starts another once this one exits.
    afterAll(async () => {
      await new Promise((resolve) => node.close(resolve));
      const restarted = new Promise((resolve) => core.once('ready', resolve));
      core.current.child.kill('SIGKILL');
      await restarted;
      await vaultBackend.unlock('testpass1');
    });

    // A run of the relay, kept until it settles.
    function track(run) {
      running.push(run);
      return run;
    }

    // A fake device, as main's signers ask one (`signers.js`): after the
    // core's hash and spend, and the caller's last check. What it is asked
    // is recorded; it signs with the test key.
    function device(name) {
      const key = new Wallet(ABANDON_KEY);
      const asked = (method) => deviceAsked.push([name, method]);
      if (name === 'ledger') {
        // The HID device under main's Ledger backend: what hw-app-eth asks.
        const answer = async (signature) => {
          const sig = require('ethers').Signature.from(await signature);
          return { r: sig.r.slice(2), s: sig.s.slice(2), v: sig.v };
        };
        return {
          open: async () => ({ close: async () => {} }),
          getAddress: async () => ({ address: DEVICE_ADDRESS }),
          signPersonalMessage: async (_path, hex) => {
            asked('signMessage');
            return answer(key.signMessage(Buffer.from(hex, 'hex')));
          },
          signEIP712Message: async (_path, payload) => {
            asked('signTypedData');
            const { EIP712Domain: _domain, ...types } = payload.types;
            return answer(key.signTypedData(payload.domain, types, payload.message));
          },
          signTransaction: async (_path, rawHex) => {
            asked('signTransaction');
            const signed = Transaction.from(await key.signTransaction(Transaction.from('0x' + rawHex)));
            return answer(signed.signature.serialized);
          },
        };
      }
      // A phone: its answer to the core's relayed job (PHN-2).
      const ASKED = { personal_sign: 'signMessage', eth_signTypedData_v4: 'signTypedData', eth_sendTransaction: 'sendTransaction' };
      return {
        answer: async (request) => {
          asked(ASKED[request.method]);
          return phoneAnswer(key, request);
        },
      };
    }

    // A PageContext for `key`, under which the core writes a grant or rule
    // for this test's setup (design 0012, APB-2: every grant write is the
    // core's, under the page's own PageContext).
    const pageOf = (key) => ({ origin: key, top_origin: key, frame: 4, navigation: 9, agent: false });

    beforeEach(async () => {
      approvals = [];
      answerWith = 'approved';
      running = [];
      serviceWait = null;
      sheetWait = null;
      presented = [];
      committed = [];
      deviceAsked = [];
      devices.ledger = device('ledger');
      devices.phone = device('phone');
      await fixtures.coreConnect(permissions, 0, 100, pageOf(SITE));
    });

    afterEach(async () => {
      await permissions.revokePermission(SITE);
      // No signature for an attested page request goes as main's own: each
      // is under `page`, in the Agent's tab, with a token.
      const signs = calls.filter((call) => call.method.startsWith('sign.'));
      for (const call of signs) {
        expect(call.context).toEqual({ caller: 'page', page: expect.objectContaining({ origin: expect.stringMatching(/^(https:\/\/app\.example|example\.com)$/), agent: true }) });
        expect(call.params.authorization).toEqual(expect.objectContaining({ token: expect.stringMatching(/^[0-9a-f]{64}$/) }));
        expect(call.params.authorization).not.toHaveProperty('standing');
      }
    });

    // A page in a tab the Agent holds (or, `held: false`, one it doesn't),
    // and its requests; `name`: a DNS name over IPNS bound to the tab, at
    // its IPNS key.
    function agentTab({ held = true, name = null } = {}) {
      const guest = new Guest();
      guests.set(guest.id, guest);
      requests.track(guest);
      if (name) {
        expect(requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name, key: names.get(name) })).toBe(true);
        guest.commit(`ipns://${names.get(name)}/`);
      } else {
        guest.commit(`${SITE}/app`);
      }
      const nonce = (nextNonce++).toString(16).padStart(32, '0');
      const event = { sender: guest, senderFrame: guest.mainFrame };
      expect(requests.hello(event, { nonce }).ok).toBe(true);
      if (held) custody.add(guest.id);
      const origin = name || SITE;
      const page = {
        origin,
        top_origin: origin,
        frame: guest.mainFrame.frameTreeNodeId,
        navigation: expect.any(Number),
        agent: held,
      };
      return {
        guest,
        page,
        ask: (method, params) => requests.request(event, { nonce, provider: 'ethereum', method, params }),
      };
    }

    // The core's `{ send }` for one request, as main's signer was handed it
    // (APB-5b): the core minted the token on the sheet's approve, for the
    // request's page (`agent: true`) and the handle main opened for the
    // sheet. Main minted nothing.
    function handedSend(page) {
      expect(calls.filter((call) => call.method === 'approval.issue')).toEqual([]);
      expect(presented).toEqual([
        expect.objectContaining({
          kind: 'dapp-send',
          page,
          handle: expect.stringMatching(/^[0-9a-f]{64}$/),
          token: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]);
      return presented[0].handle;
    }
    const SEND_PARAMS = () => [{ to: TX.to, value: '0x' + BigInt(TX.value).toString(16), data: TX.data }];

    // A connect or a signature in the Agent's tab is the core's since APB-5a,
    // and a send since APB-5b: the core's eth.send, answered by the sheet,
    // and its `{ send }` signed by main's own steps with the core's token.
    test("eth_sendTransaction: the core's eth.send answered by the sheet; its dapp-send token presented under `page` with agent: true, naming its kind", async () => {
      const tab = agentTab();
      const answer = await tab.ask('eth_sendTransaction', SEND_PARAMS());
      expect(answer.result).toMatch(/^0x[0-9a-f]{64}$/);
      expect(approvals).toEqual([{ sheet: 'eth.send' }]);
      const handle = handedSend(tab.page);
      const signs = calls.filter((call) => call.method.startsWith('sign.'));
      expect(signs).toEqual([
        expect.objectContaining({
          method: 'sign.transaction',
          context: { caller: 'page', page: tab.page },
          params: expect.objectContaining({ authorization: { token: expect.any(String), kind: 'dapp-send', handle } }),
        }),
      ]);
      expect(Transaction.from(await signs[0].reply.then((reply) => reply.raw)).from).toBe(SIGNER);
      // No rule was asked for, so none is reported.
      expect((await signs[0].reply).rule ?? null).toBeNull();
    });

    test("a standing rule never answers it: the core asks the Agent's sheet, and refuses `{ standing }` in its tab (custody)", async () => {
      await fixtures.coreSigningRule(permissions, pageOf(SITE));
      const tab = agentTab();
      const answer = await tab.ask('personal_sign', ['0x68656c6c6f', SIGNER]);
      expect(require('ethers').verifyMessage('hello', answer.result)).toBe(SIGNER);
      // The core prompted, and the sheet answered: no rule's verdict, and
      // no token main minted.
      expect(approvals).toEqual([{ sheet: 'eth.sign' }]);
      expect(calls.filter((call) => call.method === 'approval.check' || call.method === 'approval.issue')).toEqual([]);
      // Under the PageContext main sent for the Agent's request, the core
      // answers no rule: custody.
      const page = calls.find((call) => call.method === 'eip1193.request').context.page;
      expect(page).toEqual(tab.page);
      expect(await sc.checkStanding(page, { kind: 'message', account: 0, accountType: 'mnemonic', payload: 'hello' })).toEqual({
        covered: false,
        reason: 'custody',
      });
      const ruled = require('./signers').getSigner(0, { page, standing: {}, chainId: 100 });
      const refused = await refusal(ruled.signMessage('hello'));
      expect(refused.reason).toBe('custody');
      calls.length = 0;
    });

    // A7-5: a send whose fee the core's check stops is never the sheet's:
    // the core gets a closed prompt, and the page today's fee text through
    // main's override. Here the core's fee evidence falls while the sheet
    // decides (main's own fee reference), so the core asks again with
    // feeAskAgain at the sheet's approve.
    test("a fee the core asks again (A7-5): the core's prompt closed cancelled, the page gets the fee-check text, nothing signed", async () => {
      const feeReference = () =>
        core.request('chain.fee_reference', { chain_id: 100, deadline_ms: 30_000 }, { caller: 'chrome' }, { watchdogMs: 60_000 });
      const tab = agentTab();
      const hold = holdSheet();
      try {
        const asking = tab.ask('eth_sendTransaction', SEND_PARAMS());
        await hold.reached;
        nodePrice = 1_000_000_000;
        await feeReference();
        hold.restore();
        hold.release();
        expect(await asking).toEqual({
          error: { code: -32603, message: expect.stringMatching(/^The network fee is .+× today's network fee\. Confirm it again to send\.$/) },
        });
        // The sheet's approve, then the core's prompt asked again, which
        // main closed without relaying an approve.
        expect(approvals).toEqual([{ sheet: 'eth.send' }, { sheet: 'eth.send' }]);
        expect(presented).toEqual([]);
        expect(calls.filter((call) => call.method.startsWith('sign.'))).toEqual([]);
      } finally {
        hold.restore();
        nodePrice = NODE_PRICE;
        await feeReference();
      }
    });

    test("the Agent declining a send: the core's prompt answered approve false, the page gets 4001; nothing minted or signed", async () => {
      const tab = agentTab();
      answerWith = 'declined';
      expect(await tab.ask('eth_sendTransaction', SEND_PARAMS())).toEqual({
        error: { code: 4001, message: 'User rejected the request' },
      });
      expect(approvals).toEqual([{ sheet: 'eth.send' }]);
      expect(presented).toEqual([]);
      expect(calls.filter((call) => call.method === 'approval.issue' || call.method.startsWith('sign.'))).toEqual([]);
    });

    // Codex on #1246, and A7-6 since APB-5b: main presents the core's token
    // as the signer is built, and the core spends it under the PageContext
    // read then; the signer waits after that (a vault's address, a device's
    // hash and the core's spend, the transaction service's fee and nonce).
    // Its last step reads the tab and the document again, right before the
    // core or the device is asked: a tab the Agent left, or a document gone,
    // at any of those waits signs nothing, sends nothing, and leaves no live
    // token.
    const ASKS = {
      personal_sign: (account) => ['personal_sign', ['0x68656c6c6f', account]],
      eth_signTypedData_v4: (account) => ['eth_signTypedData_v4', [account, JSON.stringify(TYPED_DATA)]],
      eth_sendTransaction: () => ['eth_sendTransaction', [{ to: TX.to, value: '0x' + BigInt(TX.value).toString(16), data: TX.data }]],
    };
    const KINDS = { personal_sign: 'sign-message', eth_signTypedData_v4: 'sign-typed-data', eth_sendTransaction: 'dapp-send' };
    const ACCOUNTS = { vault: [0, SIGNER], ledger: [LEDGER_INDEX, DEVICE_ADDRESS], phone: [PHONE_INDEX, DEVICE_ADDRESS] };

    // Holds the core's next reply to `method` until released.
    function holdCore(method) {
      const request = core.request;
      const reached = deferred();
      const released = deferred();
      core.request = (name, params, context, options) => {
        const reply = request(name, params, context, options);
        if (name !== method) return reply;
        core.request = request;
        const held = async (settle) => {
          reached.resolve();
          await released.promise;
          return settle();
        };
        return reply.then(
          (value) => held(() => value),
          (err) => held(() => Promise.reject(err))
        );
      };
      return { reached: reached.promise, release: released.resolve, restore: () => (core.request = request) };
    }

    // Holds the transaction service's own wait before it asks the signer.
    function holdService() {
      const wait = { ...deferred(), reached: deferred() };
      serviceWait = wait;
      return { reached: wait.reached.promise, release: wait.resolve, restore: () => (serviceWait = null) };
    }

    // Holds the Agent's sheet before it answers the core's prompt.
    function holdSheet() {
      const wait = { ...deferred(), reached: deferred() };
      sheetWait = wait;
      return { reached: wait.reached.promise, release: wait.resolve, restore: () => (sheetWait = null) };
    }

    // A send since APB-5b: the core's eth.send, answered by the sheet, and
    // its `{ send }` through main's steps (`page-core-sends.js`).
    describe.each([
      ["a vault send, at the transaction service's wait", 'vault', 'eth_sendTransaction', 'service'],
      ["a Ledger send, at the transaction service's wait", 'ledger', 'eth_sendTransaction', 'service'],
      ["a Ledger send, at the core's spend", 'ledger', 'eth_sendTransaction', 'approval.spend'],
      // A phone's job spends the token as the core opens it (PHN-2).
      ["a phone send, at the transaction service's wait", 'phone', 'eth_sendTransaction', 'service'],
      ["a phone send, at the core's job", 'phone', 'eth_sendTransaction', 'phone.job'],
    ])('%s', (_label, held, method, holdAt) => {
      const [index, address] = ACCOUNTS[held];

      test.each([
        ['the Agent leaves the tab', (tab) => custody.delete(tab.guest.id), { error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } }],
        ['the document navigates', (tab) => tab.guest.commit(`${SITE}/next`), { gone: true }],
        ['nothing changes', () => {}, null],
      ])('%s there: the signer\'s last step decides', async (_change, change, refused) => {
        await fixtures.coreConnect(permissions, index, 100, pageOf(SITE));
        const tab = agentTab();
        const hold = holdAt === 'service' ? holdService() : holdCore(holdAt);
        let answer;
        try {
          const asking = tab.ask(...ASKS[method](address));
          await hold.reached;
          // The core's token handed to main's signer, which waits.
          expect(approvals).toEqual([{ sheet: 'eth.send' }]);
          const handle = handedSend(tab.page);
          const issued = presented[0];
          change(tab);
          hold.release();
          answer = await asking;
          await Promise.allSettled(running);
          const signs = calls.filter((call) => call.method.startsWith('sign.'));
          if (refused?.gone) {
            // The document gone: main's steps read it in the send's turn and
            // at the commit, not as the signer's last step (A7-6 adds
            // custody there), as for any page's send (APB-4c). A vault's or
            // a Ledger's signed send is never committed; a phone's job signs
            // and broadcasts in one step, with no such point.
            expect(answer).toEqual(refused);
            expect(committed).toEqual([]);
            calls.length = 0;
          } else if (refused) {
            expect(answer).toEqual(refused);
            expect(committed).toEqual([]);
            // Neither the core nor the device was asked.
            expect(signs).toEqual([]);
            expect(deviceAsked).toEqual([]);
            // No live token: spent by a device's signer before its last
            // step, or burnt unspent.
            const { page } = issued;
            expect(
              await reasonOf(
                vaultBackend.sign.message(account(0), Buffer.from('hello'), {
                  authorization: { token: issued.token, handle },
                  page,
                })
              )
            ).toBe('unknown_token');
            calls.length = 0;
          } else {
            expect(answer).toEqual({ result: expect.stringMatching(/^0x[0-9a-f]+$/) });
            expect(committed).toHaveLength(held === 'phone' ? 0 : 1);
            if (held === 'vault') {
              expect(signs).toHaveLength(1);
              expect(deviceAsked).toEqual([]);
            } else {
              expect(signs).toEqual([]);
              expect(deviceAsked).toHaveLength(1);
              // A Ledger's token spent with approval.spend; a phone's by the
              // core's job, which checked the phone's answer.
              const spent = held === 'phone' ? ['phone.job', 'phone.result'] : ['approval.spend'];
              for (const method of spent) expect(calls.filter((call) => call.method === method)).toHaveLength(1);
              if (held === 'phone') expect(calls.filter((call) => call.method === 'approval.spend')).toEqual([]);
            }
          }
        } finally {
          hold.restore();
        }
      });
    });

    // A signature since APB-5a: the core's eth.sign prompt, answered by the
    // Agent's sheet. The core signs a vault's at once on the approve, which
    // main answers only while the Agent still holds the tab (A7-6); a
    // device's `{ device }` goes through main's signer (`page-devices.js`)
    // with the core's token, the tab read again as its last step, right
    // before the device is asked. Main mints nothing.
    describe.each([
      ["a vault message, at the sheet's approve", 'vault', 'personal_sign', 'sheet'],
      ["vault typed data, at the sheet's approve", 'vault', 'eth_signTypedData_v4', 'sheet'],
      ["a Ledger message, at the core's spend", 'ledger', 'personal_sign', 'approval.spend'],
      ["Ledger typed data, at the core's hash", 'ledger', 'eth_signTypedData_v4', 'typed_data.hash'],
      ["Ledger typed data, at the core's spend", 'ledger', 'eth_signTypedData_v4', 'approval.spend'],
      // A phone's job spends the token as the core opens it (PHN-2).
      ["a phone message, at the core's job", 'phone', 'personal_sign', 'phone.job'],
      ["phone typed data, at the core's hash", 'phone', 'eth_signTypedData_v4', 'typed_data.hash'],
      ["phone typed data, at the core's job", 'phone', 'eth_signTypedData_v4', 'phone.job'],
    ])('%s', (_label, held, method, holdAt) => {
      const [index, address] = ACCOUNTS[held];
      // A document gone while a device's step waits isn't read again before
      // the device is asked: a device's step is any page's (APB-4c,
      // `page-devices.js`), with custody added (A7-6). The page hears
      // `{ gone: true }` all the same.
      const changes = [
        ['the Agent leaves the tab', (tab) => custody.delete(tab.guest.id), { error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } }],
        ...(held === 'vault' ? [['the document navigates', (tab) => tab.guest.commit(`${SITE}/next`), { gone: true }]] : []),
        ['nothing changes', () => {}, null],
      ];

      test.each(changes)("%s there: the sheet's answer, or the device signer's last step, decides", async (_change, change, refused) => {
        await fixtures.coreConnect(permissions, index, 100, pageOf(SITE));
        const tab = agentTab();
        const hold = holdAt === 'sheet' ? holdSheet() : holdCore(holdAt);
        try {
          const asking = tab.ask(...ASKS[method](address));
          await hold.reached;
          expect(approvals).toEqual([{ sheet: 'eth.sign' }]);
          change(tab);
          hold.release();
          const answer = await asking;
          await Promise.allSettled(running);
          const relayed = calls.find((call) => call.method === 'eip1193.request');
          expect(relayed.context).toEqual({ caller: 'page', page: tab.page });
          const reply = await relayed.reply.catch((err) => ({ refused: err }));
          const signs = calls.filter((call) => call.method.startsWith('sign.'));
          expect(signs).toEqual([]);
          expect(calls.filter((call) => call.method === 'approval.issue')).toEqual([]);
          if (refused) {
            expect(answer).toEqual(refused);
            // Neither the core nor the device signed.
            expect(reply.result).toBeUndefined();
            expect(deviceAsked).toEqual([]);
            // A device's token, presented to its signer: no longer live.
            for (const confirmation of presented) {
              expect(
                await reasonOf(
                  vaultBackend.sign.message(account(0), Buffer.from('hello'), {
                    authorization: { token: confirmation.token, handle: confirmation.handle },
                    page: confirmation.page,
                  })
                )
              ).toBe('unknown_token');
            }
            calls.length = 0;
          } else {
            expect(answer).toEqual({ result: expect.stringMatching(/^0x[0-9a-f]+$/) });
            if (held === 'vault') {
              // The core's own signature, in its reply.
              expect(reply.result).toBe(answer.result);
              expect(presented).toEqual([]);
              expect(deviceAsked).toEqual([]);
            } else {
              expect(presented).toEqual([expect.objectContaining({ kind: KINDS[method], account: index, page: expect.objectContaining({ agent: true }) })]);
              expect(deviceAsked).toHaveLength(1);
              // A Ledger's token spent with approval.spend; a phone's by the
              // core's job, which checked the phone's answer.
              const spent = held === 'phone' ? ['phone.job', 'phone.result'] : ['approval.spend'];
              for (const name of spent) expect(calls.filter((call) => call.method === name)).toHaveLength(1);
              if (held === 'phone') expect(calls.filter((call) => call.method === 'approval.spend')).toEqual([]);
            }
          }
        } finally {
          hold.restore();
        }
      });
    });

    // Codex round 2 on #1246: a Ledger's backend waits again after the
    // signer's own steps (its device queue, the transport's open, the
    // device's address check), so the caller's last check runs inside that
    // session, right before the signing APDU. Main's real Ledger backend
    // and transport here, over a fake HID device.
    describe("a Ledger's device session: the last check after its queue, its open and its address", () => {
      const NAME = 'example.com';
      const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
      const tick = async () => {
        for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
      };
      // The step held, and how to tell the request has reached it: the
      // device queue held by another device task (the request queued once
      // its token's spend has settled), the
      // transport's open, or the device's address check.
      const HOLDS = {
        'the device queue': (settled) => {
          const gate = deferred();
          const blocker = require('./ledger/transport').withEthApp(() => gate.promise);
          return { reached: settled().then(tick), release: gate.resolve, done: blocker };
        },
        "the transport's open": () => {
          const gate = deferred();
          const reached = deferred();
          const open = devices.ledger.open;
          devices.ledger.open = async (...args) => {
            reached.resolve();
            await gate.promise;
            return open(...args);
          };
          return { reached: reached.promise, release: gate.resolve, done: Promise.resolve() };
        },
        "the device's address check": () => {
          const gate = deferred();
          const reached = deferred();
          const getAddress = devices.ledger.getAddress;
          devices.ledger.getAddress = async (...args) => {
            reached.resolve();
            await gate.promise;
            return getAddress(...args);
          };
          return { reached: reached.promise, release: gate.resolve, done: Promise.resolve() };
        },
      };
      // Polled by the clock, not by turns: the core's replies take their
      // own time, more under load.
      const until = async (found, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (!found() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        if (!found()) throw new Error('the request never reached the held step');
        return found();
      };
      // The `nth` call of `method` settled: the last wait before the signer.
      const settledCall = (method, nth = 1) => async () => {
        const call = await until(() => calls.filter((entry) => entry.method === method)[nth - 1]);
        await call.reply.catch(() => {});
      };

      let ledgerHolds = [];
      beforeEach(() => {
        names.set(NAME, IPNS_KEY);
        ledgerHolds = [];
      });

      afterEach(async () => {
        for (const hold of ledgerHolds) hold.release();
        await Promise.allSettled([...ledgerHolds.map((hold) => hold.done), ...running]);
        names.clear();
        await permissions.revokePermission(NAME);
      });

      const LEFT = ['the Agent leaves the tab', (tab) => custody.delete(tab.guest.id), { error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } }];
      const UNCHANGED = ['nothing changes', () => {}, null];

      // Each change at the held step: what the page gets and which APDU the
      // device was sent.
      async function atHeldStep(held, method, apdu, changes, { name = null, grantKey = SITE } = {}) {
        for (const [change, act, refused] of changes) {
          calls.length = 0;
          deviceAsked = [];
          running = [];
          names.set(NAME, IPNS_KEY);
          await fixtures.coreConnect(permissions, LEDGER_INDEX, 100, pageOf(grantKey));
          const tab = agentTab({ name });
          const hold = HOLDS[held](settledCall('approval.spend'));
          const asking = tab.ask(...ASKS[method](DEVICE_ADDRESS));
          // A failure never leaves the device queue held for the next.
          ledgerHolds.push(hold);
          await hold.reached;
          // Past the token's spend, in the device session: no APDU yet.
          expect({ change, spent: calls.filter((call) => call.method === 'approval.spend').length, asked: deviceAsked }).toEqual({ change, spent: 1, asked: [] });
          act(tab);
          hold.release();
          await hold.done;
          const answer = await asking;
          await Promise.allSettled(running);
          if (refused) {
            expect({ change, answer }).toEqual({ change, answer: refused });
            expect({ change, asked: deviceAsked }).toEqual({ change, asked: [] });
          } else {
            expect({ change, answer }).toEqual({ change, answer: { result: expect.stringMatching(/^0x[0-9a-f]+$/) } });
            expect({ change, asked: deviceAsked }).toEqual({ change, asked: [['ledger', apdu]] });
          }
          expect(calls.filter((call) => call.method.startsWith('sign.'))).toEqual([]);
          // The device is free for the next.
          await expect(require('./ledger/transport').withEthApp(async () => 'free')).resolves.toBe('free');
        }
      }

      describe.each(Object.keys(HOLDS))('%s held', (held) => {
        // A send since APB-5b: the `{ send }` the core hands main after the
        // sheet's approve, through main's steps (`page-core-sends.js`) and
        // its own Ledger backend, with custody read again inside the device
        // session (A7-6), in a plain tab as the signatures'. The document and
        // the name are any page's send's (APB-4c, APB-4e): read in the
        // send's turn and at the commit.
        test("the Agent's eth_sendTransaction, the sheet's: the tab left there sends no signing APDU; unchanged, one", async () => {
          await atHeldStep(held, 'eth_sendTransaction', 'signTransaction', [LEFT, UNCHANGED]);
        });

        // A signature since APB-5a: the `{ device }` the core hands main
        // after the sheet's approve, through main's own Ledger backend, with
        // custody read again inside the device session (A7-6). The document
        // and the name are any page's device step's (APB-4c).
        test.each([
          ['personal_sign', 'signMessage'],
          ['eth_signTypedData_v4', 'signTypedData'],
        ])("the Agent's %s, the sheet's: the tab left there sends no signing APDU; unchanged, one", async (method, apdu) => {
          await atHeldStep(held, method, apdu, [LEFT, UNCHANGED]);
        });
      });
    });
  });

  // APB-1c: the Safe approval a Safe's spend gives, presented by each vault
  // owner's `sign.typed_data` and the executor's `sign.transaction` as
  // `{ safe }`, under the caller it was recorded for, until main ends it.
  describe("Safe approvals: each owner's and the executor's signature (APB-1c)", () => {
    const { Interface, hashMessage, concat } = require('ethers');
    const ZERO = '0x' + '00'.repeat(20);
    const OWNER = new Wallet(ABANDON_KEY).address;
    const SAFE_CALL = Object.freeze({ to: TX.to, value: '5', data: '0x' });
    const EXEC = new Interface([
      'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
    ]);
    const DOMAIN_TYPE = [
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ];
    // A SafeTx as safe-executor builds one for a call (protocol-kit's
    // createTransaction): operation 0, no refund.
    const safeTx = (call = SAFE_CALL, nonce = 3) => ({
      domain: { chainId: 100, verifyingContract: SAFE_ADDRESS },
      types: {
        EIP712Domain: DOMAIN_TYPE,
        SafeTx: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' },
          { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' },
          { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      primaryType: 'SafeTx',
      message: {
        ...call,
        operation: 0,
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: ZERO,
        refundReceiver: ZERO,
        nonce: String(nonce),
      },
    });
    // A SafeMessage as safe-messages builds one: the digest a verifier
    // computes for the page's request.
    const safeMessage = (digest) => ({
      domain: { chainId: 100, verifyingContract: SAFE_ADDRESS },
      types: { EIP712Domain: DOMAIN_TYPE, SafeMessage: [{ name: 'message', type: 'bytes' }] },
      primaryType: 'SafeMessage',
      message: { message: digest },
    });
    // The executor's transaction: execTransaction to the Safe, value 0, the
    // SafeTx field for field, with the owners' signatures.
    const execSend = (signatures, call = SAFE_CALL) => ({
      to: SAFE_ADDRESS,
      value: '0',
      data: EXEC.encodeFunctionData('execTransaction', [call.to, call.value, call.data, 0, 0, 0, 0, ZERO, ZERO, concat(signatures)]),
      chainId: 100,
      gasLimit: '150000',
      maxFeePerGas: TX.maxFeePerGas,
      maxPriorityFeePerGas: TX.maxPriorityFeePerGas,
    });
    let getSigner;

    beforeAll(() => {
      ({ getSigner } = require('./signers'));
    });

    const owner = (approval) => getSigner(0, { safe: approval });
    const notConfirmed = async (promise) => {
      const err = await refusal(promise);
      expect(err.code).toBe('SIGNING_NOT_CONFIRMED');
      return err.reason;
    };
    const walletApproval = async (call = SAFE_CALL) =>
      (await sc.spendSafeConfirmation(await walletToken('safe-send', SAFE_INDEX, { tx: call, chainId: 100 }))).approval;
    const pageApproval = async (kind, payload, page = PAGE) =>
      (await sc.spendSafeConfirmation(await pageToken(kind, SAFE_INDEX, payload, page))).approval;

    test("a wallet's: its owners sign the SafeTx it approved as main itself, the first fixing it; nothing else", async () => {
      const approval = await walletApproval();
      // Another call, or the same call on another chain, is refused.
      await expect(notConfirmed(owner(approval).signTypedData(safeTx({ ...SAFE_CALL, value: '6' })))).resolves.toBe('mismatch');
      await expect(
        notConfirmed(owner(approval).signTypedData({ ...safeTx(), domain: { chainId: 1, verifyingContract: SAFE_ADDRESS } }))
      ).resolves.toBe('mismatch');
      // Under a page: not the wallet's caller.
      await expect(notConfirmed(owner({ ...approval, page: PAGE }).signTypedData(safeTx()))).resolves.toBe('mismatch');
      // The SafeTx itself, at its nonce, as main: signed, under `shell`.
      const signature = await owner(approval).signTypedData(safeTx());
      const { domain, types, message } = safeTx();
      const { EIP712Domain: _domain, ...signed } = types;
      expect(require('ethers').verifyTypedData(domain, signed, message, signature)).toBe(OWNER);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.typed_data',
        context: { caller: 'shell' },
        params: { authorization: { safe: approval.id } },
      });
      // Fixed: the same SafeTx again, but not one at another nonce.
      await expect(owner(approval).signTypedData(safeTx())).resolves.toBe(signature);
      await expect(notConfirmed(owner(approval).signTypedData(safeTx(SAFE_CALL, 4)))).resolves.toBe('mismatch');
      // A message is never a Safe owner's.
      await expect(notConfirmed(owner(approval).signMessage('hello'))).resolves.toBe('mismatch');
      // Ended (main's discard): every later use refused, and ending again is {}.
      await expect(vaultBackend.approval.end(approval.id)).resolves.toEqual({});
      await expect(notConfirmed(owner(approval).signTypedData(safeTx()))).resolves.toBe('unknown_token');
      await expect(vaultBackend.approval.end(approval.id)).resolves.toEqual({});
    });

    test("a page's: signed only under its own PageContext, the document gone or not; never as main's", async () => {
      const approval = await pageApproval('safe-send', { tx: SAFE_CALL, chainId: 100, origin: SITE });
      expect(approval.page).toEqual(PAGE);
      for (const other of [null, { ...PAGE, navigation: PAGE.navigation + 1 }, { ...PAGE, frame: PAGE.frame + 1 }, { ...PAGE, origin: OTHER_SITE, top_origin: OTHER_SITE }]) {
        await expect(notConfirmed(owner({ ...approval, page: other }).signTypedData(safeTx()))).resolves.toBe('mismatch');
      }
      await expect(owner(approval).signTypedData(safeTx())).resolves.toMatch(/^0x[0-9a-f]{130}$/);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.typed_data',
        context: { caller: 'page', page: PAGE },
        params: { authorization: { safe: approval.id } },
      });
      await vaultBackend.approval.end(approval.id, PAGE);
      expect(calls.at(-1)).toMatchObject({ method: 'approval.end', context: { caller: 'page', page: PAGE } });
    });

    test("the executor: the approval while the core's fee check allows it, else an executor-send token; main ends it once executed", async () => {
      const approval = await walletApproval();
      const ownerSignature = await owner(approval).signTypedData(safeTx());
      const send = execSend([ownerSignature]);
      const executor = (authorized) => getSigner(0, authorized);
      const signedTx = (built) => buildTransaction({ ...built, nonce: 7 });
      // Another call than the SafeTx approved: refused whatever the fee.
      await expect(
        notConfirmed(executor({ safe: approval }).signTransaction(signedTx(execSend([ownerSignature], { ...SAFE_CALL, value: '6' }))))
      ).resolves.toBe('mismatch');
      // No fee evidence served to this core: its fee check stops the
      // approval, with nothing signed (main asks the fee: safe-executor.js).
      await expect(notConfirmed(executor({ safe: approval }).signTransaction(signedTx(send)))).resolves.toBe('fee_check');
      // The user confirms the fee: an executor-send token, named as its kind.
      const { token } = await sc.issueConfirmation('executor-send', 0, send);
      const confirmation = sc.confirmationFor(token, 'executor-send', 0, send);
      const raw = await executor({ confirmation }).signTransaction(signedTx(send));
      expect(Transaction.from(raw).from).toBe(OWNER);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.transaction',
        context: { caller: 'shell' },
        params: { authorization: { kind: 'executor-send' } },
      });
      // Executed: main ends the approval, and no owner signs with it again.
      await vaultBackend.approval.end(approval.id);
      await expect(notConfirmed(owner(approval).signTypedData(safeTx()))).resolves.toBe('unknown_token');
    });

    test("a Safe's new send approval ends its older one", async () => {
      const older = await walletApproval();
      const newer = await walletApproval();
      await expect(notConfirmed(owner(older).signTypedData(safeTx()))).resolves.toBe('unknown_token');
      await expect(owner(newer).signTypedData(safeTx())).resolves.toMatch(/^0x/);
      await vaultBackend.approval.end(newer.id);
    });

    test("a page's Safe message: its owners sign the SafeMessage over the request's digest, under its page, until ended", async () => {
      const request = { method: 'personal_sign', params: ['0x68656c6c6f', SAFE_ADDRESS] };
      const approval = await pageApproval('safe-message', request);
      const digest = hashMessage(require('ethers').getBytes('0x68656c6c6f'));
      await expect(notConfirmed(owner(approval).signTypedData(safeMessage(hashMessage('other'))))).resolves.toBe('mismatch');
      await expect(notConfirmed(owner({ ...approval, page: null }).signTypedData(safeMessage(digest)))).resolves.toBe('mismatch');
      await expect(owner(approval).signTypedData(safeMessage(digest))).resolves.toMatch(/^0x[0-9a-f]{130}$/);
      // The threshold's last signature: main ends it before the join.
      await vaultBackend.approval.end(approval.id, PAGE);
      await expect(notConfirmed(owner(approval).signTypedData(safeMessage(digest)))).resolves.toBe('unknown_token');
    });

    // cored 0.16.0 (design 0012, APR-4b): main's word signs no Safe's
    // signature. Without its Safe approval or a token that binds it, an
    // owner's SafeTx or SafeMessage and an executor's execTransaction are
    // refused `no_token` before the key, while the vault is locked too, and
    // `{ standing }` answers none (`no_rule`). Main's other typed data still
    // signs on its word.
    test("main's word alone signs no Safe's signature: no_token, locked or not; no standing rule answers one", async () => {
      const bare = getSigner(0);
      const digest = hashMessage('hello');
      await expect(notConfirmed(bare.signTypedData(safeTx()))).resolves.toBe('no_token');
      await expect(notConfirmed(bare.signTypedData(safeMessage(digest)))).resolves.toBe('no_token');
      const approval = await walletApproval();
      const ownerSignature = await owner(approval).signTypedData(safeTx());
      await vaultBackend.approval.end(approval.id);
      const send = buildTransaction({ ...execSend([ownerSignature]), nonce: 7 });
      await expect(notConfirmed(bare.signTransaction(send))).resolves.toBe('no_token');
      expect(calls.at(-1)).toMatchObject({ method: 'sign.transaction', context: { caller: 'shell' } });
      expect(calls.at(-1).params).not.toHaveProperty('authorization');
      const hashOf = (typed) => {
        const { EIP712Domain: _domain, ...types } = typed.types;
        return TypedDataEncoder.hash(typed.domain, types, typed.message);
      };
      const shellSafeTx = (options) =>
        vaultBackend.sign.typedData(account(), toCoreTypedData(safeTx()), hashOf(safeTx()), options);
      expect(await reasonOf(shellSafeTx({ authorization: { standing: {} } }))).toBe('no_rule');
      expect(await reasonOf(shellSafeTx({ page: PAGE, authorization: { standing: {} } }))).toBe('no_rule');
      await vaultBackend.lock();
      try {
        expect(await reasonOf(shellSafeTx())).toBe('no_token');
      } finally {
        await vaultBackend.unlock('testpass1');
      }
      await expect(bare.signTypedData(TYPED_DATA)).resolves.toMatch(/^0x[0-9a-f]{130}$/);
    });

    // Review of #1245, round 1: main ends a held approval through the core
    // and counts a failed end only once the core process that gave it has
    // ended, since a new process knows none of its approvals. Last: it
    // restarts the core.
    test('held by main, ended through the core ({} again once ended); a restarted core knows none', async () => {
      const safeApprovals = require('./safe/safe-approvals');
      safeApprovals._reset();
      const hash = '0x' + '11'.repeat(32);
      const ended = await walletApproval();
      await safeApprovals.hold('send', SAFE_INDEX, ended, hash);
      await safeApprovals.end('send', SAFE_INDEX, hash);
      expect(calls.at(-1)).toMatchObject({ method: 'approval.end', params: { safe: ended.id }, context: { caller: 'shell' } });
      await expect(safeApprovals.release(ended)).resolves.toBeUndefined();
      await expect(notConfirmed(owner(ended).signTypedData(safeTx()))).resolves.toBe('unknown_token');

      const live = await walletApproval();
      await safeApprovals.hold('send', SAFE_INDEX, live, hash);
      const mark = vaultBackend.coreProcess();
      expect(vaultBackend.coreProcessEnded(mark)).toBe(false);
      // The core process exits (a crash), and main's client starts another.
      const exited = new Promise((resolve) => core.once('exit', resolve));
      const restarted = new Promise((resolve) => core.once('ready', resolve));
      core.current.child.kill('SIGKILL');
      await exited;
      expect(vaultBackend.coreProcessEnded(mark)).toBe(true);
      await restarted;
      expect(vaultBackend.coreProcessEnded(mark)).toBe(true);
      expect(vaultBackend.coreProcessEnded(vaultBackend.coreProcess())).toBe(false);
      await expect(safeApprovals.end('send', SAFE_INDEX, hash)).resolves.toBeUndefined();
      await vaultBackend.unlock('testpass1');
      await expect(notConfirmed(owner(live).signTypedData(safeTx()))).resolves.toBe('unknown_token');
    }, 30_000);
  });
});

// APB-2 (design 0012, "The files (Q10)", Q9): `dapp-permissions.json` is the
// core's. Main names it in the hello's `grant_moved`, every write goes to the
// core's write methods (main writes the file nowhere: a spy on `fs`), and
// today's unlimited rules answer nothing. A profile from before the move,
// with today's signing flag and a contract rule, prompts for both; "Always
// allow" on each prompt has the core write the limited replacement and clear
// today's rule in the same write, so the reference (the build before APB-2,
// test/helpers/reference-dapp-permissions.js) then finds no rule for either.
// Rolled back, the reference reads the core's file and sees the same grants.
describeIfBinary('the dApp file, the core\'s from APB-2 (real freedom-cored)', () => {
  const SELECTOR = TX.data.slice(0, 10);
  const THIRD_SITE = 'https://third.example';
  const TODAY_RULE = Object.freeze({ to: TX.to.toLowerCase(), selector: SELECTOR, chainId: 100, maxValue: TX.value });
  // A profile written by a build before APB-2.
  const TODAY = Object.freeze({
    [SITE]: {
      origin: SITE,
      connectedAt: 1700000000000,
      lastUsed: 1700000000001,
      walletIndex: 0,
      chainId: 100,
      autoApprove: { signing: true, transactions: [TODAY_RULE] },
    },
    [OTHER_SITE]: {
      origin: OTHER_SITE,
      connectedAt: 1700000000000,
      lastUsed: 1700000000000,
      walletIndex: 0,
      chainId: 1,
      autoApprove: { signing: false, transactions: [] },
    },
  });
  const SEND = Object.freeze({
    to: TX.to,
    value: TX.value,
    data: TX.data,
    chainId: 100,
    gasLimit: TX.gasLimit,
    maxFeePerGas: TX.maxFeePerGas,
    maxPriorityFeePerGas: TX.maxPriorityFeePerGas,
  });
  const FS_WRITES = ['writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'truncateSync', 'unlinkSync', 'rmSync', 'openSync'];
  const FS_PROMISE_WRITES = ['writeFile', 'appendFile', 'rename', 'copyFile', 'truncate', 'unlink', 'rm', 'open'];

  let root;
  let core;
  let calls;
  let fixtures;
  let sc;
  let permissions;
  let reference;
  let getSigner;
  let buildTransaction;
  let vaultBackend;
  let spies;

  const file = () => path.join(root, 'dapp-permissions.json');
  const readReference = () => {
    reference._resetCache();
    return reference;
  };
  const coreRecords = async () => (await vaultBackend.approval.grants({ store: 'dapp' })).records;
  const check = (request, page = PAGE) => sc.checkStanding(page, { account: 0, accountType: 'remote', ...request });
  const message = { kind: 'message', payload: 'hello' };
  const send = { kind: 'transaction', payload: SEND, paused: false };
  async function flaggedSend(page = PAGE) {
    const confirmation = await fixtures.pageToken('dapp-send', 0, { ...SEND, origin: page.origin }, page, HANDLE, {
      remember: true,
    });
    const heard = [];
    await getSigner(0, { confirmation, onRule: (rule) => heard.push(rule) }).signTransaction(buildTransaction({ ...(confirmation.sent ?? SEND), nonce: 7 }));
    return heard;
  }
  async function refusal(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error('expected a refusal');
  }
  async function until(condition) {
    for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(condition()).toBe(true);
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dapp-file-moved-'));
    fs.writeFileSync(path.join(root, 'dapp-permissions.json'), JSON.stringify(TODAY, null, 2), { mode: 0o600 });
    const { CoreClient } = require('../core/core-client');
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    calls = [];
    const request = core.request.bind(core);
    core.request = (method, params, context, options) => {
      calls.push({ method, context, params });
      return request(method, params, context, options);
    };
    const chainShell = { ...require('../core/chain-shell'), makeHop: require('../core/naming-shell').makeHop };
    fixtures = coreFixtures(request, () => sc, () => ({ client: core, chainShell, mainTxOf: require('../page/page-core-sends').mainTxOf }));
    jest.resetModules();
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../identity-manager', () => ({
      getWalletRecord: () => null,
      isHardwareWalletIndex: () => false,
      recordLedgerAddressCheck: () => {},
      recordRemoteAddressCheck: () => {},
      WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
    }));
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    jest.doMock('./ledger/signer', () => ({ createLedgerBackend: () => ({}) }));
    jest.doMock('./remote/signer', () => ({ createRemoteBackend: () => ({}) }));
    // The reference reads the file where the core writes it.
    jest.doMock('../freedom-root', () => ({ getFreedomDataPath: (name) => path.join(root, name) }));
    sc = require('./signing-confirmation');
    ({ vaultBackend } = require('../core/vault-backend'));
    ({ buildTransaction } = require('./transaction-service'));
    ({ getSigner } = require('./signers'));
    permissions = require('./dapp-permissions');
    reference = require('../../../test/helpers/reference-dapp-permissions');
    // Main's copy follows the core: read whole at the handshake, a key again
    // for each approval.changed (core-process.js attaches it).
    permissions.attachCore(core);
    await core.start();
    await permissions.whenLoaded();
    await vaultBackend.importVault('testpass1', ABANDON);
  });

  afterAll(async () => {
    await fixtures.close();
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
    fixtures.calls.length = 0;
    spies = [...FS_WRITES.map((name) => jest.spyOn(fs, name)), ...FS_PROMISE_WRITES.map((name) => jest.spyOn(fs.promises, name))];
  });

  afterEach(() => {
    // Main mints no page kind and writes no dApp grant under `page` (APB-5).
    expect(pageMintsAndGrants(calls)).toEqual([]);
    // Main writes the dApp file nowhere: the core is its only writer. (A
    // read opens it 'r'.)
    for (const spy of spies) {
      spy.mock.calls.forEach(([target, second]) => {
        if (spy === fs.openSync || spy === fs.promises.open) {
          if (second === undefined || second === 'r') return;
        }
        expect(String(target)).not.toMatch(/dapp-permissions\.json/);
        if (typeof second === 'string') expect(second).not.toMatch(/dapp-permissions\.json/);
      });
      spy.mockRestore();
    }
    expect(unmovedWrites(calls)).toEqual([]);
  });

  test("the hello names the moved files in grant_moved, and main's copy is the store the core read", async () => {
    expect([...core.service.helloParams(core).grant_moved].sort()).toEqual(['dapp', 'radicle', 'swarm', 'x402']);
    expect(permissions.getPermission(SITE)).toEqual(TODAY[SITE]);
    expect(permissions.getPermission(OTHER_SITE)).toEqual(TODAY[OTHER_SITE]);
    expect(await coreRecords()).toEqual([TODAY[SITE], TODAY[OTHER_SITE]]);
    expect(calls.at(-1)).toMatchObject({ method: 'approval.grants', context: { caller: 'shell' } });
  });

  test("today's unlimited rules answer nothing (Q9): the site's signature and its send each prompt", async () => {
    expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
    expect(await check(send)).toEqual({ covered: false, reason: 'no_rule' });
    const signer = getSigner(0, { page: PAGE, standing: {}, chainId: 100 });
    const err = await refusal(signer.signMessage('hello'));
    expect(err).toMatchObject({ code: 'SIGNING_NOT_CONFIRMED', reason: 'no_rule' });
    // The older build still answers them in the file as it stands.
    expect(readReference().getSigningAutoApprove(SITE)).toBe(true);
    expect(readReference().isTransactionAutoApproved(SITE, TX.to, SELECTOR, 100, TX.value)).toBe(true);
  });

  test("Q9's transition: the limited replacements through the browser's own prompt; the reference then finds no rule for either", async () => {
    // "Always allow" on the core's signing prompt (APB-4b): Q9's limited
    // rule, under the page, which clears today's flag.
    expect(await fixtures.coreSigningRule(permissions, PAGE)).toBeTruthy();
    expect(fixtures.calls.find((call) => call.method === 'eip1193.request' && call.params.method === 'personal_sign')).toMatchObject({
      context: { caller: 'page', page: PAGE },
      prompts: [{ kind: 'eth.sign', choices: { alwaysAllow: true } }],
    });
    // "Always allow" on the core's send prompt (APB-4c): the core
    // writes the limited contract rule as it signs, clearing today's.
    expect(await flaggedSend()).toEqual([{ added: true }]);
    // The new build answers both.
    expect(await check(message)).toEqual({ covered: true, reason: null });
    expect(await check(send)).toEqual({ covered: true, reason: null });
    // The file: the limited rules where an older build doesn't look, today's
    // cleared, the rest as it was.
    const written = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(written[SITE]).toEqual({
      ...TODAY[SITE],
      autoApprove: {
        signing: false,
        transactions: [],
        limited: {
          signing: { grantedAt: expect.any(Number) },
          transactions: [{ ...TODAY_RULE, grantedAt: expect.any(Number) }],
        },
      },
    });
    expect(written[OTHER_SITE]).toEqual(TODAY[OTHER_SITE]);
    // An older build, reading the core's file, finds no rule for either, and
    // prompts for both.
    const older = readReference();
    expect(older.getSigningAutoApprove(SITE)).toBe(false);
    expect(older.isTransactionAutoApproved(SITE, TX.to, SELECTOR, 100, TX.value)).toBe(false);
    expect(older.isTransactionAutoApproved(SITE, TX.to, SELECTOR, 100, '0')).toBe(false);
    expect(older.getPermission(SITE).walletIndex).toBe(0);
    // Main's copy followed the core's change (approval.changed).
    await until(() => permissions.getPermission(SITE)?.autoApprove?.limited?.transactions?.length === 1);
  });

  test('rollback: the reference reads the file the core wrote and sees the same grants', async () => {
    const third = { ...PAGE, origin: THIRD_SITE, top_origin: THIRD_SITE };
    await fixtures.coreConnect(permissions, 1, 10, third);
    await fixtures.coreAccount(permissions, 2, third);
    await permissions.updateLastUsed(THIRD_SITE, 100, third);
    expect(await permissions.revokePermission(OTHER_SITE)).toBe(true);
    // The chrome's revoke goes as the chrome (design 0012, API).
    expect(calls.filter((call) => call.method === 'approval.revoke').at(-1)).toMatchObject({
      params: { store: 'dapp', key: OTHER_SITE, what: 'grant' },
      context: { caller: 'chrome' },
    });
    const records = await coreRecords();
    const older = readReference();
    expect(older.getAllPermissions()).toEqual(records);
    for (const record of records) expect(older.getPermission(record.origin)).toEqual(record);
    expect(older.getPermission(THIRD_SITE)).toMatchObject({ origin: THIRD_SITE, walletIndex: 2, chainId: 100 });
    // A grant revoked in the new build stays revoked.
    expect(older.getPermission(OTHER_SITE)).toBeNull();
    // The text is today's: JSON.stringify(…, null, 2).
    const text = fs.readFileSync(file(), 'utf8');
    expect(JSON.stringify(JSON.parse(text), null, 2)).toBe(text);
    // Main's copy is the core's.
    await until(() => permissions.getPermission(OTHER_SITE) === null);
    expect(permissions.getAllPermissions().map((record) => record.origin).sort()).toEqual(records.map((r) => r.origin).sort());
  });

  // APR-7: a page's dApp grant comes only from the core's own prompt. An
  // account change (or any dApp grant) asked under `page`, for a key the
  // core holds no grant for or one it does, is refused before the change.
  test("a dApp grant asked under `page` (connect, account, signing, transaction), for a key the core holds no grant for or one it does: refused, the core writes nothing, and main's copy has none", async () => {
    const fourth = 'https://fourth.example';
    const page = { ...PAGE, origin: fourth, top_origin: fourth };
    const before = fs.readFileSync(file(), 'utf8');
    const recordsBefore = await coreRecords();
    // All four dApp changes. A `transaction` rule is refused by APR-7's
    // check, before the older "only with a confirmed send" refusal.
    const changes = [
      [page, { op: 'account', account: 1 }],
      [page, { op: 'connect', account: 1, chain_id: 100 }],
      [PAGE, { op: 'account', account: 1 }],
      [PAGE, { op: 'signing' }],
      [PAGE, { op: 'transaction' }],
    ];
    for (const [asking, change] of changes) {
      await expect(fixtures.grantAsPage({ store: 'dapp', change }, asking)).rejects.toMatchObject({
        code: 'forbidden',
        message: expect.stringMatching(/only from the core's own prompt/),
      });
    }
    expect(await coreRecords()).toEqual(recordsBefore);
    expect(recordsBefore.map((record) => record.origin)).not.toContain(fourth);
    expect(permissions.getPermission(fourth)).toBeNull();
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  });

  test("an account deleted: the core revokes its grants (main's own), and the reference sees none", async () => {
    const revoked = await permissions.revokePermissionsForWalletIndex(0);
    expect(revoked).toEqual([SITE]);
    expect(calls.find((call) => call.method === 'approval.forget_account')).toMatchObject({
      context: { caller: 'shell' },
      params: { wallet_index: 0 },
    });
    expect(permissions.getPermission(SITE)).toBeNull();
    expect(readReference().getPermission(SITE)).toBeNull();
    expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
  });
});
