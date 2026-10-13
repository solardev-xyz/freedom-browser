/**
 * Main's resolvers as drivers of the naming core's sessions (freedom-core
 * design 0004, implementation step 3; 0003 step 5). Each lookup goes to the
 * initialized core process alone (`whenServing`, then `requestTo`), and its
 * reply becomes today's result, or today's thrown resolution:
 *
 * - endpoint references become hosts, or URLs where today's results carry
 *   URLs (design 0004, Replies);
 * - keys present with the value `undefined` get it back (`undefined_keys`);
 * - `resolution_failed` throws its message, as today's resolvers throw.
 *
 * A reply computed under a generation main has since moved past was
 * overtaken in the pipe: main discards it and sends the lookup again, with
 * the attempts and the time it has left (design 0004, Generations).
 *
 * `dweb.open` (design 0006) is fenced the same way: a plan is a lookup's
 * result shaped as the request main will make, so an overtaken plan is
 * planned again with `attempts_used`, within the remaining deadline.
 */

const { isPrivateLogContext } = require('../private/private-log-context');
const { isTezosDomainHost } = require('../../shared/origin-utils');
const { unlessAborted } = require('../lib/unless-aborted');

/** A caller's lifecycle attempts, in all (resolveAcrossStableLifecycle). */
const MAX_ATTEMPTS = 3;
/** A caller's deadline, from its first request (design 0004, Admission). */
const DEADLINE_MS = 120_000;
/** The hang watchdog's margin past the core's deadline (design 0001). */
const WATCHDOG_MARGIN_MS = 15_000;

/** The generations a lookup's result depends on. */
const SCOPES = { ens: ['ens', 'lifecycle'], tezos: ['tezos'] };
const REPEATED = {
  ens: (subject) => `Myotis availability changed repeatedly while resolving ${subject}`,
  tezos: (subject) => `Tezos configuration changed repeatedly while resolving ${subject}`,
};
/** A pending lookup whose core process ended (deviation `core-restart`). */
const RESTARTED = 'Name resolution restarted';
/** No core process to send a lookup to. */
const UNAVAILABLE = 'Name resolution is unavailable';
/** The core's own text for its `deadline` (`overall-deadline`). */
const DEADLINE = "The resolution's deadline passed";

