'use strict';

const { keccak256, toQuantity, dnsEncode } = require('ethers');
const { ADDRESSES, ABI, CODE_HASHES, refuse, ZeroAddress } = require('./contracts');
const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const boundedRecord = value => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8192) refuse('This existing record is too large for the direct domain editor. Use its management app.', 'DOMAIN_UNSUPPORTED');
  return value;
};

class DomainChain {
  constructor(options = {}) {
    // Uses the same node/proxy/privacy policy as Freedom's wallet. No private
    // public-RPC fallback or endpoint chosen by the model.
    this.addresses = { ...ADDRESSES, ...options.addresses };
    this.codeHashes = { ...CODE_HASHES, ...options.codeHashes };
    this.request = options.request || ((method, params) => require('../networks/chain-data-router').request(1, method, params).then(response => response.result));
  }
  async snapshot(receipt) {
    let block = await this.request('eth_getBlockByNumber', ['latest', false]);
    // A receipt can arrive before a node's (or router's) latest-block view has
    // caught up. Never verify a mined effect against an earlier block.
    if (receipt && block?.number && BigInt(block.number) < BigInt(receipt.blockNumber)) {
      block = await this.request('eth_getBlockByNumber', [receipt.blockNumber, false]);
    }
    if (!block?.hash || !block.number || !block.timestamp) refuse('The current Ethereum block is unavailable.');
    if (receipt && (BigInt(block.number) < BigInt(receipt.blockNumber) ||
        (BigInt(block.number) === BigInt(receipt.blockNumber) && block.hash !== receipt.blockHash))) {
      refuse('Ethereum state has not caught up with the confirmed transaction. Check the same operation again; do not resend it.', 'DOMAIN_CHAIN_BEHIND');
    }
    return { tag: block.number, hash: block.hash, timestamp: Number(BigInt(block.timestamp)) };
  }
  async call(role, method, args, snapshot, from) {
    const abi = ABI[role] || ABI.nft;
    const to = this.addresses[role];
    if (!abi || !to) refuse('Unsupported domain contract.');
    return this.callAt(role, to, method, args, snapshot, from);
  }
  async callAt(role, to, method, args, snapshot, from) {
    const abi = ABI[role] || ABI.nft;
    const data = abi.encodeFunctionData(method, args);
    const result = await this.request('eth_call', [{ to, data, ...(from && { from }) }, snapshot.tag]);
    return abi.decodeFunctionResult(method, result);
  }
  async checkCode(role, snapshot) {
    const code = await this.request('eth_getCode', [this.addresses[role], snapshot.tag]);
    if (!this.codeHashes[role] || keccak256(code) !== this.codeHashes[role]) refuse('The domain contract version has changed or is unsupported. Use its official app until Freedom has qualified it.', 'DOMAIN_UNSUPPORTED');
  }
  async inspect(parsed, keys = [], receipt) {
    const snapshot = await this.snapshot(receipt);
    const role = parsed.namespace;
    if (role === 'eth') {
      let v2;
      if (parsed.topLevel) {
        [v2] = await this.call('ensRegistry', 'getState', [parsed.tokenId], snapshot);
        const [available] = await this.call('ensRegistrar', 'isAvailable', [parsed.label], snapshot);
        // RESERVED entries are premigrated v1 names. An expired reservation
        // still uses the legacy renewer during its contract-defined grace.
        if (v2.status !== 1n && !(v2.status === 0n && v2.latestOwner === ZeroAddress && v2.expiry > 0n && !available)) {
          return this.inspectV2(parsed, keys, snapshot, v2, available);
        }
      }
      const [manager] = await this.call('registry', 'owner', [parsed.node], snapshot);
      const [resolver] = await this.call('registry', 'resolver', [parsed.node], snapshot);
      let owner = manager;
      let expiry = null;
      let wrapped = sameAddress(manager, ADDRESSES.wrapper);
      if (parsed.topLevel) {
        [expiry] = await this.call('base', 'nameExpires', [parsed.tokenId], snapshot);
        if (expiry > BigInt(snapshot.timestamp)) [owner] = await this.call('base', 'ownerOf', [parsed.tokenId], snapshot);
        else owner = ZeroAddress; // ownerOf deliberately reverts during ENS grace.
      }
      let wrapperExpiry;
      let fuses;
      if (wrapped) [owner, fuses, wrapperExpiry] = await this.call('wrapper', 'getData', [parsed.node], snapshot);
      const available = false;
      const records = {};
      const resolverRole = sameAddress(resolver, this.addresses.resolver) ? 'resolver'
        : sameAddress(resolver, this.addresses.ensPublicResolver) ? 'ensPublicResolver' : null;
      const supportedResolver = Boolean(resolverRole);
      if (supportedResolver) {
        records.contenthash = boundedRecord((await this.call(resolverRole, 'contenthash', [parsed.node], snapshot))[0]);
        records.address = (await this.call(resolverRole, 'addr(bytes32)', [parsed.node], snapshot))[0];
        records.text = Object.create(null);
        for (const key of keys) records.text[key] = boundedRecord((await this.call(resolverRole, 'text', [parsed.node, key], snapshot))[0]);
      }
      return { ...parsed, ensVersion: 1, resolverRole, registryResource: v2?.resource.toString(), owner, manager, recordOwner: wrapped ? owner : manager, resolver, supportedResolver, wrapped, fuses: fuses?.toString(),
        wrapperExpiry: wrapperExpiry?.toString(), expiry: expiry?.toString() || null, available,
        active: manager !== ZeroAddress && (expiry === null || expiry > BigInt(snapshot.timestamp)), records, snapshot };
    }
    const parent = parsed.name.split('.').slice(1).join('.');
    const parentId = parsed.topLevel ? '0' : (await this.call(role, 'computeId', [parent], snapshot))[0].toString();
    const [available] = await this.call(role, 'isAvailable', [parsed.label, parentId], snapshot);
    const record = await this.call(role, 'records', [parsed.tokenId], snapshot);
    const [epoch] = await this.call(role, 'recordVersion', [parsed.tokenId], snapshot);
    let owner = ZeroAddress;
    // ownerOf is deliberately only called for a recorded token; an RPC error
    // is never interpreted as availability or absence of ownership.
    if (record.label) [owner] = await this.call(role, 'ownerOf', [parsed.tokenId], snapshot);
    const [resolvedAddress] = await this.call(role, 'resolve', [parsed.tokenId], snapshot);
    const records = { contenthash: boundedRecord((await this.call(role, 'contenthash', [parsed.tokenId], snapshot))[0]), address: resolvedAddress, text: Object.create(null) };
    for (const key of keys) records.text[key] = boundedRecord((await this.call(role, 'text', [parsed.tokenId, key], snapshot))[0]);
    return { ...parsed, owner, manager: owner, resolver: ADDRESSES[role], supportedResolver: true,
      available, active: resolvedAddress !== ZeroAddress, expiry: record.expiresAt.toString(),
      epoch: epoch.toString(), parentEpoch: record.parentEpoch.toString(), records, snapshot };
  }
  async inspectV2(parsed, keys, snapshot, state, available) {
    const owner = state.status === 2n && state.expiry > BigInt(snapshot.timestamp) ? state.latestOwner : ZeroAddress;
    const [resolver] = await this.call('ensRegistry', 'getResolver', [parsed.label], snapshot);
    let resolverRole = sameAddress(resolver, this.addresses.ensPublicResolver) ? 'ensPublicResolver' : null;
    if (!resolverRole && resolver !== ZeroAddress) {
      if (await this.request('eth_getCode', [resolver, snapshot.tag]) !== '0x') {
        try {
          const [implementation] = await this.call('ensFactory', 'verifyContract', [resolver], snapshot);
          if (sameAddress(implementation, this.addresses.ensResolverImpl)) resolverRole = 'ensResolverImpl';
        } catch (error) {
          // Only this factory's explicit rejection means an unsupported resolver.
          // Transport failures and malformed responses must still surface.
          const data = error.data ?? error.info?.error?.data;
          const expected = ABI.ensFactory.encodeErrorResult('VerificationFailed', [resolver]);
          if (typeof data !== 'string' || data.toLowerCase() !== expected.toLowerCase()) throw error;
        }
      }
    }
    const records = resolverRole ? { text: Object.create(null) } : {};
    if (resolverRole === 'ensPublicResolver') {
      records.contenthash = boundedRecord((await this.call(resolverRole, 'contenthash', [parsed.node], snapshot))[0]);
      records.address = (await this.call(resolverRole, 'addr(bytes32)', [parsed.node], snapshot))[0];
      for (const key of keys) records.text[key] = boundedRecord((await this.call(resolverRole, 'text', [parsed.node, key], snapshot))[0]);
    } else if (resolverRole) {
      const read = async (method, args) => {
        const [result] = await this.callAt(resolverRole, resolver, 'resolve', [dnsEncode(parsed.name, 255), ABI.resolver.encodeFunctionData(method, args)], snapshot);
        return ABI.resolver.decodeFunctionResult(method, result)[0];
      };
      records.contenthash = boundedRecord(await read('contenthash', [parsed.node]));
      records.address = await read('addr', [parsed.node]);
      for (const key of keys) records.text[key] = boundedRecord(await read('text', [parsed.node, key]));
    }
    return { ...parsed, ensVersion: 2, registryResource: state.resource.toString(), registryTokenId: state.tokenId.toString(),
      owner, manager: state.latestOwner, recordOwner: owner, resolver, resolverRole, supportedResolver: Boolean(resolverRole),
      wrapped: false, expiry: state.expiry.toString(), available, active: owner !== ZeroAddress, records, snapshot };
  }
  async simulate(tx, snapshot) {
    await this.request('eth_call', [{ from: tx.from, to: tx.to, data: tx.data, value: toQuantity(BigInt(tx.value)) }, snapshot.tag]);
  }
  async receipt(hash) {
    const receipt = await this.request('eth_getTransactionReceipt', [hash]);
    if (!receipt) return null;
    const block = await this.request('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!block || block.hash !== receipt.blockHash) return null;
    return receipt;
  }
}
module.exports = { DomainChain, sameAddress };
