/**
 * Strict mode (freedom-core design 0009, "Strict mode"): the setting main
 * reads at capture, main's copy of the core's composition (a 403 with its
 * cause's fixed message wherever content would be `unverified`), and the
 * two checks validation changes against a strict backend. These cases run
 * everywhere; `verify-plan-vectors.test.js` runs fc-dweb's strict vectors
 * against the same code when the vectors are found.
 */

let mockSettings = {};
jest.mock('../settings-store', () => ({ loadSettings: () => mockSettings }));

const { loadsOnlyVerifiedContent, STRICT_MODE_SETTING } = require('./strict-mode');
const { openDweb } = require('./dweb-open');
const { validatePlan } = require('./plan-validation');
const {
  composeVerify,
  STRICT_MESSAGE,
  STRICT_MESSAGES,
  STRICT_STATUS,
  VERIFY_BOUND_ERRORS,
} = require('./verify-plan');

const HASH = 'c0ffee'.repeat(10) + 'beef';
const ENCRYPTED = HASH + 'a1b2'.repeat(16);
const CID = 'bafybeidon73zkcrwdb5iafqtijxildoonbwnpv7dyd6ef3qdgads2jc4su';
// IPNS names: an inlined Ed25519 key (verified), a sha2-256 multihash (an
// RSA key: verified too, decision 9), a secp256k1 peer ID (its key type
// can't be verified), and a DNSLink name.
const ED25519_NAME = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const RSA_NAME = 'k2k4r8np1qb2z0j9bg52w5u13cdwss35fmh5lbs2wo48be1b8d86b6i3';
const SECP256K1_PEER = '16Uiu2HAmSWMwdVs6WACXRjGWiBRqkfBV1tFnL4yhAxscizU2PeRA';
const DNSLINK = 'docs.example.org';

const ANT_VERIFIED = { ant: 'external', up: true, verify: true };
const ANT_OFF = { ant: 'external', up: true };
const GATEWAY_VERIFIED = { ipfs: 'gateway', up: true, verify: true };
const GATEWAY_UNSUPPORTED = { ipfs: 'gateway', up: true, unsupported: true };
const GATEWAY_OFF = { ipfs: 'gateway', up: true };
const strict = (backend) => ({ ...backend, strict: true });

const request = (url, backend, headers = []) => ({ url, method: 'GET', headers, backend });
const refused = (cause) => ({
  error: { status: 403, code: 403, message: STRICT_MESSAGE[cause] },
});

describe('the setting', () => {
  beforeEach(() => {
    mockSettings = {};
  });

  test('off by default, on only for `true`', () => {
    expect(STRICT_MODE_SETTING).toBe('loadOnlyVerifiedContent');
    expect(loadsOnlyVerifiedContent()).toBe(false);
    for (const value of [false, 'true', 1, null, {}]) {
      mockSettings = { loadOnlyVerifiedContent: value };
      expect(loadsOnlyVerifiedContent()).toBe(false);
    }
    mockSettings = { loadOnlyVerifiedContent: true };
    expect(loadsOnlyVerifiedContent()).toBe(true);
  });
});

