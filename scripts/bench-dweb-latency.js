// Design 0006's latency measurement (freedom-core
// docs/design/0006-dweb-transports.md, Latency): time to first byte and
// total time of `bzz:` and `ipfs:` requests through main's real handlers,
// planned (the core's `dweb.open`, design 0006 step 4) against today (the
// handlers before it), on one machine, with nothing on the network.
//
// What it doesn't measure: `ipns:` (no target here), the native IPFS node
// (the gateway stands in for IPFS), a cold name lookup (names come from the
// core's cache), a real node's retrieval time, and Chromium's own scheduling
// and rendering.
//
// Each tree's handlers are driven as the real-handler tests drive them (#689):
// registered on a stand-in session and called with real `Request`s. Below
// them everything is real but the nodes, which are local HTTP servers in a
// process of their own: a fake Ant API and a fake external IPFS gateway,
// serving 1 KB, 100 KB and 10 MiB bodies and Range. They answer in well under
// a millisecond, so the numbers are main's handlers and the core's planning,
// without a real node's own retrieval time. The core is a real freedom-cored
// with naming attached
// through the tree's own naming driver, its RPC answered from freedom-core's
// recorded `quorum-agree` lookup, so a named host's lookup is the core's
// cache after one warm-up request (as 0004's fan-out measurement was), and the
// core round trip is what's measured, not RPC.
//
// Cases: hash hosts and named hosts, on the Ant and the gateway, for each body
// and for a video seek (a 1 MiB Range in the middle of the 10 MiB body), at 50
// and 200 requests at once, and one at a time. Time to first byte runs from
// the handler call to the first body chunk read; total, to the body's end.
// Each row also gives main's CPU per request and the core calls each request
// made, and checks that no named lookup reached RPC while measured.
//
// Usage (not part of the jest gate):
//   node scripts/bench-dweb-latency.js --today <checkout> \
//     [--planned <checkout>] [--core <freedom-cored>] [--vectors <naming-replay.json>] \
//     [--runs 3] [--local] [--quick] [--json <file>]
// --today is a checkout of the handlers before design 0006 step 4 (e.g. a
// worktree of integration/rust-core at dca4a4ef) with node_modules; --planned
// defaults to this checkout. --core defaults to FREEDOM_CORED_PATH, a release
// build serving `dweb.open`. --vectors defaults to FREEDOM_NAMING_VECTORS, a
// freedom-core checkout's vectors/naming-replay.json. --local adds two
// columns, the planned handlers with requests that have no name:
// - `local`: planned in main instead (the fallback the design names), by the
//   JS planner the real-handler tests use;
// - `cached`: given a plan made once at warm-up, so main executes plans with
//   no planning at all, the floor any local planning could reach.
// planned − cached is the planning round trip; local − cached, local
// planning's own cost; cached − today, main's executor. The run log also
// gives the JS planner alone, one plan at a time on an idle loop.
// Each run starts one worker process per column, rotating which goes first;
// the table gives the median over runs of each percentile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const KIB = 1024;
const MIB = 1024 * KIB;
const BODIES = {
  '1kb': KIB,
  '100kb': 100 * KIB,
  '10mb': 10 * MIB,
};
// A seek: 1 MiB from the middle of the 10 MiB body.
const SEEK = { body: '10mb', range: [5 * MIB, 6 * MIB - 1] };
const CASES = ['1kb', '100kb', '10mb', 'seek'];
// The design's 50 and 200 at once, and one at a time: the planning round
// trip on its own, with nothing queued behind or in front of it.
const CONCURRENCY = [1, 50, 200];
// Rounds of `concurrency` requests per case: fewer for the 10 MiB bodies,
// more one at a time.
const ROUNDS = { '1kb': 10, '100kb': 10, '10mb': 3, seek: 10 };
const SEQUENTIAL_ROUNDS = { '1kb': 200, '100kb': 200, '10mb': 30, seek: 200 };
const HASH = 'ab'.repeat(32);
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
// The recorded lookup's name (its content is IPFS) and a name answered with
// a Swarm contenthash for HASH.
const IPFS_NAME = 'vitalik.eth';
const SWARM_NAME = 'swarmbench.eth';
const ENDPOINTS = ['https://a.rpc.example', 'https://b.rpc.example', 'https://c.rpc.example'];
const PROBE_PATH = '/ipfs/bafkqaaa';
const noop = () => {};

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

