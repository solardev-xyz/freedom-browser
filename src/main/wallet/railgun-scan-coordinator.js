/** Main-owned exclusive public scan scheduling. The engine can access storage
 * only inside an acknowledged apply window, after a durable journal prepare.
 * Readiness here means a source-matched unverified public state, never spend/POI.
 */
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunScanJournal, sameRangeContent } = require('./railgun-scan-journal');
const owners = new WeakSet();
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
  return Object.freeze({
    advance,
    recover: () => exclusive(recover),
    inspect: diagnostic,
    close,
    signal: scope.signal,
  });
}
module.exports = { createRailgunScanCoordinator };
