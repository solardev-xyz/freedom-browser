/** Main-owned wallet coverage pages and an exclusive engine write phase. The
 * engine receives only its wallet namespace through railgun-wallet-storage;
 * coverage pages are written by main after that utility process has exited.
 */
const {
  kinds,
  checkpointHash,
  normalizeRailgunWalletCoverage,
  summarizeRailgunWalletCoverage,
  assertRailgunWalletCoverageExtends,
  assertRailgunWalletCheckpointFollows,
} = require('./railgun-wallet-coverage');
const { getRailgunWalletPrefixes } = require('./railgun-wallet-storage');
const { plan: normalizePlan } = require('./railgun-scan-journal');
const PREFIX = 'freedom:railgun:wallet-coverage:v1:';
const META = PREFIX + 'manifest';
const reads = new Set(['get', 'getMany', 'open', 'next', 'nextMany', 'seek', 'end']);
const pageKey = (kind, index) => PREFIX + kind + ':' + index.toString().padStart(4, '0');
const encode = (value) => Buffer.from(value).toString('base64');
const fail = () =>
  Object.assign(new Error('Railgun wallet coverage store unavailable'), {
    code: 'RAILGUN_WALLET_COVERAGE_STORE_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
function createRailgunWalletCoverageStore({ session, walletId, policy, assertScan }) {
  check(/^[0-9a-f]{64}$/.test(walletId) && /^[0-9a-f]{64}$/.test(policy));
  const prefixes = getRailgunWalletPrefixes(walletId),
    cursors = new Map();
  const decode = (value) => {
    check(typeof value === 'string' && value.length <= 5500);
    const bytes = Buffer.from(value, 'base64'),
      text = bytes.toString();
    check(bytes.toString('base64') === value && Buffer.from(text).equals(bytes));
    return text;
  };
  const contains = (prefix, key) => key === prefix || key.startsWith(prefix + ':');
  const allowed = (key) => prefixes.some((prefix) => contains(prefix, decode(key)));
  function engineRequest(message) {
    check(message && Object.keys(message).sort().join(',') === 'args,id,method');
    check(
      ['get', 'getMany', 'open', 'next', 'nextMany', 'seek', 'end', 'batch'].includes(
        message.method
      )
    );
    const { method, args } = message;
    check(args && typeof args === 'object' && !Array.isArray(args));
    if (method === 'get') check(allowed(args.key));
    if (method === 'getMany') check(Array.isArray(args.keys) && args.keys.every(allowed));
    if (method === 'batch')
      check(
        Array.isArray(args.operations) &&
          args.operations.every((op) => op.type === 'put' && allowed(op.key))
      );
    if (method === 'open') {
      const options = args.options;
      check(
        options &&
          !(options.gte !== undefined && options.gt !== undefined) &&
          !(options.lte !== undefined && options.lt !== undefined)
      );
      const lower = decode(options.gte ?? options.gt),
        upper = decode(options.lte ?? options.lt);
      const prefix = prefixes.find((p) => lower >= p && upper <= p + '~' && lower <= upper);
      check(prefix);
      return prefix;
    }
    if (['next', 'nextMany', 'seek', 'end'].includes(method)) {
      check(cursors.has(args.cursor));
      if (method === 'seek') check(contains(cursors.get(args.cursor), decode(args.target)));
    }
  }
  const observations = new WeakMap(),
    finishedReceipts = new WeakSet();
  let observationEpoch = 0;
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  let engineReceipt = null,
    engineReceiptKind = null,
    hostReceipt = null,
    receiptConsumed = false;
  const observation = (checkpoint, coverage, summary, receipt = hostReceipt) => {
    const result = freeze({ checkpoint, coverage, summary });
    if (receipt) assertScan(receipt, { session, walletId, policy, checkpoint, summary });
    observations.set(result, { id, receipt, epoch: observationEpoch });
    return result;
  };
  const grant = session.claimDispatch(),
    controller = new AbortController();
  const signal = AbortSignal.any([session.signal, controller.signal]);
  let id = 0,
    engineId = 0,
    pending = 0,
    busy = false,
    phase = 'host',
    engineStarted = false,
    currentGrant = null;
  function revokeGrant() {
    const current = currentGrant;
    currentGrant = null;
    current?.windowSignal?.removeEventListener('abort', close);
    current?.controller.abort();
  }
  function close() {
    revokeGrant();
    controller.abort();
    session.close();
  }
  const active = () => check(!signal.aborted);
  async function call(method, args) {
    active();
    const nextId = ++id;
    const wire = JSON.stringify({ id: nextId, method, args });
    check(Buffer.byteLength(wire) <= 2 * 1024 * 1024);
    const result = JSON.parse(await grant.dispatch(wire));
    active();
    check(result.id === nextId && Object.hasOwn(result, 'value'));
    return result.value;
  }
  async function host(run, receipt, writing = false) {
    active();
    check(phase === 'host' && !busy && pending === 0);
    busy = true;
    try {
      if (receipt) {
        check(receipt === engineReceipt && !receiptConsumed);
        check(!writing || engineReceiptKind === 'engine');
        assertScan(receipt, { session, walletId, policy });
      }
      // Once a read-only restoration starts, omitting its receipt cannot turn
      // the host coverage API into a writable path either.
      check(!writing || engineReceiptKind !== 'restore');
      receiptConsumed = true;
      hostReceipt = receipt ?? null;
      return await run();
    } catch {
      close();
      throw fail();
    } finally {
      hostReceipt = null;
      busy = false;
    }
  }
  async function get(key) {
    const value = await call('get', { key: encode(key) });
    if (value === null) return null;
    check(typeof value === 'string' && value.length <= 1400000);
    const bytes = Buffer.from(value, 'base64');
    try {
      check(bytes.toString('base64') === value);
      return JSON.parse(bytes.toString());
    } finally {
      bytes.fill(0);
    }
  }
  async function read(register = true) {
    const manifest = await get(META);
    if (manifest === null) {
      const cursor = await call('open', {
        options: { gte: encode(PREFIX), lt: encode(PREFIX + '~') },
      });
      try {
        check((await call('next', { cursor })) === null);
      } finally {
        await call('end', { cursor });
      }
      return null;
    }
    check(
      manifest &&
        manifest.version === 1 &&
        manifest.walletId === walletId &&
        manifest.policy === policy
    );
    const plan = normalizePlan(manifest.checkpoint);
    check(manifest.checkpointHash === checkpointHash(plan));
    const input = { scannedLeaves: plan.state.commitments.count };
    let expectedKeys = 1;
    for (const kind of kinds) {
      const count = manifest.summary?.[kind]?.count;
      check(Number.isSafeInteger(count) && count >= 0 && count <= 10000);
      input[kind] = [];
      for (let page = 0; page < Math.ceil(count / 128); page++) {
        const rows = await get(pageKey(kind, page));
        check(Array.isArray(rows) && rows.length === Math.min(128, count - page * 128));
        input[kind].push(...rows);
        expectedKeys++;
      }
    }
    const coverage = normalizeRailgunWalletCoverage(plan, input),
      summary = summarizeRailgunWalletCoverage(coverage);
    check(JSON.stringify(summary) === JSON.stringify(manifest.summary));
    // Reject orphan/unknown host rows too, not only the pages the manifest names.
    const cursor = await call('open', {
      options: { gte: encode(PREFIX), lt: encode(PREFIX + '~'), values: false },
    });
    let seen = 0;
    try {
      while ((await call('next', { cursor })) !== null) {
        seen++;
        check(seen <= expectedKeys);
      }
    } finally {
      await call('end', { cursor });
    }
    check(seen === expectedKeys);
    return observation(plan, coverage, summary, register ? hostReceipt : null);
  }
  async function write(checkpoint, input) {
    const plan = normalizePlan(checkpoint),
      coverage = normalizeRailgunWalletCoverage(plan, input),
      summary = summarizeRailgunWalletCoverage(coverage);
    const previous = await read(false);
    if (previous) {
      assertRailgunWalletCheckpointFollows(previous.checkpoint, plan);
      assertRailgunWalletCoverageExtends(previous.coverage, coverage);
      if (plan.to.number === previous.checkpoint.to.number) {
        check(checkpointHash(plan) === checkpointHash(previous.checkpoint));
        check(JSON.stringify(summary) === JSON.stringify(previous.summary));
        // Keep provider-only provenance changes out of the derived digest.
        return observation(previous.checkpoint, previous.coverage, previous.summary);
      }
    }
    const operations = [];
    const put = (key, value) =>
      operations.push({ type: 'put', key: encode(key), value: encode(JSON.stringify(value)) });
    for (const kind of kinds) {
      const rows = coverage[kind],
        pages = Math.ceil(rows.length / 128);
      for (let page = 0; page < pages; page++)
        put(pageKey(kind, page), rows.slice(page * 128, (page + 1) * 128));
      for (let page = pages; page < Math.ceil((previous?.coverage[kind].length ?? 0) / 128); page++)
        operations.push({ type: 'del', key: encode(pageKey(kind, page)) });
    }
    put(META, {
      version: 1,
      walletId,
      policy,
      checkpoint: plan,
      checkpointHash: checkpointHash(plan),
      summary,
    });
    check(Buffer.byteLength(JSON.stringify(operations)) <= 8 * 1024 * 1024);
    const transaction = await call('txBegin', {});
    for (let start = 0; start < operations.length; start += 32)
      await call('txStage', { transaction, operations: operations.slice(start, start + 32) });
    await call('txCommit', { transaction });
    return observation(plan, coverage, summary);
  }
  function begin(mode, windowSignal) {
    active();
    check(!busy && pending === 0 && cursors.size === 0 && !currentGrant && phase === 'host');
    if (mode === 'engine') {
      check(!engineStarted);
      engineStarted = true;
    } else {
      check(mode === 'restore' && engineStarted && engineReceipt && receiptConsumed);
      check(windowSignal instanceof AbortSignal && !windowSignal.aborted);
      assertScan(engineReceipt, { session, walletId, policy });
    }
    phase = mode;
    observationEpoch++;
    engineId = 0;
    const token = { controller: new AbortController(), windowSignal };
    currentGrant = token;
    windowSignal?.addEventListener('abort', close, { once: true });
    let writeAttempts = 0;
    return Object.freeze({
      signal: AbortSignal.any([signal, token.controller.signal]),
      getStatus: () => Object.freeze({ readOnly: mode === 'restore', writeAttempts }),
      async dispatch(wire) {
        try {
          active();
          check(
            phase === mode &&
              currentGrant === token &&
              typeof wire === 'string' &&
              Buffer.byteLength(wire) <= 2 * 1024 * 1024 &&
              pending < 8
          );
          const message = JSON.parse(wire);
          check(message.id === engineId + 1);
          if (mode === 'restore' && !reads.has(message.method)) {
            writeAttempts++;
            throw fail();
          }
          const prefix = engineRequest(message);
          engineId++;
          pending++;
          try {
            const value = await call(message.method, message.args);
            if (message.method === 'open') {
              check(Number.isSafeInteger(value) && value > 0 && !cursors.has(value));
              cursors.set(value, prefix);
            }
            if (message.method === 'end') cursors.delete(message.args.cursor);
            return JSON.stringify({ id: message.id, value });
          } finally {
            pending--;
          }
        } catch {
          close();
          throw fail();
        }
      },
    });
  }
  function finish(receipt, mode) {
    // Revoke before checking completion, including on a cursor/receipt failure.
    const current = currentGrant;
    revokeGrant();
    try {
      active();
      check(current && phase === mode && pending === 0 && cursors.size === 0);
      if (mode === 'restore') check(receipt);
      if (receipt) {
        check(typeof assertScan === 'function');
        check(typeof receipt === 'object' && !finishedReceipts.has(receipt));
        assertScan(receipt, {
          session,
          walletId,
          policy,
          ...(mode === 'restore' ? { mode: 'restore' } : {}),
        });
        finishedReceipts.add(receipt);
      }
      engineReceipt = receipt ?? null;
      engineReceiptKind = mode;
      receiptConsumed = false;
      phase = 'host';
    } catch {
      close();
      throw fail();
    }
  }
  return Object.freeze({
    session,
    signal,
    close,
    beginEngine: () => begin('engine'),
    beginRestore: (windowSignal) => begin('restore', windowSignal),
    assertCoverage(value, receipt) {
      active();
      check(
        !busy &&
          pending === 0 &&
          phase === 'host' &&
          observations.has(value) &&
          observations.get(value).epoch === observationEpoch &&
          observations.get(value).id === id &&
          receipt &&
          observations.get(value).receipt === receipt
      );
      assertScan(receipt, {
        session,
        walletId,
        policy,
        checkpoint: value.checkpoint,
        summary: value.summary,
      });
    },
    finishEngine: (receipt) => finish(receipt, 'engine'),
    finishRestore: (receipt) => finish(receipt, 'restore'),
    read: (receipt) => host(read, receipt),
    write: (checkpoint, input, receipt) => host(() => write(checkpoint, input), receipt, true),
  });
}
module.exports = { createRailgunWalletCoverageStore };
