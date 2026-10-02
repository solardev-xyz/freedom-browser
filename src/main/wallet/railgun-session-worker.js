/** Trusted host worker for the development broker and encrypted store. This is
 * scheduling isolation within main's authority, not an engine or OS sandbox.
 * RPC remains in main. No renderer channels or signing capabilities are added.
 */
const path = require('path');
const { Worker } = require('worker_threads');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const READS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
]);
const owners = new Set();
const fail = () =>
  Object.assign(new Error('Railgun worker unavailable'), {
    code: 'RAILGUN_SESSION_REVOKED',
  });
const shape = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function startRailgunSessionWorker({ handle, storage, createProvider, onClose }) {
  const context = getPrivacyContext(handle);
  if (
    context.subject.kind !== 'private-account' ||
    context.subject.protocol !== 'railgun' ||
    context.subject.role !== 'engine' ||
    context.subject.chainId !== 11155111 ||
    context.subject.operation !== null ||
    typeof createProvider !== 'function' ||
    typeof onClose !== 'function' ||
    storage?.format !== 'paged-v2' ||
    typeof storage.filename !== 'string' ||
    !path.isAbsolute(storage.filename) ||
    !Buffer.isBuffer(storage.key) ||
    storage.key.length !== 32 ||
    typeof storage.binding !== 'string' ||
    !/^[0-9a-f]{64}$/.test(storage.binding) ||
    (storage.create !== undefined && typeof storage.create !== 'boolean')
  )
    throw fail();
  const filename = path.resolve(storage.filename);
  // One coordinated wallet uses source ledger, public engine and derived-note
  // workers. Keep the total bounded; each worker retains its own memory limit.
  if (owners.size >= 3 || owners.has(filename)) throw fail();
  owners.add(filename);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: context.signal,
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const subject = { ...context.subject };
  delete subject.operation;
  const rpcHandle = scope.getContext({ ...subject, role: 'protocol-rpc' }, context.requirements);
  // Closed flag and monotonic store revision; this allocation is never reused
  // by another session. Main's own dispatch serial covers queued mutations too.
  const revoked = new Int32Array(new SharedArrayBuffer(8));
  let dispatchSerial = 0,
    dispatchAuthority = null;
  const observations = new WeakMap();
  let worker,
    provider,
    stopping = false,
    exited = false,
    readySeen = false,
    sequence = 0,
    lastRpc = 0,
    pendingBytes = 0,
    rpcCount = 0,
    startup,
    escalation,
    resolveReady,
    rejectReady,
    resolveClosed;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const active = () => {
    if (stopping || exited || Atomics.load(revoked, 0)) throw fail();
    getPrivacyContext(handle);
    getPrivacyContext(rpcHandle);
  };
  function close() {
    if (stopping) return;
    stopping = true;
    Atomics.store(revoked, 0, 1);
    scope.signal.removeEventListener('abort', close);
    scope.close();
    clearTimeout(startup);
    rejectReady(fail());
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(fail());
    }
    pending.clear();
    pendingBytes = 0;
    try {
      worker?.postMessage({ type: 'close' });
    } catch {
      /* Exit is observed separately. */
    }
    if (worker && !exited)
      escalation = setTimeout(() => {
        worker.terminate().catch(() => {});
      }, 2000);
    try {
      onClose();
    } catch {
      /* The capability is already revoked. */
    }
  }
  function finish(exitCode) {
    if (exited) return;
    exited = true;
    close();
    clearTimeout(escalation);
    owners.delete(filename);
    resolveClosed(Object.freeze({ exitCode }));
  }
  scope.signal.addEventListener('abort', close, { once: true });
  async function message(value) {
    try {
      if (stopping || exited) return;
      active();
      if (shape(value, ['type']) && value.type === 'ready' && !readySeen) {
        readySeen = true;
        clearTimeout(startup);
        resolveReady();
        return;
      }
      if (
        shape(value, ['type', 'id', 'wire']) &&
        value.type === 'reply' &&
        readySeen &&
        Number.isSafeInteger(value.id) &&
        pending.has(value.id) &&
        typeof value.wire === 'string' &&
        Buffer.byteLength(value.wire) <= MAX_MESSAGE
      ) {
        const call = pending.get(value.id);
        pending.delete(value.id);
        pendingBytes -= call.bytes;
        clearTimeout(call.timer);
        call.resolve(value.wire);
        return;
      }
      if (
        shape(value, ['type', 'id', 'wire']) &&
        value.type === 'rpc' &&
        readySeen &&
        value.id === lastRpc + 1 &&
        rpcCount < 8 &&
        typeof value.wire === 'string' &&
        Buffer.byteLength(value.wire) <= 65536
      ) {
        lastRpc = value.id;
        rpcCount++;
        try {
          const request = JSON.parse(value.wire);
          if (
            !shape(request, ['method', 'params']) ||
            !READS.has(request.method) ||
            !Array.isArray(request.params)
          )
            throw fail();
          const result = await scope.run(rpcHandle, () =>
            provider.request(request, { signal: scope.signal })
          );
          active();
          const wire = JSON.stringify(result);
          if (wire === undefined || Buffer.byteLength(wire) > MAX_MESSAGE) throw fail();
          worker.postMessage({ type: 'rpcReply', id: value.id, wire });
        } finally {
          rpcCount--;
        }
        return;
      }
      throw fail();
    } catch {
      close();
    }
  }
  const secret = new Uint8Array(storage.key);
  try {
    provider = createProvider({ handle: rpcHandle, signal: scope.signal });
    if (typeof provider?.request !== 'function' || provider.signal !== scope.signal) throw fail();
    active();
    worker = new Worker(path.join(__dirname, 'railgun-session-worker-entry.js'), {
      workerData: {
        profileId: context.profileId,
        subject,
        requirements: context.requirements,
        storage: {
          filename,
          key: secret,
          binding: storage.binding,
          create: storage.create === true,
          format: 'paged-v2',
        },
        revoked: revoked.buffer,
      },
      transferList: [secret.buffer],
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on('message', message);
    worker.once('error', close);
    worker.once('messageerror', close);
    worker.once('exit', finish);
    startup = setTimeout(close, 30000);
  } catch {
    if (secret.byteLength) secret.fill(0);
    close();
    if (!worker) finish(null);
    throw fail();
  }
  function enqueue(type, wire) {
    try {
      active();
      if (typeof wire !== 'string' || wire.length > MAX_MESSAGE) throw fail();
      const bytes = Buffer.byteLength(wire);
      if (bytes > MAX_MESSAGE || pending.size >= 8 || pendingBytes + bytes > MAX_PENDING_BYTES)
        throw fail();
      const id = ++sequence;
      pendingBytes += bytes;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, bytes, timer: setTimeout(close, 30000) });
      });
      ready
        .then(() => {
          if (!stopping && pending.has(id)) worker.postMessage({ type, id, wire });
        })
        .catch(close);
      return promise;
    } catch {
      close();
      return Promise.reject(fail());
    }
  }
  function claimDispatch() {
    active();
    if (dispatchAuthority || dispatchSerial || pending.size) throw fail();
    dispatchAuthority = Object.freeze({});
    return Object.freeze({ dispatch: (wire) => dispatch(wire, dispatchAuthority) });
  }
  function dispatch(wire, authority) {
    if (dispatchAuthority && authority !== dispatchAuthority) {
      close();
      return Promise.reject(fail());
    }
    dispatchSerial++;
    return enqueue('dispatch', wire);
  }
  const unavailable = (code) => Object.assign(new Error('Railgun frontier unavailable'), { code });
  function assertFresh(observation) {
    active();
    const record = observations.get(observation);
    if (
      !record ||
      pending.size ||
      record.serial !== dispatchSerial ||
      record.revision !== Atomics.load(revoked, 1)
    )
      throw unavailable('RAILGUN_FRONTIER_STALE');
  }
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  async function inspect(request) {
    const serial = dispatchSerial;
    const wire = await enqueue('inspect', JSON.stringify(request));
    const reply = JSON.parse(wire);
    if (reply.error) {
      if (
        ![
          'RAILGUN_FRONTIER_BUSY',
          'RAILGUN_FRONTIER_STALE',
          'RAILGUN_FRONTIER_NOT_ELIGIBLE',
        ].includes(reply.error)
      ) {
        close();
        throw fail();
      }
      throw unavailable(reply.error);
    }
    if (
      !shape(reply, ['observation', 'revision', 'value']) ||
      !Number.isSafeInteger(reply.observation) ||
      !Number.isInteger(reply.revision) ||
      reply.revision < 0 ||
      !reply.value ||
      serial !== dispatchSerial ||
      reply.revision !== Atomics.load(revoked, 1)
    )
      throw unavailable('RAILGUN_FRONTIER_STALE');
    const value = freeze(reply.value);
    observations.set(value, {
      id: reply.observation,
      revision: reply.revision,
      serial,
      kind: request.method,
    });
    assertFresh(value);
    return value;
  }
  const inspectPublicState = () => inspect({ method: 'publicState' });
  const inspectWalletState = () => inspect({ method: 'walletState' });
  const inspectStoreIdentity = () => inspect({ method: 'storeIdentity' });
  const inspectFrontier = () => inspect({ method: 'frontier' });
  function inspectPosition(frontier, position) {
    assertFresh(frontier);
    const record = observations.get(frontier);
    if (record.kind !== 'frontier') throw unavailable('RAILGUN_FRONTIER_NOT_ELIGIBLE');
    return inspect({ method: 'position', observation: record.id, position });
  }
  return Object.freeze({
    ready,
    closed,
    dispatch,
    claimDispatch,
    close,
    signal: scope.signal,
    inspectFrontier,
    inspectStoreIdentity,
    inspectPublicState,
    inspectWalletState,
    inspectPosition,
    assertFresh,
  });
}
module.exports = { startRailgunSessionWorker };
