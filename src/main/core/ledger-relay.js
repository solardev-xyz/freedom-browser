/**
 * Main's relay for the core's `shell.ledger_apdu` (freedom-core design
 * 0016, The device lane, `shell.ledger_apdu`, The APDU grammar, Typed data
 * on the device (Q23), Deadlines, cancel and unplugging, and LDG-3's relay
 * rules across operations; the LDG-3 plan's PR 6 and its points 4 to 7, 12
 * and 14). Once the core drives a Ledger, it builds every APDU and sends
 * each to main as one `shell.ledger_apdu { for, apdu, deadline_ms }`;
 * main admits it by the grammar for the parent `for` names (one of main's
 * own requests: a Ledger key's `sign.*`, `ledger.accounts`, `ledger.add`,
 * `x402.settle { reservation, typed_data }`), carries it to the device in
 * one exchange, and answers the device's bytes.
 *
 * - **The switch** (wallet/ledger/ledger-backend-kind.js, point 14):
 *   `registerLedgerRelay` registers the handler whichever backend runs, so
 *   a stray APDU is refused `parent` (an `unknown_method` would end the
 *   core's connection), and `open()` throws unless FREEDOM_LEDGER_BACKEND
 *   selects `core` in a development build: on `js` the relay opens no
 *   parent, and every APDU is refused `parent`.
 * - **The parent registry:** `prepare(capture)` builds a parent's
 *   admission (core/ledger-grammar.js) from what main itself holds (plan
 *   point 2), before the parent is sent, and refuses what main can't derive
 *   a stream for; `open({ generation, id }, capture)`, called from the
 *   parent's `onSent` (vault-backend.js `ledgerCall`), registers it before
 *   the core can ask anything for it. Its end (`close()`, its controller's
 *   abort, the core's exit) closes its device, and every later APDU of it
 *   is refused `ended`; a `for` naming no parent main opened is `parent`.
 *   The Safe rows aren't parents until SAFE-3 (`safe.sign_owner`,
 *   `safe.message_sign`: rule `parent`, plan point 11).
 * - **Read strictly:** the params are exactly `{ for, apdu, deadline_ms }`:
 *   `for` a request ID (else `parent`), `apdu` hex of 5 to 260 bytes and
 *   `deadline_ms` 15000 or 300000 (else `header`: the request isn't an APDU
 *   in its frame). The grammar decides everything else, before any byte
 *   reaches the device.
 * - **What the relay answers** (point 4): `{ answer }`, the device's bytes
 *   in hex; `{ answer, hash_only: "shown" }`, only below; `{ failed }`,
 *   one of `not_found`, `busy`, `disconnected`, `unresponsive` and
 *   `timeout`; `invalid_argument` with `data: { rule }` for a refused APDU,
 *   logged with its rule only, never an APDU's bytes; and `cancelled`, only
 *   for an APDU the core cancelled, which the service client answers at
 *   once (`race`). Nothing else: a throw inside the relay is answered as a
 *   refusal `ended`, logged `relay_fault`, and closes the device.
 * - **Each parent gets its own device** (wallet/ledger/hid-device.js),
 *   opened at its first admitted APDU and closed (`detach()`, which never
 *   waits for an exchange in flight) when the parent ends, on the core's
 *   cancel of its APDU, on a `{ failed }`, on a refused APDU, after a
 *   status that ends the operation, and after its last APDU.
 * - **`deadline_ms`** (point 6): 15000 or 300000 on any APDU, enforced from
 *   the APDU's arrival: past it with no answer the device is closed and the
 *   APDU answered `{ failed: "unresponsive" }` (15000) or `{ failed:
 *   "timeout" }` (300000). One that isn't the row's "waits for the user"
 *   column is logged, not refused. Each APDU, and each answer to one, sets
 *   the parent's device watchdog to that `deadline_ms` + 15 s
 *   (service-client.js `watchdogReset`).
 * - **Main's own cancel** (point 5): the parent's controller aborts (the
 *   user's Cancel, or `beforeSign`'s refusal): its signal sends the
 *   parent's cancel, and the relay closes the device at once. The APDU in
 *   flight is answered with whatever the exchange then gives (`{ failed:
 *   "disconnected" }`), which the core, having read the cancel first, drops
 *   as late. Never `cancelled`: the core didn't cancel it.
 * - **`beforeSign`** (point 7): a parent's last check, awaited inside the
 *   APDU's deadline before the parent's first APDU after `B0 01` is
 *   exchanged (signers.js's last check, today `ledger/signer.js`'s). Its
 *   refusal is main's own cancel of the parent, nothing reaches the device,
 *   and the handle keeps the error (`stopped`) for the caller to report.
 * - **The hash-only warning** (Q23, point 12): a `6D00` to the operation's
 *   first `E0 1A` is held while the parent's surface puts the warning on
 *   screen (`hashOnlySurface`, the hook LDG-3's PR 11 fills), at most 10 s
 *   after the `6D00` and inside the APDU's deadline. Reported in time, it
 *   is answered `{ answer: "6d00", hash_only: "shown" }`, after which the
 *   grammar admits `E0 0C 00 00`; otherwise `{ answer: "6d00" }` alone,
 *   and the core ends the operation `LEDGER_UNKNOWN`, nothing signed.
 * - **Across operations** (0016's LDG-3 rules, 2026-11-27): the core may
 *   send the next parent's first APDU while an older exchange is still
 *   out. The core's cancel of the older APDU is processed first (it aborts
 *   the handler's signal as it is read, and frames are read in order),
 *   closing the old device at once without its reply awaited; the new
 *   parent opens a fresh device; and whatever the old one answers late is
 *   no parent's: it belongs to the old exchange alone, which the core
 *   reads as late (and hid-device.js drops every report on an abandoned
 *   channel). A new parent's first APDU also lets go of any device an
 *   older parent still holds (close before open, R5).
 *
 * **The interface left for LDG-3's PR 7 (signatures), PR 8 (discovery and
 * adding), PR 9 (x402) and PR 11 (the hash-only surface)**:
 *
 *     const relay = getLedgerRelay();                    // core-process.js
 *     const prepared = relay.prepare({ method, params, path, records, expectedHash });
 *     if (!prepared.ok) → don't send; prepared.rule, prepared.reason
 *     const controller = new AbortController();
 *     let handle = null;
 *     ledgerCall(method, params, page, {
 *       signal: controller.signal,
 *       onSent: (id, generation) => {
 *         handle = relay.open({ id, generation }, { prepared, controller, beforeSign, hashOnlySurface });
 *       },
 *     }).finally(() => handle?.close());
 *     handle.cancel();     // the user's Cancel: main's own cancel
 *     handle.stopped;      // beforeSign's error, once it refused
 *     handle.signed;       // whether the device's signature may have left main
 *
 * - `path`: the account's path text from main's record snapshot, for every
 *   signature (`sign.*`, `x402.settle`); `records`: `ledger.accounts`'
 *   unmatched records as `getLedgerRecordsToCheck` lists them, and only
 *   once the core reads them (`vault_meta` moved), else none;
 *   `expectedHash`: `x402.settle`'s, main's own hash of its rebuild
 *   (`sign.typed_data` takes its params' `expected_hash`).
 * - `hashOnlySurface({ domainSeparator, structHash, signal })`: puts the
 *   hash-only warning with those two hashes (`0x` hex, main's binding's)
 *   on screen in the surface that waits on the device, and resolves true
 *   once it reports the state on screen (two animation frames in a visible
 *   window); `signal` aborts when main stops waiting for that report, or
 *   when the parent ends.
 * - `handle.signed`: whether the device answered the operation's last APDU
 *   (a signature's `E0 0C`) with status `9000` and main handed that answer
 *   to the pipe (latched by the handler's `onAnswer`), however the parent
 *   then ended (a late answer included): the device's signature may have
 *   left main. False otherwise, an answer the core's cancel overtook among
 *   them (that APDU answered `cancelled` at once, the device's answer
 *   dropped): the core holds no signature of the device's for the parent,
 *   whatever it says.
 */

