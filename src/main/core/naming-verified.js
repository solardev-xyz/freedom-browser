/**
 * Main's executor for the naming core's verified operations (freedom-core
 * design 0004, Verified operations): `shell.verified` runs one whole
 * operation through today's Myotis or Colibri adapter and replies with its
 * outcome, as the reference receives it, without text:
 *
 * - a result, its keys in snake_case;
 * - `{ revert }`, the proven revert data an error carries;
 * - `{ failure }`, one of a closed set of classes.
 *
 * Main runs no epoch check of its own: the adapters guard themselves, and
 * the core's method checks after them as today's caller does.
 */

const { ethers } = require('ethers');
const { ShellError } = require('./core-client');
const { withDeadline, unlessAborted } = require('./naming-shell');
const { MAX_PAYLOAD } = require('./frame');
// `0x` and whole bytes, checked in constant stack: a large value can't
// exhaust a backtracking regexp's stack (see ccip-fetch's VALIDATING THE
// ANSWER).
const { isHexData } = require('../ens/ccip-fetch');

/** Operations running per verifier, counted until the adapter settles
 * (not when the core cancels): more are `unavailable` at once. Chain
 * data's operations share the count (design 0005). */
const MAX_PER_VERIFIER = 8;
/** A reply whose response can't fit one frame (1 MiB) is `too_large`
 * (deviation `verified-reply-size`): its envelope, with the largest ID,
 * counts too. */
const MAX_REPLY_BYTES = MAX_PAYLOAD;
const ENVELOPE_BYTES =
  Buffer.byteLength(
    JSON.stringify({ type: 'response', id: Number.MAX_SAFE_INTEGER, result: null })
  ) - 'null'.length;

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const RECORD_METHODS = new Set(['contenthash', 'addr', 'reverse']);

/** The adapters' keys, as the wire spells them. */
const WIRE_KEYS = {
  dataHex: 'data_hex',
  addressHex: 'address_hex',
  blockNumber: 'block_number',
  resultHex: 'result_hex',
  optimisticBlockNumber: 'optimistic_block_number',
  resolvedData: 'resolved_data',
  resolverAddress: 'resolver_address',
};

/** An adapter's result with its own keys in snake_case. */
function wire(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const out = {};
  for (const [key, value] of Object.entries(result)) out[WIRE_KEYS[key] ?? key] = value;
  return out;
}

/** An adapter's error as a class: no text crosses. */
function failureClass(err) {
  // myotisManager's verifiedRequest: Myotis' state changed while a raw
  // request was running.
  if (err?.code === 'MYOTIS_UNAVAILABLE') return 'lifecycle';
  if (err?.code === 'TIMEOUT') return 'timeout';
  // ethers' own argument check inside the adapter (dnsEncode's label
  // limit, for one).
  if (err?.code === 'INVALID_ARGUMENT') return 'invalid_argument';
  return 'error';
}

/** The revert data an adapter's error carries, if any: bytes as the core
 * reads them, `0x` and whole bytes. Anything else (an odd digit, `0X`) has
 * no byte form, so the error is a failure instead. */
function revertOf(err) {
  const data = err?.data ?? err?.info?.error?.data;
  return isHexData(data) ? data : null;
}

/** Today's adapters, loaded when first used (they load the resolvers). */
function defaultAdapters() {
  const myotis = () => require('../myotis/myotis-manager');
  const colibri = () => require('../ens/colibri-resolver');
  const ens = () => require('../ens-resolver');
  return {
    myotisRecord: (params) => require('../ens/myotis-resolver').resolveRecord(params),
    myotisCall: (params) => myotis().ethCall(params),
    myotisStatus: () => myotis().getStatus(),
    colibriResolve: (name, callData, callResolver) =>
      colibri().resolveCallViaColibri(name, callData, callResolver),
    colibriReverse: (addressBytes, coinType) =>
      colibri().resolveReverseViaColibri(addressBytes, coinType),
    callResolver: (resolver) =>
      ({
        ur: ens().universalResolverCall,
        name_nft: ens().nameNftResolverCall,
        name_nft_reverse: ens().nameNftReverseResolverCall,
      })[resolver],
  };
}

const refused = () => new ShellError('refused');
const coinType = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw refused();
  return BigInt(value);
};

