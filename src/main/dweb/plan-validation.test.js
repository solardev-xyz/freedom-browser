/**
 * Validation before any dial (freedom-core design 0006). These cases run
 * everywhere; `dweb-vectors.test.js` runs fc-dweb's whole `validation` set
 * (vectors/dweb.json) against the same function when the vectors are found.
 */

const { validatePlan, urlScheme, normalizeTarget } = require('./plan-validation');

const HASH = 'c0ffee'.repeat(10) + 'beef';
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const ANT = { ant: 'bundled', up: true };
const NATIVE = { ipfs: 'native', up: true };
const GATEWAY = { ipfs: 'gateway', up: true };

const SWARM = [
  ['swarm-chunk-retrieval-timeout', '30s'],
  ['swarm-redundancy-fallback-mode', 'true'],
  ['swarm-redundancy-strategy', '3'],
];

function antPlan(overrides = {}) {
  return {
    fetch: {
      node: 'ant',
      path: `/bzz/${HASH}/index.html`,
      headers: [['accept', '*/*'], ...SWARM],
      retry: {
        statuses: [500, 502, 503, 504],
        on_error: true,
        attempts: 10,
        delays_ms: [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000],
      },
      timers: { queue_ms: null, headers_ms: 30000, body_idle_ms: 60000 },
      response: ['canonicalize_redirect', 'strip_page_state'],
      trust: { name: null, content: 'node_asserted' },
      ...overrides,
    },
  };
}

function ipfsPlan(backend, overrides = {}) {
  const native = backend.ipfs === 'native';
  return {
    fetch: {
      node: 'ipfs',
      path: `/ipfs/${CID}/`,
      headers: [['accept', 'text/html']],
      retry: { statuses: [], on_error: false, attempts: 1, delays_ms: [] },
      timers: native
        ? { queue_ms: 15000, headers_ms: 30000, body_idle_ms: 60000 }
        : { queue_ms: null, headers_ms: null, body_idle_ms: 60000 },
      response: native
        ? ['strip_page_state', 'small_text']
        : ['strip_decoded_encoding', 'strip_page_state', 'canonicalize_redirect'],
      trust: { name: 'verified', content: native ? 'node_asserted' : 'unverified' },
      ...overrides,
    },
  };
}

const bzzRequest = (overrides = {}) => ({
  url: `bzz://${HASH}/index.html`,
  method: 'GET',
  backend: ANT,
  ...overrides,
});
const ipfsRequest = (overrides = {}) => ({
  url: `ipfs://${CID}/`,
  method: 'GET',
  backend: NATIVE,
  ...overrides,
});

describe("the core's plans as main receives them", () => {
  test.each([
    ['an Ant fetch', antPlan(), bzzRequest()],
    ['an encrypted reference', antPlan({ path: `/bzz/${HASH}${HASH}/` }), bzzRequest()],
    ['a native fetch', ipfsPlan(NATIVE), ipfsRequest()],
    ['a gateway fetch', ipfsPlan(GATEWAY), ipfsRequest({ backend: GATEWAY })],
    [
      'an IPNS fetch',
      ipfsPlan(NATIVE, { path: '/ipns/docs.ipfs.tech/install' }),
      ipfsRequest({ url: 'ipns://docs.ipfs.tech/install' }),
    ],
    // An encoded separator that doesn't climb passes to the IPFS node, as today.
    ['a file name with %2F', ipfsPlan(NATIVE, { path: `/ipfs/${CID}/a%2Fb` }), ipfsRequest()],
    ['a HEAD', antPlan(), bzzRequest({ method: 'head' })],
    ['an empty method, read as GET', antPlan(), bzzRequest({ method: '' })],
  ])('passes %s', (_label, plan, request) => {
    expect(validatePlan(plan, request)).toBeNull();
  });

  test('passes a gateway-form redirect to exactly its canonical form, with any backend', () => {
    const url = 'ipfs://localhost/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a?x=1';
    const plan = {
      redirect: {
        status: 307,
        location: 'ipfs://bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34/a?x=1',
        headers: [['access-control-allow-origin', '*']],
      },
    };
    expect(
      validatePlan(plan, ipfsRequest({ url, backend: { ipfs: 'native', up: false } }))
    ).toBeNull();
  });

  test.each([400, 404, 405, 415, 502, 503])('passes an error plan with status %i', (status) => {
    const plan = { error: { status, code: status, message: 'x'.repeat(131_072) } };
    expect(validatePlan(plan, bzzRequest({ backend: { ant: 'external', up: false } }))).toBeNull();
  });
});