// --- the nodes ------------------------------------------------------------

const content = Buffer.alloc(10 * MIB);
for (let i = 0; i < content.length; i++) content[i] = (i * 7) % 251;
const bodyOf = (name) => content.subarray(0, BODIES[name]);

/** A local origin serving `/<kind>/<id>/<body>.bin` with Range, as a node's
 * HTTP API serves content; the gateway also answers the manager's probe. */
function startNode() {
  const server = http.createServer((req, res) => {
    if (req.url === PROBE_PATH) {
      res.writeHead(200, { 'X-Ipfs-Path': PROBE_PATH });
      res.end();
      return;
    }
    const match = /\/(1kb|100kb|10mb)\.bin(?:\?|$)/.exec(req.url);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const body = bodyOf(match[1]);
    const base = {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      ETag: `"${match[1]}"`,
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (!range) {
      res.writeHead(200, { ...base, 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const start = Number(range[1]);
    const end = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Content-Length': end - start + 1,
    });
    res.end(body.subarray(start, end + 1));
  });
  server.keepAliveTimeout = 60_000;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// --- naming's RPC, from the recording ---------------------------------------

function recordedAnswers(vectorsPath) {
  const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));
  const scenario = vectors.scenarios.find((s) => s.id === 'quorum-agree');
  if (!scenario) throw new Error(`no quorum-agree scenario in ${vectorsPath}`);
  const answers = new Map();
  for (const exchange of scenario.io) {
    if (exchange.method && exchange.answer?.body && !answers.has(exchange.method)) {
      answers.set(exchange.method, exchange.answer.body);
    }
  }
  return answers;
}

const word = (n) => n.toString(16).padStart(64, '0');
const padded = (hex) => hex + '0'.repeat((64 - (hex.length % 64)) % 64);

/** The Universal Resolver's answer for a Swarm contenthash of `reference`,
 * laid out as the recorded answer is (freedom-core tests/dweb.rs). */
function swarmAnswer(reference) {
  const contenthash = `e40101fa011b20${reference}`;
  const inner = `${word(32)}${word(contenthash.length / 2)}${padded(contenthash)}`;
  const resolver = '2'.repeat(40).padStart(64, '0');
  const data = `0x${word(64)}${resolver}${word(inner.length / 2)}${inner}`;
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result: data });
}

const SWARM_LABEL = Buffer.from('swarmbench').toString('hex');

// --- a worker: one tree's handlers ------------------------------------------

