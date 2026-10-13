jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../networks/chain-data', () => ({
  chainHtml: jest.fn(),
}));

jest.mock('../networks/network-registry', () => ({
  getNetwork: jest.fn((chainId) => ({ name: chainId === 1 ? 'Ethereum' : 'Gnosis Chain' })),
}));

const { ethers } = require('ethers');
const chainData = require('../networks/chain-data');
const log = require('../logger');
const {
  APPROVAL_HEADER,
  GATE_HEADER,
  ONCHAIN_APP_CSP,
  PROVENANCE_HEADER,
  REQUEST_TIMEOUT_MS,
  decodeOnchainProvenance,
  createOnchainAppTrustState,
  captureOnchainProvenance,
  failureStatus,
  guardOnchainAppRequest,
  handleOnchainAppRequest,
  parseOnchainAppUrl,
  registerOnchainAppProtocol,
} = require('./onchain-app-protocol');
const { markFailure } = require('../core/chain-driver');

const ADDRESS = '0x00000095643CFfA7D9fae407a84dfCB6406456c6';
const CANONICAL_ADDRESS = ethers.getAddress(ADDRESS);
const appUrl = (chainId = 1, path = '/') =>
  `web3://${ADDRESS.toLowerCase()}.eip155-${chainId}${path}`;

function request(url, method = 'GET', signal = undefined) {
  return { url, method, signal, headers: new Headers() };
}

const hashOf = (html) => ethers.keccak256(ethers.toUtf8Bytes(html));

// What chain data's `chainHtml` resolves (core/chain-driver.js, the core's
// `chain.html`): the document and its hash, the read's source, verified and
// trust, and the core's class, the gate's input.
function document(html, { trust, source = 'direct', verified = false, class: kind } = {}) {
  return {
    html,
    htmlHash: hashOf(html),
    source,
    verified,
    ...(trust ? { trust } : {}),
    class: kind,
  };
}

const UNVERIFIED = { level: 'unverified', method: 'direct', agreed: ['rpc.example'] };
const untrusted = (html) => document(html, { trust: UNVERIFIED, class: 'untrusted' });

// A failure as the driver throws it: today's error, and beside it what the
// core said it ended with.
const failed = (message, failure, props = {}) =>
  markFailure(Object.assign(new Error(message), props), failure);
const TOO_LARGE = "html() response exceeds Freedom's 8 MiB limit";

function gateUrl(response) {
  return new URL(Buffer.from(response.headers.get(GATE_HEADER), 'base64url').toString('utf8'));
}

describe('parseOnchainAppUrl', () => {
  test('parses the contract and explicit chain', () => {
    expect(parseOnchainAppUrl(appUrl(1, '/swap'))).toEqual({
      address: CANONICAL_ADDRESS,
      chainId: 1,
    });
  });

  test('defaults an omitted chain to Ethereum mainnet', () => {
    expect(parseOnchainAppUrl(`web3://${ADDRESS}/`)).toEqual({
      address: CANONICAL_ADDRESS,
      chainId: 1,
    });
  });

  test.each([
    'https://example.com',
    'web3://not-an-address:1/',
    `web3://${ADDRESS}:0/`,
    `web3://user@${ADDRESS}:1/`,
  ])('rejects malformed authority %s', (url) => {
    expect(parseOnchainAppUrl(url)).toBeNull();
  });
});

