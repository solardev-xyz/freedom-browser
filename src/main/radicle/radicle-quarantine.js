/**
 * Radicle's repair as main shows it (freedom-core design 0008, "The
 * deadline" and "The escape", Main's view; the radicled step-5 plan's B13),
 * under `FREEDOM_RADICLE_BACKEND=service` only. radicle-manager.js feeds it
 * the service node and hands its snapshot to the chrome.
 *
 * - **The snapshot** is `{ repairing, count, entries }`:
 *   - `repairing`: the node's start ended on `rad.reconcile`'s `deadline`,
 *     "Radicle is still repairing its data". The chrome offers Retry, the
 *     manager's start, which spawns a fresh process that continues from the
 *     checkpoints. There is no automatic restart;
 *   - `entries`: the quarantined repositories, each `{ rid, qid, kind,
 *     step, unit, name }`, in the order of their IDs: "Radicle couldn't
 *     repair <name>", with the kind, the step and Remove. `name` is the
 *     repository's own, from the node's listing, or null (the chrome shows
 *     the ID). Names are the repositories' data: untrusted;
 *   - `count`: how many the record holds, at least `entries.length`.
 * - **The entries** come from the running generation (radicled-node.js):
 *   - its `rad.reconcile` report when that holds them all: up to 16, with
 *     the count the stats give still the report's;
 *   - otherwise `rad.quarantine_list`, paged from 0, 64 entries a page,
 *     each page's `next_page` the next number, until it is null. Main holds
 *     at most MAX_PAGES pages; past them, `count` says how many more there
 *     are;
 *   - again whenever the stats' count changes, and after every removal.
 *   A listing that fails keeps what main showed (a generation's first, the
 *   report's entries), and logs only the error's code.
 * - **Remove** is bound to what main showed. The chrome passes back the
 *   entry's `rid` and `qid`, and main sends `rad.remove_repo { rid, qid }`
 *   only if its last snapshot showed that `rid` with that `qid`; anything
 *   else is refused before anything is sent (`QUARANTINE_NOT_SHOWN`). So
 *   the chrome can't name another record, and a removal never reaches a
 *   repository quarantined again under a new `qid` (0008: the service's own
 *   precondition says the same). Whatever the answer, main lists the
 *   quarantine again: `not_quarantined` among them, as 0008 says, and a
 *   removal whose outcome it can't know (`outcome_unknown`).
 * - **Nothing is shown under the add-on,** nor once the node has stopped.
 */

const { success, failure } = require('../ipc-contract');
const { isObject } = require('../core/service-client');

/** Entries a page of `rad.quarantine_list` holds (0008, Bounds). */
const PAGE_ENTRIES = 64;
/** The pages main lists: 64 pages, 4,096 entries. */
const MAX_PAGES = 64;
/** The longest name main keeps, in UTF-16 code units. */
const NAME_MAX = 256;

const RID_PATTERN = /^rad:z[1-9A-HJ-NP-Za-km-z]{20,60}$/;
const QID_PATTERN = /^[0-9a-f]{32}$/;
const TEXT_MAX = 128;

const NOT_SHOWN_MESSAGE = "That repository isn't one Freedom showed Radicle couldn't repair";
const NOT_RUNNING_MESSAGE = 'Radicle node is not running';
const NOT_QUARANTINED_MESSAGE = "It isn't quarantined any more, so nothing was removed";
const REMOVE_UNKNOWN_MESSAGE = 'Radicle stopped before confirming the removal';
const REMOVE_FAILED_MESSAGE = "Radicle couldn't remove it";

const EMPTY = Object.freeze({ repairing: false, count: 0, entries: Object.freeze([]) });

/** A short text field, or null. */
function text(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= TEXT_MAX ? value : null;
}

/**
 * A quarantine entry as the service writes it (0008, Methods: `{ rid, qid,
 * kind, step, unit, since }`), checked, or null. Main keeps what the chrome
 * shows and Remove needs.
 */
function checkEntry(raw) {
  if (!isObject(raw)) return null;
  const { rid, qid } = raw;
  if (typeof rid !== 'string' || !RID_PATTERN.test(rid)) return null;
  if (typeof qid !== 'string' || !QID_PATTERN.test(qid)) return null;
  const kind = text(raw.kind);
  const step = text(raw.step);
  if (!kind || !step) return null;
  return { rid, qid, kind, step, unit: text(raw.unit) };
}

