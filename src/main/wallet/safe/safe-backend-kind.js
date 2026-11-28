/**
 * What runs a Safe (freedom-core design 0016, SAFE-3; the SAFE-3 plan's
 * point 4, the switch): `js`, today's protocol-kit path in main
 * (`safe-service.js`, `safe-transactions.js`, `safe-messages.js`), or
 * `core`, freedom-cored's `safe.*` methods (vault-backend.js `safe`).
 *
 * Packaged builds always run `js`, whatever FREEDOM_SAFE_BACKEND says,
 * until SAFE-3's PR 11 makes the core the default: the core's Safe is
 * selectable in development builds only. Development builds run `js` by
 * default, and the core with FREEDOM_SAFE_BACKEND=core; any other value is
 * warned of, once, and runs the default.
 *
 * **One backend per process** (plan point 4): `safeBackendKind()` reads
 * the switch once, the first time it is asked, and gives that answer for
 * the rest of the process, so a Safe never has two drivers in one run.
 * `readSafeBackendKind()` is the reading itself, for tests.
 *
 * Only with `core` does main send a `safe.*` request, or declare the
 * hello's `safe3` (the plan's section 5); a core Safe whose Ledger runs on
 * `js` (ledger-backend-kind.js) shows its Ledger owners' rows unavailable.
 * Nothing reads the switch yet: SAFE-3's PRs 3 to 9 route by it.
 */

const { app } = require('electron');
const log = require('../../logger');

const KINDS = new Set(['js', 'core']);

let warnedBackend = null;
let chosen = null;

/** The switch as it reads now: `js` or `core`. */
function readSafeBackendKind({ packaged = Boolean(app?.isPackaged), env = process.env } = {}) {
  if (packaged) return 'js';
  const kind = env.FREEDOM_SAFE_BACKEND || 'js';
  if (KINDS.has(kind)) return kind;
  if (warnedBackend !== kind) {
    warnedBackend = kind;
    log.warn(`[Safe] Unknown FREEDOM_SAFE_BACKEND=${kind}; using the JS backend`);
  }
  return 'js';
}

/** The process's Safe backend, read once and kept: `js` or `core`. */
function safeBackendKind() {
  if (chosen === null) chosen = readSafeBackendKind();
  return chosen;
}

module.exports = { safeBackendKind, readSafeBackendKind };
