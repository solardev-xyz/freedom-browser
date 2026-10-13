/**
 * `web3:` — the trust gate, in order, with chain data stubbed.
 *
 * Roadmap 4.7, design 0006 ("Tests first"). Design 0006 moves the decode and
 * the trust classification into the core (`chain.html`); these cases pin the
 * order the handler applies them in (design 0006, "Main decides, in today's
 * order"), driven with real `Request` objects through the default `chainHtml`
 * (the stubbed `chain-data`):
 *
 *   1. a GET carrying a valid approval token is served from the staged
 *      document, with no chain read;
 *   2. otherwise the core reads, decodes and classifies the document (413
 *      only for the core's own size error);
 *   3. the class `trusted` (`verified` and `user-configured`) is served;
 *   4. a hash approved earlier this session is served, dissenters or not;
 *   5. an `untrusted` GET is staged behind a single-use token and answered
 *      451 — or, on a `conflict`, answered 451 with no token at all;
 *   6. an untrusted HEAD is answered 200 with no body and stages nothing.
 *
 * The 8 MiB boundary, 413 against 502, cancel and a configuration change
 * through the real core are onchain-app-protocol.core.integration.test.js.
 */

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../networks/chain-data', () => ({
  chainHtml: jest.fn(),
}));

jest.mock('../networks/network-registry', () => ({
  getNetwork: jest.fn(() => ({ name: 'Ethereum' })),
}));

const { ethers } = require('ethers');
const chainData = require('../networks/chain-data');
const {
  APPROVAL_HEADER,
  GATE_HEADER,
  PROVENANCE_HEADER,
  REQUEST_TIMEOUT_MS,
  createOnchainAppTrustState,
  decodeOnchainProvenance,
  handleOnchainAppRequest,
  registerOnchainAppProtocol,
} = require('./onchain-app-protocol');
const { markFailure } = require('../core/chain-driver');
const { waitFor } = require('../../../test/helpers/fake-http-node');

const ADDRESS = '0x00000095643CFfA7D9fae407a84dfCB6406456c6';
const APP_URL = `web3://${ADDRESS.toLowerCase()}.eip155-1/swap?pair=eth`;
const HTML = '<!doctype html><title>app</title><script>window.ran = true</script>';
const OTHER_HTML = '<!doctype html><title>changed</title>';

const hashOf = (html) => ethers.keccak256(ethers.toUtf8Bytes(html));
// The core's cap on a document (design 0006, `chain.html`).
const MAX_HTML_BYTES = 8 * 1024 * 1024;

// What chain data's `chainHtml` resolves besides the document (the core's
// `chain.html`): the source that answered, its trust record and the core's
// class.
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
    class: 'trusted',
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
    class: 'trusted',
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
    class: 'trusted',
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
    class: 'trusted',
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
    class: 'untrusted',
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
    class: 'conflict',
  },
};

function coreAnswers(html, trust) {
  chainData.chainHtml.mockResolvedValue({ html, htmlHash: hashOf(html), ...TRUST[trust] });
}

function gateUrl(res) {
  return new URL(Buffer.from(res.headers.get(GATE_HEADER), 'base64url').toString('utf8'));
}

const get = (headers = {}) => new Request(APP_URL, { headers });
const head = () => new Request(APP_URL, { method: 'HEAD' });

let trustState;
let staged;
let consumed;

// The handler with the default chainHtml (the stubbed chain data) and a
// trust state the test can watch.
const handle = (request) => handleOnchainAppRequest(request, { trustState });

beforeEach(() => {
  chainData.chainHtml.mockReset();
  trustState = createOnchainAppTrustState();
  staged = jest.spyOn(trustState, 'stage');
  consumed = jest.spyOn(trustState, 'consume');
});