/**
 * The operation `params` names: its verifier, and how to run it with the
 * adapters. Anything malformed is refused.
 */
function operation(params, adapters) {
  if (params.myotis === 'record') {
    const { method, name, address } = params;
    if (!RECORD_METHODS.has(method)) throw refused();
    if (name != null && typeof name !== 'string') throw refused();
    if (address != null && !(typeof address === 'string' && ADDRESS.test(address))) {
      throw refused();
    }
    const record = {
      method,
      ...(name != null ? { name } : {}),
      ...(address != null ? { addressHex: address } : {}),
      coinType: coinType(params.coin_type),
    };
    return { verifier: 'myotis', run: async () => wire(await adapters.myotisRecord(record)) };
  }
  if (params.myotis === 'call') {
    const { to, data } = params;
    if (typeof to !== 'string' || !ADDRESS.test(to)) throw refused();
    if (!isHexData(data)) throw refused();
    return {
      verifier: 'myotis',
      // tryMyotisContractPath: anything but `ok` with result data throws,
      // and the optimistic block is read right after.
      run: async () => {
        const rec = await adapters.myotisCall({ to, data, block: 'latest' });
        if (rec?.error || rec?.status !== 'ok' || typeof rec.resultHex !== 'string') {
          return { failure: 'error' };
        }
        const status = adapters.myotisStatus() || {};
        return {
          result_hex: rec.resultHex,
          optimistic_block_number: status.optimisticBlockNumber ?? null,
        };
      },
    };
  }
  if (params.colibri === 'resolve') {
    const { name, call_data: callData } = params;
    if (typeof name !== 'string') throw refused();
    if (!isHexData(callData)) throw refused();
    if (!['ur', 'name_nft', 'name_nft_reverse'].includes(params.resolver)) throw refused();
    const callResolver = adapters.callResolver(params.resolver);
    return {
      verifier: 'colibri',
      run: async () => wire(await adapters.colibriResolve(name, callData, callResolver)),
    };
  }
  if (params.colibri === 'reverse') {
    const { address } = params;
    if (typeof address !== 'string' || !ADDRESS.test(address)) throw refused();
    const coin = coinType(params.coin_type);
    return {
      verifier: 'colibri',
      run: async () => wire(await adapters.colibriReverse(ethers.getBytes(address), coin)),
    };
  }
  throw refused();
}

/** The reply as it will be sent: one over the cap, or one JSON can't
 * carry, is a failure. */
function bounded(reply) {
  let json;
  try {
    json = JSON.stringify(reply);
  } catch {
    return { failure: 'error' };
  }
  if (json === undefined) return { failure: 'error' };
  return Buffer.byteLength(json, 'utf8') + ENVELOPE_BYTES > MAX_REPLY_BYTES
    ? { failure: 'too_large' }
    : reply;
}

/**
 * Registers `shell.verified` on `client`.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {import('./naming-config').NamingConfig} config - the current
 *   generations
 * @param {object} [deps] - running: the operations running per verifier,
 *   shared with chain data's executor; test seam: adapters
 */
function registerNamingVerified(client, config, deps = {}) {
  const adapters = deps.adapters || defaultAdapters();
  const running = deps.running || { myotis: 0, colibri: 0 };

  client.handle('shell.verified', (params, { signal }) => {
    const generation = params.generations?.lifecycle;
    if (!Number.isSafeInteger(generation) || generation < config.generations.lifecycle) {
      throw new ShellError('stale_generation');
    }
    const { verifier, run } = operation(params, adapters);
    if (running[verifier] >= MAX_PER_VERIFIER) return { failure: 'unavailable' };
    running[verifier] += 1;
    // The whole operation, which never rejects: it runs on to its end
    // whoever waits for it.
    const done = Promise.resolve()
      .then(run)
      .then(bounded, (err) => {
        const revert = revertOf(err);
        return bounded(revert ? { revert } : { failure: failureClass(err) });
      })
      .finally(() => {
        running[verifier] -= 1;
      });
    return withDeadline(params, signal, (within) => unlessAborted(done, within));
  });

  return { running };
}

module.exports = {
  registerNamingVerified,
  MAX_PER_VERIFIER,
  MAX_REPLY_BYTES,
  ENVELOPE_BYTES,
};
