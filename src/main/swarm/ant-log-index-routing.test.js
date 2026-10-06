// Ant's first wallet scan through the real chain-data router with the
// bridge's own options, when Blockscout's log index joins as a second,
// independent full-history source (#529, the router's blockscout source).
//
// antWalletScan replays Ant v0.5.59's scan_logs_with (crates/ant-chain/src/
// discover.rs) over the bridge: one window from the token's deploy block to
// the head (capped at 50M blocks), halved on an error matching Ant's
// is_range_limit_error needles, doubled again after an answer. Each case
// asserts what Ant got (the logs, or how its scan stopped), how many requests
// Ant made and which providers were asked.
//
// The endpoints replay what was measured for #484/#529: the full-history RPC
// (rpc.gnosischain.com, Tenderly) answers any span; publicnode and dRPC's free
// plan refuse wide ones (50,000 and 10,000 blocks on 2026-10-05; both are
// modelled at 10,000 here). So without Blockscout no quorum of two
// can verify a wide span, and Ant reads the history window by window.
const mockRegistry = {
  getNetwork: jest.fn(),
  getEndpoints: jest.fn(),
  getEndpointSources: jest.fn(() => []),
  getEndpointSourceList: jest.fn(() => []),
};
const mockMyotis = {
  NETWORKS: new Map([[100, {}]]),
  isReady: jest.fn(() => false),
  getStatus: jest.fn(() => ({})),
};
jest.mock('../networks/network-registry', () => mockRegistry);
jest.mock('../myotis/myotis-manager', () => mockMyotis);
jest.mock('../ens/colibri-resolver', () => ({ requestViaColibri: jest.fn() }));
jest.mock('../logger', () => ({ verbose: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const router = require('../networks/chain-data-router');
const { blockscoutLogToRpcLog, ERC20_TRANSFER_TOPIC } = require('../networks/blockscout-logs');
const {
  LOG_SCAN_ROUTER_OPTIONS,
  antErrorReply,
  antShrinksLogScanOn,
} = require('./ant-chain-bridge');

const XBZZ = '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da';
const DEPLOY_BLOCK = 16_514_506;
const HEAD = 48_607_023;
const WALLET = '0x000000000000000000000000971f31aaeac713b47aa55e50c06409afc1de46b9';
const POSTAGE = '0x00000000000000000000000045a1502382541cd610cc9068e88727426b696293';
const INITIAL_SCAN_CHUNK = 50_000_000;

// The wallet's transfers on chain, as an RPC's eth_getLogs entries: spread
// over the history, plus one in the newest blocks.
const entry = (block, logIndex, to = POSTAGE) => ({
  address: XBZZ.toLowerCase(),
  topics: [ERC20_TRANSFER_TOPIC, WALLET, to],
  data: `0x${(block % 997).toString(16).padStart(64, '0')}`,
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: `0x${block.toString(16).padStart(56, '0')}${logIndex.toString(16).padStart(8, '0')}`,
  transactionIndex: `0x${(logIndex % 7).toString(16)}`,
  blockHash: `0x${block.toString(16).padStart(64, 'b')}`,
  logIndex: `0x${logIndex.toString(16)}`,
  removed: false,
});
const CHAIN = [
  entry(20_000_000, 3),
  entry(33_623_226, 1),
  entry(36_258_280, 9),
  entry(40_000_000, 2),
  entry(45_768_216, 4),
  entry(48_202_680, 0),
  entry(HEAD - 10, 5),
];
const inRange = (logs, from, to) =>
  logs.filter((log) => {
    const block = parseInt(log.blockNumber, 16);
    return block >= from && block <= to;
  });
// Blockscout's row for an entry: topics padded to four with null, gas and
// time fields added, no blockHash or removed (see the captured fixture).
const blockscoutRow = ({ blockHash: _blockHash, removed: _removed, ...log }) => ({
  ...log,
  topics: [...log.topics, null],
  gasPrice: '0x8f0d1f53',
  gasUsed: '0x23aa4',
  timeStamp: '0x66fa04b3',
});

const FULL = 'full';
const CAPPED = 'capped';
const PUBLICNODE_CAP = { code: -32701, message: 'exceed maximum block range: 10000' };

let requests;
let blockscout;

// endpoints: name -> FULL | CAPPED | 'down' | function(from, to) -> logs.
// blockscoutBehaviour: 'chain' (answers from CHAIN), 'down', '429', 'lagging'
// (misses the newest log), 'missing' (misses an old log), 'hang', or a
// function(from, to) -> rows.
function useProviders(endpoints, blockscoutBehaviour = 'chain') {
  const urls = Object.keys(endpoints).map((name) => `https://${name}.example`);
  mockRegistry.getNetwork.mockReturnValue({
    access: { readOrder: ['myotis', 'colibri', 'quorum', 'direct'] },
    quorum: { k: 3, m: 2, timeoutMs: 5000 },
  });
  mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
    role === 'prover' ? ['https://prover.example'] : urls
  );
  blockscout = { calls: [] };
  requests = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    if (String(url).startsWith('https://gnosis.blockscout.com/')) {
      const query = Object.fromEntries(new URL(url).searchParams);
      blockscout.calls.push(query);
      requests.push('blockscout');
      const from = Number(query.fromBlock);
      const to = Number(query.toBlock);
      let rows;
      if (blockscoutBehaviour?.delayMs) {
        // A slow-but-answering Blockscout: each page after delayMs.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, blockscoutBehaviour.delayMs);
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
        rows = blockscoutBehaviour.rows
          ? blockscoutBehaviour.rows(from, to)
          : inRange(CHAIN, from, to).map(blockscoutRow);
      } else if (typeof blockscoutBehaviour === 'function') rows = blockscoutBehaviour(from, to);
      else if (blockscoutBehaviour === 'down') throw new TypeError('fetch failed');
      else if (blockscoutBehaviour === 'hang') {
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        );
      } else if (blockscoutBehaviour === '429') {
        return {
          ok: false,
          status: 429,
          url,
          headers: { get: (name) => (name === 'x-ratelimit-reset' ? '344628' : null) },
          text: async () => '{"message":"Too many requests","result":null,"status":"0"}',
        };
      } else {
        let logs = inRange(CHAIN, from, to);
        if (blockscoutBehaviour === 'lagging') logs = logs.filter((log) => log !== CHAIN[6]);
        if (blockscoutBehaviour === 'missing') logs = logs.filter((log) => log !== CHAIN[1]);
        rows = logs.map(blockscoutRow);
      }
      const body = rows.length
        ? { status: '1', message: 'OK', result: rows }
        : { status: '0', message: 'No logs found', result: [] };
      return {
        ok: true,
        status: 200,
        url: 'https://gnosisscan.io/api',
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
      };
    }
    const name = new URL(url).hostname.split('.')[0];
    const { method, params } = JSON.parse(init.body);
    expect(method).toBe('eth_getLogs');
    const from = parseInt(params[0].fromBlock, 16);
    const to = parseInt(params[0].toBlock, 16);
    requests.push(`${name}:${to - from + 1}`);
    const behaviour = endpoints[name];
    if (behaviour === 'down') throw new TypeError('fetch failed');
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (behaviour === CAPPED && to - from + 1 > 10_000) return json({ error: PUBLICNODE_CAP });
    const result = typeof behaviour === 'function' ? behaviour(from, to) : inRange(CHAIN, from, to);
    if (result?.rpcError) return json({ error: result.rpcError });
    if (result instanceof Promise) {
      // A hung endpoint: nothing until the client gives up.
      await new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        )
      );
    }
    return json({ result });
  });
}