const defaultLog = require('../logger');
const { ShellError } = require('./core-client');
const { apduWatchdogMs } = require('./core-deadlines');
const { Admission, GrammarError, operationOf } = require('./ledger-grammar');
const { bindTypedData } = require('../wallet/ledger/apdu-binding');

/** The core's request to main. */
const METHOD = 'shell.ledger_apdu';

/** `deadline_ms`'s two values: an APDU the user doesn't confirm, and the one they do. */
const DEVICE_MS = 15_000;
const USER_MS = 300_000;

/** The longest main holds a `6D00` for the hash-only warning's report (point 12). */
const HASH_ONLY_WAIT_MS = 10_000;

/** An APDU, as `shell.ledger_apdu` carries it: 5 to 260 bytes. */
const APDU_MIN = 5;
const APDU_MAX = 260;
/** The status word of an answer that went through. */
const STATUS_OK = 0x9000;
/** A device's answer: 2 to 260 bytes, its status word last. */
const ANSWER_MIN = 2;
const ANSWER_MAX = 260;

/** `{ failed }`'s values, HidDeviceError's `failure`. */
const FAILURES = new Set(['not_found', 'busy', 'disconnected', 'unresponsive', 'timeout']);

/** The operations with a signature's head (the address check, then `B0 01`). */
const SIGNATURES = new Set(['sign.transaction', 'sign.message', 'sign.typed_data', 'x402.settle']);
const HEAD_ROWS = new Set(['signature.first', 'signature.second']);

