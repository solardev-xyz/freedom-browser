/**
 * Gated live run of Colibri's chain reads (freedom-core design 0014): chain
 * data's reads go through chain-verified's executor (`shell.verified`, its
 * `{ colibri: "request" }` operation) and colibri-resolver to
 * freedom-colibrid, which asks the real default prover, beacon and
 * checkpoint hosts for every chain the provers cover (mainnet and Gnosis).
 *
 * What it expects, where it can't move: the recorded reference
 * (freedom-core's `vectors/colibri.json`, COL-1's recording of the WASM
 * verifier) gives each chain a block, one of its transactions and its
 * receipt, which a live read must give again: the block by number and by
 * hash byte for byte, the transaction and the receipt field for field
 * (today's prover adds a null `contractAddress` to a receipt); and its
 * latest block at capture, which today's must not be behind,
 * nor ahead by more than a block per slot since. Without the vectors those
 * parts are skipped, and fail when FREEDOM_CORE_COLIBRI_VECTORS names them.
 * Everything else is held to itself: a settled block read by number and by
 * hash, its transaction and receipt naming it, a balance read twice.
 *
 * Gated by COLIBRI_SERVICE_E2E=1: it needs the network, so no pull-request
 * job runs it; .github/workflows/colibri-live.yml runs it on Linux, macOS and
 * Windows on a push to a `colibri-live/<name>` branch. It needs
 * freedom-colibrid where colibrid-binary.js finds it in a
 * development build (`npm run colibrid:download`, or FREEDOM_COLIBRID_PATH):
 *
 *   npm run colibrid:download
 *   COLIBRI_SERVICE_E2E=1 FREEDOM_CORE_COLIBRI_VECTORS=../freedom-core/vectors/colibri.json \
 *     npx jest src/main/__tests__/integration/colibri-service-e2e.test.js
 *
 * Electron's paths are a fresh temporary directory, so the stores and the
 * locks stay out of the developer's profile; nothing else is stubbed but
 * the transport, which is Node's `fetch` here, with no Electron session.
 */

const E2E_ENABLED = process.env.COLIBRI_SERVICE_E2E === '1';
const describeOrSkip = E2E_ENABLED ? describe : describe.skip;

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Made only for a gated run, and the only directory its teardown removes.
const mockAppDir = E2E_ENABLED
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'colibri-service-e2e-'))
  : null;

jest.mock('electron', () => {
  const nodePath = require('node:path');
  return {
    app: {
      isPackaged: false,
      getPath: (name) => {
        if (!mockAppDir) throw new Error('the live run is off (COLIBRI_SERVICE_E2E)');
        return nodePath.join(mockAppDir, name);
      },
      getVersion: () => 'colibri-service-e2e',
    },
    ipcMain: { handle: jest.fn() },
  };
});
// No Electron session here: main's Colibri fetches go through Node's fetch.
jest.mock('../../ipfs/gateway-transport', () => ({
  ...jest.requireActual('../../ipfs/gateway-transport'),
  netGatewayFetch: (url, init) => globalThis.fetch(url, init),
}));

const { registerChainVerified } = require('../../core/chain-verified');
const {
  clearColibriClientForTest,
  requestViaColibri,
  stopColibri,
} = require('../../ens/colibri-resolver');
const {
  colibriVectors,
  colibriVectorsRequired,
} = require('../../../../test/helpers/colibri-vectors');

const TIMEOUT_MS = 120_000;
const DEADLINE_MS = 60_000;
/** The search for a settled block with a transaction: at most this many
 * blocks, within this budget, each read within what is left of it. */
const SEARCH_BLOCKS = 8;
const SEARCH_MS = 120_000;
/** The block at latest, then the search. */
const SEARCH_TIMEOUT_MS = DEADLINE_MS + SEARCH_MS + 10_000;
/** An account whose balance rarely moves (the ecrecover precompile). */
const ACCOUNT = '0x0000000000000000000000000000000000000001';
const CHAINS = [
  { chainId: 1, name: 'mainnet', slotMs: 12_000 },
  { chainId: 100, name: 'Gnosis', slotMs: 5_000 },
];

