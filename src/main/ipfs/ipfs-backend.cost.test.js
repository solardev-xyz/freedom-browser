/**
 * What running IPFS on freedom-ipfsd costs against the add-on (freedom-core
 * design 0007, "Cost"), measured before the default switches, on one runner:
 *
 * - the time to first byte of a cached 1 KiB file;
 * - the throughput of a cached 100 MiB file;
 * - #102's fan-out: a page's 96 assets fetched 48 at a time, here from the
 *   loopback fixture rather than the public network.
 *
 * The gates are 0007's: freedom-ipfsd's median first byte no more than 5 ms
 * later than the add-on's, and its median throughput at least 80 % of the
 * add-on's. The fan-out is reported, not gated. The gates guard the default
 * switch: until then CI runs with FREEDOM_IPFS_COST_ENFORCE=0, which reports
 * each gate's verdict without failing on a miss; unset or '1' (a local run,
 * the switch), a miss fails. Everything else fails in both modes: a backend
 * running the wrong node, a measured run that reaches the fixture, a run
 * that doesn't complete (`test/helpers/ipfs-cost-report.js`).
 *
 * - **The production path:** both backends are the contract suite's
 *   (`test/helpers/ipfs-contract-backends.js`): `ipfs-manager.js` and its
 *   node, the add-on's in this process and freedom-ipfsd's the real binary,
 *   each with a store of its own over one loopback fixture. Every request
 *   goes through `ipfsBackend()`, captured as the handler captures it, then
 *   `request()`, its body read as it comes. The ipfsd backend runs without
 *   the suite's stats shims, as production runs it.
 * - **Cached:** each file is fetched once first, so the measured runs are
 *   served from the node's own store; one that asks the fixture for a block
 *   fails the run.
 * - **Noise:** warm-up rounds are discarded; within each round the backends
 *   alternate, and which goes first alternates between rounds, so runner
 *   noise lands on both alike.
 *
 * Skipped unless FREEDOM_IPFS_COST=1; it needs the add-on (`npm run
 * ipfs:download`) and the binary (`npm run ipfsd:download`). The table goes
 * to the console, and to GITHUB_STEP_SUMMARY when it is set; the numbers to
 * FREEDOM_IPFS_COST_OUT (default `<tmp>/ipfs-cost.json`). Rounds:
 * FREEDOM_IPFS_COST_TTFB (300), FREEDOM_IPFS_COST_THROUGHPUT (9) and
 * FREEDOM_IPFS_COST_FANOUT (7).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { BACKENDS } = require('../../../test/helpers/ipfs-contract-backends');
const { IpfsContent, startIpfsFixture } = require('../../../test/helpers/ipfs-fixture');
const {
  GATES,
  costEnforced,
  costTable,
  gateOutcome,
  gateVerdicts,
  round,
  summarize,
} = require('../../../test/helpers/ipfs-cost-report');

const describeCost = process.env.FREEDOM_IPFS_COST === '1' ? describe : describe.skip;

const rounds = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const MIB = 1024 * 1024;
const SMALL_BYTES = 1024;
const LARGE_BYTES = 100 * MIB;
const TTFB_ROUNDS = rounds('FREEDOM_IPFS_COST_TTFB', 300);
const TTFB_WARMUP = Math.max(10, Math.round(TTFB_ROUNDS / 10));
const THROUGHPUT_ROUNDS = rounds('FREEDOM_IPFS_COST_THROUGHPUT', 9);
const THROUGHPUT_WARMUP = 1;
const FANOUT_ROUNDS = rounds('FREEDOM_IPFS_COST_FANOUT', 7);
const FANOUT_WARMUP = 1;
const FANOUT_ASSETS = 96;
const FANOUT_CONCURRENCY = 48;
const HEADERS_MS = 30_000;

/** `length` bytes, the same for a seed and unlike any other's. */
function bytesOf(length, seed) {
  let x = (0x9e3779b9 ^ seed) >>> 0;
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

/**
 * One GET as the handler makes it: the backend captured now, then its
 * request(). Resolves to the status, the time to the first body byte and to
 * the last (ms from the call), and the bytes read.
 */
async function fetchTimed(backend, gatewayPath) {
  const started = performance.now();
  const captured = backend.manager.ipfsBackend({ partition: null });
  try {
    const res = await captured.request({
      path: gatewayPath,
      method: 'GET',
      headers: new Headers({ accept: '*/*' }),
      headersTimeoutMs: HEADERS_MS,
    });
    const reader = res.body.getReader();
    let first = null;
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      first ??= performance.now() - started;
      bytes += chunk.value.byteLength;
    }
    return {
      status: res.status,
      errorCode: res.headers.get('x-freedom-ipfs-error-code'),
      firstByteMs: first,
      lastByteMs: performance.now() - started,
      bytes,
    };
  } finally {
    captured.release?.();
  }
}

