/**
 * The IPFS cost measurement's verdicts and report (ipfs-cost-report.js;
 * freedom-core design 0007, "Cost"): the gates' arithmetic, whether a miss
 * fails the run in each mode, and the step summary's table in each.
 */

const {
  GATES,
  costEnforced,
  costTable,
  gateOutcome,
  gateVerdicts,
  summarize,
} = require('./ipfs-cost-report');

/** A run's results as the measurement writes them, with these verdicts. */
function results({ enforced, firstByteMs, throughputMibs }) {
  const gates = gateVerdicts({ firstByteMs, throughputMibs });
  return {
    enforced,
    target: 'linux-x64',
    cpu: 'Test CPU',
    cpus: 4,
    node: '24.0.0',
    ttfb: {
      rounds: 3,
      addon: summarize(firstByteMs.addon, 3),
      ipfsd: summarize(firstByteMs.ipfsd, 3),
      ...gates.firstByte,
    },
    throughput: {
      rounds: 3,
      addon: summarize(throughputMibs.addon, 1),
      ipfsd: summarize(throughputMibs.ipfsd, 1),
      ...gates.throughput,
    },
    fanout: {
      assets: 96,
      concurrency: 48,
      rounds: 3,
      addon: summarize([170, 175, 180], 1),
      ipfsd: summarize([30, 40, 50], 1),
      coldMs: { addon: 220, ipfsd: 200 },
    },
  };
}

const PASSING = {
  firstByteMs: { addon: [2, 2.1, 2.2], ipfsd: [6.9, 7.1, 7.2] },
  throughputMibs: { addon: [100, 110, 120], ipfsd: [80, 88, 90] },
};
const MISSING = {
  firstByteMs: { addon: [2, 2.1, 2.2], ipfsd: [7.1, 7.2, 7.3] },
  throughputMibs: { addon: [100, 110, 120], ipfsd: [80, 87, 90] },
};

test("the gates are 0007's, on the medians", () => {
  expect(GATES).toEqual({ firstByteMs: 5, throughputRatio: 0.8 });
  // 7.1 - 2.1 is exactly 5 ms later, and 88 of 110 exactly 80 %: both pass.
  expect(gateVerdicts(PASSING)).toEqual({
    firstByte: { deltaMs: 5, gateMs: 5, pass: true },
    throughput: { ratio: 0.8, gate: 0.8, pass: true },
  });
  expect(gateVerdicts(MISSING)).toEqual({
    firstByte: { deltaMs: 5.1, gateMs: 5, pass: false },
    throughput: { ratio: 0.7909, gate: 0.8, pass: false },
  });
});

test('FREEDOM_IPFS_COST_ENFORCE: unset or 1 enforces, 0 reports, and anything else is a mistake', () => {
  expect(costEnforced({})).toBe(true);
  expect(costEnforced({ FREEDOM_IPFS_COST_ENFORCE: '' })).toBe(true);
  expect(costEnforced({ FREEDOM_IPFS_COST_ENFORCE: '1' })).toBe(true);
  expect(costEnforced({ FREEDOM_IPFS_COST_ENFORCE: '0' })).toBe(false);
  for (const value of ['false', 'no', '2']) {
    expect(() => costEnforced({ FREEDOM_IPFS_COST_ENFORCE: value })).toThrow(
      'FREEDOM_IPFS_COST_ENFORCE must be 0 or 1'
    );
  }
});

test('a miss fails the run only where the gates are enforced; the verdict is the same', () => {
  expect(gateOutcome(true, true)).toEqual({ verdict: 'PASS', failsRun: false });
  expect(gateOutcome(false, true)).toEqual({ verdict: '**FAIL**', failsRun: true });
  expect(gateOutcome(true, false)).toEqual({ verdict: 'PASS', failsRun: false });
  expect(gateOutcome(false, false)).toEqual({ verdict: '**FAIL**', failsRun: false });
});

describe('the step summary', () => {
  const row = (markdown, start) => markdown.split('\n').find((line) => line.startsWith(start));

  test('enforced: no note, and each gate marked PASS or FAIL', () => {
    const passing = costTable(results({ enforced: true, ...PASSING }));
    expect(passing).not.toMatch(/reported, not enforced/);
    expect(row(passing, '| First byte')).toMatch(/\(\+5 ms\) \| PASS \|$/);
    expect(row(passing, '| Throughput')).toMatch(/\(80 %\) \| PASS \|$/);

    const missing = costTable(results({ enforced: true, ...MISSING }));
    expect(row(missing, '| First byte')).toMatch(/\(\+5\.1 ms\) \| \*\*FAIL\*\* \|$/);
    expect(row(missing, '| Throughput')).toMatch(/\(79\.1 %\) \| \*\*FAIL\*\* \|$/);
  });

  test('report-only: a line above the table says so, and a miss is still marked FAIL', () => {
    const markdown = costTable(results({ enforced: false, ...MISSING }));
    const lines = markdown.split('\n');
    const note = lines.findIndex((line) =>
      line.startsWith("0007's gates are reported, not enforced, until the default switch")
    );
    const header = lines.findIndex((line) => line.startsWith('| Measure |'));
    expect(note).toBeGreaterThan(0);
    expect(note).toBeLessThan(header);
    expect(row(markdown, '| First byte')).toMatch(/\*\*FAIL\*\* \|$/);
    expect(row(markdown, '| Throughput')).toMatch(/\*\*FAIL\*\* \|$/);
    expect(row(markdown, '| #102 fan-out, cached')).toMatch(/\| 175 \| 40 \| reported \| \|$/);
  });
});