/**
 * chain-verified's executor, as the core calls it, on its own Colibri
 * adapter (colibri-resolver's `requestViaColibri`): `read(chainId, method,
 * params, deadlineMs)` resolves to its reply (`{ result }`, `{ failure }`,
 * …) and the adapter's error, which the reply carries only as a class.
 */
function chainVerified() {
  const routes = [];
  const client = {
    hello: { capabilities: ['fragments', 'colibri_faults'] },
    handle: (method, fn, options) => routes.push({ method, fn, options }),
  };
  let error = null;
  const colibriRequest = (...args) =>
    requestViaColibri(...args).catch((err) => {
      error = err;
      throw err;
    });
  registerChainVerified(client, { generation: () => 1 }, { adapters: { colibriRequest } });
  const route = routes.find((entry) => entry.method === 'shell.verified');
  return async (chainId, method, params, deadlineMs = DEADLINE_MS) => {
    const operation = {
      chain_id: chainId,
      generation: 1,
      colibri: 'request',
      method,
      params,
      deadline_ms: deadlineMs,
    };
    expect(route.options.when(operation)).toBe(true);
    error = null;
    // A normal window's read: the executor takes any other as private.
    const reply = await route.fn(operation, {
      signal: new AbortController().signal,
      charge: () => true,
      private: false,
    });
    return { reply, error: error && `${error.name}: ${error.message}` };
  };
}

const verified = chainVerified();

/** One read, its result. */
async function read(chainId, method, params, deadlineMs) {
  const { reply, error } = await verified(chainId, method, params, deadlineMs);
  expect({ method, reply, error }).toEqual({
    method,
    reply: { result: expect.anything() },
    error: null,
  });
  return reply.result;
}

const hexNumber = (value) => {
  expect(value).toMatch(/^0x(0|[1-9a-f][0-9a-f]*)$/);
  return Number(BigInt(value));
};

/**
 * `value` against a recorded outcome: a result recorded by its JSON text's
 * length and SHA-256 (`result_json`, a block) is that text exactly; one
 * recorded inline (a transaction, a receipt) has every recorded field, and
 * any other only as null. Today's prover gives a receipt a
 * `contractAddress: null` the recording's answers didn't carry.
 */
function expectRecorded(value, recorded) {
  if (recorded.result_json) {
    const text = JSON.stringify(value);
    expect({
      chars: text.length,
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
    }).toEqual(recorded.result_json);
    return;
  }
  const { result } = recorded;
  if (result === null || typeof result !== 'object') {
    expect(value).toEqual(result);
    return;
  }
  expect(value).toMatchObject(result);
  const added = Object.keys(value).filter((key) => !Object.hasOwn(result, key));
  expect(Object.fromEntries(added.map((key) => [key, value[key]]))).toEqual(
    Object.fromEntries(added.map((key) => [key, null]))
  );
}

/** The recording's case `id`: its one request and its recorded outcome. */
function recordedCase(id) {
  const entry = colibriVectors.cases.find((item) => item.id === id);
  if (!entry) throw new Error(`the Colibri vectors have no case ${id}`);
  const [request] = entry.requests;
  const [outcome] = entry.outcomes;
  expect(outcome.ok).toBe(true);
  return { request, outcome };
}

const recordedTest = colibriVectors ? test : test.skip;

// Named outright, the vectors must be there, so their parts can't skip.
(E2E_ENABLED && colibriVectorsRequired ? test : test.skip)(
  'the vectors FREEDOM_CORE_COLIBRI_VECTORS names are there',
  () => {
    expect(colibriVectors).not.toBeNull();
  }
);

// Jest runs a root teardown even when every test is skipped: registered
// only for a gated run, it removes only the directory that run made.
if (E2E_ENABLED) {
  afterAll(async () => {
    clearColibriClientForTest();
    await stopColibri();
    fs.rmSync(mockAppDir, { recursive: true, force: true });
  }, TIMEOUT_MS);
}