describe('handleOnchainAppRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  test("reads html() as the core's chain.html and returns the unmodified document", async () => {
    const html = '<!doctype html><title>zSwap</title><script>window.ok = true</script>';
    const chainHtml = jest.fn(async () =>
      document(html, {
        source: 'myotis',
        verified: true,
        trust: {
          level: 'verified',
          method: 'myotis',
          finality: 'optimistic',
          block: 123,
        },
        class: 'trusted',
      })
    );

    const response = await handleOnchainAppRequest(request(appUrl()), { chainHtml });

    expect(chainHtml).toHaveBeenCalledWith(1, CANONICAL_ADDRESS, {
      origin: `web3://${ADDRESS.toLowerCase()}`,
      signal: expect.any(AbortSignal),
      deadlineMs: REQUEST_TIMEOUT_MS,
    });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(html);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(ONCHAIN_APP_CSP);
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(response.headers.get('x-freedom-onchain-app-chain-id')).toBe('1');
    expect(response.headers.get('x-freedom-onchain-app-contract')).toBe(CANONICAL_ADDRESS);
    expect(response.headers.get('x-freedom-onchain-app-source')).toBe('myotis');
    expect(response.headers.get('x-freedom-onchain-app-verified')).toBe('true');
    expect(decodeOnchainProvenance(response.headers.get(PROVENANCE_HEADER))).toEqual({
      version: 1,
      chainId: 1,
      network: 'Ethereum',
      contract: CANONICAL_ADDRESS,
      htmlHash: hashOf(html),
      trust: {
        level: 'verified',
        method: 'myotis',
        finality: 'optimistic',
        block: 123,
      },
    });
  });

  test('HEAD validates the contract but returns no body', async () => {
    const chainHtml = jest.fn(async () =>
      document('<h1>app</h1>', { source: 'quorum', verified: true, class: 'trusted' })
    );
    const response = await handleOnchainAppRequest(request(appUrl(100), 'HEAD'), { chainHtml });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
    expect(chainHtml).toHaveBeenCalledWith(
      100,
      CANONICAL_ADDRESS,
      expect.objectContaining({ origin: `web3://${ADDRESS.toLowerCase()}:100` })
    );
  });

  test("a read with no trust label gets the provenance's trust from `verified`", async () => {
    for (const [verified, level, kind] of [
      [true, 'verified', 'trusted'],
      [false, 'unverified', 'untrusted'],
    ]) {
      const response = await handleOnchainAppRequest(request(appUrl(), 'HEAD'), {
        chainHtml: jest.fn(async () =>
          document('<h1>app</h1>', { source: 'quorum', verified, class: kind })
        ),
      });
      expect(response.headers.get('x-freedom-onchain-app-verified')).toBe(String(verified));
      expect(decodeOnchainProvenance(response.headers.get(PROVENANCE_HEADER)).trust).toEqual({
        level,
        method: 'quorum',
        block: null,
        agreed: [],
        dissented: [],
        queried: [],
      });
    }
  });

  test('lets a user-configured RPC serve an app without a warning', async () => {
    const html = '<h1>trusted RPC app</h1>';
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () =>
        document(html, {
          trust: {
            level: 'user-configured',
            method: 'direct',
            agreed: ['node.example'],
            dissented: [],
            queried: ['node.example'],
          },
          class: 'trusted',
        })
      ),
      trustState: createOnchainAppTrustState(),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(html);
  });

  test('gates public-RPC HTML, then serves the exact cached bytes after approval', async () => {
    const html = '<h1>unverified app</h1><script>window.executed = true</script>';
    const changedHtml = '<h1>changed app</h1>';
    const trustState = createOnchainAppTrustState({
      createToken: () => 'a'.repeat(43),
    });
    const unverified = {
      level: 'unverified',
      method: 'direct',
      agreed: ['rpc.example'],
      dissented: [],
      queried: ['rpc.example'],
    };
    const chainHtml = jest
      .fn()
      .mockResolvedValueOnce(document(html, { trust: unverified, class: 'untrusted' }))
      .mockResolvedValueOnce(document(html, { trust: unverified, class: 'untrusted' }))
      .mockResolvedValueOnce(document(changedHtml, { trust: unverified, class: 'untrusted' }));

    const blocked = await handleOnchainAppRequest(request(appUrl()), { chainHtml, trustState });
    expect(blocked.status).toBe(451);
    const interstitial = gateUrl(blocked);
    expect(interstitial.pathname).toMatch(/\/pages\/onchain-unverified\.html$/);
    expect(interstitial.searchParams.get('target')).toBe(appUrl());
    expect(interstitial.searchParams.get('source')).toBe('rpc.example');
    expect(interstitial.searchParams.get('hash')).toBe(hashOf(html));
    const token = interstitial.searchParams.get('token');
    expect(token).toBe('a'.repeat(43));

    const approvedRequest = request(appUrl());
    approvedRequest.headers.set(APPROVAL_HEADER, token);
    const approved = await handleOnchainAppRequest(approvedRequest, { chainHtml, trustState });
    expect(approved.status).toBe(200);
    await expect(approved.text()).resolves.toBe(html);
    expect(chainHtml).toHaveBeenCalledTimes(1);

    const unchanged = await handleOnchainAppRequest(request(appUrl()), { chainHtml, trustState });
    expect(unchanged.status).toBe(200);
    await expect(unchanged.text()).resolves.toBe(html);

    const changed = await handleOnchainAppRequest(request(appUrl()), { chainHtml, trustState });
    expect(changed.status).toBe(451);
    expect(gateUrl(changed).searchParams.get('hash')).toBe(hashOf(changedHtml));
  });

  test('blocks conflicting RPC answers without issuing a continue token', async () => {
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () =>
        document('<h1>first answer</h1>', {
          trust: {
            level: 'unverified',
            method: 'direct',
            agreed: ['a.example'],
            dissented: ['b.example'],
            queried: ['a.example', 'b.example'],
          },
          class: 'conflict',
        })
      ),
      trustState: createOnchainAppTrustState(),
    });

    expect(response.status).toBe(451);
    const interstitial = gateUrl(response);
    expect(interstitial.searchParams.get('conflict')).toBe('1');
    expect(interstitial.searchParams.get('dissented')).toBe('b.example');
    expect(interstitial.searchParams.has('token')).toBe(false);
  });

  // Deviation `web3-dissent`: the core counts dissenters by endpoint
  // reference, and main drops one whose URL doesn't parse as a host. The
  // core's class still says conflict: no token, the gate still opens.
  test("a conflict whose dissenters main can't name is still a conflict, with no token", async () => {
    const trustState = createOnchainAppTrustState();
    const stage = jest.spyOn(trustState, 'stage');
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () =>
        document('<h1>app</h1>', {
          trust: {
            level: 'unverified',
            method: 'quorum',
            agreed: ['a.example'],
            dissented: [],
            queried: ['a.example'],
          },
          class: 'conflict',
        })
      ),
      trustState,
    });

    expect(response.status).toBe(451);
    const interstitial = gateUrl(response);
    expect(interstitial.searchParams.get('conflict')).toBe('1');
    expect(interstitial.searchParams.get('dissented')).toBe('');
    expect(interstitial.searchParams.has('token')).toBe(false);
    expect(stage).not.toHaveBeenCalled();
    // The gate URL is one captureOnchainProvenance opens.
    const contents = { isDestroyed: () => false, loadURL: jest.fn(() => Promise.resolve()) };
    captureOnchainProvenance({
      resourceType: 'mainFrame',
      statusCode: 451,
      url: appUrl(),
      responseHeaders: { [GATE_HEADER]: [response.headers.get(GATE_HEADER)] },
      webContents: contents,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(contents.loadURL).toHaveBeenCalledWith(interstitial.toString());
  });

  test('the class decides, not the label: a verified quorum the core calls trusted passes', async () => {
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () =>
        document('<h1>app</h1>', {
          source: 'quorum',
          verified: true,
          trust: {
            level: 'verified',
            method: 'quorum',
            agreed: ['a.example', 'b.example'],
            dissented: ['c.example'],
            queried: ['a.example', 'b.example', 'c.example'],
          },
          class: 'trusted',
        })
      ),
    });
    expect(response.status).toBe(200);
  });

  test('rejects expired approval tokens', async () => {
    let time = 10;
    let sequence = 0;
    const trustState = createOnchainAppTrustState({
      now: () => time,
      createToken: () => `${String(sequence++).padStart(43, 'a')}`,
    });
    const chainHtml = jest.fn(async () => untrusted('<h1>app</h1>'));

    const blocked = await handleOnchainAppRequest(request(appUrl()), { chainHtml, trustState });
    const token = gateUrl(blocked).searchParams.get('token');
    time += 5 * 60 * 1000 + 1;
    const expiredRequest = request(appUrl());
    expiredRequest.headers.set(APPROVAL_HEADER, token);

    const expired = await handleOnchainAppRequest(expiredRequest, { chainHtml, trustState });
    expect(expired.status).toBe(451);
    expect(chainHtml).toHaveBeenCalledTimes(2);
  });

  test('binds approval tokens to the exact requested document URL', async () => {
    let sequence = 0;
    const trustState = createOnchainAppTrustState({
      createToken: () => String(sequence++).padStart(43, 'a'),
    });
    const chainHtml = jest.fn(async () => untrusted('<h1>app</h1>'));
    const blocked = await handleOnchainAppRequest(request(appUrl()), { chainHtml, trustState });
    const wrongTarget = request(appUrl(1, '/other'));
    wrongTarget.headers.set(APPROVAL_HEADER, gateUrl(blocked).searchParams.get('token'));

    const stillBlocked = await handleOnchainAppRequest(wrongTarget, { chainHtml, trustState });

    expect(stillBlocked.status).toBe(451);
    expect(chainHtml).toHaveBeenCalledTimes(2);
  });

  test('rejects non-read methods without touching chain data', async () => {
    const chainHtml = jest.fn();
    const response = await handleOnchainAppRequest(request(appUrl(), 'POST'), { chainHtml });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(chainHtml).not.toHaveBeenCalled();
  });

  test('returns 400 for a malformed contract URL', async () => {
    const chainHtml = jest.fn();
    const response = await handleOnchainAppRequest(request('web3://invalid:1/'), { chainHtml });
    expect(response.status).toBe(400);
    expect(chainHtml).not.toHaveBeenCalled();
  });

  test('returns 502 when the contract does not implement html()', async () => {
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () => {
        throw failed('data out-of-bounds', { code: 'chain_error', kind: 'core' });
      }),
    });
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toContain('did not return a valid ERC-8244');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('data out-of-bounds'));
  });

  test("413 is the core's own size error, with its text", async () => {
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () => {
        throw failed(
          TOO_LARGE,
          { code: 'chain_error', kind: 'core' },
          { code: 'ONCHAIN_APP_TOO_LARGE' }
        );
      }),
    });
    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toBe(TOO_LARGE);
  });

  test('bounds a stalled chain read, and cancels it', async () => {
    let signal;
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn((_chainId, _contract, options) => {
        signal = options.signal;
        return new Promise(() => {});
      }),
      timeoutMs: 5,
    });
    expect(response.status).toBe(504);
    await expect(response.text()).resolves.toBe('onchain application read timed out');
    expect(signal.aborted).toBe(true);
  });

  // Deviation `web3-cancel`: the read is told, and the handler answers at once.
  test("an aborted navigation cancels the core's read", async () => {
    let signal;
    const controller = new AbortController();
    const pending = handleOnchainAppRequest(request(appUrl(), 'GET', controller.signal), {
      chainHtml: jest.fn((_chainId, _contract, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason));
        });
      }),
    });
    await new Promise(setImmediate);
    expect(signal.aborted).toBe(false);
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(504);
    expect(signal.aborted).toBe(true);
  });

  test('a navigation aborted before the read never starts it', async () => {
    const controller = new AbortController();
    controller.abort();
    const chainHtml = jest.fn(async () => untrusted('<h1>app</h1>'));
    const response = await handleOnchainAppRequest(request(appUrl(), 'GET', controller.signal), {
      chainHtml,
    });
    expect(response.status).toBe(504);
    expect(chainHtml).not.toHaveBeenCalled();
  });
});

