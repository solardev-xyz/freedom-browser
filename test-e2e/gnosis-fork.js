// The anvil fork of Gnosis behind the Safe E2E specs (safe-fixtures.js,
// safe-phone-fixtures.js), and the failover proxy anvil fetches through.
//
// Why this module (#536, #1101). A fork reads every account and storage
// slot it hasn't seen yet from its upstream, at the moment the app asks:
// the status card's first eth_getCode of a fresh Safe, the asset list's
// token calls, and the activation's eth_estimateGas, a chain of ~80 slot
// reads. The app gives each endpoint 5 s (quorum.timeoutMs), and both of its
// endpoints are this one anvil, so a read that takes longer leaves the card
// at "All chain sources failed for eth_… (quorum: … did not reach 2 matching
// responses; direct: All RPC endpoints failed)", with no retry. That is the
// failure CI hit on 2026-11-26 in three merge-queue runs, every attempt. Two
// things make a read that slow: an upstream reply that doesn't come (the
// failover proxy below), and a cold fork's long read chains holding up
// everything else (warmSharedState).
//
// anvil can't ride that out itself. Checked 2026-11-27 against anvil 1.8.3
// with a local upstream that never answers one request in five: with one
// --fork-url or three, and with --timeout 1500, the stalled read fails
// ("failed to get account for 0x…: … operation timed out") instead of being
// retried, so --retries and the multi-URL rotation don't cover a timeout.
//
// So anvil forks a local proxy instead, over the reachable public Gnosis
// RPCs, fastest first. A provider that errors (a JSON-RPC error counts: anvil
// only fetches raw chain state, which has no legitimate error reply) or
// hasn't answered within HEDGE_AFTER_MS has the read handed to the next one,
// the first good answer wins, and the provider sits at the back of the order
// for BENCH_MS, so a bad spell costs one hedge delay rather than one per read
// (the activation's gas estimate is one long chain of reads). The fork block
// is pinned a few blocks behind the head, so every provider has it.
//
// The proxy answers anvil's two extension methods itself, "method not found"
// as rpc.gnosischain.com does: anvil then reads accounts with the three
// standard calls. Forwarded, eth_getAccountInfo would be failed over until
// the one provider that has it answered, so its pauses would hold every
// account read.
//
// Each test writes anvil's own log and the proxy's (every failover, with
// the reason) to its output dir; the fixtures attach both on failure.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const { randomBytes } = require('crypto');
const path = require('path');
const { Interface, Wallet } = require('ethers');

const repoRoot = path.resolve(__dirname, '..');
const TOKENS = require(path.join(repoRoot, 'src', 'shared', 'tokens.json'));
const { buildDeploymentTransaction } = require(
  path.join(repoRoot, 'src', 'main', 'wallet', 'safe', 'safe-executor')
);
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)']);

// Three separate operators, so one having a bad spell leaves two (checked
// 2026-11-27): rpc.gnosischain.com (Tenderly) and gnosis.drpc.org serve
// state 20 000 blocks back; gnosis-rpc.publicnode.com prunes it after
// 100–300 blocks ("No state available for block …"), which still covers a
// test (a few minutes, ~60 blocks), and an error from it just moves the read
// on. rpc.gnosis.gateway.fm is left out: it runs on the same Tenderly backend
// as rpc.gnosischain.com (docs/ant-chain-bridge.md, and its x-tdly-* headers).
//
// FREEDOM_SAFE_E2E_FORK_UPSTREAMS (comma-separated URLs) replaces the list
// and fixes the order (no fastest-first sort), e.g. to put a fault-injecting
// proxy in front of the provider every read goes to first and replay the
// failover.
const FIXED_ORDER = Boolean(process.env.FREEDOM_SAFE_E2E_FORK_UPSTREAMS);
const GNOSIS_FORK_UPSTREAMS = process.env.FREEDOM_SAFE_E2E_FORK_UPSTREAMS
  ? process.env.FREEDOM_SAFE_E2E_FORK_UPSTREAMS.split(',')
      .map((url) => url.trim())
      .filter(Boolean)
  : ['https://rpc.gnosischain.com', 'https://gnosis.drpc.org', 'https://gnosis-rpc.publicnode.com'];

