/** Main-only Kohaku private lane. Adoption transfers account lifecycle ownership.
 * This is not a generic Kohaku Host, UI consent issuer or live activation route.
 * Trusted review adapters must settle after abort: exclusion waits for them.
 */
const assert = require('assert/strict');
const path = require('path');
const { isProxy } = require('util').types;
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const {
  readRailgunAccountOwnedNotes,
  reserveRailgunAccountWalletHandoff,
} = require('./railgun-account-wallet');
const {
  getRailgunAccountPublicIdentity,
  getRailgunAccountPublicDestination,
  assertRailgunAccountPublicDestination,
} = require('./railgun-account-public');
const { selectRailgunPrivatePreparation } = require('./railgun-private-preparation');
const { stageRailgunTransactInput } = require('./railgun-transact-staging');
const { proveRailgunAccountPrivateOperation } = require('./railgun-private-operation');
const { submitRailgunPrivateTransaction } = require('./railgun-private-submission');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  createPrivateRpc,
  getPrivateRpcDestination,
  getPrivateRpcDestinationDetails,
  createPrivateRpcDestinationConstraint,
} = require('../networks/private-rpc');
const registry = require('../networks/network-registry');
const pins = require('./railgun-shield-pins.json');
const instances = new WeakMap(),
  ownersByDirectory = new Map();
const REVIEW_MS = 30000,
  PREPARE_MS = 540000;
const fail = () =>
  Object.assign(new Error('Railgun Kohaku operation unavailable'), {
    code: 'RAILGUN_KOHAKU_REFUSED',
  });
