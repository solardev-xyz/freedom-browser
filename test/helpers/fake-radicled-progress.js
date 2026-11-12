/**
 * A clone's progress as freedom-radicled writes it (freedom-core design
 * 0008, "Progress"), for main's tests: the per-clone queue and the hub that
 * writes it to a fake service's stdout (fake-radicled.js), one event at a
 * time, each only once the last one is written.
 *
 * **The queue** (`ProgressQueue`), as the service's `network::progress`:
 * - `resolving`, `connecting` and `fetching`: only the latest unwritten one
 *   is kept;
 * - `peer-failed`: up to 8 unwritten events are kept as they are. A failure
 *   past them starts one summary event, `{"phase":"peer-failed","summary":
 *   {"count":N,"reasons":[…]}}`, and every failure while it waits folds into
 *   it: its count grows, and it keeps the 4 most recent reasons. Once it is
 *   written, a failure is kept as it is again while fewer than 8 wait;
 * - the terminal event (`done`, `failed` or `cancelled`) has a slot of its
 *   own, and is written after everything queued before it;
 * - the others are written in the order they were last queued: a phase
 *   event that replaces the latest, and a summary a failure folds into,
 *   take their place as of then.
 *
 * The service also cuts an event over 4 KiB (its reasons first); this model
 * doesn't, and refuses one (the tests that use it keep their reasons
 * short). freedom-core's `radicle-network.json` `queue` cases hold it to
 * the service's envelopes, byte for byte, where no cut is made
 * (radicle-vectors.test.js).
 *
 * **The hub** (`ProgressHub`): the service's connection holds at most one
 * event waiting for its writer, so the next event is handed over only once
 * the last is written. Here that is `stdout.write`'s callback: on a stdout
 * whose reader has paused (a small high-water mark, and main not reading),
 * it doesn't come, and what libradicle emits meanwhile waits in the queue,
 * under its bounds. `flush()` resolves once everything queued, the terminal
 * last, has been handed to stdout, after which the clone's answer may go.
 */

const { encodeFrame } = require('../../src/main/core/frame');

/** The most bytes an event's envelope takes, encoded. */
const MAX_ENVELOPE = 4096;
/** The unwritten peer failures a clone keeps as they are. */
const FAILURES = 8;
/** The reasons a summary keeps: the most recent. */
const REASONS = 4;

const PHASES = new Set(['resolving', 'connecting', 'fetching']);
const TERMINALS = new Set(['done', 'failed', 'cancelled']);

/** libradicle's JSON text of a progress event (`json::progress`): its
 * fields in libradicle's order, the phase last. */
function progressText(event) {
  const { phase } = event;
  switch (phase) {
    case 'resolving':
      return JSON.stringify({ candidates: event.candidates, phase });
    case 'connecting':
      return JSON.stringify({
        nid: event.nid,
        addr: event.addr,
        index: event.index,
        total: event.total,
        phase,
      });
    case 'fetching':
      return JSON.stringify({ nid: event.nid, index: event.index, total: event.total, phase });
    case 'peer-failed':
      return JSON.stringify({
        nid: event.nid,
        index: event.index,
        total: event.total,
        reason: event.reason,
        phase,
      });
    case 'failed':
      return JSON.stringify({ reason: event.reason, phase });
    case 'done':
    case 'cancelled':
      return JSON.stringify({ phase });
    default:
      throw new Error(`no progress phase ${phase}`);
  }
}

/** A summary's text. */
function summaryText(count, reasons) {
  return JSON.stringify({ phase: 'peer-failed', summary: { count, reasons } });
}

/** The envelope the connection writes for event `text` about request `id`. */
function envelope(id, text) {
  return JSON.stringify({ type: 'event', event: 'rad.progress', data: { id, event: text } });
}

class ProgressQueue {
  constructor(id) {
    this.id = id;
    // Unwritten, oldest first: { kind: 'phase'|'failure', text } or
    // { kind: 'summary', count, reasons }.
    this.items = [];
    this.terminal = null;
  }

  /** Folds libradicle's `event` in. */
  push(event) {
    const { phase } = event;
    if (TERMINALS.has(phase)) {
      this.terminal = this.fit(progressText(event));
      return;
    }
    if (PHASES.has(phase)) {
      this.items = this.items.filter((item) => item.kind !== 'phase');
      this.items.push({ kind: 'phase', text: this.fit(progressText(event)) });
      return;
    }
    if (phase !== 'peer-failed') throw new Error(`no progress phase ${phase}`);
    const summary = this.items.find((item) => item.kind === 'summary');
    if (summary) {
      summary.count += 1;
      summary.reasons = [...summary.reasons, event.reason].slice(-REASONS);
      this.fit(summaryText(summary.count, summary.reasons));
      this.items = [...this.items.filter((item) => item !== summary), summary];
      return;
    }
    if (this.items.filter((item) => item.kind === 'failure').length < FAILURES) {
      this.items.push({ kind: 'failure', text: this.fit(progressText(event)) });
      return;
    }
    const folded = { kind: 'summary', count: 1, reasons: [event.reason] };
    this.fit(summaryText(folded.count, folded.reasons));
    this.items.push(folded);
  }

  /** The next event's text the writer takes, or null: the oldest, and the
   * terminal after everything queued before it. */
  take() {
    const item = this.items.shift();
    if (item) return item.kind === 'summary' ? summaryText(item.count, item.reasons) : item.text;
    const terminal = this.terminal;
    this.terminal = null;
    return terminal;
  }

  /** Whether nothing is left to write. */
  get empty() {
    return this.items.length === 0 && this.terminal === null;
  }

  /** `text`, whose envelope must fit 4 KiB: this model doesn't cut. */
  fit(text) {
    if (Buffer.byteLength(envelope(this.id, text)) > MAX_ENVELOPE) {
      throw new Error('this model of the progress queue cuts no event: keep reasons short');
    }
    return text;
  }
}

class ProgressHub {
  /** The progress of `child`'s request `id`. */
  constructor(child, id) {
    this.child = child;
    this.id = id;
    this.queue = new ProgressQueue(id);
    this.writing = false;
    // Every envelope handed to stdout, in order.
    this.written = [];
    this.flushed = [];
  }

  /** libradicle's callback: folds `event` in and returns at once. */
  push(event) {
    this.queue.push(event);
    this.pump();
  }

  pump() {
    if (this.writing || this.child.exited) return;
    const text = this.queue.take();
    if (text === null) {
      for (const resolve of this.flushed.splice(0)) resolve();
      return;
    }
    this.written.push(envelope(this.id, text));
    this.writing = true;
    this.child.stdout.write(
      encodeFrame({ type: 'event', event: 'rad.progress', data: { id: this.id, event: text } }),
      () => {
        this.writing = false;
        this.pump();
      }
    );
    if (this.queue.empty) for (const resolve of this.flushed.splice(0)) resolve();
  }

  /** Resolves once everything queued has been handed to stdout. */
  flush() {
    if (this.queue.empty) return Promise.resolve();
    return new Promise((resolve) => this.flushed.push(resolve));
  }
}

module.exports = {
  ProgressQueue,
  ProgressHub,
  progressText,
  summaryText,
  envelope,
  MAX_ENVELOPE,
  FAILURES,
  REASONS,
};
