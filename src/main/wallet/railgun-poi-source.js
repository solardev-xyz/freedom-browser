/** Main-owned, operation-scoped POI reads for a fixed set of blinded notes.
 * The caller must derive these notes from authenticated wallet state before
 * constructing this capability. This transport does not attest note ownership
 * or check Poseidon paths; its opaque receipt attests only service observations.
 */
const { randomUUID } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createWalletTorTransport } = require('../networks/wallet-tor-transport');
const {
  REQUIRED_LIST,
  normalizePoiNotes,
  normalizePoiStatuses,
  normalizePoiProofs,
  verifyPoiEvent,
} = require('./railgun-poi-records');
const POI_URL = 'https://ppoi.fdi.network';
const MAX_AGE_MS = 60000;
const ACQUIRE_TIMEOUT_MS = 45000;
const sources = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun POI source unavailable'), {
    code: 'RAILGUN_POI_SOURCE_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
function createRailgunPoiSource({ handle, notes: input }) {
  const context = getPrivacyContext(handle),
    { subject, requirements } = context;
  check(
    subject.kind === 'private-account' &&
      /^railgun:(0|[1-9][0-9]{0,4})$/.test(subject.principal) &&
      Number(subject.principal.slice(8)) <= 65535 &&
      subject.protocol === 'railgun' &&
      subject.deployment === 'sepolia' &&
      subject.chainId === 11155111 &&
      subject.role === 'poi' &&
      typeof subject.operation === 'string' &&
      /^poi:[0-9a-f]{64}$/.test(subject.operation) &&
      requirements.content === 'public' &&
      requirements.correctness === 'any' &&
      requirements.maxAgeMs === null
  );
  const notes = normalizePoiNotes(input);
  check(require('../settings-store').isWalletTorExperimentAvailable());
  const tor = require('../tor-manager'),
    endpoint = tor.getWalletSocksEndpoint();
  check(endpoint && !endpoint.signal.aborted);
  const controller = new AbortController();
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([context.signal, endpoint.signal, controller.signal]),
    isCurrent: () => {
      try {
        // Transport uses this derived handle; retain the original parent's
        // admission checks as well as Tor endpoint currency at that boundary.
        getPrivacyContext(handle);
        return tor.getWalletSocksEndpoint() === endpoint;
      } catch {
        return false;
      }
    },
  });
  const receipts = new WeakMap();
  let scopedHandle,
    transport,
    busy = false,
    closed = false,
    transportDrained = false,
    resolveClosed,
    sequence = 0,
    acquisitionStarted,
    acquisitionBudget;
  const drained = new Promise((resolve) => (resolveClosed = resolve));
  const finishClose = () => {
    // busy covers only inner acquisition work, never the public wrapper's
    // terminal wait below. Otherwise acquire -> closed -> acquire deadlocks.
    if (closed && !busy && transportDrained) resolveClosed();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    scope.signal.removeEventListener('abort', close);
    controller.abort();
    try {
      scope.close();
    } catch {
      // Abort listeners must not throw or skip the transport close request.
    }
    try {
      transport?.close();
    } catch {
      // Only its actual closed barrier can establish physical drain.
    }
    finishClose();
  };
  const active = () => {
    check(!closed && !scope.signal.aborted);
    getPrivacyContext(handle);
    check(tor.getWalletSocksEndpoint() === endpoint);
  };
  try {
    scopedHandle = scope.getContext(subject);
    transport = createWalletTorTransport();
    const barrier = transport.closed;
    check(barrier && typeof barrier.then === 'function');
    barrier.then(
      () => {
        transportDrained = true;
        finishClose();
      },
      () => {
        // The real transport never rejects. Consume a contract violation but
        // never turn it into evidence that its sockets have actually closed.
        close();
      }
    );
    scope.signal.addEventListener('abort', close, { once: true });
    active();
  } catch {
    // A synchronous factory failure cannot promise construction-time drain,
    // but must revoke the scope and request cleanup of any returned transport.
    close();
    throw fail();
  }
  async function request(method, params) {
    active();
    const now = performance.now();
    check(now >= acquisitionStarted && now - acquisitionStarted < acquisitionBudget);
    const id = randomUUID();
    const response = await transport.request(scopedHandle, POI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          chainType: '0',
          chainID: '11155111',
          txidVersion: 'V2_PoseidonMerkle',
          ...params,
        },
      }),
      signal: scope.signal,
      timeoutMs: Math.max(1, Math.floor(acquisitionBudget - (now - acquisitionStarted))),
    });
    active();
    check(
      performance.now() >= acquisitionStarted &&
        performance.now() - acquisitionStarted < acquisitionBudget
    );
    check(
      response.status === 200 && Buffer.isBuffer(response.body) && response.body.length <= 32768
    );
    const value = JSON.parse(response.body.toString('utf8'));
    check(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 3 &&
        Object.hasOwn(value, 'result') &&
        value.jsonrpc === '2.0' &&
        value.id === id
    );
    return value.result;
  }
  async function acquire({ timeoutMs = ACQUIRE_TIMEOUT_MS } = {}) {
    active();
    check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= ACQUIRE_TIMEOUT_MS);
    check(!busy);
    busy = true;
    const current = ++sequence;
    acquisitionStarted = performance.now();
    acquisitionBudget = timeoutMs;
    const started = acquisitionStarted;
    const timer = setTimeout(close, acquisitionBudget);
    timer.unref?.();
    let result,
      failed = false;
    try {
      const statuses = normalizePoiStatuses(
        await request('ppoi_pois_per_list', {
          listKeys: [REQUIRED_LIST],
          blindedCommitmentDatas: notes,
        }),
        notes
      );
      let proofs = null,
        events = null,
        rootsAccepted = false;
      if (statuses.every((note) => note.status === 'Valid')) {
        proofs = normalizePoiProofs(
          await request('ppoi_merkle_proofs', {
            listKey: REQUIRED_LIST,
            blindedCommitments: notes.map((n) => n.blindedCommitment),
          }),
          notes
        );
        events = [];
        for (let index = 0; index < proofs.length; index++) {
          const position = Number(BigInt('0x' + proofs[index].indices));
          events.push(
            verifyPoiEvent(
              await request('ppoi_poi_events', {
                listKey: REQUIRED_LIST,
                startIndex: position,
                endIndex: position,
              }),
              notes[index],
              proofs[index]
            )
          );
        }
        Object.freeze(events);
        const accepted = await request('ppoi_validate_poi_merkleroots', {
          listKey: REQUIRED_LIST,
          poiMerkleroots: proofs.map((p) => p.root),
        });
        check(typeof accepted === 'boolean');
        rootsAccepted = accepted;
      }
      active();
      const observation = Object.freeze({
        listKey: REQUIRED_LIST,
        statuses,
        proofs,
        events,
        rootsAccepted,
        observedAt: new Date().toISOString(),
        trust: 'unverified-service',
        membershipVerified: false,
        spendingEnabled: false,
      });
      const receipt = Object.freeze({});
      receipts.set(receipt, { sequence: current, at: started, observation });
      result = Object.freeze({ receipt, observation });
    } catch {
      failed = true;
      close();
    } finally {
      clearTimeout(timer);
      busy = false;
      finishClose();
    }
    if (failed) {
      // All request/validation work has settled before waiting on terminal
      // closure. A healthy acquisition leaves the source and this barrier open.
      await drained;
      throw fail();
    }
    return result;
  }
  function assertResult(receipt, minimumRemainingMs = 0) {
    active();
    check(
      Number.isSafeInteger(minimumRemainingMs) &&
        minimumRemainingMs >= 0 &&
        minimumRemainingMs < MAX_AGE_MS
    );
    const entry = receipts.get(receipt),
      now = performance.now();
    check(
      entry &&
        !busy &&
        entry.sequence === sequence &&
        now >= entry.at &&
        now - entry.at + minimumRemainingMs < MAX_AGE_MS
    );
    return entry.observation;
  }
  const source = Object.freeze({
    acquire,
    assertResult,
    close,
    closed: drained,
    signal: scope.signal,
  });
  sources.set(source, { handle, notes });
  return source;
}
function assertRailgunPoiSource(source, handle) {
  const entry = sources.get(source);
  check(entry && !source.signal.aborted);
  const current = getPrivacyContext(entry.handle),
    expected = getPrivacyContext(handle);
  check(
    current.profileId === expected.profileId &&
      current.generation === expected.generation &&
      JSON.stringify(current.subject) === JSON.stringify(expected.subject)
  );
  return entry.notes;
}
module.exports = { createRailgunPoiSource, assertRailgunPoiSource, MAX_AGE_MS, ACQUIRE_TIMEOUT_MS };
