/**
 * SafeExecutor — execution layer for Safe smart accounts.
 *
 * A Safe account has no key of its own: its owners are other wallet
 * records, and a SafeTx is EIP-712 typed data, so every signer backend
 * (vault, Ledger, phone) co-signs through the ordinary `getSigner` seam.
 * This module orchestrates the rest: predict the counterfactual address,
 * build the deployment, build/hash a SafeTx, collect owner signatures,
 * and submit `execTransaction` through an executor EOA that pays the gas.
 *
 * Everything runs against the user's own RPC pool via protocol-kit —
 * never Safe's hosted Transaction Service. All returned shapes are plain
 * JSON (IPC- and persistence-friendly); protocol-kit objects stay
 * internal.
 *
 * Address reproducibility invariant: a Safe record's ORIGINAL init params
 * (owners, threshold, saltNonce) must never change — they are what makes
 * the CREATE2 address recomputable for retroactive deployment on other
 * chains. buildSafeTransaction re-derives the address from them and
 * refuses to proceed on a mismatch.
 */

const {
  AbiCoder,
  concat,
  getAddress,
  getCreate2Address,
  keccak256,
  verifyTypedData,
  Interface,
  TypedDataEncoder,
} = require('ethers');
const Safe = require('@safe-global/protocol-kit').default;
const {
  generateTypedData,
  EthSafeTransaction,
  EthSafeSignature,
} = require('@safe-global/protocol-kit');
const { getProxyFactoryDeployment } = require('@safe-global/safe-deployments');

const { getSigner } = require('../signers');
const { withoutDomainType } = require('../signing-utils');
const {
  estimateGas,
  getGasPrices,
  toFeeFields,
  namesOwnFees,
  signAndSendTransaction,
  heldIntentFor,
} = require('../transaction-service');
const { signAndRecord } = require('../tx-recorder');
const { takeSiteTurn } = require('../auto-approve-pause');
const {
  FEE_CHECK_NEEDS_CONFIRMATION,
  checkAtApproval,
  feeCheckError,
  feeNotShownError,
} = require('../fee-check');
const { KINDS: CONFIRM_KINDS, consumeConfirmation } = require('../signing-confirmation');
const { getWalletRecord, WALLET_TYPES } = require('../../identity-manager');
const { getEip1193Provider } = require('../provider-manager');
const { codedError, SAFE_UNSUPPORTED } = require('./errors');

/** Contract version every freedom Safe is created with. */
const SAFE_VERSION = '1.4.1';

/**
 * The Safe deployments Freedom creates Safes with, pinned (#1066): Safe
 * 1.4.1 on Gnosis, its canonical SafeL2 singleton, SafeProxyFactory and
 * CompatibilityFallbackHandler (safe-deployments 1.37.66, assets/v1.4.1),
 * and the factory's proxy creation code with its keccak256.
 *
 * A Safe's address is CREATE2 over that code. protocol-kit reads it from
 * the factory (`proxyCreationCode()`) through whichever RPC endpoint
 * answers, so one wrong answer gave an address no deployment reaches, and
 * funds sent there were lost. The code is a constant of the canonical
 * factory: it is embedded in the factory's runtime code, whose keccak256
 * is the codeHash safe-deployments lists for it (safe-executor.test.js).
 *
 * A chain or version not listed here has no pinned code, and no Safe is
 * created or deployed there (pinnedSafeDeployment).
 */