describe('web3: the gate, in order', () => {
  test("reads html() as the core's chain.html, interactive for the page's origin", async () => {
    coreAnswers(HTML, 'myotis');
    await handle(get());

    expect(chainData.chainHtml).toHaveBeenCalledWith(1, ethers.getAddress(ADDRESS), {
      origin: `web3://${ADDRESS.toLowerCase()}`,
      // Deviation `web3-cancel`: the navigation's abort reaches the read.
      signal: expect.any(AbortSignal),
      deadlineMs: REQUEST_TIMEOUT_MS,
    });
  });

  test('1. an approval-token GET is served from the staged document with no chain read', async () => {
    coreAnswers(HTML, 'unverified');
    const blocked = await handle(get());
    const token = gateUrl(blocked).searchParams.get('token');
    expect(chainData.chainHtml).toHaveBeenCalledTimes(1);

    // Whatever the chain would say now is never asked.
    chainData.chainHtml.mockRejectedValue(new Error('must not be read'));
    const approved = await handle(get({ [APPROVAL_HEADER]: token }));

    expect(approved.status).toBe(200);
    await expect(approved.text()).resolves.toBe(HTML);
    expect(chainData.chainHtml).toHaveBeenCalledTimes(1);
    expect(approved.headers.get('x-freedom-onchain-app-verified')).toBe('false');
    expect(approved.headers.get('x-freedom-onchain-app-source')).toBe('direct');
    expect(decodeOnchainProvenance(approved.headers.get(PROVENANCE_HEADER))).toMatchObject({
      htmlHash: hashOf(HTML),
      trust: { level: 'unverified' },
    });
  });

  test('1. the token is single-use: a replay reads the chain, and the now-approved hash passes', async () => {
    coreAnswers(HTML, 'unverified');
    const token = gateUrl(await handle(get())).searchParams.get('token');
    await handle(get({ [APPROVAL_HEADER]: token }));

    const replay = await handle(get({ [APPROVAL_HEADER]: token }));

    expect(chainData.chainHtml).toHaveBeenCalledTimes(2);
    expect(replay.status).toBe(200);
    await expect(replay.text()).resolves.toBe(HTML);
  });

  test('1. HEAD never consumes a token: it reads the chain, and the token still works after', async () => {
    coreAnswers(HTML, 'unverified');
    const token = gateUrl(await handle(get())).searchParams.get('token');
    consumed.mockClear();

    const probe = await handle(
      new Request(APP_URL, { method: 'HEAD', headers: { [APPROVAL_HEADER]: token } })
    );
    expect(consumed).not.toHaveBeenCalled();
    expect(chainData.chainHtml).toHaveBeenCalledTimes(2);
    expect(probe.status).toBe(200);

    const approved = await handle(get({ [APPROVAL_HEADER]: token }));
    expect(approved.status).toBe(200);
    expect(chainData.chainHtml).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['verified (Myotis)', 'myotis', 'true', 'myotis'],
    ['verified (Colibri)', 'colibri', 'true', 'colibri'],
    ['verified (quorum) even with a dissenter', 'quorumWithDissent', 'true', 'quorum'],
    ['user-configured', 'userConfigured', 'false', 'direct'],
  ])('3. %s is served at once', async (_label, trust, verified, source) => {
    coreAnswers(HTML, trust);

    const res = await handle(get());

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(HTML);
    expect(res.headers.get(GATE_HEADER)).toBeNull();
    expect(res.headers.get('x-freedom-onchain-app-verified')).toBe(verified);
    expect(res.headers.get('x-freedom-onchain-app-source')).toBe(source);
    expect(staged).not.toHaveBeenCalled();
  });

  test('4. an approved hash passes on later reads, even when the RPCs now disagree', async () => {
    coreAnswers(HTML, 'unverified');
    const token = gateUrl(await handle(get())).searchParams.get('token');
    await handle(get({ [APPROVAL_HEADER]: token }));
    staged.mockClear();

    coreAnswers(HTML, 'conflict');
    const res = await handle(get());

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(HTML);
    expect(staged).not.toHaveBeenCalled();

    // The approval is for that exact document, not the contract.
    coreAnswers(OTHER_HTML, 'unverified');
    const changed = await handle(get());
    expect(changed.status).toBe(451);
    expect(gateUrl(changed).searchParams.get('hash')).toBe(hashOf(OTHER_HTML));
  });

  test('5. untrusted is staged behind a single-use token and answered 451', async () => {
    coreAnswers(HTML, 'unverified');

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
    coreAnswers(HTML, 'conflict');

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
    coreAnswers(HTML, 'unverified');

    const res = await handle(head());

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get(GATE_HEADER)).toBeNull();
    expect(decodeOnchainProvenance(res.headers.get(PROVENANCE_HEADER)).htmlHash).toBe(hashOf(HTML));
    expect(staged).not.toHaveBeenCalled();
  });
});

describe('web3: the size limit', () => {
  const sizeError = (kind) =>
    markFailure(
      Object.assign(new Error("html() response exceeds Freedom's 8 MiB limit"), {
        code: 'ONCHAIN_APP_TOO_LARGE',
      }),
      { code: 'chain_error', kind }
    );

  test("413 is the core's own size error, with its text", async () => {
    chainData.chainHtml.mockRejectedValue(sizeError('core'));

    const res = await handle(get());

    expect(res.status).toBe(413);
    await expect(res.text()).resolves.toBe("html() response exceeds Freedom's 8 MiB limit");
    expect(staged).not.toHaveBeenCalled();
  });

  // Deviation `web3-413`: today a node's error carrying the code was a 413
  // with the node's message; only the core's own size error is now.
  test("a node's error carrying the same code is a 502", async () => {
    chainData.chainHtml.mockRejectedValue(sizeError('node'));

    const res = await handle(get());

    expect(res.status).toBe(502);
  });

  test('a document of exactly 8 MiB is served whole', async () => {
    const atLimit = 'a'.repeat(MAX_HTML_BYTES);
    coreAnswers(atLimit, 'myotis');
    const served = await handle(get());
    expect(served.status).toBe(200);
    expect((await served.text()).length).toBe(MAX_HTML_BYTES);
  });
});

describe('web3: cancellation', () => {
  // Design 0006, deviation `web3-cancel`: an aborted navigation cancels the
  // chain read. Before it, the handler stopped waiting but the read was
  // never told.
  test("an aborted navigation cancels the core's read (deviation web3-cancel)", async () => {
    let readOptions = null;
    let finishRead;
    chainData.chainHtml.mockImplementation((_chainId, _contract, options) => {
      readOptions = options;
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    });
    const controller = new AbortController();

    const pending = handle(new Request(APP_URL, { signal: controller.signal }));
    await waitFor(() => readOptions !== null, { what: 'the chain read to start' });
    expect(readOptions.signal.aborted).toBe(false);
    controller.abort();
    const res = await pending;

    // The handler stops waiting at once…
    expect(res.status).toBe(504);
    // …and the read it started is cancelled.
    expect(readOptions.signal.aborted).toBe(true);

    // A read finishing late anyway changes nothing.
    finishRead({ html: HTML, htmlHash: hashOf(HTML), ...TRUST.unverified });
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
    coreAnswers(HTML, 'unverified');
    const main = registerSession();
    const privateWindow = registerSession();

    const token = gateUrl(await main(get())).searchParams.get('token');
    expect((await main(get({ [APPROVAL_HEADER]: token }))).status).toBe(200);
    expect((await main(get())).status).toBe(200);

    // The other session's state never saw the approval, nor the token.
    expect((await privateWindow(get({ [APPROVAL_HEADER]: token }))).status).toBe(451);
  });
});
