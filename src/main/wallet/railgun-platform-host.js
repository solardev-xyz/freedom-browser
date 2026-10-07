/** Main-only OS port for the future Railgun owner. No protocol, key admission,
 * broker, deadline or closure claims live here. Entry stubs are deliberately not
 * supplied in this prerequisite: absent fixed entries fail closed at spawn.
 */
const path = require('path');
const { types } = require('util');
const { EventEmitter } = require('events');
const { isMainThread, Worker } = require('worker_threads');
const kill = process.kill;
const platform = process.platform;
const on = EventEmitter.prototype.on;
const once = EventEmitter.prototype.once;
const Controller = AbortController;
const abort = AbortController.prototype.abort;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const typedLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const typedOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset').get;
const arrayLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const sharedLength = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get;
let originals;
const fail = () =>
  Object.assign(new Error('Railgun platform unavailable'), {
    code: 'RAILGUN_PLATFORM_REFUSED',
  });

function record(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) throw fail();
  const result = {};
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) throw fail();
    result[key] = field.value;
  }
  return result;
}
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;

function storageInput(input) {
  const { workerData: raw, transferList } = record(input, ['workerData', 'transferList']);
  if (!raw || types.isProxy(raw)) throw fail();
  const readOnly = Object.hasOwn(raw, 'readOnly');
  const data = record(raw, [
    'profileId',
    'subject',
    'requirements',
    'storage',
    'revoked',
    ...(readOnly ? ['readOnly'] : []),
  ]);
  const subject = record(data.subject, [
    'kind',
    'principal',
    'chainId',
    'protocol',
    'deployment',
    'role',
  ]);
  const requirements = record(data.requirements, ['origin', 'content', 'correctness', 'maxAgeMs']);
  const storage = record(data.storage, ['filename', 'key', 'binding', 'create', 'format']);
  if (
    !text(data.profileId) ||
    subject.kind !== 'private-account' ||
    typeof subject.principal !== 'string' ||
    !/^railgun:(0|[1-9][0-9]{0,4})$/.test(subject.principal) ||
    Number(subject.principal.slice(8)) > 65535 ||
    subject.chainId !== 11155111 ||
    subject.protocol !== 'railgun' ||
    subject.deployment !== 'sepolia' ||
    subject.role !== 'engine' ||
    requirements.origin !== 'tor' ||
    !['public', 'pir'].includes(requirements.content) ||
    !['any', 'quorum', 'proof'].includes(requirements.correctness) ||
    (requirements.maxAgeMs !== null &&
      !integer(requirements.maxAgeMs, 0, Number.MAX_SAFE_INTEGER)) ||
    typeof storage.filename !== 'string' ||
    !path.isAbsolute(storage.filename) ||
    path.resolve(storage.filename) !== storage.filename ||
    typeof storage.binding !== 'string' ||
    !/^[0-9a-f]{64}$/.test(storage.binding) ||
    typeof storage.create !== 'boolean' ||
    storage.format !== 'paged-v2' ||
    (readOnly && (data.readOnly !== true || storage.create))
  )
    throw fail();
  const key = storage.key;
  if (
    !types.isUint8Array(key) ||
    types.isProxy(key) ||
    Object.getPrototypeOf(key) !== Uint8Array.prototype ||
    Reflect.ownKeys(key).length !== 32 ||
    typedLength.call(key) !== 32 ||
    typedOffset.call(key) !== 0
  )
    throw fail();
  const buffer = typedBuffer.call(key);
  if (
    !types.isArrayBuffer(buffer) ||
    arrayLength.call(buffer) !== 32 ||
    Reflect.ownKeys(buffer).length ||
    !types.isSharedArrayBuffer(data.revoked) ||
    sharedLength.call(data.revoked) !== 8 ||
    Reflect.ownKeys(data.revoked).length
  )
    throw fail();
  if (
    !Array.isArray(transferList) ||
    types.isProxy(transferList) ||
    Object.getPrototypeOf(transferList) !== Array.prototype ||
    Reflect.ownKeys(transferList).length !== 2
  )
    throw fail();
  const transfer = Object.getOwnPropertyDescriptor(transferList, '0');
  if (
    !transfer ||
    !Object.hasOwn(transfer, 'value') ||
    transfer.value !== buffer ||
    transferList.length !== 1
  )
    throw fail();
  return {
    workerData: {
      profileId: data.profileId,
      subject,
      requirements,
      ...(readOnly ? { readOnly: true } : {}),
      storage,
      revoked: data.revoked,
    },
    transferList: [buffer],
  };
}