const PINNED_DEPLOYMENTS = {
  [SAFE_VERSION]: {
    chainIds: [100],
    singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
    factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
    fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
    proxyCreationCode:
      '0x608060405234801561001057600080fd5b506040516101e63803806101e683398181016040526020' +
      '81101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffff' +
      'ffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100' +
      'ca576040517f08c379a0000000000000000000000000000000000000000000000000000000008152' +
      '6004018080602001828103825260228152602001806101c460229139604001915050604051809103' +
      '90fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff0219169083' +
      '73ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3' +
      'fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e00000000' +
      '00000000000000000000000000000000000000000000000060003514156050578060005260206000' +
      'f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2' +
      '64697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f3144' +
      '1364736f6c63430007060033496e76616c69642073696e676c65746f6e2061646472657373207072' +
      '6f7669646564',
    proxyCreationCodeHash: '0x1856e0ee08399d74e0ea0b03adca210aeade6f748969ac023cdcb4dd62dcaf5f',
  },
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SETUP_INTERFACE = new Interface([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]);
const FACTORY_INTERFACE = new Interface([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
]);

const EXEC_INTERFACE = new Interface([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);

const resolveProvider = (provider, chainId) => provider ?? getEip1193Provider(chainId);

// This layer works in owner ADDRESSES; wallet records store owners as
// wallet INDEXES — fail loudly on the mixup instead of letting the
// address parser produce a cryptic error deep inside the encoder.
function assertOwnerAddresses(owners) {
  if (!Array.isArray(owners) || owners.some((owner) => typeof owner !== 'string')) {
    throw new Error('Safe owners must be addresses here — resolve wallet indexes first');
  }
}

/**
 * The pinned deployment (PINNED_DEPLOYMENTS) for a chain and Safe
 * version. Without one there is no proxy code to trust, and the RPC's
 * answer is not taken instead: the Safe is refused (SAFE_UNSUPPORTED).
 *
 * @param {number} chainId
 * @param {string} [version]
 * @returns {{singleton: string, factory: string, fallbackHandler: string,
 *   proxyCreationCode: string, proxyCreationCodeHash: string}}
 */
function pinnedSafeDeployment(chainId, version = SAFE_VERSION) {
  const pinned = Object.hasOwn(PINNED_DEPLOYMENTS, version) ? PINNED_DEPLOYMENTS[version] : null;
  if (!pinned || !pinned.chainIds.includes(Number(chainId))) {
    throw codedError(
      `Safe accounts can only be created on Gnosis with Safe ${SAFE_VERSION}: ` +
        `Safe ${version} on chain ${chainId} has no pinned deployment`,
      SAFE_UNSUPPORTED
    );
  }
  return pinned;
}

/**
 * The deployment of a Safe and the address it lands on, computed locally
 * from the pinned deployment and the init params, with no chain read:
 * `createProxyWithNonce(singleton, initializer, saltNonce)` to the
 * factory, with the initializer protocol-kit encodes for Freedom's Safes
 * (`setup(owners, threshold, 0x0, 0x, fallbackHandler, 0x0, 0, 0x0)`), and
 * the CREATE2 address the factory deploys it at: salt keccak256(
 * keccak256(initializer) ‖ saltNonce), init code the proxy creation code ‖
 * the singleton.
 */
function pinnedDeployment({ owners, threshold, saltNonce, chainId }) {
  assertOwnerAddresses(owners);
  if (owners.length === 0) throw new Error('Owner list must have at least one owner');
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
    throw new Error('Threshold must be between 1 and the number of owners');
  }
  if (!/^\d+$/.test(String(saltNonce))) throw new Error('Invalid Safe salt nonce');
  const pinned = pinnedSafeDeployment(chainId);
  const coder = AbiCoder.defaultAbiCoder();
  const initializer = SETUP_INTERFACE.encodeFunctionData('setup', [
    owners,
    threshold,
    ZERO_ADDRESS,
    '0x',
    pinned.fallbackHandler,
    ZERO_ADDRESS,
    0,
    ZERO_ADDRESS,
  ]);
  const salt = keccak256(
    concat([keccak256(initializer), coder.encode(['uint256'], [BigInt(saltNonce)])])
  );
  const initCodeHash = keccak256(
    concat([pinned.proxyCreationCode, coder.encode(['address'], [pinned.singleton])])
  );
  return {
    safeAddress: getCreate2Address(pinned.factory, salt, initCodeHash),
    to: getAddress(pinned.factory),
    value: '0',
    data: FACTORY_INTERFACE.encodeFunctionData('createProxyWithNonce', [
      pinned.singleton,
      initializer,
      BigInt(saltNonce),
    ]),
  };
}

/** protocol-kit instance for a not-yet-assumed-deployed safe. */
function initPredictedKit({ owners, threshold, saltNonce, chainId, provider }) {
  assertOwnerAddresses(owners);
  return Safe.init({
    provider: resolveProvider(provider, chainId),
    predictedSafe: {
      safeAccountConfig: { owners, threshold },
      safeDeploymentConfig: { saltNonce: String(saltNonce), safeVersion: SAFE_VERSION },
    },
  });
}

/**
 * Deployments must go through the canonical factory from the
 * safe-deployments registry — never a user- or dApp-supplied one. The
 * canonical 1.4.1 factory has the same address on every chain, which is
 * also what makes counterfactual addresses portable.
 */
function assertCanonicalFactory(factoryAddress) {
  const canonical = getAddress(
    getProxyFactoryDeployment({ version: SAFE_VERSION }).defaultAddress
  );
  if (getAddress(factoryAddress) !== canonical) {
    throw new Error(
      `Refusing non-canonical Safe factory ${factoryAddress} (expected ${canonical})`
    );
  }
}

/** Recursively replace BigInts so results survive JSON / IPC boundaries. */
function toJsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v))
  );
}

