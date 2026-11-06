/**
 * A keyed provider's resolved RPC URL carries the user's API key (#1040),
 * and ethers quotes the URL of a failed request in its error. No wallet
 * handler answers the renderer with either, whichever endpoint fails.
 *
 * - Through the handlers: the real registry, provider manager and Safe
 *   modules, with chain 100's pool on local endpoints that answer HTTP
 *   errors and quote the key in their body. Main's providers throw no URL
 *   (provider-manager.js); the handlers' redaction is the second line.
 * - The handlers' redaction alone: a service that throws ethers' own
 *   error, URL, key and all.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

// Loaded with the profile modules; each fresh load would add a set of
// process signal listeners. No lock is taken here.
jest.mock('proper-lockfile', () => ({
  lock: jest.fn(),
  unlock: jest.fn(),
  check: jest.fn(),
  lockSync: jest.fn(),
  unlockSync: jest.fn(),
  checkSync: jest.fn(),
}));
const {
  createIpcMainMock,
  createTempUserDataDir,
  removeTempUserDataDir,
  loadMainModule,
} = require('../../../test/helpers/main-process-test-utils');

const SHARED = path.join(__dirname, '..', '..', 'shared');
const readShared = (name) => JSON.parse(fs.readFileSync(path.join(SHARED, name), 'utf-8'));

// Built at runtime, so no key-shaped literal sits in the source.
const KEY = ['rpc', 'key', 'sentinel', process.pid.toString(36), 'x7q'].join('-');

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SAFE = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const RECORDS = {
  0: { index: 0, name: 'Main Wallet', address: OWNER, type: 'mnemonic' },
  5: {
    index: 5,
    name: 'Joint',
    address: SAFE,
    type: 'safe',
    owners: [0],
    threshold: 1,
    saltNonce: '7508',
    deployed: {},
  },
  6: {
    index: 6,
    name: 'Active',
    address: SAFE,
    type: 'safe',
    owners: [0],
    threshold: 1,
    saltNonce: '7508',
    deployed: { 100: true },
  },
};

const identityMock = () => ({
  getActiveWalletIndex: () => 0,
  getWalletRecord: (index) => RECORDS[index] ?? null,
  isHardwareWalletIndex: () => false,
  isVaultUnlocked: () => true,
  addSafeWallet: jest.fn(async (name, params) => ({ index: 9, name, type: 'safe', ...params })),
  markSafeDeployed: jest.fn(async () => {}),
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
});

/** An endpoint that answers `status` and quotes the key and its URL. */
function startEndpoint({ status, healthy = 0 }) {
  const hits = [];
  let answered = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const { id, method } = JSON.parse(body);
        hits.push(method);
        if (answered < healthy) {
          answered += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x10' }));
          return;
        }
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: `key ${KEY} refused at http://${req.headers.host}${req.url}` })
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, hits, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// Gnosis's builtin RPCs, removed so the pool is the test's alone.
const builtinGnosisRpcs = Object.entries(readShared('endpoint-sources.json'))
  .filter(([, src]) => src.role === 'rpc' && src.coverage?.['100'])
  .map(([id]) => id);

let userDataDir;
let endpoints;

/**
 * Chain 100's pool, in order: `keyed` the user's keyed provider (its URL
 * has the key in its path), otherwise a keyless one.
 */
async function writePool(shape) {
  endpoints = [];
  const endpointSources = {};
  for (const [index, entry] of shape.entries()) {
    const started = await startEndpoint(entry);
    const id = entry.keyed ? 'test-keyed' : `test-public-${index}`;
    const template = entry.keyed ? `${started.origin}/v2/{API_KEY}` : `${started.origin}/public`;
    endpointSources[id] = {
      role: 'rpc',
      keyed: entry.keyed,
      name: id,
      coverage: { 100: template },
    };
    endpoints.push({ ...started, url: template.replace('{API_KEY}', KEY) });
  }
  fs.writeFileSync(
    path.join(userDataDir, 'network-config.json'),
    JSON.stringify({ endpointSources, removedSources: builtinGnosisRpcs })
  );
  fs.writeFileSync(
    path.join(userDataDir, 'rpc-api-keys.json'),
    JSON.stringify({ 'test-keyed': { apiKey: KEY, enabled: true, addedAt: 1 } })
  );
}

function loadWalletIpc(extraMocks = {}) {
  const ipcMain = createIpcMainMock();
  const { mod } = loadMainModule(require.resolve('./wallet-ipc'), {
    ipcMain,
    userDataDir,
    extraMocks: {
      [require.resolve('../identity-manager')]: identityMock,
      ...extraMocks,
    },
  });
  mod.registerWalletIpc();
  return ipcMain;
}