async function worker(opts) {
  const root = path.resolve(opts.root);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-dweb-bench-'));
  const stub = (file, exports) => {
    const module = new Module(file);
    module.filename = file;
    module.loaded = true;
    module.exports = exports;
    require.cache[file] = module;
  };
  // main's modules outside Electron: a scratch profile, a silent log.
  stub(require.resolve('electron', { paths: [root] }), {
    app: {
      isPackaged: false,
      getPath: () => userData,
      getName: () => 'Freedom',
      getVersion: () => '0.0.0',
      on: noop,
      whenReady: () => Promise.resolve(),
    },
    BrowserWindow: { getAllWindows: () => [] },
    webContents: { getAllWebContents: () => [] },
    ipcMain: { handle: noop, on: noop, removeHandler: noop },
  });
  const errors = [];
  stub(require.resolve(path.join(root, 'src/main/logger')), {
    info: noop,
    debug: noop,
    verbose: noop,
    warn: noop,
    error: (...line) => errors.push(line.join(' ')),
  });
  const load = (rel) => require(path.join(root, rel));

  // The nodes run in their own process, as Ant and a gateway do: main's
  // event loop carries the handlers alone.
  const nodes = spawn(process.execPath, [__filename, '--serve'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const { ant, gateway } = await new Promise((resolve, reject) => {
    let text = '';
    nodes.stdout.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) resolve(JSON.parse(text));
    });
    nodes.once('exit', (code) => reject(new Error(`the nodes exited ${code}`)));
  });

  // The seams the real-handler tests use: the Ant's URL and mode, the IPFS
  // profile (external gateway), a transport that dials only the gateway (the
  // manager's background Kubo probe would dial :5001), and the naming driver.
  const registry = load('src/main/service-registry');
  registry.getAntApiUrl = () => ant;
  const realGetService = registry.getService;
  registry.getService = (name) =>
    name === 'ant' ? { mode: registry.MODE.BUNDLED } : realGetService(name);
  const profiles = load('src/main/profile-resolver');
  profiles.getActiveProfile = () => ({
    metadata: { nodes: { ipfs: { mode: 'external', externalGateway: gateway } } },
  });
  const transport = load('src/main/ipfs/gateway-transport');
  const realGatewayFetch = transport.gatewayFetch;
  transport.gatewayFetch = async (url, init) => {
    if (!String(url).startsWith(`${gateway}/`)) throw new TypeError('fetch failed');
    return realGatewayFetch(url, init);
  };

  // The core, naming attached as the tree attaches it.
  const { CoreClient } = load('src/main/core/core-client');
  const { NamingConfig } = load('src/main/core/naming-config');
  const { registerNamingShell } = load('src/main/core/naming-shell');
  const { registerNamingVerified } = load('src/main/core/naming-verified');
  const { NamingDriver } = load('src/main/core/naming-driver');
  const { NOOP_HANDLE } = load('src/main/ens-prefetch');
  const answers = recordedAnswers(opts.vectors);
  const lookups = { rpc: 0 };
  const hop = async (_url, init) => {
    lookups.rpc += 1;
    const body = JSON.parse(init.body);
    let text = answers.get(body.method);
    if (body.method === 'eth_call' && JSON.stringify(body.params).includes(SWARM_LABEL)) {
      text = swarmAnswer(HASH);
    }
    if (!text) return { status: 500, headers: {}, body: Buffer.from('{"error":"no answer"}') };
    return { status: 200, headers: {}, body: Buffer.from(text) };
  };
  const client = new CoreClient({
    spawn,
    command: opts.core,
    args: [
      'serve',
      '--data-dir',
      path.join(userData, 'identity'),
      '--lock-dir',
      path.join(userData, 'locks'),
      '--parent-pid',
      String(process.pid),
    ],
    log: { info: noop, warn: noop, error: noop },
    shellVersion: 'dweb-bench',
  });
  const config = new NamingConfig({
    client,
    sources: {
      ens: {
        getEffectiveRpcEndpoints: () => ENDPOINTS,
        getDirectRpcCandidate: () => ({ url: null }),
        resolutionPolicy: () => ({ order: ['quorum'] }),
      },
      tezos: { getRpcEndpoints: () => [] },
      registry: { getNetwork: () => ({ quorum: { k: 3, m: 2 } }), getEndpoints: () => [] },
      myotis: { isEnabled: () => false, isReady: () => false },
    },
    log: { info: noop, warn: noop, error: noop },
  });
  // The core requests main makes, by method: a hash host today makes none.
  const coreCalls = new Map();
  const requestTo = client.requestTo.bind(client);
  client.requestTo = (gen, method, ...rest) => {
    coreCalls.set(method, (coreCalls.get(method) || 0) + 1);
    return requestTo(gen, method, ...rest);
  };
  registerNamingShell(client, config, { hop, prefetch: () => NOOP_HANDLE });
  registerNamingVerified(client, config, { adapters: {} });
  const driver = new NamingDriver({ client, config });
  let attached = driver;
  // Requests with no name, by URL, as the handlers asked for their plans.
  const unnamed = new Map();
  let planner = null;
  if (opts.plan === 'local' || opts.plan === 'cached') {
    // `local`: what design 0006 falls back to if hash hosts regress. Main
    // plans a request with no name itself, with the JS planner the
    // real-handler tests use (`planDweb`, held to fc-dweb's `requests`
    // vectors), called directly: the tests' driver keeps every request it
    // sees, which a benchmark mustn't. `cached`: each such request's plan
    // made once, at warm-up, and handed back as is, so the column is main's
    // executor with no planning at all, the floor any local planning could
    // reach. A name still goes to the core's `dweb.open` in both.
    const { planDweb } = load('test/helpers/fake-dweb-core');
    const { isDwebNameHost } = load('src/shared/origin-utils');
    planner = planDweb;
    const plans = new Map();
    const reply = async (params) => ({
      plan: await planDweb(params),
      generations: { ens: 0, tezos: 0, lifecycle: 0 },
      attempts: 0,
    });
    attached = Object.create(driver);
    attached.open = async (params, { signal = null, ready = null } = {}) => {
      if (isDwebNameHost(new URL(params.url).hostname)) {
        return driver.open(params, { signal, ready });
      }
      if (!unnamed.has(params.url)) unnamed.set(params.url, params);
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
      let answer;
      if (opts.plan === 'cached') {
        const key = JSON.stringify(params);
        if (!plans.has(key)) plans.set(key, Object.freeze(await reply(params)));
        answer = plans.get(key);
      } else {
        answer = await reply(params);
      }
      if (ready) await ready(answer);
      return answer;
    };
  }
  load('src/main/core/naming').namingDriver = () => attached;
  await client.start();
  if (!(await config.whenReady())) throw new Error('naming is not ready');

  // The handlers, registered on a stand-in session.
  const manager = load('src/main/ipfs-manager');
  const { registerBzzProtocol } = load('src/main/swarm/bzz-protocol');
  const { registerIpfsProtocol } = load('src/main/ipfs/ipfs-protocol');
  const handlers = new Map();
  const session = { protocol: { handle: (scheme, fn) => handlers.set(scheme, fn) } };
  registerBzzProtocol(session);
  registerIpfsProtocol(session);
  await manager.startIpfs();

  const targets = {
    'ant/hash': (file) => ['bzz', `bzz://${HASH}/${file}`],
    'ant/name': (file) => ['bzz', `bzz://${SWARM_NAME}/${file}`],
    'gateway/hash': (file) => ['ipfs', `ipfs://${CID}/${file}`],
    'gateway/name': (file) => ['ipfs', `ipfs://${IPFS_NAME}/${file}`],
  };

  /** One request: its time to first byte, total time and bytes. */
  async function one(target, kase) {
    const body = kase === 'seek' ? SEEK.body : kase;
    const [scheme, url] = targets[target](`${body}.bin`);
    const headers = { Accept: '*/*' };
    let expected = BODIES[body];
    if (kase === 'seek') {
      headers.Range = `bytes=${SEEK.range[0]}-${SEEK.range[1]}`;
      expected = SEEK.range[1] - SEEK.range[0] + 1;
    }
    const started = performance.now();
    const res = await handlers.get(scheme)(new Request(url, { headers }));
    const reader = res.body.getReader();
    let first = null;
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (first === null) first = performance.now();
      if (done) break;
      bytes += value.length;
    }
    const ended = performance.now();
    const ok = (res.status === 200 || res.status === 206) && bytes === expected;
    return { ttfb: first - started, total: ended - started, ok, status: res.status, bytes };
  }

  const percentile = (sorted, p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const summary = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  };

  const loadBefore = os.loadavg();
  const results = [];
  // Warm the JIT, the connections and the names.
  for (const target of Object.keys(targets)) {
    for (const kase of CASES) await one(target, kase);
  }
  // The JS planner on its own, one plan at a time on an idle event loop: the
  // planning work a local plan would add to each request.
  let plannerUs = null;
  if (planner) {
    const perPlan = [];
    for (const params of unnamed.values()) {
      const repeats = 2000;
      const started = performance.now();
      for (let i = 0; i < repeats; i++) await planner(params);
      perPlan.push(((performance.now() - started) * 1000) / repeats);
    }
    plannerUs = summary(perPlan);
  }
  for (const target of Object.keys(targets)) {
    for (const kase of CASES) {
      for (const concurrency of opts.quick ? [50] : CONCURRENCY) {
        // A named host's lookup: from the core's cache, warmed just before.
        await one(target, kase);
        const rpcBefore = lookups.rpc;
        coreCalls.clear();
        const cpu = process.cpuUsage();
        const samples = [];
        const rounds = opts.quick ? 2 : concurrency === 1 ? SEQUENTIAL_ROUNDS[kase] : ROUNDS[kase];
        for (let round = 0; round < rounds; round++) {
          samples.push(
            ...(await Promise.all(Array.from({ length: concurrency }, () => one(target, kase))))
          );
        }
        const used = process.cpuUsage(cpu);
        const failed = samples.filter((s) => !s.ok);
        results.push({
          target,
          case: kase,
          concurrency,
          samples: samples.length,
          failed: failed.length,
          failedStatuses: [...new Set(failed.map((s) => s.status))],
          lookups: lookups.rpc - rpcBefore,
          // Per request: main's CPU (the handlers, the core client), in ms.
          cpu: (used.user + used.system) / 1000 / samples.length,
          coreCalls: Object.fromEntries(
            [...coreCalls].map(([method, n]) => [method, n / samples.length])
          ),
          ttfb: summary(samples.map((s) => s.ttfb)),
          total: summary(samples.map((s) => s.total)),
        });
      }
    }
  }
  const out = {
    root,
    commit: spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim(),
    core: client.hello?.core_version,
    cpus: os.cpus().length,
    load: { before: loadBefore, after: os.loadavg() },
    errors: errors.slice(0, 5),
    plannerUs,
    results,
  };
  await manager.stopIpfs?.().catch(noop);
  await client.stop();
  nodes.kill();
  fs.rmSync(userData, { recursive: true, force: true });
  return out;
}

