/**
 * Chain data's parity with the JS router, through the real freedom-cored
 * (freedom-core design 0005, Replay). freedom-core's replay vectors
 * (`vectors/chain-replay.json`: each call, the I/O it made and today's
 * result, recorded from the pinned chain-data-router.js) run through
 * main's drivers, its executors and a real core:
 *
 * - **Main's configuration** comes from each scenario's world: its registry
 *   and Myotis' readiness, sent again on each world change or event.
 * - **The calls** start when the reference started them, through the
 *   drivers as chain-data.js makes them.
 * - **The I/O:** every exchange, verifier operation, Myotis status sample,
 *   Blockscout hop and DNS lookup the executors make is answered from the
 *   recording, after its recorded delay: the first unused record of its
 *   kind that matches (URL and body with its id normalized; verifier,
 *   operation, chain and params), up to the current step. Answers due in
 *   one instant settle in one turn, in the reference's order. One the
 *   reference aborted, or left open, is never answered.
 * - **Each result** is compared with the router's: its keys in order and
 *   their values, or the error's constructor, `name`, message and own
 *   properties. Scenarios a deviation changes (the machine replay's
 *   DEVIATIONS) are compared with the difference it must show, as main's
 *   callers get it.
 *
 * The core runs on real time, so a scenario takes as long as it did in
 * virtual time; those that need the core's clock to run longer than the
 * cap (FREEDOM_CHAIN_REPLAY_MAX_MS, 65 s by default) are not replayed here
 * (fc-chain's replay runs them on a virtual clock), and neither are those
 * calling with router options `chain.request` doesn't carry. Both are
 * counted. Real time also costs what the reference's instant didn't: a
 * scenario whose budgets run out moving 16 MiB answers (THROUGHPUT_BOUND)
 * is reported, not failed, when its result is exactly the router's for
 * that (`throughputCut`). Settle times,
 * request ledgers and state tables are the machine replay's: here they are
 * reported, not asserted.
 *
 * Skipped unless FREEDOM_CORED_PATH points at a build with the chain thread
 * and the vectors are found: FREEDOM_CORE_VECTORS names the file, or the
 * binary sits inside a freedom-core checkout. FREEDOM_CHAIN_REPLAY narrows
 * the run to scenario IDs with these comma-separated prefixes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { keccak256 } = require('ethers');
const { CoreClient } = require('./core-client');
const { makeHop } = require('./naming-shell');
const { ChainConfig } = require('./chain-config');
const { BroadcastRecords } = require('./chain-broadcasts');
const { registerChainShell } = require('./chain-shell');
const { registerChainVerified } = require('./chain-verified');
const { ChainDriver } = require('./chain-driver');
const { isReadMethod } = require('../networks/chain-data');
const { LOG_INDEX_URLS } = require('../networks/blockscout-logs');
const { isCapacityFailure } = require('../networks/chain-errors');
const { isHexData } = require('../ens/ccip-fetch');
const { servesChain } = require('../../../test/helpers/core-chain-probe');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({
  netGatewayFetch: jest.fn(),
  isOnionHostname: () => false,
}));

const binary = process.env.FREEDOM_CORED_PATH;
const MAX_MS = Number(process.env.FREEDOM_CHAIN_REPLAY_MAX_MS) || 65_000;
const ONLY = (process.env.FREEDOM_CHAIN_REPLAY || '').split(',').filter(Boolean);
/** Scenarios replayed at once, each with its own core. */
const CONCURRENCY = 6;
/** How long past its recorded settle time a call may run before it counts
 * as never settled. */
const SETTLE_GRACE_MS = 20_000;
const quietLog = { info() {}, warn() {}, error() {} };
/** Answers due this close together settle in one turn. */
const TICK_MS = 2;
/** Settle times further than this from the reference's are reported. */
const DRIFT_MS = 250;

/** The vectors: FREEDOM_CORE_VECTORS, or the checkout the binary was built
 * in. */
