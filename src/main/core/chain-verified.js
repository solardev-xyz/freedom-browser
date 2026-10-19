/**
 * Main's executor for the chain thread's verified operations (freedom-core
 * design 0005, Verified operations): `shell.verified` runs one whole Myotis
 * or Colibri operation through today's adapters, and replies only once the
 * adapter has settled, never early, in exactly its operation's shape:
 *
 * - a Myotis read: `{ payload, block_before, block_after }`, the adapter's
 *   JSON with its keys in snake_case and the optimistic block number around
 *   it, or `{ failure }`;
 * - a Myotis broadcast: `{ hash }`, `{ rejected: { reason } }` (the
 *   adapter's `rejected`), `{ rejected: { reason, code: -32602 } }` (its
 *   `invalid-params`, to a core that reads it; any other gets the first
 *   form), `{ uncertain: true }`, `{ not_sent: true }` or `{ failure }`;
 * - Colibri: `{ result }`, `{ undefined_keys: ["result"] }` for a result of
 *   `undefined`, `{ revert: { data } }` (with `capacity: true` when it is
 *   also a capacity failure) or `{ failure }`. The `undefined_keys` and
 *   `capacity` forms are freedom-core's follow-up to #57.
 *
 * A failure is a class of chain data's closed set, without text (Myotis
 * read outcomes); Colibri's adds `capacity`, set exactly where the router's
 * isCapacityFailure holds, a revert's too. A reply over the message cap is `too_large`, and
 * one main's pool can't hold is `busy`. Naming's operations share the
 * per-verifier bound. A Myotis broadcast marks main's record of each
 * broadcast of its bytes in flight as it starts (chain-broadcasts.js).
 */

const { ShellError } = require('./core-client');
const { MAX_PER_VERIFIER, ENVELOPE_BYTES } = require('./naming-verified');
const { MAX_MESSAGE } = require('./frame');
const { isChainRequest, chainHandler, NOT_SENT } = require('./chain-shell');
const { isHexData } = require('../ens/ccip-fetch');
const { isCapacityFailure } = require('../networks/chain-errors');

/** The adapters' own MYOTIS_UNAVAILABLE rejections whose texts the core
 * rebuilds: verifiedRequest's, and myotis-process's of a read. */
const UNAVAILABLE_CLASSES = new Map([
  ['Myotis state changed while the request was running', 'state_changed'],
  ['Myotis request queue is full', 'queue_full'],
  ['Myotis queue deadline exceeded', 'queue_deadline'],
  ['Myotis caller deadline exceeded', 'caller_deadline'],
]);
/** myotis-process's rejections of an operation it never dispatched: a
 * dispatched broadcast's are MYOTIS_BROADCAST_UNCERTAIN instead. */
const UNDISPATCHED = new Set([
  'Myotis is unavailable',
  'Myotis request exceeds size limit',
  'Myotis stopped',
  'Myotis child exited',
]);
/** The classes of a broadcast that sent nothing, whose texts the core
 * rebuilds (design 0005, The rest). */
const UNSENT_CLASSES = new Set(['not_running', 'not_ready', 'queue_full', 'queue_deadline']);

const refused = () => new ShellError('refused');

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A Myotis adapter's error as chain data's class: `runningInstance`'s two,
 * which name the chain first; the adapters' own MYOTIS_UNAVAILABLE ones,
 * by their texts; `error` for any other. */
function myotisClass(err) {
  const message = typeof err?.message === 'string' ? err.message : '';
  if (err?.code === undefined) {
    if (message.endsWith(' Myotis client is not running')) return 'not_running';
    if (message.endsWith(' Myotis verified reader is not ready')) return 'not_ready';
  }
  if (err?.code === 'MYOTIS_UNAVAILABLE') return UNAVAILABLE_CLASSES.get(message) ?? 'error';
  return 'error';
}

/** The adapter's definite refusals of a broadcast, which sent nothing:
 * `rejected` on verified state (ABI 36), and `invalid-params` for bytes that
 * are no transaction Myotis relays (ABI 44's permanent -32602). */
const REFUSALS = new Set(['rejected', 'invalid-params']);

/** The `core.hello` feature of a core that reads a refusal's code
 * (freedom-core design 0005, The rest). */
const REFUSAL_CODES = 'myotis_refusal_codes';

