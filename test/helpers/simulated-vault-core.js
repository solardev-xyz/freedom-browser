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
      // The core signs only the confirmed digest (freedom-core #88): any
      // other is invalid_argument, before the key (so also while locked).
      typedData: async (key, data, expectedHash) => {
        core.calls.push(['sign.typed_data', key, data, expectedHash]);
        const hash = TypedDataEncoder.hash(data.domain, data.types, data.message);
        if (expectedHash !== hash) {
          throw Object.assign(
            new Error('invalid typed data: typed data hash is not the confirmed one (expected_hash)'),
            { code: 'invalid_argument' }
          );
        }
        if (!identity.isUnlocked()) {
          throw Object.assign(new Error('Vault is locked'), { code: 'vault_locked' });
        }
        return wallet().signTypedData(data.domain, data.types, data.message);
      },
    },
    typedDataView: async (data, options = {}) => {
      core.calls.push(['typed_data.hash', data, options]);
      return {
        hash: TypedDataEncoder.hash(data.domain, data.types, data.message),
        view: simulatedView(data, options),
      };
    },
    typedDataHash: async (data) => {
      core.calls.push(['typed_data.hash', data]);
      return TypedDataEncoder.hash(data.domain, data.types, data.message);
    },
  };
}

/**
 * The core's view of typed data (freedom-core design 0002, #88): ethers'
 * getPayload with primaryType as primary_type, and the three reports.
 */
function simulatedView(data, { primaryType, chainId } = {}) {
  const payload = TypedDataEncoder.getPayload(data.domain, data.types, data.message);
  const declared = new Set((payload.types[payload.primaryType] || []).map((field) => field.name));
  const ignored = Object.keys(data.message || {})
    .filter((key) => !declared.has(key))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  let namedType = 'unknown';
  if (primaryType !== undefined) {
    namedType = typeof primaryType === 'string' && primaryType === payload.primaryType ? 'match' : 'mismatch';
  }
  const domainChain = data.domain?.chainId;
  let chain = 'unknown';
  if (domainChain === undefined || domainChain === null) chain = 'absent';
  else if (chainId !== undefined) chain = BigInt(domainChain) === BigInt(chainId) ? 'match' : 'mismatch';
  return {
    types: payload.types,
    domain: payload.domain,
    primary_type: payload.primaryType,
    message: payload.message,
    ignored,
    named_type: namedType,
    chain,
  };
}

module.exports = { simulatedVaultBackend, simulatedView };