/** `raws` checked: the entries, and how many there were. */
function checkEntries(raws) {
  const entries = [];
  for (const raw of raws) {
    const entry = checkEntry(raw);
    if (entry) entries.push(entry);
  }
  return { entries, seen: raws.length };
}

function invalidReply(why) {
  return Object.assign(new Error(`rad.quarantine_list answered ${why}`), {
    code: 'invalid_reply',
  });
}

/**
 * Every page of `node`'s quarantine record, from page 0 (0008, Methods
 * `rad.quarantine_list`): `{ entries, seen, complete }`, `complete` false
 * when `maxPages` pages ran out first. Each page holds at most 64 entries,
 * and names the next page's number, or null after the last; anything else
 * is an invalid reply, and the listing fails.
 */
async function listQuarantine(node, { maxPages = MAX_PAGES } = {}) {
  const entries = [];
  let seen = 0;
  let page = 0;
  for (let pages = 0; pages < maxPages; pages += 1) {
    const reply = await node.quarantineList(page);
    if (!isObject(reply) || !Array.isArray(reply.entries)) throw invalidReply('without entries');
    if (reply.entries.length > PAGE_ENTRIES) throw invalidReply('a page over 64 entries');
    const checked = checkEntries(reply.entries);
    entries.push(...checked.entries);
    seen += checked.seen;
    if (reply.next_page === null) return { entries, seen, complete: true };
    if (reply.next_page !== page + 1) throw invalidReply('a next page out of order');
    page = reply.next_page;
  }
  return { entries, seen, complete: false };
}

class QuarantineView {
  /**
   * @param {object} options
   * @param {Function} options.broadcast - (snapshot) to every chrome window
   * @param {Function} [options.readNames] - async (rids) => Map of rid to
   *   the repository's name, for those it lists
   * @param {object} options.log
   * @param {number} [options.maxPages]
   */
  constructor({ broadcast, readNames = async () => new Map(), log, maxPages = MAX_PAGES }) {
    this.broadcastSnapshot = broadcast;
    this.readNames = readNames;
    this.log = log;
    this.maxPages = maxPages;
    this.repairing = false;
    // The node whose quarantine is shown, and its generation.
    this.node = null;
    this.generation = null;
    // Whether the generation's report may stand in for a listing: only at
    // its first.
    this.reportUsable = false;
    this.count = 0;
    this.entries = [];
    // What the last snapshot showed: rid -> qid. Remove is bound to it.
    this.shown = new Map();
    this.last = JSON.stringify(EMPTY);
    this.listing = null;
    this.again = false;
  }

  /** What the chrome shows: a copy. */
  snapshot() {
    return {
      repairing: this.repairing,
      count: Math.max(this.count, this.entries.length),
      entries: this.entries.map((entry) => ({ ...entry })),
    };
  }

  /** Sends the snapshot, if it changed, and binds Remove to it. */
  publish() {
    const snapshot = this.snapshot();
    this.shown = new Map(snapshot.entries.map((entry) => [entry.rid, entry.qid]));
    const json = JSON.stringify(snapshot);
    if (json === this.last) return;
    this.last = json;
    try {
      this.broadcastSnapshot(snapshot);
    } catch (err) {
      this.log.warn('[Radicle] Could not send the repair state:', err.message);
    }
  }

  /** A start began: nothing is being repaired, or shown, until it runs. */
  starting() {
    this.repairing = false;
    this.forget();
    this.publish();
  }

  /** The node stopped or gave up; `repairing` when its start ended on
   * `rad.reconcile`'s `deadline`. */
  stopped({ repairing = false } = {}) {
    this.repairing = Boolean(repairing);
    this.forget();
    this.publish();
  }

  forget() {
    this.node = null;
    this.generation = null;
    this.reportUsable = false;
    this.count = 0;
    this.entries = [];
  }

  /** `node` runs a generation: the first or a crash's restart. Its
   * quarantine replaces what was shown. */
  running(node) {
    if (this.node === node && this.generation === node.generation) return this.listing;
    this.node = node;
    this.generation = node.generation;
    this.reportUsable = true;
    this.repairing = false;
    return this.refresh();
  }

  /** The stats' count changed on `node`. */
  changed(node) {
    if (node !== this.node || node.generation !== this.generation) return null;
    return this.refresh();
  }