describe("strict mode's plans", () => {
  test('the five messages, fixed, in the order 0009 gives them, with a 403', () => {
    expect(STRICT_STATUS).toBe(403);
    expect(STRICT_MESSAGES).toEqual([
      'This profile loads only verified content, and verification is off for this node',
      "This profile loads only verified content, and this gateway doesn't serve verifiable responses",
      "This profile loads only verified content, and a DNSLink name can't be verified",
      "This profile loads only verified content, and this IPNS name's key type can't be verified",
      "This profile loads only verified content, and an encrypted Swarm reference can't be verified with an external node",
    ]);
    expect(Object.values(STRICT_MESSAGE)).toEqual(STRICT_MESSAGES);
  });

  test('each unverified cause is its 403, before anything is fetched', () => {
    for (const [url, backend, cause] of [
      [`bzz://${HASH}/`, strict(ANT_OFF), 'off'],
      [`ipfs://${CID}/a`, strict(GATEWAY_OFF), 'off'],
      [`ipfs://${CID}/a`, strict(GATEWAY_UNSUPPORTED), 'unsupported'],
      [`ipns://${DNSLINK}/`, strict(GATEWAY_VERIFIED), 'dnslink'],
      [`ipns://${SECP256K1_PEER}/`, strict(GATEWAY_VERIFIED), 'key'],
      [`bzz://${ENCRYPTED}/x`, strict(ANT_VERIFIED), 'encrypted'],
    ]) {
      const req = request(url, backend);
      const plan = openDweb(req);
      expect([url, plan]).toEqual([url, refused(cause)]);
      expect(validatePlan(plan, req)).toBeNull();
      // Without strict mode, the same request is today's fetch.
      const { strict: _strict, ...lenient } = backend;
      expect(openDweb(request(url, lenient)).fetch).toBeDefined();
    }
  });

  test("the backend's cause comes first: verification off, then a gateway without raw blocks", () => {
    // Verification off: an encrypted reference or a DNSLink name says why
    // the node isn't verifying, not why its target couldn't be.
    expect(openDweb(request(`bzz://${ENCRYPTED}/`, strict(ANT_OFF)))).toEqual(refused('off'));
    expect(openDweb(request(`ipns://${DNSLINK}/`, strict(GATEWAY_OFF)))).toEqual(refused('off'));
    expect(openDweb(request(`ipns://${DNSLINK}/`, strict(GATEWAY_UNSUPPORTED)))).toEqual(
      refused('unsupported')
    );
    expect(openDweb(request(`ipns://${SECP256K1_PEER}/`, strict(GATEWAY_UNSUPPORTED)))).toEqual(
      refused('unsupported')
    );
  });

  test('verified and RSA-keyed content still loads: the verify plan, unchanged', () => {
    for (const [url, backend] of [
      [`bzz://${HASH}/a?x=1`, ANT_VERIFIED],
      [`ipfs://${CID}/a`, GATEWAY_VERIFIED],
      [`ipns://${ED25519_NAME}/`, GATEWAY_VERIFIED],
      [`ipns://${RSA_NAME}/`, GATEWAY_VERIFIED],
    ]) {
      const req = request(url, strict(backend));
      const plan = openDweb(req);
      expect(plan.verify).toBeDefined();
      expect(plan).toEqual(openDweb(request(url, backend)));
      expect(validatePlan(plan, req)).toBeNull();
    }
  });

  test("past the verifier's bound, strict mode keeps the 414 and the 431", () => {
    const path = `/${'p'.repeat(8192)}`;
    const long = request(`ipfs://${CID}${path}`, strict(GATEWAY_VERIFIED));
    expect(openDweb(long)).toEqual({ error: VERIFY_BOUND_ERRORS.url });
    expect(validatePlan(openDweb(long), long)).toBeNull();
    const header = request(`bzz://${HASH}/a`, strict(ANT_VERIFIED), [
      ['Range', `bytes=${'0'.repeat(8190)}-`],
    ]);
    expect(openDweb(header)).toEqual({ error: VERIFY_BOUND_ERRORS.header });
    expect(validatePlan(openDweb(header), header)).toBeNull();
    // An encrypted reference has no verify plan to bound: its 403.
    const encrypted = request(`bzz://${ENCRYPTED}${path}`, strict(ANT_VERIFIED));
    expect(openDweb(encrypted)).toEqual(refused('encrypted'));
  });

  test('redirects, error plans and a node that is down are as without strict mode', () => {
    for (const [url, backend] of [
      // A node that isn't up: its 503.
      [`bzz://${HASH}/`, { ...strict(ANT_OFF), up: false }],
      [`ipfs://${CID}/`, { ...strict(GATEWAY_VERIFIED), up: false }],
      // A gateway-form URL's 307, and an invalid reference's 400.
      [`ipfs://localhost/ipfs/${CID}/a`, strict(GATEWAY_OFF)],
      ['bzz://zz/', strict(ANT_VERIFIED)],
    ]) {
      const { strict: _strict, ...lenient } = backend;
      const plan = openDweb(request(url, backend));
      expect(plan.fetch).toBeUndefined();
      expect(plan).toEqual(openDweb(request(url, lenient)));
      expect(plan.error?.status).not.toBe(403);
    }
  });

  test("a name's result: verified, or refused with its target's cause", () => {
    const named = (path) => ({
      fetch: {
        node: 'ipfs',
        path,
        headers: [],
        retry: { statuses: [], on_error: false, attempts: 1, delays_ms: [] },
        timers: { queue_ms: null, headers_ms: null, body_idle_ms: 60000 },
        response: ['strip_decoded_encoding', 'strip_page_state', 'canonicalize_redirect'],
        trust: { name: 'verified', content: 'unverified' },
      },
    });
    const backend = strict(GATEWAY_VERIFIED);
    expect(composeVerify(named(`/ipfs/${CID}/`), backend, false).verify.trust).toEqual({
      name: 'verified',
      content: 'verified',
    });
    expect(composeVerify(named(`/ipns/${DNSLINK}/`), backend, false)).toEqual(refused('dnslink'));
    // A plan that isn't a fetch passes as it is.
    const redirect = { redirect: { status: 307, location: 'ipfs://x', headers: [] } };
    expect(composeVerify(redirect, backend, false)).toBe(redirect);
  });
});

