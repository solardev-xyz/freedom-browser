/**
 * The step marker's state for one freedom-colibrid process (freedom-core
 * design 0014, "The step marker", "Cancel and deadlines" and "Crashes,
 * overruns and restarts"): which of main's requests are open, which one's
 * call into the C core is running, and, once the process has died, which
 * request that death names. One `ColibriMarkers` serves one process
 * generation (colibrid-client.js makes one at each handshake).
 *
 * - **Open requests:** a `colibri.request` or `colibri.checkpoint` is open
 *   from the moment it is written (`open`, from ServiceClient's `onSent`)
 *   until its reply (`close`) or the process's death (`die`). Each is the
 *   operation `shell.colibri_fetch` admits fetches for (`operation`).
 * - **The markers:** `colibri.step { request }` opens a step for an open
 *   request; `colibri.stepped { request }` closes it. A step for a request
 *   that isn't open (unknown, or ended), a step while another is open, a
 *   `stepped` that doesn't name the open step's request, a marker whose
 *   data isn't one, and a reply that arrives while its own step is open
 *   (the service queues `stepped` before any frame its step caused) are
 *   protocol errors: the process is abandoned (`marker`), and its death
 *   names nobody. Such a reply is refused (`closed` says so): it is never
 *   its request's outcome, and the request is one more bystander of the
 *   death (`afterDeath`). From then on its markers are ignored: a killed
 *   process still writes until its pipe closes, and nothing it writes is
 *   trusted.
 * - **Overruns:** 2 s past a request's deadline, a step of that request
 *   still open kills the process (`overrun`), and names that request. A
 *   step opened later than that (a context freed after main's cancel) has
 *   2 s of its own (open question 4).
 * - **A death** (`die`), recorded synchronously as the process retires,
 *   before any outcome is built: an abandon's own culprit (none for a
 *   marker, the overrunning request for an overrun); otherwise the open
 *   step's request, for a process that died on its own or whose pipe broke
 *   (`transport`); nobody for any other end (main's stop, a protocol error
 *   ServiceClient found, a hang). The record is frozen: a second call
 *   returns it, and those waiting for it (`afterDeath`) get it then.
 *
 * Nothing here sends anything: the owner gives `abandon(cause)`, which ends
 * the process (ServiceClient's `abandon`), and builds the outcomes.
 */

/** How long past its request's deadline a step may run (design 0014, Cancel
 * and deadlines: twice the longest native step, rounded up). */
const OVERRUN_MS = 2_000;

const STEP = 'colibri.step';
const STEPPED = 'colibri.stepped';

/** What ends a process whose open step it names: its own death, or its pipe
 * breaking, which a death causes as often as its exit does. */
const NAMING_CAUSES = new Set([null, 'transport']);

/** Why a process died, as the culprit's and bystanders' errors carry it
 * (`Colibri worker replaced: <reason>`): fixed texts, none matching the
 * resolver's retry pattern. */
const DEATH_REASONS = Object.freeze({
  overrun: 'verification still running after its deadline',
  marker: 'step marker out of order',
  protocol: 'protocol error',
  transport: 'service connection failed',
  shutdown: 'service stopped',
  hang: 'request hung',
});

/** The reason for a death with exit `code` or `signal` and `cause`. */
function deathReason({ code = null, signal = null, cause = null } = {}) {
  if (cause === null) return `service exited (${code ?? signal})`;
  return Object.hasOwn(DEATH_REASONS, cause)
    ? DEATH_REASONS[cause]
    : `service abandoned (${cause})`;
}

/** A death's record (`die`): frozen, with its reason. */
function deathRecord({
  generation = null,
  code = null,
  signal = null,
  cause = null,
  culprit = null,
}) {
  return Object.freeze({
    generation,
    code,
    signal,
    cause,
    culprit,
    reason: deathReason({ code, signal, cause }),
  });
}

/** The request a marker names, or null if its data isn't one's. */
function markedRequest(data) {
  const request = data?.request;
  return Number.isSafeInteger(request) && request > 0 ? request : null;
}

class ColibriMarkers {
  /**
   * @param {object} options
   * @param {number} options.generation - the process's (ServiceClient's)
   * @param {(cause: string) => boolean} options.abandon - ends the process
   *   with `cause` (`marker` or `overrun`); whether it did
   * @param {Function} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   * @param {object} [options.log]
   * @param {string} [options.label] - the log lines' prefix
   */
  constructor({
    generation,
    abandon,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = console,
    label = '[colibrid]',
  }) {
    if (typeof abandon !== 'function') throw new TypeError('Markers need an abandon');
    this.generation = generation;
    this.abandonProcess = abandon;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    this.label = label;
    // Open requests by main's ID: { op, timer }, the timer at the request's
    // deadline + 2 s.
    this.open = new Map();
    // The highest ID ever opened: a marker for one at or below it that
    // isn't open names an ended request.
    this.highest = 0;
    // The open step: { id, timer }, the timer a late step's own 2 s.
    this.step = null;
    // Set once this process is abandoned for its markers or an overrun:
    // { cause, culprit }. Its markers are ignored from then on.
    this.abandoned = null;
    this.death = null;
    // Called with the death's record once it is made (`afterDeath`).
    this.deathWaiters = [];
  }

