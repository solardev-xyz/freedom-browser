/** Main-owned exclusive public scan scheduling. The engine can access storage
 * only inside an acknowledged apply window, after a durable journal prepare,
 * or an exclusive read-only window over a completed public checkpoint.
 * Readiness here means a source-matched unverified public state, never spend/POI.
 */
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunScanJournal, sameRangeContent } = require('./railgun-scan-journal');
const owners = new WeakSet();
const snapshotReads = new Set(['get', 'getMany', 'open', 'next', 'nextMany', 'seek', 'end']);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const fail = () =>
  Object.assign(new Error('Railgun scan coordinator unavailable'), {
    code: 'RAILGUN_SCAN_COORDINATOR_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
async function createRailgunScanCoordinator({
  handle,
  storeSession,
  source,
  journalStorage,
  applyRange,
}) {
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.role === 'engine' &&
      subject.operation === null &&
      typeof applyRange === 'function'
  );
  check(
    typeof storeSession?.claimDispatch === 'function' &&
      typeof storeSession.inspectPublicState === 'function' &&
      typeof source?.acquire === 'function' &&
      typeof source.refresh === 'function' &&
      typeof source.assertSource === 'function' &&
      source.signal instanceof AbortSignal
  );
  check(!owners.has(storeSession));
  owners.add(storeSession);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([context.signal, storeSession.signal, source.signal]),
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const storageSubject = { ...subject, role: 'storage', operation: 'railgun-scan-v1' };
  let dispatchGrant;
  const snapshots = new WeakMap();
  let journal,
    closed = false,
    busy = false,
    ready = null,
    wireId = 0;
  function active() {
    check(!closed);
    getPrivacyContext(handle);
    check(!scope.signal.aborted);
  }
  function close() {
    if (closed) return;
    closed = true;
    ready = null;
    owners.delete(storeSession);
    journal?.close();
    scope.close();
    source.close();
    storeSession.close();
  }
  scope.signal.addEventListener('abort', close, { once: true });
  try {
    dispatchGrant = storeSession.claimDispatch();
    journal = await createRailgunScanJournal({
      ...journalStorage,
      handle: scope.getContext(storageSubject),
      storeSession,
      ledgerId: source.ledgerId,
      assertSource: source.assertSource,
    });
  } catch (error) {
    close();
    throw error;
  }
  async function exclusive(run) {
    active();
    check(!busy);
    busy = true;
    try {
      return await run();
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
    }
  }
  const query = (plan) => ({
    from: plan.from,
    to: plan.to.number,
    previousHash: plan.previousHash,
    anchor: plan.anchor,
    storeId: plan.state.storeId,
  });
  async function matched(plan) {
    const result = await source.acquire(query(plan));
    check(sameRangeContent(result.plan, plan));
    return result;
  }
  async function apply(result) {
    ready = null;
    const token = await journal.prepare(result.plan, result.evidence);
    active();
    let accepting = true,
      localId = 0,
      failed = false;
    const pending = new Set();
    const dispatch = (wire) => {
      let promise;
      try {
        active();
        check(accepting && typeof wire === 'string' && Buffer.byteLength(wire) <= 2 * 1024 * 1024);
        const message = JSON.parse(wire);
        check(
          message &&
            message.id === localId + 1 &&
            message.method !== 'rpc' &&
            message.method !== 'clear'
        );
        if (['batch', 'txStage'].includes(message.method))
          check(
            Array.isArray(message.args?.operations) &&
              message.args.operations.every((op) => op.type === 'put')
          );
        localId++;
        const globalId = ++wireId;
        promise = dispatchGrant
          .dispatch(JSON.stringify({ ...message, id: globalId }))
          .then((reply) => {
            const value = JSON.parse(reply);
            check(value.id === globalId); // Return the child's own sequence, not the store-global one.
            return JSON.stringify({ ...value, id: message.id });
          });
      } catch (error) {
        close();
        return Promise.reject(error);
      }
      pending.add(promise);
      promise.then(
        () => pending.delete(promise),
        () => {
          failed = true;
          pending.delete(promise);
        }
      );
      return promise;
    };
    let abort, timer;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(fail());
      scope.signal.addEventListener('abort', abort, { once: true });
      if (scope.signal.aborted) abort();
      timer = setTimeout(() => {
        close();
        reject(fail());
      }, 180000);
    });
    try {
      await Promise.race([
        Promise.resolve().then(() =>
          applyRange({ plan: result.plan, logs: result.logs }, { dispatch, signal: scope.signal })
        ),
        cancelled,
      ]);
    } catch (error) {
      close();
      throw error;
    } finally {
      clearTimeout(timer);
      scope.signal.removeEventListener('abort', abort);
      accepting = false;
      await Promise.allSettled([...pending]);
    }
    active();
    check(!failed);
    // Rechecking headers is cheap and refreshes a long-running apply without
    // downloading logs or recomputing its expected state.
    const evidence = await source.refresh(result.plan, result.evidence);
    const state = await storeSession.inspectPublicState();
    await journal.complete(token, { source: evidence, state });
    ready = { plan: result.plan, evidence, state };
    return diagnostic();
  }
  function diagnostic() {
    active();
    check(ready);
    storeSession.assertFresh(ready.state);
    if (ready.plan) source.assertSource(ready.plan, ready.evidence);
    return Object.freeze({
      status: ready.plan ? 'applied-unverified' : 'unscanned',
      to: ready.plan?.to ?? null,
    });
  }
  async function recover() {
    ready = null;
    const value = await journal.readState();
    await journal.withSourceRetention((token) => source.retain(token));
    if (value.pending) return apply(await matched(value.pending));
    const result = value.checkpoint ? await matched(value.checkpoint) : null;
    const state = await storeSession.inspectPublicState();
    await journal.revalidate({ source: result?.evidence, state, plan: result?.plan });
    ready = { plan: result?.plan ?? null, evidence: result?.evidence, state };
    return diagnostic();
  }
  async function advance({ to, anchor }) {
    return exclusive(async () => {
      // A new instance must recover before progressing; recovered readiness is
      // rechecked synchronously and never survives another engine dispatch.
      if (!ready) await recover();
      if (ready.plan) {
        storeSession.assertFresh(ready.state);
        ready.evidence = await source.refresh(ready.plan, ready.evidence);
        await journal.revalidate({ source: ready.evidence, state: ready.state });
      }
      diagnostic();
      const previous = ready.plan;
      const result = await source.acquire({
        from: previous ? previous.to.number + 1 : 0,
        to,
        previousHash: previous ? previous.to.hash : '0x' + '0'.repeat(64),
        anchor,
        storeId: ready.state.storeId,
      });
      return apply(result);
    });
  }
  async function withPublicSnapshot(run) {
    return exclusive(async () => {
      check(typeof run === 'function');
      if (!ready) await recover();
      check(ready.plan); // An empty, never-scanned store is not wallet coverage.
      const plan = ready.plan;
      storeSession.assertFresh(ready.state);
      const evidence = await source.refresh(plan, ready.evidence);
      await journal.revalidate({ source: evidence, state: ready.state });
      const checkpoint = freeze(structuredClone(plan));
      ready = null; // Invalidate previous snapshot evidence before the first read.
      const window = new AbortController(),
        signal = AbortSignal.any([scope.signal, window.signal]),
        pending = new Set();
      let accepting = true,
        localId = 0,
        failed = false,
        timer,
        abort;
      const dispatch = (wire) => {
        let promise;
        try {
          active();
          check(accepting && !signal.aborted && typeof wire === 'string');
          check(Buffer.byteLength(wire) <= 2 * 1024 * 1024);
          const message = JSON.parse(wire);
          check(message && message.id === localId + 1 && snapshotReads.has(message.method));
          localId++;
          const globalId = ++wireId;
          promise = dispatchGrant
            .dispatch(JSON.stringify({ ...message, id: globalId }))
            .then((reply) => {
              const value = JSON.parse(reply);
              check(value.id === globalId);
              return JSON.stringify({ ...value, id: message.id });
            });
        } catch (error) {
          close();
          return Promise.reject(error);
        }
        pending.add(promise);
        promise.then(
          () => pending.delete(promise),
          () => {
            failed = true;
            pending.delete(promise);
          }
        );
        return promise;
      };
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(fail());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        timer = setTimeout(() => {
          close();
          reject(fail());
        }, 180000);
      });
      let value;
      try {
        // The trusted runner must observe its utility process exit before it
        // resolves. Returning also revokes its broker; leaked cursors prevent
        // the whole-store observation below from completing.
        value = await Promise.race([
          Promise.resolve().then(() => run({ checkpoint, dispatch, signal })),
          cancelled,
        ]);
        accepting = false;
        await Promise.race([Promise.allSettled([...pending]), cancelled]);
        check(!failed);
      } finally {
        accepting = false;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        window.abort();
      }
      active();
      const refreshed = await source.refresh(plan, evidence),
        state = await storeSession.inspectPublicState();
      await journal.revalidate({ source: refreshed, state });
      ready = { plan, evidence: refreshed, state };
      const token = Object.freeze({});
      snapshots.set(token, { ready, checkpoint });
      return Object.freeze({ value, evidence: token });
    });
  }
  function assertSnapshot(token) {
    active();
    const snapshot = snapshots.get(token);
    check(!busy && snapshot && snapshot.ready === ready);
    diagnostic();
    // Public source consistency only; never a wallet, chain-trust or POI grant.
    return snapshot.checkpoint;
  }
  return Object.freeze({
    advance,
    withPublicSnapshot,
    assertSnapshot,
    recover: () => exclusive(recover),
    inspect: diagnostic,
    close,
    signal: scope.signal,
  });
}
module.exports = { createRailgunScanCoordinator };
