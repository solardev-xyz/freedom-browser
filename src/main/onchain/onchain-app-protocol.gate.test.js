/**
 * `web3:` — the trust gate, in order, with the chain-data router stubbed.
 *
 * Roadmap 4.7, design 0006 ("Tests first"). Design 0006 moves the decode and
 * the trust decision into the core (`chain.html`); these cases pin the order
 * the handler applies them in today, driven with real `Request` objects
 * through the default `chainRequest` (the stubbed `chain-data-router`) and the
 * real decode worker:
 *
 *   1. a GET carrying a valid approval token is served from the staged
 *      document, with no chain read;
 *   2. otherwise the chain is read and decoded (413 for size, before any
 *      decode work);
 *   3. `verified` and `user-configured` are served;
 *   4. a hash approved earlier this session is served, dissenters or not;
 *   5. an untrusted GET is staged behind a single-use token and answered 451
 *      — or, on a conflict, answered 451 with no token at all;
 *   6. an untrusted HEAD is answered 200 with no body and stages nothing.
 */

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../networks/chain-data-router', () => ({
  request: jest.fn(),
}));

jest.mock('../networks/network-registry', () => ({
  getNetwork: jest.fn(() => ({ name: 'Ethereum' })),
}));

const { ethers } = require('ethers');
const chainData = require('../networks/chain-data-router');
const {
  APPROVAL_HEADER,
  GATE_HEADER,
  HTML_SELECTOR,
  MAX_HTML_BYTES,
  PROVENANCE_HEADER,
  createOnchainAppTrustState,
  decodeOnchainProvenance,
  handleOnchainAppRequest,
  htmlWorker,
  registerOnchainAppProtocol,
} = require('./onchain-app-protocol');
const { waitFor } = require('../../../test/helpers/fake-http-node');

const ADDRESS = '0x00000095643CFfA7D9fae407a84dfCB6406456c6';
const APP_URL = `web3://${ADDRESS.toLowerCase()}.eip155-1/swap?pair=eth`;
const HTML = '<!doctype html><title>app</title><script>window.ran = true</script>';
const OTHER_HTML = '<!doctype html><title>changed</title>';

const hashOf = (html) => ethers.keccak256(ethers.toUtf8Bytes(html));

// The ABI encoding of `html()`'s string result, built by hand: ethers takes
// seconds to encode the 8 MiB boundary documents.
function encodeHtml(html) {
  const bytes = Buffer.from(html, 'utf8');
  const word = (n) => n.toString(16).padStart(64, '0');
  const padding = (32 - (bytes.length % 32)) % 32;
  return `0x${word(32)}${word(bytes.length)}${bytes.toString('hex')}${'00'.repeat(padding)}`;
}

// What the router resolves with `includeTrust: true` (chain-data-router.js
// `request`): the result, the source that answered and its trust record.
const TRUST = {
  myotis: {
    source: 'myotis',
    verified: true,
    trust: {
      level: 'verified',
      method: 'myotis',
      block: 123,
      agreed: ['myotis-p2p'],
      dissented: [],
      queried: ['myotis-p2p'],
    },
  },
  colibri: {
    source: 'colibri',
    verified: true,
    trust: {
      level: 'verified',
      method: 'colibri',
      prover: 'prover.example',
      block: null,
      agreed: ['prover.example'],
      dissented: [],
      queried: ['prover.example'],
    },
  },
  quorumWithDissent: {
    source: 'quorum',
    verified: true,
    trust: {
      level: 'verified',
      method: 'quorum',
      block: null,
      agreed: ['a.example', 'b.example'],
      dissented: ['c.example'],
      queried: ['a.example', 'b.example', 'c.example'],
    },
  },
  userConfigured: {
    source: 'direct',
    verified: false,
    trust: {
      level: 'user-configured',
      method: 'direct',
      block: null,
      agreed: ['node.example'],
      dissented: [],
      queried: ['node.example'],
    },
  },
  unverified: {
    source: 'direct',
    verified: false,
    trust: {
      level: 'unverified',
      method: 'direct',
      block: null,
      agreed: ['rpc.example'],
      dissented: [],
      queried: ['rpc.example'],
    },
  },
  conflict: {
    source: 'direct',
    verified: false,
    trust: {
      level: 'unverified',
      method: 'direct',
      block: null,
      agreed: ['rpc.example'],
      dissented: ['other.example'],
      queried: ['rpc.example', 'other.example'],
    },
  },
};