const params = (from, to) => [
  {
    address: XBZZ,
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${to.toString(16)}`,
    topics: [ERC20_TRANSFER_TOPIC, WALLET],
  },
];

// One eth_getLogs the way the bridge routes it; what Ant receives.
async function bridgeGetLogs(from, to, { signal } = {}) {
  let outcome;
  router
    .request(100, 'eth_getLogs', params(from, to), {
      background: true,
      ...LOG_SCAN_ROUTER_OPTIONS,
      ...(signal ? { signal } : {}),
    })
    .then(
      (answer) => {
        outcome = { result: answer.result, source: answer.source, verified: answer.verified };
      },
      (error) => {
        const { message } = antErrorReply('eth_getLogs', error);
        outcome = { error: message, shrinks: antShrinksLogScanOn(message), cause: error };
      }
    );
  for (let waited = 0; !outcome && waited <= 120_000; waited += 100) {
    await jest.advanceTimersByTimeAsync(waited === 0 ? 0 : 100);
  }
  if (!outcome) throw new Error('request never settled');
  return outcome;
}

// Ant's scan_logs_with over [from, to].
async function antWalletScan(from = DEPLOY_BLOCK, to = HEAD, { maxWindows = 20_000 } = {}) {
  requests = [];
  const answers = [];
  const logs = [];
  let start = from;
  let chunk = Math.min(INITIAL_SCAN_CHUNK, to - from + 1);
  let antRequests = 0;
  while (start <= to) {
    if (antRequests >= maxWindows) return { stopped: 'window budget', antRequests, logs, answers };
    const end = Math.min(start + chunk - 1, to);
    antRequests += 1;
    const got = await bridgeGetLogs(start, end);
    if (got.result) {
      logs.push(...got.result);
      answers.push({ span: end - start + 1, source: got.source, verified: got.verified });
      start = end + 1;
      chunk = Math.min(chunk * 2, INITIAL_SCAN_CHUNK);
    } else if (got.shrinks && chunk > 1) {
      chunk = Math.max(1, Math.floor(chunk / 2));
    } else {
      return { stopped: got.error, antRequests, logs, answers };
    }
  }
  return { antRequests, logs, answers };
}

const DEFAULTS = { gnosischain: FULL, publicnode: CAPPED, drpc: CAPPED };
const sameLogs = (logs) => expect(logs).toEqual(CHAIN);

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  router.clearAdaptiveRoutingForTest();
});
afterEach(() => {
  jest.useRealTimers();
  delete global.fetch;
});

describe('a first wallet scan with Blockscout', () => {
  test('three requests from Ant instead of window by window, every answer verified', async () => {
    useProviders(DEFAULTS);
    const scan = await antWalletScan();
    sameLogs(scan.logs);
    // 1: the quorum learns publicnode's and dRPC's caps and refuses the span;
    // Ant halves. 2 and 3: Blockscout + rpc.gnosischain.com agree on each half,
    // the quorum verifies its newest 1,000 blocks.
    expect(scan.antRequests).toBe(3);
    expect(scan.answers.map((answer) => answer.source)).toEqual(['blockscout', 'blockscout']);
    expect(scan.answers.every((answer) => answer.verified)).toBe(true);
    expect(blockscout.calls).toHaveLength(2);
    expect(requests.filter((name) => name === 'blockscout')).toHaveLength(2);
    // Ant's own request count at most, plus the quorum's and the pair's RPCs.
    expect(requests.length).toBeLessThan(20);
  });

  test('without Blockscout (down), the same scan is read window by window', async () => {
    useProviders(DEFAULTS, 'down');
    const scan = await antWalletScan(DEFAULT_SLOW_FROM, HEAD);
    expect(scan.logs).toEqual(inRange(CHAIN, DEFAULT_SLOW_FROM, HEAD));
    expect(scan.antRequests).toBeGreaterThan(20);
    expect(scan.stopped).toBeUndefined();
    expect(scan.answers.every((answer) => answer.source === 'quorum')).toBe(true);
    expect(scan.answers.every((answer) => answer.span <= 10_000)).toBe(true);
    // Blockscout was asked once, failed, and was then left alone.
    expect(blockscout.calls).toHaveLength(1);
  });

  test("Blockscout pairs only with the span's leading part: the newest blocks go to the quorum", async () => {
    useProviders(DEFAULTS);
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD); // teaches the caps
    requests = [];
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got).toMatchObject({ source: 'blockscout', verified: true });
    expect(got.result).toEqual(CHAIN);
    const pairSpan = HEAD - 1000 - DEPLOY_BLOCK + 1;
    expect(blockscout.calls[blockscout.calls.length - 1]).toMatchObject({
      fromBlock: String(DEPLOY_BLOCK),
      toBlock: String(HEAD - 1000),
      topic1: WALLET,
      topic0_1_opr: 'and',
    });
    expect(requests.sort()).toEqual(
      [
        'blockscout',
        `gnosischain:${pairSpan}`,
        'drpc:1000',
        'gnosischain:1000',
        'publicnode:1000',
      ].sort()
    );
  });

  test('the RPC entries (with blockHash) are what Ant gets, not the mapped Blockscout rows', async () => {
    useProviders(DEFAULTS);
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got.result[0].blockHash).toBe(CHAIN[0].blockHash);
    expect(blockscoutLogToRpcLog(blockscoutRow(CHAIN[0])).blockHash).toBeUndefined();
  });
});

// Where the slow-path case starts: a narrow history keeps the window-by-window
// replay quick while still needing many windows.
const DEFAULT_SLOW_FROM = HEAD - 200_000;

describe('Blockscout is a shortcut: anything wrong falls back to the quorum path', () => {
  test.each([
    ['down', 'down'],
    ['rate limited (429)', '429'],
    ['missing an old log', 'missing'],
  ])('Blockscout %s: Ant halves to windows the quorum verifies', async (_label, behaviour) => {
    useProviders(DEFAULTS, behaviour);
    const first = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(first).toMatchObject({ shrinks: true });
    const second = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    // The quorum's refusal, as without Blockscout: Ant halves on it.
    expect(second).toMatchObject({
      error: 'Chain request failed: query exceeds max block range 10000',
      shrinks: true,
    });
    expect(blockscout.calls).toHaveLength(1);
    // Left alone afterwards: the next wide window costs no Blockscout request.
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD - 1);
    expect(blockscout.calls).toHaveLength(1);
  });

  test('a 429 leaves Blockscout alone for the reset it names, then it is asked again', async () => {
    useProviders(DEFAULTS, '429');
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(blockscout.calls).toHaveLength(1);
    jest.setSystemTime(Date.now() + 344_000);
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(blockscout.calls).toHaveLength(1);
    jest.setSystemTime(Date.now() + 1_000);
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(blockscout.calls).toHaveLength(2);
  });

  test('a hung Blockscout fails within the scan budget and the quorum refusal follows', async () => {
    useProviders(DEFAULTS, 'hang');
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const started = Date.now();
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got).toMatchObject({ shrinks: true });
    expect(Date.now() - started).toBeLessThanOrEqual(LOG_SCAN_ROUTER_OPTIONS.quorumTimeoutMs + 100);
  });

  // A wallet with more than 1,000 transfers: Blockscout pages, slowly. The
  // scan budget bounds every page together, not each one.
  test('a slow multi-page Blockscout stays inside the scan budget, then is left alone', async () => {
    let page = 0;
    useProviders(DEFAULTS, {
      delayMs: 12_000,
      rows: (from) => {
        page += 1;
        return Array.from({ length: 1000 }, (_, i) => blockscoutRow(entry(from + i, page)));
      },
    });
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const started = Date.now();
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    // The quorum's own range refusal, not a timeout Ant would misread.
    expect(got).toMatchObject({
      error: 'Chain request failed: query exceeds max block range 10000',
      shrinks: true,
    });
    expect(Date.now() - started).toBeLessThanOrEqual(LOG_SCAN_ROUTER_OPTIONS.quorumTimeoutMs + 100);
    const asked = blockscout.calls.length;
    expect(asked).toBeLessThanOrEqual(3);
    // Left alone: the next window does not wait on it again.
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD - 1);
    expect(blockscout.calls).toHaveLength(asked);
  });

  test("Blockscout answering late leaves the newest blocks' quorum only what is left", async () => {
    let tailHangs = false;
    // Every endpoint answers wide spans as before, but hangs on the newest
    // blocks once the caps are learned.
    const hangingTail =
      (capped = false) =>
      (from, to) => {
        if (capped && to - from + 1 > 10_000) return { rpcError: PUBLICNODE_CAP };
        if (tailHangs && to - from + 1 <= 1000) return new Promise(() => {});
        return inRange(CHAIN, from, to);
      };
    useProviders(
      { gnosischain: hangingTail(), publicnode: hangingTail(true), drpc: hangingTail(true) },
      { delayMs: 24_000 }
    );
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    tailHangs = true;
    const started = Date.now();
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got.result).toBeUndefined();
    expect(blockscout.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThanOrEqual(LOG_SCAN_ROUTER_OPTIONS.quorumTimeoutMs + 100);
  });

  test('a Blockscout slower than the whole budget is cut off before the newest-block quorum', async () => {
    useProviders(DEFAULTS, { delayMs: 28_000 });
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const started = Date.now();
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got).toMatchObject({ shrinks: true });
    expect(got.error).not.toContain('timeout');
    expect(Date.now() - started).toBeLessThanOrEqual(LOG_SCAN_ROUTER_OPTIONS.quorumTimeoutMs + 100);
  });

  test('the caller giving up while Blockscout reads leaves Blockscout alone for a while', async () => {
    useProviders(DEFAULTS, 'hang');
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD, { signal: controller.signal });
    expect(blockscout.calls).toHaveLength(1);
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(blockscout.calls).toHaveLength(1);
    jest.setSystemTime(Date.now() + 61_000);
    useProviders(DEFAULTS);
    expect((await bridgeGetLogs(DEPLOY_BLOCK, HEAD)).source).toBe('blockscout');
  });

  test('a hung full-history RPC: the pair gives up within the scan budget, Blockscout unasked', async () => {
    let wide = 0;
    const hangsOnSecondWide = (from, to) =>
      to - from + 1 > 10_000 && ++wide >= 2 ? new Promise(() => {}) : inRange(CHAIN, from, to);
    useProviders({ ...DEFAULTS, gnosischain: hangsOnSecondWide });
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const started = Date.now();
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got).toMatchObject({ shrinks: true });
    expect(Date.now() - started).toBeLessThanOrEqual(LOG_SCAN_ROUTER_OPTIONS.quorumTimeoutMs + 100);
    expect(blockscout.calls).toHaveLength(0);
  });

  test('Blockscout behind the head by less than the quorum tail still agrees', async () => {
    useProviders(DEFAULTS, 'lagging');
    const scan = await antWalletScan();
    sameLogs(scan.logs);
    expect(scan.antRequests).toBe(3);
  });

  // #496: the full-history RPC cuts a large answer to its newest blocks with
  // no error. Disagreeing with Blockscout's complete answer fails the pair.
  test('a silently truncated RPC answer is never accepted', async () => {
    const truncating = (from, to) => inRange(CHAIN, Math.max(from, to - 474), to);
    useProviders({ ...DEFAULTS, gnosischain: truncating });
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got.result).toBeUndefined();
    expect(got).toMatchObject({ shrinks: true });
  });

  test("a capped Blockscout page Blockscout's cap hides is caught by the RPC disagreeing", async () => {
    // A Blockscout that silently caps below 1,000 (say a future 2-log cap).
    useProviders(DEFAULTS, (from, to) => inRange(CHAIN, from, to).slice(0, 2).map(blockscoutRow));
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got.result).toBeUndefined();
    expect(got.shrinks).toBe(true);
  });

  test('no full-history RPC to pair with: Blockscout is not asked', async () => {
    useProviders({ a: CAPPED, b: CAPPED, c: CAPPED });
    // The first scan's quorum ends at a's and b's refusals, before c's: c's
    // cap is still unknown, so the second scan pairs it and c refuses.
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got).toMatchObject({ shrinks: true });
    expect(requests.filter((name) => name.startsWith('c:'))).toHaveLength(2);
    // Blockscout is asked only once an RPC answered the span.
    expect(blockscout.calls).toHaveLength(0);
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(requests.filter((name) => name.startsWith('c:'))).toHaveLength(2);
    expect(blockscout.calls).toHaveLength(0);
  });

  test('the pair RPC failing: the quorum refusal follows, Blockscout is not cooled down', async () => {
    let pairCalls = 0;
    const flaky = (from, to) => {
      if (to - from + 1 > 10_000 && ++pairCalls === 2) throw new Error('boom');
      return inRange(CHAIN, from, to);
    };
    useProviders({ ...DEFAULTS, gnosischain: flaky });
    // fetch rejecting inside the behaviour = a transport failure.
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const failed = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(failed).toMatchObject({ shrinks: true });
    jest.setSystemTime(Date.now() + 31_000); // past the endpoint's own cooldown
    const again = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(again).toMatchObject({ source: 'blockscout' });
  });
});

describe('Blockscout is asked only when the quorum cannot verify the span', () => {
  test('two full-history RPCs: the quorum answers and Blockscout is never asked', async () => {
    useProviders({ a: FULL, b: FULL, c: CAPPED });
    const scan = await antWalletScan();
    sameLogs(scan.logs);
    expect(scan.antRequests).toBe(1);
    expect(scan.answers[0].source).toBe('quorum');
    expect(blockscout.calls).toHaveLength(0);
  });

  test('a routine tail scan stays with the quorum', async () => {
    useProviders(DEFAULTS);
    await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    const got = await bridgeGetLogs(HEAD - 999, HEAD);
    expect(got).toMatchObject({ source: 'quorum', result: [CHAIN[6]] });
    expect(blockscout.calls).toHaveLength(0);
  });

  test('a page (no includeSources) never reaches Blockscout', async () => {
    useProviders(DEFAULTS);
    const { includeSources, ...pageLike } = LOG_SCAN_ROUTER_OPTIONS;
    expect(includeSources).toEqual(['blockscout']);
    for (let i = 0; i < 2; i += 1) {
      await router
        .request(100, 'eth_getLogs', params(DEPLOY_BLOCK, HEAD), pageLike)
        .catch(() => {});
    }
    expect(blockscout.calls).toHaveLength(0);
  });

  test("other filters (Ant's BatchCreated lookup) never reach Blockscout", async () => {
    useProviders(DEFAULTS);
    const batchCreated = [{ ...params(DEPLOY_BLOCK, HEAD)[0], topics: [`0x${'5'.repeat(64)}`] }];
    for (let i = 0; i < 2; i += 1) {
      await router
        .request(100, 'eth_getLogs', batchCreated, { background: true, ...LOG_SCAN_ROUTER_OPTIONS })
        .catch(() => {});
    }
    expect(blockscout.calls).toHaveLength(0);
  });

  test('a read order without the quorum leaves Blockscout out too', async () => {
    useProviders(DEFAULTS);
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['myotis', 'colibri', 'direct'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    const got = await bridgeGetLogs(DEPLOY_BLOCK, HEAD);
    expect(got.error).toContain('No chain source left for eth_getLogs');
    expect(blockscout.calls).toHaveLength(0);
  });
});
