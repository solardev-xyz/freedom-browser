/**
 * Main's chain-data callers as drivers of the core's `chain.*` requests
 * (freedom-core design 0005, implementation step 5). A read, a fee quote or
 * a broadcast goes to the initialized core process alone (`whenServing`,
 * then `requestTo`), and its reply becomes today's result, or today's
 * thrown error:
 *
 * - a read's `result` gets back the `undefined` its reply names in
 *   `undefined_keys`, first in key order; endpoint references in its trust
 *   label become hosts, as the router's `endpointHost` makes them (design
 *   0005, Replies);
 * - `chain_error` is rebuilt as the router throws it: its constructor, its
 *   message and its own properties, in order (Errors and text);
 * - 0001's codes (`deadline`, `busy`, `budget`, `too_large`,
 *   `reconfigured`) throw the core's text;
 * - a caller's abort cancels the request and throws the signal's reason,
 *   as the router's `throwIfAborted` did.
 *
 * **Fencing** (Generations): every request is sent only with no chain
 * control in flight, checked last, with nothing between the check and the
 * write (the client's `fence`); its params are serialized once, before
 * that, so no caller code runs in between. Reads and fee quotes are also
 * judged only then. One that a configuration change ended
 * (`reconfigured`), or whose reply such a change overtook in the pipe, is
 * sent again once, within the caller's deadline.
 *
 * **Documents** (design 0006, `chain.html`): the `web3:` handler's
 * `html()` read, decoded, capped, hashed and classified by the core, is
 * fenced as a read is, within the caller's own deadline, and cancelled
 * with the caller's signal (deviation `web3-cancel`). Its result is the
 * document's text and hash, the read's source, verified and trust, and
 * the core's class; a failure throws as a read's does, and `failureOf`
 * tells the handler what the core said it ended with.
 *
 * **Broadcasts** are neither fenced nor sent again: an outcome is a fact
 * about the network. `sent` resolves the hash as today; `uncertain`
 * resolves it too, marked (`outcome: 'uncertain'`): sent but unconfirmed,
 * never a failure. `rejected` and `not_sent` throw today's error, tagged
 * with the outcome. With no reply from the core, main's record decides
 * (chain-broadcasts.js): `uncertain` once an attempt may have left main,
 * `not_sent` otherwise, never `rejected`.
 */

const { keccak256 } = require('ethers');
const { JsonParams } = require('./core-client');
const { MAX_PAYLOAD } = require('./frame');

/** A call's overall deadline (design 0005, Deadlines): the core's bound. */
const DEADLINE_MS = 120_000;
/** The hang watchdog's margin past the core's deadline (design 0001). */
const WATCHDOG_MARGIN_MS = 15_000;
/** The client's largest request ID, as wide as an ID gets on the wire. */
const MAX_ID = Number.MAX_SAFE_INTEGER;
/** The context chain requests go with (the client's default). */
const CONTEXT = { caller: 'chrome' };

/** A pending request whose core process ended. */
const RESTARTED = 'Chain data restarted';
/** No core process to send a request to. */
const UNAVAILABLE = 'Chain data is unavailable';
/** The core's own text for its `deadline`, which main also uses when the
 * caller's time ran out before sending (deviation `overall-deadline`). */
const DEADLINE = "The chain request's deadline passed";
/** The core's own text for `reconfigured`, which a read or a fee quote
 * throws when its one resend ended so too. */
const RECONFIGURED = "The chain's configuration changed";
/** A request over one frame (deviation `request-size`). */
const TOO_LARGE = 'The chain request is too large';
/** A request JSON can't carry (a function, a cycle), as the client says. */
const NOT_SERIALIZABLE = 'Request is not serializable';
/** A `chain.html` reply main can't read (design 0006, `chain.html`). */
const MALFORMED_DOCUMENT = 'The chain.html reply is malformed';

