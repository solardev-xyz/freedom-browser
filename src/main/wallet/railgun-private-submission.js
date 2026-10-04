/** Exact completed private operation -> one EOA attempt under account exclusion.
 * No caller-supplied proof, completion snapshot or generic review grants authority.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { claimRailgunPrivateCompletion } = require('./railgun-private-operation');
const { verifyRailgunPrivateProof, assertRailgunPrivateProof } = require('./railgun-private-proof');
const {
  createRailgunPrivatePreflight,
  assertRailgunPrivatePreflight,
} = require('./railgun-private-preflight');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
const pins = require('./railgun-shield-pins.json');
const submissions = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun private submission unavailable'), {
    code: 'RAILGUN_PRIVATE_SUBMISSION_REFUSED',
  });
async function submitRailgunPrivateTransaction({
  identity,
  enrollment,
  completion,
  proverArchive,
  artifactDirectory,
  review,
  gasLimit,
  maxGasFee,
}) {
  let claim,
    proof,
    preflight,
    scope,
    outcome,
    stage = 'completion';
  try {
    assert.equal(typeof review, 'function');
    assert.ok(typeof gasLimit === 'bigint' && gasLimit > 0n && gasLimit <= 3000000n);
    assert.ok(typeof maxGasFee === 'bigint' && maxGasFee > 0n && maxGasFee <= 2000000000000000n);
    claim = claimRailgunPrivateCompletion(completion, identity, enrollment);
    const snapshot = claim.assertCurrent();
    assert.equal(snapshot.stored.capsule.version, 1);
    assert.ok(
      ['railgun-private-transfer', 'railgun-token-unshield'].includes(
        snapshot.stored.capsule.selection.kind
      )
    );
    const reservations = await enrollment.openReservations();
    const capsules = await enrollment.openPrivateCapsules();
    stage = 'recovery';
    await reservations.withSigningRecovery(
      async (records, context) => {
        let handle, network, intent;
        const callbacks = new Set();
        const track =
          (use) =>
          (...args) => {
            const pending = use(...args);
            callbacks.add(pending);
            pending.then(
              () => callbacks.delete(pending),
              () => callbacks.delete(pending)
            );
            return pending;
          };
        try {
          const recovered = records.find((v) => v.entry.id === snapshot.entry.id);
          assert.ok(recovered);
          const attest = async () => {
            context.assertCurrent();
            claim.assertCurrent();
            reservations.assertReceiptContext(recovered.receipt, 'recovery');
            assert.deepEqual(await reservations.assertReceipt(recovered.receipt), snapshot.entry);
            assert.deepEqual(await capsules.get(snapshot.entry.id), snapshot.stored);
            context.assertCurrent();
            claim.assertCurrent();
          };
          await attest();
          const { capsule, provedTransaction: tx } = snapshot.stored;
          const owner = snapshot.entry.signing.submitter;
          const signer = require('./signers').getSigner(0);
          assert.equal((await signer.getAddress()).toLowerCase(), owner);
          assert.ok(typeof signer.signTransaction === 'function' && !signer.sendTransaction);
          if (capsule.selection.kind === 'railgun-token-unshield')
            assert.equal(capsule.selection.recipient, owner);
          const evidence = {
            intent: capsule.preparation.transaction,
            transaction: tx,
            expected: capsule.preparation.expected,
          };
          stage = 'proof';
          proof = await verifyRailgunPrivateProof({
            enrollment,
            proverArchive,
            artifactDirectory,
            ...evidence,
            signal: AbortSignal.any([claim.signal, context.signal]),
          });
          await attest();
          stage = 'preflight';
          const input = {
            tree: capsule.selection.tree,
            merkleRoot: capsule.preparation.expected.merkleRoot,
            nullifier: snapshot.entry.facts.nullifier,
            checkpointHash: snapshot.entry.facts.checkpointHash,
            minimumBlock: snapshot.minimumBlock,
          };
          preflight = createRailgunPrivatePreflight({
            enrollment,
            artifactDirectory,
            input,
            ...(claim.destinationConstraints
              ? { destinationConstraint: claim.destinationConstraints.protocol }
              : {}),
          });
          const stop = () => preflight.close();
          const signal = AbortSignal.any([claim.signal, context.signal]);
          signal.addEventListener('abort', stop, { once: true });
          let acquired;
          const timer = setTimeout(stop, 20000);
          timer.unref?.();
          try {
            assert.ok(!signal.aborted);
            acquired = await preflight.acquire();
          } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', stop);
          }
          const observed = assertRailgunPrivatePreflight(
            preflight,
            acquired.receipt,
            enrollment,
            10000
          );
          assert.deepEqual(observed.input, input);
          const assertCurrent = () => {
            context.assertCurrent();
            claim.assertCurrent();
            reservations.assertReceiptContext(recovered.receipt, 'recovery');
            assertRailgunPrivateProof(proof.receipt, enrollment, evidence);
            assert.equal(
              assertRailgunPrivatePreflight(preflight, acquired.receipt, enrollment),
              observed
            );
          };
          assertCurrent();
          const parent = enrollment.getContext('engine');
          scope = createPrivacyScope({
            profileId: getPrivacyContext(parent).profileId,
            signal: AbortSignal.any([claim.signal, context.signal, proof.signal, preflight.signal]),
            isCurrent: () => {
              assertCurrent();
              return true;
            },
          });
          handle = scope.getContext({
            kind: 'public-address',
            principal: owner,
            chainId: pins.chainId,
            role: 'transaction-rpc',
          });
          network = require('./private-transaction-network').getPrivateTransactionNetwork(
            handle,
            ...(claim.destinationConstraints
              ? [{ destinationConstraint: claim.destinationConstraints.transaction }]
              : [])
          );
          intent = railgunTransactJournalIntent({ ...tx, from: owner });
          assert.equal(intent.intentDigest, snapshot.entry.facts.intentDigest);
          submissions.set(handle, { intent, assertCurrent });
          const reviewDeadline = Date.now() + 30000;
          stage = 'eoa';
          await network.assertCanSubmit(scope.signal);
          assert.equal(
            (await network.request(pins.chainId, 'eth_getCode', [owner, 'pending'])).result,
            '0x'
          );
          const rpcTx = { from: owner, to: tx.to, value: '0x0', data: tx.data };
          const estimate = await network.request(pins.chainId, 'eth_estimateGas', [rpcTx]);
          assert.ok(BigInt(estimate.result) > 0n && BigInt(estimate.result) <= gasLimit);
          await network.request(pins.chainId, 'eth_call', [rpcTx, 'latest']);
          await attest();
          assertCurrent();
          stage = 'submission';
          let signingAttempted = false;
          const submissionSigner = Object.freeze({
            getAddress: track(async () => {
              assertCurrent();
              const address = await signer.getAddress();
              assertCurrent();
              assert.equal(address.toLowerCase(), owner);
              return address;
            }),
            signTransaction: track(async (transaction) => {
              assert.ok(!signingAttempted);
              signingAttempted = true;
              await attest();
              assertCurrent();
              const signed = await signer.signTransaction(transaction);
              assertCurrent();
              return signed;
            }),
          });
          outcome = await require('./transaction-service').signAndSendTransaction(
            {
              chainId: pins.chainId,
              to: tx.to,
              value: '0',
              data: tx.data,
              gasLimit: gasLimit.toString(),
            },
            submissionSigner,
            {
              privacyContext: handle,
              intent,
              reviewExpiresAt: reviewDeadline,
              review: track(async (request) => {
                await attest();
                assertCurrent();
                const actual = request.transaction;
                assert.equal(request.from.toLowerCase(), owner);
                assert.deepEqual(railgunTransactJournalIntent({ ...actual, from: owner }), intent);
                const fee = BigInt(actual.gasPrice ?? actual.maxFeePerGas);
                assert.ok(
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
                assert.ok(
                  BigInt(latest.result) === BigInt(pending.result) &&
                    BigInt(pending.result) === BigInt(actual.nonce)
                );
                const balance = await network.request(pins.chainId, 'eth_getBalance', [
                  owner,
                  'pending',
                ]);
                assert.ok(BigInt(balance.result) >= gasLimit * fee);
                assertCurrent();
                const approved = await Promise.resolve()
                  .then(() =>
                    review(
                      Object.freeze({
                        ...request,
                        intent,
                        operation: intent.operation,
                        maxGasFee,
                        fundingAddressPublic: true,
                        chainStateVerified: false,
                      })
                    )
                  )
                  .catch(() => {
                    throw fail();
                  });
                await attest();
                assertCurrent();
                assert.ok(Date.now() < reviewDeadline);
                return approved === true;
              }),
            }
          );
        } catch (error) {
          if (
            stage === 'submission' &&
            network &&
            intent &&
            typeof error?.transactionHash === 'string' &&
            /^0x[0-9a-f]{64}$/.test(error.transactionHash)
          ) {
            try {
              const records = await network.listSubmissions();
              const attempted = records.find((v) => v.hash === error.transactionHash);
              assert.deepEqual(attempted?.intent, intent);
              outcome = Object.freeze({
                transactionHash: attempted.hash,
                submissionStatus: 'unknown',
              });
            } catch {
              // If history cannot be authenticated, retain the private hold and
              // require cold recovery rather than report an unbound hash.
            }
          }
          // Expected refusal is a value, so it does not close authenticated stores.
        } finally {
          if (handle) submissions.delete(handle);
          scope?.close();
          preflight?.close();
          proof?.close();
          await Promise.allSettled([...callbacks]);
        }
      },
      { timeoutMs: 120000 }
    );
  } catch {
    // A phase expiry after journaling must not hide its acknowledged/uncertain hash.
  } finally {
    scope?.close();
    preflight?.close();
    proof?.close();
    claim?.close();
  }
  return Object.freeze(outcome || { status: 'recovery-required', stage });
}
function assertRailgunPrivateSubmission(handle, intent) {
  try {
    const entry = submissions.get(handle);
    assert.ok(entry);
    assert.deepEqual(entry.intent, intent);
    entry.assertCurrent();
  } catch {
    throw fail();
  }
}
module.exports = { submitRailgunPrivateTransaction, assertRailgunPrivateSubmission };
