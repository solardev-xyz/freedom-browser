/**
 * The IPFS cost measurement's arithmetic and report
 * (`src/main/ipfs/ipfs-backend.cost.test.js`; freedom-core design 0007,
 * "Cost"): the summaries of the samples, the two gates' verdicts, a missed
 * gate's second measurement, whether a miss fails the run, and the step
 * summary's table.
 *
 * 0007's gates guard freedom-ipfsd as the default: unset, or '1',
 * FREEDOM_IPFS_COST_ENFORCE fails the run on a miss, as CI and a local run
 * want; '0' reports each gate's verdict without failing on a miss.
 */

/** 0007, Cost: the median first byte at most 5 ms later, the median
 * throughput at least 80 % of the add-on's. */
const GATES = Object.freeze({ firstByteMs: 5, throughputRatio: 0.8 });

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

const median = (values) => quantile(values, 0.5);
const round = (value, places = 2) => Number(value.toFixed(places));

/** The median, p10 and p90 of `values`, and how many there were. */
function summarize(values, places = 2) {
  return {
    median: round(median(values), places),
    p10: round(quantile(values, 0.1), places),
    p90: round(quantile(values, 0.9), places),
    samples: values.length,
  };
}

/** Whether a gate's miss fails the run: FREEDOM_IPFS_COST_ENFORCE, '1' or
 * unset to enforce, '0' to report only. Anything else is a mistake. */
function costEnforced(env = process.env) {
  const value = env.FREEDOM_IPFS_COST_ENFORCE;
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new Error(`FREEDOM_IPFS_COST_ENFORCE must be 0 or 1, not ${JSON.stringify(value)}`);
}

/** The two gates on the samples: the first byte's median delta (ms) and the
 * throughput's median ratio, each with whether it passes. Judged on the
 * unrounded medians: the rounded values are the report's, so a value just
 * past a limit can't round onto it and pass. */
function gateVerdicts({ firstByteMs, throughputMibs }) {
  const delta = median(firstByteMs.ipfsd) - median(firstByteMs.addon);
  const ratio = median(throughputMibs.ipfsd) / median(throughputMibs.addon);
  return {
    firstByte: {
      deltaMs: round(delta, 3),
      gateMs: GATES.firstByteMs,
      pass: delta <= GATES.firstByteMs,
    },
    throughput: {
      ratio: round(ratio, 4),
      gate: GATES.throughputRatio,
      pass: ratio >= GATES.throughputRatio,
    },
  };
}

/** Which samples each gate judges. */
const GATE_SAMPLES = Object.freeze({ firstByte: 'firstByteMs', throughput: 'throughputMibs' });

/**
 * The gates on `samples`, a missed one measured once more:
 * `remeasure(name)` resolves to new samples for `samples[name]`, and the
 * gate is judged on both runs' samples pooled. Pooled, not the better run:
 * a pass stands as measured, and a miss is overturned only by the samples
 * taken together, never by a luckier run alone. Near a limit, that makes a
 * miss from runner noise rare, and passes a service truly past it about as
 * rarely as one run does. Resolves to the samples judged and the verdicts,
 * each saying whether it was `remeasured`, and if so its `firstRun`.
 */
async function judgeGates(samples, remeasure) {
  const firstRun = gateVerdicts(samples);
  const judged = { ...samples };
  for (const [gate, name] of Object.entries(GATE_SAMPLES)) {
    if (firstRun[gate].pass) continue;
    const more = await remeasure(name);
    judged[name] = {
      addon: [...samples[name].addon, ...more.addon],
      ipfsd: [...samples[name].ipfsd, ...more.ipfsd],
    };
  }
  const gates = gateVerdicts(judged);
  for (const [gate, name] of Object.entries(GATE_SAMPLES)) {
    gates[gate].remeasured = judged[name] !== samples[name];
    if (gates[gate].remeasured) gates[gate].firstRun = firstRun[gate];
  }
  return { samples: judged, gates };
}

/** A gate's verdict for the report, and whether it fails the run. */
function gateOutcome(pass, enforced) {
  return { verdict: pass ? 'PASS' : '**FAIL**', failsRun: enforced && !pass };
}

/** The step summary's Markdown for a run's `results`. */
function costTable(results) {
  const { ttfb, throughput, fanout } = results;
  const mark = ({ pass, remeasured }) =>
    `${gateOutcome(pass, results.enforced).verdict}${remeasured ? ' (re-measured)' : ''}`;
  const signed = (value) => `${value >= 0 ? '+' : ''}${value}`;
  const firstRuns = [
    ttfb.remeasured && `first byte ${signed(ttfb.firstRun.deltaMs)} ms`,
    throughput.remeasured && `throughput ${round(throughput.firstRun.ratio * 100, 1)} %`,
  ].filter(Boolean);
  return [
    `### freedom-ipfsd against the add-on (${results.target})`,
    '',
    ...(results.enforced
      ? []
      : ["0007's gates are reported, not enforced (FREEDOM_IPFS_COST_ENFORCE=0).", '']),
    `${results.cpu}, ${results.cpus} CPUs, Node ${results.node}. Interleaved rounds: ` +
      `${ttfb.rounds} first-byte, ${throughput.rounds} throughput, ${fanout.rounds} fan-out.`,
    '',
    '| Measure | add-on | freedom-ipfsd | Gate (0007, Cost) | Result |',
    '|---|---:|---:|---|---|',
    `| First byte, cached 1 KiB: median ms (p10–p90) | ${ttfb.addon.median} ` +
      `(${ttfb.addon.p10}–${ttfb.addon.p90}) | ${ttfb.ipfsd.median} ` +
      `(${ttfb.ipfsd.p10}–${ttfb.ipfsd.p90}) | at most ${ttfb.gateMs} ms later ` +
      `(${signed(ttfb.deltaMs)} ms) | ${mark(ttfb)} |`,
    `| Throughput, cached 100 MiB: median MiB/s (p10–p90) | ${throughput.addon.median} ` +
      `(${throughput.addon.p10}–${throughput.addon.p90}) | ${throughput.ipfsd.median} ` +
      `(${throughput.ipfsd.p10}–${throughput.ipfsd.p90}) | at least ` +
      `${round(throughput.gate * 100, 1)} % (${round(throughput.ratio * 100, 1)} %) | ` +
      `${mark(throughput)} |`,
    `| #102 fan-out, cached, ${fanout.assets} assets ${fanout.concurrency} at a time: ` +
      `median ms | ${fanout.addon.median} | ${fanout.ipfsd.median} | reported | |`,
    `| #102 fan-out, cold (from the loopback fixture): ms | ${fanout.coldMs.addon} | ` +
      `${fanout.coldMs.ipfsd} | reported | |`,
    '',
    ...(firstRuns.length
      ? [
          `Re-measured: a gate that missed on its first run (${firstRuns.join(', ')}) was ` +
            "measured once more, and is judged on both runs' samples together.",
          '',
        ]
      : []),
  ].join('\n');
}

module.exports = {
  GATES,
  costEnforced,
  costTable,
  gateOutcome,
  gateVerdicts,
  judgeGates,
  median,
  quantile,
  round,
  summarize,
};
