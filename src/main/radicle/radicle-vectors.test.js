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
 * answers) has no `main` to replay here; later PRs run every file again
 * against main's service path.
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
