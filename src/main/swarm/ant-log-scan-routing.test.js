// Ant's eth_getLogs scan through the real chain-data router, as a matrix:
// tier (myotis / colibri / quorum k-of-n / direct untried / direct widened
// retry) x error class (range limit / timeout reply / endpoint-dependent /
// hang / success) x arrival order. Each case asserts what Ant receives (the
// bridge's own antErrorReply over the router's error), whether Ant's
// is_range_limit_error needles match it (it halves its window) and when it
// arrives (fake timers, so elapsed times are exact).
//
// The rule under test (chain-data-router createErrorKeeper + the bridge's
// rankLogScanError): range limit > timeout > endpoint-dependent; the most
// useful error seen across every tier and retry is kept and a lower-ranked
// later one never replaces it; only a range limit ends the request early.
//
// Only the registry, Myotis, Colibri and fetch are stubbed. The PR #419
// review findings R1-F1..R6-F1 are the named cases at the end.
const mockRegistry = {
  getNetwork: jest.fn(),
  getEndpoints: jest.fn(),
  getEndpointSources: jest.fn(() => []),
  getEndpointSourceList: jest.fn(() => []),
};
const mockMyotis = {
  NETWORKS: new Map([[100, {}]]),
  isReady: jest.fn(() => false),
  markUnhealthy: jest.fn(),
  getStatus: jest.fn(() => ({})),
};
const mockColibri = jest.fn();
jest.mock('../networks/network-registry', () => mockRegistry);
jest.mock('../myotis/myotis-manager', () => mockMyotis);
jest.mock('../ens/colibri-resolver', () => ({
  requestViaColibri: (...args) => mockColibri(...args),
}));
jest.mock('../logger', () => ({ verbose: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const router = require('../networks/chain-data-router');
const {
  LOG_SCAN_ROUTER_OPTIONS,
  LOG_SCAN_ERROR_RANK,
  antErrorReply,
  antShrinksLogScanOn,
} = require('./ant-chain-bridge');

// Gnosis defaults: quorum k=3/m=2 at 5 s, Ant's widened Direct budget 60 s,
// the bridge's 120 s per-request deadline.
const QUORUM_MS = 5000;
const BRIDGE_DEADLINE_MS = 120000;
const BRIDGE_DEADLINE_REPLY = { code: -32002, message: 'Chain request failed: query timeout' };
const RANGE = { code: -32005, message: 'query exceeds max block range 50000' };
const TIMEOUT_REPLY = { code: -32000, message: 'query timeout exceeded' };
const ENDPOINT = {
  code: -32601,
  message: 'the method eth_getLogs does not exist/is not available',
};
const LOGS = ['LOGS'];
// Throttles whose wording matches Ant's needles ("exceed", "limit") but which
// depend on the endpoint: Infura's and EIP-1474's -32005 texts.
const THROTTLE = { code: -32005, message: 'project ID request rate exceeded' };
const LIMIT_EXCEEDED = { code: -32005, message: 'limit exceeded' };
// An endpoint behind the chain head names the block range, but a synced
// endpoint may answer: reth's and Erigon's wordings.
const RETH_LAG = {
  code: -32000,
  message: 'block range extends beyond current head block: requested 0x2000, head 0x1000',
};
const ERIGON_LAG = {
  code: -32000,
  message:
    'requested block range [4096, 8192] is beyond latest executed block 4000 (node is still syncing)',
};
// A range cap worded outside the bridge's REQUEST list.
const LOG_CAP = { code: -32005, message: 'query exceeds limit of 10000 logs' };

const originalFetch = global.fetch;

function rpcReply(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

// One fetch behaviour. `{ kind, after }` delays it by `after` ms.
function behave(step, signal) {
  const { kind, after = 0 } = typeof step === 'string' ? { kind: step } : step;
  const now = () => {
    switch (kind) {
      case 'range':
        return rpcReply({ error: RANGE });
      case 'timeoutReply':
        return rpcReply({ error: TIMEOUT_REPLY });
      case 'endpoint':
        return rpcReply({ error: ENDPOINT });
      case 'throttle':
        return rpcReply({ error: THROTTLE });
      case 'limitExceeded':
        return rpcReply({ error: LIMIT_EXCEEDED });
      case 'rethLag':
        return rpcReply({ error: RETH_LAG });
      case 'erigonLag':
        return rpcReply({ error: ERIGON_LAG });
      case 'logCap':
        return rpcReply({ error: LOG_CAP });
      case '429':
        return Promise.resolve({ ok: false, status: 429, json: async () => ({}) });
      case 'down':
        return Promise.reject(new TypeError('fetch failed'));
      case 'success':
        return rpcReply({ result: LOGS });
      case 'hang':
        return new Promise(() => {});
      default:
        throw new Error(`unknown behaviour ${kind}`);
    }
  };
  const aborted = new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    )
  );
  const answer = after
    ? new Promise((resolve) => setTimeout(resolve, after)).then(now)
    : Promise.resolve().then(now);
  return Promise.race([answer, aborted]);
}

// Colibri's own failure shapes (it is not an HTTP endpoint).
function colibriBehaviour(kind) {
  switch (kind) {
    case 'range':
      return Promise.reject(Object.assign(new Error(RANGE.message), { code: RANGE.code }));
    case 'timeoutReply':
      return Promise.reject(Object.assign(new Error(TIMEOUT_REPLY.message), TIMEOUT_REPLY));
    case 'endpoint':
      return Promise.reject(Object.assign(new Error(ENDPOINT.message), { code: ENDPOINT.code }));
    case 'down':
      return Promise.reject(new Error('Colibri prover unreachable'));
    case 'success':
      return Promise.resolve(LOGS);
    case 'hang':
      return new Promise(() => {});
    default:
      throw new Error(`unknown behaviour ${kind}`);
  }
}

const host = (url) => new URL(url).hostname.split('.')[0];

// Runs one eth_getLogs the way the bridge does and reports what Ant gets.
// `rpcs` maps an endpoint letter to a list of per-call behaviours (the last
// repeats). `colibri` is a behaviour or null for "no prover configured".
async function scan({
  rpcs,
  colibri = null,
  myotisReady = false,
  readOrder = ['myotis', 'colibri', 'quorum', 'direct'],
}) {
  const urls = Object.keys(rpcs).map((name) => `https://${name}.example`);
  mockRegistry.getNetwork.mockReturnValue({
    access: { readOrder },
    quorum: { k: 3, m: 2, timeoutMs: QUORUM_MS },
  });
  mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
    role === 'prover' ? (colibri ? ['https://prover.example'] : []) : urls
  );
  mockMyotis.isReady.mockReturnValue(myotisReady);
  mockColibri.mockImplementation(() => colibriBehaviour(colibri));
  const calls = new Map();
  const fetches = [];
  const start = Date.now();
  global.fetch = jest.fn((url, { signal }) => {
    const name = host(url);
    const n = calls.get(name) || 0;
    calls.set(name, n + 1);
    fetches.push(`${name}@${Date.now() - start}`);
    const script = [].concat(rpcs[name]);
    return behave(script[Math.min(n, script.length - 1)], signal);
  });

  // The bridge's deadline aborts the routed request and answers Ant itself.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), BRIDGE_DEADLINE_MS);
  let outcome;
  router
    .request(100, 'eth_getLogs', [{}], {
      signal: controller.signal,
      background: true,
      ...LOG_SCAN_ROUTER_OPTIONS,
    })
    .then(
      (answer) => {
        outcome = { result: answer.result, source: answer.source };
      },
      (error) => {
        const { code, message } = controller.signal.aborted
          ? BRIDGE_DEADLINE_REPLY
          : antErrorReply('eth_getLogs', error);
        outcome = { code, message, shrinks: antShrinksLogScanOn(message) };
      }
    )
    .finally(() => {
      outcome.at = Date.now() - start;
      clearTimeout(deadline);
    });
  await jest.advanceTimersByTimeAsync(BRIDGE_DEADLINE_MS + 10000);
  if (!outcome) throw new Error('request never settled');
  return { ...outcome, fetches };
}

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  router.clearAdaptiveRoutingForTest();
  mockColibri.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
  global.fetch = originalFetch;
});

