/**
 * Gated live run of Colibri's chain reads on both backends (freedom-core
 * design 0014, COL-5): with the development switch on
 * (FREEDOM_COLIBRI_BACKEND=service), chain data's reads go through
 * chain-verified's executor (`shell.verified`, its `{ colibri: "request" }`
 * operation) and colibri-resolver to freedom-colibrid, which asks the real
 * default prover, beacon and checkpoint hosts for every chain the provers
 * cover (mainnet and Gnosis). Each read runs again with the switch off, on
 * the WASM verifier, and the two answers are compared wherever they can't
 * move between the reads: a block by number and by hash, its transaction
 * and receipt. A read at `latest` can: the block number is compared within a
 * margin, the balance once two reads agree.
 *
 * Gated by COLIBRI_SERVICE_E2E=1: it needs the network, so no pull-request
 * job runs it; .github/workflows/colibri-live.yml runs it on Linux, macOS and
 * Windows on a push to a `colibri-live/<name>` branch. It needs
 * freedom-colibrid where colibrid-binary.js finds it in a
 * development build (`npm run colibrid:download`, or FREEDOM_COLIBRID_PATH):
 *
 *   npm run colibrid:download
 *   COLIBRI_SERVICE_E2E=1 npx jest src/main/__tests__/integration/colibri-service-e2e.test.js
 *
 * Electron's paths are a fresh temporary directory, so the stores and the
 * locks stay out of the developer's profile; nothing else is stubbed but
 * the transport, which is Node's `fetch` here, with no Electron session.
 */

const E2E_ENABLED = process.env.COLIBRI_SERVICE_E2E === '1';
const describeOrSkip = E2E_ENABLED ? describe : describe.skip;

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
const workerHost = require('../../ens/colibri-worker-host');

const TIMEOUT_MS = 120_000;
const DEADLINE_MS = 60_000;
/** The search for a settled block with a transaction: at most this many
 * blocks, within this budget, each read within what is left of it. */