  /** The request whose step is open, or null. */
  get openStep() {
    return this.step ? this.step.id : null;
  }

  /**
   * A request written to the process: open until its reply or the death.
   * `op` is its operation (colibri-fetch.js's registry entry), with its `id`
   * and `deadlineAt`.
   */
  opened(op) {
    if (this.death) return;
    const { id } = op;
    if (id > this.highest) this.highest = id;
    const timer = this.setTimer(
      () => this.overrun(id),
      Math.max(0, op.deadlineAt + OVERRUN_MS - this.now())
    );
    this.open.set(id, { op, timer });
  }

  /**
   * Request `id`'s reply arrived: it is no longer open. A reply while its
   * own step is open is out of order: the process is abandoned, and the
   * reply refused.
   * @returns {boolean} whether the reply stands as its request's outcome
   */
  closed(id) {
    const entry = this.open.get(id);
    if (!entry) return true;
    this.open.delete(id);
    this.clearTimer(entry.timer);
    entry.op.ended = true;
    if (this.step?.id !== id || this.abandoned || this.death) return true;
    this.refuse('reply_in_step');
    return false;
  }

  /** Calls `fn` with the death's record once the process has died (at
   * once if it has). */
  afterDeath(fn) {
    if (this.death) fn(this.death);
    else this.deathWaiters.push(fn);
  }

  /** The operation of open request `id`, or undefined. */
  operation(id) {
    return this.open.get(id)?.op;
  }

  /**
   * One of the process's events: a marker is checked, anything else is
   * left alone. Ignored once the process is abandoned or dead.
   * @returns {boolean} whether it was a marker
   */
  event(name, data) {
    if (name !== STEP && name !== STEPPED) return false;
    if (this.abandoned || this.death) return true;
    const id = markedRequest(data);
    if (id === null) {
      this.refuse('bad_marker');
    } else if (name === STEP) {
      this.stepOpened(id);
    } else {
      this.stepClosed(id);
    }
    return true;
  }

  stepOpened(id) {
    const entry = this.open.get(id);
    if (!entry) {
      this.refuse(id <= this.highest ? 'ended_request' : 'unknown_request');
      return;
    }
    if (this.step) {
      this.refuse('step_open');
      return;
    }
    const step = { id, timer: null };
    this.step = step;
    // Past its request's deadline + 2 s already: the overrun's check ran,
    // so the step gets its own 2 s.
    if (this.now() >= entry.op.deadlineAt + OVERRUN_MS) {
      step.timer = this.setTimer(() => {
        step.timer = null;
        if (this.step === step) this.overran(id);
      }, OVERRUN_MS);
    }
  }

  stepClosed(id) {
    if (this.step?.id !== id) {
      this.refuse('not_open_step');
      return;
    }
    this.clearStep();
  }

  clearStep() {
    if (this.step?.timer) this.clearTimer(this.step.timer);
    this.step = null;
  }

  /** Request `id`'s deadline + 2 s: its step, if open, overran. */
  overrun(id) {
    const entry = this.open.get(id);
    if (entry) entry.timer = null;
    if (this.step?.id === id) this.overran(id);
  }

  overran(id) {
    if (this.abandoned || this.death) return;
    if (this.step?.timer) this.clearTimer(this.step.timer);
    // An abandon refused (the process has exited, or main is stopping it)
    // leaves the death to name as its cause says.
    this.log.warn(`${this.label} step overran its deadline`);
    if (this.abandonProcess('overrun')) this.abandoned = { cause: 'overrun', culprit: id };
  }

  /** A protocol error in the markers: the process is abandoned, and its
   * death names nobody, whether or not the abandon ended it (one that has
   * exited already, or that main is stopping). */
  refuse(rule) {
    this.log.warn(`${this.label} step marker refused`, { rule });
    this.abandoned = { cause: 'marker', culprit: null };
    if (this.step?.timer) this.clearTimer(this.step.timer);
    this.abandonProcess('marker');
  }

  /**
   * The process died with `exit` (ServiceClient's `{ code, signal, cause }`):
   * the death's record, frozen at the first call. Every open request ends.
   * @returns {{generation: number, code: number|null, signal: string|null,
   *   cause: string|null, culprit: number|null, reason: string}}
   */
  die({ code = null, signal = null, cause = null } = {}) {
    if (this.death) return this.death;
    let culprit = null;
    if (this.abandoned) culprit = this.abandoned.culprit;
    else if (NAMING_CAUSES.has(cause)) culprit = this.openStep;
    for (const { op, timer } of this.open.values()) {
      this.clearTimer(timer);
      op.ended = true;
    }
    this.open.clear();
    if (this.step?.timer) this.clearTimer(this.step.timer);
    this.death = deathRecord({ generation: this.generation, code, signal, cause, culprit });
    for (const fn of this.deathWaiters.splice(0)) fn(this.death);
    return this.death;
  }
}

module.exports = {
  ColibriMarkers,
  deathRecord,
  deathReason,
  DEATH_REASONS,
  OVERRUN_MS,
};
