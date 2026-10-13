/**
 * The Radicle backend contract (freedom-core design 0008, "Tests first",
 * "JSON results", "The blob API" and "Main's side"): what main's Radicle
 * surface returns over a fixture repository, whatever hosts the node. It
 * runs against a real backend, chosen by FREEDOM_RADICLE_CONTRACT_BACKEND
 * (`test/helpers/radicle-contract-backends.js`): today's libradicle v0.8.0
 * add-on (`addon`), and later freedom-radicled, unchanged. Without it, the
 * suite is skipped.
 *
 * - **The fixture** (`test/helpers/radicle-fixture.js`): a Radicle home
 *   with one repository, made through the add-on and kept as a snapshot,
 *   so every backend reads the same bytes. Each run restores it into a new
 *   home. The home names no peer, and the suite runs no network operation.
 * - **The golden vectors** (`test/fixtures/radicle-contract/vectors.json`,
 *   cases in `test/helpers/radicle-contract-cases.js`): every read op's
 *   output, in the design's three classes, and the `rad:`, `radapi:` and
 *   manager answers built on them, as v0.8.0 and main's code at the
 *   reference produce them. A backend must match every byte.
 * - **The exports' contract:** `radicle-embedded.js`'s exports, their
 *   parsed results and their writes, on the restored home.
 * - **Pending:** what only the service does is written too. A test named
 *   `[pending: <feature>]` runs against a backend that honours the feature,
 *   or when FREEDOM_RADICLE_CONTRACT_PENDING names it (or is `all`).
 *
 * `FREEDOM_RADICLE_CONTRACT_RECORD=1` (with the `addon` backend) remakes the
 * fixture through the add-on and records the vectors again.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  BACKENDS,
  FEATURES,
  contractBackendName,
  forcedFeatures,
} = require('../../test/helpers/radicle-contract-backends');
const {
  VECTORS_PATH,
  buildWorkingCopy,
  fixtureIdentity,
  restoreSnapshot,
  writeIdentity,
  writeSnapshot,
} = require('../../test/helpers/radicle-fixture');
const { vectorCases } = require('../../test/helpers/radicle-contract-cases');

const BACKEND = contractBackendName();
const RECORD = process.env.FREEDOM_RADICLE_CONTRACT_RECORD === '1';
const FORCED = forcedFeatures();
const describeContract = BACKEND && !RECORD ? describe : describe.skip;
const describeRecord = BACKEND === 'addon' && RECORD ? describe : describe.skip;

const RID_RE = /^rad:z[1-9A-HJ-NP-Za-km-z]{20,60}$/;
const OID_RE = /^[0-9a-f]{40}$/;
const KIB = 1024;
const MIB = 1024 * KIB;
/** A data frame's most, and the one ring main keeps per stream (0007). */
const CHUNK = 64 * KIB;
const RING = 128 * KIB;
const NUL = String.fromCharCode(0);
const E_ACUTE = String.fromCharCode(0xe9);
const ROCKET = String.fromCodePoint(0x1f680);
const VECTORS = fs.existsSync(VECTORS_PATH)
  ? JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'))
  : null;

/** A test for a feature the design adds: pending until the backend honours
 * it, or the run forces it. */
function pendingTest(feature, name, fn, timeout) {
  if (!FEATURES.includes(feature)) throw new Error(`unknown contract feature: ${feature}`);
  const run =
    BACKEND !== null && (BACKENDS[BACKEND].honours.includes(feature) || FORCED.has(feature));
  (run ? test : test.skip)(`[pending: ${feature}] ${name}`, fn, timeout);
}

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const removeDir = (dir) =>
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

/** The `embedded` call, and its arguments, behind each pass-through and
 * serialized read: the parsed contract of `radicle-embedded.js`. */