function routerAnswers(html, trust) {
  chainData.request.mockResolvedValue({ result: encodeHtml(html), ...TRUST[trust] });
}

function gateUrl(res) {
  return new URL(Buffer.from(res.headers.get(GATE_HEADER), 'base64url').toString('utf8'));
}

const get = (headers = {}) => new Request(APP_URL, { headers });
const head = () => new Request(APP_URL, { method: 'HEAD' });

let trustState;
let staged;
let consumed;

// The handler with the default chainRequest (the stubbed router) and a trust
// state the test can watch.
const handle = (request) => handleOnchainAppRequest(request, { trustState });

beforeEach(() => {
  chainData.request.mockReset();
  trustState = createOnchainAppTrustState();
  staged = jest.spyOn(trustState, 'stage');
  consumed = jest.spyOn(trustState, 'consume');
});

describe('web3: the gate, in order', () => {
  test('reads html() through the router as an interactive, trust-labelled eth_call', async () => {
    routerAnswers(HTML, 'myotis');
    await handle(get());

    expect(chainData.request).toHaveBeenCalledWith(
      1,
      'eth_call',
      [{ to: ethers.getAddress(ADDRESS), data: HTML_SELECTOR }, 'latest'],
      // objectContaining: the `web3-cancel` change adds a `signal` here.
      expect.objectContaining({
        includeTrust: true,
        routingContext: { origin: `web3://${ADDRESS.toLowerCase()}` },
      })
    );
  });

  test('1. an approval-token GET is served from the staged document with no chain read', async () => {
    routerAnswers(HTML, 'unverified');
    const blocked = await handle(get());
    const token = gateUrl(blocked).searchParams.get('token');
    expect(chainData.request).toHaveBeenCalledTimes(1);

    // Whatever the chain would say now is never asked.
    chainData.request.mockRejectedValue(new Error('must not be read'));
    const approved = await handle(get({ [APPROVAL_HEADER]: token }));

    expect(approved.status).toBe(200);
    await expect(approved.text()).resolves.toBe(HTML);
    expect(chainData.request).toHaveBeenCalledTimes(1);
    expect(approved.headers.get('x-freedom-onchain-app-verified')).toBe('false');
    expect(approved.headers.get('x-freedom-onchain-app-source')).toBe('direct');
    expect(decodeOnchainProvenance(approved.headers.get(PROVENANCE_HEADER))).toMatchObject({
      htmlHash: hashOf(HTML),
      trust: { level: 'unverified' },
    });
  });

  test('1. the token is single-use: a replay reads the chain, and the now-approved hash passes', async () => {
    routerAnswers(HTML, 'unverified');
    const token = gateUrl(await handle(get())).searchParams.get('token');
    await handle(get({ [APPROVAL_HEADER]: token }));

    const replay = await handle(get({ [APPROVAL_HEADER]: token }));

    expect(chainData.request).toHaveBeenCalledTimes(2);
    expect(replay.status).toBe(200);
    await expect(replay.text()).resolves.toBe(HTML);
  });

  test('1. HEAD never consumes a token: it reads the chain, and the token still works after', async () => {
    routerAnswers(HTML, 'unverified');
    const token = gateUrl(await handle(get())).searchParams.get('token');
    consumed.mockClear();

    const probe = await handle(
      new Request(APP_URL, { method: 'HEAD', headers: { [APPROVAL_HEADER]: token } })
    );
    expect(consumed).not.toHaveBeenCalled();
    expect(chainData.request).toHaveBeenCalledTimes(2);
    expect(probe.status).toBe(200);

    const approved = await handle(get({ [APPROVAL_HEADER]: token }));
    expect(approved.status).toBe(200);
    expect(chainData.request).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['verified (Myotis)', 'myotis', 'true', 'myotis'],
    ['verified (Colibri)', 'colibri', 'true', 'colibri'],
    ['verified (quorum) even with a dissenter', 'quorumWithDissent', 'true', 'quorum'],
    ['user-configured', 'userConfigured', 'false', 'direct'],
  ])('3. %s is served at once', async (_label, trust, verified, source) => {
    routerAnswers(HTML, trust);

    const res = await handle(get());

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(HTML);
    expect(res.headers.get(GATE_HEADER)).toBeNull();
    expect(res.headers.get('x-freedom-onchain-app-verified')).toBe(verified);
    expect(res.headers.get('x-freedom-onchain-app-source')).toBe(source);
    expect(staged).not.toHaveBeenCalled();
  });

  test('4. an approved hash passes on later reads, even when the RPCs now disagree', async () => {
    routerAnswers(HTML, 'unverified');
    const token = gateUrl(await handle(get())).searchParams.get('token');
    await handle(get({ [APPROVAL_HEADER]: token }));
    staged.mockClear();

    routerAnswers(HTML, 'conflict');
    const res = await handle(get());

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(HTML);
    expect(staged).not.toHaveBeenCalled();

    // The approval is for that exact document, not the contract.
    routerAnswers(OTHER_HTML, 'unverified');
    const changed = await handle(get());
    expect(changed.status).toBe(451);
    expect(gateUrl(changed).searchParams.get('hash')).toBe(hashOf(OTHER_HTML));
  });

  test('5. untrusted is staged behind a single-use token and answered 451', async () => {
    routerAnswers(HTML, 'unverified');

    const res = await handle(get());

    expect(res.status).toBe(451);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    await expect(res.text()).resolves.toBe('Freedom blocked unverified onchain application code.');
    expect(staged).toHaveBeenCalledTimes(1);
    expect(staged.mock.calls[0][0]).toMatchObject({
      html: HTML,
      requestUrl: APP_URL,
      provenance: { htmlHash: hashOf(HTML), trust: { level: 'unverified' } },
    });
    const gate = gateUrl(res);
    expect(gate.protocol).toBe('file:');
    expect(gate.pathname).toMatch(/\/pages\/onchain-unverified\.html$/);
    expect(gate.searchParams.get('target')).toBe(APP_URL);
    expect(gate.searchParams.get('hash')).toBe(hashOf(HTML));
    expect(gate.searchParams.get('source')).toBe('rpc.example');
    expect(gate.searchParams.get('token')).toBe(staged.mock.results[0].value);
    expect(gate.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(gate.searchParams.has('conflict')).toBe(false);
  });

  test('5. a conflict is answered 451 with no token, so it cannot be approved', async () => {
    routerAnswers(HTML, 'conflict');

    const res = await handle(get());

    expect(res.status).toBe(451);
    expect(staged).not.toHaveBeenCalled();
    const gate = gateUrl(res);
    expect(gate.searchParams.get('conflict')).toBe('1');
    expect(gate.searchParams.get('dissented')).toBe('other.example');
    expect(gate.searchParams.has('token')).toBe(false);
  });

  // TODAY: a HEAD is never gated — it learns the 200, the hash and the trust
  // record of code a GET would block — but it carries no body and stages
  // nothing, so nothing runs and no token is minted.
  test('6. an untrusted HEAD gets 200 with a null body and stages nothing', async () => {
    routerAnswers(HTML, 'unverified');

    const res = await handle(head());

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get(GATE_HEADER)).toBeNull();
    expect(decodeOnchainProvenance(res.headers.get(PROVENANCE_HEADER)).htmlHash).toBe(hashOf(HTML));
    expect(staged).not.toHaveBeenCalled();
  });
});