// Upstream replies measured 2026-11-27 take 70–800 ms at the 95th
// percentile (dRPC's free tier is the slow one); one that hasn't come after
// this long is likely stalled, and the next provider can still answer well
// inside the app's 5 s per endpoint.
const HEDGE_AFTER_MS = 1000;
// A read that took this long is logged with who answered it.
const SLOW_LOG_MS = 1500;
// How long a provider that stalled or errored goes to the back of the order.
const BENCH_MS = 30_000;
// Measured 2026-11-27: 1.9–9.3 s over 20 starts with one provider faulted.
const WARM_UP_BUDGET_MS = 12_000;
// How long a warm-up stopped at its budget gets to fail on the refused reads.
const WARM_UP_SETTLE_MS = 2000;
// What the proxy answers while refusing (a warm-up past its budget being
// stopped): an error anvil fails the read with at once, without retrying.
const REFUSED_REPLY = { status: 500, text: '' };
// anvil's own extension methods, answered "method not found" locally.
const LOCAL_ONLY_METHODS = new Set(['eth_getAccountInfo', 'anvil_nodeInfo']);
// A single attempt is dropped after this, so a request that every provider
// stalls on still gets an answer (an error) rather than hanging anvil.
const ATTEMPT_TIMEOUT_MS = 10_000;
// Blocks behind the head the fork starts at (≈25 s on Gnosis): providers
// behind a load balancer can lag the head by a block or two.
const FORK_BLOCK_OFFSET = 5;

const CHAIN_ID_BODY = '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}';

const reachableCache = new Map();

/**
 * curl's output for the eth_chainId probe: the body, then `\n` and
 * `%{time_total}` from -w. The time is what follows the *last* newline:
 * a body can end in a newline of its own (publicnode's does, measured
 * 2026-11-27: `{...}\n\n0.0667`) or span several lines. A time that doesn't
 * parse sorts last, never first. Null when the body isn't a JSON-RPC answer.
 *
 * @returns {{chainId: number, ms: number} | null}
 */
function parseChainIdProbe(stdout) {
  const cut = stdout.lastIndexOf('\n');
  if (cut < 0) return null;
  const seconds = Number(stdout.slice(cut + 1).trim());
  let result;
  try {
    ({ result } = JSON.parse(stdout.slice(0, cut)));
  } catch {
    return null; // not a JSON-RPC answer: unreachable for our purposes
  }
  return {
    chainId: parseInt(result, 16),
    ms: Number.isFinite(seconds) && stdout.slice(cut + 1).trim() ? seconds * 1000 : Infinity,
  };
}

/**
 * Upstreams that answer eth_chainId = 100, fastest first (synchronous probe,
 * once per process: a provider can stall for the whole 10 s curl limit, and
 * the fixture's set-up has 30 s).
 */
function reachableGnosisUpstreams(urls = GNOSIS_FORK_UPSTREAMS) {
  const key = urls.join(',');
  if (!reachableCache.has(key)) {
    const timed = [];
    for (const url of urls) {
      const probe = spawnSync(
        'curl',
        [
          '-sf',
          '-m',
          '10',
          '-w',
          '\\n%{time_total}',
          '-X',
          'POST',
          url,
          '-H',
          'Content-Type: application/json',
          '-d',
          CHAIN_ID_BODY,
        ],
        { encoding: 'utf-8' }
      );
      if (probe.status !== 0) continue;
      const reply = parseChainIdProbe(probe.stdout);
      if (reply?.chainId === 100) timed.push({ url, ms: reply.ms });
    }
    if (!FIXED_ORDER) timed.sort((a, b) => (a.ms === b.ms ? 0 : a.ms < b.ms ? -1 : 1));
    reachableCache.set(
      key,
      timed.map(({ url }) => url)
    );
  }
  return reachableCache.get(key);
}

/**
 * Why the fork can't run here, or null when it can: anvil on PATH and at
 * least one upstream reachable. Hedging needs more than one to help, but one
 * is enough to run (a skip on a partial outage would hide the spec).
 */
