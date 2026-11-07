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
const { formatEther, getAddress } = require('ethers');

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
const chainData = require('../../networks/chain-data');
const {
  codedError,
  SAFE_NEEDS_FUNDS,
  SAFE_UNVERIFIED,
  SAFE_ADDRESS_MISMATCH,
} = require('./errors');

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
 * Whether a verified check has marked the Safe deployed on `chainId`
 * (#1066). This is the only way any caller accepts a Safe as active:
 * status and activation (isDeployedOnChain), Send and SafeMessages.
 *
 * The record seams expose only verified marks. A mark a release before
 * #1066 wrote from one endpoint's answer reads as not deployed, so that
 * Safe stays pending until isDeployedOnChain's verified read marks it
 * again; the status card runs it whenever the account is shown.
 */
function isMarkedDeployed(record, chainId = DEPLOY_CHAIN_ID) {
  return record?.deployed?.[chainId] === true;
}

/**
 * Deployment truth: the record short-circuits (deployment is permanent),
 * otherwise the chain is asked and a positive answer heals the record
 * (covers deploys that confirmed after the app quit).
 *
 * The mark is for good, so only a verified answer makes it (#1066): the
 * core's chain router labels a read `verified` from Myotis, Colibri or a
 * quorum of agreeing distinct endpoints (freedom-core design 0005). Code
 * that no verified source confirms marks nothing and is reported as
 * unverified (SAFE_UNVERIFIED), and the next status check asks again.
 * Activation is not offered on it either: the Safe may well be deployed.
 */
async function isDeployedOnChain(record, chainId) {
  if (isMarkedDeployed(record, chainId)) {
    return true;
  }
  const { result: code, verified } = await chainData.request(chainId, 'eth_getCode', [
    record.address,
    'latest',
  ]);
  if (!code || code === '0x') {
    return false;
  }
  if (verified !== true) {
    throw codedError(
      "Freedom couldn't verify on Gnosis whether this account is activated. " +
        'Try again, or add an RPC provider in Settings.',
      SAFE_UNVERIFIED
    );
  }
  await markSafeDeployed(record.index, chainId);
  return true;
}

/**
 * The deployment must create the record's own address (#1066): the one
 * the Safe was shown with and funds may already have been sent to. A
 * deployment to another address is refused before it is quoted or sent.
 */
function assertDeploysRecordAddress(record, deployment) {
  if (getAddress(deployment.safeAddress) !== getAddress(record.address)) {
    throw codedError(
      `This account's address is ${record.address}, but activating it would create ` +
        `${deployment.safeAddress}. Freedom won't activate it.`,
      SAFE_ADDRESS_MISMATCH
    );
  }
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
      assertDeploysRecordAddress(record, built);
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
 * should render getSafeStatus's blocking state instead of retrying. Throws
 * `SAFE_ADDRESS_MISMATCH`, with nothing sent, when the deployment would
 * create another address than the record's, and `SAFE_UNVERIFIED` when
 * the chain shows code at the address that no verified source confirms.
 * After the deployment is sent, it also throws `SAFE_UNVERIFIED`, with
 * nothing marked, when neither its receipt nor the Safe's code is
 * verified (confirmDeployment).
 *
 * The executor's fee is judged by the fee check at confirmation (design
 * 0005, A): one that needs the user stops with nothing signed
 * (FEE_CHECK_NEEDS_CONFIRMATION), and the activation runs again with
 * `feeConfirmation`, the user's confirmation of that fee.
 *
 * @param {number} index - Wallet index of the safe record
 * @param {{ feeConfirmation?: Object }} [options]
 * @returns {Promise<{safeAddress: string, hash?: string, alreadyDeployed?: boolean}>}
 */
async function activateSafe(index, { feeConfirmation = null } = {}) {
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
    feeConfirmation,
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
  await confirmDeployment(record, receipt);
  return { safeAddress, hash: tx.hash };
}

/**
 * Mark the Safe deployed after its deployment's receipt, but only on a
 * verified check (#1066). The receipt may come from one endpoint, and so
 * may the broadcast: a dishonest one can return the right hash without
 * relaying the transaction, then answer a successful receipt for it.
 *
 * So the receipt marks the Safe only when a verified source gave it.
 * Otherwise a verified eth_getCode read must show the Safe's code. If
 * neither does, nothing is marked and the Safe stays pending: activation
 * refuses with SAFE_UNVERIFIED, and the next status check reads again.
 */
async function confirmDeployment(record, receipt) {
  if (receipt.verified === true) {
    await markSafeDeployed(record.index, DEPLOY_CHAIN_ID);
    return;
  }
  let deployed = false;
  try {
    deployed = await isDeployedOnChain(record, DEPLOY_CHAIN_ID);
  } catch (err) {
    console.warn('[SafeService] Could not verify the Safe deployment:', err.message);
  }
  if (!deployed) {
    throw codedError(
      "Freedom sent the activation, but couldn't verify on Gnosis that it went through. " +
        'It checks again the next time you open this account. ' +
        'If it stays unverified, add an RPC provider in Settings.',
      SAFE_UNVERIFIED
    );
  }
}

module.exports = {
  DEPLOY_CHAIN_ID,
  chainRead,
  getSafeRecord,
  isMarkedDeployed,
  resolveOwnerAddresses,
  createSafeAccount,
  getSafeStatus,
  activateSafe,
};
