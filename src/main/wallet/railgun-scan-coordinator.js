/** Main-owned exclusive public scan scheduling. The engine can access storage
 * only inside an acknowledged apply window, after a durable journal prepare,
 * or an exclusive read-only window over a completed public checkpoint.
 * Readiness here means a source-matched unverified public state, never spend/POI.
 */
const { isProxy } = require('util').types;
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunScanJournal, sameRangeContent, scanState } = require('./railgun-scan-journal');
const owners = new WeakSet();
const instances = new WeakMap();
const completedOutcomes = new WeakMap();
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
        sourceVisited = false,
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
      const visitSource = (visitor) => {
        let promise;
        try {
          active();
          check(accepting && !signal.aborted && !sourceVisited && typeof visitor === 'function');
          sourceVisited = true;
          promise = source.visitSnapshot(plan, evidence, async (log) => {
            check(accepting && !signal.aborted);
            await visitor(log);
            check(accepting && !signal.aborted);
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
      let value;
      try {
        // The trusted runner must observe its utility process exit before it
        // resolves. Returning also revokes its broker; leaked cursors prevent
        // the whole-store observation below from completing.
        value = await Promise.race([
          Promise.resolve().then(() => run({ checkpoint, dispatch, visitSource, signal })),
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
        await Promise.allSettled([...pending]);
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
  async function withCompletedPublicSnapshot(options, run) {
    const outcome = { fatal: true, reason: 'fatal', rpcFailure: null };
    try {
      active();
      outcome.fatal = false;
      outcome.reason = 'busy';
      check(!busy);
      outcome.reason = 'invalid-arguments';
      check(options && !isProxy(options) && Object.getPrototypeOf(options) === Object.prototype);
      const keys = Reflect.ownKeys(options);
      check(
        keys.every((key) => ['destination', 'signal', 'timeoutMs'].includes(key)) &&
          ['destination', 'signal'].every((key) => keys.includes(key)) &&
          keys.every((key) => Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))
      );
      const { destination, signal, timeoutMs = 180000 } = options;
      check(!isProxy(signal) && signal instanceof AbortSignal && typeof run === 'function');
      check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000);
      outcome.reason = 'cancelled';
      check(!signal.aborted);
      outcome.reason = 'admission-refused';
      check(
        typeof source.openCompletedCheckpointRead === 'function' &&
          typeof source.matchesCompletedDestination === 'function'
      );
      const started = performance.now(),
        deadline = started + timeoutMs;
      check(Number.isFinite(started) && Number.isFinite(deadline));
      // Reserve before the journal's first await; old snapshots never survive an
      // admitted completed-only attempt, including a benign missing checkpoint.
      busy = true;
      ready = null;
      const controller = new AbortController(),
        window = new AbortController();
      const refusal = fail(),
        pending = new Set();
      let operation,
        sourceAborted,
        reason = null,
        fatal = false,
        accepting = false,
        lastNow = started,
        localId = 0,
        sourceVisited = false,
        sourceRefused = false,
        candidate,
        result,
        cleanupFailed = false,
        timer,
        sourceOutcome;
      function revoke(value, failed = false) {
        if (failed) {
          fatal = true;
          reason = 'fatal';
        } else if (!reason) reason = value;
        accepting = false;
        window.abort();
        controller.abort();
      }
      const onCancel = () => revoke('cancelled');
      const onOwner = () => revoke('fatal', true);
      signal.addEventListener('abort', onCancel, { once: true });
      scope.signal.addEventListener('abort', onOwner, { once: true });
      timer = setTimeout(() => revoke('expired'), timeoutMs);
      timer.unref?.();
      function current() {
        try {
          active();
        } catch {
          revoke('fatal', true);
          throw refusal;
        }
        const now = performance.now();
        if (!Number.isFinite(now) || now < lastNow || now >= deadline) revoke('expired');
        lastNow = now;
        if (signal.aborted) revoke('cancelled');
        if (reason) throw refusal;
      }
      function callbackCurrent() {
        current();
        if (!accepting || window.signal.aborted) throw refusal;
      }
      function rejected(error) {
        if (error !== refusal) revoke('fatal', true);
        const promise = Promise.reject(refusal);
        promise.catch(() => {});
        return promise;
      }
      function track(action) {
        const promise = Promise.resolve()
          .then(action)
          .catch((error) => {
            if (error !== refusal) revoke('fatal', true);
            throw refusal;
          });
        pending.add(promise);
        promise.then(
          () => pending.delete(promise),
          () => pending.delete(promise)
        );
        return promise;
      }
      async function sourceCall(method, ...args) {
        try {
          return await operation[method](...args);
        } catch {
          sourceRefused = true;
          throw refusal;
        }
      }
      const dispatch = (wire) => {
        try {
          callbackCurrent();
          check(typeof wire === 'string' && Buffer.byteLength(wire) <= 2 * 1024 * 1024);
          const message = JSON.parse(wire);
          check(message && message.id === localId + 1 && snapshotReads.has(message.method));
          localId++;
          return track(async () => {
            callbackCurrent();
            const globalId = ++wireId;
            const reply = JSON.parse(
              await dispatchGrant.dispatch(JSON.stringify({ ...message, id: globalId }))
            );
            // Validate the admitted reply even after local cancellation.
            check(
              reply &&
                reply.id === globalId &&
                Object.hasOwn(reply, 'value') &&
                !Object.hasOwn(reply, 'error')
            );
            current();
            return JSON.stringify({ ...reply, id: message.id });
          });
        } catch (error) {
          return rejected(error);
        }
      };
      const visitSource = (visitor) => {
        try {
          callbackCurrent();
          check(!sourceVisited && typeof visitor === 'function');
          sourceVisited = true;
          return track(async () => {
            callbackCurrent();
            return sourceCall('visitSource', async (log) => {
              if (!accepting || window.signal.aborted) return;
              try {
                await visitor(log);
              } catch (error) {
                // Only our own revoked borrowed capability is recognized here.
                // Unknown consumer errors remain fatal even when canceled.
                if (error !== refusal) {
                  revoke('fatal', true);
                  throw error;
                }
              }
            });
          });
        } catch (error) {
          return rejected(error);
        }
      };
      async function inspectCheckpoint(checkpoint) {
        const state = await storeSession.inspectPublicState();
        storeSession.assertFresh(state);
        check(JSON.stringify(scanState(state)) === JSON.stringify(checkpoint.state));
        current();
        return state;
      }
      try {
        current();
        if (!source.matchesCompletedDestination(destination)) {
          revoke('destination-mismatch');
          throw refusal;
        }
        const journalState = await journal.readState();
        current();
        if (journalState.pending || !journalState.checkpoint) {
          revoke('checkpoint-unavailable');
          throw refusal;
        }
        const checkpoint = freeze(structuredClone(journalState.checkpoint));
        operation = source.openCompletedCheckpointRead({
          checkpoint,
          destination,
          signal: controller.signal,
          deadline,
        });
        sourceAborted = () => revoke('source-refused');
        operation.signal.addEventListener('abort', sourceAborted, { once: true });
        if (operation.signal.aborted) sourceAborted();
        current();
        const prepared = await sourceCall('prepare');
        check(JSON.stringify(prepared.plan) === JSON.stringify(checkpoint));
        current();
        const initialState = await inspectCheckpoint(checkpoint);
        await journal.revalidate({ source: prepared.evidence, state: initialState });
        current();
        accepting = true;
        const callbackSignal = AbortSignal.any([
          controller.signal,
          operation.signal,
          window.signal,
        ]);
        try {
          // Await the actual callback, not a cancellation race. Its owner must
          // itself observe any utility exit and other child work before settling.
          const callback = Promise.resolve().then(() => {
            callbackCurrent();
            return run({ checkpoint, dispatch, visitSource, signal: callbackSignal });
          });
          const value = await callback;
          accepting = false;
          window.abort();
          await Promise.allSettled([...pending]);
          current();
          const finished = await sourceCall('finish');
          check(
            finished.plan === prepared.plan &&
              JSON.stringify(finished.plan) === JSON.stringify(checkpoint)
          );
          current();
          const state = await inspectCheckpoint(checkpoint);
          await journal.revalidate({ source: finished.evidence, state });
          current();
          // Normal source cleanup aborts its operation signal. Remove only this
          // listener, then independently recheck our own lifetime after draining.
          operation.signal.removeEventListener('abort', sourceAborted);
          operation.close();
          sourceOutcome = await operation.closed;
          check(!sourceOutcome.fatal && sourceOutcome.reason === 'completed');
          current();
          candidate = {
            value,
            plan: finished.plan,
            evidence: finished.evidence,
            state,
            checkpoint,
          };
        } catch (error) {
          if (error !== refusal) revoke('fatal', true);
          throw refusal;
        } finally {
          accepting = false;
          window.abort();
          await Promise.allSettled([...pending]);
        }
      } catch (error) {
        if (error !== refusal) revoke('fatal', true);
        throw fail();
      } finally {
        try {
          accepting = false;
          window.abort();
          // Callback and borrowed work were awaited before this point. Revocation
          // stops further admissions; held source work finishes its authentic drain.
          if (operation) {
            operation.signal.removeEventListener('abort', sourceAborted);
            if (!sourceOutcome) {
              operation.close();
              sourceOutcome = await operation.closed;
            }
            if (sourceOutcome.fatal) fatal = true;
            if (sourceRefused && sourceOutcome.reason === 'completed') fatal = true;
          }
          controller.abort();
          if (candidate) {
            check(!fatal);
            // Publication is after every awaited cleanup, with exclusion retained.
            // Synchronous abort listeners above can revoke the caller or owner.
            current();
            ready = { plan: candidate.plan, evidence: candidate.evidence, state: candidate.state };
            const token = Object.freeze({});
            snapshots.set(token, { ready, checkpoint: candidate.checkpoint });
            result = Object.freeze({ value: candidate.value, evidence: token });
          }
        } catch (error) {
          if (error !== refusal) fatal = true;
          ready = null;
          cleanupFailed = true;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', onCancel);
          scope.signal.removeEventListener('abort', onOwner);
          if (!result) ready = null;
          try {
            if (fatal) close();
          } finally {
            busy = false;
            outcome.fatal = fatal;
            outcome.reason = fatal
              ? 'fatal'
              : reason && reason !== 'source-refused'
                ? reason
                : sourceOutcome?.reason || 'admission-refused';
            outcome.rpcFailure = sourceOutcome?.rpcFailure || null;
          }
        }
      }
      if (cleanupFailed) throw fail();
      return result;
    } catch {
      // Only the exact final rejection is registered, after admitted work and
      // cleanup have settled. Error text/codes never establish provenance.
      const error = fail();
      completedOutcomes.set(error, {
        coordinator: instance,
        outcome: Object.freeze({ ...outcome }),
      });
      throw error;
    }
  }
  function assertSnapshot(token) {
    active();
    const snapshot = snapshots.get(token);
    check(!busy && snapshot && snapshot.ready === ready);
    diagnostic();
    // Public source consistency only; never a wallet, chain-trust or POI grant.
    return snapshot.checkpoint;
  }
  const instance = Object.freeze({
    identity: Object.freeze({
      directory: journalStorage.directory,
      policy: journalStorage.policy,
      binding: journalStorage.binding,
      ledgerId: source.ledgerId,
    }),
    advance,
    withPublicSnapshot,
    withCompletedPublicSnapshot,
    assertSnapshot,
    recover: () => exclusive(recover),
    inspect: diagnostic,
    close,
    signal: scope.signal,
  });
  instances.set(instance, handle);
  return instance;
}
function assertRailgunScanCoordinator(instance, expectedHandle) {
  const handle = instances.get(instance);
  check(handle && !instance.signal.aborted);
  const actual = getPrivacyContext(handle),
    expected = getPrivacyContext(expectedHandle);
  check(actual.profileId === expected.profileId);
  for (const key of ['kind', 'principal', 'protocol', 'deployment', 'chainId'])
    check(actual.subject[key] === expected.subject[key]);
}
function getRailgunCompletedSnapshotOutcome(coordinator, error) {
  const entry = completedOutcomes.get(error);
  check(entry && entry.coordinator === coordinator);
  // Historical failure provenance remains readable after fatal owner closure.
  return entry.outcome;
}
module.exports = {
  createRailgunScanCoordinator,
  assertRailgunScanCoordinator,
  getRailgunCompletedSnapshotOutcome,
};