function vectorsPath() {
  if (process.env.FREEDOM_CORE_VECTORS) return process.env.FREEDOM_CORE_VECTORS;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors', 'chain-replay.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const vectors = vectorsPath();
const describeIfReplay =
  vectors && fs.existsSync(vectors) && servesChain(binary) ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Values as the vectors record them.

/** A repeat form's text (a text over 64 KiB). */
const expand = (repeat) => `${repeat.head}${repeat.unit.repeat(repeat.count)}${repeat.tail}`;

/** A text field, or its repeat form. */
function textField(entry, name) {
  if (typeof entry?.[name] === 'string') return entry[name];
  const repeat = entry?.[`${name}_repeat`];
  return repeat ? expand(repeat) : undefined;
}

/** A value as one text, key order, `-0` and `undefined` included. */
function canon(value) {
  if (value === undefined) return 'undefined';
  if (Object.is(value, -0)) return '-0';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : String(value);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
      .join(',')}}`;
  }
  return `<${typeof value}>`;
}

/** A recorded entry's value: its JSON, or `undefined`. */
const entryValue = (entry) => (entry.undefined ? undefined : JSON.parse(textField(entry, 'json')));

/** The error a recorded throw was: its class, message and own
 * properties, as an adapter threw it. */
function thrownOf(recorded) {
  const Class = { TypeError, RangeError, SyntaxError }[recorded.class] ?? Error;
  const error = new Class(JSON.parse(recorded.message_json));
  for (const prop of recorded.props ?? []) error[prop.key] = entryValue(prop);
  return error;
}

/** A body with its JSON-RPC id as the vectors normalize it. */
const normalizedBody = (body) =>
  body.replace(/^\{"jsonrpc":"2\.0","id":\d+,/, '{"jsonrpc":"2.0","id":0,');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The world main is configured from.

const MYOTIS_NETWORKS = new Map([
  [1, { chainId: 1, displayName: 'Ethereum' }],
  [100, { chainId: 100, displayName: 'Gnosis' }],
]);

/** The registry a world describes: world.chains[chain] is { network, rpc,
 * prover, sources }, with world.sourceList. */
function registryOf(world) {
  const chainOf = (chainId) => world.chains?.[String(chainId)];
  return {
    getAllNetworks: () =>
      Object.fromEntries(
        Object.entries(world.chains ?? {})
          .filter(([, chain]) => chain?.network)
          .map(([id, chain]) => [id, chain.network])
      ),
    getEndpoints: (chainId, role) => [...(chainOf(chainId)?.[role] ?? [])],
    getEndpointSources: (chainId) => structuredClone(chainOf(chainId)?.sources ?? []),
    getEndpointSourceList: () => structuredClone(world.sourceList ?? []),
  };
}

/** Myotis' readiness in a world. */
function myotisOf(world) {
  return {
    NETWORKS: MYOTIS_NETWORKS,
    isReady: (chainId) => world.myotis?.[String(chainId)]?.ready === true,
  };
}

/** A status sample the reference never took (it samples for a trust label
 * only, main around every read): the world's, never one that throws. */
function worldStatus(world, chainId) {
  const plan = world.myotis?.[String(chainId)]?.status;
  const samples = (Array.isArray(plan) ? plan : [plan]).filter((s) => s && !s.throws);
  return samples.length ? structuredClone(samples.at(-1)) : null;
}

// ---------------------------------------------------------------------------
// The recorded I/O, answered as the reference's world answered it.

class Ledger {
  constructor(scenario, world, { reconcile }) {
    this.records = scenario.io ?? [];
    this.world = world;
    this.reconcile = reconcile;
    this.used = new Set();
    this.step = 0;
    // Answers waiting for their time (`schedule`).
    this.queue = [];
    this.timer = null;
    this.seq = 0;
    // Requests the reference never made, and replies the pinned core may
    // not take yet (freedom-core's Colibri shapes).
    this.extra = [];
    this.colibriShapes = [];
    this.fetch = (url, init = {}) =>
      (init.method ?? 'GET') === 'POST'
        ? this.rpc(String(url), init)
        : this.page(String(url), init);
    this.lookup = (host) => this.dns(host);
  }

  /** The first unused record of `kind` that `match` takes, up to the
   * current step. */
  take(kind, match) {
    for (const record of this.records) {
      if (this.used.has(record) || record.kind !== kind || (record.step ?? 0) > this.step) continue;
      if (!match(record)) continue;
      this.used.add(record);
      return record;
    }
    return null;
  }

  /** The records never answered: requests the reference made and the core
   * didn't. */
  missing() {
    return this.records
      .filter((r) => ['rpc', 'verified-op', 'blockscout', 'dns'].includes(r.kind))
      .filter((r) => !this.used.has(r))
      .map((r) => `${r.kind} ${r.url ?? r.host ?? ''} ${r.op ?? r.method ?? ''} (step ${r.step})`);
  }

  /** Settles as the record did, after its recorded delay: `produce` makes
   * its answer. One the reference aborted or left open never settles but
   * on `signal`. `depth` orders answers due together (`schedule`). */
  answer(record, signal, produce, depth = 0) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let item = null;
      const onAbort = () => {
        this.queue = this.queue.filter((queued) => queued !== item);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (record.outcome === 'aborted' || record.outcome === 'open' || record.end == null) return;
      item = this.schedule(Math.max(0, record.end - record.t), record.end, depth, () => {
        signal?.removeEventListener('abort', onAbort);
        try {
          resolve(produce(record));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Delivers `deliver` once `delay` has passed. Answers due together (within
   * a tick) settle in one turn, as the reference's did in one virtual
   * instant, in its order (fc-chain's replay): by their recorded end, then
   * a failure or a non-2xx status before a body is read (`depth`), then as
   * they came. Main's work on each then interleaves as the reference's
   * microtasks did.
   */
  schedule(delay, end, depth, deliver) {
    const item = { due: performance.now() + delay, end, depth, seq: this.seq++, deliver };
    this.queue.push(item);
    this.arm();
    return item;
  }

  arm() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length === 0) return;
    const next = Math.min(...this.queue.map((item) => item.due));
    this.timer = setTimeout(() => this.flush(), Math.max(0, next - performance.now()));
  }

  flush() {
    const now = performance.now() + TICK_MS;
    const due = this.queue
      .filter((item) => item.due <= now)
      .sort((a, b) => a.end - b.end || a.depth - b.depth || a.seq - b.seq);
    this.queue = this.queue.filter((item) => item.due > now);
    for (const item of due) item.deliver();
    this.arm();
  }

  close() {
    clearTimeout(this.timer);
    this.queue = [];
  }

  /** A request the reference never made: a reconciliation lookup is
   * answered `null` (the network doesn't know the hash), anything else
   * fails. */
  unscripted(what, isLookup, answer) {
    this.extra.push(what);
    if (this.reconcile && isLookup) return Promise.resolve(answer());
    return Promise.reject(new TypeError('unscripted'));
  }

  rpc(url, init) {
    const body = normalizedBody(String(init.body));
    const record = this.take('rpc', (r) => r.url === url && textField(r, 'body') === body);
    if (!record) {
      return this.unscripted(
        `rpc ${url} ${body.slice(0, 200)}`,
        body.includes('"method":"eth_getTransactionByHash"'),
        () => new Response('{"jsonrpc":"2.0","id":1,"result":null}', { status: 200 })
      );
    }
    const ok =
      record.outcome === 'answered' && record.answer.status >= 200 && record.answer.status < 300;
    return this.answer(
      record,
      init.signal,
      (r) => {
        if (r.outcome === 'failed') throw new TypeError(r.answer.fail);
        const { status } = r.answer;
        const body = [204, 205, 304].includes(status) ? null : textField(r.answer, 'body');
        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
      },
      ok ? 1 : 0
    );
  }

  page(url, init) {
    const record = this.take('blockscout', (r) => r.url === url);
    if (!record) return this.unscripted(`blockscout ${url}`, false);
    return this.answer(record, init.signal, (r) => {
      if (r.outcome === 'failed') throw new TypeError(r.answer.fail);
      const { status, headers } = r.answer;
      const body = [204, 205, 304].includes(status) ? null : textField(r.answer, 'body');
      return new Response(body, { status, headers });
    });
  }

  dns(host) {
    const record = this.take('dns', (r) => r.host === host);
    if (!record) return this.unscripted(`dns ${host}`, false);
    return this.answer(record, null, (r) => {
      if (r.outcome === 'failed') {
        throw Object.assign(new Error(`getaddrinfo ${r.answer.fail} ${host}`), {
          code: r.answer.fail,
        });
      }
      return JSON.parse(r.answer.addresses_json);
    });
  }

  /** One verifier operation, matched by its verifier, operation, chain and
   * params (Colibri's deadline aside: it is what is left of the source's
   * budget when the core sends it). */
  operation(host, op, chainId, params) {
    const want = canon(params);
    const record = this.take('verified-op', (r) => {
      if (r.host !== host || r.op !== op || r.chain !== chainId) return false;
      const recorded = JSON.parse(textField(r, 'params_json'));
      if (host === 'colibri') delete recorded.deadline_ms;
      return canon(recorded) === want;
    });
    if (!record) {
      return this.unscripted(
        `${host} ${op} chain ${chainId} ${want.slice(0, 200)}`,
        host === 'colibri' && params.method === 'eth_getTransactionByHash',
        () => null
      );
    }
    return this.answer(record, null, (r) => {
      const { answer } = r;
      const payload = textField(answer, 'payload_json') ?? textField(answer, 'result_json');
      if (payload !== undefined) return JSON.parse(payload);
      if (answer.result_undefined) {
        this.colibriShapes.push('a result of undefined');
        return undefined;
      }
      const error = thrownOf(answer.thrown);
      if (
        host === 'colibri' &&
        error.code === 3 &&
        isHexData(error.data) &&
        isCapacityFailure(error)
      ) {
        this.colibriShapes.push('a revert with capacity');
      }
      throw error;
    });
  }

  /** A Myotis status sample: the reference's, in order, else the world's. */
  status(chainId) {
    const record = this.take('myotis-status', (r) => r.chain === chainId);
    if (!record) return worldStatus(this.world, chainId);
    if (record.answer.thrown) throw thrownOf(record.answer.thrown);
    return JSON.parse(record.answer.status_json);
  }

  adapters() {
    const op = (host, name) => (chainId, params) => this.operation(host, name, chainId, params);
    return {
      myotisStatus: (chainId) => this.status(chainId),
      myotisAccount: (address, chainId) => op('myotis', 'account')(chainId, { address }),
      myotisCode: (address, chainId) => op('myotis', 'code')(chainId, { address }),
      myotisStorage: (address, slot, chainId) =>
        op('myotis', 'storage')(chainId, { address, slot }),
      myotisCallTx: ({ chainId, tx, block }) => op('myotis', 'call_tx')(chainId, { tx, block }),
      myotisEstimateTx: ({ chainId, tx, block }) =>
        op('myotis', 'estimate_tx')(chainId, { tx, block }),
      myotisFee: (chainId) => op('myotis', 'fee')(chainId, {}),
      myotisBroadcast: (raw, chainId) => op('myotis', 'broadcast')(chainId, { raw }),
      colibriRequest: (chainId, method, params) =>
        op('colibri', 'request')(chainId, { method, params }),
    };
  }
}

// ---------------------------------------------------------------------------
// What main's callers get where a deviation changes the result (fc-chain's
// replay.rs DEVIATIONS): step 0's call 0 in each.

/**
 * Scenarios whose I/O is large enough that moving it through main's
 * executors and the core takes real time against an interactive read's 2 s
 * budget: three 16 MiB `html()` answers, each read, sent in fragments and
 * decoded, where the reference's arrived in one virtual instant. On a slow
 * build or a busy machine the quorum is cut and Direct answers, or, slower
 * still, every member's own 5 s runs out; those two outcomes, exactly
 * (`throughputCut`), are reported, not failed. They run first, alone (a
 * release core on an idle machine agrees in about 1.4 s).
 */
const THROUGHPUT_BOUND = new Set(['boundary-html-8mib-through-quorum']);
const INTERACTIVE_BUDGET_MS = 2000;

/** Each quorum member's own budget in that scenario: its chain's
 * configured timeout, as Direct comes next. */
const MEMBER_BUDGET_MS = 5000;
/** The router's error when every member ran out of it before answering:
 * the quorum asked every endpoint, so Direct has none left. */
const EVERY_MEMBER_TIMED_OUT =
  'All chain sources failed for eth_call (quorum: RPC quorum did not reach 2 matching ' +
  'responses; direct: All RPC endpoints failed)';

/** Which of the router's budget outcomes a read cut by its I/O's real time
 * gave, exactly, or null: Direct's fallback past the interactive budget,
 * or every member's own timeout past theirs. */
function throughputCut(got, want) {
  if (directFallback(got, want)) return 'Direct answered';
  if (everyMemberTimedOut(got)) return 'every member timed out';
  return null;
}

/** Whether a read that ran past its members' own budget failed exactly as
 * the router does when none of them answered in time. */
function everyMemberTimedOut(got) {
  if (got.ok || !(got.elapsed > MEMBER_BUDGET_MS)) return false;
  const failure = { class: 'Error', name: 'Error', message: EVERY_MEMBER_TIMED_OUT, props: {} };
  return canon(outcomeOf(got)) === canon({ thrown: failure });
}

/**
 * Whether a read that ran past its interactive budget gave exactly what the
 * router gives when that budget cuts its quorum: Direct reusing the answer
 * that crossed first (its `directFallback`), unverified, with the round's
 * evidence. Nothing else may differ from the reference's quorum result:
 * the result's bytes, the keys and their order, the members asked, k and
 * m. Only the one answer that crossed agreed, so none dissented.
 */
function directFallback(got, want) {
  const value = got.value;
  const wanted = want.value;
  if (!value || !wanted?.trust || !(got.elapsed > INTERACTIVE_BUDGET_MS)) return false;
  const { queried, quorum } = wanted.trust;
  const crossed = Array.isArray(value.trust?.agreed) ? value.trust.agreed[0] : undefined;
  if (!queried.includes(crossed)) return false;
  const fallback = {
    result: wanted.result,
    source: 'direct',
    verified: false,
    trust: {
      level: 'unverified',
      method: 'direct',
      block: null,
      agreed: [crossed],
      dissented: [],
      queried,
      quorum: { k: quorum.k, m: quorum.m, achieved: false },
    },
  };
  return canon(value) === canon(fallback);
}

/** A broadcast that fails throws today's error tagged with its outcome
 * (deviation `broadcast-outcome`): `rejected` where every node it reached
 * refused it, `not_sent` for every other failure here. */
const REJECTED = new Set([
  'router-myotis-broadcast-rejected',
  'boundary-broadcast-mined-bytes-nonce-too-low',
]);

const uncertain = (source) => (call) => ({
  value: { result: keccak256(call.raw), source, outcome: 'uncertain' },
});
const failed = (message) => () => ({
  thrown: { class: 'Error', name: 'Error', message, props: {} },
});
const DEVIATIONS = new Map([
  ['router-myotis-broadcast-in-band-failure', ['broadcast-outcome', uncertain('myotis')]],
  ['router-myotis-broadcast-uncertain', ['broadcast-outcome', uncertain('myotis')]],
  ['cancel-broadcast-no-fallthrough', ['broadcast-outcome', uncertain('myotis')]],
  ['cancel-broadcast-later-timeout-wins', ['broadcast-outcome', uncertain('direct')]],
  ['cancel-broadcast-no-second-rpc', ['broadcast-outcome', uncertain('direct')]],
  ['boundary-broadcast-last-error-wins', ['broadcast-outcome', uncertain('direct')]],
  ['boundary-broadcast-lost-reply-then-already-known', ['broadcast-outcome', uncertain('direct')]],
  ['boundary-broadcast-lost-reply-then-nonce-too-low', ['broadcast-outcome', uncertain('direct')]],
  ['boundary-broadcast-refusal-after-ambiguous', ['broadcast-outcome', uncertain('direct')]],
  ['boundary-broadcast-other-hash-accepted', ['broadcast-outcome', uncertain('direct')]],
  ['boundary-broadcast-cancel-after-send', ['broadcast-outcome', uncertain('direct')]],
  ['boundary-broadcast-myotis-uncertain-in-band', ['broadcast-outcome', uncertain('myotis')]],
  ['boundary-broadcast-myotis-odd-payload', ['broadcast-outcome', uncertain('myotis')]],
  [
    'boundary-registry-change-mid-request',
    ['config-change', () => ({ value: { result: '0xnew', source: 'direct', verified: false } })],
  ],
  [
    'boundary-order-duplicates-and-unknown',
    [
      'order-validation',
      failed(
        'All chain sources failed for eth_call (colibri: No Colibri prover configured; ' +
          'direct: No RPC endpoint configured)'
      ),
    ],
  ],
  [
    'boundary-json-depth-513',
    [
      'json-depth',
      failed(
        'All chain sources failed for eth_call (quorum: RPC quorum did not reach 2 matching responses)'
      ),
    ],
  ],
]);

/** The reference's result as `{ value }` or `{ thrown }`, in the shape
 * `outcomeOf` gives main's. */
function recorded(result) {
  if (result.thrown) {
    const { thrown } = result;
    return {
      thrown: {
        class: thrown.class,
        name: thrown.name,
        message: JSON.parse(thrown.message_json),
        props: Object.fromEntries((thrown.props ?? []).map((p) => [p.key, entryValue(p)])),
      },
    };
  }
  if (result.pending) return { pending: true };
  return { value: Object.fromEntries(result.value.map((entry) => [entry.key, entryValue(entry)])) };
}

/** What a call settled with, as `recorded` shapes the reference's. */
function outcomeOf(settled) {
  if (settled.ok) return { value: settled.value };
  const error = settled.error;
  return {
    thrown: {
      class: error?.constructor?.name,
      name: error?.name,
      message: error?.message,
      props: Object.fromEntries(Object.keys(error ?? {}).map((key) => [key, error[key]])),
    },
  };
}

/** How `got` differs from `want`, or null. */
function difference(got, want) {
  if (want.pending) return 'the reference never settled it';
  const [a, b] = [canon(got), canon(want)];
  if (a === b) return null;
  // Where they part, for the long ones.
  let at = 0;
  while (at < a.length && a[at] === b[at]) at += 1;
  const from = Math.max(0, at - 120);
  const around = (text) => `${from ? '…' : ''}${text.slice(from, at + 280)}`;
  return `${around(a)} instead of ${around(b)} (${a.length} and ${b.length} long)`;
}

// ---------------------------------------------------------------------------
// A scenario, replayed.

/** Why a scenario isn't replayed here, or null. */
function notReplayed(scenario) {
  const calls = scenario.steps.flatMap((step) => step.calls ?? []);
  if (calls.some((call) => call.options)) return 'router options chain.request does not carry';
  if (duration(scenario) > MAX_MS) return `the core's clock past ${MAX_MS / 1000} s`;
  return null;
}

