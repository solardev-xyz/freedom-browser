/**
 * Main's executors for the naming core's I/O (freedom-core design 0004,
 * Requests the core makes and Transport): `shell.rpc`, `shell.gateway`,
 * `shell.tezos` and `shell.prefetch`. The core decides what to ask; main
 * performs each exchange through the session's network stack and answers
 * `{ status, body }` (the body in base64) or a transport error.
 *
 * Every error is a fixed code (timeout, network, refused, too_large,
 * cancelled, stale_generation): none carries a URL or a server's text.
 */

const { isIP } = require('net');
const { ShellError } = require('./core-client');
const { netGatewayFetch } = require('../ipfs/gateway-transport');
const { validateRpcUrl } = require('../networks/network-registry');
const { prefetchGatewayUrl } = require('../ens-prefetch');

// ethers' FetchRequest (6.17.0): at most 12 attempts, a 250 ms back-off
// slot, and 300 s for the exchange and for each attempt's inactivity.
const MAX_ATTEMPTS = 12;
const SLOT_INTERVAL_MS = 250;
const EXCHANGE_MS = 300_000;
/** Any answer body: 720 KiB, which is 960 KiB in base64 (response-caps). */
const ANSWER_BYTES = 720 * 1024;
const REDIRECTS = new Set([301, 302, 307, 308]);
/** The statuses `fetch` treats as redirects when they carry a Location:
 * Tezos' `fetch` follows them, the gateway's `redirect: 'error'` refuses
 * them. */
const FOLLOWED = new Set([301, 302, 303, 307, 308]);
/** Today's Tezos and gateway reads discard any other body unread. */
const isOk = (status) => status >= 200 && status < 300;

function isAbort(err) {
  return err?.name === 'AbortError';
}

/** A failed hop as a transport error: an onion name the session isn't
 * proxying is refused (never dialled); anything else is the network. */
function hopError(err) {
  if (err instanceof ShellError) return err;
  const message = String(err?.message || '');
  if (message.includes('.onion gateway')) return new ShellError('refused');
  return new ShellError('network');
}

/** An abortable wait. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Hops abandoned while their fetch hadn't returned (a proxy lookup
 * that ignores the abort): past this many, new hops fail at once. */
const MAX_ABANDONED = 64;

/** Settles as `promise` does, or rejects with the abort as `signal`
 * aborts first. */
function unlessAborted(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    // Observed whichever wins, so a rejection that comes after the abort is
    // never left unhandled.
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One HTTP exchange through the session's network stack (`netGatewayFetch`:
 * its proxy policy and onion gate, no cookies, credentials or cache, and no
 * redirect taken). `read(status)` says whether the body is wanted: one that
 * isn't, as the references discard it, is cancelled unread and answered
 * empty. A body is read up to `max` bytes (a larger declared length is
 * refused unread); `inactivityMs` of silence ends the attempt as `timeout`.
 * Every wait settles as the request is cancelled or times out, even one the
 * transport can't abort (its proxy lookup): that work is abandoned, its late
 * response discarded, and bounded.
 *
 * @returns {Promise<{status: number, headers: object, body: Buffer}>}
 */
function makeHop({ fetch = netGatewayFetch, inactivityMs = EXCHANGE_MS } = {}) {
  let abandoned = 0;
  const hop = async (
    url,
    { method = 'GET', headers, body, signal, max = ANSWER_BYTES, read = () => true }
  ) => {
    if (abandoned >= MAX_ABANDONED) throw new ShellError('network');
    const idle = new AbortController();
    let timer = null;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), inactivityMs);
    };
    const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    const failed = (err) => {
      if (idle.signal.aborted) return new ShellError('timeout');
      if (signal?.aborted || isAbort(err)) return err;
      return hopError(err);
    };
    touch();
    try {
      const fetching = Promise.resolve().then(() =>
        fetch(url, { method, headers, body, signal: combined, redirect: 'manual' })
      );
      let response;
      try {
        response = await unlessAborted(fetching, combined);
      } catch (err) {
        if (combined.aborted) {
          // The transport may still be waiting (its proxy lookup ignores
          // the abort): count it until it settles, and discard what it
          // brings.
          abandoned += 1;
          fetching
            .then(
              (late) => late?.body?.cancel().catch(() => {}),
              () => {}
            )
            .finally(() => {
              abandoned -= 1;
            });
        }
        throw failed(err);
      }
      touch();
      const responseHeaders = {};
      for (const [name, value] of response.headers) responseHeaders[name.toLowerCase()] = value;
      const discard = () => response.body?.cancel().catch(() => {});
      if (!read(response.status)) {
        discard();
        return { status: response.status, headers: responseHeaders, body: Buffer.alloc(0) };
      }
      if (Number(responseHeaders['content-length']) > max) {
        discard();
        throw new ShellError('too_large');
      }
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            // Once cancelled, no further read starts.
            if (combined.aborted) throw combined.reason;
            const next = await unlessAborted(reader.read(), combined);
            if (next.done) break;
            touch();
            size += next.value.byteLength;
            if (size > max) {
              reader.cancel().catch(() => {});
              throw new ShellError('too_large');
            }
            chunks.push(next.value);
          }
        } catch (err) {
          if (combined.aborted) reader.cancel().catch(() => {});
          throw failed(err);
        }
      }
      return { status: response.status, headers: responseHeaders, body: Buffer.concat(chunks) };
    } finally {
      clearTimeout(timer);
    }
  };
  hop.abandoned = () => abandoned;
  return hop;
}

