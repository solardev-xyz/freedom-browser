/**
 * Successful Colibri reads replayed on both backends (freedom-core design
 * 0014, COL-5), from freedom-core's recordings: `vectors/colibri.json`'s
 * cases, each fetch's answer from `vectors/fixtures/colibri/bodies/<sha256>.bin`
 * by the trace's `reply.sha256` (a flipped or scripted answer from its
 * `derived`), its content type from `fixtures/colibri/sessions.json`. Nothing
 * leaves the machine: a fetch the case didn't record fails as a transport
 * error, and is reported.
 *
 * - **wasm:** the real package in a child process per case
 *   (test/helpers/colibri-replay-wasm.js), `Date.now` at each request's
 *   recorded instant: the clock the generator fixed, which the WASM
 *   verifier reads too.
 * - **service:** colibri-service.js on the real freedom-colibrid
 *   (test/helpers/colibri-backends.js), its fetches through main's executor
 *   on a scripted hop, main's clock (`now`, which sets each request's
 *   freshness bound) at the request's instant. A released binary's C core
 *   reads the system clock, which nothing outside it can fix: that clock is
 *   read only by the transaction cache (its age and its pending list), so a
 *   case whose fetches depend on that age (`cCoreClock`) needs a binary built
 *   with the `testhooks` feature (FREEDOM_COLIBRID_TESTHOOKS_PATH), whose
 *   `test_clock_ms` fixes the C core's clock, as freedom-core's own replay
 *   (`services/freedom-colibrid/tests/service_vectors.rs`) does. `testClock`
 *   adds it to each `colibri.request` main sends.
 *
 * A warm case starts from the store its source case (`store.from`) left on
 * the same backend, so each backend's runs are kept (`wasmReplay`,
 * `serviceReplay`) until `cleanup()`. Each run starts its own process, as
 * the verifier keeps state between requests (the transaction cache).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { keyOf } = require('./colibri-replay-wasm');

const ROOT = path.join(__dirname, '..', '..');
const ENS = path.join(ROOT, 'src', 'main', 'ens');
const CHILD = path.join(__dirname, 'colibri-replay-wasm.js');

/**
 * The cases replayed on each chain (`<chain>-<name>`): every method the
 * service serves at least once, each block form it serves, each cold start,
 * a warm one, the transaction cache cold and incremental, and the ZK
 * fallback.
 */
const PER_CHAIN = Object.freeze([
  // eth_blockNumber: a ZK client's cold start (a checkpoint root), a ZK-off
  // client's (the finality checkpoint and a bootstrap), and a warm read.
  'zk-cold',
  'std-cold',
  'block-number-warm',
  'balance',
  'nonce',
  'storage',
  'code',
  'std-balance',
  // eth_getBlockByNumber at latest with its transactions (the largest
  // answer), at a number and at a hash; eth_getBlockByHash.
  'block-latest-full',
  'block-number',
  'block-hash',
  'block-by-hash',
  'priority-fee',
  // The transaction cache cold, then incremental at a later request.
  'tx',
  'receipt',
  'tx-incremental',
  // A ZK proof the prover can't make yet, then the same client without ZK.
  'zk-fallback',
]);

/**
 * Successes the reference recorded that the service refuses by design, one
 * per deviation: each is marked with it (design 0014, Deviations).
 */
const DEVIATING = Object.freeze([
  '1-gas-price',
  '1-balance-pending',
  '1-call-scripted-code',
  '1-unbound-balance-safe',
  '1-unbound-block-finalized',
]);

const REPLAYED = Object.freeze([
  ...[1, 100].flatMap((chain) => PER_CHAIN.map((name) => `${chain}-${name}`)),
  // A private session's cold start: a store in memory only.
  '1-private-cold',
  ...DEVIATING,
]);

/**
 * The cases whose fetches depend on the C core's clock: a later request
 * finds the transaction cache old enough to refresh only at its recorded
 * instant.
 */
const C_CORE_CLOCK = new Set(['1-tx-incremental', '100-tx-incremental']);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The recorded cases replayed, each with what a replay needs. */
function replayCases(vectors) {
  const byId = new Map(vectors.cases.map((entry) => [entry.id, entry]));
  return REPLAYED.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`the Colibri vectors have no case ${id}`);
    return {
      id,
      chain: entry.chain,
      zk: entry.zk,
      private: entry.private === true,
      session: entry.session,
      deviation: entry.deviation ?? null,
      source: entry.store?.from ?? null,
      seed: entry.store?.entries ?? null,
      prover: vectors.servers[entry.chain].prover[0],
      requests: entry.requests.map(({ method, params, clock }) => ({ method, params, clock })),
      outcomes: entry.outcomes,
      design: entry.design?.outcomes ?? null,
      fetches: entry.trace.filter((step) => step.op === 'fetch'),
      storeAfter: entry.store_after ?? null,
      cCoreClock: C_CORE_CLOCK.has(id),
    };
  });
}

