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
 */

const { isPrivateLogContext } = require('../private/private-log-context');

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

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRef = (value) =>
  isObject(value) && typeof value.ref === 'string' && Object.keys(value).length === 1;

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
   * @param {() => number} [options.now]
   */
  constructor({ client, config, normalize, now = Date.now }) {
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

  /** Drops a name's cached content: whether it was there. Sent at once,
   * so a lookup that follows goes after it; nothing without a core. */
  async invalidateContent(name) {
    const gen = this.config.servingNow();
    if (!gen) return false;
    const reply = await this.client.requestTo(gen, 'naming.invalidate_content', { name });
    return reply?.evicted === true;
  }

  /** Drops a Tezos name's cached result, or every Tezos cache. */
  invalidateTezos(name) {
    const gen = this.config.servingNow();
    if (!gen) return Promise.resolve();
    return this.client
      .requestTo(gen, 'naming.invalidate_tezos', name ? { name } : {})
      .then(() => undefined);
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

  /** The initialized process, waiting for one that is starting. */
  async process(until) {
    if (!this.config.core) {
      try {
        await within(this.client.whenReady(), until - this.now());
      } catch {
        return null;
      }
    }
    try {
      return await within(this.config.whenServing(), until - this.now());
    } catch {
      return null;
    }
  }

  async resolve(method, subject, system, subjectOf) {
    const until = this.now() + DEADLINE_MS;
    let attempts = 0;
    for (;;) {
      const left = until - this.now();
      if (left <= 0) throw new Error(DEADLINE);
      const gen = await this.process(until);
      if (!gen) throw new Error(this.now() >= until ? DEADLINE : UNAVAILABLE);
      const params = { ...subject, private: isPrivateLogContext() };
      if (attempts > 0) {
        params.attempts_used = attempts;
        params.deadline_ms = Math.max(0, Math.ceil(until - this.now()));
      }
      let reply = null;
      let failed = null;
      let lost = null;
      try {
        reply = await this.client.requestTo(gen, method, params, undefined, {
          watchdogMs: Math.max(0, until - this.now()) + WATCHDOG_MARGIN_MS,
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
      if (this.overtaken(data?.generations, system)) {
        const used = Number.isSafeInteger(data.attempts) ? data.attempts : 0;
        attempts = Math.max(attempts + 1, used);
        if (attempts >= MAX_ATTEMPTS) throw new Error(REPEATED[system](subjectOf()));
        continue;
      }
      if (failed) {
        const message = failed.data?.message;
        throw new Error(typeof message === 'string' ? message : failed.message);
      }
      return this.published(reply, system);
    }
  }

  /** Whether main has seen a newer generation, of one the result depends
   * on, than the reply was computed under. */
  overtaken(generations, system) {
    if (!isObject(generations)) return false;
    const current = this.config.generations;
    return SCOPES[system].some(
      (scope) => Number.isSafeInteger(generations[scope]) && generations[scope] < current[scope]
    );
  }

  /** A result as today's resolvers return it. */
  published(reply, system) {
    const result = reply?.result;
    if (!isObject(result)) return result;
    for (const key of Array.isArray(reply.undefined_keys) ? reply.undefined_keys : []) {
      if (typeof key === 'string' && Object.hasOwn(result, key)) result[key] = undefined;
    }
    const url = (value) =>
      isRef(value) ? (this.config.endpointUrl(value.ref) ?? value.ref) : value;
    const host = (value) => (isRef(value) ? hostOf(url(value)) : value);
    const map = (list, fn) => (Array.isArray(list) ? list.map(fn) : list);
    // Exactly where today's results name endpoints: a reference-shaped
    // value anywhere else (in a Tezos record, say) is data.
    const { trust } = result;
    if (isObject(trust)) {
      if (system === 'tezos') {
        trust.agreed = map(trust.agreed, url);
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

/** Settles as `promise` does, or rejects once `ms` have passed. */
function within(promise, ms) {
  if (ms <= 0) return Promise.reject(new Error('deadline'));
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('deadline')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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