describe('failureStatus (design 0006, chain.html, Errors)', () => {
  const core = { code: 'chain_error', kind: 'core' };
  const node = { code: 'chain_error', kind: 'node' };
  test.each([
    ["the core's size error", failed(TOO_LARGE, core, { code: 'ONCHAIN_APP_TOO_LARGE' }), 413],
    // Deviation `web3-413`: only the core's.
    [
      "a node's error with the size code",
      failed('big', node, { code: 'ONCHAIN_APP_TOO_LARGE' }),
      502,
    ],
    ["the core's decode error", failed('html() returned malformed ABI data', core), 502],
    ["a node's revert", failed('execution reverted', node, { code: 3 }), 502],
    ['deadline', failed("The chain request's deadline passed", { code: 'deadline' }), 504],
    ['cancelled', failed('Cancelled', { code: 'cancelled' }), 504],
    ['busy', failed('Too many chain requests', { code: 'busy' }), 503],
    ['budget', failed('Out of memory', { code: 'budget' }), 502],
    ['too_large', failed('Too large', { code: 'too_large' }), 502],
    [
      'a second reconfigured',
      failed("The chain's configuration changed", { code: 'reconfigured' }),
      502,
    ],
    ['an AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' }), 504],
    ['the core unavailable', new Error('Chain data is unavailable'), 502],
    // A size code alone, with nothing to say the core sent it, is no 413.
    [
      'an unmarked size code',
      Object.assign(new Error(TOO_LARGE), { code: 'ONCHAIN_APP_TOO_LARGE' }),
      502,
    ],
  ])('%s', (_label, error, status) => {
    expect(failureStatus(error)).toBe(status);
  });

  test("the handler's own deadline or the page's abort is a 504, whatever the read threw", () => {
    expect(failureStatus(failed(TOO_LARGE, core, { code: 'ONCHAIN_APP_TOO_LARGE' }), true)).toBe(
      504
    );
  });

  test.each([
    ['busy', 503, 'onchain application read is busy; try again shortly'],
    ['deadline', 504, 'onchain application read timed out'],
  ])('%s answers %i', async (code, status, text) => {
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () => {
        throw failed('core text', { code });
      }),
    });
    expect(response.status).toBe(status);
    await expect(response.text()).resolves.toBe(text);
  });
});

