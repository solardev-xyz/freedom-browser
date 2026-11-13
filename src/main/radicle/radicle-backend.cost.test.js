/**
 * What serving Radicle from freedom-radicled costs against the add-on
 * (freedom-core design 0008, "Gates"), on one runner:
 *
 * - the `rad:` metadata read: `rad://<rid>/tree/<commit>` on the contract
 *   fixture, which is `repo_info` (the handler's visibility check) plus
 *   `tree_at`, timed to the body's last byte;
 * - the time to the last byte of a 1 MiB text blob through `rad:`'s
 *   `/blob/` (`repo_info` plus `blob_at`).
 *
 * The gates are 0008's: freedom-radicled's median metadata read no more
 * than 5 ms slower than the add-on's, and its median blob no more than
 * 10 ms. Unset or '1' (CI, a local run), FREEDOM_RADICLE_COST_ENFORCE fails
 * the run on a miss, with both medians in the message; '0' reports each
 * gate's verdict without failing. Everything else fails in both modes: a
 * backend running the wrong node, a read that isn't a 200 with the same
 * bytes from both, a run that doesn't complete
 * (`test/helpers/radicle-cost-report.js`).
 *
 * - **The production path:** both backends are the contract suite's
 *   (`test/helpers/radicle-contract-backends.js`): `radicle-manager.js` and
 *   its node, the add-on's in this process under the binary's `hold-lock`
 *   and freedom-radicled's the real binary, each loader with its own kind
 *   fixed, so the two share the process. Every read is `rad:`'s own
 *   `handleRadRequest`, with its admission (rad-read-admission.js on the
 *   add-on, main's dweb admission on the service), its body read as it
 *   comes.
 * - **The same bytes:** each backend serves a home of its own, restored
 *   from one snapshot: the contract fixture's home with a second
 *   repository, imported once through the add-on, whose one file is the
 *   1 MiB of text. Both answer every read with the same body, checked on
 *   every measured read.
 * - **Noise:** warm-up rounds are discarded; within each round the backends
 *   alternate, and which goes first alternates between rounds, so runner
 *   noise lands on both alike. The gates judge medians over hundreds of
 *   samples. A gate that misses is measured once more, and judged on both
 *   runs' samples pooled (`judgeGates`), never on the better run alone.
 *
 * Skipped unless FREEDOM_RADICLE_COST=1; it needs the add-on (`npm run
 * radicle:download`) and the binary (`npm run radicled:download`, or
 * FREEDOM_RADICLED_PATH). The table goes to the console, and to
 * GITHUB_STEP_SUMMARY when it is set; the numbers to
 * FREEDOM_RADICLE_COST_OUT (default `<tmp>/radicle-cost.json`). Rounds:
 * FREEDOM_RADICLE_COST_METADATA (300) and FREEDOM_RADICLE_COST_BLOB (300).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { BACKENDS } = require('../../../test/helpers/radicle-contract-backends');
const {
  VECTORS_PATH,
  restoreSnapshot,
  writeSnapshot,
} = require('../../../test/helpers/radicle-fixture');
const { summarize } = require('../../../test/helpers/ipfs-cost-report');
const {
  GATES,
  costEnforced,
  costTable,
  gateMessage,
  judgeGates,
} = require('../../../test/helpers/radicle-cost-report');

const describeCost = process.env.FREEDOM_RADICLE_COST === '1' ? describe : describe.skip;

const rounds = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const warmupFor = (measured) => Math.max(10, Math.round(measured / 10));
const METADATA_ROUNDS = rounds('FREEDOM_RADICLE_COST_METADATA', 300);
const BLOB_ROUNDS = rounds('FREEDOM_RADICLE_COST_BLOB', 300);
const BLOB_BYTES = 1024 * 1024;
const BLOB_NAME = 'text.txt';

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const removeDir = (dir) =>
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** `length` bytes of printable text in lines, the same on every run. */
function textOf(length) {
  const lines = [];
  let size = 0;
  for (let i = 0; size < length; i++) {
    const line = `${String(i).padStart(6, '0')} the Radicle cost fixture's text, line by line.\n`;
    lines.push(line);
    size += line.length;
  }
  const text = lines.join('').slice(0, length - 1);
  return Buffer.from(`${text}\n`);
}