// --- the orchestrator -----------------------------------------------------

function runWorker(tree, root, opts, extra = []) {
  const out = path.join(os.tmpdir(), `dweb-bench-${process.pid}-${tree}-${Date.now()}.json`);
  const childArgs = [
    __filename,
    '--worker',
    '--root',
    root,
    '--core',
    opts.core,
    '--vectors',
    opts.vectors,
    '--out',
    out,
  ];
  if (opts.quick) childArgs.push('--quick');
  childArgs.push(...extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`${tree} worker exited ${code}`));
      const result = JSON.parse(fs.readFileSync(out, 'utf8'));
      fs.rmSync(out, { force: true });
      resolve({ tree, ...result });
    });
  });
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ms = (v) => (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0));

function table(runs, trees) {
  const key = (r) => `${r.target} ${r.case} ${r.concurrency}`;
  const byTree = Object.fromEntries(trees.map((tree) => [tree, new Map()]));
  for (const run of runs) {
    for (const r of run.results) {
      const map = byTree[run.tree];
      if (!map.has(key(r))) map.set(key(r), []);
      map.get(key(r)).push(r);
    }
  }
  const rows = [];
  rows.push(
    `| host | body | conc | TTFB p50 | TTFB p95 | TTFB p99 | total p50 | total p99 | main CPU per request | core calls per request | lookups |`
  );
  rows.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const k of byTree[trees[0]].keys()) {
    const [target, kase, concurrency] = k.split(' ');
    const of = trees.map((tree) => byTree[tree].get(k) || []);
    const cell = (metric, p) =>
      of
        .map((results) => (results.length ? ms(median(results.map((r) => r[metric][p]))) : '–'))
        .join(' → ');
    const all = of.flat();
    const lookups = all.reduce((n, r) => n + r.lookups, 0);
    const failed = all.reduce((n, r) => n + r.failed, 0);
    const calls = (results) =>
      Object.entries(results[0]?.coreCalls || {})
        .map(([method, n]) => `${n.toFixed(2).replace(/\.00$/, '')} ${method}`)
        .join(', ') || 'none';
    rows.push(
      `| ${target} | ${kase} | ${concurrency} | ${cell('ttfb', 'p50')} | ${cell('ttfb', 'p95')} | ` +
        `${cell('ttfb', 'p99')} | ${cell('total', 'p50')} | ${cell('total', 'p99')} | ` +
        `${of.map((results) => (results.length ? ms(median(results.map((r) => r.cpu))) : '–')).join(' → ')} | ` +
        `${of.map(calls).join(' → ')} | ${lookups}${failed ? `, ${failed} failed` : ''} |`
    );
  }
  return rows.join('\n');
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (opts.serve) {
    const [ant, gateway] = await Promise.all([startNode(), startNode()]);
    process.stdout.write(`${JSON.stringify({ ant: ant.origin, gateway: gateway.origin })}\n`);
    return;
  }
  if (opts.worker) {
    const result = await worker(opts);
    fs.writeFileSync(opts.out, JSON.stringify(result));
    return;
  }
  opts.core = opts.core || process.env.FREEDOM_CORED_PATH;
  opts.vectors = opts.vectors || process.env.FREEDOM_NAMING_VECTORS;
  const planned = path.resolve(opts.planned || path.join(__dirname, '..'));
  if (!opts.today || !opts.core || !opts.vectors) {
    console.error(
      'usage: node scripts/bench-dweb-latency.js --today <checkout> [--planned <checkout>] ' +
        '--core <freedom-cored> --vectors <naming-replay.json> [--runs 3] [--quick] [--json <file>]'
    );
    process.exitCode = 2;
    return;
  }
  const today = path.resolve(opts.today);
  const runs = Number(opts.runs || 3);
  // --local: the planned handlers with requests that have no name planned
  // in main (`local`), and with their plans made once (`cached`).
  const trees = opts.local ? ['today', 'planned', 'local', 'cached'] : ['today', 'planned'];
  const workers = {
    today: () => runWorker('today', today, opts),
    planned: () => runWorker('planned', planned, opts),
    local: () => runWorker('local', planned, opts, ['--plan', 'local']),
    cached: () => runWorker('cached', planned, opts, ['--plan', 'cached']),
  };
  const all = [];
  for (let run = 0; run < runs; run++) {
    // Each run starts with the next tree, so none always goes first.
    const order = trees.map((_, i) => trees[(i + run) % trees.length]);
    for (const tree of order) {
      const started = Date.now();
      const result = await workers[tree]();
      all.push({ run: run + 1, ...result });
      console.error(
        `run ${run + 1} ${tree} (${result.commit}, core ${result.core}): ` +
          `${((Date.now() - started) / 1000).toFixed(0)} s, load ${result.load.before
            .map((l) => l.toFixed(1))
            .join('/')} → ${result.load.after.map((l) => l.toFixed(1)).join('/')} ` +
          `on ${result.cpus} CPUs` +
          (result.plannerUs
            ? `; the JS planner alone: ${result.plannerUs.p50.toFixed(1)} µs a plan at p50, ` +
              `${result.plannerUs.p99.toFixed(1)} µs at p99 (per request kind)`
            : '') +
          (result.errors.length ? `; errors: ${result.errors.join('; ')}` : '')
      );
    }
  }
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(all, null, 2));
  console.log(
    `Time to first byte and total, ms: median over ${runs} runs of each percentile, ` +
      `${trees.join(' → ')}. lookups: RPC requests the core made while measuring (0: every ` +
      "named lookup was the core's cache)."
  );
  console.log(table(all, trees));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