describe('captureOnchainProvenance trust gate', () => {
  test('opens only the validated bundled interstitial for a blocked main frame', async () => {
    const html = '<h1>unverified app</h1>';
    const blocked = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () => untrusted(html)),
      trustState: createOnchainAppTrustState({ createToken: () => 'a'.repeat(43) }),
    });
    const contents = {
      isDestroyed: jest.fn(() => false),
      loadURL: jest.fn(() => Promise.resolve()),
    };

    captureOnchainProvenance({
      resourceType: 'mainFrame',
      statusCode: blocked.status,
      url: appUrl(),
      responseHeaders: { [GATE_HEADER]: [blocked.headers.get(GATE_HEADER)] },
      webContents: contents,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(contents.loadURL).toHaveBeenCalledWith(gateUrl(blocked).toString());
  });

  test('ignores a gate header bound to another app URL', async () => {
    const blocked = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () => untrusted('<h1>unverified app</h1>')),
      trustState: createOnchainAppTrustState({ createToken: () => 'a'.repeat(43) }),
    });
    const contents = { loadURL: jest.fn() };

    captureOnchainProvenance({
      resourceType: 'mainFrame',
      statusCode: blocked.status,
      url: appUrl(1, '/another-path'),
      responseHeaders: { [GATE_HEADER]: [blocked.headers.get(GATE_HEADER)] },
      webContents: contents,
    });

    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  test('strips the approval token from a response that is not a navigation', async () => {
    const blocked = await handleOnchainAppRequest(request(appUrl()), {
      chainHtml: jest.fn(async () => untrusted('<h1>unverified app</h1>')),
      trustState: createOnchainAppTrustState({ createToken: () => 'a'.repeat(43) }),
    });
    const contents = { loadURL: jest.fn() };

    const result = captureOnchainProvenance({
      resourceType: 'xhr',
      statusCode: blocked.status,
      url: appUrl(),
      responseHeaders: {
        'Cache-Control': ['no-store'],
        [GATE_HEADER]: [blocked.headers.get(GATE_HEADER)],
      },
      webContents: contents,
    });

    expect(result).toEqual({ responseHeaders: { 'Cache-Control': ['no-store'] } });
    expect(JSON.stringify(result)).not.toContain('a'.repeat(43));
    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  test('leaves unrelated subresource responses untouched', () => {
    expect(
      captureOnchainProvenance({
        resourceType: 'image',
        statusCode: 200,
        url: 'https://example.com/logo.png',
        responseHeaders: { 'Content-Type': ['image/png'] },
      })
    ).toBeNull();
  });
});

