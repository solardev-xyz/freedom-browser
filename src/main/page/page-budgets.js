'use strict';

/**
 * Budgets and tickets for page requests (freedom-core design 0011,
 * "Bounds", "The size and the charge", "Large requests"; step PRQ-2).
 *
 * The ledger charges each admitted request's charge, and one request, to
 * its document, its window and the browser, and admits a charge only while
 * all three have room. A charge ends when page-requests.js lets the request
 * go: once it is answered and its work, which holds its payload and every
 * copy, is over.
 *
 * A request's charge is what main may hold for it at once: its size times
 * its method's copies, 128 bytes for each value and each property name, for
 * `swarm_publishFiles` 1 MiB of stream buffers, and 16 KiB for main's own
 * bookkeeping of the request.
 *
 * A request over 1 MiB (only the two Swarm uploads allow one) first reserves
 * a turn (`page:reserve`). The browser grants two at a time, from the
 * oldest waiting reservation whose largest charge fits, after checking its
 * document again. The ticket is 32 random bytes bound to that document,
 * spent once, and released when its document goes or after 30 s unused.
 */

const crypto = require('crypto');
const { PAGE_REQUEST_LIMITS, pageRequestMaxBytes } = require('../../shared/page-request-bounds');

const MiB = 1024 * 1024;

// In flight (design 0011, "The numbers", proposed).
const BUDGETS = Object.freeze({
  document: Object.freeze({ requests: 64, bytes: 128 * MiB }),
  window: Object.freeze({ requests: 256, bytes: 256 * MiB }),
  browser: Object.freeze({ requests: 1024, bytes: 384 * MiB }),
});

// Every form of a request's bytes main can hold at the same time, the IPC
// value included. `swarm_publishFiles`: the IPC value and normalizeBytes'
// copy. `swarm_publishData`: those and fetch's copy of the body. Every
// other method: the IPC value (two bytes a character), its JSON for the
// core or a node and that JSON's bytes. V8 holds the JSON of a string with
// any character past U+00FF at two bytes a character, so a control
// character takes 12 bytes there and 6 in its UTF-8: 2 + 12 + 6 = 20,
// rounded up to 24 (design 0011 says 16, from 2 + 6 + 6; PRQ-2's measured
// peaks raise it, as its "Measured, not assumed" asks).
const COPIES = Object.freeze({
  'swarm:swarm_publishFiles': 2,
  'swarm:swarm_publishData': 3,
});
const DEFAULT_COPIES = 24;
const STREAM_BYTES = Object.freeze({ 'swarm:swarm_publishFiles': MiB });
const VALUE_BYTES = 128;
// Main's own bookkeeping of every request while it holds it: the record, the
// dispatcher's context and its promises, and the IPC event the request
// keeps. The two uploads' copies are counted exactly, so without it their
// measured peaks passed their charges by a few KiB. 16 KiB left about 7 KiB
// of spare locally, and CI runs measured up to 20 KiB over it, so it is 64 KiB.
const REQUEST_BYTES = 64 * 1024;

// Large requests (design 0011, "The numbers", proposed).
const TICKETS = Object.freeze({ turns: 2, waiting: 16, unusedMs: 30_000, bytes: 32 });
const LARGE_METHODS = new Set(['swarm_publishData', 'swarm_publishFiles']);

const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined);
const copiesOf = (provider, method) => own(COPIES, `${provider}:${method}`) ?? DEFAULT_COPIES;
const streamOf = (provider, method) => own(STREAM_BYTES, `${provider}:${method}`) ?? 0;

/** The charge of a measured request (`measurePageRequest`'s answer). */
function chargeOf(provider, method, { size, values, names }) {
  return (
    size * copiesOf(provider, method) +
    VALUE_BYTES * (values + names) +
    streamOf(provider, method) +
    REQUEST_BYTES
  );
}

/**
 * The most a request of this method and size can be charged: what a ticket
 * holds. The walk's largest overhead is 10,000 values with a name each.
 */
function largestChargeOf(provider, method, bytes) {
  return chargeOf(provider, method, {
    size: bytes,
    values: PAGE_REQUEST_LIMITS.maxValues,
    names: PAGE_REQUEST_LIMITS.maxValues,
  });
}

