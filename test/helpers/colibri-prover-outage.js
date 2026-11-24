/**
 * A Colibri read while its prover fails (#1059, F-9), on either backend
 * (freedom-core design 0014, A failed remote proof; COL-5). Nothing leaves
 * the machine: every request is answered here, by `failure`, an HTTP error
 * (`{ status, body }`) or a transport failure (`{ transport }`, the error
 * Node's `fetch` throws).
 *
 * - **wasm:** the real package, through colibri-runtime and colibri-worker.js's
 *   own service (its client config, its disk store, its error serializer),
 *   in a child process whose `fetch` is scripted. A child because Jest
 *   cannot load the WASM runtime, and because a worker thread can't have
 *   its `fetch` scripted. The outcome is what the worker posts, revived as
 *   the host revives it; `raw` is the client's error message before the
 *   worker's 2,000-unit cut.
 * - **service:** colibri-service.js on the real freedom-colibrid binary
 *   (`test/helpers/colibri-backends.js`), its fetches through main's
 *   executor on a scripted hop.
 *
 * `store` seeds the chain's store (key → hex), as a session's earlier
 * requests left it: the WASM worker's flat directory, the service's chain
 * directory. Each run starts its own process with its own store.
 *
 * `proverOutage(kind, options)` resolves to `{ error, raw, fetched }`: the
 * error the host's caller gets (`null` if the read was answered), and every
 * request made (`{ url, method, body }`). `proverOutageError()` is the WASM
 * one's error, synchronously, as chain.integration.test.js takes it.
 * `f9Cases(vectors)` lists the vectors' outage cases with what each
 * backend's outcome must be.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const ENS = path.join(__dirname, '..', '..', 'src', 'main', 'ens');
const NAMING_SHELL = path.join(__dirname, '..', '..', 'src', 'main', 'core', 'naming-shell.js');

const PROVER = 'https://prover.invalid';
const ACCOUNT = '0x00000000000000000000000000000000000000aa';
const HTTP_503 = Object.freeze({ status: 503, body: 'prover down' });
const TRANSPORT = Object.freeze({ transport: 'fetch failed' });

function readOptions({
  chain = 1,
  zk = true,
  prover = PROVER,
  method = 'eth_getBalance',
  params = [ACCOUNT, 'latest'],
  failure = HTTP_503,
  store = {},
} = {}) {
  return { chain, zk, prover, method, params, failure, store };
}

/** The child's source: each read in `reads` on a fresh worker service and
 * store, one JSON line of outcomes on stdout. */
function wasmSource(reads) {
  return `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const runtime = require(${JSON.stringify(path.join(ENS, 'colibri-runtime.js'))});
    const { createColibriService } = require(${JSON.stringify(path.join(ENS, 'colibri-worker.js'))});
    // The client's own error, before the worker's serializer cuts it. The
    // package protects its prototype, so the worker gets a subclass.
    let raw = null;
    class RecordingColibri extends runtime.Colibri {
      async request(args) {
        try {
          return await super.request(args);
        } catch (err) {
          raw = String(err && err.message);
          throw err;
        }
      }
    }
    const recording = { ...runtime, Colibri: RecordingColibri };
    let current = null;
    globalThis.fetch = async (url, init = {}) => {
      current.fetched.push({ url: String(url), method: init.method, body: init.body ?? null });
      if (current.failure.transport) throw new TypeError(current.failure.transport);
      return new Response(current.failure.body, { status: current.failure.status });
    };
    (async () => {
      const outcomes = [];
      for (const read of ${JSON.stringify(reads)}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-outage-'));
        for (const [key, hex] of Object.entries(read.store)) {
          fs.writeFileSync(path.join(dir, key), Buffer.from(hex, 'hex'));
        }
        current = { failure: read.failure, fetched: [] };
        raw = null;
        const posted = [];
        const service = createColibriService({ runtime: recording, storageDir: dir, post: (m) => posted.push(m) });
        await service.init();
        await service.handle({
          type: 'request', id: 1, clientId: outcomes.length + 1,
          config: { chainId: read.chain, proverUrl: read.prover, zkProof: read.zk },
          method: read.method, params: read.params,
        });
        fs.rmSync(dir, { recursive: true, force: true });
        outcomes.push({ posted: posted.find((m) => m.type === 'result'), raw, fetched: current.fetched });
      }
      return outcomes;
    })().then(
      (outcomes) => { console.log(JSON.stringify({ outage: true, outcomes })); process.exit(0); },
      (err) => { console.log(JSON.stringify({ outage: true, error: String(err && err.stack || err) })); process.exit(0); },
    );
  `;
}

/** The outcomes from the child's stdout, revived as the host revives an
 * error (colibri-worker-host.js, `reviveError`). */
