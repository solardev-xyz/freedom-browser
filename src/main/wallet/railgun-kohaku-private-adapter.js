/** Restricted host-relative transaction interface. Trusted host code owns all
 * cryptography, durable state and authority; this adapter issues none of those.
 */
const assert = require('assert/strict');
const { isProxy, isPromise } = require('util').types;
const pins = require('./railgun-shield-pins.json');
const { getAddress } = require('ethers');
const { normalizeRailgunKohakuReadFilter } = require('./railgun-kohaku-read-data');
const instances = new WeakMap(),
  adopted = new WeakSet();
const MAX = BigInt(pins.maxQualificationAmount),
  U120 = 1n << 120n;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const refusal = () =>
  Object.assign(new Error('Kohaku private adapter unavailable'), {
    code: 'RAILGUN_KOHAKU_PRIVATE_ADAPTER_REFUSED',
  });
const recovery = () => Object.freeze({ status: 'recovery-required', stage: 'adapter-contract' });
function shape(value, keys) {
  assert.ok(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys)
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function array(value, max) {
  assert.ok(
    Array.isArray(value) && !isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
  );
  assert.ok(value.length <= max && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++)
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)) || {}, 'value'));
}
function nativePromise(value) {
  // Observe rejected real Promises even when their shape violates the contract.
  if (isPromise(value) && !isProxy(value))
    observe(
      value,
      () => {},
      () => {}
    );
  assert.ok(isPromise(value) && !isProxy(value));
  assert.equal(Object.getPrototypeOf(value), Promise.prototype);
  assert.equal(Reflect.ownKeys(value).length, 0);
  return value;
}
function observe(promise, yes, no) {
  return Promise.prototype.then.call(promise, yes, no);
}
function hex(value, size) {
  assert.equal(typeof value, 'string');
  assert.match(value, new RegExp(`^0x[0-9a-fA-F]{${size}}$`));
  return value;
}
function asset(value) {
  assert.ok(value && !isProxy(value));
  const kind = Object.getOwnPropertyDescriptor(value, '__type');
  assert.ok(kind && Object.hasOwn(kind, 'value'));
  const type = kind.value;
  assert.ok(['native', 'erc20', 'erc721'].includes(type));
  shape(
    value,
    type === 'native'
      ? ['__type']
      : type === 'erc20'
        ? ['__type', 'contract']
        : ['__type', 'contract', 'tokenId']
  );
  const result = { __type: type };
  if (type !== 'native') result.contract = hex(value.contract, 40);
  if (type === 'erc721') {
    assert.ok(
      typeof value.tokenId === 'bigint' && value.tokenId >= 0n && value.tokenId < 1n << 256n
    );
    result.tokenId = value.tokenId;
  }
  return result;
}
function filter(value) {
  if (value === undefined) return undefined;
  array(value, 1000);
  const result = value.map(asset);
  normalizeRailgunKohakuReadFilter(result);
  return Object.freeze(result.map(Object.freeze));
}
function amount(value, max = U120 * 10000n) {
  assert.ok(typeof value === 'bigint' && value >= 0n && value < max);
  return value;
}
function resultRead(method, value) {
  if (method === 'instanceId') {
    assert.equal(typeof value, 'string');
    assert.match(value, /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/);
    return value;
  }
  array(value, 10000);
  const ids = new Set();
  return value.map((record) => {
    if (method === 'balance') {
      shape(record, ['asset', 'amount', 'tag']);
      assert.equal(record.tag, 'unverified');
      return { asset: asset(record.asset), amount: amount(record.amount), tag: record.tag };
    }
    shape(record, [
      'id',
      'tree',
      'position',
      'txid',
      'hash',
      'tokenHash',
      'asset',
      'amount',
      'tag',
      'spentTxid',
    ]);
    assert.ok(Number.isSafeInteger(record.tree) && record.tree >= 0 && record.tree < 256);
    assert.ok(
      Number.isSafeInteger(record.position) && record.position >= 0 && record.position < 65536
    );
    assert.equal(record.id, `${record.tree}:${record.position}`);
    assert.ok(!ids.has(record.id));
    ids.add(record.id);
    assert.equal(record.tag, 'unverified');
    const copiedAsset = asset(record.asset),
      copiedAmount = amount(record.amount, U120);
    if (copiedAsset.__type === 'erc721') assert.equal(copiedAmount, 1n);
    assert.ok(BigInt(hex(record.hash, 64)) < FIELD);
    return {
      id: record.id,
      tree: record.tree,
      position: record.position,
      txid: hex(record.txid, 64),
      hash: record.hash,
      tokenHash: hex(record.tokenHash, 64),
      asset: copiedAsset,
      amount: copiedAmount,
      tag: record.tag,
      spentTxid: record.spentTxid === false ? false : hex(record.spentTxid, 64),
    };
  });
}
function input(value, recipient, options, unshield) {
  shape(value, ['asset', 'amount', 'noteId']);
  const copiedAsset = asset(value.asset);
  assert.equal(copiedAsset.__type, 'erc20');
  assert.ok(typeof value.amount === 'bigint' && value.amount > 0n && value.amount <= MAX);
  assert.equal(typeof value.noteId, 'string');
  assert.match(value.noteId, /^(0|[1-9][0-9]{0,2}):(0|[1-9][0-9]{0,4})$/);
  const [tree, position] = value.noteId.split(':').map(Number);
  assert.ok(tree < 256 && position < 65536);
  if (unshield) {
    hex(recipient, 40);
    assert.ok(BigInt(recipient) > 0n);
    if (options !== undefined) shape(options, []);
  } else resultRead('instanceId', recipient);
  return [
    Object.freeze({
      asset: Object.freeze(copiedAsset),
      amount: value.amount,
      noteId: value.noteId,
    }),
    recipient,
    ...(unshield ? [options === undefined ? undefined : Object.freeze({})] : []),
  ];
}
function outcome(value) {
  assert.ok(value && !isProxy(value));
  if (Object.hasOwn(value, 'transactionHash')) {
    shape(value, ['transactionHash', 'submissionStatus']);
    assert.match(value.transactionHash, /^0x[0-9a-f]{64}$/);
    assert.equal(value.submissionStatus, 'unknown');
  } else if (Object.hasOwn(value, 'status')) {
    shape(value, ['status', 'stage']);
    assert.equal(value.status, 'recovery-required');
    assert.ok(
      [
        'completion',
        'recovery',
        'proof',
        'preflight',
        'eoa',
        'submission',
        'kohaku',
        'review-draining',
      ].includes(value.stage)
    );
  } else {
    shape(value, [
      'hash',
      'nonce',
      'from',
      'to',
      'value',
      'chainId',
      'broadcastSource',
      'explorerUrl',
    ]);
    assert.match(value.hash, /^0x[0-9a-f]{64}$/);
    getAddress(hex(value.from, 40));
    getAddress(hex(value.to, 40));
    assert.ok(Number.isSafeInteger(value.nonce) && value.nonce >= 0);
    assert.equal(value.value, '0');
    assert.equal(value.chainId, pins.chainId);
    assert.equal(value.broadcastSource, 'direct');
    if (value.explorerUrl !== null) {
      assert.ok(typeof value.explorerUrl === 'string' && value.explorerUrl.length <= 4096);
      assert.equal(new URL(value.explorerUrl).protocol, 'https:');
    }
  }
  // Preserve the original host settlement identity; shape is not authority.
  return value;
}
function checkedOutcome(value) {
  try {
    return outcome(value);
  } catch {
    // A single canonical own-data hash is the only uncertainty we can salvage.
    // Never invoke accessors or choose between conflicting hash fields.
    if (value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype) {
      const hash = Object.getOwnPropertyDescriptor(value, 'hash');
      const transactionHash = Object.getOwnPropertyDescriptor(value, 'transactionHash');
      const one =
        hash && !transactionHash ? hash : transactionHash && !hash ? transactionHash : null;
      if (
        one &&
        Object.hasOwn(one, 'value') &&
        typeof one.value === 'string' &&
        /^0x[0-9a-f]{64}$/.test(one.value)
      )
        return Object.freeze({ transactionHash: one.value, submissionStatus: 'unknown' });
    }
    return recovery();
  }
}
function createRailgunKohakuPrivateAdapter(options) {
  try {
    return create(options);
  } catch {
    throw refusal();
  }
}
function create(options) {
  shape(options, ['host', 'signal']);
  const { host, signal } = options;
  shape(host, [
    'signal',
    'closed',
    'instanceId',
    'balance',
    'notes',
    'prepareTransfer',
    'prepareUnshield',
    'broadcast',
    'close',
  ]);
  assert.ok(
    signal instanceof AbortSignal &&
      host.signal instanceof AbortSignal &&
      !signal.aborted &&
      !host.signal.aborted
  );
  assert.ok(!adopted.has(host));
  const methods = {};
  for (const name of [
    'instanceId',
    'balance',
    'notes',
    'prepareTransfer',
    'prepareUnshield',
    'broadcast',
    'close',
  ]) {
    assert.equal(typeof host[name], 'function');
    assert.ok(!isProxy(host[name]));
    methods[name] = host[name];
  }
  const hostClosed = nativePromise(host.closed),
    controller = new AbortController();
  const lifetime = AbortSignal.any([signal, host.signal]);
  let state = 'ready',
    closing = false,
    closeCalled = false,
    failed = false,
    hostSettled = false;
  let resolveClosed, rejectClosed;
  const closed = new Promise((yes, no) => {
    resolveClosed = yes;
    rejectClosed = no;
  });
  closed.catch(() => {});
  const aborters = new Set();
  const tasks = new Set(),
    tokens = new WeakMap(),
    handles = new WeakSet();
  let activeToken;
  const current = () => assert.ok(!closing && !lifetime.aborted);
  function finish() {
    if (!closing || tasks.size || !hostSettled || !closeCalled) return;
    lifetime.removeEventListener('abort', close);
    if (failed) rejectClosed(refusal());
    else resolveClosed();
  }
  function close() {
    if (closing) return;
    closing = true;
    state = 'closed';
    if (activeToken) tokens.delete(activeToken);
    activeToken = undefined;
    controller.abort();
    for (const stop of aborters) stop();
    aborters.clear();
    // Mark invocation before calling trusted reentrant host code.
    closeCalled = true;
    try {
      const value = methods.close.call(host);
      if (isPromise(value) && !isProxy(value)) {
        tasks.add(value);
        const settled = () => {
          tasks.delete(value);
          finish();
        };
        observe(value, settled, settled);
      }
      assert.equal(value, undefined);
    } catch {
      failed = true;
    }
    finish();
  }
  adopted.add(host);
  observe(
    hostClosed,
    (value) => {
      if (value !== undefined) failed = true;
      hostSettled = true;
      if (!closing) close();
      finish();
    },
    () => {
      failed = true;
      hostSettled = true;
      close();
      finish();
    }
  );
  function invoke(
    method,
    args,
    fulfilled,
    rejected = () => {
      throw refusal();
    }
  ) {
    // Reserve the whole validation/settlement chain before invoking host code.
    let yes, no;
    const raw = new Promise((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    const pending = raw.then((box) => fulfilled(box.value), rejected);
    tasks.add(pending);
    const settled = () => {
      tasks.delete(pending);
      finish();
    };
    observe(pending, settled, settled);
    try {
      const supplied = methods[method].apply(host, args);
      if (isPromise(supplied) && !isProxy(supplied)) {
        tasks.add(supplied);
        const done = () => {
          tasks.delete(supplied);
          finish();
        };
        observe(supplied, done, done);
      }
      observe(nativePromise(supplied), (value) => yes(Object.freeze({ value })), no);
    } catch {
      no(refusal());
    }
    return pending;
  }
  function outward(pending) {
    let stop;
    const aborted = new Promise((resolve, reject) => {
      stop = () => reject(refusal());
    });
    aborters.add(stop);
    const result = Promise.race([pending, aborted]).finally(() => aborters.delete(stop));
    if (closing) stop();
    result.catch(() => {});
    return result;
  }
  function read(method, args) {
    try {
      current();
      assert.equal(state, 'ready');
      const copied = method === 'instanceId' ? [] : [filter(args[0])];
      if (method === 'notes') {
        assert.ok(args[1] === undefined || typeof args[1] === 'boolean');
        copied.push(args[1]);
      }
      current();
      return outward(
        invoke(method, copied, (value) => {
          try {
            const result = resultRead(method, value);
            current();
            return result;
          } catch {
            throw refusal();
          }
        })
      );
    } catch {
      return Promise.reject(refusal());
    }
  }
  function prepare(method, value, recipient, opts) {
    try {
      current();
      assert.equal(state, 'ready');
      assert.equal(tasks.size, 0);
      const args = input(value, recipient, opts, method === 'prepareUnshield');
      current();
      state = 'preparing';
      return outward(
        invoke(
          method,
          args,
          (result) => {
            try {
              shape(result, ['handle']);
              shape(result.handle, []);
              assert.ok(Object.isFrozen(result.handle) && !handles.has(result.handle));
              handles.add(result.handle);
              current();
              const token = Object.freeze({ __type: 'privateOperation' });
              tokens.set(token, result.handle);
              activeToken = token;
              state = 'prepared';
              return token;
            } catch {
              close();
              throw refusal();
            }
          },
          () => {
            close();
            throw refusal();
          }
        )
      );
    } catch {
      return Promise.reject(refusal());
    }
  }
  function broadcast(token) {
    try {
      current();
      assert.equal(state, 'prepared');
      assert.ok(activeToken && token === activeToken && tokens.has(token));
      const handle = tokens.get(token);
      tokens.delete(token);
      activeToken = undefined;
      state = 'broadcasting';
      return invoke(
        'broadcast',
        [handle],
        (value) => {
          try {
            return checkedOutcome(value);
          } finally {
            close();
          }
        },
        () => {
          close();
          throw refusal();
        }
      );
    } catch {
      return Promise.reject(refusal());
    }
  }
  const adapter = Object.freeze({
    instanceId: () => read('instanceId', []),
    balance: (assets) => read('balance', [assets]),
    notes: (assets, includeSpent) => read('notes', [assets, includeSpent]),
    prepareTransfer: (value, to) => prepare('prepareTransfer', value, to),
    prepareUnshield: (value, to, opts) => prepare('prepareUnshield', value, to, opts),
    provenance: 'host-supplied',
    signal: controller.signal,
    close,
    closed,
  });
  instances.set(adapter, broadcast);
  lifetime.addEventListener('abort', close, { once: true });
  if (lifetime.aborted) close();
  return adapter;
}
function createRailgunKohakuPrivateAdapterBroadcaster(adapter) {
  const broadcast = instances.get(adapter);
  if (!broadcast) throw refusal();
  return Object.freeze({ broadcast });
}
module.exports = {
  createRailgunKohakuPrivateAdapter,
  createRailgunKohakuPrivateAdapterBroadcaster,
};