const MEMBERS = ['for', 'apdu', 'deadline_ms'];
const HEX = /^(?:[0-9a-fA-F]{2})+$/;

const keyOf = (generation, id) => `${generation}:${id}`;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const hashText = (bytes) => `0x${hex(bytes)}`;

/**
 * A `shell.ledger_apdu`'s params, read strictly: `{ for, apdu, deadlineMs }`,
 * or `{ for, rule }` (`for` null when it names no request).
 */
function readAsk(params) {
  const id = isObject(params) ? params.for : undefined;
  if (!Number.isSafeInteger(id) || id < 1) return { for: null, rule: 'parent' };
  const keys = Object.keys(params);
  if (keys.length !== MEMBERS.length || !MEMBERS.every((name) => Object.hasOwn(params, name))) {
    return { for: id, rule: 'header' };
  }
  const { apdu, deadline_ms: deadlineMs } = params;
  if (
    typeof apdu !== 'string' ||
    apdu.length < 2 * APDU_MIN ||
    apdu.length > 2 * APDU_MAX ||
    !HEX.test(apdu)
  ) {
    return { for: id, rule: 'header' };
  }
  if (deadlineMs !== DEVICE_MS && deadlineMs !== USER_MS) return { for: id, rule: 'header' };
  return { for: id, apdu: Buffer.from(apdu, 'hex'), deadlineMs };
}

/** A HidDeviceError's `failure`, or null for any other error. */
function failureOf(err) {
  return err?.name === 'HidDeviceError' && FAILURES.has(err.failure) ? err.failure : null;
}

function defaultOpenDevice() {
  const { HidDevice } = require('../wallet/ledger/hid-device');
  return new HidDevice();
}

