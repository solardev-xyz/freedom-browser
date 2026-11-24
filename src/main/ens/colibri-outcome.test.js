/**
 * colibri-outcome.js against today's WASM path, byte for byte (freedom-core
 * design 0014, "What main builds from an answer"; COL-5).
 *
 * The WASM path here is the real one from the host's client down to the C
 * core: colibri-worker-host.js (its client's `params ?? []`, its
 * `reviveError`), messages cloned as `postMessage` clones them, a worker
 * running colibri-worker.js's own service (its client config, its
 * `serializeError`), and the installed package's client (`request()`, the
 * VerifiedOnly strategy, `rpc()`'s statuses, `throwRevert` and
 * `ProviderRpcError.createError`). Only the C core is scripted, through the
 * package's runtime provider: the request's context ends with the status the
 * service's reply carries, so each case hands the same status to both paths.
 * Nothing of those modules' logic is copied here.
 *
 * COL-6 removes the package and the worker with the WASM path; the contract
 * suite's vectors carry these comparisons on from there.
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

jest.mock('node:worker_threads', () => ({ Worker: jest.fn() }));
jest.mock('../logger', () => ({ warn: jest.fn(), info: jest.fn() }));

const host = require('./colibri-worker-host');
const { createColibriService } = require('./colibri-worker');
const { replyOutcome } = require('./colibri-outcome');

const PKG_CJS = path.dirname(require.resolve('@corpus-core/colibri-stateless'));
const { setRuntimeProvider } = require(path.join(PKG_CJS, 'runtime.js'));
const { default: Colibri, Strategy } = require(path.join(PKG_CJS, 'index.js'));

// ZK off: with it on, the client retries a text naming `zk sync proof`
// itself, which the service does before it replies.
const CONFIG = { chainId: 1, proverUrl: 'https://prover.example', zkProof: false };
const BALANCE = {
  method: 'eth_getBalance',
  params: ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'latest'],
};
const CUT = 2000;
const HIGH_SURROGATE = 0xd83d;
const ASTRAL = '\u{1F600}';

// The C core's status for the next request's context. The client's own
// first context, `eth_chainId`, is answered locally, as the C core does.
let coreStatus = null;
setRuntimeProvider(async () => ({
  getMethodType: () => 1,
  createRpcCtx: (method) => ({ method }),
  rpcCtxSetMinLatestBlockTs: () => {},
  executeRpcCtx: (ctx) =>
    ctx.method === 'eth_chainId' ? { status: 'success', result: '0x1' } : coreStatus,
  freeRpcCtx: () => {},
  registerStorage: () => {},
}));

beforeEach(() => {
  Worker.mockReset();
  Worker.mockImplementation(() => {
    const worker = new EventEmitter();
    const service = createColibriService({
      runtime: { Colibri, Strategy },
      storageDir: null,
      post: (message) => setImmediate(() => worker.emit('message', structuredClone(message))),
    });
    worker.postMessage = (message) => {
      const cloned = structuredClone(message);
      setImmediate(() => service.handle(cloned));
    };
    worker.terminate = () => Promise.resolve(1);
    worker.unref = () => {};
    service.init().then(() => worker.emit('message', { type: 'ready' }));
    return worker;
  });
  host.resetForTest({ storageDir: '/nonexistent/colibri' });
});

afterEach(() => {
  host.resetForTest();
});

/** What today's WASM path gives the caller of `request` when the C core
 * ends its context with `status`. */
async function wasmOutcome(request, status) {
  coreStatus = status;
  const client = host.createClient(CONFIG);
  try {
    return { ok: true, result: await client.request(request) };
  } catch (error) {
    return { ok: false, error };
  } finally {
    client.destroy();
  }
}

/** What main builds from the service's reply carrying `status`, as it comes
 * off the wire. */
function serviceOutcome(request, status) {
  return replyOutcome(JSON.parse(JSON.stringify(status)), request);
}

/** Everything of an outcome its caller can read: the result, or the error's
 * prototype, name and own properties (`stack` apart, which names where it
 * was made). Strings compare by their UTF-16 units. */
function readable(outcome) {
  if (outcome.ok) return outcome;
  const { error } = outcome;
  const own = Object.getOwnPropertyNames(error).filter((key) => key !== 'stack').sort();
  return {
    ok: false,
    prototype: Object.getPrototypeOf(error),
    name: error.name,
    own: Object.fromEntries(own.map((key) => [key, error[key]])),
  };
}

/** Both paths for one status: equal, and the service's outcome returned. */
async function compare(request, status) {
  const wasm = await wasmOutcome(request, status);
  const service = serviceOutcome(request, status);
  expect(service).not.toBeNull();
  expect(readable(service)).toStrictEqual(readable(wasm));
  return { service, wasm };
}

