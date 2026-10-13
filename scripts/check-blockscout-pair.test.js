/**
 * The Blockscout canary's scan loop and judgement, offline: the live run
 * (scripts/check-blockscout-pair.js, nightly) can only fail on what these
 * accept. A fake driver plays the core, `exchanges` the executors' record.
 */
const { SCANS, MAX_REQUESTS, antScan, judge } = require('./check-blockscout-pair');

const XBZZ = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const [POSTAGE] = SCANS;
// The core's refusal of a span no quorum can serve (as the router threw it).
const tooWide = (cap) =>
  Object.assign(new Error(`query exceeds max block range ${cap}`), { code: -32005 });
const PAGE = 'https://gnosisscan.io/api/v2/addresses/0x45a1/token-transfers?type=ERC-20&filter=to';
const RPC = 'https://rpc.gnosischain.com';

const log = (block, i = 0, topics = POSTAGE.topics) => ({
  address: XBZZ,
  topics: topics.map((topic) => topic ?? `0x${'11'.repeat(32)}`),
  blockNumber: `0x${block.toString(16)}`,
  transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
  logIndex: `0x${i.toString(16)}`,
});
const logs = (count, from = POSTAGE.fromBlock) =>
  Array.from({ length: count }, (_, i) => log(from + i * 10, i));

/**
 * A core that has just learned the endpoints' range caps from the first
 * scan it sees, refusing it if wider than 50,000 blocks, and answers every
 * other window with `answer({ from, to, exchanges })`, which records the
 * pages and RPC exchanges the answer would have made.
 */
function fakeCore(answer) {
  const exchanges = [];
  const asked = [];
  let learned = false;
  const driver = {
    request: jest.fn(async (chainId, method, [filter], options) => {
      expect([chainId, method, options]).toEqual([
        100,
        'eth_getLogs',
        { background: true, profile: 'ant_scan' },
      ]);
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
      asked.push([from, to]);
      if (!learned) {
        learned = true;
        if (to - from + 1 > 50_000) throw tooWide(50_000);
      }
      return answer({ from, to, exchanges });
    }),
  };
  return { driver, exchanges, asked };
}

/** A paired answer: `count` transfers in [from, to], read in pages of 50. */
const paired =
  (counts) =>
  ({ from, to, exchanges }) => {
    const count = counts.shift();
    exchanges.push({ url: RPC, method: 'eth_getLogs', status: 200 });
    for (let page = 0; page < Math.max(1, Math.ceil(count / 50)); page++) {
      exchanges.push({ url: PAGE, method: null, status: 200 });
    }
    const step = Math.max(1, Math.floor((to - from) / Math.max(count, 1)));
    return {
      result: Array.from({ length: count }, (_, i) => log(from + i * step, i)),
      source: 'blockscout',
      verified: true,
    };
  };

