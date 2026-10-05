/** Fixed trusted worker entry. Never accepts code, paths or authority from the
 * engine. Reuses the broker's validation and transaction/cursor semantics.
 */
const { isMainThread, parentPort, workerData } = require('worker_threads');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunSession, createRailgunReadOnlySession } = require('./railgun-session');
if (isMainThread || !parentPort) throw new Error('Railgun worker entry only');
const revoked = new Int32Array(workerData.revoked);
const controller = new AbortController();
const scope = createPrivacyScope({
  profileId: workerData.profileId,
  signal: controller.signal,
  isCurrent: () => Atomics.load(revoked, 0) === 0,
});
let session,
  stopping = false,
  sequence = 0,
  rpcId = 0,
  pending = 0;
const requests = new Map();
const observations = new Map();
let observationId = 0;
const fail = () =>
  Object.assign(new Error('Railgun worker unavailable'), { code: 'RAILGUN_SESSION_REVOKED' });
function close() {
  if (stopping) return;
  stopping = true;
  Atomics.store(revoked, 0, 1);
  try {
    controller.abort();
  } finally {
    try {
      session?.close();
    } catch {
      // A drained worker with failed storage closure is not a clean close.
      // Keep the failure observable through the actual worker exit status.
      process.exitCode = 1;
    } finally {
      for (const request of requests.values()) request.reject(fail());
      requests.clear();
      observations.clear();
      parentPort.close();
    }
  }
}
parentPort.on('close', close);
parentPort.once('messageerror', close);
parentPort.on('message', (message) => {
  if (stopping) return;
  if (message?.type === 'close' || Atomics.load(revoked, 0)) return close();
  if (
    message?.type === 'rpcReply' &&
    requests.has(message.id) &&
    typeof message.wire === 'string' &&
    Buffer.byteLength(message.wire) <= 2 * 1024 * 1024
  ) {
    const request = requests.get(message.id);
    requests.delete(message.id);
    try {
      request.resolve(JSON.parse(message.wire));
    } catch {
      close();
    }
    return;
  }
  if (
    !['dispatch', 'inspect'].includes(message?.type) ||
    message.id !== sequence + 1 ||
    pending >= 8
  )
    return close();
  sequence = message.id;
  if (message.type === 'inspect') {
    try {
      const request = JSON.parse(message.wire);
      let value;
      if (request.method === 'publicState') value = session.inspectPublicState();
      else if (request.method === 'walletState') value = session.inspectWalletState();
      else if (request.method === 'storeIdentity') value = session.inspectStoreIdentity();
      else if (request.method === 'frontier') value = session.inspectFrontier();
      else if (request.method === 'position' && observations.has(request.observation))
        value = session.inspectPosition(observations.get(request.observation), request.position);
      else throw Object.assign(new Error(), { code: 'RAILGUN_FRONTIER_STALE' });
      if (observations.size >= 16) observations.delete(observations.keys().next().value);
      observations.set(++observationId, value);
      parentPort.postMessage({
        type: 'reply',
        id: message.id,
        wire: JSON.stringify({
          observation: observationId,
          revision: Atomics.load(revoked, 1),
          value,
        }),
      });
    } catch (error) {
      if (
        [
          'RAILGUN_FRONTIER_BUSY',
          'RAILGUN_FRONTIER_STALE',
          'RAILGUN_FRONTIER_NOT_ELIGIBLE',
        ].includes(error.code)
      )
        parentPort.postMessage({
          type: 'reply',
          id: message.id,
          wire: JSON.stringify({ error: error.code }),
        });
      else close();
    }
    return;
  }
  pending++;
  session
    .dispatch(message.wire)
    .then((wire) => {
      if (!stopping && !Atomics.load(revoked, 0))
        parentPort.postMessage({ type: 'reply', id: message.id, wire });
    }, close)
    .finally(() => {
      pending--;
    });
});
const key = Buffer.from(workerData.storage.key);
workerData.storage.key.fill(0);
try {
  if (Object.hasOwn(workerData, 'readOnly') && workerData.readOnly !== true) throw fail();
  if (Object.hasOwn(workerData.storage, 'readOnly')) throw fail();
  session = (workerData.readOnly === true ? createRailgunReadOnlySession : createRailgunSession)({
    handle: scope.getContext(workerData.subject, workerData.requirements),
    storage: { ...workerData.storage, key },
    onClose: close,
    onRevision: (revision) => {
      if (revision > 0x7fffffff) throw fail();
      Atomics.store(revoked, 1, revision);
      observations.clear();
    },
    createProvider: ({ signal }) => ({
      signal,
      request: (request) => {
        if (stopping || requests.size >= 8 || Atomics.load(revoked, 0))
          return Promise.reject(fail());
        const id = ++rpcId;
        return new Promise((resolve, reject) => {
          requests.set(id, { resolve, reject });
          parentPort.postMessage({ type: 'rpc', id, wire: JSON.stringify(request) });
        });
      },
    }),
  });
  key.fill(0);
  if (stopping || Atomics.load(revoked, 0)) close();
  else parentPort.postMessage({ type: 'ready' });
} catch {
  key.fill(0);
  close();
}
