/**
 * freedom-core's Radicle vectors against today's main (the radicled step-5
 * plan's B1): the parity harness that the move onto `freedom-radicled`
 * builds on (B7–B14).
 *
 * freedom-core's generator (`vectors/generator/radicle-*.js`) recorded each
 * vector's `main` from this repository's own modules at the vectors'
 * reference commit (each file's `meta.freedomBrowserCommit`), over a scripted
 * add-on. This suite replays every such case through the same modules as
 * they are now, in the generator's world (`test/helpers/radicle-vector-harness.js`),
 * and checks that main answers byte for byte as recorded:
 *
 * - `radicle-reads.json`: each `rad.read` op through the radapi handlers
 *   (`serveRepoApi`, the `/api/v1/repos` listing, `serveNodeApi` and
 *   `getConnections` for `node_info`): status, body, the add-on calls in
 *   order, and the warnings logged;
 * - `radicle-blob.json`: each file's `/blob/<rev>/<path>` answer, and
 *   libradicle's errors through it;
 * - `radicle-network.json`: `connectAndSeedDefault` over each seed report
 *   (its calls and log lines), the statuses `seedRepository` publishes over
 *   each clone's progress, and its last status for each clone's end;
 * - `radicle-stats.json`: `getConnections`'s count over the add-on's
 *   `status`;
 * - `radicle-import.json`: `importGitHubRepo` whole, over each of the
 *   add-on's and the service's answers.
 *
 * What only the service has (`source: design`: the progress queue, the
 * `rad.stats` results, `rad.blob`'s ranges and refusals, the service's
 * answers) has no `main` to replay here. Main's service path runs the files
 * again below: radicle-reads.json and radicle-blob.json (B7, B8), and
 * radicle-network.json with the service's progress queue (B9); the others
 * with their steps.
 *
 * **Drift.** A case main no longer answers as recorded fails, unless it is
 * listed in KNOWN_STALE: main changed it on purpose, and freedom-core
 * regenerates the vector from a newer reference (the PR named). A listed
 * case must still differ from its vector only as described; once the
 * vectors this suite reads match it, it fails until it is removed from the
 * list.
 *
 * **Which files.** The vectors aren't copied into this repository: they are
 * read from a freedom-core checkout. FREEDOM_CORE_RADICLE_VECTORS names its
 * `vectors/` directory; otherwise the directory of FREEDOM_CORE_VECTORS, or
 * the one in the freedom-core checkout FREEDOM_CORED_PATH was built in. CI
 * checks out freedom-core's at a reviewed commit and names it: then every
 * file below must be there, and one that is missing fails the suite rather
 * than skipping it. Without any of them, the suite is skipped.
 */

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const harness = require('../../../test/helpers/radicle-vector-harness');

const FILES = [
  'radicle-reads.json',
  'radicle-blob.json',
  'radicle-network.json',
  'radicle-stats.json',
  'radicle-import.json',
];