test("the bridge's ranks are the router's ERROR_RANK", () => {
  expect(LOG_SCAN_ERROR_RANK).toEqual(router.ERROR_RANK);
});

// Expected outcomes Ant can see.
const gotRange = {
  code: RANGE.code,
  message: `Chain request failed: ${RANGE.message}`,
  shrinks: true,
};
const gotTimeoutReply = {
  code: TIMEOUT_REPLY.code,
  message: `Chain request failed: ${TIMEOUT_REPLY.message}`,
  shrinks: true,
};
const gotLogs = { result: LOGS };
const gotTimeout = (ms) => ({
  code: -32002,
  message: `Chain request failed: RPC query timeout after ${ms}ms`,
  shrinks: true,
});
const gotBridgeDeadline = { ...BRIDGE_DEADLINE_REPLY, shrinks: true };
const gotUnactionable = { shrinks: false };

// Tier x error class. In each row one tier carries the class; every other
// source is unavailable (Myotis not ready or unsupported, Colibri without a
// prover, the remaining RPCs refusing connections), so the row isolates what
// that one tier's answer does to what Ant receives and when.
const down = 'down';
const TIERS = {
  // Myotis v0.1.11 does not serve eth_getLogs: ready or not, it is an
  // unavailable source Ant's scan falls straight through.
  myotis: (kind) => ({ myotisReady: true, rpcs: { a: down, b: down, c: down, d: kind } }),
  colibri: (kind) => ({ colibri: kind, rpcs: { a: down, b: down, c: down, d: down } }),
  // k-of-n: all three quorum members answer alike.
  'quorum 3/3': (kind) => ({ rpcs: { a: kind, b: kind, c: kind, d: down } }),
  // k-of-n: one member carries the class, the other two refuse.
  'quorum 1/3': (kind) => ({ rpcs: { a: kind, b: down, c: down, d: down } }),
  // The endpoint quorum never asked.
  'direct untried': (kind) => ({ rpcs: { a: down, b: down, c: down, d: kind } }),
  // A member that hung through quorum's 5 s and answers on the widened retry.
  'direct retry': (kind) => ({ rpcs: { a: ['hang', kind], b: down, c: down, d: down } }),
};
const MATRIX = {
  myotis: {
    range: [gotRange, 0, ['a', 'b', 'c', 'd']],
    timeoutReply: [gotTimeoutReply, 0, ['a', 'b', 'c', 'd']],
    endpoint: [gotUnactionable, 0, ['a', 'b', 'c', 'd']],
    hang: [gotTimeout(60000), 60000, ['a', 'b', 'c', 'd']],
    success: [gotLogs, 0, ['a', 'b', 'c', 'd']],
  },
  colibri: {
    // A range limit is final: no RPC is asked.
    range: [gotRange, 0, []],
    timeoutReply: [gotTimeoutReply, 0, ['a', 'b', 'c', 'd']],
    endpoint: [gotUnactionable, 0, ['a', 'b', 'c', 'd']],
    // Colibri's 5 s source deadline is a timeout; the RPCs then refuse.
    hang: [
      {
        code: -32002,
        message: 'Chain request failed: Colibri exceeded its 5000ms interactive deadline',
        shrinks: true,
      },
      5000,
      ['a', 'b', 'c', 'd'],
    ],
    success: [gotLogs, 0, []],
  },
  'quorum 3/3': {
    // Final: Direct's untried d is never asked.
    range: [gotRange, 0, ['a', 'b', 'c']],
    timeoutReply: [gotTimeoutReply, 0, ['a', 'b', 'c', 'd']],
    endpoint: [gotUnactionable, 0, ['a', 'b', 'c', 'd']],
    // Quorum 5 s, d refuses, a retried 60 s, b's retry cut by the bridge.
    hang: [gotBridgeDeadline, BRIDGE_DEADLINE_MS, ['a', 'b', 'c', 'd', 'a', 'b']],
    success: [gotLogs, 0, ['a', 'b', 'c']],
  },
  'quorum 1/3': {
    range: [gotRange, 0, ['a', 'b', 'c']],
    timeoutReply: [gotTimeoutReply, 0, ['a', 'b', 'c', 'd']],
    endpoint: [gotUnactionable, 0, ['a', 'b', 'c', 'd']],
    // The later timeout (a's widened retry) replaces quorum's 5 s cut, so Ant
    // and the logs see the budget that actually ran out (R1-M2).
    hang: [gotTimeout(60000), 65000, ['a', 'b', 'c', 'd', 'a']],
    // One member's answer is reused by Direct without a second request.
    success: [gotLogs, 0, ['a', 'b', 'c']],
  },
  'direct untried': {
    range: [gotRange, 0, ['a', 'b', 'c', 'd']],
    timeoutReply: [gotTimeoutReply, 0, ['a', 'b', 'c', 'd']],
    endpoint: [
      { code: ENDPOINT.code, message: `Chain request failed: ${ENDPOINT.message}`, shrinks: false },
      0,
      ['a', 'b', 'c', 'd'],
    ],
    hang: [gotTimeout(60000), 60000, ['a', 'b', 'c', 'd']],
    success: [gotLogs, 0, ['a', 'b', 'c', 'd']],
  },
  'direct retry': {
    range: [gotRange, QUORUM_MS, ['a', 'b', 'c', 'd', 'a']],
    // a's quorum timeout is replaced by its later, equal-ranked timeout
    // reply. Either way Ant halves.
    timeoutReply: [gotTimeoutReply, QUORUM_MS, ['a', 'b', 'c', 'd', 'a']],
    // The endpoint-dependent reply never displaces the timeout (R5-F1).
    endpoint: [gotTimeout(QUORUM_MS), QUORUM_MS, ['a', 'b', 'c', 'd', 'a']],
    hang: [gotTimeout(60000), QUORUM_MS + 60000, ['a', 'b', 'c', 'd', 'a']],
    success: [gotLogs, QUORUM_MS, ['a', 'b', 'c', 'd', 'a']],
  },
};

