/**
 * The Radicle cost measurement's verdicts and report (radicle-cost-report.js;
 * freedom-core design 0008, "Gates"): the gates' arithmetic, a missed gate's
 * second measurement, whether a miss fails the run in each mode, the message
 * a miss fails with, and the step summary's table in each.
 */

const { summarize } = require('./ipfs-cost-report');
const {
  GATES,
  costEnforced,
  costTable,
  gateMessage,
  gateVerdicts,
  judgeGates,
} = require('./radicle-cost-report');

/** A run's results as the measurement writes them, with these verdicts. */
function results({ enforced, samples, gates: judged }) {
  const gates = judged || gateVerdicts(samples);
  const measured = (name, extra) => ({
    ...extra,
    rounds: samples[name].addon.length,
    warmup: 10,
    addon: summarize(samples[name].addon, 3),
    radicled: summarize(samples[name].radicled, 3),
    ...gates[name],
  });
  return {
    enforced,
    target: 'linux-x64',
    cpu: 'Test CPU',
    cpus: 4,
    node: '24.0.0',
    metadata: measured('metadataMs', { bodyBytes: 900 }),
    blob: measured('blobMs', { bytes: 1048576, bodyBytes: 1070000 }),
  };
}

const PASSING = {
  metadataMs: { addon: [1, 2, 3], radicled: [6, 7, 8] },
  blobMs: { addon: [10, 11, 12], radicled: [20, 21, 22] },
};
const MISSING = {
  metadataMs: { addon: [1, 2, 3], radicled: [6, 7.1, 8] },
  blobMs: { addon: [10, 11, 12], radicled: [20, 21.5, 22] },
};

test("the gates are 0008's, on the medians", () => {
  expect(GATES).toEqual({ metadataMs: 5, blobMs: 10 });
  // 7 - 2 is exactly 5 ms slower, and 21 - 11 exactly 10: both pass.
  expect(gateVerdicts(PASSING)).toEqual({
    metadataMs: { addonMs: 2, radicledMs: 7, deltaMs: 5, gateMs: 5, pass: true },
    blobMs: { addonMs: 11, radicledMs: 21, deltaMs: 10, gateMs: 10, pass: true },
  });
  expect(gateVerdicts(MISSING)).toEqual({
    metadataMs: { addonMs: 2, radicledMs: 7.1, deltaMs: 5.1, gateMs: 5, pass: false },
    blobMs: { addonMs: 11, radicledMs: 21.5, deltaMs: 10.5, gateMs: 10, pass: false },
  });
  // A faster service passes with a negative delta.
  expect(
    gateVerdicts({
      metadataMs: { addon: [3, 3, 3], radicled: [1, 1, 1] },
      blobMs: { addon: [12, 12, 12], radicled: [9, 9, 9] },
    })
  ).toMatchObject({ metadataMs: { deltaMs: -2, pass: true }, blobMs: { deltaMs: -3, pass: true } });
});

test('a value just past a limit fails, though the report rounds it onto the limit', () => {
  expect(
    gateVerdicts({
      metadataMs: { addon: [2, 2, 2], radicled: [7.0004, 7.0004, 7.0004] },
      blobMs: { addon: [11, 11, 11], radicled: [21.0004, 21.0004, 21.0004] },
    })
  ).toEqual({
    metadataMs: { addonMs: 2, radicledMs: 7, deltaMs: 5, gateMs: 5, pass: false },
    blobMs: { addonMs: 11, radicledMs: 21, deltaMs: 10, gateMs: 10, pass: false },
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
      metadataMs: { ...gateVerdicts(PASSING).metadataMs, remeasured: false },
      blobMs: { ...gateVerdicts(PASSING).blobMs, remeasured: false },
    });
  });

  test("only the missed gate's samples are taken again, once, and judged pooled", async () => {
    const first = { metadataMs: PASSING.metadataMs, blobMs: MISSING.blobMs };
    const remeasure = remeasureWith({ blobMs: { addon: [10, 11, 12], radicled: [18, 19, 20] } });
    const { samples, gates } = await judgeGates(first, remeasure);

    expect(remeasure.mock.calls).toEqual([['blobMs']]);
    expect(samples.metadataMs).toBe(PASSING.metadataMs);
    expect(samples.blobMs).toEqual({
      addon: [10, 11, 12, 10, 11, 12],
      radicled: [20, 21.5, 22, 18, 19, 20],
    });
    // Pooled, the medians are 11 and 20: 9 ms, where the first run's 10.5 missed.
    expect(gates.blobMs).toEqual({
      addonMs: 11,
      radicledMs: 20,
      deltaMs: 9,
      gateMs: 10,
      pass: true,
      remeasured: true,
      firstRun: { addonMs: 11, radicledMs: 21.5, deltaMs: 10.5, gateMs: 10, pass: false },
    });
    expect(gates.metadataMs).toMatchObject({ pass: true, remeasured: false });
  });

  test('a second run that passes alone still misses when the two pooled do', async () => {
    const remeasure = remeasureWith({
      metadataMs: { addon: [2, 2, 2], radicled: [6, 6, 6] },
      blobMs: { addon: [11, 11, 11], radicled: [30, 30, 30] },
    });
    const { gates } = await judgeGates(
      {
        metadataMs: { addon: [2, 2, 2], radicled: [9, 9, 9] },
        blobMs: MISSING.blobMs,
      },
      remeasure
    );

    expect(remeasure.mock.calls).toEqual([['metadataMs'], ['blobMs']]);
    // 2 2 2 2 2 2 against 6 6 6 9 9 9: a median of 7.5, 5.5 ms slower.
    expect(gates.metadataMs).toMatchObject({ deltaMs: 5.5, pass: false, remeasured: true });
    expect(gates.blobMs).toMatchObject({ pass: false, remeasured: true });
  });
});