/** One full read of a file, which must come back whole. */
async function fetchWhole(backend, gatewayPath, size) {
  const result = await fetchTimed(backend, gatewayPath);
  if (result.status !== 200 || result.bytes !== size) {
    throw new Error(
      `${backend.name}: ${gatewayPath} answered ${result.status} with ${result.bytes} of ${size} bytes`
    );
  }
  return result;
}

/** The page's assets, `FANOUT_CONCURRENCY` at a time: the wall time, and
 * what didn't come back 2xx. */
async function fanOut(backend, assets) {
  const started = performance.now();
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const asset = assets[next++];
      const result = await fetchTimed(backend, asset.path);
      if (result.status !== 200 || result.bytes !== asset.size) failed.push(result);
    }
  };
  await Promise.all(Array.from({ length: FANOUT_CONCURRENCY }, worker));
  return {
    ms: performance.now() - started,
    non2xx: failed.length,
    gatewayBusy: failed.filter((result) => result.errorCode === 'gateway_busy').length,
  };
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

const blockRequests = (fixture) =>
  fixture.requests.filter((request) => request.kind === 'block').length;

describeCost('IPFS cost: freedom-ipfsd against the add-on (0007, Cost)', () => {
  let fixture;
  let backends;
  let site;
  let results;

  beforeAll(async () => {
    const content = new IpfsContent();
    const small = content.file(bytesOf(SMALL_BYTES, 1));
    const large = content.file(bytesOf(LARGE_BYTES, 2));
    // #102's shape: a page and its 96 assets, 2 to 48 KiB each.
    const entries = { 'index.html': content.file('<html><body>fan-out</body></html>') };
    const sizes = [];
    for (let i = 0; i < FANOUT_ASSETS; i++) {
      const name = `asset-${String(i).padStart(2, '0')}.bin`;
      sizes.push([name, 1024 * (2 + ((i * 7) % 47))]);
      entries[name] = content.file(bytesOf(sizes.at(-1)[1], 100 + i));
    }
    const page = content.dir(entries);
    site = {
      small: { path: `/ipfs/${small.cid}`, size: SMALL_BYTES },
      large: { path: `/ipfs/${large.cid}`, size: LARGE_BYTES },
      assets: sizes.map(([name, size]) => ({ path: `/ipfs/${page.cid}/${name}`, size })),
    };
    fixture = await startIpfsFixture(content);

    // The add-on first: the ipfsd backend sets FREEDOM_IPFS_BACKEND=service
    // for the manager it loads, which a later start of the add-on's manager
    // would read too.
    const addon = await BACKENDS.addon.load({ router: fixture.router });
    await addon.manager.startIpfs();
    const ipfsd = await BACKENDS.ipfsd.load({ router: fixture.router, freshStats: false });
    await ipfsd.manager.startIpfs();
    backends = [addon, ipfsd];
    for (const backend of backends) {
      expect(backend.manager.ipfsBackend({ partition: null }).ref.up).toBe(true);
    }
    // Each runs the node it names: the service reports its own build.
    const service = (backend) =>
      JSON.parse(backend.manager.getNativeDiagnostics().nativeBuildInfo).service?.name ?? null;
    expect(backends.map(service)).toEqual([null, 'freedom-ipfsd']);
  }, 120_000);

  afterAll(async () => {
    for (const backend of backends || []) await backend.close();
    await fixture?.close();
  }, 60_000);

  test('measures both backends on this runner', async () => {
    // Cache fill: every file once through each backend, the fan-out's
    // cold run timed.
    const coldMs = {};
    for (const backend of backends) {
      await fetchWhole(backend, site.small.path, site.small.size);
      await fetchWhole(backend, site.large.path, site.large.size);
      const cold = await fanOut(backend, site.assets);
      expect(cold.non2xx).toBe(0);
      coldMs[backend.name] = round(cold.ms, 1);
    }
    const askedBefore = blockRequests(fixture);

    const ttfb = await interleaved(
      backends,
      { warmup: TTFB_WARMUP, rounds: TTFB_ROUNDS },
      async (backend) => (await fetchWhole(backend, site.small.path, site.small.size)).firstByteMs
    );
    const throughput = await interleaved(
      backends,
      { warmup: THROUGHPUT_WARMUP, rounds: THROUGHPUT_ROUNDS },
      async (backend) => {
        const { lastByteMs } = await fetchWhole(backend, site.large.path, site.large.size);
        return LARGE_BYTES / MIB / (lastByteMs / 1000);
      }
    );
    const fanoutRuns = await interleaved(
      backends,
      { warmup: FANOUT_WARMUP, rounds: FANOUT_ROUNDS },
      (backend) => fanOut(backend, site.assets)
    );

    // Cached: nothing of the measured runs came from the fixture.
    expect(blockRequests(fixture)).toBe(askedBefore);

    const gates = gateVerdicts({ firstByteMs: ttfb, throughputMibs: throughput });
    results = {
      enforced: costEnforced(),
      target: `${process.platform}-${process.arch}`,
      cpu: os.cpus()[0]?.model?.trim() || 'unknown CPU',
      cpus: os.cpus().length,
      node: process.versions.node,
      ttfb: {
        bytes: SMALL_BYTES,
        rounds: TTFB_ROUNDS,
        warmup: TTFB_WARMUP,
        addon: summarize(ttfb.addon, 3),
        ipfsd: summarize(ttfb.ipfsd, 3),
        ...gates.firstByte,
      },
      throughput: {
        bytes: LARGE_BYTES,
        rounds: THROUGHPUT_ROUNDS,
        warmup: THROUGHPUT_WARMUP,
        addon: summarize(throughput.addon, 1),
        ipfsd: summarize(throughput.ipfsd, 1),
        ...gates.throughput,
      },
      fanout: {
        assets: FANOUT_ASSETS,
        concurrency: FANOUT_CONCURRENCY,
        rounds: FANOUT_ROUNDS,
        addon: summarize(
          fanoutRuns.addon.map((run) => run.ms),
          1
        ),
        ipfsd: summarize(
          fanoutRuns.ipfsd.map((run) => run.ms),
          1
        ),
        coldMs,
        non2xx: {
          addon: fanoutRuns.addon.reduce((sum, run) => sum + run.non2xx, 0),
          ipfsd: fanoutRuns.ipfsd.reduce((sum, run) => sum + run.non2xx, 0),
        },
        gatewayBusy: {
          addon: fanoutRuns.addon.reduce((sum, run) => sum + run.gatewayBusy, 0),
          ipfsd: fanoutRuns.ipfsd.reduce((sum, run) => sum + run.gatewayBusy, 0),
        },
      },
    };

    const out = process.env.FREEDOM_IPFS_COST_OUT || path.join(os.tmpdir(), 'ipfs-cost.json');
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    const markdown = costTable(results);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    }
    console.log(`${markdown}\n${out}`);
    expect(results.fanout.non2xx).toEqual({ addon: 0, ipfsd: 0 });
  }, 600_000);

  // 0007's gates: a miss fails only where they are enforced
  // (FREEDOM_IPFS_COST_ENFORCE); the verdict is logged either way.
  test(`freedom-ipfsd's median first byte is at most ${GATES.firstByteMs} ms later than the add-on's`, () => {
    expect(results).toBeDefined();
    const { verdict } = gateOutcome(results.ttfb.pass, results.enforced);
    console.log(`first-byte gate: ${verdict} (${results.ttfb.deltaMs} ms)`);
    // The verdict, judged unrounded (gateVerdicts), not the report's figure.
    if (results.enforced) expect(results.ttfb).toMatchObject({ pass: true });
  });

  test(`freedom-ipfsd's median throughput is at least ${GATES.throughputRatio * 100} % of the add-on's`, () => {
    expect(results).toBeDefined();
    const { verdict } = gateOutcome(results.throughput.pass, results.enforced);
    console.log(`throughput gate: ${verdict} (${round(results.throughput.ratio * 100, 1)} %)`);
    if (results.enforced) expect(results.throughput).toMatchObject({ pass: true });
  });
});
