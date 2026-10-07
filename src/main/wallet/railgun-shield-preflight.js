/** Fixed Sepolia deployment reads before shield review/signing. EIP-1898 pins
 * one latest block; acceptance is RPC consistency, not proof of chain state or
 * a guarantee that governance cannot change before transaction inclusion.
 */
const { Interface, id, toBeHex, keccak256 } = require('ethers');
const { isProxy } = require('util').types;
const { getPrivacyContext, createPrivacyScope } = require('../networks/privacy-context');
const { createPrivateRpc } = require('../networks/private-rpc');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([
  'function railgun() view returns (address)',
  'function wBase() view returns (address)',
  'function shieldFee() view returns (uint120)',
  'function tokenBlocklist(address) view returns (bool)',
]);
const fail = (reason = 'refused') =>
  Object.assign(new Error('Railgun shield deployment unavailable'), {
    code: 'RAILGUN_SHIELD_DEPLOYMENT_REFUSED',
    reason,
  });
const check = (v, reason) => {
  if (!v) throw fail(reason);
};
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const quantity = (v) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v);
const sources = new WeakMap();
const MAX_AGE_MS = 60000;
const MAX_BLOCK_AGE_SECONDS = 120;
// Floor from the reviewed Sepolia deployment qualification. This is a lower
// bound, not authenticated finality or a replacement for the public scan.
const MIN_BLOCK = 11833631n;
// Diagnostic only: never infer delivery or retry permission from a stage.
const CAUSE_STAGES = Object.freeze([
  'connect',
  'tls',
  'socket-new',
  'socket-reused',
  'response',
  'unclassified',
]);
function own(error, key) {
  if (!error || typeof error !== 'object' || isProxy(error)) return undefined;
  const property = Object.getOwnPropertyDescriptor(error, key);
  return property && Object.hasOwn(property, 'value') ? property.value : undefined;
}
function causeStage(error, key) {
  const stage = own(error, key);
  return CAUSE_STAGES.includes(stage) ? stage : undefined;
}
function createRailgunShieldPreflight(enrollment, options = {}) {
  check(
    options &&
      !require('util').types.isProxy(options) &&
      Object.getPrototypeOf(options) === Object.prototype
  );
  check(Reflect.ownKeys(options).every((key) => key === 'destinationConstraint'));
  check(
    !Object.hasOwn(options, 'destinationConstraint') ||
      Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'destinationConstraint'), 'value')
  );
  const { destinationConstraint } = options;
  check(isRailgunAccountEnrollment(enrollment) && !enrollment.signal.aborted);
  const parent = enrollment.getContext('protocol-rpc', 'shield-preflight');
  const context = getPrivacyContext(parent);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: enrollment.signal,
    isCurrent: () => {
      try {
        getPrivacyContext(parent);
        return true;
      } catch {
        return false;
      }
    },
  });
  const handle = scope.getContext(context.subject);
  let rpc;
  try {
    rpc = createPrivateRpc(
      handle,
      'protocol-rpc',
      ...(destinationConstraint !== undefined ? [{ destinationConstraint }] : [])
    );
  } catch (error) {
    scope.close();
    throw error;
  }
  const receipts = new WeakMap();
  let closed = false,
    busy = false,
    sequence = 0;
  const active = () => {
    try {
      check(!closed && !enrollment.signal.aborted);
      getPrivacyContext(handle);
      rpc.assertActive();
    } catch {
      throw fail('inactive');
    }
  };
  const close = () => {
    if (!closed) {
      closed = true;
      rpc.signal.removeEventListener('abort', close);
      scope.close();
      rpc.release();
    }
  };
  rpc.signal.addEventListener('abort', close, { once: true });
  async function acquire() {
    active();
    check(!busy);
    busy = true;
    const current = ++sequence;
    const started = performance.now();
    let step = 'anchor';
    const fresh = () => {
      const now = performance.now();
      check(now >= started && now - started < MAX_AGE_MS, 'stale');
    };
    const read = async (method, params, validate) => {
      fresh();
      let response;
      try {
        response = await rpc.request(method, params, validate);
      } catch (error) {
        active();
        const code = own(error, 'code');
        const stage = code === 'TOR_REQUEST_FAILED' ? causeStage(error, 'stage') : undefined;
        throw Object.assign(fail('rpc'), {
          causeCode:
            typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'UNCLASSIFIED',
          ...(stage === undefined ? {} : { causeStage: stage }),
        });
      }
      active();
      fresh();
      check(validate(response.result));
      return response.result;
    };
    try {
      const header = await read(
        'eth_getBlockByNumber',
        ['latest', false],
        (v) => v && quantity(v.number) && hash(v.hash) && quantity(v.timestamp)
      );
      const wallSeconds = BigInt(Math.floor(Date.now() / 1000));
      const timestamp = BigInt(header.timestamp);
      check(BigInt(header.number) >= MIN_BLOCK, 'stale');
      check(
        timestamp <= wallSeconds + 30n && timestamp >= wallSeconds - BigInt(MAX_BLOCK_AGE_SECONDS),
        'stale'
      );
      const anchor = Object.freeze({
        number: header.number,
        hash: header.hash,
        timestamp: header.timestamp,
      });
      const block = { blockHash: anchor.hash, requireCanonical: true };
      for (const name of ['proxy', 'relayAdapt', 'wrappedNative', 'implementation']) {
        step = 'code-' + name;
        const code = await read(
          'eth_getCode',
          [pins[name], block],
          (v) => typeof v === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(v) && v.length <= 131074
        );
        check(keccak256(code) === pins.codeHashes[name], 'mismatch');
      }
      for (const [name, expected] of [
        ['implementation', '0x' + pins.implementation.slice(2).padStart(64, '0')],
        ['paused', '0x' + '0'.repeat(64)],
      ]) {
        step = 'slot-' + name;
        const slot = toBeHex(BigInt(id('eip1967.proxy.' + name)) - 1n, 32);
        check(
          (await read('eth_getStorageAt', [pins.proxy, slot, block], hash)) === expected,
          'mismatch'
        );
      }
      for (const [to, method, args, expected] of [
        [pins.relayAdapt, 'railgun', [], pins.proxy],
        [pins.relayAdapt, 'wBase', [], pins.wrappedNative],
        [pins.proxy, 'shieldFee', [], BigInt(pins.shieldFeeBps)],
        [pins.proxy, 'tokenBlocklist', [pins.wrappedNative], false],
      ]) {
        step = 'getter-' + method;
        const encoded = await read(
          'eth_call',
          [{ to, data: abi.encodeFunctionData(method, args) }, block],
          hash
        );
        const decoded = abi.decodeFunctionResult(method, encoded);
        check(abi.encodeFunctionResult(method, decoded).toLowerCase() === encoded, 'mismatch');
        check(
          (typeof decoded[0] === 'string' ? decoded[0].toLowerCase() : decoded[0]) === expected,
          'mismatch'
        );
      }
      step = 'anchor-recheck';
      const reread = await read(
        'eth_getBlockByNumber',
        [anchor.number, false],
        (v) => v && quantity(v.number) && hash(v.hash) && quantity(v.timestamp)
      );
      check(
        reread.number === anchor.number &&
          reread.hash === anchor.hash &&
          reread.timestamp === anchor.timestamp,
        'stale'
      );
      active();
      fresh();
      const observation = Object.freeze({
        anchor,
        shieldFeeBps: pins.shieldFeeBps,
        deploymentMatched: true,
        trust: 'unverified-rpc',
        signingEnabled: false,
      });
      const receipt = Object.freeze({});
      receipts.set(receipt, { observation, at: started, sequence: current });
      return Object.freeze({ receipt, observation });
    } catch (error) {
      close();
      const reason = ['rpc', 'mismatch', 'stale', 'inactive', 'refused'].includes(error.reason)
        ? error.reason
        : 'refused';
      throw Object.assign(fail(reason), {
        step,
        ...(reason === 'rpc' ? { causeCode: error.causeCode } : {}),
        ...(reason === 'rpc' && causeStage(error, 'causeStage') !== undefined
          ? { causeStage: causeStage(error, 'causeStage') }
          : {}),
      });
    } finally {
      busy = false;
    }
  }
  const assertResult = (receipt) => {
    active();
    const entry = receipts.get(receipt),
      now = performance.now();
    check(
      entry &&
        !busy &&
        entry.sequence === sequence &&
        now >= entry.at &&
        now - entry.at < MAX_AGE_MS,
      'stale'
    );
    return entry.observation;
  };
  const source = Object.freeze({ acquire, assertResult, close, signal: rpc.signal });
  sources.set(source, enrollment);
  return source;
}
function assertRailgunShieldPreflight(source, receipt, enrollment) {
  check(isRailgunAccountEnrollment(enrollment) && sources.get(source) === enrollment);
  return source.assertResult(receipt);
}
module.exports = { createRailgunShieldPreflight, assertRailgunShieldPreflight, MAX_AGE_MS };