/** `chain.html`'s classes (design 0006): the gate's input. */
const DOCUMENT_CLASSES = new Set(['trusted', 'conflict', 'untrusted']);
const DOCUMENT_HASH = /^0x[0-9a-f]{64}$/;
/** The core's cap on a document (design 0006, `chain.html`): 8 MiB of UTF-8. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
/** The standard base64 alphabet, padding last. One character class, so a
 * 10.7 MiB document is checked in a single pass, without backtracking; the
 * padding's place and the unused bits are checked by re-encoding. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Fatal: a byte sequence that isn't UTF-8 fails, never becomes U+FFFD. A
 * leading BOM stays in the text, as the document's own bytes. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A document's text from its `html_base64`, or null for one the core
 * couldn't have written: anything but canonical base64 (Buffer's decoder
 * would drop what isn't base64, and ignore bad padding), more than 8 MiB of
 * bytes, or bytes that aren't UTF-8. The core's hash is trusted as it is:
 * this checks the encoding, not the content.
 */
function documentText(base64) {
  if (
    base64.length % 4 !== 0 ||
    base64.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 ||
    !BASE64.test(base64)
  ) {
    return null;
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_DOCUMENT_BYTES || bytes.toString('base64') !== base64) return null;
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** The call-object quantities the router turned into hex
 * (`normalizeCallObject`), in its order. */
const CALL_OBJECT_METHODS = new Set(['eth_call', 'eth_estimateGas']);
const CALL_QUANTITY_FIELDS = [
  'value',
  'gas',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'nonce',
  'chainId',
  'type',
];

/** The router's error classes, which main rebuilds the core's errors as:
 * their own properties (`name` among them) come from the reply. */
class SourceUnavailableError extends Error {}
class SourceDeadlineError extends SourceUnavailableError {}
class TruncatedLogsError extends Error {}
const CONSTRUCTORS = new Map([
  ['Error', Error],
  ['TypeError', TypeError],
  ['SyntaxError', SyntaxError],
  ['RangeError', RangeError],
  ['SourceUnavailableError', SourceUnavailableError],
  ['SourceDeadlineError', SourceDeadlineError],
  ['TruncatedLogsError', TruncatedLogsError],
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRef = (value) =>
  isObject(value) && typeof value.ref === 'string' && Object.keys(value).length === 1;

/** The router's `endpointHost`: `''` for a URL that doesn't parse. */
function endpointHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** A chain ID as the wire carries it, or null. The router looked a chain up
 * by `String(chainId)`, so a number names its chain and so does its
 * decimal text; nothing else names a configured one. */
function wireChainId(chainId) {
  if (typeof chainId === 'symbol') return null;
  const id = Number(chainId);
  return Number.isSafeInteger(id) && id >= 0 && String(id) === String(chainId) ? id : null;
}

/**
 * A call's params as the router took them, for JSON to carry: a BigInt
 * quantity of an `eth_call` or `eth_estimateGas` call object (a dApp's
 * `value: 3n` crosses IPC as one) becomes the router's hex quantity,
 * `quantity()`'s `0x` and its digits, a negative's sign among them. The core
 * normalizes everything else as the router did (design 0005,
 * Normalization); the call object keeps its key order.
 */
function wireParams(method, params) {
  if (!CALL_OBJECT_METHODS.has(method) || !Array.isArray(params) || params.length === 0) {
    return params;
  }
  const call = params[0];
  if (!isObject(call)) return params;
  let wired = call;
  for (const field of CALL_QUANTITY_FIELDS) {
    const value = call[field];
    if (typeof value !== 'bigint') continue;
    if (wired === call) wired = { ...call };
    wired[field] = `0x${value.toString(16)}`;
  }
  return wired === call ? params : [wired, ...params.slice(1)];
}

/** A request's params as JSON text, serialized once, before any fence: the
 * caller's own code (a getter, a `toJSON`) runs here, never between the
 * last fence and the write. `deadline_ms` goes last, per attempt. */
function serialized(payload) {
  try {
    return JSON.stringify(payload);
  } catch {
    throw new Error(NOT_SERIALIZABLE);
  }
}

/** One attempt's params: the serialized payload with what is left of the
 * deadline. */
const attemptParams = (head, deadlineMs) =>
  new JsonParams(`${head.slice(0, -1)},"deadline_ms":${deadlineMs}}`);

/** Whether a request would take more than one frame (deviation
 * `request-size`), measured as the client frames it, with the widest ID
 * and deadline. */
function oversized(method, head) {
  const envelope =
    `{"type":"request","id":${MAX_ID},"method":${JSON.stringify(method)},"params":` +
    `,"deadline_ms":${DEADLINE_MS}},"context":${JSON.stringify(CONTEXT)}}`;
  return Buffer.byteLength(head, 'utf8') - 1 + Buffer.byteLength(envelope, 'utf8') > MAX_PAYLOAD;
}

/**
 * What the core said a failed request ended with, kept beside the error
 * rather than on it, so today's error keeps exactly its own properties:
 * `{ code }` for 0001's codes (`deadline`, `cancelled`, `busy`, `budget`,
 * `too_large`, `reconfigured`), `deadline` also when the caller's time ran
 * out in main; `{ code: 'chain_error', kind }` for today's error, `kind`
 * `core` for the core's own texts and `node` for a node's error. The
 * `web3:` handler maps it to a status (design 0006, `chain.html`, Errors).
 */
const failures = new WeakMap();

/** `error`, noted as having ended with `failure`. */
function markFailure(error, failure) {
  if (error !== null && typeof error === 'object') failures.set(error, failure);
  return error;
}

/** What `error` ended with, as markFailure noted it, or null. */
function failureOf(error) {
  return (error !== null && typeof error === 'object' && failures.get(error)) || null;
}

/** The caller's deadline passed in main. */
const deadlineError = () => markFailure(new Error(DEADLINE), { code: 'deadline' });

/** Today's thrown error, rebuilt from a `chain_error`'s data: its
 * constructor, its message, then its own properties in order, an
 * `undefined` restored where the reply names one. */
function rebuilt(data) {
  const name = isObject(data) && Object.hasOwn(data, 'constructor') ? data.constructor : null;
  const Constructor = CONSTRUCTORS.get(name) ?? Error;
  const error = new Constructor(String(data?.message ?? ''));
  const props = isObject(data?.props) ? data.props : {};
  const undefinedKeys = Array.isArray(data?.undefined_keys) ? data.undefined_keys : [];
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(error, key, {
      value: undefinedKeys.includes(key) ? undefined : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return error;
}

/** The error a failed request throws: a `chain_error` rebuilt, anything
 * else the core's or the client's text. */
function thrown(err) {
  if (err?.code === 'chain_error') {
    const kind = err.data?.kind === 'core' || err.data?.kind === 'node' ? err.data.kind : null;
    return markFailure(rebuilt(err.data), { code: 'chain_error', kind });
  }
  const error = new Error(String(err?.message));
  return typeof err?.code === 'string' ? markFailure(error, { code: err.code }) : error;
}

/** Whether a failure is the core's reply to a chain request: those carry
 * the generation they were made under. */
function answered(err) {
  return isObject(err?.data) && Number.isSafeInteger(err.data.generation);
}

/** The client sent nothing: a control came in flight after the last idle
 * check. */
function fencedOff(err) {
  return err?.code === 'fenced' && !answered(err);
}

/** A failure the core never answered: its process ended, or the client
 * refused to send it. */
function lost(err) {
  return new Error(err?.code === 'core_unavailable' ? RESTARTED : String(err?.message));
}

/** A broadcast failure, tagged with its outcome. */
function tagged(error, outcome) {
  error.outcome = outcome;
  return error;
}

/** keccak256 of a raw transaction's bytes, or null for one that isn't hex
 * bytes. */
function transactionHash(raw) {
  try {
    return keccak256(raw);
  } catch {
    return null;
  }
}

/** Settles as `promise` does, or rejects once `ms` have passed or `signal`
 * aborts. */
function within(promise, ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (ms <= 0) return Promise.reject(new Error('deadline'));
  let timer;
  let onAbort;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('deadline')), ms);
      onAbort = () => reject(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

class ChainDriver {
  /**
   * @param {object} options
   * @param {import('./core-client').CoreClient} options.client
   * @param {import('./chain-config').ChainConfig} options.config
   * @param {import('./chain-broadcasts').BroadcastRecords} options.broadcasts
   * @param {() => number} [options.now] - a monotonic clock, in ms
   */
  constructor({ client, config, broadcasts, now = () => performance.now() }) {
    this.client = client;
    this.config = config;
    this.broadcasts = broadcasts;
    this.now = now;
  }

  /**
   * `request()`: one read, as the router served it. `routingContext.origin`
   * goes as it is: the core normalizes it as the router did, and keeps it
   * in memory only.
   *
   * @param {object} [options] - includeTrust, routingContext, signal,
   *   background, and profile: `default`, or `ant_scan` for the Ant
   *   bridge's log scans
   */
  request(
    chainId,
    method,
    params = [],
    { includeTrust = false, routingContext = null, signal, background = false, profile } = {}
  ) {
    const until = this.now() + DEADLINE_MS;
    const id = wireChainId(chainId);
    if (id === null) return Promise.reject(new Error(`Unsupported chain ID: ${chainId}`));
    const origin = routingContext?.origin;
    let head;
    try {
      head = serialized({
        chain_id: id,
        method,
        params: wireParams(method, params),
        include_trust: Boolean(includeTrust),
        ...(typeof origin === 'string' ? { origin } : {}),
        background: Boolean(background),
        profile: profile === 'ant_scan' ? 'ant_scan' : 'default',
      });
    } catch (err) {
      return Promise.reject(err);
    }
    return this.fenced('chain.request', id, head, { signal, until }, (reply, gen) =>
      this.published(reply, gen)
    );
  }

  /** `getFeeQuote()`: today's quote. */
  feeQuote(chainId) {
    const until = this.now() + DEADLINE_MS;
    const id = wireChainId(chainId);
    if (id === null) return Promise.reject(new Error(`Unsupported chain ID: ${chainId}`));
    const head = serialized({ chain_id: id });
    return this.fenced('chain.fee_quote', id, head, { until }, (reply) => {
      const { generation: _generation, ...quote } = reply ?? {};
      return quote;
    });
  }

  /**
   * `broadcastRawTransaction()`: `{ result, source }` once sent, with
   * `outcome: 'uncertain'` when it may have been; otherwise a throw
   * tagged `rejected` or `not_sent`. A cancel tells the core, and the
   * outcome it still answers is the one given.
   */
  async broadcast(chainId, raw, { signal } = {}) {
    const until = this.now() + DEADLINE_MS;
    const id = wireChainId(chainId);
    if (id === null) throw tagged(new Error(`Unsupported chain ID: ${chainId}`), 'not_sent');
    const record = this.broadcasts.begin(id, raw);
    try {
      return await this.sendBroadcast(id, raw, record, { signal, until });
    } finally {
      this.broadcasts.end(record);
    }
  }

  /**
   * `chain.html` (design 0006): the `web3:` handler's `html()` read of
   * `contract` on `chainId`, for the page whose permission key is
   * `origin`, within `deadlineMs` (at most the core's 120 s) and cancelled
   * when `signal` aborts. Resolves `{ html, htmlHash, source, verified,
   * trust?, class }`: the document's text, its keccak-256, the read's
   * source, verified and trust (hosts for references, as a read's), and
   * the core's class, `trusted`, `conflict` or `untrusted`. Fenced as a
   * read: a configuration change sends it again once.
   */
  chainHtml(chainId, contract, { origin, signal, deadlineMs = DEADLINE_MS } = {}) {
    const limit = Number.isFinite(deadlineMs)
      ? Math.min(Math.max(deadlineMs, 0), DEADLINE_MS)
      : DEADLINE_MS;
    const until = this.now() + limit;
    const id = wireChainId(chainId);
    if (id === null) return Promise.reject(new Error(`Unsupported chain ID: ${chainId}`));
    let head;
    try {
      head = serialized({
        chain_id: id,
        contract,
        origin: typeof origin === 'string' ? origin : '',
      });
    } catch (err) {
      return Promise.reject(err);
    }
    return this.fenced('chain.html', id, head, { signal, until }, (reply, gen) =>
      this.document(reply, gen)
    );
  }

  async sendBroadcast(id, raw, record, { signal, until }) {
    let head;
    try {
      head = serialized({ chain_id: id, raw });
    } catch (err) {
      throw tagged(err, 'not_sent');
    }
    if (oversized('chain.broadcast', head)) throw tagged(new Error(TOO_LARGE), 'not_sent');
    for (;;) {
      let gen;
      try {
        // After every control asked for before it, as a read goes.
        gen = await this.quiet(null, until, signal);
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        throw tagged(err, 'not_sent');
      }
      const remaining = Math.floor(until - this.now());
      if (remaining <= 0) throw tagged(new Error(DEADLINE), 'not_sent');
      let reply;
      try {
        reply = await this.send(gen, 'chain.broadcast', head, remaining, {
          signal,
          untilResponse: true,
        });
      } catch (err) {
        // A control came in flight since the wait: nothing was sent, and
        // it goes first.
        if (fencedOff(err)) continue;
        const outcome = err?.data?.outcome;
        if (answered(err) && (outcome === 'rejected' || outcome === 'not_sent')) {
          if (outcome === 'not_sent' && signal?.aborted) throw signal.reason;
          throw tagged(thrown(err), outcome);
        }
        // No outcome from the core: main's record gives one.
        if (record.sent) {
          return { result: transactionHash(raw), source: record.source, outcome: 'uncertain' };
        }
        if (signal?.aborted) throw signal.reason;
        throw tagged(answered(err) ? thrown(err) : lost(err), 'not_sent');
      }
      // Only `sent` is sent: anything else may have been.
      if (reply?.outcome === 'sent') return { result: reply.hash, source: reply.source };
      return { result: reply?.hash ?? null, source: reply?.source, outcome: 'uncertain' };
    }
  }

  /**
   * One attempt of a request to `gen`'s process, its serialized params
   * (`head`) with what is left of the deadline. It goes only if no chain
   * control is in flight, checked by the client last, after the request is
   * encoded, with nothing between the check and the write; otherwise it
   * fails `fenced` and sends nothing.
   */
  send(gen, method, head, remaining, options) {
    return this.client.requestTo(gen, method, attemptParams(head, remaining), undefined, {
      watchdogMs: remaining + WATCHDOG_MARGIN_MS,
      fence: () => this.config.idle(gen),
      ...options,
    });
  }

  /** The initialized process, waiting for one that is starting. */
  async process(until, signal) {
    if (!this.config.core) {
      try {
        await within(this.client.whenReady(), until - this.now(), signal);
      } catch {
        if (signal?.aborted) throw signal.reason;
        return null;
      }
    }
    try {
      return await within(this.config.whenServing(), until - this.now(), signal);
    } catch {
      if (signal?.aborted) throw signal.reason;
      return null;
    }
  }

  /** The process `pinned` (or, first, the current one) once no control is
   * in flight on it. A request belongs to the process it first went to: a
   * restart sends nothing again. */
  async quiet(pinned, until, signal) {
    for (;;) {
      if (pinned && this.config.core?.gen !== pinned) throw new Error(RESTARTED);
      const gen = await this.process(until, signal);
      // Its process gone, replaced or not.
      if (pinned && gen !== pinned && (gen || !this.client.serves(pinned))) {
        throw new Error(RESTARTED);
      }
      if (!gen) throw this.now() >= until ? deadlineError() : new Error(UNAVAILABLE);
      if (this.config.idle(gen)) return gen;
    }
  }

  /**
   * A read or a fee quote, fenced: sent with nothing between the last idle
   * check and the write, judged once every control it may have crossed has
   * settled, and sent again once when a configuration change ended or
   * overtook it.
   */
  async fenced(method, chainId, head, { signal, until }, publish) {
    if (oversized(method, head)) throw new Error(TOO_LARGE);
    let pinned = null;
    let resent = false;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      if (this.now() >= until) throw deadlineError();
      const gen = await this.quiet(pinned, until, signal);
      pinned = gen;
      // What is left after waiting for the core: the core's deadline for
      // the request, and its watchdog's, agree.
      const remaining = Math.floor(until - this.now());
      if (remaining <= 0) throw deadlineError();
      let reply = null;
      let failed = null;
      try {
        reply = await this.send(gen, method, head, remaining, { signal });
      } catch (err) {
        failed = err ?? new Error('Internal error');
      }
      // A cancel is the caller's own: today's AbortError.
      if (signal?.aborted) throw signal.reason;
      // A control came in flight since the wait: nothing was sent, and it
      // goes first.
      if (fencedOff(failed)) continue;
      if (failed && !answered(failed)) throw lost(failed);
      // A control asked for while the request ran may have overtaken it,
      // though the core hadn't seen it yet: the reply is judged once every
      // control has settled, by the generations they leave. Checked again
      // after every wait, so the last check, the judgment and the result
      // are one step.
      while (!this.config.idle(gen)) await this.quiet(gen, until, signal);
      const generation = failed ? failed.data.generation : reply?.generation;
      if (failed?.code === 'reconfigured' || this.config.overtaken(gen, chainId, generation)) {
        if (resent) throw markFailure(new Error(RECONFIGURED), { code: 'reconfigured' });
        resent = true;
        continue;
      }
      if (failed) throw thrown(failed);
      return publish(reply, gen);
    }
  }

  /** A read's result as the router returned it: `{ result, source,
   * verified, trust? }`, its trust label's references mapped by the
   * process that made it. */
  published(reply, gen) {
    const undefinedKeys = Array.isArray(reply?.undefined_keys) ? reply.undefined_keys : [];
    const published = {
      result: undefinedKeys.includes('result') ? undefined : reply?.result,
      source: reply?.source,
      verified: reply?.verified,
    };
    if (reply && Object.hasOwn(reply, 'trust')) published.trust = this.hosts(reply.trust, gen);
    return published;
  }

  /** A `chain.html` result as the `web3:` handler takes it: the document's
   * UTF-8 as text, and its trust label's references mapped by the process
   * that made it. A reply main can't read fails, as a malformed one: no
   * document, one not in the core's encoding (documentText), a hash that
   * isn't 32 lowercase hex bytes, an unknown class. */
  document(reply, gen) {
    if (
      !isObject(reply) ||
      typeof reply.html_base64 !== 'string' ||
      typeof reply.hash !== 'string' ||
      !DOCUMENT_HASH.test(reply.hash) ||
      !DOCUMENT_CLASSES.has(reply.class)
    ) {
      throw new Error(MALFORMED_DOCUMENT);
    }
    const html = documentText(reply.html_base64);
    if (html === null) throw new Error(MALFORMED_DOCUMENT);
    const document = {
      html,
      htmlHash: reply.hash,
      source: reply.source,
      verified: reply.verified,
    };
    if (Object.hasOwn(reply, 'trust')) document.trust = this.hosts(reply.trust, gen);
    document.class = reply.class;
    return document;
  }

  /** A trust label with its endpoint references as hosts, exactly where
   * the router named endpoints: `''` (a URL that doesn't parse, or a
   * reference main no longer maps) is dropped from `agreed`, `dissented`
   * and `queried`; Colibri's `prover` keeps it. */
  hosts(trust, gen) {
    if (!isObject(trust)) return trust;
    const host = (value) => endpointHost(this.config.endpointUrl(value.ref, gen));
    for (const key of ['agreed', 'dissented', 'queried']) {
      if (!Array.isArray(trust[key])) continue;
      trust[key] = trust[key].flatMap((value) => {
        if (!isRef(value)) return [value];
        const mapped = host(value);
        return mapped ? [mapped] : [];
      });
    }
    if (isRef(trust.prover)) trust.prover = host(trust.prover);
    return trust;
  }
}

module.exports = {
  ChainDriver,
  SourceUnavailableError,
  SourceDeadlineError,
  TruncatedLogsError,
  endpointHost,
  wireChainId,
  rebuilt,
  failureOf,
  markFailure,
  DEADLINE_MS,
  WATCHDOG_MARGIN_MS,
  RESTARTED,
  UNAVAILABLE,
  DEADLINE,
  RECONFIGURED,
  TOO_LARGE,
  MALFORMED_DOCUMENT,
};