/**
 * A SafeTx's EIP-712 payload, as every owner signs it, and its digest.
 */
function hashSafeTransaction({ safeAddress, chainId, data }) {
  const typedData = toJsonSafe(
    generateTypedData({
      safeAddress,
      safeVersion: SAFE_VERSION,
      chainId: BigInt(chainId),
      data,
    })
  );
  const safeTxHash = TypedDataEncoder.hash(
    typedData.domain,
    withoutDomainType(typedData.types),
    typedData.message
  );
  return { typedData, safeTxHash };
}

/**
 * Intent keys (transaction-service's signAndSendTransaction): a retry of
 * the same SafeTx execution, or of the same Safe's deployment, sends the
 * held intent's own bytes again at its one nonce instead of signing anew.
 */
const execIntentKey = (chainId, safeTxHash) => `safe-exec:${chainId}:${safeTxHash.toLowerCase()}`;
const deployIntentKey = (chainId, safeAddress) =>
  `safe-deploy:${chainId}:${safeAddress.toLowerCase()}`;

/**
 * Counterfactual (CREATE2) address for the given init params, deployed or
 * not, computed from the pinned deployment (pinnedDeployment): no chain is
 * asked. Refused (SAFE_UNSUPPORTED) on a chain with no pinned deployment.
 *
 * @param {Object} params
 * @param {string[]} params.owners - Owner addresses
 * @param {number} params.threshold
 * @param {string|number} params.saltNonce
 * @param {number} params.chainId
 * @returns {Promise<string>} Checksummed address
 */
async function predictSafeAddress({ owners, threshold, saltNonce, chainId }) {
  return pinnedDeployment({ owners, threshold, saltNonce, chainId }).safeAddress;
}

/**
 * The raw deployment transaction (to = canonical factory) plus the
 * address it will land on, for callers that want to inspect or quote it
 * before sending. Both come from the pinned deployment, as
 * predictSafeAddress's address does, so the address is the one this
 * transaction deploys.
 *
 * @returns {Promise<{safeAddress: string, to: string, value: string, data: string}>}
 */
async function buildDeploymentTransaction({ owners, threshold, saltNonce, chainId }) {
  const deployment = pinnedDeployment({ owners, threshold, saltNonce, chainId });
  assertCanonicalFactory(deployment.to);
  return deployment;
}

/**
 * Build and hash a SafeTx for a (deployed or counterfactual) Safe.
 *
 * The nonce comes from the chain when the Safe is deployed, else 0. The
 * returned `typedData` is the exact EIP-712 payload every owner signs
 * (full wire shape, EIP712Domain included) and `safeTxHash` its digest.
 *
 * @param {Object} params
 * @param {number} params.chainId
 * @param {Object} params.safe - Safe record: original init params
 *   (owners, threshold, saltNonce) and optionally the stored address,
 *   which is verified against the re-derived one.
 * @param {Object} params.tx - {to, value, data?} — plain CALL only
 * @param {Object|string} [params.provider]
 * @returns {Promise<{safeAddress: string, deployed: boolean,
 *   safeTxData: Object, safeTxHash: string, typedData: Object}>}
 */
async function buildSafeTransaction({ chainId, safe, tx, provider }) {
  // The pinned address (predictSafeAddress), never protocol-kit's, which
  // rests on the RPC's proxyCreationCode() answer.
  const safeAddress = await predictSafeAddress({ ...safe, chainId });

  // Guard the reproducibility invariant: if the record's stored address
  // no longer matches its init params, something mutated what must be
  // frozen — refuse rather than sign for the wrong account.
  if (safe.address && getAddress(safe.address) !== safeAddress) {
    throw new Error(
      `Safe address mismatch: record says ${safe.address}, init params derive ${safeAddress}`
    );
  }

  const resolved = resolveProvider(provider, chainId);
  let kit = await initPredictedKit({ ...safe, chainId, provider: resolved });
  const deployed = await kit.getSafeProvider().isContractDeployed(safeAddress);
  if (deployed) {
    kit = await kit.connect({ provider: resolved, safeAddress });
  }

  const safeTx = await kit.createTransaction({
    transactions: [{ to: getAddress(tx.to), value: String(tx.value ?? '0'), data: tx.data || '0x' }],
  });
  const { typedData, safeTxHash } = hashSafeTransaction({
    safeAddress,
    chainId,
    data: safeTx.data,
  });

  return { safeAddress, deployed, safeTxData: toJsonSafe(safeTx.data), safeTxHash, typedData };
}