/**
 * One `shell.rpc` exchange: ethers' `FetchRequest.#send` (6.17.0), run by
 * main so that every hop goes through the session's network stack. The
 * loop, as ethers runs it: up to 12 attempts (then a 599 with the last
 * answer's body); 301/302/307/308 followed at once with the method and body
 * kept, unless the target isn't an absolute http(s) URL or would downgrade
 * https to http, when the 3xx itself is the answer; a 429 retried after
 * `250 × trunc(r × 2^attempt)` ms, or a positive integer Retry-After read as
 * milliseconds; the exchange's 300 s checked before each attempt's wait.
 *
 * Main adds one rule (deviation `rpc-redirects`): a hop the endpoint policy
 * refuses ends the exchange as `refused`.
 *
 * @param {string} url
 * @param {string} body - the JSON-RPC request
 * @param {object} deps - { hop, allowed, signal, now, random, wait }
 */
async function fetchLoop(url, body, deps) {
  const { hop, allowed, signal, now = Date.now, random = Math.random, wait = sleep } = deps;
  const expires = now() + EXCHANGE_MS;
  let last = { status: 0, headers: {}, body: Buffer.alloc(0) };
  let delay = 0;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt >= MAX_ATTEMPTS) return { ...last, status: 599 };
    if (now() > expires) throw new ShellError('timeout');
    if (delay > 0) await wait(delay, signal);
    if (signal?.aborted) throw signal.reason;
    const response = await hop(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    });
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.location || '';
      const current = url.split(':')[0].toLowerCase();
      const target = location.split(':')[0].toLowerCase();
      if ((current === 'https' && target === 'http') || !/^https?:/.test(location)) return response;
      if (!allowed(location)) throw new ShellError('refused');
      url = location;
      delay = 0;
      last = response;
      continue;
    }
    if (response.status === 429) {
      const retryAfter = response.headers['retry-after'];
      delay = SLOT_INTERVAL_MS * Math.trunc(random() * 2 ** attempt);
      if (typeof retryAfter === 'string' && /^[1-9][0-9]*$/.test(retryAfter)) {
        delay = parseInt(retryAfter, 10);
      }
      last = response;
      continue;
    }
    return response;
  }
}

/**
 * Runs `fn` until the request's deadline (`deadline_ms`, what is left of its
 * session's) or the core's cancel: past the deadline it is `timeout`.
 */
