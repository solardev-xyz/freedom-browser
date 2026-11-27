/**
 * What drives a Ledger (freedom-core design 0016, LDG-3; the LDG-3 plan's
 * point 14, the switch): `js`, today's hw-app-eth path in main
 * (`transport.js`, `signer.js`), or `core`, freedom-cored's device lane,
 * whose APDUs main carries to the device through its relay
 * (`core/ledger-relay.js`).
 *
 * Packaged builds always run `js`, whatever FREEDOM_LEDGER_BACKEND says,
 * until LDG-3's PR 14 makes the core the default: the core's backend is
 * selectable in development builds only. Development builds run `js` by
 * default, and the core with FREEDOM_LEDGER_BACKEND=core; any other value
 * is warned of, once, and runs the default.
 *
 * **One backend per process** (plan point 14): `ledgerBackendKind()` reads
 * the switch once, the first time it is asked, and gives that answer for
 * the rest of the process, so a Ledger never has two drivers in one run.
 * `readLedgerBackendKind()` is the reading itself, for tests.
 *
 * The relay's handler is registered whichever runs, so a stray
 * `shell.ledger_apdu` is answered `parent` (an `unknown_method` would end
 * the core's connection); its registry opens no parent unless this says
 * `core`.
 */

const { app } = require('electron');
const log = require('../../logger');

const KINDS = new Set(['js', 'core']);

let warnedBackend = null;
let chosen = null;

/** The switch as it reads now: `js` or `core`. */
function readLedgerBackendKind({ packaged = Boolean(app?.isPackaged), env = process.env } = {}) {
  if (packaged) return 'js';
  const kind = env.FREEDOM_LEDGER_BACKEND || 'js';
  if (KINDS.has(kind)) return kind;
  if (warnedBackend !== kind) {
    warnedBackend = kind;
    log.warn(`[Ledger] Unknown FREEDOM_LEDGER_BACKEND=${kind}; using the JS backend`);
  }
  return 'js';
}

/** The process's Ledger backend, read once and kept: `js` or `core`. */
function ledgerBackendKind() {
  if (chosen === null) chosen = readLedgerBackendKind();
  return chosen;
}

module.exports = { ledgerBackendKind, readLedgerBackendKind };