/**
 * One owner's signature over a SafeTx typed-data payload, through its
 * normal signer backend (vault instantly, Ledger tap, phone QR) —
 * recover-verified before it counts, so a mis-keyed or compromised
 * device fails here rather than on-chain.
 *
 * @param {Object} params
 * @param {Object} params.typedData - From buildSafeTransaction
 * @param {number} params.ownerIndex - Wallet index of the owner
 * @returns {Promise<{signer: string, data: string}>}
 */
async function collectOwnerSignature({ typedData, ownerIndex }) {
  const signer = getSigner(ownerIndex);
  const address = await signer.getAddress();
  const data = await signer.signTypedData(typedData);
  const recovered = verifyTypedData(
    typedData.domain,
    withoutDomainType(typedData.types),
    typedData.message,
    data
  );
  if (recovered !== getAddress(address)) {
    throw new Error(`Owner signature from ${address} does not match: recovered ${recovered}`);
  }
  return { signer: getAddress(address), data };
}

/** The fee fields a confirmation names: both EIP-1559 fees, or a gas price. */
function confirmedFees(fees) {
  if (fees?.maxFeePerGas != null && fees?.maxPriorityFeePerGas != null) {
    return {
      maxFeePerGas: String(fees.maxFeePerGas),
      maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
    };
  }
  if (fees?.gasPrice != null) return { gasPrice: String(fees.gasPrice) };
  return {};
}

/**
 * The executor's transaction at today's quote, judged by the fee check at
 * confirmation (freedom-core design 0005, A) as it is signed. A fee within
 * the threshold, against a reference that permits it, goes ahead without
 * the user, as before. Any other stops here, with nothing signed: the error
 * (FEE_CHECK_NEEDS_CONFIRMATION) carries the verdict and the transaction
 * offered, which the Safe's screen shows and confirms ('executor-send').
 */
async function quotedExecutorSend({ chainId, to, data, executorIndex, from }) {
  const [{ gasLimit }, gasPrices] = await Promise.all([
    estimateGas({ from, to, value: '0', data, chainId }),
    getGasPrices(chainId),
  ]);
  const params = { to, value: '0', data, gasLimit, ...toFeeFields(gasPrices), chainId };
  const verdict = await checkAtApproval(params);
  if (!verdict.autoApprove) {
    const error = feeCheckError(FEE_CHECK_NEEDS_CONFIRMATION, verdict);
    error.offer = { executorIndex, chainId, to, value: '0', data, gasLimit, ...toFeeFields(gasPrices) };
    throw error;
  }
  return params;
}

/**
 * The executor's transaction with the fee the user confirmed on the Safe's
 * screen: signed with exactly that fee, against its 'executor-send'
 * confirmation, or not at all.
 */
function confirmedExecutorSend({ chainId, to, data, executorIndex, feeConfirmation }) {
  const fees = confirmedFees(feeConfirmation.fees);
  const params = { to, value: '0', data, gasLimit: feeConfirmation.gasLimit, ...fees, chainId };
  consumeConfirmation(feeConfirmation.confirmation, CONFIRM_KINDS.EXECUTOR_SEND, executorIndex, params);
  // A confirmation of no fee would be given today's as it is signed.
  if (!namesOwnFees(params)) throw feeNotShownError();
  return params;
}

/**
 * Quote gas against the executor account and broadcast through the
 * ordinary transaction-service path (the executor EOA pays the fee).
 *
 * `intentKey` names the send across retries: while its intent is held, a
 * retry sends that intent's bytes again, so it needs no new quote.
 *
 * A new send is judged by the fee check first (quotedExecutorSend), unless
 * it comes with `feeConfirmation` (`{ confirmation, gasLimit, fees }`): the
 * user's confirmation of the fee the check stopped for, which it is then
 * signed with (confirmedExecutorSend).
 *
 * With a `record` context the tx lands in payment history (the executor
 * address is stamped into the metadata automatically); without one the
 * broadcast is bare — callers own the recording decision.
 */
