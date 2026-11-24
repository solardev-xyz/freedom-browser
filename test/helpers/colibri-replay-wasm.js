/**
 * One recorded Colibri case on the WASM backend, at its recorded clock
 * (freedom-core design 0014, Vectors; COL-5): run as
 * `node colibri-replay-wasm.js <plan.json>` by test/helpers/colibri-replay.js.
 *
 * The real package, through colibri-runtime and colibri-worker.js's own
 * service (its client config, its disk store, its error serializer), as
 * freedom-core's generator ran it to record the case: `Date.now` reads each
 * request's recorded instant, which is the clock the WASM verifier reads
 * too, and `fetch` answers from the plan's world, keyed by URL, verb and body
 * (`keyOf`). A request the world doesn't answer fails as a transport error
 * and is reported. A child process because Jest cannot load the WASM
 * runtime, a fresh one per case because the verifier keeps state between
 * requests (its transaction cache).
 *
 * The plan: `{ ens, chain, zk, prover, storageDir, requests: [{ method,
 * params, clock }], world: [{ key, status, headers, base64 } | { key,
 * transport }] }`; `storageDir` null for a private session's memory store.
 * Prints one JSON line: `{ replay: true, posted, fetched, unscripted }`,
 * each fetch as `{ url, method, headers, body }`.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * A fetch's key in a world: its URL (an origin's empty path written as
 * none, as the package writes a prover's URL and main's join doesn't), its
 * verb, and its body.
 */
function keyOf({ url, method = 'GET', body = null }) {
  const parsed = new URL(url);
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
  return JSON.stringify([
    `${parsed.origin}${pathname}${parsed.search}`,
    method.toUpperCase(),
    body,
  ]);
}

async function replay(plan) {
  const runtime = require(path.join(plan.ens, 'colibri-runtime.js'));
  const { createColibriService } = require(path.join(plan.ens, 'colibri-worker.js'));
  let clock = plan.requests[0]?.clock ?? 0;
  Date.now = () => clock;
  const world = new Map(plan.world.map((answer) => [answer.key, answer]));
  const fetched = [];
  const unscripted = [];
  globalThis.fetch = async (url, init = {}) => {
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
    return new Response(Buffer.from(answer.base64, 'base64'), {
      status: answer.status,
      headers: answer.headers,
    });
  };
  const posted = [];
  const service = createColibriService({
    runtime,
    storageDir: plan.storageDir,
    post: (message) => posted.push(message),
  });
  await service.init();
  for (const [index, request] of plan.requests.entries()) {
    clock = request.clock;
    await service.handle({
      type: 'request',
      id: index + 1,
      clientId: 1,
      config: { chainId: plan.chain, proverUrl: plan.prover, zkProof: plan.zk },
      method: request.method,
      params: request.params,
    });
  }
  return { posted, fetched, unscripted };
}

if (require.main === module) {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  replay(plan).then(
    (outcome) => {
      process.stdout.write(`${JSON.stringify({ replay: true, ...outcome })}\n`, () =>
        process.exit(0)
      );
    },
    (err) => {
      process.stdout.write(
        `${JSON.stringify({ replay: true, error: String((err && err.stack) || err) })}\n`,
        () => process.exit(0)
      );
    }
  );
}

module.exports = { keyOf };