/** A Myotis broadcast's failure, as myotis-process classes it: a definite
 * refusal; uncertain once dispatched; not sent when it never was, keeping
 * today's text where the core rebuilds one. Anything else may have been
 * dispatched.
 *
 * Both refusals are `rejected`, the one reply that ends the core's attempt
 * loop with nothing sent, so no second broadcaster is asked, as the router
 * did. The core rebuilds the adapter's error from it: `invalid-params`
 * names its -32602 for a core that reads the code (`codes`), which
 * rebuilds it with that code and marker. To a core that doesn't, it goes
 * as `rejected` does, and comes back as -32000, `myotisRefusal: 'rejected'`. */
function broadcastFailure(err, codes) {
  if (REFUSALS.has(err?.myotisRefusal)) {
    const rejected = { reason: String(err.message) };
    if (codes && err.myotisRefusal === 'invalid-params' && err.code === -32602) {
      rejected.code = -32602;
    }
    return { rejected };
  }
  if (err?.code === 'MYOTIS_BROADCAST_UNCERTAIN') return { uncertain: true };
  const failure = myotisClass(err);
  if (UNSENT_CLASSES.has(failure)) return { failure };
  if (err?.code === 'MYOTIS_UNAVAILABLE' && UNDISPATCHED.has(err.message)) return NOT_SENT;
  return { failure };
}

/** The hash a broadcast's answer names, as the router reads it
 * (`assertMyotisAnswer`, then `nativeResult(payload, 'txHash', 'result')`);
 * undefined when it names none, or isn't an answer. */
function broadcastHash(payload) {
  if (!payload || payload.error) return undefined;
  if (['revert', 'infeasible', 'error', 'unavailable'].includes(payload.status)) return undefined;
  for (const key of ['txHash', 'result']) {
    if (payload[key] != null) return payload[key];
  }
  return undefined;
}

/** A Colibri adapter's error: a revert the prover verified (the worker's
 * code 3 with hex data), or a failure. Either is a capacity failure where
 * the router would block the route for it: a failure's class is then
 * `capacity`, and a revert keeps its data with `capacity: true` beside it,
 * a member present only when true. Its text never crosses. */
function colibriFailure(err) {
  const capacity = isCapacityFailure(err);
  if (err?.code === 3 && isHexData(err.data)) {
    return capacity
      ? { revert: { data: err.data }, capacity: true }
      : { revert: { data: err.data } };
  }
  return { failure: capacity ? 'capacity' : 'error' };
}

/** A Myotis payload with its own keys in snake_case (`codeHex` becomes
 * `code_hex`), in its order; anything but an object as it is, and nothing
 * as `null`. */
function wirePayload(payload) {
  if (!isObject(payload)) return payload ?? null;
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ])
  );
}

/** The optimistic block number of a status sample, or null. */
const blockOf = (status) => status?.optimisticBlockNumber ?? null;

/** The Myotis reads, by operation: today's adapter call, at `latest`. */
const MYOTIS_READS = new Map([
  ['account', (op, a) => a.myotisAccount(op.address, op.chain_id)],
  ['code', (op, a) => a.myotisCode(op.address, op.chain_id)],
  ['storage', (op, a) => a.myotisStorage(op.address, op.slot, op.chain_id)],
  ['call_tx', (op, a) => a.myotisCallTx({ chainId: op.chain_id, tx: op.tx, block: 'latest' })],
  [
    'estimate_tx',
    (op, a) => a.myotisEstimateTx({ chainId: op.chain_id, tx: op.tx, block: 'latest' }),
  ],
  ['fee', (op, a) => a.myotisFee(op.chain_id)],
]);

/** Today's adapters, loaded when first used. */
function defaultAdapters() {
  const myotis = () => require('../myotis/myotis-manager');
  return {
    myotisStatus: (chainId) => myotis().getStatus(chainId),
    myotisAccount: (address, chainId) => myotis().getAccount(address, chainId),
    myotisCode: (address, chainId) => myotis().getCode(address, chainId),
    myotisStorage: (address, slot, chainId) => myotis().getStorageAt(address, slot, chainId),
    myotisCallTx: (args) => myotis().ethCallTx(args),
    myotisEstimateTx: (args) => myotis().estimateGas(args),
    myotisFee: (chainId) => myotis().feeEstimate(chainId),
    myotisBroadcast: (raw, chainId) => myotis().sendRawTransaction(raw, chainId),
    colibriRequest: (chainId, method, params, options) =>
      require('../ens/colibri-resolver').requestViaColibri(chainId, method, params, options),
  };
}

/**
 * The operation `params` names: its verifier, how to run it with the
 * adapters, and what its adapter's error answers (`refusalCodes()`: whether
 * the core reads a broadcast refusal's code). Anything malformed is
 * refused.
 */
