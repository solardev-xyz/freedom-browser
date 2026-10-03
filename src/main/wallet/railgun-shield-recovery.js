/** Restartable public-address recovery; preparation/receiver receipts play no
 * role after the encrypted submission journal has recorded an attempt.
 */
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { openPrivacySession } = require('./privacy-session');
const { getPrivateTransactionNetwork } = require('./private-transaction-network');
const { inspectRailgunShieldReceipt } = require('./railgun-shield-receipt');
const {
  validRailgunShieldResolution,
  freezeRailgunShieldResolution,
} = require('./railgun-shield-resolution');
const owners = new WeakMap(),
  permits = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun shield recovery unavailable'), {
    code: 'RAILGUN_SHIELD_RECOVERY_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
function openRailgunShieldRecovery(owner) {
  check(typeof owner === 'string' && /^0x[0-9a-f]{40}$/.test(owner) && BigInt(owner) > 0n);
  const parent = openPrivacySession();
  const subject = {
    kind: 'public-address',
    principal: owner,
    chainId: 11155111,
    role: 'transaction-rpc',
  };
  const parentHandle = parent.getContext(subject);
  const scope = createPrivacyScope({
    profileId: getPrivacyContext(parentHandle).profileId,
    signal: parent.signal,
    isCurrent: () => {
      try {
        getPrivacyContext(parentHandle);
        return true;
      } catch {
        return false;
      }
    },
  });
  const handle = scope.getContext(subject);
  let network;
  try {
    network = getPrivateTransactionNetwork(handle);
  } catch (error) {
    scope.close();
    throw error;
  }
  let busy = false,
    currentHash = null,
    currentPermit = null;
  owners.set(handle, {
    active: () => busy && !scope.signal.aborted,
    hash: () => currentHash,
    permit: () => currentPermit,
  });
  const active = () => network.assertActive();
  async function list() {
    active();
    const records = await network.listSubmissions();
    active();
    return Object.freeze(records.filter((r) => r.intent?.kind === 'railgun-native-shield'));
  }
  async function observe(hash) {
    active();
    const record = (await list()).find((r) => r.hash === hash);
    check(record);
    const current = await network.reconcileSubmission(hash);
    active();
    check(current.intent?.digest === record.intent.digest);
    if (current.observation?.status !== 'included')
      return Object.freeze({ record: current, shield: null });
    const { result: transaction } = await network.request(11155111, 'eth_getTransactionByHash', [
      hash,
    ]);
    const { result: receipt } = await network.request(11155111, 'eth_getTransactionReceipt', [
      hash,
    ]);
    active();
    const shield = inspectRailgunShieldReceipt(current, transaction, receipt);
    check(
      shield.status !== 'matched' ||
        (shield.blockHash === current.observation.blockHash &&
          BigInt(shield.blockNumber) === BigInt(current.observation.blockNumber))
    );
    return Object.freeze({ record: current, shield });
  }
  async function resolve(hash, { minimumConfirmations, review } = {}) {
    check(
      !busy &&
        Number.isSafeInteger(minimumConfirmations) &&
        minimumConfirmations >= 3 &&
        typeof review === 'function'
    );
    busy = true;
    currentHash = hash;
    try {
      return await network.resolveSubmission(hash, {
        minimumConfirmations,
        review: async (request) => {
          const before = await observe(hash);
          check(
            before.record.observation.status === request.observation.status &&
              before.record.observation.blockHash === request.observation.blockHash &&
              before.record.observation.blockNumber === request.observation.blockNumber
          );
          // A nonce-consumed observation cannot identify the mined candidate;
          // a success without its note is also unresolved. Neither grants retry.
          check(
            before.record.observation.status === 'reverted' ||
              (before.record.observation.status === 'included' &&
                before.shield?.status === 'matched')
          );
          const readFinalized = async (record) => {
            const { result: block } = await network.request(11155111, 'eth_getBlockByNumber', [
              'finalized',
              false,
            ]);
            check(BigInt(block.number) >= BigInt(record.observation.blockNumber));
            if (BigInt(block.number) === BigInt(record.observation.blockNumber))
              check(block.hash === record.observation.blockHash);
            return { number: Number(BigInt(block.number)), hash: block.hash };
          };
          const finalized = await readFinalized(before.record);
          const decision = await review(
            Object.freeze({ ...request, shield: before.shield, finalized })
          );
          active();
          const after = await observe(hash);
          check(
            before.record.observation.status === after.record.observation.status &&
              before.record.observation.blockHash === after.record.observation.blockHash &&
              before.record.observation.blockNumber === after.record.observation.blockNumber &&
              JSON.stringify(before.shield) === JSON.stringify(after.shield)
          );
          const final = await readFinalized(after.record);
          const details = freezeRailgunShieldResolution({
            outcome: after.shield ? 'matched' : 'reverted',
            finalizedBlockNumber: final.number,
            finalizedBlockHash: final.hash,
            shield: after.shield,
          });
          check(validRailgunShieldResolution(details, after.record));
          currentPermit = Object.freeze({});
          permits.set(currentPermit, {
            details,
            digest: after.record.intent.digest,
            nonce: after.record.nonce,
            hash,
            at: performance.now(),
            active: () => busy && !scope.signal.aborted,
          });
          return decision;
        },
      });
    } finally {
      busy = false;
      currentHash = currentPermit = null;
    }
  }
  return Object.freeze({
    list,
    observe,
    resolve,
    close: () => scope.close(),
    signal: scope.signal,
  });
}
function assertRailgunShieldResolution(permit, record) {
  const entry = permits.get(permit),
    now = performance.now();
  check(
    entry &&
      entry.active() &&
      entry.hash === record.hash &&
      entry.digest === record.intent?.digest &&
      entry.nonce === record.nonce &&
      now >= entry.at &&
      now - entry.at < 60000 &&
      validRailgunShieldResolution(entry.details, record)
  );
  return entry.details;
}
function authorizeRailgunResolution(handle, record, completed = false) {
  const entry = owners.get(handle);
  check(entry && entry.active() && entry.hash() === record.hash);
  if (!completed) return;
  const permit = entry.permit();
  assertRailgunShieldResolution(permit, record);
  return permit;
}
module.exports = {
  openRailgunShieldRecovery,
  authorizeRailgunResolution,
  assertRailgunShieldResolution,
};