/** Where the C core's text starts in `request`'s adapter message. */
async function textOffset(request) {
  const { error } = await wasmOutcome(request, { status: 'error', error: '.' });
  return error.message.length - 1;
}

describe('an error reply: createError of the whole text, then the cut', () => {
  test.each([
    ['a verifier error', 'proof for latest too old', -32603],
    ['an unsupported method', 'Method eth_gasPrice is not supported', 4200],
    ['an unsupported method with a trailing space', 'Method eth_gasPrice is not supported ', -32603],
    ['an unsupported method with trailing text', 'Method eth_gasPrice is not supported here', -32603],
    ['an unsupported method in lower case', 'method eth_gasPrice is not supported', -32603],
    ['an unsupported method after other text', 'The Method eth_gasPrice is not supported', -32603],
    ['"Method " and " is not supported" overlapping', 'Method is not supported', 4200],
    ['an HTTP error', 'HTTP error! Status: 503, Details: down', 4900],
    ['an HTTP error in lower case', 'http error! Status: 503, Details: down', -32603],
    ['an HTTP error without its "!"', 'HTTP error Status: 503, Details: down', -32603],
    [
      'a failed remote proof over an HTTP error',
      'remote proof failed (no local proving): HTTP error! Status: 503, Details: prover down',
      4900,
    ],
    [
      'a failed remote proof over a transport error',
      'remote proof failed (no local proving): Request to <url> failed: fetch failed',
      -32603,
    ],
    ['every server failed', 'All nodes failed', 4900],
    ['every server failed, in lower case', 'all nodes failed', -32603],
    ['a browser fetch failure', 'Failed to fetch', 4900],
    ['a browser fetch failure in lower case', 'failed to fetch', -32603],
    ["Node's fetch failure", 'fetch failed', -32603],
    ['a transport error naming its URL', 'Request to https://prover.example/ failed: fetch failed', -32603],
    ['the unsupported rule before the transport one', 'Method HTTP error! is not supported', 4200],
    ["#279's refusal", 'Colibri cannot prove eth_getBalance at block "pending"', -32603],
    ['no ZK sync proof yet', 'No zk sync proof has been generated for this period yet', -32603],
    ['an empty text', '', -32603],
    ['non-ASCII text', `Fehler: ungültige Antwort – ${ASTRAL}`, -32603],
    ['a transport text past the cut', `${'x'.repeat(3000)} All nodes failed`, 4900],
    ['an unsupported method whose suffix is past the cut', `Method ${'m'.repeat(2500)} is not supported`, 4200],
  ])('%s', async (_label, text, code) => {
    const { service } = await compare(BALANCE, { status: 'error', error: text });
    expect(service.error.code).toBe(code);
    expect(service.error.message.length).toBeLessThanOrEqual(CUT);
  });

  test.each([
    ['no params', { method: 'eth_blockNumber' }],
    ['null params', { method: 'eth_getBlockByNumber', params: null }],
    ['empty params', { method: 'eth_blockNumber', params: [] }],
    ['params as an object', { method: 'eth_getBalance', params: { address: '0xabc' } }],
    ['params as a string', { method: 'eth_getBalance', params: '0xabc' }],
    ['params as 0', { method: 'eth_getBalance', params: 0 }],
    ['params as false', { method: 'eth_getBalance', params: false }],
    ['params as an empty string', { method: 'eth_getBalance', params: '' }],
    ['params with holes and nulls', { method: 'eth_getBalance', params: [undefined, null, { a: undefined }] }],
    ['params with escapes and non-ASCII', { method: 'eth_getBalance', params: ['ü"\\\n\u0001', { k: ASTRAL }] }],
    ['no method', { params: ['0xabc'] }],
    ['an empty method', { method: '', params: ['0xabc'] }],
  ])('%s', async (_label, request) => {
    const { service } = await compare(request, {
      status: 'error',
      error: 'HTTP error! Status: 503, Details: down',
    });
    expect(service.error.code).toBe(4900);
  });

  test('long params: the cut falls in them, and the code is still the whole text’s', async () => {
    const addresses = Array.from({ length: 120 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
    const request = { method: 'eth_getLogs', params: [{ address: addresses }] };
    const text = 'remote proof failed (no local proving): HTTP error! Status: 503, Details: down';
    const { service } = await compare(request, { status: 'error', error: text });
    expect(service.error.message).toHaveLength(CUT);
    expect(service.error.message).not.toContain(' : ');
    expect(service.error.code).toBe(4900);
  });

  test('a long text: cut to 2,000 units of the completed message', async () => {
    const text = `HTTP error! Status: 503, Details: ${'x'.repeat(5000)}`;
    const { service } = await compare(BALANCE, { status: 'error', error: text });
    expect(service.error.message).toHaveLength(CUT);
    expect(service.error.message.startsWith('Error in rpc call eth_getBalance[')).toBe(true);
  });

  describe('a cut at a surrogate pair', () => {
    test('a pair across the cut: its high half ends the message, alone', async () => {
      const at = await textOffset(BALANCE);
      const text = `${'a'.repeat(CUT - at - 1)}${ASTRAL}b`;
      const { service } = await compare(BALANCE, { status: 'error', error: text });
      expect(service.error.message).toHaveLength(CUT);
      expect(service.error.message.charCodeAt(CUT - 1)).toBe(HIGH_SURROGATE);
    });

    test('a pair ending at the cut: kept whole', async () => {
      const at = await textOffset(BALANCE);
      const text = `${'a'.repeat(CUT - at - 2)}${ASTRAL}b`;
      const { service } = await compare(BALANCE, { status: 'error', error: text });
      expect(service.error.message).toHaveLength(CUT);
      expect(service.error.message.endsWith(ASTRAL)).toBe(true);
    });

    test('a pair starting at the cut: left out whole', async () => {
      const at = await textOffset(BALANCE);
      const text = `${'a'.repeat(CUT - at)}${ASTRAL}`;
      const { service } = await compare(BALANCE, { status: 'error', error: text });
      expect(service.error.message).toHaveLength(CUT);
      expect(service.error.message.endsWith('a')).toBe(true);
    });

    test('a pair in the params across the cut', async () => {
      const probe = { method: 'eth_getBalance', params: ['\u0000'] };
      const { error } = await wasmOutcome(probe, { status: 'error', error: '.' });
      // Where the param's text starts: its one character is escaped to six.
      const at = error.message.indexOf('\\u0000');
      const request = { method: 'eth_getBalance', params: [`${'a'.repeat(CUT - at - 1)}${ASTRAL}`] };
      const { service } = await compare(request, { status: 'error', error: 'All nodes failed' });
      expect(service.error.message).toHaveLength(CUT);
      expect(service.error.message.charCodeAt(CUT - 1)).toBe(HIGH_SURROGATE);
      expect(service.error.code).toBe(4900);
    });

    test('astral text throughout: the cut falls where the units say', async () => {
      const { service } = await compare(BALANCE, { status: 'error', error: ASTRAL.repeat(1500) });
      expect(service.error.message).toHaveLength(CUT);
    });
  });
});

describe('a revert reply: throwRevert’s error', () => {
  const CALL = { method: 'eth_call', params: [{ to: '0x' + '11'.repeat(20), data: '0x' }, 'latest'] };

  test.each([
    ['revert data', `0x08c379a0${'00'.repeat(68)}`],
    ['empty revert data', '0x'],
    ['revert data past 2,000 units, which is never cut', `0x${'ab'.repeat(5000)}`],
  ])('%s', async (_label, data) => {
    const { service } = await compare(CALL, { status: 'revert', data });
    expect(service.error).toMatchObject({ name: 'ProviderRpcError', code: 3, message: 'execution reverted', data });
  });
});

describe('a success reply: the result', () => {
  test.each([
    ['a quantity', '0x507c30d79341ec0a'],
    ['an object', { number: '0x10', hash: `0x${'aa'.repeat(32)}`, transactions: [] }],
    ['an array', ['0x1', null]],
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
  ])('%s', async (_label, result) => {
    const { service } = await compare(BALANCE, { status: 'success', result });
    expect(service).toEqual({ ok: true, result });
  });

  test('no result: undefined', async () => {
    const { service } = await compare(BALANCE, { status: 'success' });
    expect(service).toStrictEqual({ ok: true, result: undefined });
  });
});

describe('a reply main does not know', () => {
  test.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'success'],
    ['an array', [{ status: 'success' }]],
    ['no status', {}],
    ['a pending status', { status: 'pending', requests: [] }],
    ['a status in upper case', { status: 'SUCCESS', result: '0x1' }],
    ['an error without its text', { status: 'error' }],
    ['an error whose text is a number', { status: 'error', error: 5 }],
    ['an error whose text is null', { status: 'error', error: null }],
    ['a revert without data', { status: 'revert' }],
    ['a revert whose data is a number', { status: 'revert', data: 7 }],
    ['a revert whose data is null', { status: 'revert', data: null }],
  ])('%s: null', (_label, reply) => {
    expect(replyOutcome(reply, BALANCE)).toBeNull();
  });
});