function capture() {
  if (!originals) {
    const { app, utilityProcess, MessageChannelMain } = require('electron');
    const lifetime = new Controller();
    // Freedom shutdown is one-way. This notification cannot be reset or used to
    // prevent quit; the package retains original child drainage and release.
    once.call(app, 'before-quit', () => abort.call(lifetime));
    originals = Object.freeze({
      app,
      lifetime: lifetime.signal,
      utilityProcess,
      Channel: MessageChannelMain,
      ready: app.isReady,
      temp: app.getPath,
      metrics: app.getAppMetrics,
      fork: utilityProcess.fork,
    });
  }
  return originals;
}

function createRailgunPlatformHost(...args) {
  if (args.length || !isMainThread || (process.type !== undefined && process.type !== 'browser'))
    throw fail();
  const original = capture();
  const children = new WeakMap();
  const ready = () => {
    if (!original.ready.call(original.app)) throw fail();
  };
  return Object.freeze({
    applicationLifetime(...args) {
      if (args.length) throw fail();
      return original.lifetime;
    },
    spawnUtility(input, ...extra) {
      const { entry, heapMb } = record(input, ['entry', 'heapMb']);
      if (extra.length || entry !== 'railgun-utility-v1' || !integer(heapMb, 16, 1024))
        throw fail();
      ready();
      // Fixed host composition: guard installation precedes context/artifact bindings.
      const filename = require.resolve('./railgun-owner-utility-entry');
      const child = original.fork.call(original.utilityProcess, filename, [], {
        env: Object.fromEntries(Object.keys(process.env).map((key) => [key, ''])),
        cwd: original.temp.call(original.app, 'temp'),
        stdio: 'ignore',
        execArgv: [`--max-old-space-size=${heapMb}`],
        serviceName: 'Freedom Railgun engine',
      });
      const state = { pid: null, exited: false, kill: child.kill };
      children.set(child, state);
      const started = () => {
        if (state.pid === null && integer(child.pid, 1, Number.MAX_SAFE_INTEGER))
          state.pid = child.pid;
      };
      started();
      on.call(child, 'spawn', started);
      on.call(child, 'exit', () => {
        state.exited = true;
      });
      return child;
    },
    createUtilityChannel(...args) {
      if (args.length) throw fail();
      ready();
      return new original.Channel();
    },
    memorySamples(...args) {
      if (args.length) throw fail();
      ready();
      return original.metrics.call(original.app);
    },
    terminateUtility(child, signal, ...extra) {
      const state = children.get(child);
      if (
        extra.length ||
        !state ||
        state.exited ||
        !['SIGTERM', 'SIGKILL'].includes(signal) ||
        !integer(state.pid, 1, Number.MAX_SAFE_INTEGER) ||
        child.pid !== state.pid
      )
        throw fail();
      if (platform === 'win32' && signal === 'SIGTERM') return state.kill.call(child);
      return kill.call(process, state.pid, signal);
    },
    spawnStorageWorker(input, ...extra) {
      if (extra.length) throw fail();
      const options = storageInput(input);
      // Worker-local context only; never a main owner facade or legacy fallback.
      const filename = require.resolve('./railgun-owner-storage-entry');
      const worker = new Worker(filename, {
        ...options,
        env: {},
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      worker.stdout.resume();
      worker.stderr.resume();
      return worker;
    },
  });
}
module.exports = { createRailgunPlatformHost };