function gnosisForkUnavailableReason() {
  if (spawnSync('anvil', ['--version']).status !== 0) return 'anvil (foundry) is not on PATH';
  if (!reachableGnosisUpstreams().length) {
    return `none of the fork RPCs is reachable (${GNOSIS_FORK_UPSTREAMS.join(', ')})`;
  }
  return null;
}

/** A reply anvil can use: HTTP 200, JSON, and no JSON-RPC error in it. */
function usableReply(status, text) {
  if (status !== 200) return `HTTP ${status}`;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  const replies = Array.isArray(body) ? body : [body];
  const failed = replies.find((reply) => !reply || typeof reply !== 'object' || reply.error);
  if (failed) return `JSON-RPC error ${JSON.stringify(failed?.error ?? failed).slice(0, 160)}`;
  return null;
}

function describeRequest(body) {
  try {
    const parsed = JSON.parse(body);
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    return calls.map((call) => call.method).join(',');
  } catch {
    return '?';
  }
}

/** The "method not found" reply for a request only anvil's extensions have, else null. */
function localReply(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (!calls.length || !calls.every((call) => LOCAL_ONLY_METHODS.has(call?.method))) return null;
  const replies = calls.map((call) => ({
    jsonrpc: '2.0',
    id: call.id ?? null,
    error: { code: -32601, message: 'method not found' },
  }));
  return { status: 200, text: JSON.stringify(Array.isArray(parsed) ? replies : replies[0]) };
}

/**
 * Hedged JSON-RPC proxy on 127.0.0.1 (ephemeral port) over `upstreams`,
 * tried in the order given (fastest first) except for benched ones.
 *
 * @returns {Promise<{url: string, close: () => Promise<void>, refuse: () => () => void}>}
 */
function startForkUpstream(
  upstreams,
  {
    hedgeAfterMs = HEDGE_AFTER_MS,
    attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
    benchMs = BENCH_MS,
    log = () => {},
    fetchImpl = fetch,
    now = Date.now,
  } = {}
) {
  if (!upstreams.length) throw new Error('startForkUpstream: no upstream');
  const benchedUntil = new Map();
  const bench = (url) => benchedUntil.set(url, now() + benchMs);
  const isBenched = (url) => (benchedUntil.get(url) || 0) > now();
  const currentOrder = () => [
    ...upstreams.filter((url) => !isBenched(url)),
    ...upstreams.filter(isBenched).sort((a, b) => benchedUntil.get(a) - benchedUntil.get(b)),
  ];

  // refuse(): every pending and new read is answered REFUSED_REPLY at once,
  // until the function refuse() returned is called.
  let refusing = false;
  const pending = new Set();

  const forward = (body) =>
    new Promise((resolve) => {
      const local = localReply(body);
      if (local) {
        resolve(local);
        return;
      }
      if (refusing) {
        resolve(REFUSED_REPLY);
        return;
      }
      const order = currentOrder();
      const startedAt = now();
      const controllers = [];
      let launched = 0;
      let settled = 0;
      let done = false;
      let hedgeTimer = null;
      let lastFailure = null;

      const finish = (reply) => {
        if (done) return;
        done = true;
        pending.delete(finish);
        clearTimeout(hedgeTimer);
        controllers.forEach((controller) => controller.abort());
        resolve(reply);
      };
      pending.add(finish);
      const launch = () => {
        if (done || launched >= order.length) return;
        const url = order[launched++];
        const controller = new AbortController();
        controllers.push(controller);
        const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
        clearTimeout(hedgeTimer);
        hedgeTimer = setTimeout(() => {
          if (!done && launched < order.length) {
            log(`hedge ${describeRequest(body)}: ${url} silent for ${hedgeAfterMs}ms`);
            bench(url);
            launch();
          }
        }, hedgeAfterMs);
        fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })
          .then(async (res) => ({ status: res.status, text: await res.text() }))
          .then(
            ({ status, text }) => {
              const problem = usableReply(status, text);
              if (!problem) {
                const tookMs = now() - startedAt;
                if (tookMs >= SLOW_LOG_MS) {
                  log(`slow ${describeRequest(body)}: ${tookMs}ms, answered by ${url}`);
                }
                finish({ status, text });
                return;
              }
              lastFailure = { status, text };
              if (!done) {
                log(`failover ${describeRequest(body)}: ${url} gave ${problem}`);
                bench(url);
              }
            },
            (err) => {
              if (!done) {
                log(
                  `failover ${describeRequest(body)}: ${url} failed (${err.name}: ${err.message})`
                );
                bench(url);
              }
            }
          )
          .finally(() => {
            clearTimeout(timer);
            settled += 1;
            if (done) return;
            if (launched < order.length) launch();
            else if (settled === launched) {
              finish(lastFailure || { status: 502, text: '' });
            }
          });
      };
      launch();
    });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const { status, text } = await forward(Buffer.concat(chunks).toString('utf-8'));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
        refuse: () => {
          refusing = true;
          [...pending].forEach((finish) => finish(REFUSED_REPLY));
          return () => {
            refusing = false;
          };
        },
      })
    );
  });
}

