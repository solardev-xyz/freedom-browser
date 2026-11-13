/**
 * The Radicle cost measurement's arithmetic and report
 * (`src/main/radicle/radicle-backend.cost.test.js`; freedom-core design
 * 0008, "Gates"): the two gates' verdicts, a missed gate's second
 * measurement, whether a miss fails the run, the message a miss fails with,
 * and the step summary's table. The summaries and the pooled second
 * measurement are the IPFS measurement's (`ipfs-cost-report.js`), with
 * Radicle's gates.
 *
 * 0008's gates guard freedom-radicled before it becomes the default: unset,
 * or '1', FREEDOM_RADICLE_COST_ENFORCE fails the run on a miss, as CI and a
 * local run want; '0' reports each gate's verdict without failing on a miss.
 */

const { gateOutcome, median, round } = require('./ipfs-cost-report');

/** 0008, Gates: freedom-radicled's median `rad:` metadata read (`repo_info`
 * plus `tree_at`) at most 5 ms slower than the add-on's, and its median time
 * to the last byte of a 1 MiB text blob through `/blob/` at most 10 ms. */
const GATES = Object.freeze({ metadataMs: 5, blobMs: 10 });

/** What each gate measures, for the table and a miss's message. */
const MEASURES = Object.freeze({
  metadataMs: 'rad: metadata read (repo_info + tree_at), to the last byte',
  blobMs: 'rad: /blob/ of a 1 MiB text file, to the last byte',
});

/** Whether a gate's miss fails the run: FREEDOM_RADICLE_COST_ENFORCE, '1' or
 * unset to enforce, '0' to report only. Anything else is a mistake. */
function costEnforced(env = process.env) {
  const value = env.FREEDOM_RADICLE_COST_ENFORCE;
  if (value === undefined || value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new Error(`FREEDOM_RADICLE_COST_ENFORCE must be 0 or 1, not ${JSON.stringify(value)}`);
}

/** Each gate on the samples (`{ addon, radicled }` of ms, by gate): both
 * medians, the service's delta, and whether it passes. Judged on the
 * unrounded medians: the rounded values are the report's, so a value just
 * past a limit can't round onto it and pass. */
function gateVerdicts(samples) {
  const verdicts = {};
  for (const [name, gateMs] of Object.entries(GATES)) {
    const addon = median(samples[name].addon);
    const radicled = median(samples[name].radicled);
    const delta = radicled - addon;
    verdicts[name] = {
      addonMs: round(addon, 3),
      radicledMs: round(radicled, 3),
      deltaMs: round(delta, 3),
      gateMs,
      pass: delta <= gateMs,
    };
  }
  return verdicts;
}

/**
 * The gates on `samples`, a missed one measured once more:
 * `remeasure(name)` resolves to new samples for `samples[name]`, and the
 * gate is judged on both runs' samples pooled, as the IPFS measurement
 * judges its own (`ipfs-cost-report.js`): a pass stands as measured, and a
 * miss is overturned only by the samples taken together, never by a luckier
 * run alone. Resolves to the samples judged and the verdicts, each saying
 * whether it was `remeasured`, and if so its `firstRun`.
 */
async function judgeGates(samples, remeasure) {
  const firstRun = gateVerdicts(samples);
  const judged = { ...samples };
  for (const name of Object.keys(GATES)) {
    if (firstRun[name].pass) continue;
    const more = await remeasure(name);
    judged[name] = {
      addon: [...samples[name].addon, ...more.addon],
      radicled: [...samples[name].radicled, ...more.radicled],
    };
  }
  const gates = gateVerdicts(judged);
  for (const name of Object.keys(GATES)) {
    gates[name].remeasured = judged[name] !== samples[name];
    if (gates[name].remeasured) gates[name].firstRun = firstRun[name];
  }
  return { samples: judged, gates };
}

const signed = (value) => `${value >= 0 ? '+' : ''}${value}`;

/** A gate's verdict in words, with both medians: what a miss fails with. */
function gateMessage(name, gate, target) {
  const verdict = gate.pass ? 'within' : 'over';
  const pooled = gate.remeasured
    ? ` (two runs pooled; the first alone was ${signed(gate.firstRun.deltaMs)} ms)`
    : '';
  return (
    `${target}: ${MEASURES[name]}: freedom-radicled's median is ${gate.radicledMs} ms and ` +
    `the add-on's ${gate.addonMs} ms, ${signed(gate.deltaMs)} ms${pooled}, ${verdict} ` +
    `0008's gate of at most ${gate.gateMs} ms slower`
  );
}

/** The step summary's Markdown for a run's `results`. */
function costTable(results) {
  const { metadata, blob } = results;
  const mark = ({ pass, remeasured }) =>
    `${gateOutcome(pass, results.enforced).verdict}${remeasured ? ' (re-measured)' : ''}`;
  const row = (label, measure) =>
    `| ${label}: median ms (p10–p90) | ${measure.addon.median} ` +
    `(${measure.addon.p10}–${measure.addon.p90}) | ${measure.radicled.median} ` +
    `(${measure.radicled.p10}–${measure.radicled.p90}) | at most ${measure.gateMs} ms slower ` +
    `(${signed(measure.deltaMs)} ms) | ${mark(measure)} |`;
  const firstRuns = [
    metadata.remeasured && `metadata ${signed(metadata.firstRun.deltaMs)} ms`,
    blob.remeasured && `blob ${signed(blob.firstRun.deltaMs)} ms`,
  ].filter(Boolean);
  return [
    `### freedom-radicled against the add-on (${results.target})`,
    '',
    ...(results.enforced
      ? []
      : ["0008's gates are reported, not enforced (FREEDOM_RADICLE_COST_ENFORCE=0).", '']),
    `${results.cpu}, ${results.cpus} CPUs, Node ${results.node}. Interleaved rounds after ` +
      `warm-up: ${metadata.rounds} metadata, ${blob.rounds} blob.`,
    '',
    '| Measure | add-on | freedom-radicled | Gate (0008, Gates) | Result |',
    '|---|---:|---:|---|---|',
    row('`rad:` metadata read (`repo_info` + `tree_at`)', metadata),
    row(`\`rad:\` \`/blob/\`, ${blob.bytes} bytes of text, to the last byte`, blob),
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
  MEASURES,
  costEnforced,
  costTable,
  gateMessage,
  gateVerdicts,
  judgeGates,
};
