/** Internal transaction transport experiment. No IPC or setting activates it.
 * A caller must own a transaction-rpc context and a reviewed transaction.
 */
const { Transaction } = require('ethers');
const {
  createPrivateRpc,
  isQuantity,
  getPrivateRpcDestination,
  assertPrivateRpcDestination,
} = require('../networks/private-rpc');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { validIntent, transactionIntent } = require('./private-transaction-intent');
const clients = new WeakMap(),
  constraints = new WeakMap();
const instances = new WeakMap();
const destinationFailure = () =>
  privacyError(
    'PRIVATE_TRANSACTION_DESTINATION_REFUSED',
    'Private transaction destination unavailable'
  );

function getPrivateTransactionNetworkDestination(network, handle) {
  try {
    const entry = instances.get(network);
    if (!entry || entry.handle !== handle || clients.get(handle) !== network)
      throw destinationFailure();
    return getPrivateRpcDestination(entry.rpc, handle);
  } catch {
    throw destinationFailure();
  }
}

function assertPrivateTransactionNetworkDestination(network, handle, observation) {
  try {
    const entry = instances.get(network);
    if (!entry || entry.handle !== handle || clients.get(handle) !== network)
      throw destinationFailure();
    return assertPrivateRpcDestination(entry.rpc, handle, observation);
  } catch {
    throw destinationFailure();
  }
}
const address = (value) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const data = (value) =>
  typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value) && value.length <= 131074;

