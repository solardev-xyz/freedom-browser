/**
 * colibri-outcome.js against the WASM path's outcomes, byte for byte
 * (freedom-core design 0014, "What main builds from an answer").
 *
 * The reference is the WASM path as it ran until COL-6 removed it, from the
 * host's client down to the C core: the worker host's client (its
 * `params ?? []`, its `reviveError`), messages cloned as `postMessage` clones
 * them, the worker's service (its client config, its `serializeError`), and
 * the package's client (`request()`, the VerifiedOnly strategy, `rpc()`'s
 * statuses, `throwRevert` and `ProviderRpcError.createError`), with only the
 * C core scripted to end each request's context with the status a service
 * reply carries. Its outcome for every error and revert case here was
 * recorded before it went: test/fixtures/colibri/reference-outcomes.json,
 * by case, each error's own properties (`stack` apart) on an
 * `Error.prototype` object. Each case hands the same status to main and
 * compares the two.
 */

const { ColibriWorkerError, replyOutcome } = require('./colibri-outcome');
const RECORDED = require('../../../test/fixtures/colibri/reference-outcomes.json');

const BALANCE = {
  method: 'eth_getBalance',
  params: ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'latest'],
};
const CUT = 2000;
const HIGH_SURROGATE = 0xd83d;
const ASTRAL = '\u{1F600}';

/** What main builds from the service's reply carrying `status`, as it comes
 * off the wire. */
function serviceOutcome(request, status) {
  return replyOutcome(JSON.parse(JSON.stringify(status)), request);
}

/** Everything of an error its caller can read: its own properties
 * (`stack` apart, which names where it was made), as the fixture records
 * them. Strings compare by their UTF-16 units. */
function own(error) {
  const keys = Object.getOwnPropertyNames(error).filter((key) => key !== 'stack').sort();
  return Object.fromEntries(keys.map((key) => [key, error[key]]));
}

/** Main's outcome for one status against the reference's recorded `key`:
 * equal, and main's outcome returned. */
function compare(key, request, status) {
  if (!Object.hasOwn(RECORDED, key)) throw new Error(`no recorded outcome for ${key}`);
  const service = serviceOutcome(request, status);
  expect(service).not.toBeNull();
  expect(service.ok).toBe(false);
  expect(Object.getPrototypeOf(service.error)).toBe(Error.prototype);
  expect(own(service.error)).toStrictEqual(RECORDED[key]);
  return { service };
}

/** Where the C core's text starts in the recorded probe `key`'s message
 * (its text is `.`). */