function vectorsDir() {
  if (process.env.FREEDOM_CORE_RADICLE_VECTORS) return process.env.FREEDOM_CORE_RADICLE_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) return path.dirname(process.env.FREEDOM_CORE_VECTORS);
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors');
    if (fs.existsSync(path.join(candidate, FILES[0]))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const dir = vectorsDir();
const vectors = Object.fromEntries(
  FILES.map((name) => {
    const file = dir && path.join(dir, name);
    return [name, file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null];
  })
);
// Named outright (CI does): they must be there.
const required = Boolean(process.env.FREEDOM_CORE_RADICLE_VECTORS);

(required ? test : test.skip)('the vectors FREEDOM_CORE_RADICLE_VECTORS names are there', () => {
  expect(FILES.filter((name) => !vectors[name])).toEqual([]);
});

/** Calls as an unordered list: what they are, not when. */
const callSet = (calls) => calls.map((call) => JSON.stringify(call)).sort();

/**
 * Cases whose recorded `main` main has changed on purpose since the
 * vectors' reference, by file and case: why, the freedom-core PR that
 * regenerates them, and `onlyDifference(now, recorded)`, which holds when
 * main's answer differs from the vector in that way and no other.
 */
const KNOWN_STALE = {
  'radicle-network.json': {
    'progress/every-phase-then-done': {
      core: 'solardev-xyz/freedom-core#312',
      reason:
        "R-3's read bounds (#948) put every add-on call behind one more await " +
        "(radicle-embedded.js's addonCall), so after a clone succeeds the seed count's " +
        "`seeders` and the node info's `status` and `listRepos`, which run concurrently, " +
        'reach the add-on in another order. The statuses main publishes are the same.',
      onlyDifference: (now, recorded) =>
        !isDeepStrictEqual(now.calls, recorded.calls) &&
        isDeepStrictEqual(
          { ...now, calls: callSet(now.calls) },
          { ...recorded, calls: callSet(recorded.calls) }
        ),
    },
  },
};

test('every known-stale case names a vector case and a freedom-core PR', () => {
  for (const [name, cases] of Object.entries(KNOWN_STALE)) {
    expect(FILES).toContain(name);
    for (const stale of Object.values(cases)) {
      expect(stale.core).toMatch(/^solardev-xyz\/freedom-core#\d+$/);
      expect(stale.reason).toEqual(expect.any(String));
    }
  }
});

/**
 * A case's replay against its recorded `main`: no add-on call unscripted or
 * left unread, then the answer, byte for byte (key order included), or the
 * known-stale difference and only that.
 */
function expectAsRecorded(name, id, replay, recorded) {
  expect({ unscripted: replay.unscripted, unread: replay.unread }).toEqual({
    unscripted: [],
    unread: [],
  });
  if (replay.gitLeft !== undefined) expect(replay.gitLeft).toBe(0);
  const same =
    isDeepStrictEqual(replay.main, recorded) &&
    JSON.stringify(replay.main) === JSON.stringify(recorded);
  const stale = KNOWN_STALE[name]?.[id];
  if (!stale) {
    expect(replay.main).toStrictEqual(recorded);
    expect(JSON.stringify(replay.main)).toBe(JSON.stringify(recorded));
    return;
  }
  if (same) {
    throw new Error(
      `${name} ${id} now matches its vector (${stale.core} has landed): remove it from KNOWN_STALE`
    );
  }
  expect(stale.onlyDifference(replay.main, recorded)).toBe(true);
}

/**
 * Each file's cases with their recorded `main`, and how to replay them all,
 * in the generator's order and worlds (see the harness).
 */
const REPLAYS = {
  'radicle-reads.json': (v) => ({
    cases: v.cases.map((c) => ({ id: c.id, recorded: c.main })),
    async run() {
      const main = harness.loadReadsMain();
      const out = new Map();
      for (const c of v.cases) out.set(c.id, await harness.runRead(main, c));
      return out;
    },
  }),
  'radicle-blob.json': (v) => {
    const files = v.files.filter((file) => file.main);
    return {
      cases: [
        ...files.map((file) => ({ id: `files/${file.path}`, recorded: file.main })),
        ...v.errors.map((error) => ({ id: `errors/${error.id}`, recorded: error.main })),
      ],
      async run() {
        const main = harness.loadReadsMain();
        const out = new Map();
        for (const file of files) {
          out.set(
            `files/${file.path}`,
            await harness.runBlob(main, harness.blobText(file), file.path)
          );
        }
        for (const error of v.errors) {
          out.set(`errors/${error.id}`, await harness.runBlob(main, error.addon, error.path));
        }
        return out;
      },
    };
  },
  'radicle-network.json': (v) => ({
    cases: [
      ...v.reports.map((c) => ({ id: `reports/${c.id}`, recorded: c.main })),
      ...v.progress.map((c) => ({ id: `progress/${c.id}`, recorded: c.main })),
      ...v.results.map((c) => ({ id: `results/${c.id}`, recorded: c.main })),
    ],
    async run() {
      // One world for the three, as the generator runs them.
      const main = harness.loadNetworkMain();
      const out = new Map();
      for (const c of v.reports) out.set(`reports/${c.id}`, await harness.runReport(main, c));
      for (const c of v.progress) out.set(`progress/${c.id}`, await harness.runProgress(main, c));
      for (const c of v.results) out.set(`results/${c.id}`, await harness.runResult(main, c));
      return out;
    },
  }),
  'radicle-stats.json': (v) => ({
    cases: v.connections.map((c) => ({ id: `connections/${c.id}`, recorded: c.main })),
    async run() {
      const main = harness.loadNetworkMain();
      const out = new Map();
      for (const c of v.connections) {
        out.set(`connections/${c.id}`, await harness.runConnections(main, c));
      }
      return out;
    },
  }),
  'radicle-import.json': (v) => ({
    cases: v.imports.map((c) => ({ id: `imports/${c.id}`, recorded: c.main })),
    async run() {
      const out = new Map();
      for (const c of v.imports)
        out.set(`imports/${c.id}`, await harness.runImport(c, v.constants));
      return out;
    },
  }),
};

let previousAddon;
beforeAll(() => {
  previousAddon = process.env.FREEDOM_RADICLE_ADDON;
  process.env.FREEDOM_RADICLE_ADDON = harness.ADDON;
});
afterAll(() => {
  if (previousAddon === undefined) delete process.env.FREEDOM_RADICLE_ADDON;
  else process.env.FREEDOM_RADICLE_ADDON = previousAddon;
});

for (const name of FILES) {
  const v = vectors[name];
  const commit = v?.meta?.freedomBrowserCommit?.slice(0, 8) ?? 'missing';
  (v ? describe : describe.skip)(`${name} (recorded at ${commit}) through today's main`, () => {
    const replay = v ? REPLAYS[name](v) : { cases: [], run: async () => new Map() };
    let replayed;
    // Every case at once, in order: a file's first case loads the add-on.
    beforeAll(async () => {
      replayed = await replay.run();
    });

    test('has cases, each once, and every known-stale case among them', () => {
      const ids = replay.cases.map((c) => c.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of Object.keys(KNOWN_STALE[name] ?? {})) expect(ids).toContain(id);
    });

    test.each(replay.cases.map((c) => [c.id, c.recorded]))('%s', (id, recorded) => {
      expectAsRecorded(name, id, replayed.get(id), recorded);
    });
  });
}

/**
 * On main's service path (the radicled plan's B7): `FREEDOM_RADICLE_BACKEND=
 * service`, over a fake service node whose `rad.read` answers each op with
 * the vector's service text (`expect`, which the design gives `node_info`).
 * The manager's `getConnections` reads the composed `node_info`, collected,
 * and must answer as it answered over the add-on, with the service's
 * diagnostics beside it (`confinement`, `service`), and log what it logged.
 * The handlers' answers (`root` and `stats`, and the other ops) move onto
 * the service with the handlers.
 */
const readsVectors = vectors['radicle-reads.json'];
const nodeInfoCases = readsVectors?.cases.filter((c) => c.op === 'node_info') ?? [];
(readsVectors ? describe : describe.skip)(
  "radicle-reads.json's node_info through main's service path",
  () => {
    let previousBackend;
    let main;
    beforeAll(() => {
      previousBackend = process.env.FREEDOM_RADICLE_BACKEND;
      process.env.FREEDOM_RADICLE_BACKEND = 'service';
      main = harness.loadServiceReadsMain();
    });
    afterAll(() => {
      if (previousBackend === undefined) delete process.env.FREEDOM_RADICLE_BACKEND;
      else process.env.FREEDOM_RADICLE_BACKEND = previousBackend;
    });

    test("has cases, each with the design's answer", () => {
      expect(nodeInfoCases.length).toBeGreaterThan(0);
      for (const c of nodeInfoCases) expect(c.expect.source).toBe('design');
    });

    test.each(nodeInfoCases.map((c) => [c.id, c]))(
      '%s: getConnections rebuilt from the service answer',
      async (_id, c) => {
        const replay = await harness.runServiceNodeInfo(main, c);
        expect(replay.unscripted).toEqual([]);
        // One collected read, node_info with the case's args, and nothing of
        // the add-on's.
        expect(replay.calls).toEqual([{ op: 'node_info', args: c.args }]);
        const { confinement, service, ...connections } = replay.connections;
        expect(connections).toStrictEqual(c.main.connections);
        expect(JSON.stringify(connections)).toBe(JSON.stringify(c.main.connections));
        expect(confinement).toEqual(main.node.confinement);
        expect(service).toBe('0.1.0');
        // The manager's own lines, as over the add-on.
        expect(replay.warnings).toEqual(
          c.main.warnings.filter((line) => line.startsWith('[Radicle] '))
        );
      }
    );
  }
);

/**
 * The radapi handlers' answers on main's service path (the radicled plan's
 * B8): each radicle-reads.json case's endpoint (the same serveRepoApi path,
 * listing or node endpoint the add-on replay asks), and each
 * radicle-blob.json file's and error's `/blob/`, over a fake service node
 * that answers the case's op as the service would (`serviceAnswer`; for
 * node_info, `status` as the add-on's text and `node_info` as `expect`).
 *
 * Main must send one `rad.read` with the case's op and args (node_info's
 * `/` the collected `status`, and `/api/v1/stats` the composed
 * `node_info`), answer as it did over the add-on, status and body byte for
 * byte, and log its own `[radapi]` lines as it did. What the add-on's
 * composition logged (`[RadicleEmbedded] seeders() failed`) is the
 * service's now. The one difference by design: a read past a byte bound is
 * 413 on the service (deviation `size-caps`), where the add-on's was a 500.
 */
const blobVectors = vectors['radicle-blob.json'];
(readsVectors ? describe : describe.skip)(
  "radicle-reads.json's and radicle-blob.json's HTTP answers through main's service path",
  () => {
    let previousBackend;
    let main;
    beforeAll(() => {
      previousBackend = process.env.FREEDOM_RADICLE_BACKEND;
      process.env.FREEDOM_RADICLE_BACKEND = 'service';
      main = harness.loadServiceReadsMain();
    });
    afterAll(() => {
      if (previousBackend === undefined) delete process.env.FREEDOM_RADICLE_BACKEND;
      else process.env.FREEDOM_RADICLE_BACKEND = previousBackend;
    });

    /** The reference's answer, as the service path gives it: 413 for a
     * byte bound (size-caps), else the same. */
    const onService = (recorded) => {
      if (recorded.status === 200) return recorded;
      const { error } = JSON.parse(recorded.body);
      return harness.TOO_LARGE_TEXT.test(error) ? { ...recorded, status: 413 } : recorded;
    };
    const ownLines = (warnings) => warnings.filter((line) => line.startsWith('[radapi] '));

    test('some failures are byte bounds, each a 413 on the service', () => {
      const bounded = readsVectors.cases.filter(
        (c) => c.op !== 'node_info' && onService(c.main).status === 413
      );
      expect(bounded.map((c) => c.id).length).toBeGreaterThan(0);
    });

    // describe.skip still runs this callback, so the table can't read a
    // missing radicle-reads.json.
    test.each(readsVectors ? readsVectors.cases.map((c) => [c.id, c]) : [['(no radicle-reads.json)', null]])(
      '%s: the radapi answer, from one rad.read',
      async (_id, c) => {
        const replay = await harness.runServiceRead(main, c);
        expect(replay.unscripted).toEqual([]);
        if (c.op === 'node_info') {
          expect(replay.calls).toEqual([
            { op: 'status', args: {} },
            { op: 'node_info', args: c.args },
          ]);
          expect(replay.main).toStrictEqual({ root: c.main.root, stats: c.main.stats });
        } else {
          expect(replay.calls).toEqual([{ op: c.op, args: c.args }]);
          const expected = onService({ status: c.main.status, body: c.main.body });
          expect(replay.main).toStrictEqual(expected);
          expect(JSON.stringify(replay.main)).toBe(JSON.stringify(expected));
        }
        expect(replay.warnings).toEqual(ownLines(c.main.warnings));
      }
    );

    // Each file's blob_at text, and each error's code and message as the
    // service answers it (rad.blob's `expect`: the same libradicle error).
    const blobCases = blobVectors
      ? [
          ...blobVectors.files
            .filter((file) => file.main)
            .map((file) => [
              `files/${file.path}`,
              file.path,
              { body: harness.blobText(file) },
              file.main,
            ]),
          ...blobVectors.errors.map((error) => [
            `errors/${error.id}`,
            error.path,
            { error: error.expect.error },
            error.main,
          ]),
        ]
      : [['(no radicle-blob.json)', null, null, null]];
    (blobVectors ? test.each : test.skip.each)(blobCases)(
      '%s: /blob/ from one blob_at',
      async (_id, filePath, answer, recorded) => {
        const replay = await harness.runServiceBlob(main, answer, filePath);
        expect(replay.unscripted).toEqual([]);
        expect(replay.calls).toEqual([
          { op: 'blob_at', args: { rid: harness.RID, revision: harness.REV, path: filePath } },
        ]);
        expect(replay.main).toStrictEqual(recorded);
        expect(replay.warnings).toEqual(
          recorded.status === 500
            ? [`[radapi] ${harness.RID} /blob/${harness.REV}/${filePath} → ${answer.error.message}`]
            : []
        );
      }
    );
  }
);

/**
 * radicle-network.json on main's service path (the radicled plan's B9):
 * the same manager and seed status, over a fake service node whose
 * `rad.connect_seeds` and `rad.clone` answer as the service would.
 *
 * - **`reports`:** the background network start over the service's answer
 *   (`expect`): the same log lines as over the add-on, and the same calls,
 *   each as the service routes it (`serviceCalls`);
 * - **`progress`:** each clone's events, as the texts of its `rad.progress`
 *   events, then its result: the same statuses, byte for byte;
 * - **`queue`:** what the service writes for a clone's progress, its queue's
 *   envelopes (`written`), through `seed-status.js`: each event's status,
 *   the summary event as `{ phase, count, reason }` with its reasons as
 *   recent attempts, every failure counted, and the terminal's status last;
 * - **`results`:** each clone's end as the service answers it: the same last
 *   status where the service's text is the add-on's, its own text where it
 *   isn't (a repository the gate holds closed), and for `nothing` the
 *   deadline's or the stop's answer, a failure with the service's text,
 *   where libradicle's cancel was the add-on's `cancelled`.
 */
const networkVectors = vectors['radicle-network.json'];

/**
 * The add-on calls a case recorded, each as the service routes it: the
 * seeds and the clones are its methods, `getConnections`' counts one
 * composed `node_info` read (its `status` and `listRepos`), a seeder count
 * a collected `seeders` read, and the peer count after the seeds the node's
 * own stats (no call).
 */
function serviceCalls(addonCalls) {
  const out = [];
  for (const { export: name, args } of addonCalls) {
    switch (name) {
      case 'connectSeeds':
        out.push({ method: 'rad.connect_seeds', params: { timeout_ms: args[0] } });
        break;
      case 'cloneRepo':
        out.push({
          method: 'rad.clone',
          params: { rid: args[0], timeout_ms: args[1], progress: false },
        });
        break;
      case 'cloneRepoWithProgress':
        out.push({
          method: 'rad.clone',
          params: { rid: args[0], timeout_ms: args[1], progress: true },
        });
        break;
      case 'listRepos':
        out.push({ op: 'node_info', args: {} });
        break;
      case 'seeders':
        out.push({ op: 'seeders', args: { rid: args[0] } });
        break;
      case 'status':
        break;
      default:
        throw new Error(`no service route for the add-on's ${name}`);
    }
  }
  return out;
}

/** The lines main logs of its own, without the add-on's loading. */
const mainLines = (lines) => lines.filter((line) => !line.startsWith('[RadicleEmbedded] Loaded'));

(networkVectors ? describe : describe.skip)(
  "radicle-network.json through main's service path",
  () => {
    let previousBackend;
    let main;
    beforeAll(() => {
      previousBackend = process.env.FREEDOM_RADICLE_BACKEND;
      process.env.FREEDOM_RADICLE_BACKEND = 'service';
      main = harness.loadServiceNetworkMain();
    });
    afterAll(() => {
      if (previousBackend === undefined) delete process.env.FREEDOM_RADICLE_BACKEND;
      else process.env.FREEDOM_RADICLE_BACKEND = previousBackend;
    });

    // describe.skip still runs this callback: the tables can't read a
    // missing file.
    const cases = (name) =>
      networkVectors ? networkVectors[name].map((c) => [c.id, c]) : [[`(no ${name})`, null]];

    test.each(cases('reports'))(
      'reports/%s: the background start over the service answer',
      async (_id, c) => {
        const replay = await harness.runServiceReport(main, c);
        expect(replay.unscripted).toEqual([]);
        expect(replay.unanswered).toBe(0);
        expect(replay.main.calls).toEqual(serviceCalls(c.main.calls));
        expect(replay.main.infos).toEqual(mainLines(c.main.infos));
        expect(replay.main.warnings).toEqual(mainLines(c.main.warnings));
      }
    );

    test.each(cases('progress'))(
      'progress/%s: the same statuses, byte for byte',
      async (_id, c) => {
        const replay = await harness.runServiceProgress(main, c);
        expect(replay.unscripted).toEqual([]);
        expect(replay.unanswered).toBe(0);
        expect(replay.main.statuses).toStrictEqual(c.main.statuses);
        expect(JSON.stringify(replay.main.statuses)).toBe(JSON.stringify(c.main.statuses));
        // The same calls, as the service routes them. The node info the
        // fetch's steps push is one read at a time, joined while one is in
        // flight: how many there are follows how long each takes, which the
        // service's reads and the add-on's don't share (see KNOWN_STALE).
        const expected = serviceCalls(c.main.calls);
        const isInfo = (call) => call.op === 'node_info';
        expect(replay.main.calls.filter((call) => !isInfo(call))).toEqual(
          expected.filter((call) => !isInfo(call))
        );
        expect(replay.main.calls.filter(isInfo).length).toBeGreaterThanOrEqual(
          expected.filter(isInfo).length
        );
        expect(replay.main.warnings).toEqual(mainLines(c.main.warnings));
      }
    );

    test.each(cases('queue'))(
      'queue/%s: what the service writes, through seed-status.js',
      async (_id, c) => {
        const replay = await harness.runServiceQueue(main, c);
        expect(replay.unscripted).toEqual([]);
        const { statuses, events: texts } = replay.main;
        const events = texts.map((text) => JSON.parse(text));
        // A status for each event, in order, between the start and the end.
        expect(statuses).toHaveLength(events.length + 2);
        expect(statuses[0].progress).toEqual({ phase: 'starting' });
        events.forEach((event, i) => {
          const { progress, state } = statuses[i + 1];
          expect(state).toBe('fetching');
          if (event.summary) {
            expect(progress).toEqual({
              phase: 'peer-failed',
              count: event.summary.count,
              reason: event.summary.reasons.at(-1),
            });
          } else {
            expect(progress).toEqual(event);
          }
        });
        // Every failure counted: the singles, and each summary's count.
        const failures = events.filter((e) => e.phase === 'peer-failed');
        const written = failures.reduce((n, e) => n + (e.summary ? e.summary.count : 1), 0);
        const counted = statuses
          .filter((s) => s.progress?.phase === 'peer-failed')
          .reduce((n, s) => n + ('count' in s.progress ? s.progress.count : 1), 0);
        expect(counted).toBe(written);
        // Each failure's reasons, the summary's among them, are recent
        // attempts; none names an nid it doesn't have.
        const reasons = failures.flatMap((e) => (e.summary ? e.summary.reasons : [e.reason]));
        const last = statuses.at(-1);
        expect(last.recentAttempts.filter((a) => !a.ok).map((a) => a.error)).toEqual(
          reasons.slice(-last.recentAttempts.filter((a) => !a.ok).length)
        );
        for (const status of statuses) {
          for (const attempt of status.recentAttempts) expect(attempt).toHaveProperty('nid');
          expect(status.progress).not.toHaveProperty('summary');
        }
        // The terminal's status last.
        const terminal = events.at(-1).phase;
        const state =
          { done: 'fetched', cancelled: 'cancelled', failed: 'failed' }[terminal] ?? 'fetched';
        expect(last.state).toBe(state);
      }
    );

    const resultCases = networkVectors
      ? networkVectors.results.flatMap((c) =>
          c.expect.nothing
            ? [
                [`${c.id} (deadline)`, c, 'deadline'],
                [`${c.id} (stop)`, c, 'stop'],
              ]
            : [[c.id, c, null]]
        )
      : [['(no results)', null, null]];
    test.each(resultCases)(
      "results/%s: the last status for the service's answer",
      async (_id, c, ending) => {
        const replay = await harness.runServiceResult(main, c, ending);
        expect(replay.unscripted).toEqual([]);
        const recorded = c.main.final;
        const error = c.expect.error ?? (c.expect.nothing ? harness.SERVICE_ENDINGS[ending] : null);
        let expected = recorded;
        if (error && error.message !== recorded.lastError) {
          // The service's own text: a closed repository's, or its deadline's
          // or stop's, where the add-on answered libradicle's.
          expected = {
            ...recorded,
            state: 'failed',
            progress: { phase: 'failed', reason: error.message },
            lastError: error.message,
          };
        }
        expect(replay.main.final).toStrictEqual(expected);
        expect(JSON.stringify(replay.main.final)).toBe(JSON.stringify(expected));
        expect(replay.main.warnings).toEqual(
          error ? [`[seed-status] ${harness.RID} fetch failed: ${error.message}`] : []
        );
      }
    );

    test("the service's own texts are the deliberate differences: a closed repository's, and the deadline's and the stop's", () => {
      const differ = networkVectors.results
        .filter(
          (c) =>
            c.expect.nothing ||
            (c.expect.error && c.expect.error.message !== c.main.final.lastError)
        )
        .map((c) => c.id);
      expect(differ).toEqual([
        'cancelled-by-the-deadline-or-the-stop',
        'gated-namespace',
        'gated-cache',
        'gated-repairing',
      ]);
    });
  }
);

/**
 * The fake service's progress queue (test/helpers/fake-radicled-progress.js,
 * which radicle-service-network.test.js runs a clone through) against the
 * service's: each `queue` case's envelopes, byte for byte, where nothing is
 * cut (the model cuts nothing, and refuses an event that would need it).
 */
const { ProgressQueue, envelope } = require('../../../test/helpers/fake-radicled-progress');
(networkVectors ? describe : describe.skip)("the fake service's progress queue", () => {
  const expand = (reason) =>
    reason && typeof reason === 'object' && reason.$repeat
      ? reason.$repeat[0].repeat(reason.$repeat[1])
      : reason;
  /** What the model writes for case `c`, or null where it would cut. */
  const modelled = (c) => {
    const queue = new ProgressQueue(c.request_id);
    const out = [];
    const take = () => {
      const text = queue.take();
      if (text !== null) out.push(envelope(c.request_id, text));
      return text;
    };
    try {
      for (const step of c.steps) {
        if (step.emit) queue.push({ ...step.emit, reason: expand(step.emit.reason) });
        else for (let i = 0; i < step.take; i += 1) take();
      }
    } catch (err) {
      if (/cuts no event/.test(err.message)) return null;
      throw err;
    }
    while (take() !== null);
    return out;
  };

  test("writes the service's envelopes for every case it can, among them the summary's", () => {
    const uncut = networkVectors.queue.filter((c) => modelled(c) !== null).map((c) => c.id);
    expect(uncut).toEqual(
      expect.arrayContaining([
        'phases-keep-the-latest',
        'failures-keep-their-place',
        'eight-failures-then-a-summary',
        'a-summary-folds-while-it-waits',
        'the-terminal-comes-last',
      ])
    );
    for (const c of networkVectors.queue) {
      const out = modelled(c);
      if (out !== null) expect([c.id, out]).toEqual([c.id, c.written]);
    }
  });
});

/**
 * On main's service path for the import (the radicled plan's B14):
 * `FREEDOM_RADICLE_BACKEND=service`, `importGitHubRepo` whole over main's
 * import on the one-shot import process (radicle/radicled-import.js) and a
 * fake freedom-radicled whose `rad.import_repo` answers each case's
 * `expect`, the service's answer (`source: design`). Main sends
 * `importRepo`'s arguments as `rad.import_repo`'s params, field by field
 * (`path` being `--source`), and then answers and does exactly what it did
 * over the add-on: `{ rid }` read into `rid.slice(4)`, only "already exists
 * in storage" an already-bridged repository, and every other answer the
 * import's failure with the service's message. What differs by design: no
 * add-on call, and the clone made in the OS's temporary directory, not the
 * profile's.
 */
const importVectors = vectors['radicle-import.json'];
const serviceImportCases = importVectors?.imports.filter((c) => c.expect) ?? [];
(importVectors ? describe : describe.skip)(
  "radicle-import.json through main's service path (the import process)",
  () => {
    let previousBackend;
    beforeAll(() => {
      previousBackend = process.env.FREEDOM_RADICLE_BACKEND;
      process.env.FREEDOM_RADICLE_BACKEND = 'service';
    });
    afterAll(() => {
      if (previousBackend === undefined) delete process.env.FREEDOM_RADICLE_BACKEND;
      else process.env.FREEDOM_RADICLE_BACKEND = previousBackend;
    });

    test("has cases, each with the service's answer: its four successes and its eleven refusals", () => {
      expect(serviceImportCases.filter((c) => c.expect.result_text)).toHaveLength(4);
      expect(serviceImportCases.filter((c) => c.expect.error)).toHaveLength(11);
      for (const c of serviceImportCases) expect(c.expect.source).toBe('design');
    });

    test.each(serviceImportCases.map((c) => [c.id, c]))(
      '%s: main answers as it did over the add-on',
      async (_id, c) => {
        const replay = await harness.runServiceImport(c, importVectors.constants);
        expect({ unscripted: replay.unscripted, unread: replay.unread }).toEqual({
          unscripted: [],
          unread: [],
        });
        expect(replay.gitLeft).toBe(0);
        const [source, name, description, defaultBranch] = c.addon.args;
        expect(replay.imports).toEqual([
          { path: source, name, description, default_branch: defaultBranch },
        ]);
        expect(replay.spawned).toHaveLength(1);
        const args = replay.spawned[0];
        expect(args[0]).toBe('import');
        expect(args[args.indexOf('--source') + 1]).toBe(source);
        // The clone in the OS's temporary directory, not the profile's.
        expect(replay.mkdtemp).toEqual(['freedom-github-bridge-']);
        const { calls, temp, ...now } = replay.main;
        const { calls: addonCalls, temp: profileTemp, ...recorded } = c.main;
        expect(addonCalls).toHaveLength(1);
        expect(profileTemp).toEqual(['github-bridge']);
        expect(calls).toEqual([]);
        expect(temp).toEqual([]);
        expect(now).toStrictEqual(recorded);
        expect(JSON.stringify(now)).toBe(JSON.stringify(recorded));
      }
    );
  }
);
