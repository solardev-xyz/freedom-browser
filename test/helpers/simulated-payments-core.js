/**
 * The identity core's payment history (`payments.*`, freedom-core design
 * 0013, "Payment history"; PRF-6(c)) for unit tests, simulated on the
 * reference module (reference-payment-history.js, at 9d4ea6251), so a
 * suite's assertions still run on today's statements and rows. The real
 * core is tested against main in src/main/payment-history.integration.test.js.
 *
 * `simulatedPayments(options)` is a sim whose `payments` is
 * `vaultBackend.payments` as main sees it (core/vault-backend.js, after its
 * error mapping):
 *   - each request's members go through JSON, as on the wire, and then the
 *     reference's own function runs on them: `append`, `update`,
 *     `markConfirmed`, `markFailed`, `markDropped`, `getRecent`, `getById`,
 *     `getCount` and `clear`; `pending` is the reference's `getPending`
 *     statement (its raw rows), and `setDroppedSeen` its `setDroppedSeenAt`
 *     (neither exported), answering nothing;
 *   - the answer holds the reference's return value, copied through JSON,
 *     and the reference's own broadcasts are silenced, as the core sends
 *     none;
 *   - the reference module is loaded in the suite's registry at the first
 *     request (its logger, paths and better-sqlite3 the suite's, so a suite
 *     mocking better-sqlite3 with fake-better-sqlite3-payments.js gets that),
 *     and it opens its database as it did, at its first use;
 *   - a refusal is thrown as vault-backend throws it: the reference's class
 *     (`Error`, `TypeError`, …) with its message, `code: 'invalid_argument'`
 *     and `data.name`; a driver's own error (a SqliteError) is `storage`
 *     with `{ store: 'payments', kind: 'io' }`, as the core answers it;
 *   - the methods the core takes only from main (all but `get_recent`,
 *     `get_by_id`, `get_count` and `clear`) refuse the chrome, `forbidden`.
 *
 * The sim's own controls:
 *   - `moved: false` (a core that didn't take `payments`, as 0.22.0): every
 *     method fails `requirement_unmet`, and nothing is read or written;
 *   - `failBefore(method, code)`: the next request of `method` (wire name)
 *     fails `code` (default `core_unavailable`) before the store sees it;
 *     `loseReply(method)`: the next one runs, then its answer is lost
 *     (`core_unavailable`);
 *   - `calls` records `[method, caller]`, the caller `'chrome'` or
 *     `'shell'`; `reference()` is the reference module.
 *
 * `withSimulatedPayments(mocked, options)` adds a sim's `payments` to a
 * suite's vault-backend mock.
 */

const CHROME_METHODS = new Set([
  'payments.get_recent',
  'payments.get_by_id',
  'payments.get_count',
  'payments.clear',
]);
const PENDING_SQL = "SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at ASC";
const ERROR_CLASSES = { Error, TypeError, RangeError, SyntaxError };

function coded(code, message, data) {
  return Object.assign(new Error(message), { code, ...(data ? { data } : {}) });
}

/** The reference's `setDroppedSeenAt(row, seenAt)`, which it doesn't export. */
function setDroppedSeenAt(reference, id, seenAt) {
  const current = reference.getDb().prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!current || current.status !== 'pending') return;
  let parsed;
  try {
    parsed = current.metadata ? JSON.parse(current.metadata) : null;
  } catch {
    parsed = null;
  }
  const metadata = { ...(parsed || {}) };
  if (seenAt === null) delete metadata.txDroppedSeenAt;
  else metadata.txDroppedSeenAt = seenAt;
  reference.update(id, { metadata });
}

const RUNS = {
  'payments.append': (ref, p) => ({ payment: ref.append(p.entry) }),
  'payments.update': (ref, p) => ({ payment: ref.update(p.id, p.patch) }),
  'payments.mark_confirmed': (ref, p) => ({ payment: ref.markConfirmed(p.id, p.receipt) }),
  'payments.mark_failed': (ref, p) => ({ payment: ref.markFailed(p.id, p.info) }),
  'payments.mark_dropped': (ref, p) => ({ payment: ref.markDropped(p.id) }),
  'payments.set_dropped_seen': (ref, p) => {
    setDroppedSeenAt(ref, p.id, p.seen_at);
    return {};
  },
  'payments.pending': (ref) => ({ payments: ref.getDb().prepare(PENDING_SQL).all() }),
  'payments.get_recent': (ref, p) => ({ payments: ref.getRecent(p.filters) }),
  'payments.get_by_id': (ref, p) => ({ payment: ref.getById(p.id) }),
  'payments.get_count': (ref, p) => ({ count: ref.getCount(p.filters) }),
  'payments.clear': (ref) => ({ removed: ref.clear() }),
};

