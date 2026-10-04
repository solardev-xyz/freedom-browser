// Ant's eth_getLogs scan through the real chain-data router, with the
// bridge's own options and error mapping, under fake timers. Each case asserts
// what Ant receives (antErrorReply over the router's error), whether Ant's
// is_range_limit_error needles match it (it halves its window), when it
// arrives and which RPCs were asked.
//
// Only the RPC quorum answers Ant's log scans (#484): a log Ant never receives
// is the one failure it cannot detect, so no single endpoint's answer settles
// a range. Myotis serves no logs and Colibri proves only the logs it returns,
// so neither is asked, and there is no single-endpoint Direct fallback.
//
// 1. Error ranking (chain-data-router createErrorKeeper + the bridge's
//    rankLogScanError): range limit > timeout > possible range cap >
//    endpoint-dependent (REQUEST > TIMEOUT > HINT > ENDPOINT). The most useful
//    error the quorum's members return is kept and a lower-ranked later one
//    never replaces it (a later timeout does replace an earlier one); only a
//    range limit ends the request before the quorum's budget runs out. A
//    possible range cap (a coded reply matching Ant's needles that names
//    neither the query's size, a throttle nor a lagging endpoint, e.g.
//    EIP-1474 "-32005 limit exceeded") reaches Ant verbatim if nothing better
//    turns up, so Ant halves on it as it would against that RPC directly.
//    These cases send a filter without a numeric block range, which the
//    router never learns from.
// 2. Range caps: for a numeric block range the router learns the cap each
//    endpoint names (the bridge's logScanRangeCap), asks only endpoints that
//    can serve the span, and, when no quorum can, refuses at once with the
//    widest span one can verify. These cases replay the endpoint behaviour
//    measured for #484.
//
// Only the registry, Myotis, Colibri and fetch are stubbed. The PR #419 review
// findings that still apply to a quorum-only scan are named cases.
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
  ANT_LOG_SCAN_SHRINK_NEEDLES,
  antErrorReply,
  antShrinksLogScanOn,
} = require('./ant-chain-bridge');

// Gnosis defaults: quorum k=3/m=2 at 5 s, which Ant's log scans widen, and the
// bridge's 120 s per-request deadline.
const QUORUM_MS = 5000;
const SCAN_QUORUM_MS = LOG_SCAN_ROUTER_OPTIONS.quorumTimeoutMs;
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
const RANGES_OVER = { code: -32000, message: 'ranges over 10000 blocks are not supported' };
// Measured for #484 (2026-10-03).
const NETHERMIND_CAP = {
  code: -32602,
  message:
    'Block range 50000 exceeds the maximum of 10000 blocks per logs request. Use a narrower fromBlock/toBlock range or increase Receipt.MaxBlockDepth.',
};
const PUBLICNODE_CAP = { code: -32701, message: 'exceed maximum block range: 50000' };

const originalFetch = global.fetch;

function rpcReply(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

// One fetch behaviour. `{ kind, after }` delays it by `after` ms; a function
// of the requested block span returns the behaviour for that span.
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
      case 'rangesOver':
        return rpcReply({ error: RANGES_OVER });
      case 'nethermindCap':
        return rpcReply({ error: NETHERMIND_CAP });
      case 'publicnodeCap':
        return rpcReply({ error: PUBLICNODE_CAP });
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

const host = (url) => new URL(url).hostname.split('.')[0];
const spanOf = (params) => parseInt(params[0].toBlock, 16) - parseInt(params[0].fromBlock, 16) + 1;

// A filter over `span` blocks ending at the chain head.
const HEAD = 48_560_000;
const FULL_HISTORY = HEAD - 16_514_506 + 1;
const logsOver = (span) => [
  { fromBlock: `0x${(HEAD - span + 1).toString(16)}`, toBlock: `0x${HEAD.toString(16)}` },
];

let fetches = [];
let start = 0;

// Points the stubbed registry and fetch at `rpcs`: endpoint letter -> list of
// per-call behaviours (the last repeats), each a behaviour or a function of
// the requested span. Myotis is ready and Colibri answers, so a case shows
// that neither is asked.
function useEndpoints(rpcs) {
  const urls = Object.keys(rpcs).map((name) => `https://${name}.example`);
  mockRegistry.getNetwork.mockReturnValue({
    access: { readOrder: ['myotis', 'colibri', 'quorum', 'direct'] },
    quorum: { k: 3, m: 2, timeoutMs: QUORUM_MS },
  });
  mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
    role === 'prover' ? ['https://prover.example'] : urls
  );
  mockMyotis.isReady.mockReturnValue(true);
  mockColibri.mockResolvedValue(LOGS);
  const calls = new Map();
  global.fetch = jest.fn((url, { body, signal }) => {
    const name = host(url);
    const n = calls.get(name) || 0;
    calls.set(name, n + 1);
    fetches.push(`${name}@${Date.now() - start}`);
    const script = [].concat(rpcs[name]);
    const step = script[Math.min(n, script.length - 1)];
    return behave(
      typeof step === 'function' ? step(spanOf(JSON.parse(body).params)) : step,
      signal
    );
  });
}