describe('guardOnchainAppRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  test('allows a top-level navigation to an onchain app', () => {
    expect(guardOnchainAppRequest({ url: appUrl(), resourceType: 'mainFrame' })).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  // The gate is only meaningful if web content cannot reach it: a page that
  // can fetch the 451 response reads the single-use approval token out of it
  // (no CORS is enforced on custom-scheme responses), replays it, and
  // pre-approves unverified app code for the session with no interstitial.
  test.each(['subFrame', 'xhr', 'image', 'script', 'other', undefined])(
    'cancels a %s request for an onchain app',
    (resourceType) => {
      expect(guardOnchainAppRequest({ url: appUrl(), resourceType })).toEqual({ cancel: true });
    }
  );

  test('cancels a mixed-case web3 URL that is not a navigation', () => {
    expect(
      guardOnchainAppRequest({ url: `WEB3://${ADDRESS}.eip155-1/`, resourceType: 'xhr' })
    ).toEqual({ cancel: true });
  });

  test('ignores requests for every other scheme', () => {
    expect(guardOnchainAppRequest({ url: 'https://example.com/', resourceType: 'xhr' })).toBeNull();
    expect(guardOnchainAppRequest({ url: 'ipfs://cid/x', resourceType: 'subFrame' })).toBeNull();
    expect(guardOnchainAppRequest({})).toBeNull();
  });
});

