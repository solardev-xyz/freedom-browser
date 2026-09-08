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

const { getAddress, verifyTypedData, Interface, TypedDataEncoder } = require('ethers');
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
  signAndSendTransaction,
} = require('../transaction-service');
const { signAndRecord } = require('../tx-recorder');
const { getWalletRecord, WALLET_TYPES } = require('../../identity-manager');
const { getEip1193Provider } = require('../provider-manager');

/** Contract version every freedom Safe is created with. */
const SAFE_VERSION = '1.4.1';

const EXEC_INTERFACE = new Interface([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);

const resolveProvider = (provider, chainId) => provider ?? getEip1193Provider(chainId);

/** protocol-kit instance for a not-yet-assumed-deployed safe. */
function initPredictedKit({ owners, threshold, saltNonce, chainId, provider }) {
  // This layer works in owner ADDRESSES; wallet records store owners as
  // wallet INDEXES — fail loudly on the mixup instead of letting the
  // address parser produce a cryptic error deep inside protocol-kit.
  if (!Array.isArray(owners) || owners.some((owner) => typeof owner !== 'string')) {
    throw new Error('Safe owners must be addresses here — resolve wallet indexes first');
  }
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
 * Counterfactual (CREATE2) address for the given init params — the same
 * on every chain, deployed or not.
 *
 * @param {Object} params
 * @param {string[]} params.owners - Owner addresses
 * @param {number} params.threshold
 * @param {string|number} params.saltNonce
 * @param {number} params.chainId
 * @param {Object|string} [params.provider] - EIP-1193 or RPC URL override
 * @returns {Promise<string>} Checksummed address
 */
async function predictSafeAddress({ owners, threshold, saltNonce, chainId, provider }) {
  const kit = await initPredictedKit({ owners, threshold, saltNonce, chainId, provider });
  return getAddress(await kit.getAddress());
}

/**
 * The raw deployment transaction (to = canonical factory) plus the
 * address it will land on, for callers that want to inspect or quote it
 * before sending.
 *
 * @returns {Promise<{safeAddress: string, to: string, value: string, data: string}>}
 */
async function buildDeploymentTransaction({ owners, threshold, saltNonce, chainId, provider }) {
  const kit = await initPredictedKit({ owners, threshold, saltNonce, chainId, provider });
  const safeAddress = getAddress(await kit.getAddress());
  const { to, value, data } = await kit.createSafeDeploymentTransaction();
  assertCanonicalFactory(to);
  return { safeAddress, to: getAddress(to), value: String(value), data };
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
  const resolved = resolveProvider(provider, chainId);
  let kit = await initPredictedKit({ ...safe, chainId, provider: resolved });
  const safeAddress = getAddress(await kit.getAddress());

  // Guard the reproducibility invariant: if the record's stored address
  // no longer matches its init params, something mutated what must be
  // frozen — refuse rather than sign for the wrong account.
  if (safe.address && getAddress(safe.address) !== safeAddress) {
    throw new Error(
      `Safe address mismatch: record says ${safe.address}, init params derive ${safeAddress}`
    );
  }

  const deployed = await kit.isSafeDeployed();
  if (deployed) {
    kit = await kit.connect({ provider: resolved, safeAddress });
  }

  const safeTx = await kit.createTransaction({
    transactions: [{ to: getAddress(tx.to), value: String(tx.value ?? '0'), data: tx.data || '0x' }],
  });
  const typedData = toJsonSafe(
    generateTypedData({
      safeAddress,
      safeVersion: SAFE_VERSION,
      chainId: BigInt(chainId),
      data: safeTx.data,
    })
  );
  const safeTxHash = TypedDataEncoder.hash(
    typedData.domain,
    withoutDomainType(typedData.types),
    typedData.message
  );

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

/**
 * Quote gas against the executor account and broadcast through the
 * ordinary transaction-service path (the executor EOA pays the fee).
 *
 * With a `record` context the tx lands in payment history (the executor
 * address is stamped into the metadata automatically); without one the
 * broadcast is bare — callers own the recording decision.
 */
async function sendViaExecutor({ chainId, to, data, executorIndex, record }) {
  const executor = getSigner(executorIndex);
  const from = await executor.getAddress();
  const [{ gasLimit }, gasPrices] = await Promise.all([
    estimateGas({ from, to, value: '0', data, chainId }),
    getGasPrices(chainId),
  ]);
  const params = { to, value: '0', data, gasLimit, ...toFeeFields(gasPrices), chainId };
  if (record) {
    return signAndRecord(params, executor, {
      ...record,
      metadata: { ...record.metadata, executor: from },
    });
  }
  return signAndSendTransaction(params, executor);
}

/**
 * Submit a fully-signed SafeTx via `execTransaction`. Encoding is fully
 * local (protocol-kit's SafeTransaction sorts and concatenates the
 * signatures); only gas quoting and the broadcast touch the chain.
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
async function execTransaction({ chainId, safeAddress, safeTxData, signatures, executorIndex, record }) {
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
  return sendViaExecutor({
    chainId,
    to: getAddress(safeAddress),
    data: calldata,
    executorIndex,
    record,
  });
}

/**
 * Deploy the Safe through the canonical factory, paid by the executor.
 * Also the retroactive-deployment path: same init params on another
 * chain produce the same address, claiming any funds already sent there.
 *
 * Callers that already built the deployment (e.g. to quote its gas) pass
 * it as `deployment` to skip the second protocol-kit build.
 *
 * @returns {Promise<{safeAddress: string, tx: Object}>}
 */
async function deploySafe({ owners, threshold, saltNonce, chainId, executorIndex, provider, deployment, record }) {
  const { safeAddress, to, data } =
    deployment ??
    (await buildDeploymentTransaction({ owners, threshold, saltNonce, chainId, provider }));
  const tx = await sendViaExecutor({ chainId, to, data, executorIndex, record });
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
  predictSafeAddress,
  buildDeploymentTransaction,
  buildSafeTransaction,
  collectOwnerSignature,
  execTransaction,
  deploySafe,
  pickDefaultExecutor,
};