/** An answer's bytes from the fixtures, checked against its record. */
function answerBytes(reply, bodies) {
  let bytes;
  if (reply.derived?.scripted) {
    bytes = Buffer.from(reply.derived.body, 'utf8');
  } else if (reply.derived?.flip !== undefined) {
    bytes = fs.readFileSync(path.join(bodies, `${reply.derived.of}.bin`));
    bytes[reply.derived.flip] ^= 1;
  } else {
    bytes = fs.readFileSync(path.join(bodies, `${reply.sha256}.bin`));
  }
  if (bytes.length !== reply.bytes || sha256(bytes) !== reply.sha256) {
    throw new Error(`the fixture for ${reply.sha256} isn't the recorded answer`);
  }
  return bytes;
}

/**
 * A case's world: every fetch it recorded, by `keyOf`, with its answer
 * (`{ key, status, headers, bytes }` or `{ key, transport }`).
 */
function worldOf(entry, fixturesDir) {
  const sessions = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'sessions.json'), 'utf8'));
  const types = new Map(
    (sessions.sessions[entry.session]?.exchanges ?? []).map((exchange) => [
      keyOf(exchange),
      exchange.response.content_type,
    ])
  );
  const bodies = path.join(fixturesDir, 'bodies');
  const world = new Map();
  for (const step of entry.fetches) {
    const key = keyOf({ url: step.url, method: step.method, body: step.body ?? null });
    const answer = step.reply.transport
      ? { key, transport: step.reply.transport }
      : {
          key,
          status: step.reply.status,
          headers: types.get(key) ? { 'content-type': types.get(key) } : {},
          bytes: answerBytes(step.reply, bodies),
          sha256: step.reply.sha256,
        };
    const known = world.get(key);
    if (known && (known.sha256 !== answer.sha256 || known.transport !== answer.transport)) {
      throw new Error(`${entry.id}: one request recorded with two answers`);
    }
    world.set(key, answer);
  }
  return world;
}

/** A fetch as the comparisons take it: its key and its headers, names in
 * lower case. */
const fetchOf = (request) =>
  JSON.stringify([keyOf(request), Object.fromEntries(new Headers(request.headers ?? {}))]);

/** The fetches a case recorded, with their headers, sorted. */
const recordedFetches = (entry) =>
  entry.fetches
    .map((step) =>
      fetchOf({
        url: step.url,
        method: step.method,
        headers: step.headers,
        body: step.body ?? null,
      })
    )
    .sort();

/** The fetches a replay made, with their headers, sorted. */
const madeFetches = (fetched) => fetched.map(fetchOf).sort();