// Runs one eth_getLogs the way the bridge does and reports what Ant gets.
// Fake time only moves until the request settles, so consecutive scans see
// each other's cooldowns.
async function scanOnce(params = [{}]) {
  fetches = [];
  start = Date.now();
  // The bridge's deadline aborts the routed request and answers Ant itself.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), BRIDGE_DEADLINE_MS);
  let outcome;
  router
    .request(100, 'eth_getLogs', params, {
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
  for (let waited = 0; !outcome && waited <= BRIDGE_DEADLINE_MS; waited += 100) {
    await jest.advanceTimersByTimeAsync(waited === 0 ? 0 : 100);
  }
  if (!outcome) throw new Error('request never settled');
  return { ...outcome, fetches: [...fetches] };
}

async function scan(rpcs, params) {
  useEndpoints(rpcs);
  return scanOnce(params);
}

// Ant's scan_logs: start at its 50M-block window (here the full history),
// halve on a range limit or timeout, until an answer or another failure.
async function antScan(rpcs) {
  useEndpoints(rpcs);
  const steps = [];
  for (let span = FULL_HISTORY; span >= 1; span = Math.floor(span / 2)) {
    const got = await scanOnce(logsOver(span));
    steps.push({ span, ...got });
    if (!got.shrinks) break;
  }
  return steps;
}

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  router.clearAdaptiveRoutingForTest();
  mockColibri.mockReset();
  mockMyotis.isReady.mockReset();
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
const gotLogs = { result: LOGS, source: 'quorum' };
const gotQuorumTimeout = {
  code: -32002,
  message: `Chain request failed: RPC query timeout after ${SCAN_QUORUM_MS}ms`,
  shrinks: true,
};
const gotUnactionable = { shrinks: false };

describe('only the RPC quorum answers', () => {
  test('Myotis and Colibri are not asked, even when ready', async () => {
    const got = await scan({ a: 'success', b: 'success', c: 'success' });
    expect(got).toMatchObject({ ...gotLogs, at: 0 });
    expect(mockColibri).not.toHaveBeenCalled();
    expect(mockMyotis.isReady).not.toHaveBeenCalled();
  });

  // Colibri truncates wide ranges (#496) and proves no completeness, so it is
  // never asked, whatever it would answer (#494).
  test.each([
    ['logs', () => Promise.resolve(LOGS)],
    ['a range limit', () => Promise.reject(Object.assign(new Error(RANGE.message), RANGE))],
    [
      'a timeout reply',
      () => Promise.reject(Object.assign(new Error(TIMEOUT_REPLY.message), TIMEOUT_REPLY)),
    ],
    ['nothing (hang)', () => new Promise(() => {})],
  ])('Colibri is not asked when it would answer %s', async (_kind, colibri) => {
    useEndpoints({ a: 'down', b: 'down', c: 'down' });
    mockColibri.mockImplementation(colibri);
    const got = await scanOnce();
    expect(mockColibri).not.toHaveBeenCalled();
    expect(got).toMatchObject({ ...gotUnactionable, at: 0 });
  });

  test("one endpoint's answer does not settle a range: Ant gets no answer", async () => {
    const got = await scan({ a: 'success', b: 'down', c: 'down', d: 'success' });
    // No Direct fallback: a's answer alone is not reused, d is never asked,
    // and nothing Ant would halve on reaches it.
    expect(got).toMatchObject({ ...gotUnactionable, at: 0 });
    expect(got.result).toBeUndefined();
    expect(got.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
  });

  test("the no-quorum reply carries none of Ant's range needles", async () => {
    const got = await scan({ a: 'success', b: 'down', c: 'down' });
    for (const needle of ANT_LOG_SCAN_SHRINK_NEEDLES) {
      expect(got.message.toLowerCase()).not.toContain(needle);
    }
  });
});

// Member pattern x error class. In each row the class is answered by every
// member ("3/3") or by two of them with the third refusing the connection
// ("2/3"), or by one with the other two refusing ("1/3").
const PATTERNS = {
  '3/3': (kind) => ({ a: kind, b: kind, c: kind, d: 'success' }),
  '2/3': (kind) => ({ a: kind, b: kind, c: 'down', d: 'success' }),
  '1/3': (kind) => ({ a: kind, b: 'down', c: 'down', d: 'success' }),
};
const MATRIX = {
  '3/3': {
    range: [gotRange, 0],
    timeoutReply: [gotTimeoutReply, 0],
    endpoint: [gotUnactionable, 0],
    hang: [gotQuorumTimeout, SCAN_QUORUM_MS],
    success: [gotLogs, 0],
  },
  '2/3': {
    range: [gotRange, 0],
    timeoutReply: [gotTimeoutReply, 0],
    endpoint: [gotUnactionable, 0],
    hang: [gotQuorumTimeout, SCAN_QUORUM_MS],
    success: [gotLogs, 0],
  },
  // Two members refusing the connection make agreement impossible at once:
  // the third is not waited for, whatever it would have answered, and Ant gets
  // no answer and nothing it would halve on.
  '1/3': {
    range: [gotUnactionable, 0],
    timeoutReply: [gotUnactionable, 0],
    endpoint: [gotUnactionable, 0],
    hang: [gotUnactionable, 0],
    success: [gotUnactionable, 0],
  },
};
const rows = Object.entries(MATRIX).flatMap(([pattern, classes]) =>
  Object.entries(classes).map(([kind, [expected, at]]) => [pattern, kind, expected, at])
);

describe('members x error class', () => {
  test.each(rows)('%s members answer %s', async (pattern, kind, expected, at) => {
    const got = await scan(PATTERNS[pattern](kind));
    expect(got).toMatchObject({ ...expected, at });
    // The quorum's three members, never the fourth endpoint.
    expect(got.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
  });
});

// Arrival order: which error lands first must not change which one Ant gets.
describe('arrival order', () => {
  test('a range limit after an endpoint error ends the quorum as soon as it lands', async () => {
    const got = await scan({ a: 'endpoint', b: { kind: 'range', after: 1000 }, c: 'hang' });
    expect(got).toMatchObject({ ...gotRange, at: 1000 });
  });

  test('an endpoint error after a range limit does not replace it', async () => {
    const got = await scan({ a: { kind: 'endpoint', after: 1000 }, b: 'range', c: 'hang' });
    expect(got).toMatchObject({ ...gotRange, at: 1000 });
  });

  test('timeouts after a range limit do not replace it', async () => {
    const got = await scan({ a: 'hang', b: 'range', c: 'hang' });
    // The quorum could still agree until the hung members time out.
    expect(got).toMatchObject({ ...gotRange, at: SCAN_QUORUM_MS });
  });

  test('a timeout replaces an earlier endpoint error', async () => {
    const got = await scan({ a: 'endpoint', b: 'hang', c: 'hang' });
    expect(got).toMatchObject({ ...gotQuorumTimeout, at: SCAN_QUORUM_MS });
  });

  test("one member's answer does not outvote the others' range limits", async () => {
    const got = await scan({ a: 'success', b: 'range', c: 'range' });
    expect(got).toMatchObject({ ...gotRange, at: 0 });
  });

  test("two agreeing answers win over the third member's failure", async () => {
    const got = await scan({
      a: { kind: 'success', after: 1000 },
      b: 'endpoint',
      c: { kind: 'success', after: 2000 },
    });
    expect(got).toMatchObject({ ...gotLogs, at: 2000 });
  });
});

describe('PR #419 review findings', () => {
  test('R1-F1: the upstream range-limit wording reaches Ant, not a generic message', async () => {
    const got = await scan({ a: 'down', b: 'range', c: 'range' });
    expect(got).toMatchObject({ code: -32005, shrinks: true, at: 0 });
    expect(got.message).toContain('max block range 50000');
  });

  test('R4-F1: one hung RPC does not turn a range limit into a timeout', async () => {
    const got = await scan({ a: 'hang', b: 'range', c: 'range', d: 'range' });
    // b and c make agreement impossible and the range limit is final: no wait
    // for a, no d.
    expect(got).toMatchObject({ ...gotRange, at: 0 });
    expect(got.fetches).toEqual(['a@0', 'b@0', 'c@0']);
  });

  test.each(['429', 'endpoint', 'down'])(
    'R6-F1: a range limit survives a later member failing with %s',
    async (kind) => {
      const got = await scan({ a: 'range', b: { kind, after: 100 }, c: 'hang' });
      expect(got).toMatchObject({ ...gotRange, at: 100 });
    }
  );

  test('R6-M1: a timeout outranks an endpoint error', async () => {
    const got = await scan({ a: 'endpoint', b: 'hang', c: 'hang' });
    expect(got).toMatchObject({ ...gotQuorumTimeout, at: SCAN_QUORUM_MS });
  });

  // Coded throttles matching Ant's broad needles are endpoint-dependent.
  test.each(['throttle', 'limitExceeded', 'rethLag', 'erigonLag'])(
    'a %s reply does not stop the other two members agreeing',
    async (kind) => {
      const got = await scan({ a: kind, b: 'success', c: 'success' });
      expect(got).toMatchObject({ ...gotLogs, at: 0 });
    }
  );

  test('when every RPC answers a -32005 throttle, Ant gets no wording it would halve on', async () => {
    const got = await scan({ a: 'throttle', b: 'throttle', c: 'throttle' });
    expect(got).toMatchObject({ shrinks: false, at: 0 });
  });

  test.each([
    ['limitExceeded', LIMIT_EXCEEDED],
    ['logCap', LOG_CAP],
  ])(
    'R2-F2: when every RPC answers an unrecognised -32005 %s, Ant still halves on its text',
    async (kind, error) => {
      const got = await scan({ a: kind, b: kind, c: kind });
      expect(got).toMatchObject({
        code: -32005,
        message: `Chain request failed: ${error.message}`,
        shrinks: true,
        at: 0,
      });
    }
  );

  test.each([
    ['logCap', LOG_CAP, 'down'],
    ['logCap', LOG_CAP, '429'],
    ['logCap', LOG_CAP, 'throttle'],
    ['limitExceeded', LIMIT_EXCEEDED, 'down'],
    ['limitExceeded', LIMIT_EXCEEDED, '429'],
    ['rangesOver', RANGES_OVER, 'down'],
  ])(
    'R3-F1: a %s from one RPC reaches Ant over another answering %s',
    async (kind, error, others) => {
      const expected = {
        code: error.code,
        message: `Chain request failed: ${error.message}`,
        shrinks: true,
        at: 100,
      };
      // Not final: agreement stays possible until the second failure, which
      // is either one.
      for (const rpcs of [
        { a: kind, b: { kind: others, after: 100 }, c: 'hang' },
        { a: { kind, after: 100 }, b: others, c: 'hang' },
      ]) {
        expect(await scan(rpcs)).toMatchObject(expected);
      }
    }
  );

  test('R3-F1: a possible cap still loses to a later timeout and to two real answers', async () => {
    const timedOut = await scan({ a: 'logCap', b: 'timeoutReply', c: 'hang' });
    expect(timedOut).toMatchObject({ ...gotTimeoutReply, at: 0 });
    const answered = await scan({ a: 'logCap', b: 'success', c: 'success' });
    expect(answered).toMatchObject({ ...gotLogs, at: 0 });
  });

  test('R3-F1: a lagging endpoint is still not kept over a later transport failure', async () => {
    const got = await scan({ a: 'rethLag', b: 'down', c: 'down' });
    expect(got).toMatchObject({ shrinks: false });
  });
});

// The endpoints #484 measured (2026-10-03), by the span they are asked for:
// rpc.gnosischain.com and rpc.gnosis.gateway.fm answer the full history;
// publicnode hands up to 50k blocks to a backend capped at 10k and refuses
// more itself; dRPC's free plan and Colibri's RPC refuse over 10k.
const FULL = () => 'success';
const PUBLICNODE = (span) =>
  span > 50_000 ? 'publicnodeCap' : span > 10_000 ? 'nethermindCap' : 'success';
const DRPC = (span) => (span > 10_000 ? 'rangesOver' : 'success');

describe('range caps (#484)', () => {
  test('a full-history scan is one verified answer when two endpoints serve it', async () => {
    const [step, ...rest] = await antScan({ a: FULL, b: FULL, c: PUBLICNODE, d: DRPC });
    expect(rest).toEqual([]);
    expect(step).toMatchObject({ span: FULL_HISTORY, ...gotLogs, at: 0 });
    expect(step.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
  });

  test('an endpoint that named its cap is left out of wider scans', async () => {
    useEndpoints({ a: FULL, b: PUBLICNODE, c: FULL });
    await scanOnce(logsOver(FULL_HISTORY));
    const again = await scanOnce(logsOver(FULL_HISTORY));
    expect(again).toMatchObject({ ...gotLogs, at: 0 });
    expect(again.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'c']);
    // A span under the cap asks it again.
    const narrow = await scanOnce(logsOver(10_000));
    expect(narrow.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
  });

  test('a fourth endpoint joins the quorum in place of capped ones', async () => {
    useEndpoints({ a: FULL, b: PUBLICNODE, c: DRPC, d: FULL });
    // b and c refuse the span, so a second round asks a and d straight away.
    const first = await scanOnce(logsOver(FULL_HISTORY));
    expect(first).toMatchObject({ ...gotLogs, at: 0 });
    expect(first.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c', 'a', 'd']);
    const second = await scanOnce(logsOver(FULL_HISTORY));
    expect(second.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'd']);
  });

  test('two members down: a second round asks the endpoints left', async () => {
    const got = await scan({ a: 'down', b: 'down', c: 'success', d: 'success' }, logsOver(5000));
    expect(got).toMatchObject({ ...gotLogs, at: 0 });
    expect(got.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c', 'c', 'd']);
  });

  test('when no quorum can serve the span, Ant is told the widest one can, at once', async () => {
    useEndpoints({ a: FULL, b: PUBLICNODE, c: DRPC });
    await scanOnce(logsOver(40_000));
    await scanOnce(logsOver(40_000));
    const got = await scanOnce(logsOver(FULL_HISTORY));
    expect(got).toMatchObject({
      code: -32005,
      message: 'Chain request failed: query exceeds max block range 10000',
      shrinks: true,
      at: 0,
    });
    // Nobody is asked.
    expect(got.fetches).toEqual([]);
  });

  test('one full-history endpoint down: the scan shrinks to windows the capped ones verify', async () => {
    const steps = await antScan({ a: FULL, b: 'down', c: PUBLICNODE, d: DRPC });
    const last = steps[steps.length - 1];
    expect(last).toMatchObject({ ...gotLogs });
    expect(last.span).toBeLessThanOrEqual(10_000);
    // Every refusal on the way is one Ant halves on, and most cost no request.
    expect(steps.slice(0, -1).every((step) => step.shrinks)).toBe(true);
    const asked = steps.reduce((sum, step) => sum + step.fetches.length, 0);
    expect(asked).toBeLessThan(steps.length + 8);
    expect(steps.reduce((sum, step) => sum + step.at, 0)).toBe(0);
  });

  test('a full-history endpoint failing later narrows the scan instead of ending it', async () => {
    const slow = { kind: 'success', after: 100 };
    useEndpoints({ a: slow, b: [slow, 'down'], c: PUBLICNODE });
    // The first scan teaches c's cap (it refuses before a and b agree).
    expect(await scanOnce(logsOver(FULL_HISTORY))).toMatchObject({ ...gotLogs });
    // Then b refuses connections: a alone cannot settle the full range, but a
    // and c can verify narrower windows, so Ant is told to narrow.
    const got = await scanOnce(logsOver(FULL_HISTORY));
    expect(got).toMatchObject({
      code: -32005,
      message: 'Chain request failed: query exceeds max block range 50000',
      shrinks: true,
      at: 0,
    });
    expect(got.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b']);
  });

  test('a hung endpoint is left out after one quorum budget, then asked again', async () => {
    useEndpoints({ a: FULL, b: 'hang', c: PUBLICNODE });
    const first = await scanOnce(logsOver(FULL_HISTORY));
    // c refuses, b hangs: the quorum waits out its budget, then Ant narrows
    // until a and c verify the span together.
    expect(first).toMatchObject({
      code: PUBLICNODE_CAP.code,
      message: `Chain request failed: ${PUBLICNODE_CAP.message}`,
      shrinks: true,
      at: SCAN_QUORUM_MS,
    });
    const narrow = await scanOnce(logsOver(10_000));
    expect(narrow).toMatchObject({ ...gotLogs, at: 0 });
    expect(narrow.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'c']);
    await jest.advanceTimersByTimeAsync(router.LOG_SCAN_COOLDOWN_MS);
    const later = await scanOnce(logsOver(10_000));
    expect(later.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
  });

  test('a learned cap expires, and an endpoint that answers above it loses it', async () => {
    let raised = false;
    useEndpoints({ a: FULL, b: (span) => (raised ? 'success' : PUBLICNODE(span)), c: FULL });
    await scanOnce(logsOver(FULL_HISTORY));
    raised = true;
    const capped = await scanOnce(logsOver(FULL_HISTORY));
    expect(capped.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'c']);
    await jest.advanceTimersByTimeAsync(router.LOG_RANGE_CAP_TTL_MS);
    const retried = await scanOnce(logsOver(FULL_HISTORY));
    expect(retried.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
    const kept = await scanOnce(logsOver(FULL_HISTORY));
    expect(kept.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
  });

  test('R1-M1: an upstream query timeout bounds an endpoint only briefly', async () => {
    useEndpoints({ a: FULL, b: 'timeoutReply', c: 'timeoutReply' });
    // b's and c's upstreams time out at 500 blocks: Ant narrows below it.
    const first = await scanOnce(logsOver(500));
    expect(first).toMatchObject({
      message: 'Chain request failed: query exceeds max block range 499',
      shrinks: true,
    });
    // Right after, wider scans are told that span too.
    useEndpoints({ a: FULL, b: FULL, c: FULL });
    const soon = await scanOnce(logsOver(2000));
    expect(soon).toMatchObject({ message: 'Chain request failed: query exceeds max block range 499' });
    expect(soon.fetches).toEqual([]);
    // A busy moment is no range limit: after the cooldown, not 30 minutes,
    // the wide scan is asked again and answered.
    await jest.advanceTimersByTimeAsync(router.LOG_SCAN_COOLDOWN_MS);
    const later = await scanOnce(logsOver(2000));
    expect(later).toMatchObject({ ...gotLogs });
    expect(later.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
  });

  test('R1-M1: a timed-out span holds until the cooldown ends, then is asked again', async () => {
    useEndpoints({ a: FULL, b: ['timeoutReply', 'success'], c: FULL });
    expect(await scanOnce(logsOver(4000))).toMatchObject({ ...gotLogs });
    // b is bounded below 4000 for now, so a and c serve the 4000-block scan,
    const wide = await scanOnce(logsOver(4000));
    expect(wide.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'c']);
    // b still serves narrower spans, which leave the bound in place,
    const narrow = await scanOnce(logsOver(1000));
    expect(narrow.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
    const still = await scanOnce(logsOver(4000));
    expect(still.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'c']);
    // and once the cooldown has passed b is asked for 4000 blocks again.
    await jest.advanceTimersByTimeAsync(router.LOG_SCAN_COOLDOWN_MS);
    const again = await scanOnce(logsOver(4000));
    expect(again.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
  });

  test('R1-M2: a result-count cap is not learned as a block-range cap', async () => {
    const MANY = { code: -32005, message: 'query returned more than 10000 results' };
    let dense = true;
    useEndpoints({ a: FULL, b: FULL, c: FULL });
    const fetchLogs = global.fetch;
    global.fetch = jest.fn((url, init) =>
      dense ? rpcReply({ error: MANY }) : fetchLogs(url, init)
    );
    const denseScan = await scanOnce(logsOver(20_000));
    expect(denseScan).toMatchObject({ code: MANY.code, shrinks: true });
    // A sparse filter over the same span is asked of every endpoint, not
    // refused as "max block range 19999".
    dense = false;
    const sparse = await scanOnce(logsOver(20_000));
    expect(sparse).toMatchObject({ ...gotLogs });
    expect(sparse.fetches.map((entry) => entry.split('@')[0])).toEqual(['a', 'b', 'c']);
  });

  test('every endpoint down: Ant gets no range wording and stops the scan', async () => {
    const steps = await antScan({ a: 'down', b: 'down', c: 'down' });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ shrinks: false, at: 0 });
    // The next attempt, while they cool down, asks nobody and says so.
    const again = await scanOnce(logsOver(FULL_HISTORY));
    expect(again).toMatchObject({ shrinks: false, at: 0 });
    expect(again.fetches).toEqual([]);
    expect(again.message).toContain('No RPC quorum available');
  });
});