const SEARCH_BLOCKS = 8;
const SEARCH_MS = 120_000;
/** The block at latest on both backends, then the search. */
const SEARCH_TIMEOUT_MS = 2 * DEADLINE_MS + SEARCH_MS + 10_000;
/** An account whose balance rarely moves (the ecrecover precompile). */
const ACCOUNT = '0x0000000000000000000000000000000000000001';
const CHAINS = [
  // Blocks per minute, for the margin between two reads at latest.
  { chainId: 1, name: 'mainnet', perMinute: 5 },
  { chainId: 100, name: 'Gnosis', perMinute: 12 },
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

const read = chainVerified();

/** One read on `backend` (the development switch), its result. */
async function readOn(backend, chainId, method, params, deadlineMs) {
  process.env.FREEDOM_COLIBRI_BACKEND = backend;
  const { reply, error } = await read(chainId, method, params, deadlineMs);
  expect({ backend, method, reply, error }).toEqual({
    backend,
    method,
    reply: { result: expect.anything() },
    error: null,
  });
  return reply.result;
}

/** The same read on the service, then on WASM: `{ service, wasm }`. */
async function both(chainId, method, params) {
  const service = await readOn('service', chainId, method, params);
  const wasm = await readOn('wasm', chainId, method, params);
  return { service, wasm };
}

const hexNumber = (value) => {
  expect(value).toMatch(/^0x(0|[1-9a-f][0-9a-f]*)$/);
  return Number(BigInt(value));
};

const savedBackend = process.env.FREEDOM_COLIBRI_BACKEND;

// Jest runs a root teardown even when every test is skipped: registered
// only for a gated run, it removes only the directory that run made.
if (E2E_ENABLED) {
  afterAll(async () => {
    clearColibriClientForTest();
    await stopColibri();
    workerHost.resetForTest();
    if (savedBackend === undefined) delete process.env.FREEDOM_COLIBRI_BACKEND;
    else process.env.FREEDOM_COLIBRI_BACKEND = savedBackend;
    fs.rmSync(mockAppDir, { recursive: true, force: true });
  }, TIMEOUT_MS);
}

describeOrSkip.each(CHAINS)(
  "Colibri's chain reads on both backends: $name",
  ({ chainId, perMinute }) => {
    // A settled block with a transaction, found from the service's latest.
    let block = null;

    test(
      'eth_blockNumber: within the blocks made between the two reads',
      async () => {
        const startedAt = Date.now();
        const { service, wasm } = await both(chainId, 'eth_blockNumber', []);
        const minutes = (Date.now() - startedAt) / 60_000;
        expect(Math.abs(hexNumber(service) - hexNumber(wasm))).toBeLessThanOrEqual(
          Math.ceil((minutes + 1) * perMinute)
        );
        // Each backend answered from its own store (deviation storage-per-chain):
        // the service's chain directory, the WASM verifier's flat files.
        const store = path.join(mockAppDir, 'userData', 'colibri');
        expect(fs.statSync(path.join(store, String(chainId))).isDirectory()).toBe(true);
        expect(fs.existsSync(path.join(store, `states_${chainId}`))).toBe(true);
      },
      TIMEOUT_MS
    );

    test(
      'eth_getBlockByNumber at latest: a block on each',
      async () => {
        const { service, wasm } = await both(chainId, 'eth_getBlockByNumber', ['latest', false]);
        for (const latest of [service, wasm]) {
          expect(latest).toMatchObject({
            number: expect.stringMatching(/^0x/),
            hash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
            transactions: expect.any(Array),
          });
        }
        // A few blocks back, so neither read finds it reorganised, with a
        // transaction to read: searched on the service, at most
        // SEARCH_BLOCKS blocks within SEARCH_MS, then verified on both.
        const newest = hexNumber(service.number) - 3;
        const searchEnds = Date.now() + SEARCH_MS;
        const searched = [];
        for (let number = newest; !block && number > newest - SEARCH_BLOCKS; number -= 1) {
          const left = Math.floor(searchEnds - Date.now());
          if (left <= 0) break;
          const candidate = await readOn(
            'service',
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
      'eth_getBlockByNumber at a number and at a hash: the same block',
      async () => {
        const byNumber = await both(chainId, 'eth_getBlockByNumber', [block.number, false]);
        expect(byNumber.service).toEqual(block);
        expect(byNumber.wasm).toEqual(block);
        const byHash = await both(chainId, 'eth_getBlockByNumber', [block.hash, false]);
        expect(byHash.service).toEqual(block);
        expect(byHash.wasm).toEqual(block);
      },
      TIMEOUT_MS
    );

    test(
      'eth_getBlockByHash: the same block',
      async () => {
        const { service, wasm } = await both(chainId, 'eth_getBlockByHash', [block.hash, false]);
        expect(service).toEqual(block);
        expect(wasm).toEqual(block);
      },
      TIMEOUT_MS
    );

    test(
      'a transaction of the block, and its receipt: the same on both',
      async () => {
        const [hash] = block.transactions;
        const tx = await both(chainId, 'eth_getTransactionByHash', [hash]);
        expect(tx.service).toMatchObject({
          hash,
          blockHash: block.hash,
          blockNumber: block.number,
        });
        expect(tx.wasm).toEqual(tx.service);
        const receipt = await both(chainId, 'eth_getTransactionReceipt', [hash]);
        expect(receipt.service).toMatchObject({
          transactionHash: hash,
          blockHash: block.hash,
          blockNumber: block.number,
        });
        expect(receipt.wasm).toEqual(receipt.service);
      },
      TIMEOUT_MS
    );

    test(
      'eth_getBalance at latest: the same once two reads agree',
      async () => {
        // The balance may move between the reads: read again, at most twice.
        let last = null;
        for (let round = 0; round < 3; round += 1) {
          last = await both(chainId, 'eth_getBalance', [ACCOUNT, 'latest']);
          hexNumber(last.service);
          if (last.service === last.wasm) break;
        }
        expect(last.wasm).toBe(last.service);
      },
      TIMEOUT_MS
    );
  }
);