const rows = Object.entries(MATRIX).flatMap(([tier, classes]) =>
  Object.entries(classes).map(([kind, [expected, at, order]]) => [tier, kind, expected, at, order])
);

describe('tier x error class', () => {
  test.each(rows)('%s answers %s', async (tier, kind, expected, at, order) => {
    const got = await scan(TIERS[tier](kind));
    expect(got).toMatchObject({ ...expected, at });
    expect(got.fetches.map((entry) => entry.split('@')[0])).toEqual(order);
  });
});

// Arrival order: which error lands first must not change which one Ant gets.
describe('arrival order', () => {
  test('a range limit after an endpoint error ends quorum as soon as it lands', async () => {
    const got = await scan({
      rpcs: { a: 'endpoint', b: { kind: 'range', after: 1000 }, c: 'hang', d: 'success' },
    });
    expect(got).toMatchObject({ ...gotRange, at: 1000 });
    expect(got.fetches).toEqual(['a@0', 'b@0', 'c@0']);
  });

  test('an endpoint error after a range limit does not replace it', async () => {
    const got = await scan({
      rpcs: { a: { kind: 'endpoint', after: 1000 }, b: 'range', c: 'hang', d: 'success' },
    });
    expect(got).toMatchObject({ ...gotRange, at: 1000 });
  });

  test('timeouts after a range limit do not replace it', async () => {
    const got = await scan({ rpcs: { a: 'hang', b: 'range', c: 'hang', d: 'success' } });
    // Quorum could still agree until the hung members time out at 5 s.
    expect(got).toMatchObject({ ...gotRange, at: QUORUM_MS });
    expect(got.fetches).toEqual(['a@0', 'b@0', 'c@0']);
  });

  test('a range limit after timeouts replaces them and skips the retries', async () => {
    const got = await scan({
      rpcs: { a: 'hang', b: 'hang', c: 'hang', d: { kind: 'range', after: 1000 } },
    });
    expect(got).toMatchObject({ ...gotRange, at: QUORUM_MS + 1000 });
    expect(got.fetches).toEqual(['a@0', 'b@0', 'c@0', 'd@5000']);
  });

  test('an endpoint error after a timeout does not replace it', async () => {
    const got = await scan({ rpcs: { a: 'hang', b: 'down', c: 'down', d: 'endpoint' } });
    // a's quorum timeout, then d's -32601, then a's widened retry times out:
    // the timeouts are kept (the later one), the -32601 never is.
    expect(got).toMatchObject({ ...gotTimeout(60000), at: 65000 });
  });

  test('a timeout after an endpoint error replaces it', async () => {
    const got = await scan({ rpcs: { a: 'endpoint', b: 'down', c: 'down', d: 'hang' } });
    expect(got).toMatchObject({ ...gotTimeout(60000), at: 60000 });
  });

  test("a quorum member's result beats the others' range limits", async () => {
    const got = await scan({ rpcs: { a: 'success', b: 'range', c: 'range', d: 'success' } });
    // Direct reuses a's answer; d is never asked.
    expect(got).toMatchObject({ ...gotLogs, source: 'direct', at: 0 });
    expect(got.fetches).toEqual(['a@0', 'b@0', 'c@0']);
  });

  test('a success after every kind of failure still wins', async () => {
    const got = await scan({
      colibri: 'hang',
      rpcs: { a: ['hang', 'success'], b: 'endpoint', c: 'timeoutReply', d: '429' },
    });
    // Colibri 5 s, quorum 5 s, d 429, then a's widened retry answers.
    expect(got).toMatchObject({ ...gotLogs, at: 10000 });
    expect(got.fetches).toEqual(['a@5000', 'b@5000', 'c@5000', 'd@10000', 'a@10000']);
  });
});