describeOrSkip.each(CHAINS)("Colibri's chain reads: $name", ({ chainId, slotMs }) => {
  // A settled block with a transaction, found from latest.
  let block = null;

  test(
    'eth_blockNumber: a number, from the chain\'s own store',
    async () => {
      hexNumber(await read(chainId, 'eth_blockNumber', []));
      // The chain's directory (deviation storage-per-chain), and nothing
      // else under <userData>/colibri.
      const store = path.join(mockAppDir, 'userData', 'colibri');
      expect(fs.statSync(path.join(store, String(chainId))).isDirectory()).toBe(true);
      expect(fs.readdirSync(store).every((name) => /^[1-9][0-9]*$/.test(name))).toBe(true);
    },
    TIMEOUT_MS
  );

  recordedTest(
    "eth_blockNumber: not behind the recording's latest, nor ahead by more than a block per slot since",
    async () => {
      const { request, outcome } = recordedCase(`${chainId}-zk-cold`);
      const recorded = hexNumber(outcome.result);
      const latest = hexNumber(await read(chainId, 'eth_blockNumber', []));
      const slots = Math.ceil((Date.now() - request.clock) / slotMs);
      expect(latest).toBeGreaterThanOrEqual(recorded);
      expect(latest - recorded).toBeLessThanOrEqual(slots + 1);
    },
    TIMEOUT_MS
  );

  test(
    'eth_getBlockByNumber at latest: a block, then a settled one with a transaction',
    async () => {
      const latest = await read(chainId, 'eth_getBlockByNumber', ['latest', false]);
      expect(latest).toMatchObject({
        number: expect.stringMatching(/^0x/),
        hash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        transactions: expect.any(Array),
      });
      // A few blocks back, so no read finds it reorganised, with a
      // transaction to read: at most SEARCH_BLOCKS blocks within SEARCH_MS.
      const newest = hexNumber(latest.number) - 3;
      const searchEnds = Date.now() + SEARCH_MS;
      const searched = [];
      for (let number = newest; !block && number > newest - SEARCH_BLOCKS; number -= 1) {
        const left = Math.floor(searchEnds - Date.now());
        if (left <= 0) break;
        const candidate = await read(
          chainId,
          'eth_getBlockByNumber',
          [`0x${number.toString(16)}`, false],
          Math.min(DEADLINE_MS, left)
        );
        searched.push(number);
        if (candidate.transactions.length > 0) block = candidate;
      }
      expect({ searched, found: block !== null }).toEqual({ searched, found: true });
    },
    SEARCH_TIMEOUT_MS
  );

  test(
    'the settled block by hash, both ways: the same block',
    async () => {
      expect(await read(chainId, 'eth_getBlockByNumber', [block.hash, false])).toEqual(block);
      expect(await read(chainId, 'eth_getBlockByHash', [block.hash, false])).toEqual(block);
    },
    TIMEOUT_MS
  );

  test(
    'a transaction of the settled block, and its receipt: both name the block',
    async () => {
      const [hash] = block.transactions;
      expect(await read(chainId, 'eth_getTransactionByHash', [hash])).toMatchObject({
        hash,
        blockHash: block.hash,
        blockNumber: block.number,
      });
      expect(await read(chainId, 'eth_getTransactionReceipt', [hash])).toMatchObject({
        transactionHash: hash,
        blockHash: block.hash,
        blockNumber: block.number,
      });
    },
    TIMEOUT_MS
  );

  recordedTest.each([
    ['the block by number', 'block-number'],
    ['the block by hash', 'block-hash'],
    ['eth_getBlockByHash', 'block-by-hash'],
    ['its transaction', 'tx'],
    ['its receipt', 'receipt'],
  ])(
    "the recording's block, %s: the recorded answer",
    async (_label, name) => {
      const { request, outcome } = recordedCase(`${chainId}-${name}`);
      expectRecorded(await read(chainId, request.method, request.params), outcome);
    },
    TIMEOUT_MS
  );

  test(
    'eth_getBalance at latest: the same once two reads agree',
    async () => {
      // The balance may move between the reads: read again, at most twice.
      const reads = [hexNumber(await read(chainId, 'eth_getBalance', [ACCOUNT, 'latest']))];
      for (let round = 0; round < 2 && reads.at(-1) !== reads.at(-2); round += 1) {
        reads.push(hexNumber(await read(chainId, 'eth_getBalance', [ACCOUNT, 'latest'])));
      }
      expect(reads.at(-1)).toBe(reads.at(-2));
    },
    TIMEOUT_MS
  );
});
