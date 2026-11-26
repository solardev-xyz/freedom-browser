/**
 * Main's operation grammar (swarm-grammar.js) against the pinned core's
 * `vectors/swarm-grammar.json` (freedom-core design 0015, The operation
 * grammar: "main's executor suite reads the same file and runs both
 * lists"), and the values main derives against `vectors/swarm.json`'s
 * feeds:
 * - the forms, the rows, their values and bounds are the file's, as main
 *   ships them (design 0015's SWM-5 plan, point 1: JavaScript, checked
 *   here, never loaded at runtime);
 * - `failed` is the file's set and `stopped`, the one difference in the
 *   tables, named below (plan point 7: 0015 and the core's wire.rs have
 *   it; the pinned file leaves it out, and the core's vectors are fixed);
 * - every honest scenario is admitted call by call, every forbidden one
 *   refused at its last call by its rule, all of them, not a sample;
 * - three scenarios of main's own rows are named below where the file
 *   contradicts itself or the design, each held to what main does;
 * - the head probe's runs, the next index, topics and identifiers are
 *   swarm.json's.
 *
 * Skipped unless the vectors are found (test/helpers/swarm-vectors.js):
 * FREEDOM_CORE_SWARM_VECTORS names freedom-core's `vectors` directory, as
 * CI does at the pinned commit, and then a missing file fails the suite.
 */

const {
  ERROR_REPLY,
  FAILED,
  FORMS,
  IndexLookup,
  HeadProbe,
  MAIN_HEADERS,
  REPLY_HEADERS,
  ROWS,
  RULES,
  VALUES,
  feedIdentifier,
  rowFor,
  topicOf,
} = require('./swarm-grammar');
const { param } = require('./swarm-typed');
const {
  playScenario,
  scenarioParams,
  swarmVectors,
  swarmVectorsRequired,
} = require('../../../test/helpers/swarm-vectors');

const grammar = swarmVectors('swarm-grammar.json');
const swarm = swarmVectors('swarm.json');
const dwebVerify = swarmVectors('dweb-verify.json');
const found = Boolean(grammar && swarm && dwebVerify);
const describeIfVectors = found ? describe : describe.skip;
const files = { grammar, swarm, dwebVerify };

(swarmVectorsRequired ? test : test.skip)(
  'the vectors FREEDOM_CORE_SWARM_VECTORS names are there',
  () => {
    expect(grammar?.honest?.length).toBeGreaterThan(0);
    expect(swarm?.methods?.length).toBeGreaterThan(0);
    expect(dwebVerify?.swarm?.files?.length).toBeGreaterThan(0);
  }
);

/**
 * The file's scenarios that main can't play as written, each with why and
 * what main does instead. Each applies while the file still has the fault
 * (`applies`), so a fixed file runs the scenario with the rest.
 */
const KNOWN = {
  // The reference was called with name 'draft.md' and contentType
  // 'text/markdown' (mainRows in the generator), but the scenario's params
  // name neither, so the row binds `<n>` = data and text/plain.
  'swarm.publish-data-batch-encrypt': {
    list: 'honest',
    applies: (s) =>
      param(s.params, 'name') === undefined && param(s.params, 'content_type') === undefined,
    refused: { at: 0, rule: 'value' },
  },
  // The reference was called with indexDocument 'x.txt', which the params
  // leave out; with no index.html part the row binds no index document.
  'swarm.publish-collection-batch-encrypt': {
    list: 'honest',
    applies: (s) => param(s.params, 'index_document') === undefined,
    refused: { at: 0, rule: 'header' },
  },
  // "a /stamps when the parent named its batch": the /stamps itself is the
  // call the row leaves out, so main refuses it, by the scenario's rule,
  // at its first call rather than its last.
  'swarm.publish-batch-and-stamps': {
    list: 'forbidden',
    applies: (s) => s.calls[0]?.form === 'stamps' && s.calls.length === 2,
    refused: { at: 0, rule: 'order' },
  },
};

const known = (list, s) => KNOWN[s.id]?.list === list && KNOWN[s.id].applies(s);