describe('web3: the size limit', () => {
  const ZEROS = (bytes) => `0x${'00'.repeat(bytes)}`;

  test('413 for an encoded result past MAX_HTML_BYTES + 95, before any decode work', async () => {
    const run = jest.spyOn(htmlWorker, 'run');
    chainData.request.mockResolvedValue({ result: ZEROS(MAX_HTML_BYTES + 96), ...TRUST.myotis });

    const res = await handle(get());

    expect(res.status).toBe(413);
    await expect(res.text()).resolves.toBe("html() response exceeds Freedom's 8 MiB limit");
    expect(run).not.toHaveBeenCalled();
    run.mockRestore();
  });

  // Design 0006 bounds: encoded <= MAX_HTML_BYTES + 95, document <= 8 MiB. An
  // 8 MiB document encodes to MAX_HTML_BYTES + 64 bytes; one byte more pads
  // to MAX_HTML_BYTES + 96 and is refused by the precheck alone.
  test('a document of exactly 8 MiB is served; one byte more is a 413 before any decode', async () => {
    const run = jest.spyOn(htmlWorker, 'run');
    const atLimit = 'a'.repeat(MAX_HTML_BYTES);
    routerAnswers(atLimit, 'myotis');
    const served = await handle(get());
    expect(served.status).toBe(200);
    expect((await served.text()).length).toBe(MAX_HTML_BYTES);
    expect(run).toHaveBeenCalledTimes(1);

    routerAnswers(`${atLimit}a`, 'myotis');
    const tooLarge = await handle(get());
    expect(tooLarge.status).toBe(413);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
  }, 20_000);
});