function expectNoKey(answer) {
  const text = JSON.stringify(answer);
  expect(text).not.toContain(KEY);
  for (const { url } of endpoints) {
    expect(text).not.toContain(url);
    expect(text).not.toContain(new URL(url).pathname);
  }
}

beforeEach(() => {
  userDataDir = createTempUserDataDir('freedom-rpc-errors-');
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(
    (endpoints || []).map(({ server }) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    })
  );
  endpoints = [];
  jest.restoreAllMocks();
  removeTempUserDataDir(userDataDir);
});

const POOLS = [
  ['a single keyed endpoint', [{ keyed: true, status: 403 }]],
  [
    'a keyed endpoint that fails last',
    [
      { keyed: false, status: 500 },
      { keyed: true, status: 401 },
    ],
  ],
];

const SAFE_TX = { to: '0x' + '22'.repeat(20), value: '1', data: '0x' };

// Each renderer-facing handler whose service reads the chain through main's
// providers, with the arguments that reach that read.
const HANDLERS = [
  ['wallet:get-safe-status', (ipc) => ipc.invoke('wallet:get-safe-status', 5)],
  ['wallet:activate-safe', (ipc) => ipc.invoke('wallet:activate-safe', 5, {})],
  ['wallet:create-safe', (ipc) => ipc.invoke('wallet:create-safe', 'New', [0], 1)],
  [
    'wallet:safe-send',
    async (ipc) => {
      const minted = await ipc.invoke('wallet:confirm-signing', 'safe-send', 6, {
        tx: SAFE_TX,
        chainId: 100,
      });
      expect(minted).toMatchObject({ success: true });
      return ipc.invoke('wallet:safe-send', 6, SAFE_TX, {}, 100, { confirmation: minted.token });
    },
  ],
  [
    'wallet:safe-execute',
    (ipc) => {
      fs.writeFileSync(
        path.join(userDataDir, 'safe-pending.json'),
        JSON.stringify({
          6: {
            safeAddress: SAFE,
            chainId: 100,
            safeTxHash: '0x' + 'ab'.repeat(32),
            safeTxData: { nonce: '0' },
            signatures: [],
            threshold: 1,
            display: {},
            createdAt: 1,
          },
        })
      );
      return ipc.invoke('wallet:safe-execute', 6, {});
    },
  ],
];

describe.each(POOLS)('wallet handlers on %s', (_pool, shape) => {
  test.each(HANDLERS)('%s answers without the key or the URL', async (_channel, call) => {
    await writePool(shape);
    const ipc = loadWalletIpc();

    const answer = await call(ipc);

    expect(answer).toMatchObject({ success: false });
    expectNoKey(answer);
    // The failure is the endpoints': each was asked.
    for (const { hits } of endpoints) expect(hits.length).toBeGreaterThan(0);
    expect(String(answer.error)).toMatch(/No RPC endpoint for Gnosis Chain answered/);
  });

  test('wallet:test-provider answers without the key or the URL', async () => {
    await writePool(shape.map((entry) => ({ ...entry, healthy: 1 })));
    const ipc = loadWalletIpc();

    await expect(ipc.invoke('wallet:test-provider', 100)).resolves.toMatchObject({
      success: true,
    });
    // Past ethers' 250 ms cache of a block number: the next one is asked.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const answer = await ipc.invoke('wallet:test-provider', 100);

    expectNoKey(answer);
    expect(answer).toEqual({
      success: false,
      error: 'No RPC endpoint for Gnosis Chain answered',
      code: 'RPC_UNAVAILABLE',
    });
    expectNoKey(answer);
  });
});