const LIMIT_EXCEEDED = Object.freeze({ code: -32005, message: 'Limit exceeded' });
const INVALID = Object.freeze({ code: -32602, message: 'Invalid parameters' });
const limit = () => ({ error: { ...LIMIT_EXCEEDED } });

/**
 * @param {object} options
 * @param {(requester: object) => boolean} options.isCurrent the document
 *   check a waiting reservation passes again before its ticket is made.
 */
function createPageBudgets({
  budgets = BUDGETS,
  tickets: ticketBounds = TICKETS,
  isCurrent,
  randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex'),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onTrace = () => {},
} = {}) {
  const used = {
    document: new Map(),
    window: new Map(),
    browser: { requests: 0, bytes: 0 },
  };
  const levelOf = (charge, level) => {
    if (level === 'browser') return used.browser;
    const map = used[level];
    const key = charge.owner[level];
    if (!map.has(key)) map.set(key, { requests: 0, bytes: 0 });
    return map.get(key);
  };
  const LEVELS = ['document', 'window', 'browser'];

  const ownerOf = (requester) => ({ document: `${requester.guest}:${requester.navigation}`, window: requester.window });

  function fits(owner, requests, bytes) {
    return LEVELS.every((level) => {
      const usage = level === 'browser' ? used.browser : used[level].get(owner[level]) || { requests: 0, bytes: 0 };
      return usage.requests + requests <= budgets[level].requests && usage.bytes + bytes <= budgets[level].bytes;
    });
  }

  function add(charge, requests, bytes) {
    for (const level of LEVELS) {
      const usage = levelOf(charge, level);
      usage.requests += requests;
      usage.bytes += bytes;
      if (level !== 'browser' && usage.requests === 0 && usage.bytes === 0) used[level].delete(charge.owner[level]);
    }
    charge.requests += requests;
    charge.bytes += bytes;
  }

  /** Charge one request of `bytes` to the requester's document, or null when it doesn't fit. */
  function admit(requester, bytes) {
    const owner = ownerOf(requester);
    if (!fits(owner, 1, bytes)) return null;
    const charge = { owner, requests: 0, bytes: 0, released: false, turn: false };
    add(charge, 1, bytes);
    return charge;
  }

  // Grow a charge's bytes, if all three budgets have room.
  function grow(charge, bytes) {
    if (charge.released || !fits(charge.owner, 0, bytes)) return false;
    add(charge, 0, bytes);
    return true;
  }

  let turns = 0;

  /** End a charge, and free its turn if it held one. */
  function release(charge) {
    if (!charge || charge.released) return;
    charge.released = true;
    add(charge, -charge.requests, -charge.bytes);
    if (charge.turn) {
      charge.turn = false;
      turns -= 1;
    }
    // A turn, or room in the budgets, may let a waiting reservation in.
    pump();
  }

  // Reservations: one per document, waiting or holding a ticket.
  const reservations = new Map(); // document key -> entry
  const waiting = []; // entries, oldest first
  const granted = new Map(); // ticket -> entry

  function drop(entry, answer) {
    if (entry.state === 'waiting') {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
    } else if (entry.state === 'granted') {
      granted.delete(entry.ticket);
      if (entry.timer !== null) clearTimer(entry.timer);
      entry.timer = null;
    }
    entry.state = 'gone';
    if (reservations.get(entry.key) === entry) reservations.delete(entry.key);
    if (answer) entry.resolve(answer);
    release(entry.charge);
  }

  // Grant free turns, oldest fitting entry first.
  let pumping = false;
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (turns < ticketBounds.turns) {
        const entry = waiting.find((candidate) => fits(candidate.charge.owner, 0, candidate.largest));
        if (!entry) return;
        waiting.splice(waiting.indexOf(entry), 1);
        let current = false;
        try {
          current = isCurrent(entry.requester) === true;
        } catch {
          current = false;
        }
        if (!current) {
          entry.state = 'gone';
          reservations.delete(entry.key);
          onTrace({ kind: 'reservation-dropped', key: entry.key });
          entry.resolve(entry.refusal('navigated'));
          release(entry.charge);
          continue;
        }
        grow(entry.charge, entry.largest);
        entry.charge.turn = true;
        turns += 1;
        entry.state = 'granted';
        entry.ticket = randomHex(ticketBounds.bytes);
        granted.set(entry.ticket, entry);
        entry.timer = setTimer(() => {
          entry.timer = null;
          onTrace({ kind: 'ticket-unused', key: entry.key });
          drop(entry, null);
        }, ticketBounds.unusedMs);
        entry.timer?.unref?.();
        onTrace({ kind: 'ticket-granted', key: entry.key, bytes: entry.largest });
        entry.resolve({ ticket: entry.ticket });
      }
    } finally {
      pumping = false;
    }
  }

  /**
   * `page:reserve` for an attested requester. Answers `{ ticket }` when its
   * turn comes, or `{ error }`.
   */
  function reserve(requester, { method, bytes }, refusal) {
    if (!LARGE_METHODS.has(method)) return { error: { ...INVALID } };
    const max = pageRequestMaxBytes('swarm', method);
    if (!Number.isSafeInteger(bytes) || bytes <= PAGE_REQUEST_LIMITS.ticketAbove || bytes > max) {
      return { error: { ...INVALID } };
    }
    const owner = ownerOf(requester);
    if (reservations.has(owner.document)) return limit();
    if (waiting.length >= ticketBounds.waiting) return limit();
    // While it waits, it counts as one of its document's requests.
    const charge = admit(requester, 0);
    if (!charge) return limit();
    const entry = {
      key: owner.document,
      requester,
      method,
      bytes,
      largest: largestChargeOf('swarm', method, bytes),
      charge,
      state: 'waiting',
      ticket: null,
      timer: null,
      resolve: null,
      refusal,
    };
    const answer = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    reservations.set(entry.key, entry);
    waiting.push(entry);
    onTrace({ kind: 'reservation-waiting', key: entry.key });
    pump();
    return answer;
  }

  /**
   * Burn a ticket on arrival, before any other check: it is never presented
   * twice. Returns its entry, which holds its charge and turn until the
   * request takes them (`takeTicket`) or is refused (`refuseTicket`), or
   * null for a ticket main doesn't hold.
   */
  function burn(ticket) {
    const entry = typeof ticket === 'string' ? granted.get(ticket) : undefined;
    if (!entry) return null;
    granted.delete(ticket);
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
    entry.state = 'burnt';
    if (reservations.get(entry.key) === entry) reservations.delete(entry.key);
    onTrace({ kind: 'ticket-burnt', key: entry.key });
    return entry;
  }

  /** A burnt ticket's request was refused: free its charge and turn. */
  function refuseTicket(entry) {
    if (!entry) return;
    entry.state = 'gone';
    release(entry.charge);
  }

  /**
   * A burnt ticket's binding against the request that presented it: the
   * same guest, window, frame, navigation and nonce, the same method, and
   * no more bytes than reserved. On a match the request takes the ticket's
   * charge and turn, with no gap; on a mismatch both are freed.
   */
  function takeTicket(entry, requester, method, size) {
    const bound = entry.requester;
    const matches =
      bound.guest === requester.guest &&
      bound.window === requester.window &&
      bound.frame === requester.frame &&
      bound.navigation === requester.navigation &&
      bound.nonce === requester.nonce &&
      entry.method === method &&
      Number.isSafeInteger(size) &&
      size <= entry.bytes;
    if (!matches) {
      refuseTicket(entry);
      return null;
    }
    entry.state = 'spent';
    return entry.charge;
  }

  /** A document ended: its reservation, waiting or granted, goes with it. */
  function documentEnded(key, answer) {
    const entry = reservations.get(key);
    if (entry) drop(entry, answer);
  }

  function usage() {
    return {
      browser: { ...used.browser },
      windows: Object.fromEntries([...used.window].map(([key, value]) => [key, { ...value }])),
      documents: Object.fromEntries([...used.document].map(([key, value]) => [key, { ...value }])),
      turns,
      waiting: waiting.length,
      tickets: granted.size,
    };
  }

  return { admit, release, reserve, burn, takeTicket, refuseTicket, documentEnded, usage };
}

module.exports = {
  BUDGETS,
  COPIES,
  DEFAULT_COPIES,
  STREAM_BYTES,
  VALUE_BYTES,
  REQUEST_BYTES,
  TICKETS,
  chargeOf,
  largestChargeOf,
  createPageBudgets,
};