function shape(value, required, optional = []) {
  assert.ok(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  assert.ok(required.every((key) => keys.includes(key)));
  assert.ok(keys.every((key) => required.includes(key) || optional.includes(key)));
  for (const key of keys)
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function configuredRpc() {
  // Private comparison only; never include registry records in errors/reports.
  return structuredClone({
    network: registry.getNetwork(pins.chainId),
    sources: registry.getEndpointSources(pins.chainId, 'rpc'),
    endpoints: registry.getEndpoints(pins.chainId, 'rpc'),
  });
}
function selected(account, owners, request) {
  const owned = readRailgunAccountOwnedNotes(account, owners);
  const selection = selectRailgunPrivatePreparation(owned, request);
  const notes = owned.read.received.filter((note) => note.id === request.noteId);
  const records = owned.ownedPoi.filter((note) => note.id === request.noteId);
  assert.equal(notes.length, 1);
  assert.equal(records.length, 1);
  assert.ok(['Shield', 'Transact'].includes(records[0].type));
  assert.equal(notes[0].hash, records[0].hash);
  assert.equal(notes[0].txid, records[0].txid);
  return freeze(
    structuredClone({
      selection,
      note: notes[0],
      record: records[0],
      checkpointHash: owned.checkpointHash,
    })
  );
}
function createRailgunKohakuPlugin(options) {
  try {
    return create(options);
  } catch {
    throw fail();
  }
}
function create(options) {
  shape(
    options,
    ['account', 'owners', 'signal'],
    [
      'mode',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'reviewPreparation',
      'reviewTransaction',
      'gasLimit',
      'maxGasFee',
    ]
  );
  shape(options.owners, ['identity', 'enrollment', 'coordinator']);
  const owners = Object.freeze({ ...options.owners });
  const { identity, enrollment, coordinator } = owners;
  const mode = options.mode === undefined ? 'read' : options.mode;
  assert.ok(['read', 'private'].includes(mode));
  const signal = options.signal;
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(isRailgunAccountEnrollment(enrollment));
  const parent = enrollment.getContext('engine');
  assertRailgunIdentity(identity, parent);
  assert.equal(identity.descriptor.walletId, enrollment.descriptor.walletId);
  readRailgunAccountOwnedNotes(options.account, owners);
  assert.equal(typeof enrollment.directory, 'string');
  assert.ok(!ownersByDirectory.has(enrollment.directory));
  let resources = { ...options, owners };
  if (mode === 'private') {
    for (const key of ['archive', 'proverArchive', 'artifactDirectory'])
      assert.ok(
        typeof options[key] === 'string' &&
          options[key].length <= 4096 &&
          path.isAbsolute(options[key])
      );
    assert.equal(typeof options.reviewPreparation, 'function');
    assert.equal(typeof options.reviewTransaction, 'function');
    assert.ok(
      typeof options.gasLimit === 'bigint' && options.gasLimit > 0n && options.gasLimit <= 3000000n
    );
    assert.ok(
      typeof options.maxGasFee === 'bigint' &&
        options.maxGasFee > 0n &&
        options.maxGasFee <= 2000000000000000n
    );
  } else
    assert.ok(
      Object.keys(options).every((key) => ['account', 'owners', 'signal', 'mode'].includes(key))
    );
  const publicIdentity = structuredClone(getRailgunAccountPublicIdentity(coordinator, enrollment));
  const directory = enrollment.directory,
    owner = {},
    controller = new AbortController(),
    lifetime = AbortSignal.any([signal, identity.signal, enrollment.signal, coordinator.signal]);
  let account = options.account,
    busy = false,
    closed = false,
    cleanupFailed = false,
    state = 'ready',
    recoveryRequired = false,
    operation,
    completion,
    staging,
    preview,
    constraints,
    reviewHandoff,
    reviewedCurrent,
    callbackActive = false,
    resolvePublicAbort,
    timer,
    resolveClosed;
  const work = new Set(),
    closing = new Map();
  const drained = new Promise((resolve) => (resolveClosed = resolve));
  const finish = () => {
    if (!closed || busy || work.size || cleanupFailed) return;
    try {
      reviewHandoff?.release();
      reviewHandoff = null;
    } catch {
      cleanupFailed = true;
      return;
    }
    lifetime.removeEventListener('abort', close);
    completion?.signal.removeEventListener('abort', expired);
    resources =
      operation =
      completion =
      staging =
      preview =
      constraints =
      account =
      reviewedCurrent =
        null;
    closing.clear();
    if (ownersByDirectory.get(directory) === owner) ownersByDirectory.delete(directory);
    resolveClosed();
  };
  const track = (promise) => {
    work.add(promise);
    promise.then(
      () => {
        work.delete(promise);
        finish();
      },
      () => {
        work.delete(promise);
        finish();
      }
    );
    return promise;
  };
  const closeAccount = (value) => {
    if (!value) return Promise.resolve();
    if (closing.has(value)) return closing.get(value);
    // Publish before invoking a potentially reentrant close implementation.
    let resolve, reject;
    const pending = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    closing.set(value, pending);
    track(pending);
    try {
      Promise.resolve(value.close()).then(resolve, () => {
        cleanupFailed = true;
        reject(fail());
      });
    } catch {
      cleanupFailed = true;
      reject(fail());
    }
    return pending;
  };
  function close() {
    if (closed) return;
    closed = true;
    state = 'closed';
    clearTimeout(timer);
    if (completion) recoveryRequired = true;
    if (callbackActive) resolvePublicAbort?.();
    controller.abort();
    for (const resource of [preview, staging, completion, ...(constraints || [])]) {
      try {
        resource?.close();
      } catch {
        cleanupFailed = true;
      }
    }
    closeAccount(account);
    finish();
  }
  function expired() {
    recoveryRequired = true;
    close();
  }
  function current() {
    assert.ok(!closed && !lifetime.aborted && !controller.signal.aborted && !cleanupFailed);
    assert.equal(ownersByDirectory.get(directory), owner);
    assertRailgunIdentity(identity, parent);
    enrollment.getContext('engine');
    assert.deepEqual(
      structuredClone(getRailgunAccountPublicIdentity(coordinator, enrollment)),
      publicIdentity
    );
  }
  function available() {
    current();
    assert.ok(!busy && !operation && account);
    readRailgunAccountOwnedNotes(account, owners);
  }
  function publicSettlement(pending, broadcasting) {
    let stop;
    const stopped = new Promise((resolve) => {
      stop = resolve;
    });
    resolvePublicAbort = stop;
    const outward = Promise.race([
      pending,
      stopped.then(() => {
        if (broadcasting)
          return Object.freeze({ status: 'recovery-required', stage: 'review-draining' });
        throw fail();
      }),
    ]).finally(() => {
      if (resolvePublicAbort === stop) resolvePublicAbort = null;
    });
    // Also observe a discarded admission promise. This does not release the
    // owner: pending still tracks the entire original callback/controller.
    outward.catch(() => {});
    return outward;
  }
  async function runReview(use, summary) {
    current();
    const started = performance.now(),
      deadline = started + REVIEW_MS;
    const reviewTimer = setTimeout(close, REVIEW_MS);
    reviewTimer.unref?.();
    callbackActive = true;
    let result;
    try {
      result = await use(summary, Object.freeze({ signal: controller.signal }));
    } finally {
      callbackActive = false;
      clearTimeout(reviewTimer);
    }
    current();
    const now = performance.now();
    if (now < started || now >= deadline) {
      close();
      throw fail();
    }
    return result;
  }
  async function runPreparationReview(summary) {
    // A callback may outlive wallet.close(), including an external close.
    // Reserve the real shared phase before entering it, not just our facade map.
    reviewHandoff = reserveRailgunAccountWalletHandoff(account, owners);
    try {
      return await runReview(resources.reviewPreparation, summary);
    } finally {
      if (account.signal.aborted) close();
      if (!closed) {
        // The wallet still holds its phase; staging can reserve its own handoff.
        reviewHandoff.release();
        reviewHandoff = null;
      }
      // Closed paths release in finish(), after callback and account drainage.
    }
  }
  function start(use) {
    available();
    busy = true;
    // Admission precedes every asynchronous operation and user callback.
    const pending = Promise.resolve()
      .then(use)
      .then((result) => {
        current();
        return result;
      })
      .catch(() => {
        if (completion) close();
        throw fail();
      })
      .finally(() => {
        busy = false;
        if (!closed && state !== 'prepared') state = 'ready';
        finish();
      });
    track(pending);
    return publicSettlement(pending, false);
  }
  function read(method, args) {
    try {
      current();
      assert.ok(!busy && account);
      readRailgunAccountOwnedNotes(account, owners);
      const capturedAccount = account,
        capturedView = account.view;
      return track(
        Promise.resolve(capturedView[method](...args))
          .then((result) => {
            current();
            assert.ok(account && !busy);
            assert.equal(account, capturedAccount);
            assert.equal(account.view, capturedView);
            readRailgunAccountOwnedNotes(account, owners);
            return result;
          })
          .catch(() => {
            throw fail();
          })
      );
    } catch {
      return Promise.reject(fail());
    }
  }
  function prepare(kind, amount, recipient, unshieldOptions) {
    try {
      assert.equal(mode, 'private');
      shape(amount, ['asset', 'amount', 'noteId']);
      shape(amount.asset, ['__type', 'contract']);
      assert.equal(amount.asset.__type, 'erc20');
      assert.equal(amount.asset.contract, pins.wrappedNative);
      assert.ok(typeof amount.amount === 'bigint' && amount.amount > 0n);
      assert.ok(
        typeof amount.noteId === 'string' &&
          /^(0|[1-9][0-9]{0,4}):(0|[1-9][0-9]{0,4})$/.test(amount.noteId)
      );
      if (unshieldOptions !== undefined) shape(unshieldOptions, []);
      assert.equal(typeof recipient, 'string');
      if (kind === 'railgun-token-unshield')
        recipient = require('ethers').getAddress(recipient).toLowerCase();
      const requestedAmount = amount.amount;
      const request = Object.freeze({ kind, noteId: amount.noteId, recipient });
      available();
      const baseline = selected(account, owners, request);
      assert.equal(amount.amount, baseline.note.amount);
      return start(async () => {
        const started = performance.now(),
          deadline = started + PREPARE_MS;
        timer = setTimeout(close, PREPARE_MS);
        timer.unref?.();
        let preparationStarted = false;
        try {
          current();
          const signer = require('./signers').getSigner(0);
          const submitter = (await signer.getAddress()).toLowerCase();
          current();
          assert.match(submitter, /^0x[0-9a-f]{40}$/);
          assert.ok(BigInt(submitter) > 0n);
          if (kind === 'railgun-token-unshield') assert.equal(recipient, submitter);
          const destination = getRailgunAccountPublicDestination(coordinator, enrollment);
          const sourceDetails = getPrivateRpcDestinationDetails(destination);
          const configuration = configuredRpc();
          preview = createPrivacyScope({
            profileId: getPrivacyContext(parent).profileId,
            signal: controller.signal,
            isCurrent: () => {
              try {
                current();
                return true;
              } catch {
                return false;
              }
            },
          });
          const subject = { ...getPrivacyContext(parent).subject, role: 'protocol-rpc' };
          delete subject.operation;
          const handle = preview.getContext(subject);
          // Construction selects a destination without dispatching chain-ID/RPC.
          const rpc = createPrivateRpc(handle, 'protocol-rpc');
          const protocolObservation = getPrivateRpcDestination(rpc, handle);
          const rpcDetails = getPrivateRpcDestinationDetails(protocolObservation);
          const transactionHandle = preview.getContext({
            kind: 'public-address',
            principal: submitter,
            chainId: pins.chainId,
            role: 'transaction-rpc',
          });
          const transactionRpc = createPrivateRpc(transactionHandle, 'transaction-rpc');
          const transactionObservation = getPrivateRpcDestination(
            transactionRpc,
            transactionHandle
          );
          const transactionDetails = getPrivateRpcDestinationDetails(transactionObservation);
          constraints = [];
          for (const observation of [protocolObservation, transactionObservation])
            constraints.push(
              createPrivateRpcDestinationConstraint({
                observation,
                signal: controller.signal,
                deadline: deadline + 120000,
              })
            );
          const destinationConstraints = Object.freeze({
            protocol: constraints[0].constraint,
            transaction: constraints[1].constraint,
          });
          const guard = () => {
            current();
            // Timer dispatch may be late. Preparation has its own absolute
            // budget; broadcast instead uses completion/constraint lifetimes.
            if (state !== 'broadcasting') {
              const now = performance.now();
              assert.ok(now >= started && now < deadline);
            }
            assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
            assert.deepEqual(configuredRpc(), configuration);
            assert.ok(constraints.every((constraint) => !constraint.signal.aborted));
          };
          const summary = freeze({
            purpose: 'railgun-private-preparation',
            chainId: pins.chainId,
            operation: kind,
            asset: { __type: 'erc20', contract: pins.wrappedNative },
            amount: requestedAmount.toString(),
            recipient,
            submitter,
            inputType: baseline.record.type,
            selection: {
              noteId: request.noteId,
              tree: baseline.selection.tree,
              position: baseline.selection.position,
              checkpointHash: baseline.checkpointHash,
              walletGenerationId: account.generationId,
              publicGenerationId: publicIdentity.generationId,
            },
            selectedInputs: 1,
            fullNote: true,
            destinations: {
              retainedSource: sourceDetails.url,
              protocolRpc: rpcDetails.url,
              transactionRpc: transactionDetails.url,
              poi: 'https://ppoi.fdi.network',
              txid: baseline.record.type === 'Transact' ? 'https://ppoi.fdi.network' : null,
            },
            exposures: {
              source: ['public-proxy-logs', 'canonical-blocks', 'range-and-timing'],
              poi: ['selected-blinded-commitment', 'commitment-type', 'list', 'membership-root'],
              privatePreflight: [
                'selected-nullifier',
                'input-tree',
                'merkle-root',
                'unspent-check',
              ],
              transactionRpc: [
                'public-submitter',
                'code',
                'balance',
                'nonce',
                'fee-estimates',
                'proved-calldata',
                'recipient',
                'nullifier',
                'commitments',
                'encrypted-output',
                'eth_estimateGas',
                'eth_call',
              ],
              txid:
                baseline.record.type === 'Transact'
                  ? ['latest-txid', 'txid-tree-index-root', 'creating-transaction-source-binding']
                  : [],
            },
            privateSigning: true,
            durableSigningHold: true,
            broadcastsTransaction: false,
            broadcastSimulationBeforeTransactionReview: true,
            chainStateVerified: false,
            rpcAdmissionDestinationPinned: true,
            automaticRetry: false,
          });
          state = 'reviewing-preparation';
          guard();
          const approved = await runPreparationReview(summary);
          guard();
          assert.equal(approved, true);
          reviewedCurrent = guard;
          for (const constraint of constraints)
            constraint.signal.addEventListener('abort', close, { once: true });
          assert.deepEqual(selected(account, owners, request), baseline);
          state = 'preparing';
          preparationStarted = true;
          if (baseline.record.type === 'Transact') {
            const result = await stageRailgunTransactInput({
              account,
              owners,
              request,
              archive: resources.archive,
              signal: controller.signal,
              timeoutMs: Math.min(240000, Math.floor(deadline - performance.now())),
            });
            if (result.status !== 'staged') {
              if (!result.originalAccountReusable) close();
              throw fail();
            }
            // Retain late resources before currency checks. Old wallet closure
            // is intentional and is not the instance's cancellation signal.
            staging = result;
            account = result.account;
            if (closed) {
              staging.close();
              closeAccount(account);
            }
            guard();
            assert.deepEqual(selected(account, owners, request), baseline);
          }
          guard();
          const proved = await proveRailgunAccountPrivateOperation({
            account,
            owners,
            request,
            archive: resources.archive,
            proverArchive: resources.proverArchive,
            artifactDirectory: resources.artifactDirectory,
            destinationConstraints,
            ...(staging ? { stagingReceipt: staging.receipt } : {}),
          });
          if (proved.status !== 'proved') {
            recoveryRequired ||= proved.status === 'signed-unfinished';
            throw fail();
          }
          completion = proved.completion;
          recoveryRequired = true;
          if (closed) completion.close();
          guard();
          assert.ok(completion && !completion.signal.aborted);
          completion.signal.addEventListener('abort', expired, { once: true });
          operation = Object.freeze({ __type: 'privateOperation' });
          state = 'prepared';
          return operation;
        } catch {
          if (preparationStarted) close();
          throw fail();
        } finally {
          clearTimeout(timer);
          let cleanupError = false;
          const closingResources = [staging];
          if (!completion) {
            for (const constraint of constraints || [])
              constraint.signal.removeEventListener('abort', close);
            closingResources.push(preview, ...(constraints || []));
          }
          for (const value of closingResources) {
            try {
              value?.close();
            } catch {
              cleanupError = true;
            }
          }
          if (!completion) {
            preview = null;
            constraints = null;
          }
          staging = null;
          if (cleanupError) {
            cleanupFailed = true;
            close();
          }
        }
      });
    } catch {
      return Promise.reject(fail());
    }
  }
  function submit(token) {
    try {
      current();
      assert.equal(mode, 'private');
      assert.ok(
        !busy && operation && token === operation && completion && !completion.signal.aborted
      );
    } catch {
      return Promise.reject(fail());
    }
    operation = null;
    busy = true;
    state = 'broadcasting';
    const pending = Promise.resolve()
      .then(async () => {
        reviewedCurrent();
        await closeAccount(account);
        account = null;
        reviewedCurrent();
        const result = await submitRailgunPrivateTransaction({
          identity,
          enrollment,
          completion: completion.receipt,
          proverArchive: resources.proverArchive,
          artifactDirectory: resources.artifactDirectory,
          gasLimit: resources.gasLimit,
          maxGasFee: resources.maxGasFee,
          review: async (summary) => {
            reviewedCurrent();
            const approved = await runReview(resources.reviewTransaction, summary);
            reviewedCurrent();
            return approved === true;
          },
        });
        // An acknowledged/uncertain journal-backed result survives cancellation
        // during the controller's final drain; never replace it with a retry.
        return result;
      })
      .catch(() => Object.freeze({ status: 'recovery-required', stage: 'kohaku' }))
      .finally(() => {
        close();
        busy = false;
        finish();
      });
    track(pending);
    return publicSettlement(pending, true);
  }
  const plugin = Object.freeze({
    instanceId: () => read('instanceId', []),
    balance: (assets) => read('balance', [assets]),
    notes: (assets, includeSpent) => read('notes', [assets, includeSpent]),
    ...(mode === 'private'
      ? {
          prepareTransfer: (amount, to) => prepare('railgun-private-transfer', amount, to),
          prepareUnshield: (amount, to, opts) =>
            prepare('railgun-token-unshield', amount, to, opts),
        }
      : {}),
    status: () =>
      Object.freeze({
        state,
        recoveryRequired,
        accountOpen: !!account && !closed,
        operationPending: !!operation && !closed,
      }),
    signal: controller.signal,
    closed: drained,
    close,
  });
  ownersByDirectory.set(directory, owner);
  instances.set(plugin, { mode, current, submit });
  lifetime.addEventListener('abort', close, { once: true });
  if (lifetime.aborted) close();
  return plugin;
}
function assertRailgunKohakuPrivatePlugin(plugin) {
  try {
    const entry = instances.get(plugin);
    assert.equal(entry?.mode, 'private');
    entry.current();
  } catch {
    throw fail();
  }
}
function broadcastRailgunKohakuOperation(plugin, operation) {
  try {
    assertRailgunKohakuPrivatePlugin(plugin);
    return instances.get(plugin).submit(operation);
  } catch {
    return Promise.reject(fail());
  }
}
module.exports = {
  createRailgunKohakuPlugin,
  assertRailgunKohakuPrivatePlugin,
  broadcastRailgunKohakuOperation,
};
