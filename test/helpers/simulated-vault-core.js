/**
 * The identity core's signing methods (freedom-core design 0002) for unit
 * tests, simulated with ethers. The real core matches ethers byte for byte
 * for every input it accepts (freedom-core vectors/signing.json), so tests
 * of main's wiring can compare against ethers directly.
 *
 * `identity.isUnlocked()` drives the lock and `identity.exportPrivateKey()`
 * the key the simulation signs with; every call is recorded in
 * `core.calls` as `[method, ...args]`.
 */
const { Wallet, TypedDataEncoder } = require('ethers');

function simulatedVaultBackend(identity, core) {
  const wallet = () => new Wallet(identity.exportPrivateKey());
  const admit = (method, ...args) => {
    core.calls.push([method, ...args]);
    if (!identity.isUnlocked()) {
      throw Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
    }
  };
  return {
    addresses: async ({ accounts = [] } = {}) => {
      admit('keys.addresses', accounts);
      return {
        user_wallets: accounts.map((account) => ({ account, address: wallet().address })),
      };
    },
    sign: {
      transaction: async (key, tx) => {
        admit('sign.transaction', key, tx);
        const fees =
          tx.type === 0
            ? { gasPrice: BigInt(tx.gas_price) }
            : {
                maxFeePerGas: BigInt(tx.max_fee_per_gas),
                maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas),
              };
        const raw = await wallet().signTransaction({
          type: tx.type,
          chainId: BigInt(tx.chain_id),
          nonce: Number(tx.nonce),
          gasLimit: BigInt(tx.gas_limit),
          to: tx.to,
          value: BigInt(tx.value),
          data: tx.data,
          ...fees,
        });
        return { raw };
      },
      message: async (key, bytes) => {
        admit('sign.message', key, Buffer.from(bytes).toString('hex'));
        return wallet().signMessage(bytes);
      },
      typedData: async (key, data) => {
        admit('sign.typed_data', key, data);
        return wallet().signTypedData(data.domain, data.types, data.message);
      },
    },
    typedDataHash: async (data) => {
      core.calls.push(['typed_data.hash', data]);
      return TypedDataEncoder.hash(data.domain, data.types, data.message);
    },
  };
}

module.exports = { simulatedVaultBackend };
