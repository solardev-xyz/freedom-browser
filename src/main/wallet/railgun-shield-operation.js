/** One-use main-owned Sepolia shield handoff. Receipt-bound authority ends at
 * broadcast; durable reconciliation is a separate journal-owned operation.
 */
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isProxy } = require('util').types;
const { createPrivateRpc } = require('../networks/private-rpc');
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
async function openRailgunShieldOperation(options) {
  const started = performance.now(),
    wallStarted = Date.now(),
    deadline = started + MAX_AGE_MS,
    wallDeadline = wallStarted + MAX_AGE_MS;
  let scope,
    preflight,
    protocol,
    network,
    lifetime,
    timer,
    freshnessTimer,
    cleanupFailed = false,
    opening = true,
    settled = false,
    lastNow = started,
    resolveClosed,
    closed = false,
    consumed = false;
  const controller = new AbortController(),
    work = new Set(),
    sources = new Set(),
    stopped = new Set();
  // This is an attestation of owned callback/acquisition/cleanup completion,
  // not a physical socket-drain or transaction-service lease guarantee. It
  // never rejects: failed cleanup keeps it pending so allSettled/finally cannot
  // turn uncertain cleanup into permission to release a caller's exclusion.
  const drained = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const finish = () => {
    if (!closed || opening || work.size || settled || cleanupFailed) return;
    settled = true;
    resolveClosed();
  };
  const track = (promise) => {
    const pending = Promise.resolve(promise);
    work.add(pending);
    const done = () => {
      work.delete(pending);
      finish();
    };
    pending.then(done, done);
    return pending;
  };
  const stop = (resource) => {
    if (!resource || stopped.has(resource)) return;
    stopped.add(resource);
    try {
      const pending = resource.close();
      if (pending && typeof pending.then === 'function')
        track(
          Promise.resolve(pending).catch(() => {
            cleanupFailed = true;
          })
        );
    } catch {
      cleanupFailed = true;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(freshnessTimer);
    try {
      lifetime?.removeEventListener('abort', close);
      preflight?.signal.removeEventListener('abort', close);
      protocol?.signal.removeEventListener('abort', close);
      network?.signal.removeEventListener('abort', close);
    } catch {
      cleanupFailed = true;
    }
    try {
      controller.abort();
    } catch {
      cleanupFailed = true;
    }
    stop(scope);
    for (const source of sources) stop(source);
    try {
      protocol?.release();
    } catch {
      cleanupFailed = true;
    }
    finish();
  };
  try {
    check(options && !isProxy(options) && Object.getPrototypeOf(options) === Object.prototype);
    for (const key of Reflect.ownKeys(options)) {
      check(
        [
          'identity',
          'enrollment',
          'archive',
          'amount',
          'owner',
          'signal',
          'destinationConstraints',
        ].includes(key)
      );
      check(Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'));
    }
    const { identity, enrollment, archive, amount, owner, signal, destinationConstraints } =
      options;
    check(typeof owner === 'string' && /^0x[0-9a-f]{40}$/.test(owner) && BigInt(owner) > 0n);
    check(
      signal === undefined || (!isProxy(signal) && signal instanceof AbortSignal && !signal.aborted)
    );
    let constraints;
    if (destinationConstraints !== undefined) {
      check(
        destinationConstraints &&
          !isProxy(destinationConstraints) &&
          Object.getPrototypeOf(destinationConstraints) === Object.prototype
      );
      check(Reflect.ownKeys(destinationConstraints).length === 2);
      for (const key of ['protocol', 'transaction'])
        check(
          Object.hasOwn(Object.getOwnPropertyDescriptor(destinationConstraints, key) || {}, 'value')
        );
      constraints = Object.freeze({
        protocol: destinationConstraints.protocol,
        transaction: destinationConstraints.transaction,
      });
      check(constraints.protocol !== undefined && constraints.transaction !== undefined);
    }
    lifetime = AbortSignal.any([
      identity.signal,
      enrollment.signal,
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    lifetime.addEventListener('abort', close, { once: true });
    timer = setTimeout(close, Math.max(1, deadline - performance.now()));
    timer.unref?.();
    const parent = enrollment.getContext('engine', 'shield-prepare');
    const scopeCurrent = () => {
      const now = performance.now(),
        wall = Date.now();
      check(
        !closed &&
          !cleanupFailed &&
          !lifetime.aborted &&
          Number.isFinite(now) &&
          now >= lastNow &&
          now < deadline &&
          wall >= wallStarted &&
          wall < wallDeadline
      );
      lastNow = now;
      getPrivacyContext(parent);
    };
    scopeCurrent();
    scope = createPrivacyScope({
      profileId: getPrivacyContext(parent).profileId,
      signal: lifetime,
      isCurrent: () => {
        try {
          scopeCurrent();
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
    // Construction validates genuine tokens/destinations without ready() or RPC.
    // Do this before either viewing credential when restrictions are supplied.
    if (constraints) {
      const protocolHandle = scope.getContext({
        ...getPrivacyContext(enrollment.getContext('protocol-rpc', 'shield-preflight')).subject,
      });
      protocol = createPrivateRpc(protocolHandle, 'protocol-rpc', {
        destinationConstraint: constraints.protocol,
      });
      network = require('./private-transaction-network').getPrivateTransactionNetwork(handle, {
        destinationConstraint: constraints.transaction,
      });
      protocol.signal.addEventListener('abort', close, { once: true });
      network.signal.addEventListener('abort', close, { once: true });
    }
    const active = () => {
      scopeCurrent();
      protocol?.assertActive();
      network?.assertActive();
    };
    const remaining = () => {
      active();
      const ms = Math.floor(Math.min(deadline - performance.now(), wallDeadline - Date.now()));
      check(ms > 0);
      return ms;
    };
    active();
    const preparation = await track(
      prepareRailgunNativeShield({
        identity,
        enrollment,
        archive,
        amount,
        signal: lifetime,
        timeoutMs: remaining(),
      })
    );
    active();
    const receiver = await track(
      verifyRailgunShieldReceiver({
        identity,
        enrollment,
        preparation: preparation.receipt,
        archive,
        signal: lifetime,
        timeoutMs: remaining(),
      })
    );
    active();
    let acquired, preflightStarted, preflightWall;
    // Only transport failures may retry, before any signing or journal entry.
    // Each attempt owns a new transport/source and all attempts share the
    // original preparation lifetime. Deployment mismatches never retry here.
    for (let attempt = 0; attempt < 2; attempt++) {
      active();
      assertRailgunShieldPreparation(preparation.receipt, identity, enrollment);
      preflight = createRailgunShieldPreflight(
        enrollment,
        constraints ? { destinationConstraint: constraints.protocol } : undefined
      );
      sources.add(preflight);
      try {
        preflightStarted = performance.now();
        preflightWall = Date.now();
        freshnessTimer = setTimeout(close, 60000);
        freshnessTimer.unref?.();
        acquired = await track(preflight.acquire());
        active();
        break;
      } catch (error) {
        clearTimeout(freshnessTimer);
        stop(preflight);
        active();
        if (error.reason !== 'rpc' || attempt === 1) throw error;
      }
    }
    const prepared = preparation.prepared;
    const reviewDeadline =
      Math.min(
        wallDeadline,
        preflightWall + 60000,
        Date.now() + Math.floor(deadline - performance.now())
      ) - 10000;
    const assertCurrent = () => {
      active();
      const now = performance.now();
      check(
        now >= preflightStarted &&
          now - preflightStarted < 60000 &&
          Date.now() < preflightWall + 60000
      );
      check(assertRailgunShieldPreparation(preparation.receipt, identity, enrollment) === prepared);
      check(
        assertRailgunShieldReceiver(receiver, identity, enrollment, preparation.receipt) ===
          prepared
      );
      assertRailgunShieldPreflight(preflight, acquired.receipt, enrollment);
    };
    preflight.signal.addEventListener('abort', close, { once: true });
    assertCurrent();
    network ||= require('./private-transaction-network').getPrivateTransactionNetwork(handle);
    network.signal.addEventListener('abort', close, { once: true });
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
      try {
        assertCurrent();
        check(Date.now() < reviewDeadline);
        check(!consumed && typeof review === 'function');
        check(typeof gasLimit === 'bigint' && gasLimit > 0n && gasLimit <= 3000000n);
        check(typeof maxGasFee === 'bigint' && maxGasFee > 0n && maxGasFee <= 2000000000000000n);
      } catch {
        throw fail();
      }
      consumed = true;
      let complete;
      track(
        new Promise((resolve) => {
          complete = resolve;
        })
      );
      // privateStep races cancellation. Retain the original callback promises
      // as well: an outward refusal is not proof that a host callback drained.
      const callback = (fn) =>
        track(
          Promise.resolve().then(async () => {
            try {
              assertCurrent();
              const result = await fn();
              assertCurrent();
              return result;
            } catch {
              throw fail();
            }
          })
        );
      try {
        check(
          signer &&
            typeof signer.getAddress === 'function' &&
            typeof signer.signTransaction === 'function' &&
            typeof signer.sendTransaction !== 'function'
        );
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
          {
            getAddress: () => callback(() => signer.getAddress()),
            signTransaction: (transaction) => callback(() => signer.signTransaction(transaction)),
          },
          {
            privacyContext: handle,
            intent,
            reviewExpiresAt: reviewDeadline,
            review: (request) =>
              callback(async () => {
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
              }),
          }
        );
        // Once journaled, expiry must not hide an acknowledged hash. The
        // transaction service checks receipt-bound scope before broadcast.
        return Object.freeze({ ...result });
      } catch (error) {
        // Callback errors were sanitized above. This outcome comes from the
        // real journal guard or journal-before-send boundary and must survive
        // cancellation. Unresolved history still requires reconciliation.
        if (['PRIVATE_BROADCAST_UNCERTAIN', 'PRIVATE_SUBMISSION_UNRESOLVED'].includes(error?.code))
          throw error;
        throw fail();
      } finally {
        close();
        complete();
      }
    }
    opening = false;
    finish();
    return Object.freeze({
      prepared,
      intent,
      submit,
      close,
      closed: drained,
      signal: scope.signal,
    });
  } catch {
    close();
    opening = false;
    finish();
    await drained;
    throw fail();
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