function wasmOutcomes(stdout) {
  const line = stdout.split('\n').find((text) => text.startsWith('{"outage"'));
  const parsed = JSON.parse(line);
  if (parsed.error) throw new Error(`the WASM outage child failed: ${parsed.error}`);
  return parsed.outcomes.map(({ posted, raw, fetched }) => {
    if (!posted || posted.ok) return { error: null, raw, fetched };
    const { name, message, code, data } = posted.error;
    const error = Object.assign(new Error(message), { name });
    if (code !== undefined) error.code = code;
    if (data !== undefined) error.data = data;
    return { error, raw, fetched };
  });
}

/** Each of `reads` (readOptions) on the WASM backend, in one child. */
async function wasmOutages(reads) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['-e', wasmSource(reads.map((read) => readOptions(read)))],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
  );
  return wasmOutcomes(stdout);
}

/** One read on the service backend: its own process and store. */
async function serviceOutage(options) {
  const read = readOptions(options);
  const { backendOf, startBackend } = require('./colibri-backends');
  const { makeHop } = require(NAMING_SHELL);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-colibri-outage-'));
  const fetched = [];
  const fetch = async (url, init = {}) => {
    fetched.push({ url: String(url), method: init.method, body: init.body ?? null });
    if (read.failure.transport) throw new TypeError(read.failure.transport);
    return new Response(read.failure.body, { status: read.failure.status });
  };
  const chainDir = path.join(userData, 'colibri', String(read.chain));
  fs.mkdirSync(chainDir, { recursive: true });
  for (const [key, hex] of Object.entries(read.store)) {
    fs.writeFileSync(path.join(chainDir, key), Buffer.from(hex, 'hex'));
  }
  const started = await startBackend(backendOf('service'), {
    userData,
    hop: makeHop({ fetch }),
  });
  try {
    const client = started.host.createClient({
      chainId: read.chain,
      proverUrl: read.prover,
      zkProof: read.zk,
    });
    const error = await client.request({ method: read.method, params: read.params }).then(
      () => null,
      (err) => err
    );
    return { error, raw: null, fetched };
  } finally {
    await started.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

/** A read while the prover fails, on backend `kind` (see the header). */
async function proverOutage(kind, options = {}) {
  if (kind === 'wasm') return (await wasmOutages([options]))[0];
  if (kind === 'service') return serviceOutage(options);
  throw new Error(`unknown Colibri backend: ${kind}`);
}

/** The WASM backend's error for a read while the prover is down, at once. */
function proverOutageError(options = {}) {
  const stdout = execFileSync(process.execPath, ['-e', wasmSource([readOptions(options)])], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const [{ error }] = wasmOutcomes(stdout);
  if (!error) throw new Error(`${options.method || 'eth_getBalance'} answered with the prover down`);
  return error;
}

/**
 * The vectors' F-9 cases (design 0014, Vectors): each proofable method the
 * service serves with its prover failing by an HTTP error or a transport
 * error, and the cases whose completed message crosses the 2,000-unit cut.
 * Each is `{ id, read, outcome, design }`: the read as `proverOutage` takes
 * it, the reference's recorded outcome (today's WASM path), and the one
 * the design gives the service (the same but where the case is marked
 * `fetch-error-text`). The store is the session's, as its recorded fetch
 * shows it: the prover request carries `states_<chain>` as its `c4`, and the
 * case's recorded store entry for it must agree.
 */
function f9Cases(vectors) {
  const crypto = require('node:crypto');
  return vectors.cases
    .filter((entry) => entry.kind === 'request' && /-f9-/.test(entry.id))
    .map((entry) => {
      const [asked] = entry.requests;
      const fetches = entry.trace.filter((step) => step.op === 'fetch');
      if (fetches.length !== 1 || fetches[0].server !== 'prover') {
        throw new Error(`${entry.id}: not one prover fetch`);
      }
      const [fetch] = fetches;
      const reply = fetch.reply;
      const failure = reply.transport
        ? { transport: reply.transport }
        : { status: reply.status, body: reply.derived?.body };
      if (!failure.transport && typeof failure.body !== 'string') {
        throw new Error(`${entry.id}: the reply's body isn't recorded`);
      }
      const store = {};
      const c4 = JSON.parse(fetch.body).c4;
      const key = `states_${entry.chain}`;
      if (c4 !== undefined) {
        const hex = c4.replace(/^0x/, '');
        const sha256 = crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
        if (entry.store?.entries?.[key]?.sha256 !== sha256) {
          throw new Error(`${entry.id}: the prover request's c4 isn't the recorded ${key}`);
        }
        store[key] = hex;
      }
      const [outcome] = entry.outcomes;
      const [design] = entry.design?.outcomes ?? entry.outcomes;
      return {
        id: entry.id,
        deviation: entry.deviation ?? null,
        read: {
          chain: entry.chain,
          zk: entry.zk,
          prover: fetch.url,
          method: asked.method,
          params: asked.params,
          failure,
          store,
        },
        outcome: outcome.error,
        design: design.error,
      };
    });
}

module.exports = {
  ACCOUNT,
  HTTP_503,
  PROVER,
  TRANSPORT,
  f9Cases,
  proverOutage,
  proverOutageError,
  wasmOutages,
};