function jsonRpc(url) {
  return async (method, params = []) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const { result, error } = await res.json();
    if (error) throw new Error(`${method}: ${error.message}`);
    return result;
  };
}

// Every anvil this process started and hasn't seen exit. A fixture set-up
// that times out (Playwright's 30 s) never reaches its teardown, and the
// worker then exits; an anvil left behind would keep the fixed port while
// its upstream proxy, which lived in the worker, is gone, so every retry's
// anvil would exit with "Address already in use". Checked 2026-11-27: a
// process exiting without stop() left anvil listening.
const liveForks = new Set();
process.once('exit', () => {
  for (const proc of liveForks) proc.kill('SIGKILL');
});

/** Resolve once `proc` has exited (SIGKILL if SIGTERM isn't enough). */
function stopProcess(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    proc.kill();
  });
}

/**
 * Start the fork on `port` through the failover proxy. Ready means it can
 * serve state, not just answer eth_chainId (which anvil answers locally): a
 * fresh account's balance has been read through the upstreams.
 *
 * `stop()` resolves once anvil has exited, so the next test's anvil can bind
 * the same fixed port; without that it could fail with "anvil exited with 1"
 * or the readiness probe could reach the previous one.
 *
 * @returns {Promise<{url: string, rpc: Function, stop: () => Promise<void>}>}
 */
async function startGnosisFork({ port, upstreams = reachableGnosisUpstreams(), logPath }) {
  if (!upstreams.length) throw new Error('no reachable Gnosis fork upstream');
  const logFd = fs.openSync(logPath, 'a');
  const log = (line) =>
    fs.writeSync(logFd, `${new Date().toISOString()} [fork-upstream] ${line}\n`);
  log(`upstreams: ${upstreams.join(', ')}`);
  const upstream = await startForkUpstream(upstreams, { log });

  const url = `http://127.0.0.1:${port}`;
  const rpc = jsonRpc(url);
  // --block-time (not automine): ethers' waitForTransaction — which the
  // app relies on for confirmations — only re-checks receipts when new
  // blocks arrive, exactly like on the real chain. Not --silent: anvil's log
  // (each request, and any upstream failure it reports) goes to the file.
  const proc = spawn(
    'anvil',
    [
      '--fork-url',
      upstream.url,
      // `=`: a bare "-5" would read as a flag.
      `--fork-block-number=-${FORK_BLOCK_OFFSET}`,
      '--port',
      String(port),
      '--block-time',
      '2',
    ],
    { stdio: ['ignore', logFd, logFd] }
  );
  liveForks.add(proc);
  proc.once('exit', () => liveForks.delete(proc));
  const stop = async () => {
    await stopProcess(proc);
    await upstream.close();
    fs.closeSync(logFd);
  };

  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
      try {
        const chainId = await rpc('eth_chainId');
        if (parseInt(chainId, 16) !== 100) throw new Error(`unexpected chain id ${chainId}`);
        await rpc('eth_getBalance', [`0x${randomBytes(20).toString('hex')}`, 'latest']);
        break;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(`anvil fork not ready: ${err.message}`, { cause: err });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } catch (err) {
    await stop();
    throw err;
  }
  await warmSharedState(rpc, upstream, log);
  return { url, rpc, stop };
}

