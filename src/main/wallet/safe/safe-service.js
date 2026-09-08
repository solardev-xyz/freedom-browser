/**
 * Safe account lifecycle above the executor: create the record (predict
 * the counterfactual address, freeze the init params), report the
 * deploy/funds status the UI renders as blocking states, and activate
 * (deploy) on chain.
 *
 * "Needs funds" is a first-class state here, not an error path: every
 * flow that costs gas resolves WHO pays (the default executor — first
 * mnemonic owner) and whether they CAN, so the renderer can block with a
 * "fund <address>" card instead of failing mid-flight.
 *
 * v1 deploys on Gnosis only (research doc Part B, decision 5); the
 * chainId parameter exists so retroactive deployment on other chains can
 * ship later without reshaping the API.
 */

const crypto = require('crypto');
const { formatEther } = require('ethers');

const {
  getWalletRecord,
  addSafeWallet,
  markSafeDeployed,
  WALLET_TYPES,
} = require('../../identity-manager');
const {
  predictSafeAddress,
  buildDeploymentTransaction,
  deploySafe,
  pickDefaultExecutor,
} = require('./safe-executor');
const {
  estimateGas,
  getGasPrices,
  toFeeFields,
  waitForTransaction,
} = require('../transaction-service');
const { KINDS: PAYMENT_KINDS } = require('../tx-recorder');
const { getEip1193Provider } = require('../provider-manager');
const { codedError, SAFE_NEEDS_FUNDS } = require('./errors');

/** v1: Safes deploy on Gnosis only (decision 5). */
const DEPLOY_CHAIN_ID = 100;

/** 128-bit random decimal salt — one per created Safe, then frozen. */
function generateSaltNonce() {
  return BigInt('0x' + crypto.randomBytes(16).toString('hex')).toString(10);
}

function getSafeRecord(index) {
  const record = getWalletRecord(index);
  if (!record || record.type !== WALLET_TYPES.SAFE) {
    throw new Error(`Wallet ${index} is not a Safe account`);
  }
  return record;
}

function resolveOwnerAddresses(ownerIndexes) {
  return ownerIndexes.map((ownerIndex) => {
    const record = getWalletRecord(ownerIndex);
    if (!record) {
      throw new Error(`Owner wallet index ${ownerIndex} does not exist`);
    }
    if (!record.address) {
      throw new Error(`Owner "${record.name}" has no address yet — unlock the vault once first`);
    }
    return record.address;
  });
}

/** Raw uncached read — long-lived ethers providers can serve stale state. */
function chainRead(chainId, method, params) {
  return getEip1193Provider(chainId).request({ method, params });
}

/**
 * Create a Safe account record: resolve the owners' addresses, generate
 * the salt, predict the CREATE2 address, store everything frozen.
 *
 * @param {Object} params
 * @param {string} params.name - Display name ('' → auto "Safe N")
 * @param {number[]} params.ownerIndexes - Wallet indexes of the owners
 * @param {number} params.threshold - 1 (of 2) or 2 (of 3)
 * @returns {Promise<Object>} The stored record
 */
async function createSafeAccount({ name, ownerIndexes, threshold }) {
  const owners = resolveOwnerAddresses(ownerIndexes);
  const saltNonce = generateSaltNonce();
  const address = await predictSafeAddress({
    owners,
    threshold,
    saltNonce,
    chainId: DEPLOY_CHAIN_ID,
  });
  return addSafeWallet(name, { address, owners: ownerIndexes, threshold, saltNonce });
}

/**
 * Deployment truth: the record short-circuits (deployment is permanent),
 * otherwise the chain is asked and a positive answer heals the record
 * (covers deploys that confirmed after the app quit).
 */
async function isDeployedOnChain(record, chainId) {
  if (record.deployed?.[chainId]) {
    return true;
  }
  const code = await chainRead(chainId, 'eth_getCode', [record.address, 'latest']);
  if (code && code !== '0x') {
    await markSafeDeployed(record.index, chainId);
    return true;
  }
  return false;
}

/**
 * One pass over everything activation depends on: deployment truth,
 * executor, and (when a quote is needed) the built deployment tx with
 * its cost against the executor's balance. `deployment` is returned so
 * activateSafe can broadcast the exact tx that was quoted instead of
 * rebuilding it.
 */