describe("strict mode's checks", () => {
  // The fetch a request plans without strict mode, which a strict backend
  // must never get.
  const lenientFetch = (url, backend) => {
    const { strict: _strict, ...lenient } = backend;
    const plan = openDweb(request(url, lenient));
    expect(plan.fetch).toBeDefined();
    return plan;
  };

  test('a strict backend never gets a fetch: refused at `trust`, after the other checks', () => {
    for (const [url, backend] of [
      [`bzz://${HASH}/`, strict(ANT_OFF)],
      [`ipfs://${CID}/`, strict(GATEWAY_UNSUPPORTED)],
      [`bzz://${ENCRYPTED}/`, strict(ANT_VERIFIED)],
      [`ipns://${DNSLINK}/`, strict(GATEWAY_VERIFIED)],
    ]) {
      const plan = lenientFetch(url, backend);
      const { strict: _strict, ...lenient } = backend;
      expect(validatePlan(plan, request(url, lenient))).toBeNull();
      expect(validatePlan(plan, request(url, backend))).toBe('trust');
    }
    // The fetch's own checks come first: a target that isn't the request's
    // is still `path`, judged against the request planned without strict
    // mode (its target is the same either way).
    const req = request(`bzz://${HASH}/`, strict(ANT_OFF));
    const moved = lenientFetch(`bzz://${'ab'.repeat(32)}/`, ANT_OFF);
    expect(validatePlan(moved, req)).toBe('path');
    // A name's result, too.
    const name = request('bzz://site.eth/', strict(ANT_OFF));
    const result = lenientFetch(`bzz://${HASH}/`, ANT_OFF);
    result.fetch.trust = { name: 'verified', content: 'unverified' };
    expect(validatePlan(result, request('bzz://site.eth/', ANT_OFF))).toBeNull();
    expect(validatePlan(result, name)).toBe('trust');
  });

  test('a 403 only against a strict backend, and only in one of its words', () => {
    const strictReq = request(`ipns://${DNSLINK}/`, strict(GATEWAY_VERIFIED));
    for (const message of STRICT_MESSAGES) {
      const plan = { error: { status: 403, code: 403, message } };
      // Any of the five: validation can't judge which cause applies.
      expect(validatePlan(plan, strictReq)).toBeNull();
      for (const backend of [GATEWAY_VERIFIED, GATEWAY_OFF, GATEWAY_UNSUPPORTED]) {
        expect(validatePlan(plan, request(`ipns://${DNSLINK}/`, backend))).toBe('error');
      }
      expect(validatePlan(plan, request(`bzz://${HASH}/`, { ant: 'bundled', up: true }))).toBe(
        'error'
      );
      expect(validatePlan({ error: { ...plan.error, code: 400 } }, strictReq)).toBe('error');
      expect(validatePlan({ error: { ...plan.error, message: `${message}.` } }, strictReq)).toBe(
        'error'
      );
    }
    for (const message of ['Forbidden', VERIFY_BOUND_ERRORS.url.message, '', 403]) {
      expect(validatePlan({ error: { status: 403, code: 403, message } }, strictReq)).toBe('error');
    }
    // Strict mode's words under another status are no 403.
    const off = STRICT_MESSAGE.off;
    expect(validatePlan({ error: { status: 400, code: 400, message: off } }, strictReq)).toBeNull();
    expect(validatePlan({ error: { status: 414, code: 414, message: off } }, strictReq)).toBe(
      'error'
    );
  });
});