describe('web3: cancellation', () => {
  // Design 0006, deviation `web3-cancel`: today an aborted navigation stops
  // the handler waiting, but the chain read itself is never told — no signal
  // is handed to the router (onchain-app-protocol.js, the `chainRequest(...)`
  // call), although the router honours one. When `web3-cancel` lands, the
  // read sees the navigation's abort and the one assertion marked below
  // flips to `true`.
  test('TODAY (deviation web3-cancel): an aborted navigation does not cancel the chain read', async () => {
    let routerOptions = null;
    let finishRead;
    chainData.request.mockImplementation((_chainId, _method, _params, options) => {
      routerOptions = options;
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    });
    const controller = new AbortController();

    const pending = handle(new Request(APP_URL, { signal: controller.signal }));
    await waitFor(() => routerOptions !== null, { what: 'the chain read to start' });
    controller.abort();
    const res = await pending;

    // The handler stops waiting at once…
    expect(res.status).toBe(504);
    // …but the read it started is not cancelled.
    const chainReadCancelled = routerOptions.signal?.aborted === true;
    expect(chainReadCancelled).toBe(false); // web3-cancel flips this to true

    // The orphaned read finishing later changes nothing.
    finishRead({ result: encodeHtml(HTML), ...TRUST.unverified });
    await new Promise((resolve) => setImmediate(resolve));
    expect(staged).not.toHaveBeenCalled();
  });
});

describe('web3: through the registered handler', () => {
  function registerSession() {
    const handlers = new Map();
    registerOnchainAppProtocol({ protocol: { handle: (scheme, fn) => handlers.set(scheme, fn) } });
    return handlers.get('web3');
  }

  test('each session keeps its own approvals: a second session (a private window) gates again', async () => {
    routerAnswers(HTML, 'unverified');
    const main = registerSession();
    const privateWindow = registerSession();

    const token = gateUrl(await main(get())).searchParams.get('token');
    expect((await main(get({ [APPROVAL_HEADER]: token }))).status).toBe(200);
    expect((await main(get())).status).toBe(200);

    // The other session's state never saw the approval, nor the token.
    expect((await privateWindow(get({ [APPROVAL_HEADER]: token }))).status).toBe(451);
  });
});