function operation(params, adapters, broadcasts, refusalCodes) {
  const read = typeof params.myotis === 'string' && MYOTIS_READS.get(params.myotis);
  if (read) {
    const call = params.myotis === 'call_tx' || params.myotis === 'estimate_tx';
    if (call && !Object.hasOwn(params, 'tx')) throw refused();
    return {
      verifier: 'myotis',
      run: async () => {
        // The head sampled around a state or call read, as the router
        // samples it for a trust label: inside the operation, so a throwing
        // sample fails it. A fee estimate is read with none, as the
        // router's fee quote reads it (and only an `eth_call` asks for
        // trust today).
        const sample = () =>
          params.myotis === 'fee' ? null : blockOf(adapters.myotisStatus(params.chain_id));
        const before = sample();
        const payload = await read(params, adapters);
        const after = sample();
        return { payload: wirePayload(payload), block_before: before, block_after: after };
      },
      failed: (err) => ({ failure: myotisClass(err) }),
    };
  }
  if (params.myotis === 'broadcast') {
    if (typeof params.raw !== 'string') throw refused();
    return {
      verifier: 'myotis',
      run: async () => {
        // From here the bytes may leave main.
        broadcasts?.sending(params.chain_id, params.raw, 'myotis');
        const hash = broadcastHash(await adapters.myotisBroadcast(params.raw, params.chain_id));
        return hash === undefined ? { uncertain: true } : { hash };
      },
      failed: (err) => broadcastFailure(err, refusalCodes()),
    };
  }
  if (params.colibri === 'request') {
    const { method, deadline_ms: deadlineMs } = params;
    if (typeof method !== 'string' || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
      throw refused();
    }
    return {
      verifier: 'colibri',
      run: async () => {
        const result = await adapters.colibriRequest(params.chain_id, method, params.params, {
          deadlineMs,
        });
        // JSON has no `undefined`: a success without a value names its
        // result instead, as the core's own replies do (design 0005,
        // Replies), and the router's caller gets an own `undefined`.
        return result === undefined ? { undefined_keys: ['result'] } : { result };
      },
      failed: colibriFailure,
    };
  }
  throw refused();
}

/** Whether JSON carries a member with this value. */
const carried = (value) =>
  value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';

/**
 * The reply as it will be sent, charged to main's pool until it is
 * serialized: one JSON can't carry whole is `error`, one over the message
 * cap `too_large`, and one past the pool `busy`.
 */
function held(reply, charge) {
  if (!Object.values(reply).every(carried)) return { failure: 'error' };
  let json;
  try {
    json = JSON.stringify(reply);
  } catch {
    return { failure: 'error' };
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes + ENVELOPE_BYTES > MAX_MESSAGE) return { failure: 'too_large' };
  if (!charge(bytes)) return { failure: 'busy' };
  return reply;
}

/**
 * Registers `shell.verified` on `client`, for the chain thread's requests.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {object} config - main's chain configuration: `generation(chainId)`,
 *   the chain's current generation
 * @param {object} [deps] - running: the operations running per verifier,
 *   shared with naming's executor; broadcasts: main's broadcast record
 *   (chain-broadcasts.js); test seam: adapters
 */
function registerChainVerified(client, config, deps = {}) {
  const adapters = deps.adapters || defaultAdapters();
  const running = deps.running || { myotis: 0, colibri: 0 };
  const broadcasts = deps.broadcasts || null;
  // Whether the core reads a refusal's code: its hello's, as the reply goes.
  const refusalCodes = () => client.hello?.capabilities?.includes(REFUSAL_CODES) === true;

  client.handle(
    'shell.verified',
    chainHandler(async (params, { signal, charge }) => {
      const { chain_id: chainId, generation } = params;
      if (!Number.isSafeInteger(chainId) || chainId < 0) throw refused();
      // Stale (one main hasn't seen yet is newer, never stale), or
      // cancelled first: it never runs.
      if (!Number.isSafeInteger(generation) || generation < config.generation(chainId)) {
        return NOT_SENT;
      }
      if (signal.aborted) return NOT_SENT;
      const { verifier, run, failed } = operation(params, adapters, broadcasts, refusalCodes);
      if (running[verifier] >= MAX_PER_VERIFIER) return { failure: 'busy' };
      running[verifier] += 1;
      let reply;
      try {
        // The whole operation, whoever still waits for it: a cancel or the
        // deadline doesn't end it, and the reply goes only once it settles.
        reply = await Promise.resolve().then(run).then(null, failed);
      } finally {
        running[verifier] -= 1;
      }
      return held(reply, charge);
    }),
    { when: isChainRequest }
  );

  return { running };
}

module.exports = {
  registerChainVerified,
  myotisClass,
  wirePayload,
};