/**
 * A working copy in `dir` (an empty directory) whose one commit holds
 * `name` with `content`, built with git's plumbing, with a fixed author and
 * date; resolves to the commit.
 */
function buildTextWorkingCopy(dir, name, content) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Cost Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Cost Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '1700000300 +0000',
    GIT_COMMITTER_DATE: '1700000300 +0000',
  };
  const git = (args, input) =>
    execFileSync('git', args, { cwd: dir, env, input, maxBuffer: 4 * content.length })
      .toString()
      .trim();
  git(['init', '-q']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const file = git(['hash-object', '-w', '--stdin'], content);
  const tree = git(['mktree'], `100644 blob ${file}\t${name}\n`);
  const commit = git(['commit-tree', tree, '-m', 'The text']);
  git(['update-ref', 'refs/heads/main', commit]);
  return commit;
}

/**
 * One GET as a page makes it, through `rad:`'s handler: resolves to the
 * status, the time to the body's last byte (ms from the call), and the
 * body.
 */
async function readTimed(backend, url) {
  const started = performance.now();
  const res = await backend.rad.handleRadRequest(new Request(url));
  const chunks = [];
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
    }
  }
  const ms = performance.now() - started;
  return { status: res.status, ms, body: Buffer.concat(chunks) };
}

/**
 * `rounds` measured rounds after `warmup` discarded ones; each round runs
 * `sample` once per backend, the order swapping every round.
 */
async function interleaved(backends, { warmup, rounds: measured }, sample) {
  const samples = Object.fromEntries(backends.map((backend) => [backend.name, []]));
  for (let i = 0; i < warmup + measured; i++) {
    const order = i % 2 === 0 ? backends : [...backends].reverse();
    for (const backend of order) {
      const value = await sample(backend);
      if (i >= warmup) samples[backend.name].push(value);
    }
  }
  return samples;
}

