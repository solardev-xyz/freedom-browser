/**
 * The nodes panel's count of verification failures (freedom-core design
 * 0009, Failures): per backend, for 10 minutes from the last failure.
 */
const {
  noteVerificationFailure,
  verificationFailures,
  isVerificationFailure,
  FAILURE_WINDOW_MS,
  VERIFICATION_FAILED,
  _resetVerificationFailures,
} = require('./verify-failures');

const ANT = 'http://127.0.0.1:1633';
const OTHER_ANT = 'http://192.0.2.7:1633';
const GATEWAY = 'http://127.0.0.1:8080';
const OTHER_GATEWAY = 'https://gateway.example';
const MINUTE = 60 * 1000;

const ant = (url = ANT, ref = {}) => ({
  ref: { ant: 'external', up: true, verify: true, ...ref },
  url,
});
const gateway = (url = GATEWAY, ref = {}) => ({
  ref: { ipfs: 'gateway', up: true, verify: true, ...ref },
  url,
});

beforeEach(() => {
  jest.useFakeTimers();
  _resetVerificationFailures();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the count', () => {
  test('per backend: the external Ant and the external gateway each count their own', () => {
    expect(verificationFailures('ant', ANT)).toBe(0);
    expect(verificationFailures('gateway', GATEWAY)).toBe(0);

    noteVerificationFailure(ant());
    noteVerificationFailure(ant());
    noteVerificationFailure(gateway());
    expect(verificationFailures('ant', ANT)).toBe(2);
    expect(verificationFailures('gateway', GATEWAY)).toBe(1);
  });

  test('a reused Ant counts as external, as antBackend() reports it', () => {
    noteVerificationFailure(ant(ANT, { ant: 'reused' }));
    expect(verificationFailures('ant', ANT)).toBe(1);
  });

  test("another endpoint's failures are never shown against the node serving now", () => {
    noteVerificationFailure(ant(ANT));
    // The profile moved to another Ant: its record says nothing about it,
    // and reading it doesn't drop the first node's.
    expect(verificationFailures('ant', OTHER_ANT)).toBe(0);
    expect(verificationFailures('ant', ANT)).toBe(1);
    // A request captured before the switch that fails after it: still the
    // old node's.
    noteVerificationFailure(gateway(OTHER_GATEWAY));
    expect(verificationFailures('gateway', GATEWAY)).toBe(0);
    expect(verificationFailures('gateway', OTHER_GATEWAY)).toBe(1);

    // The new node's own failure starts its record, beside the first's.
    noteVerificationFailure(ant(OTHER_ANT));
    expect(verificationFailures('ant', OTHER_ANT)).toBe(1);
    expect(verificationFailures('ant', ANT)).toBe(1);
  });

  test("a late failure of the node a request captured before a switch leaves the new node's count", () => {
    noteVerificationFailure(gateway(GATEWAY));
    // The profile moved to another gateway, which failed too.
    noteVerificationFailure(gateway(OTHER_GATEWAY));
    noteVerificationFailure(gateway(OTHER_GATEWAY));
    // A request still on the first one fails after the switch.
    noteVerificationFailure(gateway(GATEWAY));
    expect(verificationFailures('gateway', OTHER_GATEWAY)).toBe(2);
    expect(verificationFailures('gateway', GATEWAY)).toBe(2);
  });

  test("the kinds don't share a record, even at one address", () => {
    noteVerificationFailure(ant(GATEWAY));
    expect(verificationFailures('gateway', GATEWAY)).toBe(0);
    expect(verificationFailures('ant', GATEWAY)).toBe(1);
    expect(verificationFailures('native', GATEWAY)).toBe(0);
  });

  test('no endpoint serving: nothing', () => {
    noteVerificationFailure(ant());
    expect(verificationFailures('ant', null)).toBe(0);
    expect(verificationFailures('ant', '')).toBe(0);
  });

  test.each([
    ['the bundled Ant', { ref: { ant: 'bundled', up: true }, url: ANT }],
    ['the native IPFS node', { ref: { ipfs: 'native', up: true }, url: null }],
    ['a gateway without raw blocks', gateway(GATEWAY, { verify: undefined, unsupported: true })],
    ['an Ant whose verification is off', ant(ANT, { verify: undefined })],
    ['a backend with no endpoint', ant(null)],
    ['no backend', null],
    ['an unknown reference', { ref: { radicle: 'embedded', verify: true }, url: ANT }],
  ])('%s is never counted', (_what, backend) => {
    noteVerificationFailure(backend);
    expect(verificationFailures('ant', ANT)).toBe(0);
    expect(verificationFailures('gateway', GATEWAY)).toBe(0);
  });
});