describe('registerOnchainAppProtocol private sessions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('registers web3 and redacts a private contract URL from logs', async () => {
    const handlers = new Map();
    const targetSession = {
      protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) },
    };
    chainData.chainHtml.mockRejectedValue(new Error('unavailable'));

    registerOnchainAppProtocol(targetSession, { privatePartition: 'private-test' });
    await handlers.get('web3')(request(appUrl(1, '/private/path')));

    const logged = [log.info, log.warn, log.error]
      .flatMap((fn) => fn.mock.calls)
      .map((call) => call.join(' '))
      .join('\n');
    expect(logged).not.toContain(ADDRESS.toLowerCase());
    expect(logged).not.toContain('private/path');
    expect(logged).toContain('web3://<private>');
  });
});

describe('onchain-app-guard registration', () => {
  // docs/security-audit-electron.md E-6: the guard is the only thing between
  // a page's background fetch and the web3 approval token, so a throw inside
  // it must cancel the request rather than let the dispatcher skip it.
  test('registers the frame guard fail-closed', () => {
    jest.isolateModules(() => {
      jest.doMock('../webrequest-dispatcher', () => ({ registerWebRequestHandler: jest.fn() }));
      const dispatcher = require('../webrequest-dispatcher');
      const fresh = require('./onchain-app-protocol');
      fresh.installOnchainProvenanceCapture();
      expect(dispatcher.registerWebRequestHandler).toHaveBeenCalledWith(
        'onBeforeRequest',
        'onchain-app-guard',
        fresh.guardOnchainAppRequest,
        { failClosed: true }
      );
    });
  });
});