describe("the wallet handlers' own redaction", () => {
  // ethers' error for a keyed endpoint's 403, as main's providers would
  // throw it without their own redaction.
  const ethersError = (url) => {
    const error = new Error(
      `server response 403 Forbidden (request={  }, response={  }, error=null, ` +
        `info={ "requestUrl": "${url}", "responseBody": "{\\"error\\":\\"bad key ${KEY}\\"}", ` +
        `"responseStatus": "403 Forbidden" }, code=SERVER_ERROR, version=6.17.0)`
    );
    error.code = 'SERVER_ERROR';
    return error;
  };
  const KEYED = `https://lb.drpc.live/gnosis/${KEY}`;

  beforeEach(async () => {
    await writePool([{ keyed: true, status: 403 }]);
  });

  test('a reply that quotes an RPC error has neither the URL nor the key', async () => {
    const ipc = loadWalletIpc({
      [require.resolve('./safe/safe-service')]: () => ({
        getSafeStatus: jest.fn(async () => {
          throw ethersError(KEYED);
        }),
        activateSafe: jest.fn(async () => {
          throw ethersError(endpoints[0].url);
        }),
        DEPLOY_CHAIN_ID: 100,
      }),
    });

    for (const answer of [
      await ipc.invoke('wallet:get-safe-status', 5),
      await ipc.invoke('wallet:activate-safe', 5, {}),
    ]) {
      expect(answer).toMatchObject({ success: false });
      expect(answer.error).toContain('server response 403 Forbidden');
      expect(answer.error).toContain('/[path redacted]');
      expect(answer.error).toContain('[key redacted]');
      expect(JSON.stringify(answer)).not.toContain(KEYED);
      expectNoKey(answer);
    }
  });

  test("a JSON-RPC error object's text and data are redacted too", async () => {
    const ipc = loadWalletIpc({
      [require.resolve('../networks/chain-data')]: () => ({
        isReadMethod: () => true,
        request: jest.fn(async () => {
          const error = ethersError(KEYED);
          error.code = -32000;
          error.data = { detail: `quota for ${KEY}` };
          throw error;
        }),
      }),
    });

    const answer = await ipc.invoke('wallet:chain-request', {
      chainId: 100,
      method: 'eth_blockNumber',
    });
    expect(answer).toMatchObject({
      success: false,
      error: { code: -32000, data: { detail: 'quota for [key redacted]' } },
    });
    expect(JSON.stringify(answer)).not.toContain(KEYED);
    expectNoKey(answer);
  });

  test("a handler's thrown error reaches the renderer redacted", async () => {
    const ipc = loadWalletIpc({
      [require.resolve('./balance-service')]: () => ({
        getAllBalances: jest.fn(),
        getBalancesWithCache: jest.fn(),
        clearBalanceCache: () => {
          throw ethersError(KEYED);
        },
      }),
    });
    // The handler catches it: its reply is redacted.
    const answer = await ipc.invoke('wallet:clear-balance-cache', '0xabc');
    expect(answer.success).toBe(false);
    expectNoKey(answer);
    expect(JSON.stringify(answer)).not.toContain(KEYED);
  });

  test('every intent handler is registered redacted', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadMainModule(require.resolve('./intent-ipc'), {
      ipcMain,
      userDataDir,
      extraMocks: {
        [require.resolve('./intent-store')]: () => ({
          closedText: () => '',
          getIntentStore: () => ({
            onChange: () => {},
            get ready() {
              return Promise.reject(ethersError(KEYED));
            },
          }),
        }),
        [require.resolve('./intent-tracker')]: () => ({
          getIntentTracker: () => ({ onChange: () => {} }),
        }),
      },
    });
    mod.registerIntentIpc({ windows: () => [] });

    const answer = await ipcMain.invoke('wallet:intents-list');
    expect(answer).toMatchObject({ success: false });
    expect(answer.error).toContain('[key redacted]');
    expect(JSON.stringify(answer)).not.toContain(KEYED);
    expectNoKey(answer);
  });
});

describe('redactedHandler', () => {
  const { redactedHandler } = require('./rpc-errors');
  const URL_WITH_KEY = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;

  test('a synchronous handler stays synchronous', () => {
    const wrapped = redactedHandler(() => ({ success: false, error: `at ${URL_WITH_KEY}` }));
    expect(wrapped()).toEqual({
      success: false,
      error: 'at https://eth-mainnet.g.alchemy.com/[path redacted]',
    });
  });

  test('a thrown error, sync or async, keeps its code and loses the URL', async () => {
    const thrown = Object.assign(new Error(`failed at ${URL_WITH_KEY}`), { code: 'X' });
    const sync = redactedHandler(() => {
      throw thrown;
    });
    expect(() => sync()).toThrow('failed at https://eth-mainnet.g.alchemy.com/[path redacted]');
    const rejected = redactedHandler(async () => {
      throw thrown;
    });
    await expect(rejected()).rejects.toMatchObject({
      message: 'failed at https://eth-mainnet.g.alchemy.com/[path redacted]',
      code: 'X',
    });
  });

  test('a nested error is redacted at every depth, and dropped past the bound', () => {
    // Six levels down: the old four-level walk passed this through as it was.
    const nested = { cause: { errors: [{ cause: { details: { url: URL_WITH_KEY } } }] } };
    // Ten levels down: past the bound, so dropped rather than passed on.
    let deep = { text: `key=${KEY} at ${URL_WITH_KEY}` };
    for (let i = 0; i < 10; i += 1) deep = { inner: deep };
    const wrapped = redactedHandler(() => ({ success: false, error: { nested, deep } }));
    const reply = JSON.stringify(wrapped());
    expect(reply).not.toContain(KEY);
    expect(reply).not.toContain('/v2/');
    expect(reply).toContain('https://eth-mainnet.g.alchemy.com/[path redacted]');
    expect(reply).toContain('[redacted: nested too deep]');
  });

  test('a reply without an error is passed as it is', () => {
    const reply = { success: true, explorerUrl: 'https://gnosisscan.io/tx/0xabc' };
    expect(redactedHandler(() => reply)()).toBe(reply);
  });
});
