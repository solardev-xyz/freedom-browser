/**
 * The IPFS cost measurement's verdicts and report (ipfs-cost-report.js;
 * freedom-core design 0007, "Cost"): the gates' arithmetic, a missed gate's
 * second measurement, whether a miss fails the run in each mode, and the
 * step summary's table in each.
 */

const {
  GATES,
  costEnforced,
  costTable,
  gateOutcome,
  gateVerdicts,
  judgeGates,
  summarize,
} = require('./ipfs-cost-report');

/** A run's results as the measurement writes them, with these verdicts. */
function results({ enforced, firstByteMs, throughputMibs, gates: judged }) {
  const gates = judged || gateVerdicts({ firstByteMs, throughputMibs });
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

test('a value just past a limit fails, though the report rounds it onto the limit', () => {
  const justPast = gateVerdicts({
    firstByteMs: { addon: [2, 2, 2], ipfsd: [7.0004, 7.0004, 7.0004] },
    throughputMibs: { addon: [100, 100, 100], ipfsd: [79.999, 79.999, 79.999] },
  });
  expect(justPast).toEqual({
    firstByte: { deltaMs: 5, gateMs: 5, pass: false },
    throughput: { ratio: 0.8, gate: 0.8, pass: false },
  });
});

describe('a missed gate, measured once more', () => {
  const remeasureWith = (more) => jest.fn(async (name) => more[name]);

  test('a pass stands as measured: nothing is measured again', async () => {
    const remeasure = remeasureWith({});
    const { samples, gates } = await judgeGates(PASSING, remeasure);

    expect(remeasure).not.toHaveBeenCalled();
    expect(samples).toEqual(PASSING);
    expect(gates).toEqual({
      firstByte: { ...gateVerdicts(PASSING).firstByte, remeasured: false },
      throughput: { ...gateVerdicts(PASSING).throughput, remeasured: false },
    });
  });

  test("only the missed gate's samples are taken again, once, and judged pooled", async () => {
    const first = { firstByteMs: PASSING.firstByteMs, throughputMibs: MISSING.throughputMibs };
    const remeasure = remeasureWith({
      throughputMibs: { addon: [100, 110, 120], ipfsd: [90, 95, 100] },
    });
    const { samples, gates } = await judgeGates(first, remeasure);

    expect(remeasure.mock.calls).toEqual([['throughputMibs']]);
    expect(samples.firstByteMs).toBe(PASSING.firstByteMs);
    expect(samples.throughputMibs).toEqual({
      addon: [100, 110, 120, 100, 110, 120],
      ipfsd: [80, 87, 90, 90, 95, 100],
    });
    // 90 of 110: the pooled medians pass where the first run's 79.1 % missed.
    expect(gates.throughput).toEqual({
      ratio: 0.8182,
      gate: 0.8,
      pass: true,
      remeasured: true,
      firstRun: { ratio: 0.7909, gate: 0.8, pass: false },
    });
    expect(gates.firstByte).toMatchObject({ pass: true, remeasured: false });
  });

  test('a second run that passes alone still misses when the two pooled do', async () => {
    const remeasure = remeasureWith({
      firstByteMs: { addon: [2, 2, 2], ipfsd: [6, 6, 6] },
      throughputMibs: { addon: [100, 100, 100], ipfsd: [81, 82, 83] },
    });
    const { gates } = await judgeGates(
      {
        firstByteMs: { addon: [2, 2, 2], ipfsd: [8, 8, 9] },
        throughputMibs: { addon: [100, 100, 100], ipfsd: [70, 72, 74] },
      },
      remeasure
    );

    expect(remeasure).toHaveBeenCalledTimes(2);
    // Alone, the second runs pass (+4 ms, 82 %); pooled, +5 ms passes and
    // 77.5 % misses.
    expect(gates.firstByte).toMatchObject({ deltaMs: 5, pass: true, remeasured: true });
    expect(gates.throughput).toMatchObject({ ratio: 0.775, pass: false, remeasured: true });
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
      line.startsWith("0007's gates are reported, not enforced (FREEDOM_IPFS_COST_ENFORCE=0).")
    );
    const header = lines.findIndex((line) => line.startsWith('| Measure |'));
    expect(note).toBeGreaterThan(0);
    expect(note).toBeLessThan(header);
    expect(row(markdown, '| First byte')).toMatch(/\*\*FAIL\*\* \|$/);
    expect(row(markdown, '| Throughput')).toMatch(/\*\*FAIL\*\* \|$/);
    expect(row(markdown, '| #102 fan-out, cached')).toMatch(/\| 175 \| 40 \| reported \| \|$/);
  });

  test('a re-measured gate is marked, and a line below the table gives its first run', async () => {
    const plain = costTable(results({ enforced: true, ...PASSING }));
    expect(plain).not.toMatch(/re-measured|Re-measured/i);

    const { samples, gates } = await judgeGates(
      { firstByteMs: PASSING.firstByteMs, throughputMibs: MISSING.throughputMibs },
      async () => ({ addon: [100, 110, 120], ipfsd: [90, 95, 100] })
    );
    const markdown = costTable(results({ enforced: true, ...samples, gates }));

    expect(row(markdown, '| First byte')).toMatch(/\| PASS \|$/);
    expect(row(markdown, '| Throughput')).toMatch(/\(81\.8 %\) \| PASS \(re-measured\) \|$/);
    const lines = markdown.split('\n');
    const note = lines.findIndex((line) => line.startsWith('Re-measured:'));
    expect(note).toBeGreaterThan(
      lines.findIndex((line) => line.startsWith('| #102 fan-out, cold'))
    );
    expect(lines[note]).toBe(
      'Re-measured: a gate that missed on its first run (throughput 79.1 %) was measured ' +
        "once more, and is judged on both runs' samples together."
    );
  });
});