async function sendViaExecutor({
  chainId,
  to,
  data,
  executorIndex,
  record,
  intentKey,
  feeConfirmation = null,
}) {
  const executor = getSigner(executorIndex);
  const from = await executor.getAddress();
  let params = { to, value: '0', data, chainId };
  if (!(await heldIntentFor(intentKey))) {
    params = feeConfirmation
      ? confirmedExecutorSend({ chainId, to, data, executorIndex, feeConfirmation })
      : await quotedExecutorSend({ chainId, to, data, executorIndex, from });
  }
  if (record) {
    // A site's payment (a dApp's Safe transaction) takes the site's turn
    // until it is committed, as its other dApp payments do, so a silent
    // send of the site can't sign past it (auto-approve-pause.js, D12).
    const leave = record.origin ? await takeSiteTurn(record.origin) : null;
    try {
      return await signAndRecord(
        params,
        executor,
        { ...record, metadata: { ...record.metadata, executor: from } },
        { intentKey, onCommitted: leave }
      );
    } finally {
      leave?.();
    }
  }
  return signAndSendTransaction(params, executor, { intentKey });
}

/**
 * Submit a fully-signed SafeTx via `execTransaction`. Encoding is fully
 * local (protocol-kit's SafeTransaction sorts and concatenates the
 * signatures); only gas quoting and the broadcast touch the chain.
 * Executing the same SafeTx again ("Try again") while its first execution
 * is held sends that execution's bytes again, at its nonce.
 *
 * @param {Object} params
 * @param {number} params.chainId
 * @param {string} params.safeAddress - Deployed Safe
 * @param {Object} params.safeTxData - From buildSafeTransaction
 * @param {Array<{signer: string, data: string}>} params.signatures
 * @param {number} params.executorIndex - Wallet index that pays gas
 * @param {Object} [params.record] - Payment-history context (tx-recorder
 *   shape); from should be the SAFE address, the executor is stamped in
 * @returns {Promise<Object>} transaction-service result ({hash, …})
 */
async function execTransaction({
  chainId,
  safeAddress,
  safeTxData,
  signatures,
  executorIndex,
  record,
  feeConfirmation,
}) {
  const safeTx = new EthSafeTransaction(safeTxData);
  for (const { signer, data } of signatures) {
    safeTx.addSignature(new EthSafeSignature(signer, data));
  }
  const { to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver } =
    safeTx.data;
  const calldata = EXEC_INTERFACE.encodeFunctionData('execTransaction', [
    to,
    value,
    data,
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    safeTx.encodedSignatures(),
  ]);
  const { safeTxHash } = hashSafeTransaction({
    safeAddress: getAddress(safeAddress),
    chainId,
    data: safeTx.data,
  });
  return sendViaExecutor({
    chainId,
    to: getAddress(safeAddress),
    data: calldata,
    executorIndex,
    record,
    intentKey: execIntentKey(chainId, safeTxHash),
    feeConfirmation,
  });
}

/**
 * Deploy the Safe through the canonical factory, paid by the executor.
 * Also the retroactive-deployment path: same init params on another
 * chain produce the same address, claiming any funds already sent there.
 *
 * Callers that already built the deployment (e.g. to quote its gas) pass
 * it as `deployment` to skip building it again. Deploying the
 * same Safe again on the chain while its first deployment is held (an
 * activation retry) sends that deployment's bytes again, at its nonce.
 *
 * @returns {Promise<{safeAddress: string, tx: Object}>}
 */
async function deploySafe({
  owners,
  threshold,
  saltNonce,
  chainId,
  executorIndex,
  deployment,
  record,
  feeConfirmation,
}) {
  const { safeAddress, to, data } =
    deployment ?? (await buildDeploymentTransaction({ owners, threshold, saltNonce, chainId }));
  const tx = await sendViaExecutor({
    chainId,
    to,
    data,
    executorIndex,
    record,
    intentKey: deployIntentKey(chainId, safeAddress),
    feeConfirmation,
  });
  return { safeAddress, tx };
}

/**
 * Default executor: the first mnemonic owner — it always exists locally
 * and can sign + broadcast without another device round-trip. Whether it
 * can actually PAY is a UX-level check (the "needs funds" blocking state).
 *
 * @param {number[]} ownerIndexes
 * @returns {number} Wallet index
 */
function pickDefaultExecutor(ownerIndexes) {
  for (const index of ownerIndexes) {
    if (getWalletRecord(index)?.type === WALLET_TYPES.MNEMONIC) {
      return index;
    }
  }
  throw new Error('No browser account among the owners to act as executor — choose one that can pay gas');
}

module.exports = {
  SAFE_VERSION,
  pinnedSafeDeployment,
  predictSafeAddress,
  buildDeploymentTransaction,
  buildSafeTransaction,
  collectOwnerSignature,
  execTransaction,
  deploySafe,
  pickDefaultExecutor,
};