beforeEach(() => {
  // The live run's report.
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("the canary's scan loop: Ant's window halving", () => {
  test('a first scan: refused once as too wide, then each half paired', async () => {
    const core = fakeCore(paired([83, 83]));
    const scan = await antScan(core, POSTAGE, POSTAGE.toBlock);
    expect(core.asked).toEqual([
      [36_000_000, 36_299_999],
      [36_000_000, 36_149_999],
      [36_150_000, 36_299_999],
    ]);
    expect(scan.requests).toBe(3);
    expect(scan.refused).toHaveLength(1);
    expect(scan.answered.map(({ reply }) => reply.source)).toEqual(['blockscout', 'blockscout']);
    expect(judge(POSTAGE, POSTAGE.toBlock, scan)).toEqual([]);
  });

  test('a core that keeps refusing is Ant reading window by window: it gives up, saying so', async () => {
    const core = fakeCore(() => ({}));
    core.driver.request.mockImplementation(async () => {
      throw tooWide(10_000);
    });
    core.exchanges.push({ url: PAGE, method: null, status: 404 });
    const failure = await antScan(core, POSTAGE, POSTAGE.toBlock).catch((err) => err);
    expect(core.driver.request).toHaveBeenCalledTimes(MAX_REQUESTS);
    expect(failure.message).toMatch(
      /^still reading after 8 requests, in windows down to \d+ blocks \(last refusal: .*max block range 10000\): Ant would read this history window by window\. /
    );
    // Only what this scan asked of Blockscout counts.
    expect(failure.message).toMatch(/Blockscout not asked/);
  });

  test("an error Ant doesn't shrink on ends the scan, with what Blockscout answered", async () => {
    const core = fakeCore(() => ({}));
    core.driver.request.mockImplementation(async () => {
      core.exchanges.push({ url: PAGE, method: null, status: 301 });
      core.exchanges.push({ url: PAGE, method: null, status: 400 });
      throw new Error('All chain sources failed for eth_getLogs (quorum: no answer)');
    });
    const failure = await antScan(core, POSTAGE, POSTAGE.toBlock).catch((err) => err);
    expect(failure.message).toMatch(/^blocks 36000000\.\.36299999 failed: Chain request failed/);
    expect(failure.message).toMatch(/Blockscout asked 2 times \(HTTP 301, 400\)$/);
  });
});

describe("the canary's judgement", () => {
  const scanOf = (answered) => ({ requests: answered.length, answered, refused: [] });
  const window = (reply, pages = 4) => ({
    from: POSTAGE.fromBlock,
    to: POSTAGE.toBlock,
    reply,
    exchanges: Array.from({ length: pages }, () => ({ url: PAGE, method: null, status: 200 })),
  });

  test('every window paired and verified, enough pages, the exact transfers: no problems', () => {
    const scan = scanOf([window({ result: logs(166), source: 'blockscout', verified: true })]);
    expect(judge(POSTAGE, POSTAGE.toBlock, scan)).toEqual([]);
  });

  test('a window the quorum answered is the fallback, whatever it holds', () => {
    const scan = scanOf([window({ result: logs(166), source: 'quorum', verified: true }, 0)]);
    expect(judge(POSTAGE, POSTAGE.toBlock, scan)).toEqual([
      `blocks 36000000..36299999 were answered by quorum (verified true), not by Blockscout paired with an RPC`,
      '0 Blockscout pages read, expected at least 4',
    ]);
  });

  test('fewer pages, or a different count, is a problem', () => {
    const scan = scanOf([window({ result: logs(165), source: 'blockscout', verified: true }, 3)]);
    expect(judge(POSTAGE, POSTAGE.toBlock, scan)).toEqual([
      '3 Blockscout pages read, expected at least 4',
      '165 transfers, expected exactly 166',
    ]);
    const [, sent] = SCANS;
    const wallet = scanOf([
      window({ result: logs(10, 20_000_000), source: 'blockscout', verified: true }, 1),
    ]);
    expect(judge(sent, 48_000_000, wallet)).toContain('10 transfers, expected at least 11');
  });

  test("a transfer outside the scan, or one Ant didn't ask for, or twice, is a problem", () => {
    const outside = logs(166);
    outside[0] = log(35_999_999);
    expect(
      judge(
        POSTAGE,
        POSTAGE.toBlock,
        scanOf([window({ result: outside, source: 'blockscout', verified: true })])
      )
    ).toEqual([
      expect.stringMatching(/^a transfer outside the scan, or twice: .* in block 35999999$/),
    ]);
    const twice = logs(166);
    twice[1] = twice[0];
    expect(
      judge(
        POSTAGE,
        POSTAGE.toBlock,
        scanOf([window({ result: twice, source: 'blockscout', verified: true })])
      )
    ).toEqual([expect.stringMatching(/^a transfer outside the scan, or twice/)]);
    const otherRecipient = logs(166);
    otherRecipient[5] = log(36_000_050, 5, [POSTAGE.topics[0], null, `0x${'22'.repeat(32)}`]);
    expect(
      judge(
        POSTAGE,
        POSTAGE.toBlock,
        scanOf([window({ result: otherRecipient, source: 'blockscout', verified: true })])
      )
    ).toHaveLength(1);
  });
});