/** How long a scenario ran in virtual time. */
function duration(scenario) {
  let end = 0;
  for (const step of scenario.steps) {
    end = Math.max(end, step.at);
    for (const result of step.results ?? []) end = Math.max(end, result.settled ?? 0);
  }
  for (const record of scenario.io ?? []) end = Math.max(end, record.t ?? 0, record.end ?? 0);
  return end;
}

async function replay(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-chain-replay-'));
  const world = structuredClone(scenario.world);
  const deviation = DEVIATIONS.get(scenario.id);
  const ledger = new Ledger(scenario, world, {
    reconcile: deviation?.[0] === 'broadcast-outcome',
  });
  const client = new CoreClient({
    spawn,
    command: binary,
    args: [
      'serve',
      '--data-dir',
      path.join(root, 'identity'),
      '--lock-dir',
      path.join(root, 'locks'),
      '--parent-pid',
      String(process.pid),
    ],
    log: quietLog,
    shellVersion: 'jest',
  });
  const config = new ChainConfig({
    client,
    sources: { registry: registryOf(world), myotis: myotisOf(world), logIndexUrls: LOG_INDEX_URLS },
    log: quietLog,
  });
  const broadcasts = new BroadcastRecords();
  registerChainShell(client, config, {
    broadcasts,
    hop: makeHop({ fetch: ledger.fetch }),
    lookup: ledger.lookup,
  });
  registerChainVerified(client, config, { broadcasts, adapters: ledger.adapters() });
  const driver = new ChainDriver({ client, config, broadcasts });
  const outcome = { id: scenario.id, mismatches: [], throughput: [], drift: 0, ledger };
  const timers = [];
  try {
    await client.start();
    if ((await config.whenServing()) === null) throw new Error('the core never served chain data');
    const changed = () => {
      config.configure().catch(() => {});
      config.availability().catch(() => {});
    };
    for (const [index, step] of scenario.steps.entries()) {
      if (step.after) await sleep(step.after);
      ledger.step = index;
      if (step.world) {
        Object.assign(world, structuredClone(step.world));
        changed();
      }
      for (const event of step.events ?? []) {
        timers.push(
          setTimeout(() => {
            for (const [chain, change] of Object.entries(event.myotis ?? {})) {
              world.myotis ??= {};
              world.myotis[chain] = { ...(world.myotis[chain] ?? {}), ...structuredClone(change) };
            }
            for (const [chain, change] of Object.entries(event.chains ?? {})) {
              world.chains ??= {};
              world.chains[chain] = { ...(world.chains[chain] ?? {}), ...structuredClone(change) };
            }
            changed();
          }, event.at)
        );
      }
      const start = (call) => run(driver, call, timers);
      const calls = step.calls ?? [];
      let settled;
      if (step.driver) {
        // A caller's loop (Ant's log scans): each call starts when the one
        // before it settles.
        settled = [];
        for (const call of calls) settled.push(await start(call));
      } else {
        settled = await Promise.all(
          calls.map((call) => (call.at ? sleep(call.at).then(() => start(call)) : start(call)))
        );
      }
      settled.forEach((got, i) => {
        const result = step.results[i];
        const want =
          index === 0 && i === 0 && deviation ? deviation[1](calls[i]) : recorded(result);
        if (calls[i].fn === 'broadcastRawTransaction' && want.thrown?.class === 'Error') {
          want.thrown.props.outcome = REJECTED.has(scenario.id) ? 'rejected' : 'not_sent';
        }
        if (got.timedOut) {
          outcome.mismatches.push(`step ${index} call ${i}: never settled`);
          return;
        }
        const problem = difference(outcomeOf(got), want);
        // Its I/O took real time the reference's instant didn't have, and
        // the router's own budgets ran out: one of their outcomes exactly.
        const cut = problem && THROUGHPUT_BOUND.has(scenario.id) ? throughputCut(got, want) : null;
        if (cut) {
          outcome.throughput.push(
            `step ${index} call ${i} (${Math.round(got.elapsed)} ms, ${cut})`
          );
        } else if (problem) {
          outcome.mismatches.push(`step ${index} call ${i}: ${problem}`);
        }
        const took = result.settled - calls[i].started;
        outcome.drift = Math.max(outcome.drift, Math.abs(got.elapsed - took));
      });
    }
  } catch (err) {
    outcome.mismatches.push(`failed: ${err?.stack ?? err}`);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    ledger.close();
    await client.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return outcome;
}

/** One recorded call through the drivers, as chain-data.js makes it:
 * `{ ok, value | error, elapsed }`, or `timedOut` past its grace. */
async function run(driver, call, timers) {
  const controller = call.abort_at !== undefined || call.signal ? new AbortController() : null;
  if (call.abort_at !== undefined) timers.push(setTimeout(() => controller.abort(), call.abort_at));
  const signal = controller?.signal;
  const begun = performance.now();
  let pending;
  switch (call.fn) {
    case 'request': {
      const params = call.params_undefined ? undefined : JSON.parse(textField(call, 'params_json'));
      const options = {
        ...(call.include_trust ? { includeTrust: true } : {}),
        ...(call.origin !== undefined ? { routingContext: { origin: call.origin } } : {}),
        ...(call.background ? { background: true } : {}),
        ...(call.profile ? { profile: call.profile } : {}),
        ...(signal ? { signal } : {}),
      };
      pending = isReadMethod(call.method)
        ? driver.request(call.chain, call.method, params, options)
        : Promise.reject(new Error(`Unsupported read method: ${call.method}`));
      break;
    }
    case 'getFeeQuote':
      pending = driver.feeQuote(call.chain);
      break;
    case 'broadcastRawTransaction':
      pending = driver.broadcast(call.chain, call.raw, signal ? { signal } : undefined);
      break;
    default:
      throw new Error(`unknown call ${call.fn}`);
  }
  const expected = (call.expect_settle_ms ?? call.expect_settle_max_ms ?? 0) + SETTLE_GRACE_MS;
  let guard;
  const timedOut = new Promise((resolve) => {
    guard = setTimeout(() => resolve({ timedOut: true }), Math.max(expected, MAX_MS + 30_000));
  });
  const settled = await Promise.race([
    pending.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    ),
    timedOut,
  ]);
  clearTimeout(guard);
  return { ...settled, elapsed: performance.now() - begun };
}

