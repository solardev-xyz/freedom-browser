/** Main-owned public Sepolia acquisition. RPC observations remain unverified.
 * The host supplies a separate guarded source planner; no engine imports here.
 * Evidence is identity-bound, short-lived and never issued from engine cursors.
 */
const { createHash } = require('crypto');
const { getPrivacyContext } = require('../networks/privacy-context');
const { createPrivateRpc } = require('../networks/private-rpc');
const { plan: normalizePlan } = require('./railgun-scan-journal');
const PROXY = '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea';
const MAX_AGE_MS = 60000;
const MAX_RANGE_MS = 180000;
const MAX_BLOCKS = 100000;
const HEADER_CONCURRENCY = 8;
const fail = () =>
  Object.assign(new Error('Railgun scan source unavailable'), {
    code: 'RAILGUN_SCAN_SOURCE_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const tag = (n) => '0x' + n.toString(16);
function quantity(value) {
  check(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value));
  const result = Number(BigInt(value));
  check(integer(result));
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function header(value, number) {
  check(value && hash(value.hash) && hash(value.parentHash));
  const result = { number: quantity(value.number), hash: value.hash, parentHash: value.parentHash };
  if (number !== undefined) check(result.number === number);
  return result;
}
function normalizeLogs(values, from, to) {
  check(Array.isArray(values) && values.length <= 4096);
  check(Buffer.byteLength(JSON.stringify(values)) <= 4 * 1024 * 1024);
  const result = values
    .map((value) => {
      check(value?.address?.toLowerCase() === PROXY && value.removed === false);
      const blockNumber = quantity(value.blockNumber),
        transactionIndex = quantity(value.transactionIndex),
        logIndex = quantity(value.logIndex);
      check(
        blockNumber >= from &&
          blockNumber <= to &&
          hash(value.blockHash) &&
          hash(value.transactionHash)
      );
      check(
        Array.isArray(value.topics) &&
          value.topics.length >= 1 &&
          value.topics.length <= 4 &&
          value.topics.every(hash)
      );
      check(
        typeof value.data === 'string' &&
          value.data.length <= 2 * 1024 * 1024 &&
          value.data.startsWith('0x') &&
          value.data.length % 2 === 0 &&
          !/[^0-9a-f]/.test(value.data.slice(2))
      );
      return {
        address: PROXY,
        blockNumber,
        blockHash: value.blockHash,
        transactionIndex,
        transactionHash: value.transactionHash,
        logIndex,
        topics: [...value.topics],
        data: value.data,
      };
    })
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const blocks = new Map();
  let previous;
  for (const log of result) {
    if (previous && previous.blockNumber === log.blockNumber) {
      check(log.logIndex > previous.logIndex && log.transactionIndex >= previous.transactionIndex);
      if (log.transactionIndex === previous.transactionIndex)
        check(log.transactionHash === previous.transactionHash);
    }
    check(!blocks.has(log.blockNumber) || blocks.get(log.blockNumber) === log.blockHash);
    blocks.set(log.blockNumber, log.blockHash);
    previous = log;
  }
  check(blocks.size <= 512);
  return { logs: freeze(result), blocks };
}
function createRailgunScanSource({ handle, ledger, projectRange, beforeAcquire }) {
  check(beforeAcquire === undefined || typeof beforeAcquire === 'function');
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.role === 'protocol-rpc' &&
      subject.operation === null
  );
  check(
    typeof projectRange === 'function' &&
      typeof ledger?.stage === 'function' &&
      typeof ledger?.visit === 'function' &&
      ledger.signal instanceof AbortSignal
  );
  const ledgerId = ledger.identity();
  check(typeof ledgerId === 'string' && /^[0-9a-f]{64}$/.test(ledgerId));
  const controller = new AbortController();
  const rpc = createPrivateRpc(handle, 'protocol-rpc', { signal: controller.signal });
  check(
    Array.isArray(rpc.trust?.queried) &&
      rpc.trust.queried.length >= 1 &&
      rpc.trust.queried.length <= 8 &&
      rpc.trust.queried.every((v) => typeof v === 'string' && v.length <= 256)
  );
  const providersSha256 = createHash('sha256')
    .update(JSON.stringify([...new Set(rpc.trust.queried)].sort()))
    .digest('hex');
  const observations = new WeakMap(),
    issued = [];
  let closed = false,
    busy = false;
  function active() {
    check(!closed && !ledger.signal.aborted);
    getPrivacyContext(handle);
    rpc.assertActive();
  }
  function close() {
    if (closed) return;
    closed = true;
    controller.abort();
    for (const evidence of issued) observations.delete(evidence);
    issued.length = 0;
    context.signal.removeEventListener('abort', close);
    ledger.signal.removeEventListener('abort', close);
    rpc.release();
    ledger.close?.();
  }
  context.signal.addEventListener('abort', close, { once: true });
  ledger.signal.addEventListener('abort', close, { once: true });
  function requests(range) {
    const started = performance.now();
    const read = async (method, params) => {
      active();
      check(performance.now() - started < MAX_RANGE_MS);
      const result = (await rpc.request(method, params, () => true)).result;
      active();
      check(performance.now() - started < MAX_RANGE_MS);
      return result;
    };
    const readHeader = async (number) =>
      header(await read('eth_getBlockByNumber', [tag(number), false]), number);
    // Abort siblings on the first failure, then observe every result before
    // releasing this acquisition. No detached request can outlive its owner.
    async function together(jobs) {
      check(jobs.length <= HEADER_CONCURRENCY);
      const results = await Promise.allSettled(
        jobs.map(async (job) => {
          try {
            return await job();
          } catch (error) {
            close();
            throw error;
          }
        })
      );
      active();
      check(results.every((result) => result.status === 'fulfilled'));
      return results.map((result) => result.value);
    }
    async function eventHeaders(blocks) {
      const entries = [...blocks];
      for (let start = 0; start < entries.length; start += HEADER_CONCURRENCY) {
        await together(
          entries.slice(start, start + HEADER_CONCURRENCY).map(
            ([number, hash]) =>
              async () =>
                check((await readHeader(number)).hash === hash)
          )
        );
      }
    }
    async function canonical() {
      const numbers = [
        ...new Set([
          range.anchor.number,
          range.from,
          range.to,
          ...(range.from ? [range.from - 1] : []),
        ]),
      ];
      const [finalized, ...headers] = await together([
        async () => header(await read('eth_getBlockByNumber', ['finalized', false])),
        ...numbers.map((number) => () => readHeader(number)),
      ]);
      const byNumber = new Map(headers.map((value) => [value.number, value]));
      check(finalized.number >= range.anchor.number);
      const anchor = byNumber.get(range.anchor.number);
      check(anchor.hash === range.anchor.hash);
      if (finalized.number === anchor.number) check(finalized.hash === anchor.hash);
      const from = byNumber.get(range.from),
        to = byNumber.get(range.to);
      check(from.parentHash === range.previousHash);
      if (range.from) check(byNumber.get(range.from - 1).hash === range.previousHash);
      if (range.to === range.anchor.number) check(to.hash === anchor.hash);
      return { from, to, anchor };
    }
    return { read, eventHeaders, canonical };
  }
  function issue(plan, boundaries, canonicalAt) {
    const evidence = Object.freeze({});
    observations.set(evidence, { plan: JSON.stringify(plan), boundaries, canonicalAt });
    issued.push(evidence);
    if (issued.length > 16) observations.delete(issued.shift());
    return evidence;
  }
  async function refresh(input, evidence) {
    active();
    check(!busy);
    const plan = normalizePlan(input),
      previous = observations.get(evidence);
    check(previous && previous.plan === JSON.stringify(plan));
    busy = true;
    try {
      const { canonical } = requests({ ...plan, to: plan.to.number });
      const canonicalAt = performance.now(),
        boundaries = await canonical();
      check(
        JSON.stringify(boundaries) === JSON.stringify(previous.boundaries) &&
          performance.now() - canonicalAt < MAX_AGE_MS
      );
      return issue(plan, boundaries, canonicalAt);
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
    }
  }
  async function acquire(input) {
    active();
    check(!busy);
    // Snapshot host input before awaiting any network or planner operation.
    const range = JSON.parse(JSON.stringify(input));
    check(
      range &&
        Object.keys(range).length === 5 &&
        ['from', 'to', 'previousHash', 'anchor', 'storeId'].every((k) => Object.hasOwn(range, k))
    );
    check(
      integer(range.from) &&
        integer(range.to) &&
        range.from <= range.to &&
        range.to - range.from < MAX_BLOCKS
    );
    check(
      hash(range.previousHash) &&
        typeof range.storeId === 'string' &&
        /^[0-9a-f]{64}$/.test(range.storeId)
    );
    check(
      range.anchor &&
        Object.keys(range.anchor).length === 2 &&
        integer(range.anchor.number) &&
        hash(range.anchor.hash) &&
        range.to <= range.anchor.number
    );
    if (range.from === 0) check(range.previousHash === '0x' + '0'.repeat(64));
    freeze(range);
    busy = true;
    const { read, eventHeaders, canonical } = requests(range);
    const deadline = setTimeout(close, MAX_RANGE_MS);
    try {
      const before = await canonical();
      if (beforeAcquire) {
        await beforeAcquire(range);
        active();
      }
      const { logs, blocks } = normalizeLogs(
        await read('eth_getLogs', [
          { address: PROXY, fromBlock: tag(range.from), toBlock: tag(range.to) },
        ]),
        range.from,
        range.to
      );
      await eventHeaders(blocks);
      const digest = createHash('sha256');
      for (const log of logs) digest.update(JSON.stringify(log) + '\n');
      const logDigest = { count: logs.length, sha256: digest.digest('hex') };
      const reference = await ledger.stage(
        {
          from: range.from,
          to: { number: range.to, hash: before.to.hash },
          previousHash: range.previousHash,
          providersSha256,
          logs: logDigest,
        },
        logs
      );
      // The planner streams only independently acquired logs, including earlier
      // cached ranges, from the separate main-owned ledger. Never engine state.
      let visited = false;
      const planning = Promise.resolve().then(() =>
        projectRange(freeze({ range }), {
          signal: rpc.signal,
          visit: async (visitor) => {
            const result = await ledger.visit(reference, visitor);
            visited = true;
            return result;
          },
        })
      );
      let aborted;
      const cancelled = new Promise((_, reject) => {
        aborted = () => reject(fail());
        rpc.signal.addEventListener('abort', aborted, { once: true });
        if (rpc.signal.aborted) aborted();
      });
      let projected;
      try {
        projected = await Promise.race([planning, cancelled]);
      } finally {
        rpc.signal.removeEventListener('abort', aborted);
      }

      active();
      check(visited);
      const plan = normalizePlan({
        from: range.from,
        previousHash: range.previousHash,
        to: { number: range.to, hash: before.to.hash },
        anchor: range.anchor,
        logs: logDigest,
        source: { level: 'unverified-rpc', providersSha256, ...reference },
        state: projected,
      });
      check(plan.state.storeId === range.storeId);
      const canonicalAt = performance.now();
      const after = await canonical();
      check(
        JSON.stringify(before) === JSON.stringify(after) &&
          performance.now() - canonicalAt < MAX_AGE_MS
      );
      const evidence = issue(plan, before, canonicalAt);
      return freeze({ plan, evidence, logs });
    } catch {
      close();
      throw fail();
    } finally {
      clearTimeout(deadline);
      busy = false;
    }
  }
  function assertSource(plan, evidence) {
    active();
    const observation = observations.get(evidence),
      now = performance.now();
    check(
      observation &&
        now >= observation.canonicalAt &&
        now - observation.canonicalAt < MAX_AGE_MS &&
        JSON.stringify(normalizePlan(plan)) === observation.plan
    );
  }
  return Object.freeze({
    acquire,
    refresh,
    assertSource,
    close,
    signal: rpc.signal,
    ledgerId,
    retain: (token) => ledger.retain(token),
  });
}
module.exports = { createRailgunScanSource, normalizeLogs, MAX_AGE_MS, PROXY };
