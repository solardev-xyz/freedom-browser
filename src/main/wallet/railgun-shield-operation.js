/** One-use main-owned Sepolia shield handoff. Receipt-bound authority ends at
 * broadcast; durable reconciliation is a separate journal-owned operation.
 */
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  prepareRailgunNativeShield,
  assertRailgunShieldPreparation,
  MAX_AGE_MS,
} = require('./railgun-shield-prepare');
const {
  verifyRailgunShieldReceiver,
  assertRailgunShieldReceiver,
} = require('./railgun-shield-receive');
const {
  createRailgunShieldPreflight,
  assertRailgunShieldPreflight,
} = require('./railgun-shield-preflight');
const { transactionIntent } = require('./private-transaction-intent');
const pins = require('./railgun-shield-pins.json');
const submissions = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun shield handoff refused'), {
    code: 'RAILGUN_SHIELD_HANDOFF_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
async function openRailgunShieldOperation({ identity, enrollment, archive, amount, owner }) {
  check(typeof owner === 'string' && /^0x[0-9a-f]{40}$/.test(owner) && BigInt(owner) > 0n);
  const started = performance.now(),
    deadline = Date.now() + MAX_AGE_MS;
  let scope,
    preflight,
    closed = false,
    consumed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    scope?.close();
    preflight?.close();
  };
  try {
    const preparation = await prepareRailgunNativeShield({ identity, enrollment, archive, amount });
    const receiver = await verifyRailgunShieldReceiver({
      identity,
      enrollment,
      preparation: preparation.receipt,
      archive,
    });
    let acquired, preflightStarted;
    // Only transport failures may retry, before any signing or journal entry.
    // Each attempt owns a new transport/source and all attempts share the
    // original preparation lifetime. Deployment mismatches never retry here.
    for (let attempt = 0; attempt < 2; attempt++) {
      assertRailgunShieldPreparation(preparation.receipt, identity, enrollment);
      preflight = createRailgunShieldPreflight(enrollment);
      try {
        preflightStarted = Date.now();
        acquired = await preflight.acquire();
        break;
      } catch (error) {
        preflight.close();
        if (error.reason !== 'rpc' || attempt === 1) throw error;
      }
    }
    const prepared = preparation.prepared;
    const reviewDeadline = Math.min(deadline, preflightStarted + 60000) - 10000;
    const assertCurrent = () => {
      const now = performance.now();
      check(!closed && now >= started && now - started < MAX_AGE_MS && Date.now() < deadline);
      check(assertRailgunShieldPreparation(preparation.receipt, identity, enrollment) === prepared);
      check(
        assertRailgunShieldReceiver(receiver, identity, enrollment, preparation.receipt) ===
          prepared
      );
      assertRailgunShieldPreflight(preflight, acquired.receipt, enrollment);
    };
    assertCurrent();
    const parent = enrollment.getContext('engine', 'shield-prepare');
    scope = createPrivacyScope({
      profileId: getPrivacyContext(parent).profileId,
      signal: AbortSignal.any([identity.signal, enrollment.signal, preflight.signal]),
      isCurrent: () => {
        try {
          assertCurrent();
          getPrivacyContext(parent);
          return true;
        } catch {
          return false;
        }
      },
    });
    const handle = scope.getContext({
      kind: 'public-address',
      principal: owner,
      chainId: pins.chainId,
      role: 'transaction-rpc',
    });
    const network = require('./private-transaction-network').getPrivateTransactionNetwork(handle);
    const tx = Object.freeze({
      chainId: pins.chainId,
      from: owner,
      to: prepared.to,
      value: BigInt(prepared.value),
      data: prepared.data,
    });
    const intent = transactionIntent('railgun-native-shield', tx);
    submissions.set(handle, {
      digest: intent.digest,
      assertCurrent,
      isSubmitting: () => consumed && !closed,
    });
    const rpcTx = Object.freeze({
      from: owner,
      to: tx.to,
      value: '0x' + tx.value.toString(16),
      data: tx.data,
    });
    async function submit({ signer, review, gasLimit, maxGasFee } = {}) {
      assertCurrent();
      check(Date.now() < reviewDeadline);
      check(!consumed && typeof review === 'function');
      check(typeof gasLimit === 'bigint' && gasLimit > 0n && gasLimit <= 3000000n);
      check(typeof maxGasFee === 'bigint' && maxGasFee > 0n && maxGasFee <= 2000000000000000n);
      consumed = true;
      try {
        await network.assertCanSubmit();
        assertCurrent();
        check(
          (await network.request(pins.chainId, 'eth_getCode', [owner, 'pending'])).result === '0x'
        );
        const estimate = await network.request(pins.chainId, 'eth_estimateGas', [rpcTx]);
        check(BigInt(estimate.result) > 0n && BigInt(estimate.result) <= gasLimit);
        await network.request(pins.chainId, 'eth_call', [rpcTx, 'latest']);
        assertCurrent();
        const result = await require('./transaction-service').signAndSendTransaction(
          {
            chainId: pins.chainId,
            to: tx.to,
            value: tx.value.toString(),
            data: tx.data,
            gasLimit: gasLimit.toString(),
          },
          signer,
          {
            privacyContext: handle,
            intent,
            reviewExpiresAt: reviewDeadline,
            review: async (request) => {
              assertCurrent();
              const actual = request.transaction;
              check(
                request.from.toLowerCase() === owner &&
                  transactionIntent(intent.kind, { ...actual, from: owner }).digest ===
                    intent.digest
              );
              const fee = BigInt(actual.gasPrice ?? actual.maxFeePerGas);
              check(
                BigInt(actual.gasLimit) === gasLimit && fee > 0n && gasLimit * fee <= maxGasFee
              );
              const latest = await network.request(pins.chainId, 'eth_getTransactionCount', [
                owner,
                'latest',
              ]);
              const pending = await network.request(pins.chainId, 'eth_getTransactionCount', [
                owner,
                'pending',
              ]);
              check(
                BigInt(latest.result) === BigInt(pending.result) &&
                  BigInt(pending.result) === BigInt(actual.nonce)
              );
              const balance = await network.request(pins.chainId, 'eth_getBalance', [
                owner,
                'pending',
              ]);
              check(BigInt(balance.result) >= tx.value + gasLimit * fee);
              assertCurrent();
              const approved = await review(
                Object.freeze({
                  ...request,
                  operation: intent.kind,
                  intent,
                  amount: tx.value,
                  protocolFee: tx.value - BigInt(prepared.noteValue),
                  noteValue: BigInt(prepared.noteValue),
                  noteCommitment: prepared.commitment,
                  recipient: prepared.recipient,
                  maxGasFee,
                  fundingAddressPublic: true,
                  chainStateVerified: false,
                })
              );
              assertCurrent();
              check(Date.now() < reviewDeadline);
              return approved === true;
            },
          }
        );
        // Once journaled, expiry must not hide an acknowledged hash. The
        // transaction service checks receipt-bound scope before broadcast.
        return Object.freeze({ ...result });
      } finally {
        close();
      }
    }
    return Object.freeze({ prepared, intent, submit, close, signal: scope.signal });
  } catch (error) {
    close();
    throw error;
  }
}
function assertRailgunShieldSubmission(handle, intent) {
  const entry = submissions.get(handle);
  check(
    entry &&
      entry.isSubmitting() &&
      intent?.kind === 'railgun-native-shield' &&
      intent.digest === entry.digest
  );
  entry.assertCurrent();
}
module.exports = { openRailgunShieldOperation, assertRailgunShieldSubmission };
