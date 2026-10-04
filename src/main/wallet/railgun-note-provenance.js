/** Main-owned, result-only detached verifier. This diagnostic does not mint an
 * account/window capability: authentication of events, ownership and root
 * acceptance must be composed separately before any spending admission.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const { normalizeRailgunNoteTxidWitness } = require('./railgun-txid-note-witness');
const { matchRailgunTxidEvents } = require('./railgun-txid-events');
const fail = () =>
  Object.assign(new Error('Railgun note provenance unavailable'), {
    code: 'RAILGUN_NOTE_PROVENANCE_REFUSED',
  });
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
async function verify({
  handle,
  archive,
  state,
  note,
  noteWitness,
  events,
  signal,
  timeoutMs = 30000,
}) {
  const parent = getPrivacyContext(handle);
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000);
  assert.equal(parent.subject.kind, 'private-account');
  assert.equal(parent.subject.protocol, 'railgun');
  assert.equal(parent.subject.chainId, 11155111);
  assert.equal(parent.subject.role, 'engine');
  assert.equal(parent.subject.operation, 'note-provenance');
  const normalized = normalizeRailgunNoteTxidWitness(noteWitness, state, note);
  const coverage = matchRailgunTxidEvents({
    blockNumber: normalized.note.blockNumber,
    txid: normalized.note.txid.slice(2),
    events,
    rows: [normalized.witness.row],
  });
  assert.equal(coverage.matchedRows, 1);
  assert.equal(coverage.knownOmissions, 0);
  const input = JSON.stringify({
    archive: verifyRailgunEngineRuntime(archive),
    state,
    note: normalized.note,
    noteWitness: normalized,
    events,
  });
  assert.ok(Buffer.byteLength(input) <= 65536);
  const digest = createHash('sha256').update(input).digest('hex');
  const scope = createPrivacyScope({
    profileId: parent.profileId,
    signal: AbortSignal.any([signal, parent.signal]),
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const started = performance.now(),
    deadline = started + timeoutMs;
  let task,
    result,
    closed = false,
    closeFailed = false;
  const active = () => {
    if (
      closed ||
      scope.signal.aborted ||
      performance.now() < started ||
      performance.now() >= deadline
    )
      throw fail();
    getPrivacyContext(handle);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    // This also runs as an abort listener/timer. Neither cleanup failure may
    // escape that callback or prevent the other resource from being closed.
    try {
      scope.close();
    } catch {
      closeFailed = true;
    }
    try {
      task?.close();
    } catch {
      closeFailed = true;
    }
  };
  const drain = async () => {
    try {
      close();
    } finally {
      // A throwing close must not release the caller before actual child exit.
      if (task) await task.closed;
    }
    if (closeFailed) throw fail();
  };
  scope.signal.addEventListener('abort', close, { once: true });
  const timer = setTimeout(close, timeoutMs);
  timer.unref?.();
  try {
    active();
    task = startRailgunProcess({
      handle: scope.getContext(parent.subject),
      filename: require.resolve('./railgun-note-provenance-job'),
      input,
      startupMs: Math.min(30000, timeoutMs),
      lifetimeMs: timeoutMs,
      broker: {
        signal: scope.signal,
        async dispatch(wire) {
          try {
            active();
            assert.equal(result, undefined);
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
            const message = JSON.parse(wire);
            shape(message, ['id', 'method', 'value']);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            const value = message.value;
            shape(value, [
              'inputSha256',
              'pathVerified',
              'suppliedCreatorEventsMatched',
              'ownershipVerified',
              'eventSourceAuthenticated',
              'rootAccepted',
              'spendingEnabled',
              'coverage',
              'guards',
              'inventory',
            ]);
            assert.equal(value.inputSha256, digest);
            assert.equal(value.pathVerified, true);
            assert.equal(value.suppliedCreatorEventsMatched, true);
            for (const key of [
              'ownershipVerified',
              'eventSourceAuthenticated',
              'rootAccepted',
              'spendingEnabled',
            ])
              assert.equal(value[key], false);
            assert.deepEqual(value.coverage, coverage);
            assert.equal(
              value.inventory,
              require('./railgun-engine-manifest.json').inventory.sha256
            );
            shape(value.guards, ['attempts', 'canaries', 'hooks']);
            const { attempts, canaries, hooks } = value.guards;
            assert.equal(attempts, 0);
            assert.ok(Array.isArray(hooks) && hooks.length >= 1 && hooks.length <= 256);
            assert.ok(
              hooks.every((hook) => typeof hook === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(hook))
            );
            assert.equal(new Set(hooks).size, hooks.length);
            assert.equal(canaries, hooks.length);
            result = Object.freeze({
              inputSha256: digest,
              pathVerified: true,
              suppliedCreatorEventsMatched: true,
              ownershipVerified: false,
              eventSourceAuthenticated: false,
              rootAccepted: false,
              spendingEnabled: false,
              coverage,
            });
            return JSON.stringify({ id: 1, value: null });
          } catch (error) {
            // Close synchronously before the rejected promise reaches the
            // supervisor: caught or queued traffic cannot rescue this attempt.
            close();
            throw error;
          }
        },
      },
    });
    await task.ready;
    active();
    assert.ok(result);
    task.close();
    const exited = await task.closed;
    assert.equal(exited.code, 'RAILGUN_PROCESS_CLOSED');
    active();
    return Object.freeze({ ...result, utilityExitObserved: true });
  } finally {
    clearTimeout(timer);
    await drain();
  }
}
exports.verifyRailgunNoteProvenance = async (options) => {
  try {
    return await verify(options);
  } catch {
    throw fail();
  }
};