async function withDeadline(params, signal, fn) {
  const ms =
    Number.isSafeInteger(params.deadline_ms) && params.deadline_ms >= 0
      ? params.deadline_ms
      : EXCHANGE_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ms);
  try {
    return await fn(AbortSignal.any([signal, deadline.signal]));
  } catch (err) {
    if (deadline.signal.aborted && !signal.aborted) throw new ShellError('timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A gateway URL main will dial: ccipReadFetch's own policy. */
function gatewayAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  return !(
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    isIP(host) ||
    !host.includes('.') ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

function answer({ status, body }) {
  return { status, body: body.toString('base64') };
}

/**
 * Registers the executors on `client`.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {import('./naming-config').NamingConfig} config - references and
 *   the current generations
 * @param {object} [deps] - test seams: hop, prefetch, now, random, wait
 */
function registerNamingShell(client, config, deps = {}) {
  const hop = deps.hop || makeHop();
  const prefetch = deps.prefetch || prefetchGatewayUrl;
  // Prefetches replied to while their own work (a proxy lookup) hadn't
  // ended: past MAX_ABANDONED, a new one is skipped, as it's only a warm-up.
  let abandonedPrefetches = 0;
  // A request made under an older generation than main's is refused before
  // anything is done (one main hasn't seen yet is newer, never stale).
  const stale = (params, scope) => {
    const generation = params.generations?.[scope];
    if (!Number.isSafeInteger(generation) || generation < config.generations[scope]) {
      throw new ShellError('stale_generation');
    }
  };
  const endpoint = (ref) => {
    const url = config.endpointUrl(ref);
    if (!url) throw new ShellError('refused');
    return url;
  };

  client.handle('shell.rpc', (params, { signal }) => {
    stale(params, 'ens');
    const url = endpoint(params.endpoint);
    // Every hop meets the endpoint policy, the first one too.
    if (validateRpcUrl(url) !== null) throw new ShellError('refused');
    if (typeof params.body !== 'string') throw new ShellError('refused');
    return withDeadline(params, signal, (within) =>
      fetchLoop(url, params.body, {
        hop,
        signal: within,
        allowed: (location) => validateRpcUrl(location) === null,
        now: deps.now,
        random: deps.random,
        wait: deps.wait,
      })
    ).then(answer);
  });

  // Today's `fetch`, without its redirects (deviation `tezos-redirects`) and
  // without a 429 retry.
  client.handle('shell.tezos', (params, { signal }) => {
    stale(params, 'tezos');
    const base = endpoint(params.endpoint);
    if (typeof params.path !== 'string') throw new ShellError('refused');
    const post = params.method === 'POST';
    const body = typeof params.body === 'string' ? params.body : undefined;
    return withDeadline(params, signal, async (within) => {
      const response = await hop(`${base}${params.path}`, {
        method: post ? 'POST' : 'GET',
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body,
        signal: within,
        read: isOk,
      });
      if (FOLLOWED.has(response.status) && response.headers.location)
        throw new ShellError('refused');
      return answer(response);
    });
  });

  // ccipReadFetch's request, its URL policy and `redirect: 'error'`.
  client.handle('shell.gateway', (params, { signal }) => {
    stale(params, 'ens');
    if (typeof params.url !== 'string' || !gatewayAllowed(params.url))
      throw new ShellError('refused');
    const post = params.method === 'POST';
    if (post && typeof params.body !== 'string') throw new ShellError('refused');
    return withDeadline(params, signal, async (within) => {
      const response = await hop(params.url, {
        method: post ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          ...(post ? { 'Content-Type': 'application/json' } : {}),
        },
        body: post ? params.body : undefined,
        signal: within,
        read: isOk,
      });
      if (FOLLOWED.has(response.status) && response.headers.location) {
        throw new ShellError('refused');
      }
      return answer(response);
    });
  });

  // prefetchGatewayUrl, whole: {} when it ends (finished, failed, its own
  // 10 s timer, or cancelled).
  client.handle('shell.prefetch', async (params, { signal }) => {
    stale(params, 'ens');
    // Cancelled before it started: it never does.
    if (signal.aborted || abandonedPrefetches >= MAX_ABANDONED) return {};
    const handle = prefetch(params.uri);
    const done = Promise.resolve(handle.done);
    let ended = false;
    done.then(
      () => (ended = true),
      () => (ended = true)
    );
    try {
      // Its own wait (a proxy lookup) may not end with the abort: the reply
      // doesn't wait for it, and the work counts until it does end.
      await withDeadline(params, signal, async (within) => {
        const onAbort = () => handle.abort();
        within.addEventListener('abort', onAbort, { once: true });
        try {
          return await unlessAborted(done, within);
        } finally {
          within.removeEventListener('abort', onAbort);
        }
      });
    } catch {
      // Cancelled, or past its deadline: ended all the same.
      if (!ended) {
        abandonedPrefetches += 1;
        const release = () => {
          abandonedPrefetches -= 1;
        };
        done.then(release, release);
      }
    }
    return {};
  });
}

module.exports = {
  registerNamingShell,
  withDeadline,
  unlessAborted,
  MAX_ABANDONED,
  fetchLoop,
  makeHop,
  gatewayAllowed,
  MAX_ATTEMPTS,
  SLOT_INTERVAL_MS,
  ANSWER_BYTES,
};
