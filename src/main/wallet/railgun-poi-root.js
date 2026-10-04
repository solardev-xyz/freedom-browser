/** Fixed-root service observation only. A proof-specific historical root can
 * correlate activity even without a note selector; its caller owns disclosure
 * authorization. No live/renderer caller, note query or submission is installed.
 */
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createWalletTorTransport } = require('../networks/wallet-tor-transport');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const POI_URL = 'https://ppoi.fdi.network';
const MAX_AGE_MS = 60000,
  ACQUIRE_TIMEOUT_MS = 15000,
  MAX_ACQUIRE_MS = 45000;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = (code = 'RAILGUN_POI_ROOT_REFUSED') =>
  Object.assign(new Error('Railgun POI root unavailable'), {
    code,
  });
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
function createRailgunPoiRootSource(options, txid = false) {
  shape(options, txid ? ['handle', 'root', 'index'] : ['handle', 'root']);
  const { handle, root, index } = options;
  assert.equal(typeof root, 'string');
  assert.match(root, /^[0-9a-f]{64}$/);
  assert.ok(BigInt('0x' + root) < FIELD);
  if (txid) assert.ok(Number.isSafeInteger(index) && index >= 0 && index < 8000);
  const rootFields = Object.freeze(
    txid ? { tree: 0, index, root } : { listKey: REQUIRED_LIST, root }
  );
  const context = getPrivacyContext(handle),
    { subject, requirements } = context;
  assert.ok(
    subject.kind === 'private-account' &&
      /^railgun:(0|[1-9][0-9]{0,4})$/.test(subject.principal) &&
      Number(subject.principal.slice(8)) <= 65535 &&
      subject.protocol === 'railgun' &&
      subject.deployment === 'sepolia' &&
      subject.chainId === 11155111 &&
      subject.role === 'poi' &&
      typeof subject.operation === 'string' &&
      /^poi:[0-9a-f]{64}$/.test(subject.operation) &&
      requirements.content === 'public' &&
      requirements.correctness === 'any' &&
      requirements.maxAgeMs === null
  );
  assert.ok(require('../settings-store').isWalletTorExperimentAvailable());
  const tor = require('../tor-manager'),
    endpoint = tor.getWalletSocksEndpoint();
  assert.ok(endpoint && !endpoint.signal.aborted);
  const controller = new AbortController();
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([context.signal, endpoint.signal, controller.signal]),
    isCurrent: () => tor.getWalletSocksEndpoint() === endpoint,
  });
  let scopedHandle, transport;
  try {
    scopedHandle = scope.getContext(subject);
    transport = createWalletTorTransport();
  } catch {
    scope.close();
    throw fail();
  }
  const receipts = new WeakMap();
  let busy = false,
    isClosed = false,
    sequence = 0,
    resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const drained = () => {
    if (isClosed && !busy) resolveClosed();
  };
  const close = () => {
    if (isClosed) return;
    isClosed = true;
    scope.signal.removeEventListener('abort', close);
    controller.abort();
    scope.close();
    try {
      transport.close();
    } finally {
      drained();
    }
  };
  scope.signal.addEventListener('abort', close, { once: true });
  const active = () => {
    assert.ok(!isClosed && !scope.signal.aborted);
    getPrivacyContext(handle);
    assert.equal(tor.getWalletSocksEndpoint(), endpoint);
  };
  async function acquire(options = {}) {
    let timeoutMs;
    try {
      active();
      shape(options, Object.hasOwn(options, 'timeoutMs') ? ['timeoutMs'] : []);
      ({ timeoutMs = ACQUIRE_TIMEOUT_MS } = options);
      assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_ACQUIRE_MS);
      assert.equal(busy, false);
    } catch {
      // Invalid/overlapping calls must not cancel an existing acquisition.
      throw fail();
    }
    busy = true;
    const current = ++sequence,
      started = performance.now(),
      id = randomUUID();
    const fresh = () => {
      active();
      const now = performance.now();
      assert.ok(now >= started && now - started < timeoutMs);
    };
    const timer = setTimeout(close, timeoutMs);
    timer.unref?.();
    let rejected = false;
    try {
      const response = await transport.request(scopedHandle, POI_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: txid ? 'ppoi_validate_txid_merkleroot' : 'ppoi_validate_poi_merkleroots',
          params: {
            chainType: '0',
            chainID: '11155111',
            txidVersion: 'V2_PoseidonMerkle',
            ...(txid
              ? { tree: 0, index, merkleroot: root }
              : { listKey: REQUIRED_LIST, poiMerkleroots: [root] }),
          },
        }),
        signal: scope.signal,
        timeoutMs,
      });
      fresh();
      assert.equal(response.status, 200);
      assert.ok(Buffer.isBuffer(response.body) && response.body.length <= 4096);
      const result = JSON.parse(response.body.toString('utf8'));
      shape(result, ['jsonrpc', 'id', 'result']);
      assert.equal(result.jsonrpc, '2.0');
      assert.equal(result.id, id);
      fresh();
      assert.equal(typeof result.result, 'boolean');
      if (!result.result) {
        rejected = true;
        throw fail();
      }
      const observation = Object.freeze({
        ...rootFields,
        accepted: true,
        observedAt: new Date().toISOString(),
        trust: 'unverified-service',
        membershipVerified: false,
        disclosureEnabled: false,
        spendingEnabled: false,
      });
      const receipt = Object.freeze({});
      receipts.set(receipt, { sequence: current, at: started, observation });
      return Object.freeze({ receipt, observation });
    } catch {
      close();
      throw fail(rejected ? 'RAILGUN_POI_ROOT_REJECTED' : undefined);
    } finally {
      clearTimeout(timer);
      busy = false;
      drained();
    }
  }
  function assertResult(receipt, minimumRemainingMs = 0) {
    active();
    assert.ok(
      Number.isSafeInteger(minimumRemainingMs) &&
        minimumRemainingMs >= 0 &&
        minimumRemainingMs < MAX_AGE_MS
    );
    const entry = receipts.get(receipt),
      now = performance.now();
    assert.ok(
      entry &&
        !busy &&
        entry.sequence === sequence &&
        now >= entry.at &&
        now - entry.at + minimumRemainingMs < MAX_AGE_MS
    );
    return entry.observation;
  }
  return Object.freeze({
    acquire,
    assertResult(receipt, margin) {
      try {
        return assertResult(receipt, margin);
      } catch {
        throw fail();
      }
    },
    close,
    closed,
    signal: scope.signal,
  });
}
module.exports = {
  createRailgunPoiRootSource(options) {
    try {
      return createRailgunPoiRootSource(options);
    } catch {
      throw fail();
    }
  },
  createRailgunPoiTxidRootSource(options) {
    try {
      return createRailgunPoiRootSource(options, true);
    } catch {
      throw fail();
    }
  },
  MAX_AGE_MS,
  ACQUIRE_TIMEOUT_MS,
  MAX_ACQUIRE_MS,
};