class LedgerRelay {
  /**
   * @param {object} [deps] - test seams
   * @param {object} [deps.client] - the core's client, for `watchdogReset`
   * @param {object} [deps.log]
   * @param {() => string} [deps.backendKind] - the switch: `core` or `js`
   * @param {() => object} [deps.openDevice] - one operation's device:
   *   `exchange(apdu, ms, signal)` and `detach()` (hid-device.js `HidDevice`)
   * @param {() => number} [deps.now]
   * @param {Function} [deps.setTimer]
   * @param {Function} [deps.clearTimer]
   * @param {number} [deps.hashOnlyWaitMs]
   */
  constructor({
    client = null,
    log = defaultLog,
    backendKind = () => require('../wallet/ledger/ledger-backend-kind').ledgerBackendKind(),
    openDevice = defaultOpenDevice,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer),
    hashOnlyWaitMs = HASH_ONLY_WAIT_MS,
  } = {}) {
    this.client = client;
    this.log = log;
    this.backendKind = backendKind;
    this.openDevice = openDevice;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.hashOnlyWaitMs = hashOnlyWaitMs;
    // The live parents, by generation and ID.
    this.live = new Map();
    // Every parent that ended in the newest generation seen, so a late APDU
    // for any of them is refused `ended`, however many parents came after.
    // An older generation's core is gone, so its IDs are dropped with it.
    this.endedGeneration = null;
    this.endedIds = new Set();
    // The parent whose device is open, if one is: at most one at a time.
    this.holder = null;
  }

  /**
   * A parent's admission, built before it is sent from what main holds
   * (plan point 2): `{ ok: true, operation, admission, hashes }`, or
   * `{ ok: false, rule, reason, check? }` when main can't derive its stream
   * (the core refuses the same before the first APDU), or it opens no
   * operation (`parent`: a vault key's `sign.*`, `x402.settle` but its
   * Ledger form, and `safe.sign_owner` and `safe.message_sign` until
   * SAFE-3).
   *
   * @param {object} capture
   * @param {string} capture.method - the parent's method
   * @param {object} capture.params - the params main sends it with
   * @param {string} [capture.path] - the account's path, from main's record
   * @param {object[]} [capture.records] - `ledger.accounts`' unmatched records
   * @param {string} [capture.expectedHash] - `x402.settle`'s typed data's hash
   */
  prepare({ method, params, path, records, expectedHash } = {}) {
    const operation = operationOf(method, params);
    if (operation === null) return { ok: false, rule: 'parent', reason: 'no-operation' };
    let typedData;
    let hashes = null;
    if (operation === 'sign.typed_data' || operation === 'x402.settle') {
      const binding = bindTypedData({
        typedData: params.typed_data,
        expectedHash: operation === 'sign.typed_data' ? params.expected_hash : expectedHash,
      });
      if (binding.rule) {
        return {
          ok: false,
          rule: binding.rule,
          reason: binding.reason,
          ...(binding.check ? { check: binding.check } : {}),
        };
      }
      typedData = binding;
      hashes = {
        domainSeparator: hashText(binding.domainSeparator),
        structHash: hashText(binding.structHash),
      };
    }
    try {
      const admission = new Admission({ operation, params, path, records, typedData });
      return { ok: true, operation, admission, hashes };
    } catch (err) {
      if (!(err instanceof GrammarError)) throw err;
      return {
        ok: false,
        rule: err.deviation === 'path-strict' ? 'path' : 'payload',
        reason: err.deviation,
      };
    }
  }

  /**
   * A parent main has sent, from its `onSent`: its APDUs are admitted until
   * its end, `close()` (its response, whatever it is), its controller's
   * abort (main's own cancel), or the core's exit. Throws unless the switch
   * runs the core's backend.
   *
   * @param {{generation: number, id: number}} sent - as `onSent` reports it
   * @param {object} capture
   * @param {object} [capture.prepared] - `prepare()`'s, made before it was
   *   sent; else `capture` is prepared here (method, params, path, records,
   *   expectedHash), and a refusal refuses its first APDU
   * @param {AbortController} capture.controller - whose signal main sent
   *   the parent with: aborting it is main's own cancel
   * @param {() => Promise<void>} [capture.beforeSign] - the caller's last
   *   check, before the first APDU after `B0 01`: throws to refuse
   * @param {Function} [capture.hashOnlySurface] - the hash-only warning's
   *   surface (the module's comment)
   * @returns {{ operation: string|null, close(): void, cancel(): void, stopped: *, signed: boolean }}
   */
  open({ generation, id } = {}, capture = {}) {
    if (this.backendKind() !== 'core') {
      throw new Error('The Ledger runs on its JS backend: the relay opens no parent');
    }
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(id) || id < 1) {
      throw new TypeError('no request ID');
    }
    const { controller, beforeSign = null, hashOnlySurface = null } = capture;
    if (!(controller?.signal instanceof AbortSignal) || typeof controller.abort !== 'function') {
      throw new TypeError("a parent's controller, whose signal main sent it with");
    }
    if (beforeSign !== null && typeof beforeSign !== 'function') {
      throw new TypeError('beforeSign is a function');
    }
    if (hashOnlySurface !== null && typeof hashOnlySurface !== 'function') {
      throw new TypeError('hashOnlySurface is a function');
    }
    const key = keyOf(generation, id);
    if (this.live.has(key) || this.hasEnded(generation, id)) {
      throw new TypeError('that request is open already');
    }
    const prepared = capture.prepared ?? this.prepare(capture);
    if (prepared.opened) throw new TypeError('that admission is open already');
    prepared.opened = true;
    if (beforeSign && prepared.ok && !SIGNATURES.has(prepared.operation)) {
      throw new TypeError('beforeSign is for a signature');
    }
    const entry = {
      key,
      generation,
      id,
      operation: prepared.ok ? prepared.operation : null,
      admission: prepared.ok ? prepared.admission : null,
      hashes: prepared.ok ? prepared.hashes : null,
      // What main couldn't derive: its first APDU is refused with this rule.
      refusal: prepared.ok ? null : prepared.rule,
      // The rule of its first refused APDU: every later one is `ended`.
      refused: null,
      controller,
      beforeSign,
      beforeSignAsked: false,
      hashOnlySurface,
      stopped: null,
      // A 9000 answer to its last APDU was handed to the pipe (`handle.signed`).
      signed: false,
      device: null,
      deviceClosed: false,
      ended: null,
      // Aborts once it may admit nothing more: its holds stop then.
      life: new AbortController(),
      unlisten: null,
    };
    this.live.set(key, entry);
    const onAbort = () => this.end(entry, 'cancel');
    if (controller.signal.aborted) {
      this.end(entry, 'cancel');
    } else {
      controller.signal.addEventListener('abort', onAbort, { once: true });
      entry.unlisten = () => controller.signal.removeEventListener('abort', onAbort);
    }
    return {
      operation: entry.operation,
      close: () => this.end(entry, 'closed'),
      cancel: () => entry.controller.abort(),
      get stopped() {
        return entry.stopped;
      },
      get signed() {
        return entry.signed;
      },
    };
  }

  /** What the relay holds, for diagnostics and tests. */
  stats() {
    return { parents: this.live.size, open: this.holder !== null };
  }

  /** Every live parent ends: the core's process has gone. */
  endAll() {
    for (const entry of [...this.live.values()]) this.end(entry, 'exit');
    if (this.holder) this.retire(this.holder);
  }

  /** A parent's end: nothing more is admitted for it, and its device closes. */
  end(entry, why) {
    if (entry.ended) return;
    entry.ended = why;
    entry.unlisten?.();
    entry.unlisten = null;
    if (this.live.get(entry.key) === entry) this.live.delete(entry.key);
    if (this.endedGeneration === null || entry.generation > this.endedGeneration) {
      this.endedGeneration = entry.generation;
      this.endedIds = new Set();
    }
    if (entry.generation === this.endedGeneration) this.endedIds.add(entry.id);
    this.retire(entry);
  }

  /** Whether the parent `id` of `generation` was opened here and has ended. */
  hasEnded(generation, id) {
    return generation === this.endedGeneration && this.endedIds.has(id);
  }

  /** A parent may admit nothing more: its holds stop and its device closes. */
  retire(entry) {
    entry.admission?.end();
    entry.life.abort();
    this.closeDevice(entry);
  }

  /** Lets go of a parent's device at once, without waiting for its exchange. */
  closeDevice(entry) {
    if (entry.device && !entry.deviceClosed) {
      entry.deviceClosed = true;
      try {
        entry.device.detach();
      } catch (err) {
        this.log.warn('[Ledger] the device did not close', { error: err?.name || 'error' });
      }
    }
    if (this.holder === entry) this.holder = null;
  }

  /** The parent's device, opened at its first APDU; any other parent's closed first. */
  deviceFor(entry) {
    if (entry.device) return entry.device;
    if (this.holder && this.holder !== entry) {
      // The core starts the next operation at once after a cancel or a
      // deadline (0016's LDG-3 rules): an older one still holding the device
      // has ended at the core. Close before open (R5).
      this.log.warn('[Ledger] a new operation: the device an older one held is let go');
      this.retire(this.holder);
    }
    entry.device = this.openDevice();
    this.holder = entry;
    return entry.device;
  }

  /**
   * A refusal: `invalid_argument` with its rule, logged with the rule only;
   * the parent, if there is one, refuses every later APDU (`ended`), and
   * its device closes.
   */
  refuse(entry, rule) {
    const final = entry?.refused ? 'ended' : rule;
    if (entry) {
      entry.refused = entry.refused ?? final;
      this.retire(entry);
    }
    this.log.warn(`[Ledger] ${METHOD} refused`, { rule: final });
    throw new ShellError('invalid_argument', { rule: final });
  }

  /** A throw inside the relay (point 4): refused `ended`, logged `relay_fault`, the device closed. */
  fault(entry, err) {
    this.log.error(`[Ledger] ${METHOD} relay_fault`, {
      rule: 'ended',
      error: err?.name || 'error',
    });
    const holder = entry ?? this.holder;
    if (holder) {
      holder.refused = holder.refused ?? 'ended';
      this.retire(holder);
    }
    throw new ShellError('invalid_argument', { rule: 'ended' });
  }

  /** Each APDU, and each answer to one, sets the parent's watchdog (service-client.js). */
  watch(entry, deadlineMs, onAnswer) {
    const ms = apduWatchdogMs(deadlineMs);
    const reset = () => {
      try {
        this.client?.watchdogReset?.(entry.generation, entry.id, ms);
      } catch (err) {
        this.log.warn('[Ledger] the watchdog was not set', { error: err?.name || 'error' });
      }
    };
    reset();
    if (typeof onAnswer === 'function') onAnswer(reset);
  }

  /** The handler: one `shell.ledger_apdu`. */
  async apdu(params, { signal, generation, onAnswer } = {}) {
    let entry = null;
    try {
      const ask = readAsk(params);
      if (ask.for === null) return this.refuse(null, ask.rule);
      const key = keyOf(generation, ask.for);
      entry = this.live.get(key) ?? null;
      if (!entry) return this.refuse(null, this.hasEnded(generation, ask.for) ? 'ended' : 'parent');
      if (ask.rule) return this.refuse(entry, ask.rule);
      this.watch(entry, ask.deadlineMs, onAnswer);
      if (entry.refused || !entry.admission) {
        return this.refuse(entry, entry.refused ? 'ended' : entry.refusal);
      }
      const verdict = entry.admission.admit(ask.apdu);
      if (verdict.rule) return this.refuse(entry, verdict.rule);
      return await this.carry(entry, ask, verdict, signal, onAnswer);
    } catch (err) {
      if (err instanceof ShellError) throw err;
      return this.fault(entry, err);
    }
  }

  /** Whether the parent's APDU is still the one its admission waits on. */
  answering(entry) {
    return Boolean(entry.admission) && entry.admission.outstanding !== null && !entry.ended;
  }

  /** Whether the APDU last admitted for the parent is its stream's last one. */
  isLast(entry) {
    const { admission } = entry;
    return Boolean(admission) && admission.position >= admission.expected.length;
  }

  /** Whether the parent can admit nothing more: its stream is over. */
  over(entry) {
    const { admission } = entry;
    return admission.ended || admission.position >= admission.expected.length;
  }

  /** An admitted APDU: held where the design holds it, exchanged once, answered. */
  async carry(entry, ask, { row, waits }, signal, onAnswer) {
    if ((ask.deadlineMs === USER_MS) !== (waits === true)) {
      this.log.warn("[Ledger] deadline_ms isn't the row's", { row, deadline_ms: ask.deadlineMs });
    }
    const apdu = {
      deadlineAt: this.now() + ask.deadlineMs,
      failure: ask.deadlineMs === USER_MS ? 'timeout' : 'unresponsive',
    };
    // The core's cancel of this APDU: it has ended the operation.
    const onCancel = () => this.retire(entry);
    signal?.addEventListener('abort', onCancel, { once: true });
    try {
      if (signal?.aborted) {
        onCancel();
        return { failed: 'disconnected' };
      }
      if (
        entry.beforeSign &&
        !entry.beforeSignAsked &&
        SIGNATURES.has(entry.operation) &&
        !HEAD_ROWS.has(row)
      ) {
        const stop = await this.beforeSign(entry, apdu, signal);
        if (stop) return stop;
      }
      return await this.exchange(entry, ask, apdu, signal, onAnswer);
    } finally {
      signal?.removeEventListener('abort', onCancel);
    }
  }

  /**
   * The caller's last check (point 7), before the first APDU after `B0 01`
   * reaches the device: null to go on, or the APDU's answer.
   */
  async beforeSign(entry, apdu, signal) {
    entry.beforeSignAsked = true;
    const outcome = await this.held(entry, apdu.deadlineAt, signal, () => entry.beforeSign());
    if (outcome.error !== undefined) {
      // Main's own cancel: the parent's cancel goes, and the device closes.
      entry.stopped = outcome.error;
      this.log.info('[Ledger] the last check refused the signature: main cancels it');
      entry.controller.abort();
      return { failed: 'disconnected' };
    }
    if (outcome.timeout) return this.failed(entry, apdu.failure);
    if (outcome.stopped) return { failed: 'disconnected' };
    return null;
  }

  /** The one exchange, under `deadline_ms` from the APDU's arrival. */
  async exchange(entry, ask, apdu, signal, onAnswer) {
    if (entry.life.signal.aborted || signal?.aborted) return { failed: 'disconnected' };
    const device = this.deviceFor(entry);
    let timedOut = false;
    const timer = this.setTimer(
      () => {
        timedOut = true;
        this.closeDevice(entry);
      },
      Math.max(0, apdu.deadlineAt - this.now())
    );
    let answer;
    try {
      answer = await device.exchange(ask.apdu, ask.deadlineMs, signal);
    } catch (err) {
      const failure = timedOut ? apdu.failure : failureOf(err);
      if (failure === null) throw err;
      return this.failed(entry, failure);
    } finally {
      this.clearTimer(timer);
    }
    if (
      !(answer instanceof Uint8Array) ||
      answer.length < ANSWER_MIN ||
      answer.length > ANSWER_MAX
    ) {
      this.log.warn('[Ledger] the device gave an answer out of bounds');
      return this.failed(entry, 'disconnected');
    }
    // The operation's last APDU, answered 9000: the device's signature, which
    // leaves main only with this answer (`signedOnHandOff`).
    const signature =
      this.isLast(entry) && Buffer.from(answer).readUInt16BE(answer.length - 2) === STATUS_OK;
    // Ended meanwhile (the core's cancel, main's own): whatever the exchange
    // gave, which the core drops as late.
    if (signal?.aborted || !this.answering(entry)) {
      if (signature) this.signedOnHandOff(entry, signal, onAnswer);
      return { answer: hex(answer) };
    }
    if (entry.admission.isHashOnlyAnswer(answer)) return this.hashOnly(entry, answer, apdu, signal);
    entry.admission.answered({ answer });
    if (this.over(entry)) this.closeDevice(entry);
    if (signature) this.signedOnHandOff(entry, signal, onAnswer);
    return { answer: hex(answer) };
  }

  /**
   * `handle.signed`, latched as main hands the device's signature to the
   * pipe (the handler's `onAnswer`, service-client.js), never before. Once
   * the core has cancelled the APDU (its signal aborted), the service
   * client has answered it `cancelled` at once (`race`) and drops this
   * answer, so nothing is latched; and a hook run for another of the
   * request's answers (that `cancelled`) finds the signal aborted. Without
   * the hook (no service client), the answer is handed over by returning.
   */
  signedOnHandOff(entry, signal, onAnswer) {
    if (signal?.aborted) return;
    const latch = () => {
      if (!signal?.aborted) entry.signed = true;
    };
    if (typeof onAnswer === 'function') onAnswer(latch);
    else latch();
  }

  /** A `{ failed }` answer: the operation ends, and the device closes. */
  failed(entry, failure) {
    if (this.answering(entry)) entry.admission.answered({ failed: failure });
    this.closeDevice(entry);
    return { failed: failure };
  }

  /**
   * The `6D00` to the operation's first `E0 1A` (Q23, point 12): held until
   * the hash-only warning is on screen, at most 10 s and inside the APDU's
   * deadline; then `hash_only: "shown"`, or the bare `6d00`, which ends it.
   */
  async hashOnly(entry, answer, apdu, signal) {
    const until = Math.min(this.now() + this.hashOnlyWaitMs, apdu.deadlineAt);
    const shown = await this.presentHashOnly(entry, until, signal);
    if (shown && !signal?.aborted && this.answering(entry)) {
      entry.admission.answered({ answer, hashOnly: true });
      return { answer: hex(answer), hash_only: 'shown' };
    }
    if (this.answering(entry)) entry.admission.answered({ answer });
    this.closeDevice(entry);
    return { answer: hex(answer) };
  }

  /** Whether the parent's surface reported the hash-only warning on screen by `until`. */
  async presentHashOnly(entry, until, signal) {
    if (!entry.hashOnlySurface || !entry.hashes) return false;
    const giveUp = new AbortController();
    const surfaceSignal = AbortSignal.any([giveUp.signal, entry.life.signal]);
    const outcome = await this.held(entry, until, signal, () =>
      entry.hashOnlySurface({ ...entry.hashes, signal: surfaceSignal })
    );
    const shown = outcome.value === true;
    if (!shown) giveUp.abort();
    if (outcome.error !== undefined) {
      this.log.warn("[Ledger] the hash-only warning's surface failed");
    }
    return shown;
  }

  /**
   * Waits for `start()` until `until`, the APDU's signal (the core's
   * cancel) or the parent's end: `{ value }`, `{ error }`, `{ timeout }` or
   * `{ stopped }`.
   */
  held(entry, until, signal, start) {
    return new Promise((resolve) => {
      const sources = [signal, entry.life.signal].filter(Boolean);
      if (sources.some((source) => source.aborted)) {
        resolve({ stopped: true });
        return;
      }
      let timer = null;
      let done = false;
      const finish = (outcome) => {
        if (done) return;
        done = true;
        this.clearTimer(timer);
        for (const source of sources) source.removeEventListener('abort', onStop);
        resolve(outcome);
      };
      const onStop = () => finish({ stopped: true });
      for (const source of sources) source.addEventListener('abort', onStop, { once: true });
      timer = this.setTimer(() => finish({ timeout: true }), Math.max(0, until - this.now()));
      let pending;
      try {
        pending = Promise.resolve(start());
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(
        (value) => finish({ value }),
        (error) => finish({ error: error ?? new Error('refused') })
      );
    });
  }
}

/**
 * Registers the relay on the core's client, whichever Ledger backend runs
 * (`race`: the core's cancel is answered `cancelled` at once), and ends its
 * parents when the core's process exits. Returns the relay, whose
 * `prepare()` and `open()` a Ledger request's sender calls.
 */
function registerLedgerRelay(client, deps = {}) {
  const relay = new LedgerRelay({ client, ...deps });
  client.handle(METHOD, (params, context) => relay.apdu(params, context), { race: true });
  if (typeof client.on === 'function') client.on('exit', () => relay.endAll());
  return relay;
}

module.exports = {
  registerLedgerRelay,
  LedgerRelay,
  readAsk,
  METHOD,
  HASH_ONLY_WAIT_MS,
};