describeCost('Radicle cost: freedom-radicled against the add-on (0008, Gates)', () => {
  const dirs = [];
  let backends = [];
  let reads;
  let results;

  beforeAll(async () => {
    const vectors = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));
    const fx = vectors.fixture;

    // The homes' snapshot: the contract fixture's home, and a repository
    // holding the 1 MiB of text, imported through the add-on.
    const workingCopy = tempDir('rad-cost-wc-');
    const seedHome = tempDir('rad-cost-');
    const snapshotDir = tempDir('rad-cost-snap-');
    dirs.push(workingCopy, seedHome, snapshotDir);
    const text = textOf(BLOB_BYTES);
    const commit = buildTextWorkingCopy(workingCopy, BLOB_NAME, text);
    restoreSnapshot(seedHome);
    const seeding = await BACKENDS.addon.load({ home: seedHome });
    let textRid;
    try {
      await seeding.start();
      ({ rid: textRid } = await seeding.embedded.importRepo(
        workingCopy,
        'radicle-cost-text',
        "The Radicle cost measurement's 1 MiB of text",
        'main'
      ));
    } finally {
      await seeding.close();
    }
    const snapshot = path.join(snapshotDir, 'home.json.gz');
    writeSnapshot(seedHome, snapshot);

    // The add-on first: each backend's modules are loaded, with its kind,
    // before the next loader resets the registry.
    for (const name of ['addon', 'radicled']) {
      const home = tempDir('rad-cost-');
      dirs.push(home);
      restoreSnapshot(home, snapshot);
      const backend = await BACKENDS[name].load({ home });
      backends.push(backend);
      await backend.start();
    }

    // Each runs the node it names: only the service reports its build.
    const service = async (backend) => (await backend.manager.getConnections()).service;
    const [addonService, radicledService] = await Promise.all(backends.map(service));
    expect(addonService).toBeUndefined();
    expect(radicledService).toEqual(expect.any(String));

    const base = (rid) => `rad://${rid.slice('rad:'.length)}`;
    reads = {
      metadataMs: { url: `${base(fx.rid)}/tree/${fx.commits.second}` },
      blobMs: { url: `${base(textRid)}/blob/${commit}/${BLOB_NAME}` },
    };
    // The same bytes from both, the blob's content the text itself.
    for (const read of Object.values(reads)) {
      const bodies = [];
      for (const backend of backends) {
        const { status, body } = await readTimed(backend, read.url);
        expect({ backend: backend.name, url: read.url, status }).toEqual({
          backend: backend.name,
          url: read.url,
          status: 200,
        });
        bodies.push(body);
      }
      expect(sha256(bodies[1])).toBe(sha256(bodies[0]));
      read.sha256 = sha256(bodies[0]);
      read.bytes = bodies[0].length;
    }
    const blob = JSON.parse((await readTimed(backends[0], reads.blobMs.url)).body.toString());
    expect(blob.binary).toBe(false);
    expect(Buffer.from(blob.content).equals(text)).toBe(true);
  }, 180_000);

  afterAll(async () => {
    for (const backend of backends) await backend.close();
    backends = [];
    for (const dir of dirs) removeDir(dir);
  }, 60_000);

  test('measures both backends on this runner', async () => {
    // One read, whole and the same as the first: its time to the last byte.
    const timed = (read) => async (backend) => {
      const { status, ms, body } = await readTimed(backend, read.url);
      if (status !== 200 || body.length !== read.bytes || sha256(body) !== read.sha256) {
        throw new Error(
          `${backend.name}: ${read.url} answered ${status} with ${body.length} bytes, not ` +
            `the ${read.bytes} both answered first`
        );
      }
      return ms;
    };
    const plan = {
      metadataMs: { warmup: warmupFor(METADATA_ROUNDS), rounds: METADATA_ROUNDS },
      blobMs: { warmup: warmupFor(BLOB_ROUNDS), rounds: BLOB_ROUNDS },
    };
    const measure = (name) => interleaved(backends, plan[name], timed(reads[name]));
    const firstRun = {
      metadataMs: await measure('metadataMs'),
      blobMs: await measure('blobMs'),
    };
    const { samples, gates } = await judgeGates(firstRun, measure);

    const measured = (name, extra) => ({
      ...extra,
      rounds: samples[name].addon.length,
      warmup: plan[name].warmup,
      addon: summarize(samples[name].addon, 3),
      radicled: summarize(samples[name].radicled, 3),
      ...gates[name],
    });
    results = {
      enforced: costEnforced(),
      target: `${process.platform}-${process.arch}`,
      cpu: os.cpus()[0]?.model?.trim() || 'unknown CPU',
      cpus: os.cpus().length,
      node: process.versions.node,
      metadata: measured('metadataMs', { bodyBytes: reads.metadataMs.bytes }),
      blob: measured('blobMs', { bytes: BLOB_BYTES, bodyBytes: reads.blobMs.bytes }),
    };

    const out = process.env.FREEDOM_RADICLE_COST_OUT || path.join(os.tmpdir(), 'radicle-cost.json');
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    const markdown = costTable(results);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    }
    console.log(`${markdown}\n${out}`);
    expect(results.metadata.addon.median).toBeGreaterThan(0);
  }, 600_000);

  // 0008's gates: a miss fails only where they are enforced
  // (FREEDOM_RADICLE_COST_ENFORCE), with both medians in its message; the
  // verdict is logged either way.
  const gateTest = (key, name, title) =>
    test(title, () => {
      expect(results).toBeDefined();
      const gate = results[key];
      const message = gateMessage(name, gate, results.target);
      console.log(message);
      // The verdict, judged unrounded (gateVerdicts), not the report's figure.
      if (results.enforced && !gate.pass) throw new Error(message);
    });
  gateTest(
    'metadata',
    'metadataMs',
    `freedom-radicled's median rad: metadata read is at most ${GATES.metadataMs} ms slower than the add-on's`
  );
  gateTest(
    'blob',
    'blobMs',
    `freedom-radicled's median 1 MiB blob through /blob/ is at most ${GATES.blobMs} ms slower than the add-on's`
  );
});
