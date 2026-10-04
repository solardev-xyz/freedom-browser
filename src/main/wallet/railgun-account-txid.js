/** Enrolled, public-data-only TXID mirror. This lifetime owns the third worker
 * while wallet scanning is closed. Checkpoints are diagnostics, never POI or
 * spending authority. No caller supplies rows, roots, keys or service URLs.
 */
const fs = require('fs'),
  path = require('path');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const {
  getRailgunAccountPublicIdentity,
  openRailgunAccountPublicTxidStore,
  withRailgunAccountTxidJournalKey,
} = require('./railgun-account-public');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { getRailgunTxidPolicy, railgunTxidBinding } = require('./railgun-txid-policy');
const { createRailgunTxidRunner } = require('./railgun-txid-runner');
const { createRailgunTxidJournal } = require('./railgun-txid-journal');
const { createRailgunTxidRootSource } = require('./railgun-txid-root');
const { createRailgunPublicServices } = require('./railgun-public-services');
const {
  normalizeRailgunTxidWitness,
  normalizeRailgunNoteTxidWitness,
} = require('./railgun-txid-note-witness');
const { getPrivacyStoragePath } = require('./privacy-storage');
const fail = () =>
  Object.assign(new Error('Railgun account TXID state requires recovery'), {
    code: 'RAILGUN_ACCOUNT_TXID_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
// This validates diagnostic shape and checkpoint binding, not Poseidon. The
// guarded job computes the prefix; its receipt remains inside the TXID phase.
function normalizeHistoricalRoot(value, state, index) {
  const keys = [
    'version',
    'tree',
    'index',
    'root',
    'checkpointIndex',
    'checkpointRoot',
    'transcript',
    'localPrefixComputed',
    'globalTxidCompleteness',
    'ownershipVerified',
    'eventCoverageVerified',
    'rootAccepted',
    'spendingEnabled',
  ];
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key))
  );
  const text = JSON.stringify(value);
  check(Buffer.byteLength(text) <= 4096);
  const result = JSON.parse(text);
  const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  const field = (v) =>
    digest(v) &&
    BigInt('0x' + v) <
      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  check(
    result.version === 1 &&
      result.tree === 0 &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index <= 7999 &&
      result.index === index &&
      Number.isSafeInteger(state?.count) &&
      state.count > 0 &&
      state.count <= 8000 &&
      index < state.count &&
      result.checkpointIndex === state.count - 1 &&
      field(result.root) &&
      field(result.checkpointRoot) &&
      result.checkpointRoot === state.root &&
      digest(result.transcript) &&
      result.transcript === state.transcript &&
      result.localPrefixComputed === true
  );
  for (const key of [
    'globalTxidCompleteness',
    'ownershipVerified',
    'eventCoverageVerified',
    'rootAccepted',
    'spendingEnabled',
  ])
    check(result[key] === false);
  if (index === state.count - 1) check(result.root === state.root);
  return Object.freeze(result);
}
function exists(filename) {
  try {
    const stat = fs.lstatSync(filename);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function openRailgunAccountTxid({
  enrollment,
  archive,
  coordinator,
  create = false,
  checkpointOnly = false,
  handoff,
}) {
  check(typeof create === 'boolean' && typeof checkpointOnly === 'boolean');
  check(!checkpointOnly || !create);
  check(handoff === undefined || checkpointOnly);
  const publicPolicy = getRailgunPublicPolicy(archive),
    publicIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy),
    policy = getRailgunTxidPolicy(archive),
    binding = railgunTxidBinding(enrollment.binding),
    phase = claimRailgunAccountPhase(enrollment, 'txid', handoff);
  let scope, opened, runner, journal, roots, services, work, onAbort;
  const watched = [];
  let closed = false,
    draining,
    capturedCheckpoint,
    serviceLatestIndex = null;
  const active = () => {
    check(!closed && !scope.signal.aborted);
    phase.assertCurrent();
    getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy);
  };
  const stop = () => {
    closed = true;
    if (onAbort) for (const signal of watched) signal.removeEventListener('abort', onAbort);
    scope?.close();
    journal?.close();
    roots?.close();
    services?.close();
    runner?.close();
    opened?.session.close();
  };
  const close = () => {
    if (draining) return draining;
    stop();
    draining = (async () => {
      if (work) await work.catch(() => {});
      stop();
      if (opened) await opened.session.closed;
      phase.release();
    })();
    return draining;
  };
  const validate = (state) => roots.acquire({ index: state.count - 1, root: state.root });
  async function applyAndComplete(token, payload) {
    await runner.run('apply', payload);
    // Root acquisition can itself exceed the compute receipt lifetime. Replay
    // the already authenticated page after refreshing the root, so both final
    // receipts are fresh. The runner verifies the whole idempotent page.
    const root = await validate(payload.expected);
    const applied = await runner.run('apply', payload);
    await journal.complete(token, applied.receipt, root);
  }
  function assertCheckpoint(current) {
    if (checkpointOnly) {
      // Staging may revalidate public service acceptance, but must never turn
      // missing/pending state into an implicit repair or advance operation.
      check(
        current.checkpoint &&
          !current.pending &&
          Number.isSafeInteger(current.checkpoint.state?.count) &&
          current.checkpoint.state.count > 0 &&
          current.checkpoint.state.count <= 8000
      );
      const serialized = JSON.stringify(current.checkpoint);
      check(capturedCheckpoint === undefined || capturedCheckpoint === serialized);
      capturedCheckpoint = serialized;
    }
  }
  async function restore() {
    const current = await journal.readState();
    active();
    assertCheckpoint(current);
    if (current.pending) {
      const payload = current.pending.work;
      const receipt = await validate(payload.expected);
      const inspected = await runner.run('inspect', {});
      const token = await journal.resume(inspected.receipt, receipt);
      await applyAndComplete(token, payload);
    } else {
      const receipt = current.checkpoint ? await validate(current.checkpoint.state) : undefined;
      const inspected = await runner.run('inspect', {});
      await journal.revalidate(inspected.receipt, receipt);
    }
    active();
  }
  async function advance() {
    check(!checkpointOnly);
    // Opening already recovered the journal. Every successful page is complete;
    // a page failure closes this lifetime and requires another opening.
    const inspected = await runner.run('inspect', {}),
      base = inspected.value.state,
      latest = await services.latestTxid();
    serviceLatestIndex = latest.index;
    active();
    check(latest.index + 1 >= base.count);
    const target = Math.min(latest.index + 1, 8000);
    if (target === base.count) return diagnostic();
    const page = await services.txidPage(base.after);
    active();
    const rows = page.transactions.slice(0, target - base.count);
    check(rows.length > 0);
    // A service round trip may outlive a compute receipt. Acquire root evidence
    // first, then repeat the deterministic read-only projection before prepare.
    const projected = await runner.run('project', { base, rows });
    const expected = projected.value.state;
    const root = await validate(expected);
    const fresh = await runner.run('project', { base, rows });
    check(JSON.stringify(fresh.value.state) === JSON.stringify(expected));
    const payload = { base, rows, expected };
    const token = await journal.prepare(payload, fresh.receipt, root);
    await applyAndComplete(token, payload);
    active();
    return diagnostic();
  }
  async function diagnostic() {
    const value = await journal.readState();
    active();
    assertCheckpoint(value);
    return Object.freeze({
      ...value,
      capacityReached: value.checkpoint?.state.count === 8000,
      serviceLatestIndex,
    });
  }
  async function cover() {
    await restore();
    const current = await journal.readState();
    assertCheckpoint(current);
    check(current.checkpoint && !current.pending);
    let payload;
    const checked = await coordinator.withPublicSnapshot((snapshot) => {
      payload = { state: current.checkpoint.state, plan: snapshot.checkpoint };
      return runner.run('coverage', payload, {
        visit: snapshot.visitSource,
        signal: snapshot.signal,
      });
    });
    active();
    const plan = coordinator.assertSnapshot(checked.evidence);
    check(JSON.stringify(plan) === JSON.stringify(payload.plan));
    const value = runner.assertResult(checked.value.receipt, 'coverage', payload);
    check(
      value.coverage.txid.count === current.checkpoint.state.count &&
        value.coverage.txid.root === current.checkpoint.state.root &&
        value.coverage.txid.transcript === current.checkpoint.state.transcript
    );
    check(
      value.coverage.source.ledgerId === publicIdentity.sourceId &&
        value.coverage.source.ledgerSha256 === plan.source.ledgerSha256
    );
    // Diagnostic evidence only. A later operation must independently bind its
    // note, membership witness, fresh root and required-list POI before spending.
    return value.coverage;
  }
  async function witness(mode, input) {
    await restore();
    const current = await journal.readState();
    active();
    assertCheckpoint(current);
    check(current.checkpoint && !current.pending);
    const payload = { state: current.checkpoint.state, ...input };
    if (mode === 'historical-root') check(input.index < payload.state.count);
    const computed = await runner.run(mode, payload);
    active();
    const value = runner.assertResult(computed.receipt, mode, payload);
    if (mode === 'historical-root')
      return normalizeHistoricalRoot(value.historicalRoot, payload.state, input.index);
    // These immutable values may outlive this phase, but the runner's receipt
    // may not. A spending composition must re-verify the path, owned selection,
    // canonical event relation and fresh service root under its own lifetime.
    return Object.freeze({
      ...(mode === 'note-witness'
        ? {
            noteWitness: normalizeRailgunNoteTxidWitness(
              value.noteWitness,
              payload.state,
              input.note
            ),
          }
        : { witness: normalizeRailgunTxidWitness(value.witness, payload.state, input.txid) }),
      ownershipVerified: false,
      eventCoverageVerified: false,
      rootAccepted: false,
      spendingEnabled: false,
    });
  }
  function selectWitness(mode, selector) {
    // Snapshot before exclusive() schedules work in the next microtask.
    const input = JSON.parse(JSON.stringify(selector));
    return exclusive(() => witness(mode, input));
  }
  async function exclusive(run) {
    active();
    check(!work);
    work = Promise.resolve().then(run);
    try {
      const value = await work;
      active();
      return value;
    } catch (error) {
      await close();
      throw error;
    } finally {
      work = null;
    }
  }
  try {
    const context = getPrivacyContext(enrollment.getContext('engine'));
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([enrollment.signal, coordinator.signal]),
      isCurrent: () => {
        phase.assertCurrent();
        return true;
      },
    });
    const serviceHandle = scope.getContext({
      kind: 'service',
      principal: 'railgun-public-sync',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'public-services',
    });
    roots = createRailgunTxidRootSource(serviceHandle);
    services = createRailgunPublicServices(serviceHandle);
    const directory = coordinator.identity.directory;
    const journalHandle = scope.getContext({
      ...context.subject,
      role: 'storage',
      operation: 'railgun-txid-v1:' + policy,
    });
    const filename = path.join(directory, 'txid-' + policy + '.sqlite'),
      journalFile = getPrivacyStoragePath(journalHandle, directory);
    enrollment.profileGuard.assert(filename);
    enrollment.profileGuard.assert(journalFile);
    const hasStore = exists(filename),
      hasJournal = exists(journalFile);
    check(create || (hasStore && hasJournal));
    check(hasStore || !hasJournal);
    opened = await openRailgunAccountPublicTxidStore({
      coordinator,
      enrollment,
      policy: publicPolicy,
      txidPolicy: policy,
      create: !hasStore,
    });
    active();
    runner = createRailgunTxidRunner({
      handle: scope.getContext({ ...context.subject, operation: undefined }),
      archive,
      session: opened.session,
      filename: opened.filename,
      binding,
      policy,
    });
    await withRailgunAccountTxidJournalKey(
      coordinator,
      enrollment,
      publicPolicy,
      policy,
      async (key) => {
        journal = await createRailgunTxidJournal({
          handle: journalHandle,
          directory,
          key,
          profileGuard: enrollment.profileGuard,
          binding,
          publicIdentity,
          policy,
          session: opened.session,
          assertResult: runner.assertResult,
          assertRoot: roots.assertRoot,
          create: !hasJournal,
        });
      }
    );
    await restore();
    onAbort = () => {
      close().catch(() => {});
    };
    for (const signal of [
      scope.signal,
      opened.session.signal,
      runner.signal,
      journal.signal,
      roots.signal,
      services.signal,
    ]) {
      check(signal instanceof AbortSignal && !signal.aborted);
      watched.push(signal);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    active();
    return Object.freeze({
      close,
      signal: scope.signal,
      policy,
      publicIdentity,
      advance: () => exclusive(advance),
      cover: () => exclusive(cover),
      witness: (txid) => selectWitness('witness', { txid }),
      witnessNote: (note) => selectWitness('note-witness', { note }),
      historicalRoot: (index) => {
        check(Number.isSafeInteger(index) && index >= 0 && index <= 7999);
        return selectWitness('historical-root', { index });
      },
      inspect: () => exclusive(diagnostic),
    });
  } catch (error) {
    await close();
    throw error;
  }
}
module.exports = { openRailgunAccountTxid };
