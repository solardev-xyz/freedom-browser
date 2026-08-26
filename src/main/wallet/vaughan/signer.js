/**
 * Vaughan signing backend for the wallet signer factory.
 *
 * Mirrors the Ledger backend contract: verify the connected Vaughan account
 * still matches the persisted record before every signing call, then forward
 * to the local EIP-1193 WebSocket server. Approval UX lives in Vaughan (TUI);
 * this process never sees private keys.
 *
 * `signTransaction` uses `vaughan_signTransaction` (sign-and-return raw tx)
 * so Freedom Browser can broadcast via its own RPC pool — matching the
 * existing `Signer.signTransaction` contract.
 */

const { rpcRequest } = require('./transport');
const { createVaughanError, VAUGHAN_ERROR_CODES } = require('./errors');

/** Signing needs human approval in Vaughan; allow several minutes. */
const SIGN_TIMEOUT_MS = 5 * 60 * 1000;

function asPersonalSignMessage(message) {
  if (Buffer.isBuffer(message)) {
    return '0x' + message.toString('hex');
  }
  if (message instanceof Uint8Array) {
    return '0x' + Buffer.from(message).toString('hex');
  }
  return String(message);
}

/** EIP-1193 quantities are hex strings; ethers may hand us bigint/number. */
function toHexQuantity(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'string') {
    if (value.startsWith('0x') || value.startsWith('0X')) {
      return value;
    }
    if (/^\d+$/.test(value)) {
      return '0x' + BigInt(value).toString(16);
    }
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'number') {
    return '0x' + BigInt(value).toString(16);
  }
  return undefined;
}

/**
 * Map an ethers-style unsigned tx object into EIP-1193 `TxParams`.
 *
 * @param {object} tx
 * @param {string} fromAddress
 */
function toEip1193Tx(tx, fromAddress) {
  const to = tx.to === null || tx.to === undefined ? undefined : String(tx.to);
  const data = tx.data !== undefined && tx.data !== null ? String(tx.data) : undefined;
  const params = {
    from: fromAddress,
    to,
    data,
    value: toHexQuantity(tx.value),
    gas: toHexQuantity(tx.gasLimit ?? tx.gas),
    gasPrice: toHexQuantity(tx.gasPrice),
    maxFeePerGas: toHexQuantity(tx.maxFeePerGas),
    maxPriorityFeePerGas: toHexQuantity(tx.maxPriorityFeePerGas),
    nonce: toHexQuantity(tx.nonce),
    chainId: toHexQuantity(tx.chainId),
  };
  // Drop undefined keys so Vaughan does not see explicit nulls.
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
}

function assertAccountMatches(record, accounts) {
  const expected = (record.address || '').toLowerCase();
  if (!expected) {
    throw createVaughanError(VAUGHAN_ERROR_CODES.UNAUTHORIZED);
  }
  const actual = Array.isArray(accounts) && accounts[0] ? String(accounts[0]).toLowerCase() : '';
  if (!actual) {
    // eth_accounts answered empty: Vaughan is locked or the site grant is
    // gone (lock/restart). Distinct from an account mismatch — the fix is
    // reconnecting, not switching accounts.
    throw createVaughanError(VAUGHAN_ERROR_CODES.NOT_CONNECTED);
  }
  if (actual !== expected) {
    throw createVaughanError(
      VAUGHAN_ERROR_CODES.UNAUTHORIZED,
      undefined,
      "Vaughan's active account differs from the paired account. Switch accounts in Vaughan or re-pair."
    );
  }
}

async function withVerifiedAccount(record, task) {
  const accounts = await rpcRequest('eth_accounts', []);
  assertAccountMatches(record, accounts);
  return task();
}

/**
 * @param {{address: string, type?: string}} record - Vaughan wallet record from vault-meta
 * @returns {import('../signers').Signer}
 */
function createVaughanBackend(record) {
  return {
    getAddress: async () => {
      const accounts = await rpcRequest('eth_accounts', []);
      assertAccountMatches(record, accounts);
      return record.address;
    },

    signMessage: async (message) =>
      withVerifiedAccount(record, () =>
        rpcRequest('personal_sign', [asPersonalSignMessage(message), record.address], {
          timeoutMs: SIGN_TIMEOUT_MS,
        })
      ),

    signTransaction: async (tx) =>
      withVerifiedAccount(record, () =>
        rpcRequest('vaughan_signTransaction', [toEip1193Tx(tx, record.address)], {
          timeoutMs: SIGN_TIMEOUT_MS,
        })
      ),

    signTypedData: async (typedData) =>
      withVerifiedAccount(record, () =>
        rpcRequest('eth_signTypedData_v4', [record.address, typedData], {
          timeoutMs: SIGN_TIMEOUT_MS,
        })
      ),
  };
}

module.exports = {
  createVaughanBackend,
  toEip1193Tx,
  toHexQuantity,
  SIGN_TIMEOUT_MS,
};
