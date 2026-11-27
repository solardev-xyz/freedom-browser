/**
 * Main's operation grammar (swarm-grammar.js) against the pinned core's
 * `vectors/swarm-grammar.json` (freedom-core design 0015, The operation
 * grammar: "main's executor suite reads the same file and runs both
 * lists"), and the values main derives against `vectors/swarm.json`'s
 * feeds:
 * - the forms, the rows, their values and bounds are the file's, as main
 *   ships them (design 0015's SWM-5 plan, point 1: JavaScript, checked
 *   here, never loaded at runtime);
 * - `failed` is the file's set, `stopped` included (plan point 7: 0015, the
 *   core's wire.rs and, from cored-v0.30.0's commit, the file);
 * - every honest scenario is admitted call by call, every forbidden one
 *   refused at its last call by its rule, all of them, not a sample;
 * - main's own rows' params are the file's, whole, and a part they name
 *   (`{ part: k }`) is streamed, its bytes part k's in the scenario's
 *   `parts`, never inlined;
 * - the head probe's runs, the next index, topics and identifiers are
 *   swarm.json's.
 *
 * Skipped unless the vectors are found (test/helpers/swarm-vectors.js):
 * FREEDOM_CORE_SWARM_VECTORS names freedom-core's `vectors` directory, as
 * CI does at the pinned commit, and then a missing file fails the suite.
 */

const {
  Admission,
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
const {
  coreCall,
  partBytes,
  playScenario,
  replyOf,
  scenarioParams,
  sha256,
  swarmVectors,
  swarmVectorsRequired,
  uploadReferences,
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

  test("failed is the file's set, stopped included (0015 and wire.rs have it)", () => {
    expect(FAILED).toStrictEqual(grammar.failed);
    expect(FAILED).toContain('stopped');
  });

  test('every honest scenario is admitted, call by call', () => {
    const refused = [];
    let played = 0;
    for (const s of grammar.honest) {
      const verdict = playScenario(s, files);
      if (verdict) refused.push({ id: s.id, row: s.row, ...verdict });
      played += 1;
    }
    expect(refused).toStrictEqual([]);
    expect(played).toBe(grammar.honest.length);
    expect(played).toBeGreaterThanOrEqual(372);
  });

  test('every forbidden scenario is refused at its last call, by its rule', () => {
    const wrong = [];
    let played = 0;
    for (const s of grammar.forbidden) {
      const verdict = playScenario(s, files);
      const want = { at: s.calls.length - 1, rule: s.rule };
      if (!verdict || verdict.at !== want.at || verdict.rule !== want.rule) {
        wrong.push({ id: s.id, want, got: verdict && { at: verdict.at, rule: verdict.rule } });
      }
      played += 1;
    }
    expect(wrong).toStrictEqual([]);
    expect(played).toBe(grammar.forbidden.length);
    expect(played).toBeGreaterThanOrEqual(73);
  });

  test("main's own swarm.publish params are the file's, whole: pin, deferred, and each part's bytes or its part", () => {
    const own = [...grammar.honest, ...grammar.forbidden].filter((s) =>
      s.row.startsWith('swarm.publish:')
    );
    expect(own.length).toBeGreaterThan(0);
    for (const s of own) {
      const params = scenarioParams(s);
      expect({ id: s.id, params }).toStrictEqual({ id: s.id, params: s.params });
      expect({ id: s.id, pin: typeof params.pin, deferred: typeof params.deferred }).toStrictEqual({
        id: s.id,
        pin: 'boolean',
        deferred: 'boolean',
      });
      for (const part of params.parts) {
        const forms = ['base64', 'part'].filter((name) => Object.hasOwn(part, name));
        // Exactly one: the bytes in the params, or the part that holds them.
        expect({ id: s.id, forms: forms.length }).toStrictEqual({ id: s.id, forms: 1 });
      }
    }
  });

  // From cored-v0.30.0's commit the file names a picked file's bytes as a
  // part (`{ bytes, part }`, beside the scenario's `parts`), which the
  // core streams (`Piece::Part`) however short it is. The Admission takes
  // it only as a stream of the part's length, so a play that inlined it
  // would no longer pass.
  test("a part main's params name is streamed: swarm.publish-file-default keeps { part: 0 } and its upload is { stream: 9 }", () => {
    const named = [];
    for (const s of [...grammar.honest, ...grammar.forbidden]) {
      const params = scenarioParams(s);
      for (const c of s.calls) {
        const bytes = partBytes(s, params, c);
        if (!bytes) continue;
        named.push(s.id);
        const part = params.parts[0];
        expect(coreCall(c, params).body).toStrictEqual({ stream: part.bytes });
        // Part k's bytes are the ones the node took.
        expect(bytes.length).toBe(part.bytes);
        expect(c.body.bytes).toBe(part.bytes);
        if (c.body.base64 !== undefined) {
          expect(bytes.toString('base64')).toBe(c.body.base64);
        } else {
          expect(sha256(bytes)).toBe(c.body.sha256);
        }
      }
    }
    expect(named).toStrictEqual(['swarm.publish-file-default']);

    const s = grammar.honest.find((scenario) => scenario.id === 'swarm.publish-file-default');
    const params = scenarioParams(s);
    expect(params.parts).toStrictEqual([{ bytes: 9, part: 0 }]);
    const at = s.calls.findIndex((c) => c.form === 'bzz_file');
    expect(coreCall(s.calls[at], params).body).toStrictEqual({ stream: 9 });

    // The same upload, its body inlined or another length: refused `body`.
    const play = (body) => {
      const admission = new Admission({ row: s.row, params, key: s.key ?? null });
      if (s.ready) {
        expect(admission.ready(s.ready.check)).toBeNull();
        admission.readyAnswered(s.ready.ok);
      }
      const references = uploadReferences(s, grammar, swarm);
      for (const [i, c] of s.calls.entries()) {
        const call = coreCall(c, params);
        if (i === at) call.body = body;
        const verdict = admission.admit(call);
        if (verdict.rule) return { at: i, rule: verdict.rule };
        admission.settle(verdict.ticket, replyOf(c, dwebVerify.swarm.chunks, references));
      }
      return null;
    };
    expect(play({ stream: 9 })).toBeNull();
    expect(play({ base64: s.calls[at].body.base64 })).toStrictEqual({ at, rule: 'body' });
    expect(play({ stream: 10 })).toStrictEqual({ at, rule: 'body' });
  });

  test("every rule but ended is some forbidden scenario's", () => {
    const rules = new Set(grammar.forbidden.map((s) => s.rule));
    expect([...rules].sort()).toStrictEqual(RULES.filter((r) => r !== 'ended').sort());
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