function getPrivateTransactionNetwork(handle, options = {}) {
  getPrivacyContext(handle);
  if (
    !options ||
    require('util').types.isProxy(options) ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Reflect.ownKeys(options).some((key) => key !== 'destinationConstraint') ||
    (Object.hasOwn(options, 'destinationConstraint') &&
      !Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'destinationConstraint'), 'value'))
  )
    throw destinationFailure();
  const requested = options.destinationConstraint;
  const bound = constraints.has(handle),
    retained = constraints.get(handle);
  if (bound && requested !== undefined && requested !== retained) throw destinationFailure();
  const constraint = bound ? retained : requested;
  const cached = clients.get(handle);
  if (cached) {
    // Never retrofit or silently remove a restriction on an existing client.
    if (instances.get(cached).constraint !== constraint) throw destinationFailure();
    if (constraint !== undefined) {
      cached.assertActive();
      return cached;
    }
    if (!cached.signal.aborted) return cached;
  }
  clients.delete(handle);
  // Bind before construction: a refused first build must not turn an omitted
  // retry into an unconstrained client. Invalid tokens also fail this handle
  // closed; an existing healthy unconstrained cache was handled above.
  if (constraint !== undefined) constraints.set(handle, constraint);
  const rpc = createPrivateRpc(handle, 'transaction-rpc', { destinationConstraint: constraint });
  const context = getPrivacyContext(handle);
  const { chainId, principal } = context.subject;
  const journal = () => require('./private-submission-journal').getPrivateSubmissionJournal(handle);
  let reconciler;
  const reconciliation = () =>
    (reconciler ||= require('./private-submission-reconciler').createSubmissionReconciler({
      rpc,
      journal: journal(),
      principal,
      assertActive,
      authorizeRailgun: (record, completed) =>
        (record.intent?.kind === 'railgun-transact'
          ? require('@freedom/railgun-kohaku-adapter/host/owner-authority')
              .authorizeRailgunTransactResolution
          : require('@freedom/railgun-kohaku-adapter/host/owner-authority')
              .authorizeRailgunShieldResolution
        )(handle, record, completed),
    }));
  async function assertCanSubmit(signal) {
    assertActive();
    await journal().initialize();
    await journal().assertCanSubmit();
    await reconciliation().refreshResolved(signal);
    await journal().assertCanSubmit();
    assertActive();
  }

  function assertActive(requestChain = chainId) {
    getPrivacyContext(handle, requestChain);
    rpc.assertActive();
  }
  function assertSigner(signerAddress) {
    assertActive();
    if (!address(signerAddress) || signerAddress.toLowerCase() !== principal) {
      throw privacyError('PRIVATE_SIGNER_MISMATCH', 'Signer does not own the transaction context');
    }
  }
  async function request(requestChain, method, params = []) {
    assertActive(requestChain);
    let allowed = false;
    let validate = isQuantity;
    if (method === 'eth_getTransactionCount') {
      allowed =
        params.length === 2 &&
        params[0]?.toLowerCase?.() === principal &&
        ['pending', 'latest'].includes(params[1]);
      validate = (value) => isQuantity(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
    } else if (method === 'eth_getBalance' || method === 'eth_getCode') {
      allowed =
        params.length === 2 && params[0]?.toLowerCase?.() === principal && params[1] === 'pending';
      if (method === 'eth_getCode') validate = data;
    } else if (method === 'eth_getBlockByNumber') {
      allowed =
        params.length === 2 &&
        params[1] === false &&
        (params[0] === 'finalized' ||
          (typeof params[0] === 'string' &&
            /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(params[0]) &&
            BigInt(params[0]) <= BigInt(Number.MAX_SAFE_INTEGER)));
      validate = (value) =>
        value &&
        hash(value.hash) &&
        isQuantity(value.number) &&
        BigInt(value.number) <= BigInt(Number.MAX_SAFE_INTEGER) &&
        (params[0] === 'finalized' || value.number === params[0]);
    } else if (['eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_blockNumber'].includes(method)) {
      allowed = params.length === 0;
    } else if (['eth_call', 'eth_estimateGas'].includes(method)) {
      const tx = params[0];
      allowed =
        tx &&
        address(tx.from) &&
        tx.from.toLowerCase() === principal &&
        address(tx.to) &&
        Object.keys(tx).every((key) => ['from', 'to', 'value', 'data', 'gas'].includes(key)) &&
        (tx.value === undefined || isQuantity(tx.value)) &&
        (tx.gas === undefined || isQuantity(tx.gas)) &&
        (tx.data === undefined || data(tx.data)) &&
        (method === 'eth_estimateGas'
          ? params.length === 1
          : params.length === 2 && params[1] === 'latest');
      if (method === 'eth_call') validate = data;
    } else if (['eth_getTransactionReceipt', 'eth_getTransactionByHash'].includes(method)) {
      allowed =
        params.length === 1 && hash(params[0]) && (await journal().has(params[0].toLowerCase()));
      validate = (value) =>
        value === null ||
        (value &&
          !Array.isArray(value) &&
          (method === 'eth_getTransactionReceipt'
            ? value.transactionHash?.toLowerCase() === params[0].toLowerCase() &&
              ['0x0', '0x1'].includes(value.status) &&
              isQuantity(value.blockNumber) &&
              isQuantity(value.gasUsed) &&
              (value.effectiveGasPrice === undefined || isQuantity(value.effectiveGasPrice))
            : value.hash?.toLowerCase() === params[0].toLowerCase() &&
              value.from?.toLowerCase() === principal));
    }
    if (!allowed)
      throw privacyError(
        'PRIVATE_TRANSACTION_REQUEST_REFUSED',
        'Transaction request is outside this context'
      );
    return rpc.request(method, params, validate);
  }
  async function getFeeQuote(requestChain) {
    const { result } = await request(requestChain, 'eth_gasPrice');
    if (BigInt(result) <= 0n)
      throw privacyError('PRIVATE_FEE_INVALID', 'No usable transaction fee');
    // A coherent legacy quote is sufficient for this technical experiment.
    // Product fee presets remain on the established ordinary-wallet path.
    return {
      type: 'legacy',
      gasPrice: BigInt(result).toString(),
      effectiveGasPrice: BigInt(result).toString(),
      source: 'direct',
      verified: false,
    };
  }
  async function broadcastRawTransaction(requestChain, signed, { expiresAt, intent } = {}) {
    assertActive(requestChain);
    if (!data(signed))
      throw privacyError('PRIVATE_SIGNED_TX_INVALID', 'Invalid signed transaction');
    let transaction;
    try {
      transaction = Transaction.from(signed);
    } catch {
      throw privacyError('PRIVATE_SIGNED_TX_INVALID', 'Invalid signed transaction');
    }
    if (!transaction.isSigned() || transaction.chainId !== BigInt(chainId)) {
      throw privacyError('PRIVATE_SIGNED_TX_INVALID', 'Signed transaction has the wrong chain');
    }
    assertSigner(transaction.from);
    if (
      !validIntent(intent) ||
      transactionIntent(intent.kind, transaction).digest !== intent.digest
    ) {
      throw privacyError(
        'PRIVATE_INTENT_INVALID',
        'Signed transaction differs from its operation intent'
      );
    }
    // A Railgun private submission's own admission, here and again with each
    // deadline check before journal begin and before the raw send. On the
    // recovered path it holds F on the monotonic clock, which a backward
    // wall-clock step cannot extend. Never part of assertActive(): after the
    // send, a passed F must not turn an acknowledgement into uncertainty.
    const admitted = intent;
    const assertAdmitted = () =>
      admitted.kind === 'railgun-transact'
        ? require('@freedom/railgun-kohaku-adapter/host/owner-authority').assertRailgunPrivateSubmission(handle, admitted)
        : undefined;
    assertAdmitted();
    if (intent.kind === 'railgun-native-shield')
      require('@freedom/railgun-kohaku-adapter/host/owner-authority').assertRailgunShieldSubmission(handle, intent);
    // Derive all reservation metadata from signed bytes, never caller fields.
    intent = transactionIntent(intent.kind, transaction);
    const txHash = transaction.hash.toLowerCase();
    const assertDeadline = () => {
      if (
        expiresAt !== undefined &&
        (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt)
      ) {
        throw privacyError('PRIVATE_REVIEW_EXPIRED', 'Transaction review expired');
      }
    };
    assertDeadline();
    if (await journal().has(txHash))
      throw Object.assign(
        privacyError(
          'PRIVATE_BROADCAST_ALREADY_ATTEMPTED',
          'Query the existing submission before any further action'
        ),
        { transactionHash: txHash }
      );
    await assertCanSubmit();
    await rpc.ready();
    assertActive();
    assertDeadline();
    assertAdmitted();
    // Atomic encrypted write + fsync must succeed before transport sees bytes.
    // If the process dies at any later instruction, recovery treats this hash
    // as possibly submitted. The journal never contains the signed bytes.
    await journal().begin(txHash, transaction.nonce, intent);
    try {
      assertActive();
      assertDeadline();
      // Recovered only: the submission entry's monotonic F, never caller data,
      // is also the RPC's admission deadline for the send. The RPC checks it
      // after its awaited readiness, last before transport admission; it
      // never cancels an admitted send or judges its response.
      const admission = assertAdmitted();
      const response = await rpc.request(
        'eth_sendRawTransaction',
        [signed],
        (result) => hash(result) && result.toLowerCase() === txHash,
        undefined,
        admission
      );
      await journal().markSubmitted(txHash);
      assertActive();
      return response;
    } catch {
      throw Object.assign(
        privacyError('PRIVATE_BROADCAST_UNCERTAIN', 'Transaction submission outcome is unknown'),
        { transactionHash: txHash, submissionStatus: 'unknown' }
      );
    }
  }
  const client = Object.freeze({
    request,
    getFeeQuote,
    broadcastRawTransaction,
    async initialize() {
      assertActive();
      await journal().initialize();
      assertActive();
    },
    async selectNonce(pending) {
      assertActive();
      const nonce = await journal().selectNonce(pending);
      assertActive();
      return nonce;
    },
    assertSigner,
    assertActive,
    signal: rpc.signal,
    assertCanSubmit,
    listSubmissions: () => journal().list(),
    recoverExitIntent: (hash, pool, policy) =>
      require('./ppv2-exit-recovery').createPPv2ExitRecovery({
        journal: journal(),
        principal,
        pool: pool.toLowerCase(),
        assertActive,
        lifetime: rpc.signal,
        readTransaction: async (hash, signal) =>
          (
            await createPrivateRpc(handle, 'transaction-rpc', {
              signal,
              destinationConstraint: constraint,
            }).request(
              'eth_getTransactionByHash',
              [hash],
              (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
            )
          ).result,
      })(hash, policy),
    reconcileSubmission: (hash) => reconciliation().observe(hash),
    resolveSubmission: (hash, policy) => reconciliation().resolve(hash, policy),
    archiveResolvedSubmissions: (policy) => reconciliation().archiveResolved(policy),
  });
  clients.set(handle, client);
  instances.set(client, { handle, rpc, constraint });
  return client;
}

function assertSignedIntent(signed, intended) {
  try {
    const actual = Transaction.from(signed);
    if (
      actual.isSigned() &&
      actual.unsignedSerialized === Transaction.from(intended).unsignedSerialized
    )
      return;
  } catch {
    /* Malformed signer output is rejected with the same fixed diagnostic. */
  }
  throw privacyError(
    'PRIVATE_SIGNED_INTENT_MISMATCH',
    'Signer output differs from the reviewed transaction'
  );
}

module.exports = {
  getPrivateTransactionNetwork,
  assertSignedIntent,
  getPrivateTransactionNetworkDestination,
  assertPrivateTransactionNetworkDestination,
};