describe('whether a miss fails the run', () => {
  test('enforced unless FREEDOM_RADICLE_COST_ENFORCE is 0; anything else is refused', () => {
    expect(costEnforced({})).toBe(true);
    expect(costEnforced({ FREEDOM_RADICLE_COST_ENFORCE: '' })).toBe(true);
    expect(costEnforced({ FREEDOM_RADICLE_COST_ENFORCE: '1' })).toBe(true);
    expect(costEnforced({ FREEDOM_RADICLE_COST_ENFORCE: '0' })).toBe(false);
    for (const value of ['true', 'false', 'yes', 'no', '2', ' 0']) {
      expect(() => costEnforced({ FREEDOM_RADICLE_COST_ENFORCE: value })).toThrow(
        'FREEDOM_RADICLE_COST_ENFORCE must be 0 or 1'
      );
    }
  });
});

describe('the message', () => {
  test('a miss names the measure, both medians, the delta and the gate', () => {
    const { blobMs } = gateVerdicts(MISSING);
    expect(gateMessage('blobMs', blobMs, 'win32-x64')).toBe(
      "win32-x64: rad: /blob/ of a 1 MiB text file, to the last byte: freedom-radicled's " +
        "median is 21.5 ms and the add-on's 11 ms, +10.5 ms, over 0008's gate of at most " +
        '10 ms slower'
    );
  });

  test('a pass says it is within, and a pooled verdict gives the first run alone', async () => {
    const { gates } = await judgeGates(
      { ...PASSING, metadataMs: MISSING.metadataMs },
      async () => ({
        addon: [2, 2, 2],
        radicled: [3, 3, 3],
      })
    );
    expect(gateMessage('metadataMs', gates.metadataMs, 'darwin-arm64')).toBe(
      'darwin-arm64: rad: metadata read (repo_info + tree_at), to the last byte: ' +
        "freedom-radicled's median is 4.5 ms and the add-on's 2 ms, +2.5 ms (two runs " +
        "pooled; the first alone was +5.1 ms), within 0008's gate of at most 5 ms slower"
    );
  });
});

describe('the table', () => {
  test('enforced: both gates with both medians, their spread and verdicts', () => {
    const table = costTable(results({ enforced: true, samples: MISSING }));
    expect(table).toContain('### freedom-radicled against the add-on (linux-x64)');
    expect(table).not.toContain('reported, not enforced');
    expect(table).toContain(
      '| `rad:` metadata read (`repo_info` + `tree_at`): median ms (p10–p90) | 2 (1.2–2.8) | ' +
        '7.1 (6.22–7.82) | at most 5 ms slower (+5.1 ms) | **FAIL** |'
    );
    expect(table).toContain(
      '| `rad:` `/blob/`, 1048576 bytes of text, to the last byte: median ms (p10–p90) | ' +
        '11 (10.2–11.8) | 21.5 (20.3–21.9) | at most 10 ms slower (+10.5 ms) | **FAIL** |'
    );
    expect(table).not.toContain('Re-measured');
  });

  test('reported: a note says the gates are not enforced', () => {
    const table = costTable(results({ enforced: false, samples: PASSING }));
    expect(table).toContain(
      "0008's gates are reported, not enforced (FREEDOM_RADICLE_COST_ENFORCE=0)."
    );
    expect(table.match(/\| PASS \|/g)).toHaveLength(2);
  });

  test('a re-measured gate is marked, with its first run', async () => {
    const { samples, gates } = await judgeGates(
      { metadataMs: PASSING.metadataMs, blobMs: MISSING.blobMs },
      async () => ({ addon: [10, 11, 12], radicled: [18, 19, 20] })
    );
    const table = costTable(results({ enforced: true, samples, gates }));
    expect(table).toContain('| PASS (re-measured) |');
    expect(table).toContain(
      'Re-measured: a gate that missed on its first run (blob +10.5 ms) was measured once ' +
        "more, and is judged on both runs' samples together."
    );
  });
});