  /** Lists the quarantine again; one listing at a time, and one more after
   * it if asked for meanwhile. */
  refresh() {
    if (this.listing) {
      this.again = true;
      return this.listing;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          await this.listOnce();
        } while (this.again && this.node);
      } finally {
        if (this.listing === run) this.listing = null;
      }
    })();
    this.listing = run;
    return run;
  }

  current(node, generation) {
    return this.node === node && this.generation === generation && node.generation === generation;
  }

  async listOnce() {
    const { node, generation } = this;
    if (!node) return;
    const useReport = this.reportUsable;
    this.reportUsable = false;
    let report = null;
    let count = null;
    try {
      report = node.quarantineReport();
      count = node.quarantinedCount();
    } catch (err) {
      this.log.warn('[Radicle] Could not read the quarantine report:', err.message);
    }
    let entries;
    let total;
    if (count === 0) {
      entries = [];
      total = 0;
    } else if (
      useReport &&
      report &&
      report.count === count &&
      report.first.length === report.count
    ) {
      // The report holds them all (0008: its first 16).
      ({ entries, seen: total } = checkEntries(report.first));
    } else {
      try {
        const listed = await listQuarantine(node, { maxPages: this.maxPages });
        entries = listed.entries;
        total = listed.complete ? listed.seen : Math.max(count ?? 0, listed.seen);
      } catch (err) {
        if (!this.current(node, generation)) return;
        this.log.warn('[Radicle] Could not list the quarantined repositories', {
          code: typeof err?.code === 'string' ? err.code : 'error',
        });
        // What main showed stays; a generation's first, the report's.
        if (!useReport || !report) return;
        ({ entries } = checkEntries(report.first));
        total = Math.max(count ?? report.count, report.count);
      }
    }
    if (!this.current(node, generation)) return;
    const names = entries.length > 0 ? await this.names(entries) : new Map();
    if (!this.current(node, generation)) return;
    this.entries = entries.map((entry) => ({ ...entry, name: names.get(entry.rid) ?? null }));
    this.count = total;
    this.publish();
  }

  /** The repositories' names, from the node's listing: rid -> name. None
   * when it fails (the chrome shows the IDs). */
  async names(entries) {
    try {
      const names = await this.readNames(entries.map((entry) => entry.rid));
      const kept = new Map();
      if (!(names instanceof Map)) return kept;
      for (const [rid, name] of names) {
        if (typeof name === 'string' && name.trim()) kept.set(rid, name.slice(0, NAME_MAX));
      }
      return kept;
    } catch (err) {
      this.log.warn("[Radicle] Could not read the quarantined repositories' names", {
        code: typeof err?.code === 'string' ? err.code : 'error',
      });
      return new Map();
    }
  }

  /**
   * Remove (0008, "The escape"): `rad.remove_repo { rid, qid }` for the
   * entry the chrome showed, with its `qid`, on the generation running now.
   * The IPC contract's answer: `{ success: true, removed: true }`, or a
   * failure whose message the chrome shows.
   */
  async remove(rid, qid) {
    if (typeof rid !== 'string' || typeof qid !== 'string' || this.shown.get(rid) !== qid) {
      return failure('QUARANTINE_NOT_SHOWN', NOT_SHOWN_MESSAGE);
    }
    const node = this.node;
    const target = node?.writeTarget();
    if (!target) return failure('RADICLE_NOT_RUNNING', NOT_RUNNING_MESSAGE);
    try {
      const result = await node.removeRepo(target, rid, qid);
      if (result?.removed === true) return success({ removed: true });
      this.log.warn('[Radicle] rad.remove_repo answered without removed: true');
      return failure('OUTCOME_UNKNOWN', REMOVE_UNKNOWN_MESSAGE);
    } catch (err) {
      switch (err?.code) {
        case 'not_quarantined':
          return failure('NOT_QUARANTINED', NOT_QUARANTINED_MESSAGE);
        case 'outcome_unknown':
          return failure('OUTCOME_UNKNOWN', REMOVE_UNKNOWN_MESSAGE);
        case 'stopped':
          return failure('RADICLE_NOT_RUNNING', NOT_RUNNING_MESSAGE);
        default:
          return failure(
            'REMOVE_FAILED',
            typeof err?.message === 'string' && err.message ? err.message : REMOVE_FAILED_MESSAGE
          );
      }
    } finally {
      // Whatever the answer, the quarantine is listed again.
      if (node === this.node) void this.refresh();
    }
  }
}

module.exports = {
  QuarantineView,
  listQuarantine,
  checkEntry,
  PAGE_ENTRIES,
  MAX_PAGES,
  NAME_MAX,
  NOT_SHOWN_MESSAGE,
  NOT_QUARANTINED_MESSAGE,
  REMOVE_UNKNOWN_MESSAGE,
  EMPTY,
};