/** A directory's files: name → `{ bytes, sha256 }`, as the vectors record a store. */
function storeOf(dir) {
  if (!fs.existsSync(dir)) return {};
  const store = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const bytes = fs.readFileSync(path.join(dir, name));
    store[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  return store;
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * A result as the vectors record it: inline (`result`), by its JSON text's
 * length in UTF-16 units and SHA-256 past 4 KiB (`result_json`), or
 * `result_undefined`.
 */
function asRecorded(value, recorded) {
  if (recorded.result_undefined) return { result_undefined: value === undefined };
  if (recorded.result_json) {
    const text = JSON.stringify(value);
    return { result_json: { chars: text.length, sha256: sha256(text) } };
  }
  return { result: value };
}

const temporary = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
}

/** Removes every directory the runs made. */
function cleanup() {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  runs.clear();
}

// Each backend's runs, by `<backend>:<case>`: a warm case's source runs once.
const runs = new Map();

function memo(key, run) {
  if (!runs.has(key)) runs.set(key, run());
  return runs.get(key);
}

/** An adapter outcome as the worker posts it. */
function postedOutcome(message) {
  if (!message) return null;
  if (message.ok) return { ok: true, result: message.result };
  const { name, code, message: text, data } = message.error;
  return { ok: false, error: { name, code, message: text, data } };
}

/**
 * Case `entry` on the WASM backend: `{ outcomes, fetched, unscripted,
 * storageDir, store }`. `cases` holds its source.
 */
function wasmReplay(entry, cases, fixturesDir) {
  return memo(`wasm:${entry.id}`, async () => {
    const storageDir = entry.private ? null : tempDir('freedom-colibri-replay-wasm-');
    if (entry.source) {
      const source = await wasmReplay(cases.get(entry.source), cases, fixturesDir);
      copyDir(source.storageDir, storageDir);
    }
    const world = [...worldOf(entry, fixturesDir).values()].map(
      ({ bytes, sha256: _sha, ...answer }) =>
        bytes ? { ...answer, base64: bytes.toString('base64') } : answer
    );
    const plan = path.join(tempDir('freedom-colibri-replay-plan-'), 'plan.json');
    fs.writeFileSync(
      plan,
      JSON.stringify({
        ens: ENS,
        chain: entry.chain,
        zk: entry.zk,
        prover: entry.prover,
        storageDir,
        requests: entry.requests,
        world,
      })
    );
    const { stdout } = await promisify(execFile)(process.execPath, [CHILD, plan], {
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const line = stdout.split('\n').find((text) => text.startsWith('{"replay"'));
    const parsed = JSON.parse(line);
    if (parsed.error) throw new Error(`the WASM replay of ${entry.id} failed: ${parsed.error}`);
    const results = parsed.posted.filter((message) => message.type === 'result');
    return {
      outcomes: entry.requests.map((_, index) =>
        postedOutcome(results.find((message) => message.id === index + 1))
      ),
      fetched: parsed.fetched,
      unscripted: parsed.unscripted,
      storageDir,
      store: storageDir ? storeOf(storageDir) : null,
    };
  });
}

/**
 * `test_clock_ms` on every `colibri.request` main sends while it is in
 * place, at `clock()`: for a binary with the `testhooks` feature, which a
 * released one refuses (`deny_unknown_fields`). Returns its undo.
 */
function testClock(clock) {
  const { ColibridClient } = require(path.join(ENS, 'colibrid-client.js'));
  const proto = ColibridClient.prototype;
  const own = Object.prototype.hasOwnProperty.call(proto, 'send');
  const send = proto.send;
  proto.send = function sendWithClock(gen, method, params, ...rest) {
    const sent = method === 'colibri.request' ? { ...params, test_clock_ms: clock() } : params;
    return send.call(this, gen, method, sent, ...rest);
  };
  return () => {
    if (own) proto.send = send;
    else delete proto.send;
  };
}

/**
 * Case `entry` on the service backend with `binary` (`{ label, command,
 * serviceVersion, testClock }`): `{ outcomes, fetched, unscripted,
 * chainDir, store, written }`, `written` every file under
 * `<userData>/colibri` once its processes have exited.
 */
function serviceReplay(entry, cases, fixturesDir, binary) {
  return memo(`${binary.label}:${entry.id}`, async () => {
    const { backendOf, outcomeOf, startBackend } = require('./colibri-backends');
    const { makeHop } = require(path.join(ROOT, 'src', 'main', 'core', 'naming-shell.js'));
    const userData = tempDir('freedom-colibri-replay-service-');
    const chainDir = path.join(userData, 'colibri', String(entry.chain));
    if (entry.source) {
      const source = await serviceReplay(cases.get(entry.source), cases, fixturesDir, binary);
      copyDir(source.chainDir, chainDir);
    }
    const world = worldOf(entry, fixturesDir);
    const fetched = [];
    const unscripted = [];
    const fetch = async (url, init = {}) => {
      const request = {
        url: String(url),
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers ?? {})),
        body: init.body === undefined || init.body === null ? null : String(init.body),
      };
      fetched.push(request);
      const answer = world.get(keyOf(request));
      if (!answer) {
        unscripted.push(request);
        throw new TypeError('fetch failed');
      }
      if (answer.transport) throw new TypeError(answer.transport);
      return new Response(answer.bytes, { status: answer.status, headers: answer.headers });
    };
    let clock = entry.requests[0].clock;
    const undo = binary.testClock ? testClock(() => clock) : null;
    const outcomes = [];
    try {
      const started = await startBackend(backendOf('service'), {
        userData,
        hop: makeHop({ fetch }),
        now: () => clock,
        command: binary.command,
        serviceVersion: binary.serviceVersion,
      });
      try {
        const client = started.host.createClient({
          chainId: entry.chain,
          proverUrl: entry.prover,
          zkProof: entry.zk,
          ...(entry.private ? { private: true } : {}),
        });
        for (const request of entry.requests) {
          clock = request.clock;
          outcomes.push(
            await client.request({ method: request.method, params: request.params }).then(
              (result) => ({ ok: true, result }),
              (err) => ({ ok: false, error: outcomeOf(err) })
            )
          );
        }
        client.destroy();
      } finally {
        await started.close();
      }
    } finally {
      undo?.();
    }
    return {
      outcomes,
      fetched,
      unscripted,
      chainDir,
      store: entry.private ? null : storeOf(chainDir),
      written: filesUnder(path.join(userData, 'colibri')),
    };
  });
}

module.exports = {
  C_CORE_CLOCK,
  DEVIATING,
  PER_CHAIN,
  REPLAYED,
  asRecorded,
  cleanup,
  madeFetches,
  recordedFetches,
  replayCases,
  serviceReplay,
  storeOf,
  wasmReplay,
  worldOf,
};