/** A driver's own failure, with the code the dweb handlers map. */
function failure(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRef = (value) =>
  isObject(value) && typeof value.ref === 'string' && Object.keys(value).length === 1;

/** A dweb URL's hostname, as the handlers read it; empty when it doesn't
 * parse. */
function dwebHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Today's `hostOf`: the input when it doesn't parse. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

class NamingDriver {
  /**
   * @param {object} options
   * @param {import('./core-client').CoreClient} options.client
   * @param {import('./naming-config').NamingConfig} options.config
   * @param {(name: string) => string} options.normalize - today's ENS
   *   normalization, for the subject of a "changed repeatedly" error
   * @param {() => number} [options.now] - a monotonic clock, in ms
   */
  constructor({ client, config, normalize, now = () => performance.now() }) {
    this.client = client;
    this.config = config;
    this.normalize = normalize;
    this.now = now;
  }

  resolveContent(name) {
    return this.resolve('naming.resolve_content', { name }, 'ens', () => this.ensSubject(name));
  }

  resolveAddress(name, chainId) {
    return this.resolve('naming.resolve_address', { name, chain_id: chainId }, 'ens', () =>
      this.ensSubject(name)
    );
  }

  resolveReverse(address, chainId) {
    return this.resolve('naming.resolve_reverse', { address, chain_id: chainId }, 'ens', () =>
      this.ensSubject(address)
    );
  }

  resolveTezos(name) {
    return this.resolve('naming.resolve_tezos', { name }, 'tezos', () => name.trim().toLowerCase());
  }

  /** Drops a name's cached content: whether it was there. It goes in
   * order with the core's control requests, so it follows a settings change
   * made before it, and a lookup made after it follows it; nothing without
   * a core. */
  async invalidateContent(name) {
    const reply = await this.config
      .invalidate('naming.invalidate_content', { name })
      .catch(() => undefined);
    return reply?.evicted === true;
  }

  /** Drops a Tezos name's cached result, or every Tezos cache, in the same
   * order. */
  invalidateTezos(name) {
    return this.config.invalidate('naming.invalidate_tezos', name ? { name } : {}).then(
      () => undefined,
      () => undefined
    );
  }

  /** The subject today's "changed repeatedly" error names. */
  ensSubject(name) {
    const trimmed = name.trim();
    try {
      return this.normalize(trimmed);
    } catch {
      return trimmed;
    }
  }

  /** The initialized process, waiting for one that is starting; null
   * without one, past `until`, or once `signal` aborts. */
  async process(until, signal = null) {
    if (!this.config.core) {
      try {
        await within(this.client.whenReady(), until - this.now(), signal);
      } catch {
        return null;
      }
    }
    try {
      return await within(this.config.whenServing(), until - this.now(), signal);
    } catch {
      return null;
    }
  }

  /** The process `pinned` (or, first, the current one) once no control is
   * in flight on it. A lookup belongs to the process it first went to: a
   * restart sends nothing again (design 0004, Generations). */
  async quiet(pinned, until, signal = null) {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      if (pinned && this.config.core?.gen !== pinned) throw new Error(RESTARTED);
      const gen = await this.process(until, signal);
      if (signal?.aborted) throw signal.reason;
      // Its process gone, replaced or not.
      if (pinned && gen !== pinned && (gen || !this.client.serves(pinned))) {
        throw new Error(RESTARTED);
      }
      if (!gen) throw new Error(this.now() >= until ? DEADLINE : UNAVAILABLE);
      if (this.config.idle(gen)) return gen;
    }
  }

  async resolve(method, subject, system, subjectOf) {
    const until = this.now() + DEADLINE_MS;
    let attempts = 0;
    let pinned = null;
    for (;;) {
      const left = until - this.now();
      if (left <= 0) throw new Error(DEADLINE);
      const gen = await this.quiet(pinned, until);
      pinned = gen;
      // Checked again with nothing between it and the send: a control
      // queued since goes first.
      if (!this.config.idle(gen)) continue;
      // What is left after waiting for the core: the core's deadline for
      // the request, and its watchdog's, agree.
      const remaining = Math.floor(until - this.now());
      if (remaining <= 0) throw new Error(DEADLINE);
      const params = { ...subject, private: isPrivateLogContext(), deadline_ms: remaining };
      if (attempts > 0) params.attempts_used = attempts;
      let reply = null;
      let failed = null;
      let lost = null;
      try {
        reply = await this.client.requestTo(gen, method, params, undefined, {
          watchdogMs: remaining + WATCHDOG_MARGIN_MS,
        });
      } catch (err) {
        if (err?.code === 'resolution_failed') failed = err;
        else lost = err ?? new Error('Internal error');
      }
      // Today's thrown resolution carries a message alone: the core's error
      // isn't kept on it.
      if (lost)
        throw new Error(lost?.code === 'core_unavailable' ? RESTARTED : String(lost?.message));
      const data = failed ? failed.data : reply;
      // A control asked for while the lookup ran may have overtaken it,
      // though the core hadn't seen it yet: the reply is judged once every
      // control has settled, by the generations they leave. One that left
      // this system's alone costs nothing. Checked again after every wait,
      // so the last check, the judgment and the result are one step.
      while (!this.config.idle(gen)) await this.quiet(gen, until);
      if (this.overtaken(data?.generations, system, gen)) {
        // The reply says how many attempts the caller has used: an
        // immediate one (a cache hit) used none. Only a reply that doesn't
        // say counts as one, so the loop always ends.
        attempts =
          Number.isSafeInteger(data?.attempts) && data.attempts >= attempts
            ? data.attempts
            : attempts + 1;
        if (attempts >= MAX_ATTEMPTS) throw new Error(REPEATED[system](subjectOf()));
        continue;
      }
      if (failed) {
        const message = failed.data?.message;
        throw new Error(typeof message === 'string' ? message : failed.message);
      }
      return this.published(reply, system, gen);
    }
  }

  /**
   * `dweb.open` (design 0006): the request's plan, `{ plan, generations,
   * attempts }`, fenced exactly as a lookup is (#672). It is sent and judged
   * only with no naming control in flight; an overtaken plan is planned
   * again with `attempts_used`, within the remaining deadline. A plan is
   * bound to the core process that made it: a restart plans nothing again.
   *
   * The plan's lookup is the host's: a `.tez` name's generation is Tezos',
   * any other host's ENS's and the lifecycle's. A plan made with no lookup
   * (a hash host, a redirect, an error) depends on none, so a fence that
   * finds it overtaken only plans it again.
   *
   * Every wait is in the request's lifetime: `signal` (the page's abort and
   * its session's close) ends it at once as `cancelled`, and the deadline as
   * `deadline`, whether it waits on the core, on a configuration barrier or
   * on `ready`; a request the core holds gets 0001's `cancel`.
   *
   * `ready(reply, signal)`, when given, runs once a plan is judged current
   * and before it is used: main's fetch admission, which may wait, given a
   * signal that aborts with the request's lifetime. The plan is judged again
   * after it.
   *
   * `use(reply)`, when given, is how the plan is consumed: called in the same
   * synchronous turn as the final judgment (the request is neither aborted
   * nor past its deadline, the process still serves, no control is in
   * flight, the generations are current), so nothing can come
   * between them; `open` returns what it returns. A plan that a control
   * overtook by then is planned again; one whose process has ended is
   * `core_unavailable`, and never used. Without `use`, the plan is returned.
   *
   * Failures carry a `code`: the core's (`busy`, `deadline`, `cancelled`,
   * `invalid_argument`, `forbidden`, `internal`), `core_unavailable` with no
   * core process (or a restart), and `repeated` when the generations moved
   * under every attempt.
   *
   * @param {{url: string, method: string, headers: string[][], backend: object}} params
   * @param {{signal?: AbortSignal|null,
   *   ready?: ((reply: object, signal: AbortSignal) => Promise<void>)|null,
   *   use?: ((reply: object) => any)|null}} [options]
   */
  async open(params, { signal = null, ready = null, use = null } = {}) {
    const host = dwebHost(params.url);
    const system = isTezosDomainHost(host) ? 'tezos' : 'ens';
    const subjectOf = () =>
      system === 'tezos' ? host.trim().toLowerCase() : this.ensSubject(host);
    const until = this.now() + DEADLINE_MS;
    let attempts = 0;
    let pinned = null;
    // The request's lifetime, read now: its abort and its monotonic
    // deadline. A timer only says when the deadline passed; a wait that
    // settles after it, before that timer runs, is caught here.
    // Synchronous, and the first thing every check after a wait does.
    const lifeLeft = () => {
      if (signal?.aborted) throw failure('cancelled', 'Cancelled');
      const left = until - this.now();
      if (left <= 0) throw failure('deadline', DEADLINE);
      return left;
    };
    // One wait in the request's lifetime: it settles at once as `cancelled`
    // when `signal` aborts and as `deadline` when the deadline passes, and
    // `run` gets a signal that aborts with it, for the work it starts. A
    // wait that succeeds is judged against the lifetime once more.
    const inLife = async (run) => {
      const left = lifeLeft();
      const life = new AbortController();
      const onAbort = () => life.abort(failure('cancelled', 'Cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => life.abort(failure('deadline', DEADLINE)), left);
      try {
        const result = await unlessAborted((async () => run(life.signal))(), life.signal);
        lifeLeft();
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    };
    // Whether the plan can be judged now: the request still lives, and no
    // control is in flight on its process, which still serves. Synchronous,
    // so a loop that ends on it goes straight on to the judgment and use.
    const quietNow = (gen) => {
      lifeLeft();
      if (!this.client.serves(gen) || this.config.core?.gen !== gen) {
        throw failure('core_unavailable', RESTARTED);
      }
      return this.config.idle(gen);
    };
    // The judgment, once quiet: true when the reply was overtaken, its
    // attempts counted as a lookup's are. Synchronous.
    const overtaken = (reply, gen) => {
      if (!this.overtaken(reply?.generations, system, gen)) return false;
      attempts =
        Number.isSafeInteger(reply?.attempts) && reply.attempts >= attempts
          ? reply.attempts
          : attempts + 1;
      if (attempts >= MAX_ATTEMPTS) throw failure('repeated', REPEATED[system](subjectOf()));
      return true;
    };
    for (;;) {
      const gen = await inLife((life) => this.quietFor(pinned, until, life));
      pinned = gen;
      if (!this.config.idle(gen)) continue;
      const remaining = Math.floor(until - this.now());
      if (remaining <= 0) throw failure('deadline', DEADLINE);
      const request = { ...params, private: isPrivateLogContext(), deadline_ms: remaining };
      if (attempts > 0) request.attempts_used = attempts;
      let reply;
      try {
        reply = await inLife((life) =>
          this.client.requestTo(
            gen,
            'dweb.open',
            request,
            { caller: 'shell' },
            { watchdogMs: remaining + WATCHDOG_MARGIN_MS, signal: life }
          )
        );
      } catch (err) {
        if (err?.code === 'core_unavailable') throw failure('core_unavailable', RESTARTED);
        throw err ?? failure('internal', 'Internal error');
      }
      while (!quietNow(gen)) await inLife((life) => this.quietFor(gen, until, life));
      if (overtaken(reply, gen)) continue;
      if (ready) {
        await inLife((life) => ready(reply, life));
        while (!quietNow(gen)) await inLife((life) => this.quietFor(gen, until, life));
        if (overtaken(reply, gen)) continue;
      }
      // Nothing is awaited between the last check and here: the final
      // judgment (the lifetime, the process, the controls, the generations)
      // and the plan's use are one synchronous step.
      return use ? use(reply) : reply;
    }
  }

  /** `quiet`, its failures with the codes `open` gives them. */
  async quietFor(pinned, until, signal = null) {
    try {
      return await this.quiet(pinned, until, signal);
    } catch (err) {
      // The request's own end (its abort or deadline) is already coded.
      if (err?.code) throw err;
      throw failure(err?.message === DEADLINE ? 'deadline' : 'core_unavailable', err?.message);
    }
  }

  /** Whether main has seen a newer generation, of one the result depends
   * on, than the reply was computed under. */
  overtaken(generations, system, gen) {
    if (!isObject(generations)) return false;
    // The generations of the process that answered: another's are
    // unrelated.
    const current = this.config.generationsOf(gen);
    return SCOPES[system].some(
      (scope) => Number.isSafeInteger(generations[scope]) && generations[scope] < current[scope]
    );
  }

  /** A result as today's resolvers return it, its references mapped by the
   * process that made it. */
  published(reply, system, gen) {
    const result = reply?.result;
    if (!isObject(result)) return result;
    for (const key of Array.isArray(reply.undefined_keys) ? reply.undefined_keys : []) {
      if (typeof key === 'string' && Object.hasOwn(result, key)) result[key] = undefined;
    }
    const url = (value) =>
      isRef(value) ? (this.config.endpointUrl(value.ref, gen) ?? value.ref) : value;
    const host = (value) => (isRef(value) ? hostOf(url(value)) : value);
    const map = (list, fn) => (Array.isArray(list) ? list.map(fn) : list);
    // Exactly where today's results name endpoints: a reference-shaped
    // value anywhere else (in a Tezos record, say) is data.
    const { trust } = result;
    if (isObject(trust)) {
      if (system === 'tezos') {
        // A conflict's trust has no `agreed`: none is added.
        if (Object.hasOwn(trust, 'agreed')) trust.agreed = map(trust.agreed, url);
      } else {
        for (const key of ['agreed', 'dissented', 'queried']) {
          if (Object.hasOwn(trust, key)) trust[key] = map(trust[key], host);
        }
        if (Object.hasOwn(trust, 'prover')) trust.prover = host(trust.prover);
      }
    }
    if (Array.isArray(result.groups)) {
      for (const group of result.groups) {
        if (isObject(group) && Object.hasOwn(group, 'urls')) group.urls = map(group.urls, host);
      }
    }
    return result;
  }
}

/** Settles as `promise` does, or rejects once `ms` have passed or `signal`
 * aborts; either way its timer is gone once it settles. */
function within(promise, ms, signal = null) {
  if (ms <= 0) return Promise.reject(new Error('deadline'));
  if (signal?.aborted) return Promise.reject(signal.reason);
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

module.exports = {
  NamingDriver,
  MAX_ATTEMPTS,
  DEADLINE_MS,
  WATCHDOG_MARGIN_MS,
  RESTARTED,
  UNAVAILABLE,
  hostOf,
};
