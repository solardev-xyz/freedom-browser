const { ethers } = require('ethers');
const myotis = require('../myotis/myotis-manager');

// Myotis 0.1.7's ENS API walks the legacy registry. Its generic EVM API
// verifies arbitrary calls against an attested optimistic root, so use that
// API for the canonical Universal Resolver and ethers' ERC-3668 driver.
class MyotisProvider extends ethers.AbstractProvider {
  constructor() {
    super(1, { cacheTimeout: -1 });
    this.epoch = myotis.getAvailabilityEpoch();
  }

  async _detectNetwork() {
    return ethers.Network.from(1);
  }

  async ccipReadFetch(transaction, data, urls) {
    for (const template of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const sender = transaction.to.toLowerCase();
        const url = template.replaceAll('{sender}', sender).replaceAll('{data}', data);
        if (!['https:', 'http:'].includes(new URL(url).protocol)) continue;
        const get = template.includes('{data}');
        const response = await fetch(url, {
          method: get ? 'GET' : 'POST',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            ...(get ? {} : { 'Content-Type': 'application/json' }),
          },
          body: get ? undefined : JSON.stringify({ sender, data }),
        });
        if (!response.ok || Number(response.headers.get('content-length')) > 4 * 1024 * 1024) {
          await response.body?.cancel();
          continue;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('CCIP response too large');
          }
          chunks.push(next.value);
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')).data;
        if (typeof result === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(result)) return result;
      } catch {
        /* Try the next gateway without logging names, URLs or payloads. */
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('CCIP gateways unavailable or returned invalid data');
  }

  async _perform(request) {
    if (request.method !== 'call') throw new Error('Unsupported Myotis ENS request');
    if (!myotis.isReady() || this.epoch !== myotis.getAvailabilityEpoch()) {
      throw new Error('Myotis availability changed during ENS resolution');
    }
    const tx = request.transaction;
    const rec = await myotis.ethCall({ to: tx.to, data: tx.data, block: 'latest' });
    if (!myotis.isReady() || this.epoch !== myotis.getAvailabilityEpoch()) {
      throw new Error('Myotis availability changed during ENS resolution');
    }
    if (rec.status === 'revert' && typeof rec.dataHex === 'string') {
      throw ethers.AbiCoder.getBuiltinCallException('call', tx, rec.dataHex);
    }
    if (rec.status !== 'ok' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(rec.resultHex)) {
      throw new Error('Myotis Universal Resolver call unavailable');
    }
    return rec.resultHex;
  }
}

async function resolveRecord({ method, name, addressHex, coinType = 60n }) {
  // Lazy import: ens-resolver invokes this adapter after module initialization.
  const {
    universalResolverCall,
    universalResolverReverse,
    isResolverNotFoundError,
  } = require('../ens-resolver');
  const provider = new MyotisProvider();
  // Generic calls are always optimistic in the pinned addon. Each callback
  // is independently verified; never claim finalized or block-pinned results.
  const metadata = { verified: false, blockNumber: null };
  try {
    if (method === 'reverse') {
      const result = await universalResolverReverse(
        provider,
        ethers.getBytes(addressHex),
        {},
        coinType
      );
      return { ...metadata, status: result.name ? 'ok' : 'noRecord', name: result.name };
    }
    const iface = new ethers.Interface([
      'function addr(bytes32) view returns (address)',
      'function addr(bytes32,uint256) view returns (bytes)',
      'function contenthash(bytes32) view returns (bytes)',
    ]);
    const fn =
      method === 'contenthash'
        ? 'contenthash'
        : coinType === 60n
          ? 'addr(bytes32)'
          : 'addr(bytes32,uint256)';
    const args = [ethers.namehash(name)];
    if (fn === 'addr(bytes32,uint256)') args.push(coinType);
    const { resolvedData } = await universalResolverCall(
      provider,
      name,
      iface.encodeFunctionData(fn, args)
    );
    const [value] = iface.decodeFunctionResult(fn, resolvedData);
    return {
      ...metadata,
      status: value === '0x' || value === ethers.ZeroAddress ? 'noRecord' : 'ok',
      ...(method === 'contenthash' ? { dataHex: value } : { addressHex: value }),
    };
  } catch (err) {
    if (isResolverNotFoundError(err)) return { ...metadata, status: 'noRecord' };
    throw err;
  } finally {
    provider.destroy();
  }
}

module.exports = { MyotisProvider, resolveRecord };