/**
 * `run()` with the reference's own broadcasts silenced: the core sends
 * none, and main broadcasts after its answers. The reference reaches the
 * webContents through the suite's electron mock at each broadcast, so its
 * list is empty while it runs.
 */
function silently(run) {
  const contents = require('electron')?.webContents;
  const all = contents?.getAllWebContents;
  if (typeof all !== 'function') return run();
  contents.getAllWebContents = () => [];
  try {
    return run();
  } finally {
    contents.getAllWebContents = all;
  }
}

/** A reference error, as the core answers it and vault-backend throws it again. */
function asCoreError(err) {
  const isDriver =
    err?.constructor?.name === 'SqliteError' ||
    (typeof err?.code === 'string' && err.code.startsWith('SQLITE_'));
  if (isDriver) {
    return coded('storage', 'The payment history could not be read or written', {
      store: 'payments',
      kind: 'io',
    });
  }
  const name = Object.hasOwn(ERROR_CLASSES, err?.name) ? err.name : 'Error';
  return Object.assign(new ERROR_CLASSES[name](err?.message ?? String(err)), {
    code: 'invalid_argument',
    data: { name },
  });
}

function simulatedPayments({ moved = true } = {}) {
  const sim = { moved, calls: [], lost: new Set(), failing: new Map() };
  const reference = () => require('./reference-payment-history');

  async function request(method, params, caller) {
    const from = caller === 'chrome' ? 'chrome' : 'shell';
    sim.calls.push([method, from]);
    if (!sim.moved) throw coded('requirement_unmet', "The core can't take this request");
    if (from === 'chrome' && !CHROME_METHODS.has(method)) {
      throw coded('forbidden', 'not callable by this caller');
    }
    const failing = sim.failing.get(method);
    if (failing) {
      sim.failing.delete(method);
      throw coded(failing, 'The identity core is not running');
    }
    // The wire: what JSON can't hold doesn't arrive.
    const sent = JSON.parse(JSON.stringify(params));
    let answer;
    try {
      answer = silently(() => RUNS[method](reference(), sent));
    } catch (err) {
      throw asCoreError(err);
    }
    if (sim.lost.has(method)) {
      sim.lost.delete(method);
      throw coded('core_unavailable', 'The identity core is not running');
    }
    return JSON.parse(JSON.stringify(answer));
  }

  sim.payments = {
    append: async (entry) => (await request('payments.append', { entry })).payment,
    update: async (id, patch) => (await request('payments.update', { id, patch })).payment,
    markConfirmed: async (id, receipt) =>
      (await request('payments.mark_confirmed', { id, receipt })).payment,
    markFailed: async (id, info) => (await request('payments.mark_failed', { id, info })).payment,
    markDropped: async (id) => (await request('payments.mark_dropped', { id })).payment,
    setDroppedSeen: async (id, seenAt) => {
      await request('payments.set_dropped_seen', { id, seen_at: seenAt });
    },
    pending: async () => (await request('payments.pending', {})).payments,
    getRecent: async (filters, caller = null) =>
      (await request('payments.get_recent', { filters }, caller)).payments,
    getById: async (id, caller = null) =>
      (await request('payments.get_by_id', { id }, caller)).payment,
    getCount: async (filters, caller = null) =>
      (await request('payments.get_count', { filters }, caller)).count,
    clear: async (caller = null) => (await request('payments.clear', {}, caller)).removed,
  };
  sim.failBefore = (method, code = 'core_unavailable') => sim.failing.set(method, code);
  sim.loseReply = (method) => sim.lost.add(method);
  sim.reference = reference;
  return sim;
}

/**
 * A suite's vault-backend mock (`mocked`, `{ vaultBackend, … }`) with
 * `vaultBackend.payments` a fresh sim's, and the sim as `simulatedPayments`.
 */
function withSimulatedPayments(mocked, options) {
  const sim = simulatedPayments(options);
  return {
    ...mocked,
    vaultBackend: { ...mocked.vaultBackend, payments: sim.payments },
    simulatedPayments: sim,
  };
}

module.exports = { simulatedPayments, withSimulatedPayments };