/** Runs `tasks` with at most `limit` at once, longest first. */
async function pool(items, limit, task) {
  const queue = [...items];
  const results = [];
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) results.push(await task(item));
    })
  );
  return results;
}

// Review of #698 (parity): the throughput exception admits exactly what the
// router's own budgets give (Direct's fallback, or every member's timeout),
// and nothing else. Values only: no core needed.
describe('a read cut by its interactive budget', () => {
  const html = `0x${'61'.repeat(64)}`;
  const want = {
    value: {
      result: html,
      source: 'quorum',
      verified: true,
      trust: {
        level: 'verified',
        method: 'quorum',
        block: null,
        agreed: ['a.example', 'b.example'],
        dissented: [],
        queried: ['a.example', 'b.example', 'c.example'],
        quorum: { k: 3, m: 2, achieved: true },
      },
    },
  };
  const cut = (overrides = {}, trust = {}) => ({
    ok: true,
    elapsed: 3400,
    value: {
      result: html,
      source: 'direct',
      verified: false,
      trust: {
        level: 'unverified',
        method: 'direct',
        block: null,
        agreed: ['a.example'],
        dissented: [],
        queried: ['a.example', 'b.example', 'c.example'],
        quorum: { k: 3, m: 2, achieved: false },
        ...trust,
      },
      ...overrides,
    },
  });

  test("is admitted only as the router's Direct fallback, unchanged", () => {
    expect(directFallback(cut(), want)).toBe(true);
    // Another member's answer crossed first: the same fallback.
    expect(directFallback(cut({}, { agreed: ['c.example'] }), want)).toBe(true);
  });

  test.each([
    ['a corrupted result', cut({ result: '0xdead' })],
    ['one byte off', cut({ result: `${html.slice(0, -1)}2` })],
    ['verified', cut({ verified: true })],
    ['another source', cut({ source: 'quorum' })],
    ['a trust of another shape', cut({ trust: { wrong: true } })],
    ['a member that dissented', cut({}, { dissented: ['b.example'] })],
    ['an endpoint never asked', cut({}, { agreed: ['x.example'] })],
    ['an achieved quorum', cut({}, { quorum: { k: 3, m: 2, achieved: true } })],
    ['keys in another order', { ...cut(), value: { source: 'direct', ...cut().value } }],
    ['within the budget', { ...cut(), elapsed: 1500 }],
    ['a failure', { ok: false, elapsed: 3400, error: new Error('x') }],
  ])('is refused with %s', (_name, got) => {
    expect(directFallback(got, want)).toBe(false);
    expect(throughputCut(got, want)).toBeNull();
  });

  // Slower still: every member's own budget ran out before it answered.
  const timedOut = (error, elapsed = 8500) => ({ ok: false, elapsed, error });
  test("every member's timeout is admitted only as the router's own error", () => {
    expect(throughputCut(timedOut(new Error(EVERY_MEMBER_TIMED_OUT)), want)).toBe(
      'every member timed out'
    );
    expect(throughputCut(cut(), want)).toBe('Direct answered');
    for (const got of [
      timedOut(new Error(EVERY_MEMBER_TIMED_OUT), 4000),
      timedOut(new Error(`${EVERY_MEMBER_TIMED_OUT}.`)),
      timedOut(new TypeError(EVERY_MEMBER_TIMED_OUT)),
      timedOut(Object.assign(new Error(EVERY_MEMBER_TIMED_OUT), { code: -32000 })),
      timedOut(
        new Error('All chain sources failed for eth_call (quorum: RPC quorum needs 2 endpoints)')
      ),
    ]) {
      expect(throughputCut(got, want)).toBeNull();
    }
  });
});

