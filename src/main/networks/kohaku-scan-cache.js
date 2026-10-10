/** Disposable, encrypted-by-host checkpoints of complete public log pages.
 * They never advance the SDK cursor or claim verified/comprehensive chain data.
 */
const { privacyError } = require('./privacy-context');
const { isQuantity } = require('./private-rpc');
const MAX_BYTES = 512 * 1024;
const MAX_PAGES = 256;
const MAX_AGE_MS = 60 * 60 * 1000;
const hexHash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const quantity = (value) => isQuantity(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
const header = (value) => value && quantity(value.number) && hexHash(value.hash);
const fail = () =>
  privacyError('PRIVATE_SCAN_CACHE_INVALID', 'Scan checkpoint could not be validated');
function keyOf(query) {
  return JSON.stringify({
    address: query.address.toLowerCase(),
    topics: [[...query.topics[0]].map((topic) => topic.toLowerCase()).sort()],
    fromBlock: `0x${BigInt(query.fromBlock).toString(16)}`,
    toBlock: `0x${BigInt(query.toBlock).toString(16)}`,
  });
}
function decode(value) {
  if (value === null) return [];
  try {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) throw fail();
    const state = JSON.parse(value);
    if (
      state.version !== 1 ||
      Object.keys(state).length !== 2 ||
      !Array.isArray(state.pages) ||
      state.pages.length > MAX_PAGES
    )
      throw fail();
    const keys = new Set();
    for (const page of state.pages) {
      if (
        !page ||
        Object.keys(page).length !== 4 ||
        typeof page.key !== 'string' ||
        page.key.length > 8192 ||
        !hexHash(page.blockHash) ||
        !Number.isSafeInteger(page.savedAt) ||
        page.savedAt < 0 ||
        !Array.isArray(page.logs) ||
        keys.has(page.key)
      )
        throw fail();
      keys.add(page.key);
    }
    return state.pages;
  } catch {
    // Logical cache damage is disposable; storage authentication happens outside.
    return [];
  }
}
function consistent(logs, end, anchor) {
  const blocks = new Map();
  for (const log of logs) {
    if (!quantity(log.blockNumber) || !hexHash(log.blockHash)) return false;
    const number = BigInt(log.blockNumber).toString(),
      hash = log.blockHash.toLowerCase();
    if (
      (BigInt(log.blockNumber) === BigInt(end) && hash !== anchor) ||
      (blocks.has(number) && blocks.get(number) !== hash)
    )
      return false;
    blocks.set(number, hash);
  }
  return true;
}
function createKohakuScanCache({ storage, read, assertActive }) {
  let finalObservation = null,
    finalObservedAt = 0,
    finalPending = null;
  async function readHeader(tag) {
    assertActive();
    let result;
    try {
      result = await read('eth_getBlockByNumber', [tag, false], (v) => v === null || header(v));
    } catch (error) {
      assertActive();
      if (error.code?.startsWith('PRIVATE_PROFILE_')) throw error;
      return null;
    }
    assertActive();
    if (!header(result)) return null;
    if (tag !== 'finalized' && BigInt(result.number) !== BigInt(tag)) throw fail();
    return result;
  }
  async function finalized(end) {
    const age = Date.now() - finalObservedAt;
    if (
      finalObservation &&
      age >= 0 &&
      age < 60000 &&
      BigInt(finalObservation.number) >= BigInt(end)
    )
      return finalObservation;
    if (!finalPending)
      finalPending = readHeader('finalized')
        .then((result) => {
          finalObservation = result;
          finalObservedAt = Date.now();
          return result;
        })
        .finally(() => {
          finalPending = null;
        });
    return finalPending;
  }
  async function canonical(tag) {
    return (await readHeader(tag))?.hash.toLowerCase() ?? null;
  }
  async function update(change) {
    assertActive();
    try {
      await storage.update((value) => {
        assertActive();
        const pages = change(decode(value));
        let encoded = JSON.stringify({ version: 1, pages });
        while (pages.length > MAX_PAGES || Buffer.byteLength(encoded) > MAX_BYTES) {
          pages.shift();
          encoded = JSON.stringify({ version: 1, pages });
        }
        return encoded;
      });
    } catch (error) {
      assertActive();
      if (!['PRIVATE_STORAGE_WRITE_FAILED', 'PRIVATE_STORAGE_LIMIT'].includes(error.code))
        throw error;
      // A disposable checkpoint cannot turn a successful log read into a failed scan.
    }
    assertActive();
  }
  return Object.freeze({
    async logs(query, validate, { bypass = false } = {}) {
      // The provider grants and snapshots the complete query before calling us.
      const key = keyOf(query),
        request = JSON.parse(key);
      assertActive();
      const pages = decode(await storage.get());
      assertActive();
      if (storage.available === false) {
        const logs = await read('eth_getLogs', [request], validate);
        assertActive();
        if (!validate(logs)) throw fail();
        return logs;
      }
      const final = await finalized(request.toBlock);
      assertActive();
      const eligible = final !== null && BigInt(final.number) >= BigInt(request.toBlock);
      const prior = pages.find((page) => page.key === key);
      const fresh = prior && Date.now() >= prior.savedAt && Date.now() - prior.savedAt < MAX_AGE_MS;
      const before = eligible ? await canonical(request.toBlock) : null;
      if (
        !bypass &&
        fresh &&
        eligible &&
        before === prior.blockHash.toLowerCase() &&
        validate(prior.logs) &&
        consistent(prior.logs, request.toBlock, before)
      ) {
        assertActive();
        return structuredClone(prior.logs);
      }
      if (prior) await update((current) => current.filter((page) => page.key !== key));
      const logs = await read('eth_getLogs', [request], validate);
      assertActive();
      if (!validate(logs)) throw fail();
      if (eligible && before !== null) {
        const after = await canonical(request.toBlock);
        if (after === null) return logs;
        if (before !== after || !consistent(logs, request.toBlock, after)) throw fail();
        const page = { key, blockHash: after, savedAt: Date.now(), logs: structuredClone(logs) };
        if (Buffer.byteLength(JSON.stringify({ version: 1, pages: [page] })) <= MAX_BYTES)
          await update((current) => [...current.filter((p) => p.key !== key), page]);
      }
      assertActive();
      return logs;
    },
  });
}
module.exports = { createKohakuScanCache, MAX_BYTES, MAX_PAGES, MAX_AGE_MS };
