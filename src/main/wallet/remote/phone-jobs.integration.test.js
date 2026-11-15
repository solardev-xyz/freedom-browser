/**
 * Phone jobs through the real freedom-cored (freedom-core design 0012,
 * PHN-2; cored 0.18.0): main's bridge (./bridge.js) and the phone's signer
 * backend (./signer.js) against the binary, with a fake chrome in place of
 * the openlv session and a local JSON-RPC node in place of the network.
 * bridge.test.js's and signer.test.js's cases, where the core now decides:
 * the job is the core's (`phone.job`), relayed under its id; an answer or a
 * "sent" mark from a webContents the job wasn't sent to is refused by the
 * core as well as ignored by the bridge, and the job stays open for its own
 * chrome; a signature must recover to the account; the phone's refusals map
 * as before; a payment's reported transaction is compared with the one
 * confirmed, `verified` at the answer, refused when it is another one, or
 * `unverified` until the core's `phone.checked`, which main's history then
 * shows as checked, or as another transaction, never as the confirmed one.
 * Skipped unless FREEDOM_CORED_PATH points at a build, or
 * FREEDOM_CORED_APPROVALS_TEST=1 asks for the binary `npm run core:download`
 * fetched (CI's e2e-desktop job).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Wallet, TypedDataEncoder } = require('ethers');

const required = process.env.FREEDOM_CORED_APPROVALS_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH || (required ? require('../../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_APPROVALS_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
jest.setTimeout(30_000);

const quietLog = { info() {}, warn() {}, error() {} };
const PHONE = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const INDEX = 1000001;
const CHROME = 7;
const WEBVIEW = 8;
const TO = '0x1111111111111111111111111111111111111111';
const CHAIN = 100;
const hashOf = (n) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
const TYPED = {
  domain: { name: 'Mail', version: '1', chainId: CHAIN },
  types: { Mail: [{ name: 'contents', type: 'string' }] },
  message: { contents: 'hello' },
};

/** A local JSON-RPC node: `eth_getTransactionByHash` answers from `txs`, null for any other hash. */
async function node() {
  const txs = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      const result = method === 'eth_getTransactionByHash' ? (txs.get(params[0]) ?? null) : '0x10';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    txs,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The payment as the chain shows it. */
const seen = ({ from = PHONE.address, to = TO, value = '0x5', input = '0xabcd', chainId = '0x64' } = {}) => ({
  from,
  to,
  value,
  input,
  chainId,
  nonce: '0x3',
  gas: '0x5208',
});

describeIfBinary('phone jobs with the real freedom-cored (PHN-2)', () => {
  let root;
  let core;
  let rpc;
  let calls;
  let events;
  let handlers;
  let relayed;
  let bridge;
  let backend;
  let vaultBackend;
  let history;
  let checks;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-jobs-'));
    rpc = await node();
    const { CoreClient } = require('../../core/core-client');
    core = new CoreClient({
      // The first recheck of an unverified payment soon after its answer.
      spawn: (command, args, options = {}) =>
        spawn(command, args, { ...options, env: { ...process.env, ...options.env, FREEDOM_CORED_TEST_PHONE_RECHECK_MS: '100' } }),
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks'), '--parent-pid', String(process.pid)],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    calls = [];
    const request = core.request.bind(core);
    core.request = (method, params, context, options) => {
      const reply = request(method, params, context, options);
      calls.push({ method, params, context, reply: reply.catch((err) => err) });
      return reply;
    };
    events = [];
    core.on('event', (name, data) => events.push({ name, data }));
    // The core's chain reads go to the local node, as main's executors serve them.
    const { registerChainShell } = require('../../core/chain-shell');
    const { makeHop } = require('../../core/naming-shell');
    const chain = { generation: 0 };
    registerChainShell(
      core,
      { endpoint: (ref) => (ref === 'e1' ? { url: rpc.url, chainId: CHAIN } : null), generation: () => chain.generation },
      { hop: makeHop({ fetch }) }
    );

    jest.resetModules();
    handlers = {};
    relayed = [];
    const chrome = {
      id: CHROME,
      isDestroyed: () => false,
      send: (channel, payload) => relayed.push({ channel, payload }),
    };
    jest.doMock('../../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('electron', () => ({
      ipcMain: {
        on: (channel, fn) => (handlers[channel] = fn),
        handle: (channel, fn) => (handlers[channel] = fn),
      },
      BrowserWindow: {
        getFocusedWindow: () => ({ isDestroyed: () => false, webContents: chrome }),
        getAllWindows: () => [],
      },
    }));
    jest.doMock('../../approvals/approvals-document', () => ({ isApprovalsDocumentEnabled: () => false }));
    jest.doMock('../../windows/request-window', () => ({ requestWindowId: () => null }));
    jest.doMock('../rpc-manager', () => ({ getKeylessRpcUrls: () => [] }));
    jest.doMock('../chains', () => ({ getChain: () => ({ name: 'Gnosis', nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 } }) }));
    jest.doMock('../../logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
    // Main's payment history, in memory: what the wallet shows of each payment.
    history = new Map();
    jest.doMock('../../payment-history', () => {
      const { STATUSES } = jest.requireActual('../../payment-history');
      return {
        STATUSES,
        KINDS: {},
        getById: (id) => history.get(id) ?? null,
        getRecent: ({ status }) => [...history.values()].filter((row) => row.status === status),
        update: (id, patch) => history.set(id, { ...history.get(id), ...patch }).get(id),
        markConfirmed: () => {},
        markFailed: () => {},
      };
    });
    jest.doMock('../transaction-service', () => ({ waitForTransaction: () => new Promise(() => {}) }));
    jest.doMock('../intent-store', () => ({ getIntentStore: () => ({}) }));

    await core.start();
    const { generations } = await core.request(
      'chain.configure',
      {
        chains: [
          {
            chain_id: CHAIN,
            display_name: 'Gnosis',
            read_order: ['direct'],
            broadcast_order: ['direct'],
            quorum: { k: 1, m: 1, timeout_ms: 5000 },
            rpc: [{ endpoint: 'e1', user_configured: true }],
            prover: null,
            myotis: false,
            blockscout: null,
          },
        ],
      },
      { caller: 'chrome' },
      { watchdogMs: 30_000 }
    );
    chain.generation = generations[String(CHAIN)];

    bridge = require('./bridge');
    bridge.registerRemoteSignerIpc();
    ({ vaultBackend } = require('../../core/vault-backend'));
    checks = [];
    backend = require('./signer').createRemoteBackend(
      { index: INDEX, address: PHONE.address },
      { onAddressCheck: (matched) => checks.push(matched) }
    );
    require('../tx-recorder').attachPhoneEvents(core);
  });

  afterAll(async () => {
    await core?.stop();
    await rpc?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
    relayed.length = 0;
    checks.length = 0;
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  // The job the bridge relayed last, once it has.
  async function relayedJob() {
    for (let i = 0; i < 200 && !relayed.some((r) => r.channel === 'remote-signer:request'); i += 1) await tick();
    return relayed.filter((r) => r.channel === 'remote-signer:request').at(-1).payload;
  }
  const from = (id) => ({ sender: { id } });
  const markSent = (jobId, id = CHROME) => handlers['remote-signer:request-sent'](from(id), { jobId });
  const respond = (jobId, answer, id = CHROME) => handlers['remote-signer:response'](from(id), { jobId, ...answer });
  const coreCalls = (method) => calls.filter((call) => call.method === method);
  async function until(check) {
    for (let i = 0; i < 300; i += 1) {
      if (check()) return;
      await tick();
    }
    throw new Error('timed out');
  }
  const reasonOf = (promise) => promise.then(() => null, (err) => err?.data?.reason ?? err?.code);

  describe('a signature', () => {
    test("the core's job, relayed under its id to the chrome it names; the account's signature returned and checked", async () => {
      const signing = backend.signMessage(Buffer.from('hello'));
      const job = await relayedJob();
      expect(coreCalls('phone.job')).toEqual([
        expect.objectContaining({
          context: { caller: 'shell' },
          params: { account: INDEX, address: PHONE.address, method: 'message', payload: { message: '0x68656c6c6f' }, target: CHROME },
        }),
      ]);
      expect(job).toMatchObject({ jobId: expect.stringMatching(/^[0-9a-f]{32}$/), method: 'personal_sign', params: ['0x68656c6c6f', PHONE.address] });
      expect(await markSent(job.jobId)).toEqual({ allowed: true });
      respond(job.jobId, { result: await PHONE.signMessage('hello') });
      expect(await signing).toBe(await PHONE.signMessage('hello'));
      expect(coreCalls('phone.result')[0]).toMatchObject({ context: { caller: 'chrome' }, params: { job: job.jobId, sender: CHROME } });
      expect(checks).toEqual([true]);
    });

    test('an answer or a sent mark from another webContents: ignored by the bridge, refused by the core, and the job still open for its own chrome', async () => {
      const signing = backend.signMessage(Buffer.from('hello'));
      const job = await relayedJob();
      const signature = await PHONE.signMessage('hello');
      // The bridge never passes them on.
      expect(await markSent(job.jobId, WEBVIEW)).toEqual({ allowed: false });
      respond(job.jobId, { result: signature }, WEBVIEW);
      await tick();
      expect(coreCalls('phone.sent')).toEqual([]);
      expect(coreCalls('phone.result')).toEqual([]);
      // Nor does the core take them, if they reached it.
      expect(await reasonOf(vaultBackend.phone.sent({ job: job.jobId, sender: WEBVIEW }))).toBe('wrong_sender');
      expect(await reasonOf(vaultBackend.phone.result({ job: job.jobId, sender: WEBVIEW, result: signature }))).toBe('wrong_sender');
      // Its own chrome's answer still settles it, once.
      respond(job.jobId, { result: signature });
      expect(await signing).toBe(signature);
      expect(await reasonOf(vaultBackend.phone.result({ job: job.jobId, sender: CHROME, result: signature }))).toBe('settled');
    });

    test('a signature from another account: REMOTE_WRONG_ACCOUNT, reported on the record; a malformed one: REMOTE_BAD_RESPONSE', async () => {
      const wrong = backend.signMessage(Buffer.from('hello'));
      respond((await relayedJob()).jobId, { result: await OTHER.signMessage('hello') });
      await expect(wrong).rejects.toMatchObject({ code: 'REMOTE_WRONG_ACCOUNT' });
      expect(checks).toEqual([false]);
      relayed.length = 0;
      const bad = backend.signMessage(Buffer.from('hello'));
      respond((await relayedJob()).jobId, { result: '0x1234' });
      await expect(bad).rejects.toMatchObject({ code: 'REMOTE_BAD_RESPONSE' });
    });

    test("typed data: the core's view goes to the phone, and only a signature over the confirmed hash returns", async () => {
      const digest = TypedDataEncoder.hash(TYPED.domain, TYPED.types, TYPED.message);
      const coreTyped = require('../signing-utils').toCoreTypedData(TYPED);
      const signing = backend.signTypedData(TYPED, { digest, job: { payload: { typed_data: coreTyped } } });
      const job = await relayedJob();
      expect(job.method).toBe('eth_signTypedData_v4');
      const view = JSON.parse(job.params[1]);
      expect(TypedDataEncoder.hash(view.domain, { Mail: view.types.Mail }, view.message)).toBe(digest);
      respond(job.jobId, { result: PHONE.signingKey.sign(digest).serialized });
      expect(await signing).toBe(PHONE.signingKey.sign(digest).serialized);
      // Data that doesn't hash to the confirmed hash opens no job.
      await expect(
        backend.signTypedData(TYPED, { digest: hashOf(1), job: { payload: { typed_data: coreTyped } } })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    });

    test("the phone's refusals map as before: 4001 rejected, 4100 another account; a renderer's own code passes", async () => {
      for (const [error, code] of [
        [{ rpcCode: 4001, message: 'User rejected' }, 'REMOTE_USER_REJECTED'],
        [{ rpcCode: 4100, message: 'Unauthorized' }, 'REMOTE_WRONG_ACCOUNT'],
        [{ code: 'REMOTE_USER_CANCELLED' }, 'REMOTE_USER_CANCELLED'],
      ]) {
        relayed.length = 0;
        const signing = backend.signMessage(Buffer.from('hello'));
        respond((await relayedJob()).jobId, { error });
        await expect(signing).rejects.toMatchObject({ code });
      }
    });

    test("the caller's last check refusing after the job opened: nothing relayed, the job ended in the core, the caller's error", async () => {
      const refused = new Error('the site no longer holds the request');
      await expect(
        backend.signMessage(Buffer.from('hello'), { beforeSign: async () => Promise.reject(refused) })
      ).rejects.toBe(refused);
      expect(relayed).toEqual([]);
      const [opened] = coreCalls('phone.job');
      const { job } = await opened.reply;
      expect(await reasonOf(vaultBackend.phone.result({ job, sender: CHROME, result: '0x' }))).toBe('settled');
    }, 30_000);
  });

  describe('a payment', () => {
    const TX = { type: 2, chain_id: '100', gas_limit: '60000', to: TO, value: '5', data: '0xabcd', max_fee_per_gas: '2', max_priority_fee_per_gas: '1' };
    const pay = () => backend.sendTransaction({ chainId: CHAIN }, { payload: { tx: TX } });

    test('visible at the answer and the one confirmed: verified', async () => {
      rpc.txs.set(hashOf(0x11), seen());
      const paying = pay();
      const job = await relayedJob();
      expect(job).toMatchObject({ method: 'eth_sendTransaction', chain: { chainId: '0x64' } });
      expect(job.params[0]).toMatchObject({ from: PHONE.address, to: TO, value: '0x5', data: '0xabcd', chainId: '0x64' });
      await markSent(job.jobId);
      respond(job.jobId, { result: hashOf(0x11) });
      expect(await paying).toEqual({ hash: hashOf(0x11), outcome: 'verified', job: job.jobId });
    });

    test('visible and another transaction (recipient, amount, data, chain, sender): refused, never the confirmed one, and not provably unsent', async () => {
      const { isRemoteSendProvablyUnsent } = require('./errors');
      const cases = [
        [seen({ to: '0x2222222222222222222222222222222222222222' }), 'REMOTE_WRONG_TRANSACTION'],
        [seen({ value: '0x6' }), 'REMOTE_WRONG_TRANSACTION'],
        [seen({ input: '0xabce' }), 'REMOTE_WRONG_TRANSACTION'],
        [seen({ chainId: '0x1' }), 'REMOTE_WRONG_TRANSACTION'],
        [seen({ from: OTHER.address }), 'REMOTE_WRONG_ACCOUNT'],
      ];
      for (const [i, [tx, code]] of cases.entries()) {
        relayed.length = 0;
        rpc.txs.set(hashOf(0x20 + i), tx);
        const paying = pay();
        const job = await relayedJob();
        await markSent(job.jobId);
        respond(job.jobId, { result: hashOf(0x20 + i) });
        const err = await paying.catch((e) => e);
        expect(err).toMatchObject({ code, phoneSent: true });
        expect(isRemoteSendProvablyUnsent(err)).toBe(false);
      }
    });

    test("not visible at the answer: unverified, then the core's phone.checked shows it checked, or another transaction, never the confirmed one", async () => {
      const { STATUSES } = jest.requireActual('../../payment-history');
      const outcomes = [];
      for (const [i, later] of [seen(), seen({ value: '0x9' })].entries()) {
        relayed.length = 0;
        const hash = hashOf(0x30 + i);
        const paying = pay();
        const job = await relayedJob();
        await markSent(job.jobId);
        respond(job.jobId, { result: hash });
        const sent = await paying;
        expect(sent).toEqual({ hash, outcome: 'unverified', job: job.jobId });
        // The row main writes for it (tx-recorder's recordSend): not yet checked.
        history.set(i + 1, { id: i + 1, txHash: hash, chainId: CHAIN, status: STATUSES.UNVERIFIED, metadata: { phoneCheck: { state: 'unverified', job: job.jobId, answeredAt: Date.now() } } });
        // The record is in the core's file, by its digest, never its data.
        const file = JSON.parse(fs.readFileSync(path.join(root, 'phone-payments.json'), 'utf8'));
        expect(file.payments.find((record) => record.job === job.jobId)).toMatchObject({ hash, data_length: 2 });
        rpc.txs.set(hash, later);
        await until(() => events.some((e) => e.name === 'phone.checked' && e.data.job === job.jobId));
        outcomes.push(events.find((e) => e.name === 'phone.checked' && e.data.job === job.jobId).data);
      }
      expect(outcomes[0]).toMatchObject({ outcome: 'verified' });
      expect(outcomes[1]).toMatchObject({ outcome: 'mismatch', transaction: expect.any(Object) });
      // The wallet: the first checked and on to its receipt, the second
      // another transaction, with what the phone sent.
      expect(history.get(1)).toMatchObject({ status: STATUSES.PENDING, metadata: { phoneCheck: { state: 'verified' } } });
      expect(history.get(2)).toMatchObject({
        status: STATUSES.WRONG_TRANSACTION,
        metadata: { phoneCheck: { state: 'mismatch', observed: outcomes[1].transaction } },
      });
    });

    test("a lost answer after the request went: unknown, and the core's own timeout says so too", async () => {
      const paying = pay();
      const job = await relayedJob();
      await markSent(job.jobId);
      respond(job.jobId, { error: { code: 'REMOTE_USER_CANCELLED' } });
      await expect(paying).rejects.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });
      relayed.length = 0;
      const answerless = pay();
      const second = await relayedJob();
      await markSent(second.jobId);
      respond(second.jobId, { result: 'not a hash' });
      await expect(answerless).rejects.toMatchObject({ code: 'REMOTE_OUTCOME_UNKNOWN' });
    });
  });
});
