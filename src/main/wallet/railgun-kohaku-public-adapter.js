/** Restricted public Shield trusted-host interface. Trusted host code owns all
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
  Object.assign(new Error('Kohaku public adapter unavailable'), {
    code: 'RAILGUN_KOHAKU_PUBLIC_ADAPTER_REFUSED',
  });
const contract = () =>
  Object.assign(new Error('Kohaku public submission contract failed'), {
    code: 'RAILGUN_KOHAKU_PUBLIC_ADAPTER_CONTRACT',
    submissionMayHaveOccurred: true,
  });
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
function input(value, to) {
  shape(value, ['asset', 'amount']);
  shape(value.asset, ['__type']);
  assert.equal(value.asset.__type, 'native');
  assert.ok(typeof value.amount === 'bigint' && value.amount > 0n && value.amount <= MAX);
  if (to !== undefined) resultRead('instanceId', to);
  return Object.freeze({ asset: Object.freeze({ __type: 'native' }), amount: value.amount });
}
function acknowledged(value, expectedAmount) {
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
  assert.equal(value.value, expectedAmount);
  assert.equal(value.chainId, pins.chainId);
  assert.equal(value.broadcastSource, 'direct');
  if (value.explorerUrl !== null) {
    assert.ok(typeof value.explorerUrl === 'string' && value.explorerUrl.length <= 4096);
    assert.equal(new URL(value.explorerUrl).protocol, 'https:');
  }
  return value;
}
function createRailgunKohakuPublicAdapter(options) {
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
    'prepareShield',
    'submit',
    'close',
  ]);
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(host.signal instanceof AbortSignal && !host.signal.aborted);
  assert.ok(!adopted.has(host));
  const methods = {};
  for (const name of ['instanceId', 'balance', 'notes', 'prepareShield', 'submit', 'close']) {
    assert.equal(typeof host[name], 'function');
    assert.ok(!isProxy(host[name]));
    methods[name] = host[name];
  }
  const hostClosed = nativePromise(host.closed);
  const lifetime = AbortSignal.any([signal, host.signal]);
  const controller = new AbortController(),
    tasks = new Set(),
    tokens = new WeakMap();
  let state = 'ready',
    closing = false,
    closeCalled = false,
    hostSettled = false,
    failed = false;
  let activeToken, expectedAmount, resolveClosed, rejectClosed;
  const closed = new Promise((yes, no) => {
    resolveClosed = yes;
    rejectClosed = no;
  });
  closed.catch(() => {});
  const current = () => assert.ok(!closing && !lifetime.aborted);
  function finish() {
    if (!closing || !closeCalled || !hostSettled || tasks.size) return;
    lifetime.removeEventListener('abort', close);
    if (failed) rejectClosed(refusal());
    else resolveClosed();
  }
  function track(promise) {
    tasks.add(promise);
    const settled = () => {
      tasks.delete(promise);
      finish();
    };
    try {
      observe(promise, settled, settled);
    } catch (error) {
      // A hostile constructor/species can prevent native observation. We cannot
      // establish drainage for that promise: closed must reject, never succeed.
      tasks.delete(promise);
      failed = true;
      close();
      throw error;
    }
  }
  function close() {
    if (closing) return;
    closing = true;
    state = 'closed';
    if (activeToken) tokens.delete(activeToken);
    activeToken = undefined;
    controller.abort();
    closeCalled = true;
    try {
      const result = methods.close.call(host);
      if (isPromise(result) && !isProxy(result)) track(result);
      assert.equal(result, undefined);
    } catch {
      failed = true;
    }
    finish();
  }
  // Track a real supplied promise BEFORE shape validation. Contract refusal is
  // outward only: a malformed pending promise still retains logical drainage.
  function invoke(method, args, fulfilled, rejected, malformed) {
    let yes, no;
    const raw = new Promise((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    const pending = raw.then((box) => fulfilled(box.value), rejected);
    track(pending);
    let supplied;
    try {
      supplied = methods[method].apply(host, args);
    } catch (error) {
      no(error);
      return pending;
    }
    try {
      if (isPromise(supplied) && !isProxy(supplied)) track(supplied);
      nativePromise(supplied);
      // No Promise resolution with untrusted host data: a late-added then getter
      // must not run before our own-data validation.
      observe(supplied, (value) => yes(Object.freeze({ value })), no);
    } catch {
      // Observation failures are post-admission contract violations, not a
      // pre-admission refusal. Always settle our own tracked admission promise.
      no(malformed());
    }
    return pending;
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
      return invoke(
        method,
        copied,
        (value) => {
          try {
            const result = resultRead(method, value);
            current();
            return result;
          } catch {
            throw refusal();
          }
        },
        () => {
          throw refusal();
        },
        refusal
      );
    } catch {
      return Promise.reject(refusal());
    }
  }
  function prepareShield(value, to) {
    try {
      current();
      assert.equal(state, 'ready');
      assert.equal(tasks.size, 0);
      const copied = input(value, to);
      current();
      expectedAmount = copied.amount.toString();
      state = 'preparing';
      return invoke(
        'prepareShield',
        [copied, to],
        (value) => {
          try {
            shape(value, ['handle']);
            shape(value.handle, []);
            assert.ok(Object.isFrozen(value.handle));
            current();
            const token = Object.freeze({ __type: 'publicOperation' });
            tokens.set(token, value.handle);
            activeToken = token;
            state = 'prepared';
            return token;
          } catch {
            close();
            throw refusal();
          }
        },
        (error) => {
          close();
          throw error;
        },
        refusal
      );
    } catch {
      return Promise.reject(refusal());
    }
  }
  function submit(token) {
    try {
      current();
      assert.equal(state, 'prepared');
      assert.ok(activeToken && token === activeToken && tokens.has(token));
      const handle = tokens.get(token);
      tokens.delete(token);
      activeToken = undefined;
      state = 'submitting';
      return invoke(
        'submit',
        [handle],
        (value) => {
          try {
            return acknowledged(value, expectedAmount);
          } catch {
            throw contract();
          } finally {
            close();
          }
        },
        (error) => {
          close();
          throw error;
        },
        contract
      );
    } catch {
      return Promise.reject(refusal());
    }
  }
  const adapter = Object.freeze({
    instanceId: () => read('instanceId', []),
    balance: (assets) => read('balance', [assets]),
    notes: (assets, includeSpent) => read('notes', [assets, includeSpent]),
    prepareShield,
    provenance: 'host-supplied',
    signal: controller.signal,
    closed,
    close,
  });
  instances.set(adapter, submit);
  adopted.add(host);
  observe(
    hostClosed,
    (value) => {
      if (value !== undefined) failed = true;
      hostSettled = true;
      close();
      finish();
    },
    () => {
      failed = true;
      hostSettled = true;
      close();
      finish();
    }
  );
  lifetime.addEventListener('abort', close, { once: true });
  if (lifetime.aborted) close();
  return adapter;
}
function createRailgunKohakuPublicAdapterSubmitter(adapter) {
  const submit = instances.get(adapter);
  if (!submit) throw refusal();
  return Object.freeze({ submit });
}
module.exports = { createRailgunKohakuPublicAdapter, createRailgunKohakuPublicAdapterSubmitter };