describeIfVectors("main's grammar against vectors/swarm-grammar.json", () => {
  test("the forms, rows, values and reply bounds are the file's", () => {
    expect(FORMS).toStrictEqual(grammar.forms);
    expect(ROWS).toStrictEqual(grammar.rows);
    expect(VALUES).toStrictEqual(grammar.values);
    expect(MAIN_HEADERS).toStrictEqual(grammar.main_headers);
    expect(REPLY_HEADERS).toStrictEqual(grammar.reply_headers);
    expect(ERROR_REPLY).toStrictEqual(grammar.error_reply);
    expect(RULES).toStrictEqual(grammar.rules);
  });

  test("failed is the file's set and stopped: the one known difference (0015 and wire.rs have stopped; the pinned file leaves it out)", () => {
    if (grammar.failed.includes('stopped')) {
      expect(FAILED).toStrictEqual(grammar.failed);
      return;
    }
    expect(FAILED).toStrictEqual([...grammar.failed, 'stopped']);
  });

  test('every honest scenario is admitted, call by call', () => {
    const refused = [];
    let played = 0;
    for (const s of grammar.honest) {
      if (known('honest', s)) continue;
      const verdict = playScenario(s, files);
      if (verdict) refused.push({ id: s.id, row: s.row, ...verdict });
      played += 1;
    }
    expect(refused).toStrictEqual([]);
    expect(played).toBe(
      grammar.honest.length - Object.values(KNOWN).filter((k) => k.list === 'honest').length
    );
    expect(played).toBeGreaterThanOrEqual(370);
  });

  test('every forbidden scenario is refused at its last call, by its rule', () => {
    const wrong = [];
    let played = 0;
    for (const s of grammar.forbidden) {
      if (known('forbidden', s)) continue;
      const verdict = playScenario(s, files);
      const want = { at: s.calls.length - 1, rule: s.rule };
      if (!verdict || verdict.at !== want.at || verdict.rule !== want.rule) {
        wrong.push({ id: s.id, want, got: verdict && { at: verdict.at, rule: verdict.rule } });
      }
      played += 1;
    }
    expect(wrong).toStrictEqual([]);
    expect(played).toBeGreaterThanOrEqual(73);
  });

  test("every rule but ended is some forbidden scenario's", () => {
    const rules = new Set(grammar.forbidden.map((s) => s.rule));
    expect([...rules].sort()).toStrictEqual(RULES.filter((r) => r !== 'ended').sort());
  });

  test('the scenarios named in KNOWN: refused as main binds the rows', () => {
    for (const [id, { list, refused }] of Object.entries(KNOWN)) {
      const s = grammar[list].find((scenario) => scenario.id === id);
      if (!s || !KNOWN[id].applies(s)) continue;
      const verdict = playScenario(s, files);
      expect({ id, at: verdict?.at, rule: verdict?.rule }).toStrictEqual({ id, ...refused });
    }
  });

  test("each scenario's row is the one rowFor gives its method and params", () => {
    for (const s of [...grammar.honest, ...grammar.forbidden]) {
      const params = scenarioParams(s);
      let method;
      if (s.row.startsWith('swarm.publish:')) method = 'swarm.publish';
      else if (s.row.startsWith('swarm.feed:')) method = 'swarm.feed';
      else if (s.row.startsWith('swarm.')) method = s.row;
      else method = `swarm_${s.row.replace(/_(index|latest)$/, '')}`;
      expect({ id: s.id, row: rowFor(method, params) }).toStrictEqual({ id: s.id, row: s.row });
    }
  });
});

describeIfVectors("the values main derives against vectors/swarm.json's feeds", () => {
  const feeds = () => swarm.feeds;

  test("topics and feed identifiers are bee-js's", () => {
    const topics = feeds().filter((f) => f.kind === 'topic');
    const identifiers = feeds().filter((f) => f.kind === 'identifier');
    expect(topics.length).toBeGreaterThan(0);
    expect(identifiers.length).toBeGreaterThan(0);
    for (const f of topics) expect(topicOf(f.name)).toBe(f.topic);
    for (const f of identifiers)
      expect(feedIdentifier(f.topic, BigInt(f.index))).toBe(f.identifier);
  });

  test("each index run: the head probe asks the reference's indexes, and the next index is the reference's", () => {
    const runs = feeds().filter((f) => f.kind === 'index_run');
    expect(runs.length).toBeGreaterThan(10);
    for (const run of runs) {
      const lookup = new IndexLookup({ probeOn: [404, 500] });
      let headers = [];
      if (run.lookup >= 200 && run.lookup < 300) {
        const method = swarm.methods.find((m) => m.id === run.method_case);
        headers = Object.entries(method.node.latest[0].reply.headers || {});
      }
      lookup.answerHead({ status: run.lookup, headers });
      const asked = [];
      for (const probe of run.probes) {
        const next = lookup.probe?.nextIndex;
        asked.push(next);
        lookup.probe.asked();
        lookup.probe.answer(probe.status);
      }
      expect({ id: run.id, asked }).toStrictEqual({
        id: run.id,
        asked: run.probes.map((p) => p.index),
      });
      expect(lookup.probe ? lookup.probe.nextIndex : null).toBeNull();
      const index = lookup.writeIndex;
      if (run.error) expect({ id: run.id, index }).toStrictEqual({ id: run.id, index: undefined });
      else
        expect({ id: run.id, index }).toStrictEqual({ id: run.id, index: BigInt(run.next_index) });
    }
  });

  test('the longest probe run is 81 reads', () => {
    const probe = new HeadProbe();
    let reads = 0;
    // Every index up to 2^40 − 1 exists.
    while (probe.nextIndex !== null) {
      const index = probe.nextIndex;
      probe.asked();
      probe.answer(index < 2 ** 40 ? 200 : 404);
      reads += 1;
    }
    expect(reads).toBe(81);
    expect(probe.nextWriteIndex).toBe(2 ** 40);
  });
});