describeIfReplay("chain data's replay through main's drivers and the real freedom-cored", () => {
  // The reviewer's probe: a corrupted result that settles past the budget,
  // from Direct, fails the scenario.
  test('a corrupted result past the interactive budget is a mismatch, not a cut', async () => {
    const { scenarios } = JSON.parse(fs.readFileSync(vectors, 'utf8'));
    const scenario = scenarios.find((s) => s.id === 'boundary-html-8mib-through-quorum');
    const published = jest
      .spyOn(ChainDriver.prototype, 'published')
      .mockImplementation(async () => {
        await sleep(INTERACTIVE_BUDGET_MS + 100);
        return { result: '0xdead', source: 'direct', verified: true, trust: { wrong: true } };
      });
    let outcome;
    try {
      outcome = await replay(scenario);
    } finally {
      published.mockRestore();
    }
    expect(outcome.throughput).toEqual([]);
    expect(outcome.mismatches).toHaveLength(scenario.steps.length);
  }, 60_000);

  test(
    "every replayable scenario gives the router's result, or its deviation's",
    async () => {
      const { scenarios } = JSON.parse(fs.readFileSync(vectors, 'utf8'));
      const chosen = scenarios.filter(
        (s) => ONLY.length === 0 || ONLY.some((prefix) => s.id.startsWith(prefix))
      );
      const skipped = new Map();
      const runnable = [];
      for (const scenario of chosen) {
        const reason = notReplayed(scenario);
        if (reason) skipped.set(reason, [...(skipped.get(reason) ?? []), scenario.id]);
        else runnable.push(scenario);
      }
      runnable.sort((a, b) => duration(b) - duration(a));
      // The scenarios bound by throughput go first, alone, then the rest.
      const alone = runnable.filter((s) => THROUGHPUT_BOUND.has(s.id));
      const outcomes = [
        ...(await pool(alone, 1, replay)),
        ...(await pool(
          runnable.filter((s) => !THROUGHPUT_BOUND.has(s.id)),
          CONCURRENCY,
          replay
        )),
      ];
      const failures = outcomes.filter((o) => o.mismatches.length > 0);
      const cut = outcomes.filter((o) => o.mismatches.length === 0 && o.throughput.length > 0);
      const shapes = outcomes.filter((o) => o.ledger.colibriShapes.length > 0);
      const extra = outcomes.filter((o) => o.ledger.extra.length > 0 && !DEVIATIONS.has(o.id));
      const missing = outcomes.filter((o) => o.ledger.missing().length > 0);
      const report = [
        `chain replay: ${outcomes.length - failures.length - cut.length} of ${outcomes.length} ` +
          `replayed match (${outcomes.filter((o) => DEVIATIONS.has(o.id) && !o.mismatches.length).length} ` +
          `with their deviation's difference), ${cut.length} cut by their I/O's real time, ` +
          `${failures.length} differ; not replayed: ` +
          [...skipped].map(([reason, ids]) => `${ids.length} (${reason})`).join(', '),
        `settle times off the reference's by over ${DRIFT_MS} ms: ` +
          (outcomes
            .filter((o) => o.drift > DRIFT_MS)
            .map((o) => `${o.id} (${Math.round(o.drift)} ms)`)
            .join(', ') || 'none'),
        ...[...skipped].map(([reason, ids]) => `not replayed, ${reason}: ${ids.join(', ')}`),
        ...shapes.map(
          (o) => `== ${o.id} uses Colibri shapes: ${o.ledger.colibriShapes.join(', ')}`
        ),
        ...failures.map((o) => `== ${o.id}\n${o.mismatches.join('\n')}`),
        ...cut.map(
          (o) => `-- ${o.id}: its budgets ran out moving the answers: ${o.throughput.join(', ')}`
        ),
        ...extra.map(
          (o) => `-- ${o.id} requests the reference never made: ${o.ledger.extra.join('; ')}`
        ),
        ...missing.map(
          (o) => `-- ${o.id} the reference's requests never made: ${o.ledger.missing().join('; ')}`
        ),
      ].join('\n');
      // The score is the test's report.
      console.log(report);
      expect(failures.map((o) => o.id)).toEqual([]);
    },
    30 * 60_000
  );
});