// The review findings on PR #419 that led to the rule, as named cases.
describe('PR #419 review findings', () => {
  test('R1-F1: the upstream range-limit wording reaches Ant, not a generic message', async () => {
    const got = await scan({ rpcs: { a: 'down', b: 'down', c: 'down', d: 'range' } });
    expect(got).toMatchObject({ code: -32005, shrinks: true, at: 0 });
    expect(got.message).toContain('max block range 50000');
  });

  test('R2-F1: with three RPCs (none left for Direct) a range limit still reaches Ant', async () => {
    const got = await scan({ rpcs: { a: 'range', b: 'range', c: 'range' } });
    expect(got).toMatchObject({ ...gotRange, at: 0 });
    expect(got.fetches).toHaveLength(3);
  });

  test('R2-F1: with three hung RPCs the widened retry runs and Ant gets a timeout', async () => {
    const got = await scan({
      rpcs: { a: ['hang', { kind: 'success', after: 20000 }], b: 'hang', c: 'hang' },
    });
    expect(got).toMatchObject({ ...gotLogs, at: QUORUM_MS + 20000 });
    const stuck = await scan({ rpcs: { a: 'hang', b: 'hang', c: 'hang' } });
    expect(stuck).toMatchObject({ ...gotBridgeDeadline, at: BRIDGE_DEADLINE_MS });
  });

  test('R3-F1: a healthy fourth RPC is reached right after quorum, before the retries', async () => {
    const got = await scan({ rpcs: { a: 'hang', b: 'hang', c: 'hang', d: 'success' } });
    expect(got).toMatchObject({ ...gotLogs, at: QUORUM_MS });
    expect(got.fetches).toEqual(['a@0', 'b@0', 'c@0', 'd@5000']);
  });

  test('R4-F1: one hung RPC does not turn a range limit into a 65 s timeout', async () => {
    const four = await scan({ rpcs: { a: 'hang', b: 'range', c: 'range', d: 'range' } });
    // b and c make quorum impossible and the range limit is final: no wait
    // for a, no d, no retry.
    expect(four).toMatchObject({ ...gotRange, at: 0 });
    expect(four.fetches).toEqual(['a@0', 'b@0', 'c@0']);
    const three = await scan({ rpcs: { a: 'hang', b: 'range', c: 'range' } });
    expect(three).toMatchObject({ ...gotRange, at: 0 });
  });

  test('R5-F1: an endpoint-dependent error does not skip the retry or reach Ant', async () => {
    const got = await scan({
      rpcs: { a: ['hang', { kind: 'success', after: 800 }], b: 'hang', c: 'endpoint' },
    });
    expect(got).toMatchObject({ ...gotLogs, at: QUORUM_MS + 800 });
    expect(got.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c', 'a']);
    const stuck = await scan({ rpcs: { a: 'hang', b: 'hang', c: 'endpoint' } });
    expect(stuck).toMatchObject({ shrinks: true });
    expect(stuck.message).not.toContain('does not exist');
  });

  test.each(['429', 'endpoint', 'down'])(
    "R6-F1: quorum's range limit survives Direct's untried RPC failing with %s",
    async (kind) => {
      const got = await scan({ rpcs: { a: 'range', b: 'range', c: 'range', d: kind } });
      expect(got).toMatchObject({ ...gotRange, at: 0 });
    }
  );

  test('R6-F1: a range limit survives a later 429 from the untried RPC', async () => {
    // Quorum split (no agreement, no range limit yet); d rate-limits, then the
    // widened retry of hung a answers with the range limit.
    const got = await scan({
      rpcs: { a: ['hang', 'range'], b: 'endpoint', c: 'endpoint', d: '429' },
    });
    expect(got).toMatchObject({ ...gotRange, at: QUORUM_MS });
  });

  test('R6-M1: in a quorum-only order a timeout outranks an endpoint error', async () => {
    const got = await scan({
      readOrder: ['quorum'],
      rpcs: { a: 'endpoint', b: 'hang', c: 'hang' },
    });
    expect(got).toMatchObject({ ...gotTimeout(QUORUM_MS), at: QUORUM_MS });
  });

  // Round 7 (the R1-F1/R1-M1 findings of the fix loop's next pass): coded
  // throttles matching Ant's broad needles are endpoint-dependent.
  test.each(['throttle', 'limitExceeded'])(
    'a -32005 %s reply falls through to a healthy untried RPC',
    async (kind) => {
      const got = await scan({ rpcs: { a: kind, b: 'down', c: 'down', d: 'success' } });
      expect(got).toMatchObject({ ...gotLogs, at: 0 });
      expect(got.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c', 'd']);
    }
  );

  test('when every RPC answers a -32005 throttle, Ant gets no wording it would halve on', async () => {
    const got = await scan({
      rpcs: { a: 'throttle', b: 'throttle', c: 'throttle', d: 'throttle' },
    });
    expect(got).toMatchObject({ code: -32005, shrinks: false, at: 0 });
  });

  // Round 8 (PR #419 R2-F1/R2-F2).
  test.each(['rethLag', 'erigonLag'])(
    'R2-F1: a %s reply (endpoint behind head) falls through to a healthy untried RPC',
    async (kind) => {
      const got = await scan({ rpcs: { a: kind, b: 'down', c: 'down', d: 'success' } });
      expect(got).toMatchObject({ ...gotLogs, at: 0 });
      expect(got.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c', 'd']);
    }
  );

  test('R2-F1: a lagging untried Direct RPC does not stop the next one', async () => {
    const got = await scan({
      rpcs: { a: 'down', b: 'down', c: 'down', d: 'rethLag', e: 'success' },
    });
    expect(got).toMatchObject({ ...gotLogs, at: 0 });
    expect(got.fetches.map((entry) => entry.split('@')[0])).toContain('e');
  });

  test.each([
    ['limitExceeded', LIMIT_EXCEEDED],
    ['logCap', LOG_CAP],
  ])(
    'R2-F2: when every RPC answers an unrecognised -32005 %s, Ant still halves on its text',
    async (kind, error) => {
      const got = await scan({ rpcs: { a: kind, b: kind, c: kind, d: kind } });
      expect(got).toMatchObject({
        code: -32005,
        message: `Chain request failed: ${error.message}`,
        shrinks: true,
        at: 0,
      });
    }
  );
});