const EMBEDDED_READS = {
  repo_info: (e, a) => e.repoInfo(a.rid),
  tree: (e, a) => e.tree(a.rid, a.path),
  tree_at: (e, a) => e.treeAt(a.rid, a.revision, a.path),
  blob: (e, a) => e.blob(a.rid, a.path),
  blob_at: (e, a) => e.blobAt(a.rid, a.revision, a.path),
  commits: (e, a) => e.commits(a.rid, a.parent, a.page, a.per_page),
  commit: (e, a) => e.commit(a.rid, a.revision),
  issues: (e, a) => e.issues(a.rid),
  issue: (e, a) => e.issue(a.rid, a.id),
  patches: (e, a) => e.patches(a.rid),
  patch: (e, a) => e.patch(a.rid, a.id),
  list_repos: (e) => e.listRepos(),
  list_seeded_repos: (e) => e.listSeededRepos(),
  seeders: (e, a) => e.seeders(a.rid),
  identity: (e) => e.identity(),
  status: (e) => e.status(),
  remotes: (e, a) => e.remotes(a.rid),
  repo_stats: (e, a) => e.repoStats(a.rid, a.revision),
};

/** The `*Raw` exports: the same text as the op's pass-through vector. */
const EMBEDDED_RAW = {
  tree_at: (e, a) => e.treeAtRaw(a.rid, a.revision, a.path),
  blob: (e, a) => e.blobRaw(a.rid, a.path),
  blob_at: (e, a) => e.blobAtRaw(a.rid, a.revision, a.path),
  commits: (e, a) => e.commitsRaw(a.rid, a.parent, a.page, a.per_page),
  commit: (e, a) => e.commitRaw(a.rid, a.revision),
};

describeRecord('Radicle backend contract: recording the fixture (addon)', () => {
  test('seeds the fixture repository through the add-on and records the vectors', async () => {
    const workingCopy = tempDir('rad-contract-wc-');
    const seedingHome = tempDir('rad-contract-');
    const home = tempDir('rad-contract-');
    try {
      const commits = buildWorkingCopy(workingCopy);
      writeIdentity(seedingHome);
      const seeding = await BACKENDS.addon.load({ home: seedingHome });
      await seeding.start();
      const e = seeding.embedded;
      const { rid } = await e.importRepo(
        workingCopy,
        'contract-fixture',
        'A repository for the Radicle backend contract',
        'main'
      );
      const open = await e.createIssue(
        rid,
        'An open issue',
        'It stays open.\n\nWith a second paragraph.',
        ['bug', 'contract']
      );
      const comment = await e.commentIssue(rid, open.id, 'A first comment.', null);
      await e.commentIssue(rid, open.id, 'A reply to the first comment.', comment.id);
      const closed = await e.createIssue(rid, 'A closed issue', 'Closed by its author.', []);
      await e.editIssueState(rid, closed.id, 'closed');
      const another = await e.createIssue(rid, 'Another open issue', 'For the pages.', [
        'contract',
      ]);
      await seeding.stop();
      writeSnapshot(seedingHome);

      // The vectors come from the snapshot, as every later run reads it.
      restoreSnapshot(home);
      const backend = await BACKENDS.addon.load({ home });
      await backend.start();
      const fixture = {
        rid,
        did: fixtureIdentity().did,
        commits,
        issues: { open: open.id, closed: closed.id, another: another.id },
      };
      const reads = {};
      const handlers = {};
      for (const [name, entry] of vectorCases(fixture)) {
        const record = await entry.run(backend);
        if (entry.kind === 'read') {
          reads[name] = { op: entry.op, args: entry.args, class: entry.class, ...record };
        } else {
          handlers[name] = record;
        }
      }
      await backend.stop();
      fs.writeFileSync(
        VECTORS_PATH,
        `${JSON.stringify(
          { version: 1, recorded_with: { libradicle: '0.8.0' }, fixture, reads, handlers },
          null,
          2
        )}\n`
      );
    } finally {
      for (const dir of [workingCopy, seedingHome, home]) removeDir(dir);
    }
  }, 600_000);
});

