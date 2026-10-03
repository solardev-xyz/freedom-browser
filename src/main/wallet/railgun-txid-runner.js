/** Main-owned exclusive TXID job runner. Results are branded against the
 * authenticated store revision; they are computation observations only, never
 * service-root validation, chain coverage, account POI or spending grants.
 */
const { createHash } = require('crypto');
const path = require('path');
const { assertRailgunSessionWorker } = require('./railgun-session-worker');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { startRailgunProcess } = require('./railgun-process');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
const fail = () =>
  Object.assign(new Error('Railgun TXID job unavailable'), { code: 'RAILGUN_TXID_JOB_REFUSED' });
const check = (v) => {
  if (!v) throw fail();
};
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
function createRailgunTxidRunner({ handle, archive, session, filename, binding }) {
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.deployment === 'sepolia' &&
      subject.role === 'engine' &&
      subject.operation === null
  );
  check(session?.signal instanceof AbortSignal && typeof session.claimDispatch === 'function');
  check(
    typeof filename === 'string' &&
      path.isAbsolute(filename) &&
      path.basename(filename) === 'txid.sqlite'
  );
  assertRailgunSessionWorker(session, { handle, filename, binding });
  archive = verifyRailgunEngineRuntime(archive);
  const dispatch = session.claimDispatch();
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([context.signal, session.signal]),
  });
  let busy = false,
    closed = false,
    task,
    serial = 0;
  const receipts = new WeakMap();
  const active = () => {
    check(!closed && !scope.signal.aborted);
    getPrivacyContext(handle);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    scope.signal.removeEventListener('abort', close);
    scope.close();
    task?.close();
    session.close();
  };
  scope.signal.addEventListener('abort', close, { once: true });
  async function run(mode, payload) {
    active();
    check(!busy && ['inspect', 'project', 'apply', 'witness'].includes(mode));
    const text = JSON.stringify(payload);
    check(typeof text === 'string' && Buffer.byteLength(text) <= 2 * 1024 * 1024 - 128);
    payload = JSON.parse(text);
    busy = true;
    let sequence = 0,
      supplied = false,
      result,
      storageBusy = false,
      transaction = null;
    const keyAllowed = (key) => {
      check(typeof key === 'string' && key.length <= 5500);
      const bytes = Buffer.from(key, 'base64');
      check(
        bytes.toString('base64') === key &&
          bytes.length <= 4096 &&
          /^txid:[a-z0-9:]+$/.test(bytes.toString('utf8'))
      );
    };
    try {
      task = startRailgunProcess({
        handle: scope.getContext({ ...subject, operation: 'txid-' + mode }),
        archive,
        filename: require.resolve('./railgun-txid-job'),
        input: JSON.stringify({ archive, mode }),
        startupMs: 120000,
        lifetimeMs: 180000,
        broker: {
          signal: scope.signal,
          async dispatch(wire) {
            active();
            check(typeof wire === 'string' && Buffer.byteLength(wire) <= 2 * 1024 * 1024);
            const message = JSON.parse(wire);
            check(message?.id === ++sequence && !result && !storageBusy);
            if (message.method === 'input') {
              check(!supplied && Object.keys(message).length === 2);
              supplied = true;
              return JSON.stringify({ id: message.id, value: payload });
            }
            check(supplied);
            if (message.method === 'result') {
              check(
                Object.keys(message).length === 3 &&
                  message.value?.guards?.attempts === 0 &&
                  message.value.inventory === inventory &&
                  transaction === null
              );
              result = message.value;
              return JSON.stringify({ id: message.id, value: null });
            }
            check(
              Object.keys(message).length === 3 &&
                (message.method === 'get' ||
                  (mode === 'apply' &&
                    ['txBegin', 'txStage', 'txCommit', 'txAbort', 'txRead'].includes(
                      message.method
                    )))
            );
            if (message.method === 'txStage')
              check(
                Array.isArray(message.args?.operations) &&
                  message.args.operations.every((op) => op.type === 'put')
              );
            if (message.method === 'txBegin') check(transaction === null);
            else if (message.method === 'get') {
              check(transaction === null);
              keyAllowed(message.args?.key);
            } else {
              check(transaction !== null && message.args?.transaction === transaction);
              if (message.method === 'txStage')
                message.args.operations.forEach((op) => keyAllowed(op.key));
              if (message.method === 'txRead') {
                check(message.args?.method === 'get');
                keyAllowed(message.args.args?.key);
              }
            }
            const id = ++serial;
            storageBusy = true;
            try {
              const reply = JSON.parse(await dispatch.dispatch(JSON.stringify({ ...message, id })));
              check(reply.id === id);
              if (message.method === 'txBegin') {
                check(Number.isSafeInteger(reply.value) && reply.value > 0);
                transaction = reply.value;
              }
              if (['txCommit', 'txAbort'].includes(message.method)) {
                check(reply.value === null);
                transaction = null;
              }
              return JSON.stringify({ ...reply, id: message.id });
            } finally {
              storageBusy = false;
            }
          },
        },
      });
      await task.ready;
      check(result);
      task.close();
      const drained = await task.closed;
      check(drained.code === 'RAILGUN_PROCESS_CLOSED');
      active();
      const observed = await session.inspectWalletState();
      session.assertFresh(observed);
      const value = freeze(JSON.parse(JSON.stringify(result))),
        receipt = Object.freeze({});
      receipts.set(receipt, {
        value,
        observed,
        mode,
        created: performance.now(),
        inputSha256: createHash('sha256').update(text).digest('hex'),
      });
      return Object.freeze({ value, receipt });
    } catch {
      close();
      throw fail();
    } finally {
      task?.close();
      if (task) await task.closed;
      task = null;
      busy = false;
    }
  }
  function assertResult(receipt, mode, payload) {
    active();
    check(!busy);
    const entry = receipts.get(receipt),
      now = performance.now();
    check(
      entry &&
        entry.mode === mode &&
        now >= entry.created &&
        now - entry.created < 60000 &&
        entry.inputSha256 === createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    );
    session.assertFresh(entry.observed);
    return entry.value;
  }
  return Object.freeze({ run, assertResult, close, signal: scope.signal });
}
module.exports = { createRailgunTxidRunner };