/**
 * Pull into the fork the contract state every test reads before the app
 * asks for it: the wallet's Gnosis token contracts (the asset list's
 * balanceOf calls) and the Safe factory, singleton and their storage (the
 * activation's gas estimate). Cold, each is a chain of sequential upstream
 * reads, a few seconds in all — on a real node one round trip — and anvil
 * holds other requests while they run: measured 2026-11-27, an eth_getCode
 * sent while the token calls of a cold fork were running took ~4 s (~0.1 s
 * alone), enough with a slow upstream to pass the app's 5 s. Warmed, the
 * same getCode took ~0.1 s. Only shared contract state is warmed; every
 * account the test itself creates (the Safe, its owners) is still read cold.
 *
 * Best effort, within WARM_UP_BUDGET_MS (fixture set-up shares the test's
 * default 30 s with anvil's start and the app's launch): a failure or an
 * overrun is logged, and the test meets the rest of the state cold.
 *
 * An overrun stops the warm-up's reads too, not just the wait for them:
 * anvil 1.8.3 keeps executing a call whose client has disconnected
 * (measured 2026-11-27: aborting the warm-up's fetches left the same ~55
 * upstream reads coming as letting them run), and those chains are what
 * would hold the app's first reads up. So the proxy refuses every upstream
 * read until the warm-up's calls have failed on it (measured: ~10 ms), then
 * forwards again. Nothing else reads the fork yet, and a read refused this
 * way is not cached: the same calls asked again afterwards succeed.
 */
async function warmSharedState(
  rpc,
  upstream,
  log,
  { budgetMs = WARM_UP_BUDGET_MS, settleMs = WARM_UP_SETTLE_MS, warm = warmUp } = {}
) {
  const started = Date.now();
  const warming = warm(rpc).then(() => 'done');
  let budgetTimer;
  let settleTimer;
  try {
    const outcome = await Promise.race([
      warming,
      new Promise((resolve) => {
        budgetTimer = setTimeout(() => resolve('over'), budgetMs);
      }),
    ]);
    if (outcome === 'done') {
      log(`warmed the token contracts and the Safe deployment in ${Date.now() - started}ms`);
      return;
    }
    const resume = upstream.refuse();
    const settled = await Promise.race([
      warming.then(
        () => true,
        () => true
      ),
      new Promise((resolve) => {
        settleTimer = setTimeout(() => resolve(false), settleMs);
      }),
    ]);
    resume();
    log(
      `warm-up stopped at its ${budgetMs}ms budget, its upstream reads refused ` +
        `(${settled ? 'settled' : `still not settled after ${settleMs}ms`}); the rest reads cold`
    );
  } catch (err) {
    log(`warm-up failed after ${Date.now() - started}ms (${err.message}); the rest reads cold`);
  } finally {
    clearTimeout(budgetTimer);
    clearTimeout(settleTimer);
  }
}

async function warmUp(rpc) {
  const holder = () => Wallet.createRandom().address;
  const tokens = Object.values(TOKENS).filter((t) => t.chainId === 100 && t.address);
  const deployment = await buildDeploymentTransaction({
    owners: [holder(), holder()],
    threshold: 1,
    saltNonce: String(Date.now()),
    chainId: 100,
  });
  await Promise.all([
    ...tokens.map((token) =>
      rpc('eth_call', [
        { to: token.address, data: ERC20.encodeFunctionData('balanceOf', [holder()]) },
        'latest',
      ])
    ),
    rpc('eth_estimateGas', [
      { from: holder(), to: deployment.to, data: deployment.data, value: '0x0' },
    ]),
  ]);
}

/** Attach the fork's log (anvil + its upstream proxy) when a test failed. */
async function attachForkLogOnFailure(testInfo, logPath) {
  if (testInfo.status !== testInfo.expectedStatus && fs.existsSync(logPath)) {
    await testInfo.attach('anvil-fork.log', { path: logPath, contentType: 'text/plain' });
  }
}

module.exports = {
  GNOSIS_FORK_UPSTREAMS,
  attachForkLogOnFailure,
  localReply,
  gnosisForkUnavailableReason,
  parseChainIdProbe,
  reachableGnosisUpstreams,
  startForkUpstream,
  startGnosisFork,
  usableReply,
  warmSharedState,
};
