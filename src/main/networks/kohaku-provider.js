/** Read-only subset of Kohaku's EthereumProvider. Main supplies reviewed
 * contracts/selectors/events; SDK code cannot widen the grant. No receipt,
 * signing or submission authority is implied by this synchronization surface.
 */
const { createPrivateRpc, isQuantity } = require('./private-rpc');
const { getPrivacyContext, privacyError } = require('./privacy-context');
const address = (value) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const selector = (value) => typeof value === 'string' && /^0x[0-9a-f]{8}$/i.test(value);
const bytes = (value) => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value) && value.length <= 131074;
const block = (value) => isQuantity(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

function createKohakuProvider({ handle, contracts, signal, publicReadHandle, publicContracts = [], logFloors = [], onScan, beforeScan, onHead }) {
  const context = getPrivacyContext(handle);
  if (context.subject.kind !== 'private-account' || context.subject.role !== 'protocol-rpc') {
    throw privacyError('PRIVATE_SDK_UNAVAILABLE', 'Protocol provider requires its own private-account context');
  }
  const refused = () => privacyError('PRIVATE_SDK_RPC_REFUSED', 'SDK RPC request is outside its read capability');
  if (!Array.isArray(contracts) || !contracts.length || contracts.length > 16) throw refused();
  if ((onScan !== undefined && typeof onScan !== 'function') || (beforeScan !== undefined && typeof beforeScan !== 'function') ||
      (onHead !== undefined && typeof onHead !== 'function')) throw refused();
  let completedWindows = 0, scannedBlocks = 0;
  const grants = new Map();
  for (const contract of contracts) {
    if (!onlyKeys(contract, ['address', 'selectors', 'eventTopics']) || !address(contract.address) ||
        !Array.isArray(contract.selectors) || contract.selectors.length > 64 || !contract.selectors.every(selector) ||
        !Array.isArray(contract.eventTopics) || contract.eventTopics.length > 64 || !contract.eventTopics.every(hash) ||
        grants.has(contract.address.toLowerCase())) throw refused();
    grants.set(contract.address.toLowerCase(), {
      selectors: new Set(contract.selectors.map((value) => value.toLowerCase())),
      events: new Set(contract.eventTopics.map((value) => value.toLowerCase())),
    });
  }
  // Only main may declare an audited lower bound for a particular contract.
  // Token contracts may predate the pool, so there is no provider-wide floor.
  const floors = new Map();
  if (!Array.isArray(logFloors) || logFloors.length > contracts.length) throw refused();
  for (const floor of logFloors) {
    if (!onlyKeys(floor, ['address', 'fromBlock']) || !address(floor.address) || !grants.has(floor.address.toLowerCase()) ||
        !Number.isSafeInteger(floor.fromBlock) || floor.fromBlock < 0 || floors.has(floor.address.toLowerCase())) throw refused();
    floors.set(floor.address.toLowerCase(), BigInt(floor.fromBlock));
  }
  if (beforeScan && [...grants].some(([target, grant]) => grant.events.size && !floors.has(target))) throw refused();
  const scanFloor = beforeScan && floors.size ? [...floors.values()].reduce((a, b) => a < b ? a : b) : 0n;
  let observedHead = null;
  const rpc = createPrivateRpc(handle, 'protocol-rpc', { signal });
  let publicRpc, ownerWord;
  if (!Array.isArray(publicContracts) || publicContracts.some((target) => !address(target) || !grants.has(target.toLowerCase()))) throw refused();
  const ownerTargets = new Set(publicContracts.map((target) => target.toLowerCase()));
  if (ownerTargets.size) {
    const owner = getPrivacyContext(publicReadHandle);
    if (owner.profileId !== context.profileId || owner.generation !== context.generation || owner.subject.kind !== 'public-address' ||
        owner.subject.role !== 'transaction-rpc' || owner.subject.chainId !== context.subject.chainId || owner.subject.operation !== null ||
        owner.subject.protocol !== null || owner.subject.deployment !== null) throw refused();
    ownerWord = owner.subject.principal.slice(2).padStart(64, '0');
    publicRpc = createPrivateRpc(publicReadHandle, 'transaction-rpc', { signal });
  }
  const route = (target) => ownerTargets.has(target?.toLowerCase()) ? publicRpc : rpc;
  const read = async (method, params, validate, target) => (await route(target).request(method, params, validate)).result;
  const head = async (target) => {
    const value = await read('eth_blockNumber', [], block, target);
    if (!target) { observedHead = BigInt(value); onHead?.(observedHead); }
    return value;
  };
  async function request(input) {
    rpc.assertActive();
    if (!onlyKeys(input, ['method', 'params']) || typeof input.method !== 'string') throw refused();
    const { method, params = [] } = input;
    if (!Array.isArray(params)) throw refused();
    if (method === 'eth_chainId' && params.length === 0) {
      await rpc.ready();
      return `0x${context.subject.chainId.toString(16)}`;
    }
    if (method === 'eth_blockNumber' && params.length === 0) return head();
    if (method === 'eth_getBlockByNumber' && params.length === 2 && params[0] === 'finalized' && params[1] === false) {
      const result = await read(method, ['finalized', false], (value) => value === null ||
        (value && block(value.number) && hash(value.hash)));
      // Return only the public finality observation, never transaction objects.
      return result === null ? null : { number: result.number, hash: result.hash };
    }
    if (method === 'eth_getCode' && params.length === 2 && address(params[0]) && grants.has(params[0].toLowerCase()) && params[1] === 'latest') {
      return read(method, [params[0].toLowerCase(), 'latest'], bytes, params[0]);
    }
    if (method === 'eth_call' && params.length === 2 && params[1] === 'latest') {
      const call = params[0];
      if (!onlyKeys(call, ['to', 'data']) || !address(call.to) || !bytes(call.data) || call.data.length > 8194 ||
          !grants.get(call.to.toLowerCase())?.selectors.has(call.data.slice(0, 10).toLowerCase())) throw refused();
      if (!ownerTargets.has(call.to.toLowerCase()) && ownerWord && call.data.slice(10).toLowerCase().includes(ownerWord)) throw refused();
      return read(method, [{ to: call.to.toLowerCase(), data: call.data }, 'latest'], bytes, call.to);
    }
    if (method === 'eth_getLogs' && params.length === 1) {
      const filter = params[0];
      if (!onlyKeys(filter, ['address', 'topics', 'fromBlock', 'toBlock']) || !address(filter.address) ||
          !grants.has(filter.address.toLowerCase()) || !block(filter.fromBlock) ||
          !(filter.toBlock === 'latest' || block(filter.toBlock)) || !Array.isArray(filter.topics) || filter.topics.length !== 1) throw refused();
      const target = filter.address.toLowerCase();
      const topics = Array.isArray(filter.topics[0]) ? filter.topics[0] : [filter.topics[0]];
      if (!topics.length || topics.length > 64 || !topics.every((value) => hash(value) && grants.get(target).events.has(value.toLowerCase()))) throw refused();
      // Copy before the first await: the SDK cannot mutate a validated grant
      // or filter while the chain check/head request is in flight.
      const allowedTopics = new Set(topics.map((value) => value.toLowerCase()));
      let from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock === 'latest' ? await head() : filter.toBlock);
      if (to < from || to - from >= 5000n) throw refused();
      const floor = floors.get(target) || 0n;
      if (to < floor) { rpc.assertActive(); return []; }
      if (from < floor) from = floor;
      const query = { address: target, topics: [[...allowedTopics]], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` };
      if (beforeScan) {
        if (observedHead === null) await head();
        beforeScan({ fromBlock: from, toBlock: to, floor: scanFloor, head: observedHead });
      }
      // These grants permit only unfiltered public event scans. They carry no
      // owner topic and must not share the owner's transaction connection.
      const result = await read(method, [query], (logs) => Array.isArray(logs) && logs.length <= 2048 && logs.every((log) =>
        log && address(log.address) && log.address.toLowerCase() === target && Array.isArray(log.topics) &&
        log.topics.length > 0 && log.topics.length <= 4 && log.topics.every(hash) && allowedTopics.has(log.topics[0].toLowerCase()) &&
        bytes(log.data) && block(log.blockNumber) && BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to &&
        hash(log.blockHash) && hash(log.transactionHash) && block(log.logIndex) && log.removed === false));
      rpc.assertActive();
      completedWindows++; scannedBlocks += Number(to - from + 1n);
      if (!Number.isSafeInteger(scannedBlocks)) throw refused();
      try { Promise.resolve(onScan?.(Object.freeze({ completedWindows, scannedBlocks }))).catch(() => {}); } catch { /* Diagnostics are optional. */ }
      rpc.assertActive(); return result;
    }
    throw refused();
  }
  const unsupported = async () => { rpc.assertActive(); throw refused(); };
  // _internal deliberately points to the same narrow request capability, never
  // a raw provider/transport. Convenience methods cannot bypass validation.
  return Object.freeze({
    _internal: Object.freeze({ request }), request,
    getChainId: async () => BigInt(await request({ method: 'eth_chainId' })),
    getBlockNumber: async () => BigInt(await request({ method: 'eth_blockNumber' })),
    getCode: (target) => request({ method: 'eth_getCode', params: [target, 'latest'] }),
    call: (call) => request({ method: 'eth_call', params: [call, 'latest'] }),
    getLogs: unsupported, getTransactionReceipt: unsupported, waitForTransaction: unsupported,
    getBalance: unsupported, getTransactionCount: unsupported, estimateGas: unsupported, getGasPrice: unsupported,
    trust: rpc.trust, privacy: rpc.privacy, verified: false,
  });
}

module.exports = { createKohakuProvider };
