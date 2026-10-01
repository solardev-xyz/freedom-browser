/** Explicitly accepts retiring automatic revalidation of old remote evidence.
 * The journal commits the entire prefix and permanent reuse guards atomically.
 */
const { MINIMUM_AGE_MS, ARCHIVE_MAX, fail } = require('./privacy-journal-retention');
const { isExitIntent } = require('./private-transaction-intent');
const { privacyError } = require('../networks/privacy-context');
const { isQuantity } = require('../networks/private-rpc');
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const quantity = (v) => isQuantity(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER);
const block = (v) => v && hash(v.hash) && quantity(v.number);

function createJournalArchiver({ journal, kind, withRpc, assertActive, lifetime }) {
  const id = kind === 'public' ? 'hash' : 'id';
  async function inspect(records, signal) {
    const evidence = [];
    for (const record of records) {
      assertActive();
      if (signal.aborted) throw fail();
      evidence.push(
        await withRpc(record, signal, async (rpc) => {
          const read = async (method, params, valid) => {
            assertActive();
            if (signal.aborted) throw fail();
            const { result } = await rpc.request(method, params, valid);
            assertActive();
            if (signal.aborted) throw fail();
            return result;
          };
          const latest = await read('eth_blockNumber', [], quantity);
          const final = await read('eth_getBlockByNumber', ['finalized', false], block);
          const prior = record.observation,
            tag = `0x${prior.blockNumber.toString(16)}`;
          if (
            BigInt(final.number) > BigInt(latest) ||
            BigInt(final.number) < BigInt(prior.blockNumber)
          )
            throw fail();
          const canonical = await read('eth_getBlockByNumber', [tag, false], block);
          const finalAfter = await read('eth_getBlockByNumber', [final.number, false], block);
          const canonicalAfter = await read('eth_getBlockByNumber', [tag, false], block);
          if (
            BigInt(canonical.number) !== BigInt(tag) ||
            BigInt(canonicalAfter.number) !== BigInt(tag) ||
            BigInt(finalAfter.number) !== BigInt(final.number) ||
            finalAfter.hash.toLowerCase() !== final.hash.toLowerCase() ||
            canonicalAfter.hash.toLowerCase() !== canonical.hash.toLowerCase()
          )
            throw fail();
          assertActive();
          if (signal.aborted) throw fail();
          return {
            matches: canonical.hash.toLowerCase() === prior.blockHash,
            anchor: {
              blockNumber: Number(BigInt(final.number)),
              blockHash: final.hash.toLowerCase(),
            },
          };
        })
      );
    }
    // No writes at all if any read failed. Confirmed contradictions take the
    // normal conflict path; they cannot be hidden by archival.
    for (let i = 0; i < records.length; i++)
      if (!evidence[i].matches) {
        const r = records[i];
        assertActive();
        if (signal.aborted) throw fail();
        await journal.observe(
          r[id],
          kind === 'public'
            ? {
                status: 'reorged',
                blockHash: null,
                blockNumber: null,
                confirmations: 0,
                observedAt: Date.now(),
                trust: 'unverified',
              }
            : {
                status: 'conflict',
                transactionHash: null,
                blockHash: null,
                blockNumber: null,
                trust: 'unverified-rpc',
              },
          r.revision
        );
        throw fail();
      }
    return evidence.map((e) => e.anchor);
  }

  return async function archive({ review, limit = 16, timeoutMs = 120000 } = {}) {
    if (
      typeof review !== 'function' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 16 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000
    )
      throw fail();
    assertActive();
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(lifetime ? [lifetime] : []),
    ]);
    const task = async () => {
      const records = await journal.list(),
        archive = await journal.listArchive();
      const prefix = [];
      for (const record of records) {
        if (
          kind === 'public' &&
          (!record.intent || (isExitIntent(record.intent) && !record.intent.commitment))
        )
          break;
        if (
          prefix.length === limit ||
          !record.resolution ||
          Date.now() - record.resolution.reviewedAt < MINIMUM_AGE_MS ||
          (kind === 'relay' && !record.settlement)
        )
          break;
        prefix.push(record);
      }
      if (!prefix.length) throw fail();
      if (archive.length + prefix.length > ARCHIVE_MAX)
        throw privacyError(
          'PRIVATE_HISTORY_ARCHIVE_FULL',
          'Permanent submission history capacity reached'
        );
      const before = await inspect(prefix, signal);
      const decision = await review(
        Object.freeze({
          action: 'archive-final-history',
          kind,
          recordCount: prefix.length,
          blockRange: Object.freeze({
            from: Math.min(...prefix.map((r) => r.observation.blockNumber)),
            to: Math.max(...prefix.map((r) => r.observation.blockNumber)),
          }),
          records: Object.freeze(prefix),
          finalized: Object.freeze(before.map((a) => Object.freeze(a))),
          stopsRevalidation: true,
          retainedReuseGuards: true,
          evidence: 'unverified-rpc',
        })
      );
      assertActive();
      if (signal.aborted) throw fail();
      if (
        decision?.archiveResolvedHistory !== true ||
        decision.acceptedEvidence !== 'unverified-rpc' ||
        decision.stopRevalidating !== true
      )
        throw fail();
      const after = await inspect(prefix, signal);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw fail();
      assertActive();
      if (signal.aborted) throw fail();
      await journal.archiveResolved(
        prefix.map((r) => ({ [id]: r[id], revision: r.revision })),
        after
      );
      return Object.freeze({
        archived: prefix.length,
        retained: archive.length + prefix.length,
        capacity: ARCHIVE_MAX,
        stopsRevalidation: true,
        evidence: 'unverified-rpc',
      });
    };
    // A hung review or RPC cannot commit later: every post-await write checks
    // the deadline, and the original task is drained by these handlers.
    return new Promise((resolve, reject) => {
      const abort = () => reject(fail());
      signal.addEventListener('abort', abort, { once: true });
      task()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  };
}
module.exports = { createJournalArchiver };
