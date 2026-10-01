/** Enrich a retained legacy exit record using authenticated signed bytes.
 * This recovers correlation metadata, never chain inclusion or spend permission.
 */
const { Transaction } = require('ethers');
const { privacyError } = require('../networks/privacy-context');
const { validIntent, isExitIntent, transactionIntent } = require('./private-transaction-intent');
const fail = () =>
  privacyError('PRIVATE_PPV2_EXIT_RECOVERY_REFUSED', 'Legacy exit binding could not be recovered');
const quantity = (v) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(v);
const word = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const scalar = (v) => (word(v) || quantity(v)) && BigInt(v) > 0n;
const signatureWord = (v) => `0x${v.slice(2).padStart(64, '0')}`;
const address = (v) => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v);
function recoverExitIntent(record, value, principal, pool) {
  try {
    if (
      !record ||
      !validIntent(record.intent) ||
      !isExitIntent(record.intent) ||
      record.intent.commitment ||
      !value ||
      value.type !== '0x0' ||
      !word(value.hash) ||
      !address(value.from) ||
      !address(value.to) ||
      value.from.toLowerCase() !== principal ||
      value.to.toLowerCase() !== pool ||
      !['nonce', 'gas', 'gasPrice', 'value', 'v'].every((k) => quantity(value[k])) ||
      !scalar(value.r) ||
      !scalar(value.s) ||
      (value.chainId !== undefined &&
        (!quantity(value.chainId) || BigInt(value.chainId) !== 11155111n)) ||
      ![22310257n, 22310258n].includes(BigInt(value.v)) ||
      BigInt(value.nonce) > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof value.input !== 'string' ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(value.input) ||
      value.input.length > 8194
    )
      throw fail();
    const tx = Transaction.from({
      type: 0,
      chainId: 11155111n,
      nonce: Number(BigInt(value.nonce)),
      to: value.to,
      value: BigInt(value.value),
      gasLimit: BigInt(value.gas),
      gasPrice: BigInt(value.gasPrice),
      data: value.input,
      signature: {
        r: signatureWord(value.r),
        s: signatureWord(value.s),
        v: Number(BigInt(value.v)),
      },
    });
    if (
      !tx.isSigned() ||
      tx.hash !== record.hash ||
      tx.hash !== value.hash.toLowerCase() ||
      tx.from.toLowerCase() !== principal ||
      tx.nonce !== record.nonce
    )
      throw fail();
    const intent = transactionIntent(record.intent.kind, tx);
    if (intent.digest !== record.intent.digest || intent.pool !== pool) throw fail();
    return intent;
  } catch {
    throw fail();
  }
}

function createPPv2ExitRecovery({
  journal,
  readTransaction,
  principal,
  pool,
  assertActive,
  lifetime,
}) {
  return async function recover(hash, { review, timeoutMs = 60000 } = {}) {
    if (
      !word(hash) ||
      typeof review !== 'function' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000
    )
      throw fail();
    hash = hash.toLowerCase();
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime, controller.signal]);
    const expiresAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const check = () => {
      assertActive();
      if (signal.aborted || Date.now() >= expiresAt) throw fail();
    };
    const task = async () => {
      check();
      const record = (await journal.list()).find((r) => r.hash === hash);
      if (
        !record ||
        !validIntent(record.intent) ||
        !isExitIntent(record.intent) ||
        record.intent.commitment
      )
        throw fail();
      check();
      const intent = recoverExitIntent(
        record,
        await readTransaction(hash, signal),
        principal,
        pool
      );
      check();
      const summary = Object.freeze({
        action: 'recover-exit-binding',
        transactionHash: hash,
        nonce: record.nonce,
        kind: intent.kind,
        observationStatus: record.observation?.status || 'unknown',
        evidence: 'signed-transaction-hash',
        pool: intent.pool,
        commitment: intent.commitment,
        signatureVerified: true,
        intentDigestVerified: true,
        inclusionVerified: false,
        releasesReservation: false,
      });
      const decision = await review(summary);
      check();
      if (
        decision?.recoverExitBinding !== true ||
        decision.acceptedEvidence !== 'signed-transaction-hash'
      )
        throw fail();
      await journal.bindExitIntent(hash, record.revision || 0, intent, check);
      check();
      return summary;
    };
    try {
      return await new Promise((resolve, reject) => {
        const abort = () => reject(fail());
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      });
    } catch {
      throw fail();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
module.exports = { recoverExitIntent, createPPv2ExitRecovery };