describe('the window: 10 minutes from the last failure', () => {
  test('shown until 10 minutes after the last failure, then gone', () => {
    noteVerificationFailure(gateway());
    jest.advanceTimersByTime(FAILURE_WINDOW_MS - 1);
    expect(verificationFailures('gateway', GATEWAY)).toBe(1);
    jest.advanceTimersByTime(1);
    expect(verificationFailures('gateway', GATEWAY)).toBe(0);
  });

  test('each failure restarts it, and the count runs on while it lasts', () => {
    noteVerificationFailure(ant());
    jest.advanceTimersByTime(9 * MINUTE);
    noteVerificationFailure(ant());
    // 18 minutes after the first, 9 after the last.
    jest.advanceTimersByTime(9 * MINUTE);
    expect(verificationFailures('ant', ANT)).toBe(2);
    jest.advanceTimersByTime(MINUTE);
    expect(verificationFailures('ant', ANT)).toBe(0);
  });

  test('a failure after the window has passed starts the count again at 1', () => {
    noteVerificationFailure(ant());
    noteVerificationFailure(ant());
    noteVerificationFailure(ant());
    jest.advanceTimersByTime(FAILURE_WINDOW_MS);
    // Not read in between: the stale record is dropped by the write.
    noteVerificationFailure(ant());
    expect(verificationFailures('ant', ANT)).toBe(1);
  });

  test('the backends keep their own windows', () => {
    noteVerificationFailure(ant());
    jest.advanceTimersByTime(5 * MINUTE);
    noteVerificationFailure(gateway());
    jest.advanceTimersByTime(5 * MINUTE);
    expect(verificationFailures('ant', ANT)).toBe(0);
    expect(verificationFailures('gateway', GATEWAY)).toBe(1);
  });

  test('a change of the wall clock neither stretches nor cuts it (the monotonic clock)', () => {
    noteVerificationFailure(gateway());
    jest.setSystemTime(Date.now() + 60 * MINUTE);
    expect(verificationFailures('gateway', GATEWAY)).toBe(1);
    jest.setSystemTime(Date.now() - 120 * MINUTE);
    jest.advanceTimersByTime(FAILURE_WINDOW_MS);
    expect(verificationFailures('gateway', GATEWAY)).toBe(0);
  });

  test('it sets no timer: nothing runs while no one reads it', () => {
    noteVerificationFailure(ant());
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("which of dweb.verify's error plans is a failed check", () => {
  const SWARM = VERIFICATION_FAILED.ant;
  const IPFS = VERIFICATION_FAILED.ipfs;

  test("the 502 with the plan's node's fixed text", () => {
    expect(SWARM).toBe('Swarm content verification failed');
    expect(IPFS).toBe('IPFS content verification failed');
    expect(isVerificationFailure('ant', { status: 502, code: 502, message: SWARM })).toBe(true);
    expect(isVerificationFailure('ipfs', { status: 502, code: 502, message: IPFS })).toBe(true);
  });

  test.each([
    ["the other node's text", 'ant', 502, IPFS],
    ["the other node's text (IPFS)", 'ipfs', 502, SWARM],
    ['another status', 'ant', 500, SWARM],
    ['unverifiable', 'ant', 502, "This content can't be verified with the external Swarm node"],
    [
      'unverifiable (IPFS)',
      'ipfs',
      502,
      "This content can't be verified with the external IPFS gateway",
    ],
    [
      'the memory limit',
      'ipfs',
      502,
      'This content needs more memory to verify than one request may use',
    ],
    ['malformed', 'ipfs', 502, 'This IPFS content is malformed'],
    ['not found', 'ant', 404, 'Not found on the external Swarm node'],
    ["the node's own status", 'ipfs', 500, 'The external IPFS gateway answered 500'],
    ['the node stopped sending', 'ant', 502, 'The external Swarm node stopped sending'],
    ['a dial that failed', 'ant', 503, 'bee gateway unreachable'],
    ['busy', 'ant', 503, 'Too many requests'],
    ['the deadline', 'ipfs', 504, 'Deadline passed'],
    ['a text with more around it', 'ant', 502, `${SWARM}.`],
    ['an unknown node', 'radicle', 502, SWARM],
  ])('not %s', (_what, node, status, message) => {
    expect(isVerificationFailure(node, { status, code: status, message })).toBe(false);
  });

  test('not a missing or malformed error', () => {
    expect(isVerificationFailure('ant', null)).toBe(false);
    expect(isVerificationFailure('ant', undefined)).toBe(false);
    expect(isVerificationFailure('ant', { status: '502', message: SWARM })).toBe(false);
  });
});