async function assessActivation(record) {
  const chainId = DEPLOY_CHAIN_ID;
  const deployed = await isDeployedOnChain(record, chainId);

  let executorIndex = null;
  let executorAddress = null;
  try {
    executorIndex = pickDefaultExecutor(record.owners);
    executorAddress = getWalletRecord(executorIndex).address;
  } catch {
    // No mnemonic owner — nothing local can pay gas; surfaced below.
  }

  const base = { deployed, chainId, executorIndex, executorAddress };
  if (deployed) {
    return { status: { ...base, executorBalance: null, estimatedCost: null, needsFunds: false } };
  }
  if (executorIndex === null) {
    return { status: { ...base, executorBalance: null, estimatedCost: null, needsFunds: true } };
  }

  let deployment;
  const [{ gasLimit }, gasPrices, balanceHex] = await Promise.all([
    buildDeploymentTransaction({
      owners: resolveOwnerAddresses(record.owners),
      threshold: record.threshold,
      saltNonce: record.saltNonce,
      chainId,
    }).then((built) => {
      deployment = built;
      return estimateGas({
        from: executorAddress,
        to: built.to,
        value: '0',
        data: built.data,
        chainId,
      });
    }),
    getGasPrices(chainId),
    chainRead(chainId, 'eth_getBalance', [executorAddress, 'latest']),
  ]);

  const fees = toFeeFields(gasPrices);
  const estimatedCost = BigInt(gasLimit) * BigInt(fees.maxFeePerGas ?? fees.gasPrice);
  const executorBalance = BigInt(balanceHex);

  return {
    deployment,
    status: {
      ...base,
      executorBalance: executorBalance.toString(),
      estimatedCost: estimatedCost.toString(),
      needsFunds: executorBalance < estimatedCost,
    },
  };
}

/**
 * Everything the UI needs to render the account's blocking states:
 * deployed / ready-to-activate / needs-funds / no-local-executor.
 *
 * @param {number} index - Wallet index of the safe record
 * @returns {Promise<{deployed: boolean, chainId: number,
 *   executorIndex: number|null, executorAddress: string|null,
 *   executorBalance: string|null, estimatedCost: string|null,
 *   needsFunds: boolean}>} Balances/costs in wei decimal strings
 */
async function getSafeStatus(index) {
  const { status } = await assessActivation(getSafeRecord(index));
  return status;
}

/**
 * Deploy the Safe's contract with the record's frozen init params. Waits
 * for confirmation and only then marks the record deployed.
 *
 * Throws with `code: 'SAFE_NEEDS_FUNDS'` when nothing can pay — callers
 * should render getSafeStatus's blocking state instead of retrying.
 *
 * @param {number} index - Wallet index of the safe record
 * @returns {Promise<{safeAddress: string, hash?: string, alreadyDeployed?: boolean}>}
 */
async function activateSafe(index) {
  const record = getSafeRecord(index);
  const { status, deployment } = await assessActivation(record);

  if (status.deployed) {
    return { safeAddress: record.address, alreadyDeployed: true };
  }
  if (status.executorIndex === null || status.needsFunds) {
    const message =
      status.executorIndex === null
        ? 'None of the owners is a browser account that could pay the activation fee'
        : `Fund ${status.executorAddress} with at least ${formatEther(status.estimatedCost)} xDAI to activate`;
    throw codedError(message, SAFE_NEEDS_FUNDS);
  }

  const { safeAddress, tx } = await deploySafe({
    owners: resolveOwnerAddresses(record.owners),
    threshold: record.threshold,
    saltNonce: record.saltNonce,
    chainId: DEPLOY_CHAIN_ID,
    executorIndex: status.executorIndex,
    deployment,
    // The executor paid gas to create the safe: from = executor
    // (tx-recorder default), the safe is what came into existence.
    record: {
      kind: PAYMENT_KINDS.SAFE_DEPLOY,
      toAddress: record.address,
      amount: '0',
      metadata: { safeAddress: record.address },
    },
  });

  const receipt = await waitForTransaction(tx.hash, DEPLOY_CHAIN_ID);
  if (receipt.status !== 'confirmed') {
    throw new Error('Safe deployment transaction failed on chain');
  }
  await markSafeDeployed(index, DEPLOY_CHAIN_ID);
  return { safeAddress, hash: tx.hash };
}

module.exports = {
  DEPLOY_CHAIN_ID,
  chainRead,
  getSafeRecord,
  resolveOwnerAddresses,
  createSafeAccount,
  getSafeStatus,
  activateSafe,
};
