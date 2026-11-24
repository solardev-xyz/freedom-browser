/**
 * A Colibri read while its prover fails (#1059, F-9), on freedom-colibrid
 * (freedom-core design 0014, A failed remote proof). Nothing leaves the
 * machine: every request is answered here, by `failure`, an HTTP error
 * (`{ status, body }`) or a transport failure (`{ transport }`, the error
 * Node's `fetch` throws). The read runs on colibri-service.js with the real
 * binary (test/helpers/colibri-service-harness.js), its fetches through
 * main's executor on a scripted hop.
 *
 * `store` seeds the chain's directory (key → hex), as a session's earlier
 * requests left it. Each run starts its own process with its own store.
 *
 * `proverOutage(options)` resolves to `{ error, fetched }`: the error the
 * client's caller gets (`null` if the read was answered), and every request
 * made (`{ url, method, body }`). `proverOutageError()` is that error as
 * main builds it from the service's failed remote proof, at once, as
 * chain.integration.test.js takes it. `f9Cases(vectors)` lists the vectors'
 * outage cases with what the service's outcome must be.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

/** A read while the prover fails (see the header): its own process and
 * store. */
async function proverOutage(options = {}) {
  const read = readOptions(options);
  const { startService } = require('./colibri-service-harness');
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
  const started = await startService({ userData, hop: makeHop({ fetch }) });
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
    return { error, fetched };
  } finally {
    await started.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

/**
 * The adapter's error for a read while the prover is down (an HTTP 503),
 * as main builds it from the service's failed remote proof
 * (colibri-outcome.js), at once. colibri-outage-parity.test.js holds the
 * real binary to it.
 */
function proverOutageError({ method = 'eth_getBalance', params = [ACCOUNT, 'latest'] } = {}) {
  const { replyOutcome } = require(path.join(ENS, 'colibri-outcome.js'));
  const text = `HTTP error! Status: ${HTTP_503.status}, Details: ${HTTP_503.body}`;
  return replyOutcome(
    { status: 'error', error: `remote proof failed (no local proving): ${text}` },
    { method, params }
  ).error;
}

/**
 * The vectors' F-9 cases (design 0014, Vectors): each proofable method the
 * service serves with its prover failing by an HTTP error or a transport
 * error, and the cases whose completed message crosses the 2,000-unit cut.
 * Each is `{ id, read, body, outcome, design }`: the read as `proverOutage`
 * takes it, the prover request's recorded body, the reference's recorded
 * outcome (the WASM path's), and the one the design gives the service (the
 * same but where the case is marked `fetch-error-text`). The store is the session's, as its recorded fetch
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
        body: fetch.body,
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
};