// Each refusal is named by the first check the plan fails.
describe('refusals before any dial', () => {
  test.each([
    ['not an object', null],
    ['two variants', { ...antPlan(), error: { status: 404, code: 404, message: '' } }],
    ['an unknown variant', { stream: {} }],
    ['an extra field', antPlan({ url: 'http://evil.example/' })],
    ['a missing field', { fetch: { ...antPlan().fetch, trust: undefined } }],
    ['headers that are not pairs', antPlan({ headers: [['accept']] })],
    ['a numeric path', antPlan({ path: 1 })],
  ])('shape: %s', (_label, plan) => {
    expect(validatePlan(plan, bzzRequest())).toBe('shape');
  });

  test('method: only GET and HEAD are dialled', () => {
    expect(validatePlan(antPlan(), bzzRequest({ method: 'POST' }))).toBe('method');
  });

  test.each([
    ['a backend that is not up', antPlan(), bzzRequest({ backend: { ant: 'bundled', up: false } })],
    ["another scheme's node", ipfsPlan(NATIVE), bzzRequest({ backend: NATIVE })],
    ['the IPFS node for bzz:', { fetch: { ...antPlan().fetch, node: 'ipfs' } }, bzzRequest()],
    [
      'a URL instead of a reference',
      { fetch: { ...antPlan().fetch, node: 'http://127.0.0.1:1633' } },
      bzzRequest(),
    ],
  ])('node: %s', (_label, plan, request) => {
    expect(validatePlan(plan, request)).toBe('node');
  });

  // Deviation `plan-paths`: targets today's handlers would dial.
  test.each([
    ['a relative base path glued onto the reference', `/bzz/${HASH}docs/page`],
    ['a climbing base path', `/bzz/${HASH}/../stamps`],
    ['a resolver `decoded` that is not a reference', '/bzz/stamps/1/17'],
    ['an encoded separator in a published base path', `/bzz/${HASH}/a%2Fb/x`],
    ['an encoded backslash', `/bzz/${HASH}/a%5cb`],
    ['literal backslash dot segments', `/bzz/${HASH}/a/..\\..\\..\\stamps`],
    ['an authority', `//evil.example/bzz/${HASH}/`],
    ['a fragment', `/bzz/${HASH}/#x`],
    ['no leading slash', `bzz/${HASH}/`],
  ])('path (bzz:): %s', (_label, path) => {
    expect(validatePlan(antPlan({ path }), bzzRequest())).toBe('path');
  });

  test.each([
    ['another namespace', '/ipns/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8/'],
    ['a resolver `decoded` of `../ipns/…`', `/ipfs/../ipns/${CID}/`],
    ['`..%2F` climbing out once decoded', `/ipfs/${CID}/..%2F..%2Fipns/x`],
    ['`%2E%2E%2F`', `/ipfs/${CID}/%2E%2E%2Fx`],
    ['`%2e%2e%5c` in any case', `/ipfs/${CID}/%2e%2e%5cx`],
    // Refused even when the result would stay beneath the reference.
    ['a dot segment formed by escapes beneath the reference', `/ipfs/${CID}/a%2F..%2Fb`],
    ['literal backslash dot segments', `/ipfs/${CID}/a/..\\..\\..\\ipns\\x`],
    ['a reference with a colon', '/ipfs/a:b/'],
    ['no reference', '/ipfs/'],
  ])('path (ipfs:): %s', (_label, path) => {
    expect(validatePlan(ipfsPlan(NATIVE, { path }), ipfsRequest())).toBe('path');
  });

  test('path: the query is not judged', () => {
    const path = `/ipfs/${CID}/?a=%2E%2E%2F..%2F`;
    expect(normalizeTarget(path)).toBe(path);
    expect(validatePlan(ipfsPlan(NATIVE, { path }), ipfsRequest())).toBeNull();
  });

  // Deviation `plan-headers`: RFC 9110 field values only.
  test.each([
    ['a vertical tab', [['accept', 'text/html\u000bx'], ...SWARM]],
    ['CR LF', [['accept', 'a\r\nx-injected: 1'], ...SWARM]],
    ['NUL', [['accept', 'a\u0000'], ...SWARM]],
    ['DEL', [['accept', 'a\u007f'], ...SWARM]],
    ['a leading space', [['accept', ' text/html'], ...SWARM]],
    ['a trailing tab', [['accept', 'text/html\t'], ...SWARM]],
    ['a code unit past 0xFF', [['accept', 'text/Ā'], ...SWARM]],
    ['an uppercase name', [['Accept', '*/*'], ...SWARM]],
    ['a name with a space', [['x y', '1'], ...SWARM]],
    ['a header off the allowlist', [['cookie', 'a=1'], ...SWARM]],
    ['a node-authority header', [['swarm-postage-batch-id', 'ff'], ...SWARM]],
    ['a Swarm header missing', SWARM.slice(1)],
    ['a Swarm header changed', [['swarm-chunk-retrieval-timeout', '999h'], ...SWARM.slice(1)]],
    ['a Swarm header repeated', [...SWARM, SWARM[0]]],
  ])('header (bzz:): %s', (_label, headers) => {
    expect(validatePlan(antPlan({ headers }), bzzRequest())).toBe('header');
  });

  test('header (ipfs:): nothing on the strip-list', () => {
    for (const name of ['cookie', 'authorization', 'origin', 'referer', 'host', 'te']) {
      const plan = ipfsPlan(NATIVE, { headers: [[name, 'x']] });
      expect([name, validatePlan(plan, ipfsRequest())]).toEqual([name, 'header']);
    }
    const custom = ipfsPlan(NATIVE, {
      headers: [
        ['x-custom', '1'],
        ['swarm-act', 'true'],
      ],
    });
    expect(validatePlan(custom, ipfsRequest())).toBeNull();
  });

  test.each([
    ['eleven attempts', { attempts: 11, delays_ms: Array(10).fill(500) }],
    ['a delay past 15 s', { delays_ms: [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15001] }],
    ['a delay per retry, not fewer', { delays_ms: [500] }],
    ['a status past the table', { statuses: [500, 404] }],
    ['a repeated status', { statuses: [500, 500] }],
    ['a fractional attempt count', { attempts: 9.5 }],
  ])('retry (bzz:): %s', (_label, retry) => {
    const plan = antPlan({ retry: { ...antPlan().fetch.retry, ...retry } });
    expect(validatePlan(plan, bzzRequest())).toBe('retry');
  });

  test('retry (ipfs:): IPFS has no retry', () => {
    const retry = { statuses: [503], on_error: false, attempts: 1, delays_ms: [] };
    expect(validatePlan(ipfsPlan(NATIVE, { retry }), ipfsRequest())).toBe('retry');
    const onError = { statuses: [], on_error: true, attempts: 1, delays_ms: [] };
    expect(
      validatePlan(ipfsPlan(GATEWAY, { retry: onError }), ipfsRequest({ backend: GATEWAY }))
    ).toBe('retry');
  });

  test.each([
    ['no header deadline for Ant', { queue_ms: null, headers_ms: null, body_idle_ms: 60000 }],
    ['an unbounded body', { queue_ms: null, headers_ms: 30000, body_idle_ms: null }],
    ['a body idle past 60 s', { queue_ms: null, headers_ms: 30000, body_idle_ms: 60001 }],
    ['a zero body idle', { queue_ms: null, headers_ms: 30000, body_idle_ms: 0 }],
    ['headers past 30 s', { queue_ms: null, headers_ms: 30001, body_idle_ms: 60000 }],
    ['a queue past 15 s', { queue_ms: 15001, headers_ms: 30000, body_idle_ms: 60000 }],
  ])('timers: %s', (_label, timers) => {
    expect(validatePlan(antPlan({ timers }), bzzRequest())).toBe('timers');
  });

  test('timers: only the external gateway may leave the headers unbounded', () => {
    const timers = { queue_ms: null, headers_ms: null, body_idle_ms: 60000 };
    expect(validatePlan(ipfsPlan(NATIVE, { timers }), ipfsRequest())).toBe('timers');
    expect(
      validatePlan(ipfsPlan(GATEWAY, { timers }), ipfsRequest({ backend: GATEWAY }))
    ).toBeNull();
  });

  test.each([
    ['an unknown operation', ['strip_everything']],
    ['a repeated operation', ['strip_page_state', 'strip_page_state']],
    ['small text from Ant', ['small_text']],
    ['decoded-encoding stripping from Ant', ['strip_decoded_encoding']],
  ])('response: %s', (_label, response) => {
    expect(validatePlan(antPlan({ response }), bzzRequest())).toBe('response');
  });

  test('response: the native node never canonicalizes a redirect', () => {
    const plan = ipfsPlan(NATIVE, { response: ['canonicalize_redirect'] });
    expect(validatePlan(plan, ipfsRequest())).toBe('response');
  });

  test("trust: the content label is the backend's", () => {
    const plan = antPlan({ trust: { name: null, content: 'node_asserted' } });
    const external = { ant: 'external', up: true };
    expect(validatePlan(plan, bzzRequest({ backend: external }))).toBe('trust');
    expect(
      validatePlan(antPlan({ trust: { name: 1, content: 'node_asserted' } }), bzzRequest())
    ).toBe('trust');
  });

  test.each([
    ['for bzz:', bzzRequest({ url: `bzz://${HASH}/` }), 307, 'ipfs://x/'],
    ['for a URL that is not gateway-form', ipfsRequest(), 307, `ipfs://${CID}/`],
    [
      'to another location',
      ipfsRequest({ url: `ipfs://localhost/ipfs/${CID}/` }),
      307,
      'https://evil.example/',
    ],
    [
      'with another status',
      ipfsRequest({ url: `ipfs://localhost/ipfs/${CID}/` }),
      302,
      `ipfs://${CID}/`,
    ],
  ])('redirect: %s', (_label, request, status, location) => {
    const plan = {
      redirect: { status, location, headers: [['access-control-allow-origin', '*']] },
    };
    expect(validatePlan(plan, request)).toBe('redirect');
  });

  test('redirect: no header but Access-Control-Allow-Origin', () => {
    const plan = {
      redirect: {
        status: 307,
        location: `ipfs://${CID}/`,
        headers: [
          ['access-control-allow-origin', '*'],
          ['set-cookie', 'a=1'],
        ],
      },
    };
    expect(validatePlan(plan, ipfsRequest({ url: `ipfs://localhost/ipfs/${CID}/` }))).toBe(
      'redirect'
    );
  });

  test.each([
    ["a status that is not today's", { status: 500, code: 500, message: '' }],
    ['a code that is not the status', { status: 404, code: 400, message: '' }],
    ['a string status', { status: '404', code: '404', message: '' }],
    [
      'a message past twice the URL bound',
      { status: 404, code: 404, message: 'x'.repeat(131_073) },
    ],
    ['a message that is not a string', { status: 404, code: 404, message: null }],
  ])('error: %s', (_label, error) => {
    expect(validatePlan({ error }, bzzRequest())).toBe('error');
  });
});

describe('urlScheme', () => {
  test('reads the scheme as the URL parser does', () => {
    expect(urlScheme(' \tBzZ://x')).toBe('bzz');
    expect(urlScheme('ip\nfs://x')).toBe('ipfs');
    expect(urlScheme('1bzz://x')).toBeNull();
    expect(urlScheme('no-colon')).toBeNull();
  });
});