function textOffset(key) {
  return RECORDED[key].message.length - 1;
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
  ])('%s', (label, text, code) => {
    const { service } = compare(`text: ${label}`, BALANCE, { status: 'error', error: text });
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
  ])('%s', (label, request) => {
    const { service } = compare(`params: ${label}`, request, {
      status: 'error',
      error: 'HTTP error! Status: 503, Details: down',
    });
    expect(service.error.code).toBe(4900);
  });

  test('long params: the cut falls in them, and the code is still the whole text’s', () => {
    const addresses = Array.from({ length: 120 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
    const request = { method: 'eth_getLogs', params: [{ address: addresses }] };
    const text = 'remote proof failed (no local proving): HTTP error! Status: 503, Details: down';
    const { service } = compare('long params', request, { status: 'error', error: text });
    expect(service.error.message).toHaveLength(CUT);
    expect(service.error.message).not.toContain(' : ');
    expect(service.error.code).toBe(4900);
  });

  test('a long text: cut to 2,000 units of the completed message', () => {
    const text = `HTTP error! Status: 503, Details: ${'x'.repeat(5000)}`;
    const { service } = compare('long text', BALANCE, { status: 'error', error: text });
    expect(service.error.message).toHaveLength(CUT);
    expect(service.error.message.startsWith('Error in rpc call eth_getBalance[')).toBe(true);
  });

  describe('a cut at a surrogate pair', () => {
    test('the probe: the C core’s text where the recording says', () => {
      compare('surrogate: probe', BALANCE, { status: 'error', error: '.' });
    });

    test('a pair across the cut: its high half ends the message, alone', () => {
      const at = textOffset('surrogate: probe');
      const text = `${'a'.repeat(CUT - at - 1)}${ASTRAL}b`;
      const { service } = compare('surrogate: a pair across the cut', BALANCE, {
        status: 'error',
        error: text,
      });
      expect(service.error.message).toHaveLength(CUT);
      expect(service.error.message.charCodeAt(CUT - 1)).toBe(HIGH_SURROGATE);
    });

    test('a pair ending at the cut: kept whole', () => {
      const at = textOffset('surrogate: probe');
      const text = `${'a'.repeat(CUT - at - 2)}${ASTRAL}b`;
      const { service } = compare('surrogate: a pair ending at the cut', BALANCE, {
        status: 'error',
        error: text,
      });
      expect(service.error.message).toHaveLength(CUT);
      expect(service.error.message.endsWith(ASTRAL)).toBe(true);
    });

    test('a pair starting at the cut: left out whole', () => {
      const at = textOffset('surrogate: probe');
      const text = `${'a'.repeat(CUT - at)}${ASTRAL}`;
      const { service } = compare('surrogate: a pair starting at the cut', BALANCE, {
        status: 'error',
        error: text,
      });
      expect(service.error.message).toHaveLength(CUT);
      expect(service.error.message.endsWith('a')).toBe(true);
    });

    test('a pair in the params across the cut', () => {
      const probe = { method: 'eth_getBalance', params: ['\u0000'] };
      compare('surrogate: params probe', probe, { status: 'error', error: '.' });
      // Where the param's text starts: its one character is escaped to six.
      const at = RECORDED['surrogate: params probe'].message.indexOf('\\u0000');
      const request = { method: 'eth_getBalance', params: [`${'a'.repeat(CUT - at - 1)}${ASTRAL}`] };
      const { service } = compare('surrogate: a pair in the params across the cut', request, {
        status: 'error',
        error: 'All nodes failed',
      });
      expect(service.error.message).toHaveLength(CUT);
      expect(service.error.message.charCodeAt(CUT - 1)).toBe(HIGH_SURROGATE);
      expect(service.error.code).toBe(4900);
    });

    test('astral text throughout: the cut falls where the units say', () => {
      const { service } = compare('surrogate: astral text throughout', BALANCE, {
        status: 'error',
        error: ASTRAL.repeat(1500),
      });
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
  ])('%s', (label, data) => {
    const { service } = compare(`revert: ${label}`, CALL, { status: 'revert', data });
    expect(service.error).toMatchObject({ name: 'ProviderRpcError', code: 3, message: 'execution reverted', data });
  });
});

// The reference gave a success's result as the C core's status carried it,
// `undefined` when it carried none.
describe('a success reply: the result', () => {
  test.each([
    ['a quantity', '0x507c30d79341ec0a'],
    ['an object', { number: '0x10', hash: `0x${'aa'.repeat(32)}`, transactions: [] }],
    ['an array', ['0x1', null]],
    ['null', null],
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
  ])('%s', (_label, result) => {
    expect(serviceOutcome(BALANCE, { status: 'success', result })).toStrictEqual({
      ok: true,
      result,
    });
  });

  test('no result: undefined', () => {
    expect(serviceOutcome(BALANCE, { status: 'success' })).toStrictEqual({
      ok: true,
      result: undefined,
    });
  });
});

test('the recording holds the error and revert cases above, and nothing else', () => {
  const groups = Object.keys(RECORDED).map((key) => key.split(': ')[0]);
  expect(groups.filter((group) => group === 'text')).toHaveLength(25);
  expect(groups.filter((group) => group === 'params')).toHaveLength(12);
  expect(groups.filter((group) => group === 'surrogate')).toHaveLength(7);
  expect(groups.filter((group) => group === 'revert')).toHaveLength(3);
  expect(Object.keys(RECORDED).filter((key) => !key.includes(': '))).toEqual([
    'long params',
    'long text',
  ]);
});

// Main's own errors keep the WASM host's class name: chain-verified's fault
// bit, the routers and #752's backoff match on it, and on its marks.
describe('ColibriWorkerError', () => {
  test('is an Error named ColibriWorkerError, its marks set on it', () => {
    const err = Object.assign(new ColibriWorkerError('Colibri worker replaced: died'), {
      colibriBystander: true,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      name: 'ColibriWorkerError',
      message: 'Colibri worker replaced: died',
      colibriBystander: true,
    });
    expect(own(new ColibriWorkerError('x'))).toEqual({ message: 'x', name: 'ColibriWorkerError' });
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