describeContract(`Radicle backend contract (${BACKEND})`, () => {
  let backend;
  let home;
  const fx = VECTORS?.fixture;
  const cases = fx ? vectorCases(fx) : new Map();

  beforeAll(async () => {
    if (!VECTORS) throw new Error(`no vectors at ${VECTORS_PATH}`);
    home = tempDir('rad-contract-');
    restoreSnapshot(home);
    backend = await BACKENDS[BACKEND].load({ home });
    await backend.start();
  }, 120_000);

  afterAll(async () => {
    await backend?.close();
    if (home) removeDir(home);
  }, 60_000);

  describe('the node', () => {
    test("starts on the fixture's home with the test identity", async () => {
      expect(backend.embedded.isStarted()).toBe(true);
      expect(await backend.embedded.identity()).toEqual({
        did: fx.did,
        nid: fx.did.slice('did:key:'.length),
        alias: 'FreedomContract',
      });
    });

    test('every case has its vector, and every vector its case', () => {
      const recorded = [...Object.keys(VECTORS.reads), ...Object.keys(VECTORS.handlers)].sort();
      expect([...cases.keys()].sort()).toEqual(recorded);
    });
  });

  // Golden vectors: the same bytes as v0.8.0 and main's code at the
  // reference.
  describe('reads, byte for byte', () => {
    for (const [name, expected] of Object.entries(VECTORS?.reads || {})) {
      test(`${expected.class} ${name}`, async () => {
        const { op: _op, args: _args, class: _class, ...record } = expected;
        expect(await cases.get(name).run(backend)).toEqual(record);
      });
    }
  });

  describe('handlers, byte for byte', () => {
    for (const [name, expected] of Object.entries(VECTORS?.handlers || {})) {
      test(name, async () => {
        expect(await cases.get(name).run(backend)).toEqual(expected);
      });
    }
  });

  // radicle-embedded.js's exports keep their shapes, whatever serves them.
  describe('the exports', () => {
    test('the 30 required exports are all there', () => {
      expect(backend.embedded.REQUIRED_EXPORTS).toHaveLength(30);
      for (const name of backend.embedded.REQUIRED_EXPORTS) {
        expect(typeof backend.embedded[name]).toBe('function');
      }
    });

    const readVectors = Object.entries(VECTORS?.reads || {}).filter(
      ([, vector]) => vector.class !== 'composed'
    );
    for (const [name, vector] of readVectors) {
      test(`${name}: parsed as the vector, or rejected with its error`, async () => {
        const call = EMBEDDED_READS[vector.op](backend.embedded, vector.args);
        if ('error' in vector) {
          await expect(call).rejects.toThrow(vector.error);
        } else {
          expect(await call).toEqual(JSON.parse(vector.body));
        }
      });
    }

    const rawVectors = readVectors.filter(([, vector]) => EMBEDDED_RAW[vector.op]);
    for (const [name, vector] of rawVectors) {
      test(`${name}: the raw export is the vector's text`, async () => {
        const call = EMBEDDED_RAW[vector.op](backend.embedded, vector.args);
        if ('error' in vector) {
          await expect(call).rejects.toThrow(vector.error);
        } else {
          expect(await call).toBe(vector.body);
        }
      });
    }

    test('readme and readmeAt parse to the composed text, with the path', async () => {
      const composed = JSON.parse(VECTORS.reads['readme_at second'].body);
      expect(await backend.embedded.readmeAt(fx.rid, fx.commits.second)).toEqual(composed);
      expect(await backend.embedded.readme(fx.rid)).toEqual(composed);
    });

    test('cancelClone with no clone in flight answers, and changes nothing', async () => {
      await expect(backend.embedded.cancelClone(fx.rid)).resolves.toBeDefined();
      expect(await backend.readText('repo_info', { rid: fx.rid })).toBe(
        VECTORS.reads.repo_info.body
      );
    });
  });

  describe('the service', () => {
    pendingTest(
      'dirty-marker',
      'node/dirty is present for the whole run, and a clean stop clears it',
      async () => {
        const marker = path.join(home, 'node', 'dirty');
        expect(fs.existsSync(marker)).toBe(true);
        await backend.stop();
        expect(fs.existsSync(marker)).toBe(false);
        await backend.start();
        expect(fs.existsSync(marker)).toBe(true);
      },
      60_000
    );

    pendingTest(
      'quarantine',
      'no quarantine on a clean home, and a removal bound to no record removes nothing',
      async () => {
        expect(await backend.call('rad.quarantine_list', { page: 0 })).toEqual({
          entries: [],
          next_page: null,
        });
        await expect(
          backend.call('rad.remove_repo', { rid: fx.rid, qid: '0'.repeat(32) })
        ).rejects.toMatchObject({ code: 'not_quarantined' });
        expect(await backend.readText('repo_info', { rid: fx.rid })).toBe(
          VECTORS.reads.repo_info.body
        );
      }
    );

    pendingTest(
      'repository-gate',
      "while a repository is repaired its COB reads answer 503, and its file reads don't change",
      async () => {
        const issues = cases.get('rad GET /issues');
        const tree = cases.get(`rad GET /tree/${fx.commits.second}`);
        const release = await backend.hooks.holdRepair(fx.rid);
        try {
          const during = await issues.run(backend);
          expect(during.status).toBe(503);
          expect(JSON.parse(during.body)).toHaveProperty('error');
          expect(await tree.run(backend)).toEqual(
            VECTORS.handlers[`rad GET /tree/${fx.commits.second}`]
          );
        } finally {
          await release();
        }
        expect(await issues.run(backend)).toEqual(VECTORS.handlers['rad GET /issues']);
      }
    );

    pendingTest(
      'call-stream',
      "handlers' reads stream: the head gives the length, the body the vector's bytes",
      async () => {
        for (const name of ['commit second', 'tree_at second (root)', 'blob_at second README.md']) {
          const { op, args, body } = VECTORS.reads[name];
          const { head, body: stream } = await backend.embedded.callStream(op, args);
          const bytes = Buffer.from(await new Response(stream).arrayBuffer());
          expect(head).toEqual({
            content_type: 'application/json',
            bytes: Buffer.byteLength(body),
          });
          expect(bytes.toString('utf8')).toBe(body);
        }
        expect(backend.embedded.streamStats()).toEqual({ streams: 0, buffered: 0 });
      }
    );

    pendingTest(
      'call-stream',
      'a paused stream holds one ring in main: chunks of at most 64 KiB, at most 128 KiB buffered',
      async () => {
        const restore = backend.hooks.inflate('commit', 8 * MIB);
        try {
          const { head, body } = await backend.embedded.callStream('commit', {
            rid: fx.rid,
            revision: fx.commits.second,
          });
          expect(head.bytes).toBe(8 * MIB);
          const reader = body.getReader();
          let total = (await reader.read()).value.byteLength;
          expect(total).toBeLessThanOrEqual(CHUNK);

          // Paused: the service waits for credit, main buffers one ring.
          await sleep(500);
          expect(backend.embedded.streamStats()).toEqual({
            streams: 1,
            buffered: expect.any(Number),
          });
          expect(backend.embedded.streamStats().buffered).toBeLessThanOrEqual(RING);

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            expect(value.byteLength).toBeLessThanOrEqual(CHUNK);
            total += value.byteLength;
          }
          expect(total).toBe(head.bytes);
          expect(backend.embedded.streamStats()).toEqual({ streams: 0, buffered: 0 });
        } finally {
          restore();
        }
      },
      60_000
    );

    pendingTest(
      'call-stream',
      'four maximum-size results with paused consumers: one ring each in main, the output budget holds',
      async () => {
        const restore = backend.hooks.inflate('commit', 32 * MIB);
        const readers = [];
        try {
          for (let i = 0; i < 4; i++) {
            const { body } = await backend.embedded.callStream('commit', {
              rid: fx.rid,
              revision: fx.commits.second,
            });
            const reader = body.getReader();
            await reader.read();
            readers.push(reader);
          }
          await sleep(500);
          const { streams, buffered } = backend.embedded.streamStats();
          expect(streams).toBe(4);
          expect(buffered).toBeLessThanOrEqual(4 * RING);
          const { budget } = await backend.call('rad.stats', {});
          expect(budget.output.used).toBeLessThanOrEqual(budget.output.limit);
          expect(budget.output.limit).toBe(256 * MIB);
        } finally {
          for (const reader of readers) await reader.cancel();
          restore();
        }
        expect(backend.embedded.streamStats()).toEqual({ streams: 0, buffered: 0 });
      },
      60_000
    );

    pendingTest(
      'call-scoped',
      'collected results are parsed in a scope, and the collection budget is free once it settles',
      async () => {
        for (const name of ['identity', 'status', 'repo_info', 'list_seeded_repos']) {
          const { op, args, body } = VECTORS.reads[name];
          const value = await backend.embedded.callScoped(op, args, async (parsed) => parsed);
          expect(value).toEqual(JSON.parse(body));
        }
        expect(backend.embedded.collectionBudget()).toEqual({ held: 0, limit: 16 * MIB });
      }
    );

    pendingTest(
      'call-scoped',
      "each collected result has its cap: at the cap it's parsed, one byte past it is too_large",
      async () => {
        const capped = [
          ['status', {}, 64 * KIB],
          ['identity', {}, 64 * KIB],
          ['repo_info', { rid: fx.rid }, 64 * KIB],
          ['seeders', { rid: fx.rid }, 64 * KIB],
          ['list_seeded_repos', {}, 4 * MIB],
          ['list_repos', {}, 4 * MIB],
        ];
        for (const [op, args, cap] of capped) {
          for (const [bytes, accepted] of [
            [cap, true],
            [cap + 1, false],
          ]) {
            const restore = backend.hooks.inflate(op, bytes);
            let ran = false;
            try {
              const call = backend.embedded.callScoped(op, args, async () => {
                ran = true;
              });
              if (accepted) {
                await call;
                expect(ran).toBe(true);
              } else {
                await expect(call).rejects.toMatchObject({ code: 'too_large' });
                expect(ran).toBe(false);
              }
            } finally {
              restore();
            }
          }
        }
        expect(backend.embedded.collectionBudget().held).toBe(0);
      },
      60_000
    );

    pendingTest(
      'call-scoped',
      'the 16 MiB budget: held and aborted scopes keep their bytes until they settle, and a call that finds no room is busy after 5 s',
      async () => {
        const restore = backend.hooks.inflate('list_seeded_repos', 3 * MIB);
        const entered = [];
        const settle = [];
        const values = [];
        const controllers = Array.from({ length: 7 }, () => new AbortController());
        try {
          const calls = controllers.map((controller, index) =>
            backend.embedded
              .callScoped(
                'list_seeded_repos',
                {},
                (value) =>
                  new Promise((resolve) => {
                    // The scope keeps the value it was handed until it settles.
                    values[index] = value;
                    entered.push(index);
                    settle[index] = resolve;
                  }),
                { signal: controller.signal }
              )
              .then(
                () => 'ok',
                (err) => err.code
              )
          );
          // Wait for the first result to be handed over (within the read
          // deadline), then for admissions to stop.
          await waitUntil(() => entered.length > 0, 60_000);
          await quiet(() => entered.length);
          const room = entered.length;
          const { held, limit } = backend.embedded.collectionBudget();
          expect(limit).toBe(16 * MIB);
          expect(held).toBeLessThanOrEqual(limit);
          // Each admitted scope holds a value of at least 3 MiB, and is
          // charged at least that much: so at most five fit in 16 MiB, and
          // at least one of the seven calls is still waiting after a release.
          for (const index of entered) {
            expect(JSON.stringify(values[index]).length).toBeGreaterThanOrEqual(3 * MIB);
          }
          expect(held).toBeGreaterThanOrEqual(room * 3 * MIB);
          expect(room).toBeGreaterThan(0);
          expect(room).toBeLessThanOrEqual(Math.floor((16 * MIB) / (3 * MIB)));

          // An aborted scope keeps its reservation while its callback runs.
          const aborted = entered[0];
          controllers[aborted].abort();
          await sleep(500);
          expect(entered).toHaveLength(room);
          expect(backend.embedded.collectionBudget().held).toBe(held);

          // Settled, its bytes go to a call that was waiting.
          settle[aborted]();
          await waitUntil(() => entered.length === room + 1);
          expect(backend.embedded.collectionBudget().held).toBeLessThanOrEqual(limit);

          // The calls still waiting fail busy once 5 s have passed.
          await sleep(5500);
          for (const index of entered) settle[index]?.();
          const outcomes = await Promise.all(calls);
          const busy = outcomes.filter((outcome) => outcome === 'busy');
          expect(busy.length).toBeGreaterThanOrEqual(1);
          expect(busy).toHaveLength(7 - room - 1);
          expect(backend.embedded.collectionBudget().held).toBe(0);
        } finally {
          for (const resolve of settle) resolve?.();
          restore();
        }
      },
      60_000
    );

    pendingTest(
      'node-info',
      'node_info composes the peer count and the repository count',
      async () => {
        expect(await backend.readText('node_info', {})).toBe(
          JSON.stringify({ connected_peers: 0, repos_total: 1, repos_error: null })
        );
      }
    );

    pendingTest(
      'progress-summary',
      'past 8 peer failures, progress folds into one summary; every rad.progress envelope, escaped, fits 4 KiB',
      async () => {
        // Escapes and multibyte characters all through each reason, so the
        // part an event keeps has them too: a NUL is 6 bytes in the event's
        // JSON and 7 in the envelope's, a quote and a backslash 4 each.
        const mixed = `${NUL}\\"${E_ACUTE}${ROCKET}x`;
        const reason = mixed.repeat(600);
        const envelopes = await backend.hooks.scriptedClone(fx.rid, { failures: 20, reason });

        for (const envelope of envelopes) {
          expect(typeof envelope).toBe('string');
          expect(Buffer.byteLength(envelope)).toBeLessThanOrEqual(4096);
        }
        const events = envelopes.map(progressEvent);
        const failures = events.filter((event) => event.phase === 'peer-failed');
        const summaries = failures.filter((event) => event.summary);
        const single = failures.filter((event) => !event.summary);

        expect(single.length).toBeLessThanOrEqual(8);
        expect(summaries).toHaveLength(1);
        const { summary } = summaries[0];
        expect(single.length + summary.count).toBe(20);
        expect(summary.reasons.length).toBeGreaterThan(0);
        expect(summary.reasons.length).toBeLessThanOrEqual(4);
        for (const text of [...single.map((event) => event.reason), ...summary.reasons]) {
          // Cut at character boundaries, and still holding what needs escaping.
          expect(text.isWellFormed()).toBe(true);
          expect(text.endsWith('…')).toBe(true);
          for (const part of [NUL, '\\', '"', E_ACUTE, ROCKET]) expect(text).toContain(part);
        }
        expect(events.at(-1).phase).toMatch(/^(done|failed|cancelled)$/);
      }
    );

    pendingTest(
      'import-in-process',
      "an import leaves the working copy's configuration and refs untouched",
      async () => {
        const workingCopy = tempDir('rad-contract-wc-');
        try {
          buildSmallWorkingCopy(workingCopy);
          const before = snapshotGitDir(workingCopy);
          const { rid } = await backend.embedded.importRepo(
            workingCopy,
            'contract-untouched',
            'Imported in process.',
            'main'
          );
          expect(rid).toMatch(RID_RE);
          expect(snapshotGitDir(workingCopy)).toEqual(before);
          await backend.embedded.unseedRepo(rid);
        } finally {
          removeDir(workingCopy);
        }
      },
      60_000
    );
  });

  // What the service refuses, or reads differently, by design.
  describe('caps and text', () => {
    pendingTest(
      'size-caps',
      'a blob over 64 MiB is too_large: refused by the read, 413 at both handlers',
      async () => {
        const args = { rid: fx.rid, revision: fx.commits.second, path: 'big.bin' };
        await expect(backend.readText('blob_at', args)).rejects.toMatchObject({
          code: 'too_large',
        });
        for (const [route, method] of [
          [`/blob/${fx.commits.second}/big.bin`, 'GET'],
          [`/raw/${fx.commits.second}/big.bin`, 'GET'],
          [`/raw/${fx.commits.second}/big.bin`, 'HEAD'],
        ]) {
          const res = await backend.rad.handleRadRequest(
            new Request(`rad://${fx.rid.slice('rad:'.length)}${route}`, { method })
          );
          expect(res.status).toBe(413);
          await res.arrayBuffer();
        }
        // The rest of the repository reads as before.
        expect(await backend.readText('repo_info', { rid: fx.rid })).toBe(
          VECTORS.reads.repo_info.body
        );
      },
      60_000
    );

    pendingTest(
      'malformed-utf8',
      "a text blob that isn't valid UTF-8 reads as lossy text, the same bytes through the read and the handler",
      async () => {
        const workingCopy = tempDir('rad-contract-wc-');
        try {
          // Latin-1 text: each byte above 0x7f is invalid UTF-8 on its own.
          const content = Buffer.from([
            0x63, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65, 0x0a,
          ]);
          const revision = buildSmallWorkingCopy(workingCopy, { name: 'latin1.txt', content });
          const { rid } = await backend.embedded.importRepo(
            workingCopy,
            'contract-latin1',
            'Latin-1 text.',
            'main'
          );
          // The JSON endpoint stays as it is: `from_utf8_lossy` text, not
          // binary, U+FFFD for each invalid byte.
          const expected = `{"binary":false,"name":"latin1.txt","content":${JSON.stringify(
            content.toString('utf8')
          )}}`;
          expect(expected).toContain(String.fromCharCode(0xfffd));
          expect(await backend.readText('blob_at', { rid, revision, path: 'latin1.txt' })).toBe(
            expected
          );
          const res = await backend.rad.handleRadRequest(
            new Request(`rad://${rid.slice('rad:'.length)}/blob/${revision}/latin1.txt`)
          );
          expect(res.status).toBe(200);
          expect(await res.text()).toBe(expected);
          await backend.embedded.unseedRepo(rid);
        } finally {
          removeDir(workingCopy);
        }
      },
      60_000
    );
  });

  // The raw endpoint: `rad://<rid>/raw/<commit>/<path>`.
  describe('the blob API', () => {
    const raw = (file, { method = 'GET', range = null } = {}) =>
      backend.rad.handleRadRequest(
        new Request(`rad://${fx.rid.slice('rad:'.length)}/raw/${fx.commits.second}/${file}`, {
          method,
          headers: range ? { Range: range } : {},
        })
      );
    const README = 'README.md';
    const readmeBytes = () =>
      Buffer.from(JSON.parse(VECTORS.reads[`blob_at second ${README}`].body).content, 'utf8');
    const blobOid = (bytes) =>
      crypto
        .createHash('sha1')
        .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
        .digest('hex');

    pendingTest('blob-api', 'the whole blob: 200 with its bytes and inert headers', async () => {
      const bytes = readmeBytes();
      const res = await raw(README);

      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
      expect(res.headers.get('content-length')).toBe(String(bytes.length));
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('etag')).toBe(`"${blobOid(bytes)}"`);
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe('sandbox');
      expect(res.headers.get('content-type')).not.toMatch(/html|xml|javascript|svg/i);
    });

    pendingTest('blob-api', 'content types come from an inert allowlist', async () => {
      const types = {
        'notes.txt': 'text/plain; charset=utf-8',
        'image.png': 'image/png',
        link: 'application/octet-stream',
      };
      for (const [file, type] of Object.entries(types)) {
        const res = await raw(file);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(type);
        await res.arrayBuffer();
      }
    });

    pendingTest('blob-api', 'ranges: 206 with Content-Range, an end past EOF clamped', async () => {
      const bytes = readmeBytes();
      const size = bytes.length;
      const cases = [
        ['bytes=0-9', 0, 9],
        ['bytes=5-', 5, size - 1],
        ['bytes=-10', size - 10, size - 1],
        [`bytes=5-${size + 1000}`, 5, size - 1],
      ];
      for (const [range, start, end] of cases) {
        const res = await raw(README, { range });
        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/${size}`);
        expect(res.headers.get('content-length')).toBe(String(end - start + 1));
        expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(start, end + 1))).toBe(
          true
        );
      }
    });

    pendingTest(
      'blob-api',
      'a start past EOF is 416; several ranges are the whole blob',
      async () => {
        const size = readmeBytes().length;
        const past = await raw(README, { range: `bytes=${size}-` });
        expect(past.status).toBe(416);
        expect(past.headers.get('content-range')).toBe(`bytes */${size}`);
        await past.arrayBuffer();

        const several = await raw(README, { range: 'bytes=0-1,4-5' });
        expect(several.status).toBe(200);
        expect((await several.arrayBuffer()).byteLength).toBe(size);
      }
    );

    pendingTest('blob-api', 'a zero-length blob: 200 with no range, 416 with one', async () => {
      const whole = await raw('empty.txt');
      expect(whole.status).toBe(200);
      expect(whole.headers.get('content-length')).toBe('0');
      expect((await whole.arrayBuffer()).byteLength).toBe(0);

      const ranged = await raw('empty.txt', { range: 'bytes=0-' });
      expect(ranged.status).toBe(416);
      expect(ranged.headers.get('content-range')).toBe('bytes */0');
      await ranged.arrayBuffer();
    });

    pendingTest(
      'blob-api',
      'HEAD answers as GET would, with no body, with and without a range',
      async () => {
        for (const [range, status] of [
          [null, 200],
          ['bytes=0-9', 206],
          ['bytes=999999-', 416],
        ]) {
          const get = await raw(README, { range });
          expect(get.status).toBe(status);
          await get.arrayBuffer();
          const head = await raw(README, { method: 'HEAD', range });
          expect(head.status).toBe(get.status);
          expect([...head.headers]).toEqual([...get.headers]);
          expect(head.body).toBeNull();
        }
      }
    );
  });

  // Writes change the restored home, so they come after every other test.
  describe('writes', () => {
    test('an issue created, commented on and closed reads back as written', async () => {
      const e = backend.embedded;
      const created = await e.createIssue(fx.rid, 'Written by the suite', 'Body text.', ['suite']);
      expect(created.id).toMatch(OID_RE);
      const comment = await e.commentIssue(fx.rid, created.id, 'A comment.', null);
      expect(comment.id).toMatch(OID_RE);
      const closed = await e.editIssueState(fx.rid, created.id, 'closed');
      expect(closed).toEqual({ id: created.id, state: 'closed' });

      const issue = await e.issue(fx.rid, created.id);
      expect(issue).toMatchObject({
        id: created.id,
        title: 'Written by the suite',
        labels: ['suite'],
        state: { status: 'closed' },
        author: { id: fx.did },
      });
      expect(issue.discussion.map((entry) => entry.body)).toEqual(['Body text.', 'A comment.']);
      expect((await e.issues(fx.rid)).map((entry) => entry.id)).toContain(created.id);
    });

    test('a comment on an unknown patch revision is refused', async () => {
      await expect(
        backend.embedded.commentPatch(fx.rid, '0'.repeat(40), 'A comment.')
      ).rejects.toThrow();
    });

    test('an imported repository is listed and seeded, then unseeded', async () => {
      const workingCopy = tempDir('rad-contract-wc-');
      try {
        buildSmallWorkingCopy(workingCopy);
        const e = backend.embedded;
        const { rid } = await e.importRepo(workingCopy, 'contract-import', 'Imported.', 'main');
        expect(rid).toMatch(RID_RE);
        expect((await e.listRepos()).map((repo) => repo.rid)).toContain(rid);
        expect((await e.listSeededRepos()).map((repo) => repo.rid)).toContain(rid);
        expect(await e.repoInfo(rid)).toMatchObject({
          rid,
          name: 'contract-import',
          defaultBranch: 'main',
          delegates: [fx.did],
        });

        await e.unseedRepo(rid);
        expect((await e.listSeededRepos()).map((repo) => repo.rid)).not.toContain(rid);
      } finally {
        removeDir(workingCopy);
      }
    }, 60_000);

    test('a stop and a start keep the home as it was', async () => {
      await backend.stop();
      expect(backend.embedded.isStarted()).toBe(false);
      await backend.start();
      expect(await backend.readText('tree_at', VECTORS.reads['tree_at second (root)'].args)).toBe(
        VECTORS.reads['tree_at second (root)'].body
      );
    }, 60_000);
  });
});

/** A small working copy for imports: one commit with one file. Returns the
 * commit. */
function buildSmallWorkingCopy(dir, { name = 'file.txt', content = `imported at ${dir}\n` } = {}) {
  const { execFileSync } = require('child_process');
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Contract Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Contract Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '1700000200 +0000',
    GIT_COMMITTER_DATE: '1700000200 +0000',
  };
  const git = (args, input) =>
    execFileSync('git', args, { cwd: dir, env, input }).toString().trim();
  git(['init', '-q']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const file = git(['hash-object', '-w', '--stdin'], content);
  const tree = git(['mktree'], `100644 blob ${file}\t${name}\n`);
  const commit = git(['commit-tree', tree, '-m', 'Imported']);
  git(['update-ref', 'refs/heads/main', commit]);
  return commit;
}

/** A working copy's configuration and refs, as text. */
function snapshotGitDir(dir) {
  const gitDir = path.join(dir, '.git');
  const refs = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else refs.push([path.relative(gitDir, full), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(path.join(gitDir, 'refs'));
  return {
    config: fs.readFileSync(path.join(gitDir, 'config'), 'utf8'),
    refs: refs.sort(),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `read()` has stayed the same for 500 ms (at most 10 s). */
async function quiet(read) {
  let last = read();
  let stable = 0;
  for (let i = 0; i < 200 && stable < 10; i++) {
    await sleep(50);
    const now = read();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

/** The progress event a `rad.progress` envelope carries, as a JSON string. */
function progressEvent(envelope) {
  const message = JSON.parse(envelope);
  const params = message.params ?? message;
  expect(typeof params.event).toBe('string');
  return JSON.parse(params.event);
}

/** Polls `predicate` until it holds, for up to 5 s. */
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error('timed out waiting');
}
