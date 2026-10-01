/** Operation-specific remote evidence. Only an explicit review can accept its
 * unverified provenance; refresh again before every subsequent spend. */
const { Interface } = require('ethers');
const { createPrivateRpc, isQuantity } = require('../networks/private-rpc');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { NATIVE } = require('./ppv2-deposit-policy');
const { hash } = require('./ppv2-relay-policy');
const ABI = [
  'event Transacted(uint256[] outputCommitments,uint256[] nullifierHashes,address indexed asset,uint256 withdrawnValue,address indexed caller)',
  'event Ragequit(address indexed ragequitter,address indexed asset,uint256 value,uint256 commitment,uint256 nullifierHash,uint256 label)',
  'event Note(bytes32 indexed hint,bytes data)',
  'function spentNullifiers(uint256) view returns(uint256)',
];
const iface = new Interface(ABI),
  txTopic = iface.getEvent('Transacted').topicHash,
  noteTopic = iface.getEvent('Note').topicHash;
const exitTopic = iface.getEvent('Ragequit').topicHash;
const settled = (observation) => ['included', 'exited'].includes(observation?.status);
const HASH = /^0x[0-9a-f]{64}$/i;
const block = (v) => isQuantity(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
const fail = () =>
  privacyError(
    'PRIVATE_PPV2_RECONCILIATION_REFUSED',
    'Relay reconciliation could not establish matching evidence'
  );
function createPPv2RelayReconciliation({ handle, journal, getOperationHandle }) {
  const context = getPrivacyContext(handle);
  journal.assertScope(handle);
  if (typeof getOperationHandle !== 'function') throw fail();
  const empty = (status) => ({
    status,
    transactionHash: null,
    blockHash: null,
    blockNumber: null,
    trust: 'unverified-rpc',
  });
  async function inspect(record, maxBlocks, compact, signal) {
    const operationHandle = getOperationHandle(record.id),
      operation = getPrivacyContext(operationHandle);
    if (
      operation.profileId !== context.profileId ||
      operation.generation !== context.generation ||
      operation.subject.operation !== record.id ||
      Object.keys(context.subject).some(
        (key) => key !== 'operation' && operation.subject[key] !== context.subject[key]
      )
    )
      throw fail();
    const rpc = createPrivateRpc(operationHandle, 'protocol-rpc', { signal });
    try {
      if (compact && record.resolution && settled(record.observation)) {
        const prior = record.observation;
        const { result: canonical } = await rpc.request(
          'eth_getBlockByNumber',
          [`0x${prior.blockNumber.toString(16)}`, false],
          (v) => v === null || (block(v.number) && HASH.test(v.hash))
        );
        if (!canonical || Number(BigInt(canonical.number)) !== prior.blockNumber) throw fail();
        if (canonical.hash.toLowerCase() !== prior.blockHash) return empty('conflict');
        return prior; // The block hash commits to the previously reviewed receipt/logs.
      }
      const read = async (method, params, valid) =>
        (await rpc.request(method, params, valid)).result;
      const s = record.settlement;
      if (!s) return empty('unknown');
      const final = await read(
        'eth_getBlockByNumber',
        ['finalized', false],
        (b) => b === null || (block(b.number) && HASH.test(b.hash))
      );
      if (!final) throw fail();
      if (BigInt(final.number) < BigInt(s.fromBlock)) {
        if (settled(record.observation)) throw fail();
        return empty('unknown');
      }
      // One bounded page per observation. Persist progress only after matching
      // boundary reads; callers can resume after a restart without a burst of RPCs.
      const known = settled(record.observation) ? record.observation.blockNumber : null;
      let start = BigInt(known ?? s.fromBlock);
      if (known === null && record.scan) {
        const checkpoint = await read(
          'eth_getBlockByNumber',
          [`0x${(BigInt(record.scan.nextBlock) - 1n).toString(16)}`, false],
          (v) => v === null || (block(v.number) && HASH.test(v.hash))
        );
        if (
          !checkpoint ||
          BigInt(checkpoint.number) !== BigInt(record.scan.nextBlock) - 1n ||
          checkpoint.hash.toLowerCase() !== record.scan.blockHash ||
          BigInt(final.number) < BigInt(record.scan.nextBlock) - 1n
        ) {
          return { observation: empty('unknown'), scan: null };
        }
        start = BigInt(record.scan.nextBlock);
      }
      if (start > BigInt(final.number)) {
        if (known !== null) throw fail();
        return { observation: empty('unknown'), scan: record.scan };
      }
      const end =
        known !== null
          ? start
          : start + BigInt(maxBlocks - 1) < BigInt(final.number)
            ? start + BigInt(maxBlocks - 1)
            : BigInt(final.number);
      const endHex = `0x${end.toString(16)}`;
      const anchor = await read(
        'eth_getBlockByNumber',
        [endHex, false],
        (v) => v === null || (block(v.number) && HASH.test(v.hash))
      );
      if (!anchor || BigInt(anchor.number) !== end) throw fail();
      if (known !== null && anchor.hash.toLowerCase() !== record.observation.blockHash)
        return empty('conflict');
      const logs = await read(
        'eth_getLogs',
        [
          {
            address: s.pool,
            topics: [[txTopic, exitTopic]],
            fromBlock: `0x${start.toString(16)}`,
            toBlock: endHex,
          },
        ],
        (v) => Array.isArray(v) && v.length <= 2048
      );
      const matches = [];
      for (const log of logs) {
        if (
          log.address?.toLowerCase() !== s.pool ||
          log.removed !== false ||
          !block(log.blockNumber) ||
          !HASH.test(log.blockHash) ||
          !HASH.test(log.transactionHash) ||
          BigInt(log.blockNumber) < start ||
          BigInt(log.blockNumber) > end
        )
          throw fail();
        const e = iface.parseLog(log);
        if (!e || !['Transacted', 'Ragequit'].includes(e.name)) throw fail();
        if (
          e.name === 'Ragequit'
            ? e.args.nullifierHash === BigInt(record.nullifier)
            : e.args.nullifierHashes.some((v) => v === BigInt(record.nullifier))
        )
          matches.push(log);
      }
      const after = await read(
        'eth_getBlockByNumber',
        [endHex, false],
        (v) => v === null || (block(v.number) && HASH.test(v.hash))
      );
      if (
        !after ||
        BigInt(after.number) !== end ||
        after.hash.toLowerCase() !== anchor.hash.toLowerCase()
      )
        throw fail();
      if (!matches.length) {
        if (known !== null) throw fail(); // Missing index data is not evidence of a reorg.
        return {
          observation: empty('unknown'),
          scan: { nextBlock: Number(end + 1n), blockHash: anchor.hash.toLowerCase() },
        };
      }
      if (matches.length !== 1) return empty('conflict');
      const found = matches[0],
        parsedEvent = iface.parseLog(found),
        event = parsedEvent.args,
        exited = parsedEvent.name === 'Ragequit';
      if (exited) {
        if (
          !s.owner ||
          event.ragequitter.toLowerCase() !== s.owner ||
          event.commitment !== BigInt(record.commitment) ||
          event.value !== BigInt(s.inputValue) ||
          event.asset.toLowerCase() !== (s.token || NATIVE)
        )
          return empty('conflict');
      } else if (
        event.nullifierHashes.length !== 1 ||
        event.outputCommitments.length !== 1 ||
        event.outputCommitments[0] !== BigInt(s.outputCommitment) ||
        event.asset.toLowerCase() !== (s.token || NATIVE) ||
        event.withdrawnValue !== BigInt(s.amountOut) ||
        event.caller.toLowerCase() !== s.processor
      )
        return empty('conflict');
      const receipt = await read(
        'eth_getTransactionReceipt',
        [found.transactionHash],
        (v) =>
          v === null ||
          (v &&
            HASH.test(v.transactionHash) &&
            HASH.test(v.blockHash) &&
            block(v.blockNumber) &&
            Array.isArray(v.logs) &&
            v.logs.length <= 2048)
      );
      if (!receipt) throw fail();
      if (
        receipt.status !== '0x1' ||
        receipt.transactionHash.toLowerCase() !== found.transactionHash.toLowerCase() ||
        receipt.blockHash.toLowerCase() !== found.blockHash.toLowerCase() ||
        receipt.blockNumber !== found.blockNumber ||
        receipt.to?.toLowerCase() !== (exited ? s.pool : s.processor) ||
        (exited && receipt.from?.toLowerCase() !== s.owner)
      )
        return empty('conflict');
      const notes = [],
        transacts = [];
      for (const log of receipt.logs) {
        if (
          log.address?.toLowerCase() !== s.pool ||
          ![txTopic, noteTopic, exitTopic].includes(log.topics?.[0])
        )
          continue;
        if (
          log.removed !== false ||
          log.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
          log.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
          log.blockNumber !== receipt.blockNumber
        )
          return empty('conflict');
        const parsed = iface.parseLog(log);
        if (parsed.name === 'Note')
          notes.push({
            hint: parsed.args.hint.toLowerCase(),
            data: parsed.args.data.toLowerCase(),
          });
        else transacts.push(log);
      }
      if (
        transacts.length !== 1 ||
        transacts[0].data.toLowerCase() !== found.data.toLowerCase() ||
        JSON.stringify(transacts[0].topics) !== JSON.stringify(found.topics) ||
        (exited ? notes.length !== 0 : hash(JSON.stringify(notes)) !== s.noteDigest)
      )
        return empty('conflict');
      const canonical = await read(
        'eth_getBlockByNumber',
        [receipt.blockNumber, false],
        (v) => v === null || (block(v.number) && HASH.test(v.hash))
      );
      const spent = await read(
        'eth_call',
        [
          { to: s.pool, data: iface.encodeFunctionData('spentNullifiers', [record.nullifier]) },
          'latest',
        ],
        (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v)
      );
      if (!canonical) throw fail();
      if (
        canonical.number !== receipt.blockNumber ||
        canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
        BigInt(spent) === 0n
      )
        return empty('conflict');
      return {
        status: exited ? 'exited' : 'included',
        transactionHash: receipt.transactionHash.toLowerCase(),
        blockHash: receipt.blockHash.toLowerCase(),
        blockNumber: Number(BigInt(receipt.blockNumber)),
        trust: 'unverified-rpc',
      };
    } finally {
      rpc.release?.();
    }
  }
  async function observeRecord(id, { maxBlocks = 5000 } = {}, compact = false, signal) {
    if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 5000) throw fail();
    const record = (await journal.list()).find((r) => r.id === id);
    if (!record?.settlement) throw fail();
    let result;
    try {
      result = await inspect(record, maxBlocks, compact, signal);
    } catch {
      getPrivacyContext(handle);
      throw fail();
    }
    getPrivacyContext(handle);
    if (signal?.aborted) throw fail();
    return journal.observe(
      id,
      result.observation || result,
      record.revision || 0,
      result.observation ? result.scan : settled(result) ? null : undefined
    );
  }
  const observe = (id, options) => observeRecord(id, options);
  const archiveResolved = require('./privacy-journal-archiver').createJournalArchiver({
    journal,
    kind: 'relay',
    lifetime: context.signal,
    assertActive: () => getPrivacyContext(handle),
    withRpc: async (record, signal, task) => {
      const operationHandle = getOperationHandle(record.id),
        operation = getPrivacyContext(operationHandle);
      if (
        operation.profileId !== context.profileId ||
        operation.generation !== context.generation ||
        operation.subject.operation !== record.id ||
        Object.keys(context.subject).some(
          (key) => key !== 'operation' && operation.subject[key] !== context.subject[key]
        )
      )
        throw fail();
      const rpc = createPrivateRpc(operationHandle, 'protocol-rpc', { signal });
      try {
        return await task(rpc);
      } finally {
        rpc.release?.();
      }
    },
  });
  return Object.freeze({
    observe,
    archiveResolved,
    async refreshResolved(signal) {
      const records = (await journal.list()).filter((r) => r.resolution);
      for (let offset = 0; offset < records.length; offset += 4) {
        // Drain the batch before returning errors; no late journal writes after
        // a failed refresh. Each record retains its own transport context.
        const results = await Promise.allSettled(
          records.slice(offset, offset + 4).map((r) => observeRecord(r.id, {}, true, signal))
        );
        const failed = results.find((r) => r.status === 'rejected');
        if (failed) throw failed.reason;
      }
    },
    async resolve(id, review) {
      if (typeof review !== 'function') throw fail();
      const first = await observe(id);
      if (!settled(first.observation)) throw fail();
      const approval = await review(first);
      getPrivacyContext(handle);
      if (approval?.allowNextOperation !== true || approval.acceptedEvidence !== 'unverified-rpc')
        throw fail();
      const second = await observe(id);
      if (
        !settled(second.observation) ||
        second.observation.status !== first.observation.status ||
        second.observation.blockHash !== first.observation.blockHash ||
        second.observation.transactionHash !== first.observation.transactionHash ||
        second.revision !== first.revision + 1
      )
        throw fail();
      return journal.resolve(id, second.revision);
    },
  });
}
module.exports = { createPPv2RelayReconciliation, ABI };
