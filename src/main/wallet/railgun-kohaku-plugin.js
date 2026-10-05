/** Main-only Kohaku capability-selected lanes. Adoption transfers account lifecycle ownership.
 * This is not a generic Kohaku Host, UI consent issuer or live activation route.
 * Trusted review adapters must settle after abort: exclusion waits for them.
 */
const assert = require('assert/strict');
const path = require('path');
const { isProxy } = require('util').types;
const { dispatchRailgunKohakuRead } = require('./railgun-kohaku-read-dispatch');
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
const { openRailgunShieldOperation } = require('./railgun-shield-operation');
const { shieldAmount } = require('./railgun-shield-policy');
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
  PREPARE_MS = 540000,
  PUBLIC_MS = 120000;
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
function fundingRecord() {
  // Public mnemonic metadata only. Never derive an address before review.
  const { getWalletRecord, WALLET_TYPES } = require('../identity-manager');
  const record = getWalletRecord(0);
  assert.ok(record && record.index === 0 && record.type === WALLET_TYPES.MNEMONIC);
  assert.equal(typeof record.address, 'string');
  const address = require('ethers').getAddress(record.address).toLowerCase();
  assert.ok(BigInt(address) > 0n);
  return Object.freeze({ index: record.index, type: record.type, address });
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
  assert.ok(['read', 'private', 'public'].includes(mode));
  const signal = options.signal;
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(isRailgunAccountEnrollment(enrollment));
  const parent = enrollment.getContext('engine');
  const descriptor = assertRailgunIdentity(identity, parent);
  const publicInstanceId = mode === 'public' ? descriptor.instanceId : null;
  if (mode === 'public')
    assert.ok(typeof publicInstanceId === 'string' && publicInstanceId.length > 0);
  assert.equal(identity.descriptor.walletId, enrollment.descriptor.walletId);
  readRailgunAccountOwnedNotes(options.account, owners);
  assert.equal(typeof enrollment.directory, 'string');
  assert.ok(!ownersByDirectory.has(enrollment.directory));
  let resources = { ...options, owners };
  if (mode !== 'read') {
    if (mode === 'public')
      assert.ok(
        !Object.hasOwn(options, 'proverArchive') && !Object.hasOwn(options, 'artifactDirectory')
      );
    for (const key of mode === 'public'
      ? ['archive']
      : ['archive', 'proverArchive', 'artifactDirectory'])
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
    shield,
    publicBudget,
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
    shield?.signal.removeEventListener('abort', close);
    resources =
      operation =
      completion =
      shield =
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
    const preparingPublic = mode === 'public' && busy && state !== 'broadcasting';
    closed = true;
    state = 'closed';
    clearTimeout(timer);
    if (completion) recoveryRequired = true;
    if (callbackActive || preparingPublic) resolvePublicAbort?.();
    controller.abort();
    for (const resource of [preview, staging, completion, shield, ...(constraints || [])]) {
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
    if (publicBudget) {
      const now = performance.now(),
        wall = Date.now();
      if (
        !Number.isFinite(now) ||
        now < publicBudget.last ||
        now >= publicBudget.deadline ||
        !Number.isFinite(wall) ||
        wall < publicBudget.wallStarted ||
        wall >= publicBudget.wallDeadline
      ) {
        close();
        throw fail();
      }
      publicBudget.last = now;
    }
    assert.ok(!closed && !lifetime.aborted && !controller.signal.aborted && !cleanupFailed);
    assert.equal(ownersByDirectory.get(directory), owner);
    const currentDescriptor = assertRailgunIdentity(identity, parent);
    if (mode === 'public') assert.equal(currentDescriptor.instanceId, publicInstanceId);
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
        if (completion || mode === 'public') close();
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
  // These ports are fixed main-owned closures, never caller-supplied Host options.
  const readPorts = Object.freeze({
    capture() {
      current();
      assert.ok(!busy && account);
      readRailgunAccountOwnedNotes(account, owners);
      return { account, view: account.view };
    },
    recheck(captured) {
      current();
      assert.ok(account && !busy);
      assert.equal(account, captured.account);
      assert.equal(account.view, captured.view);
      readRailgunAccountOwnedNotes(account, owners);
    },
    retain: track,
    refused: fail,
  });
  function read(method, args) {
    return dispatchRailgunKohakuRead(readPorts, method, args);
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
      const requestedAmount = amount.amount,
        noteId = amount.noteId,
        unshield = kind === 'railgun-token-unshield';
      available();
      let inputAmount = requestedAmount;
      if (unshield) {
        const notes = readRailgunAccountOwnedNotes(account, owners).read.received.filter(
          (note) => note.id === noteId
        );
        assert.equal(notes.length, 1);
        inputAmount = notes[0].amount;
        assert.ok(typeof inputAmount === 'bigint' && requestedAmount <= inputAmount);
        if (requestedAmount < inputAmount) kind = 'railgun-partial-unshield';
      }
      const partial = kind === 'railgun-partial-unshield';
      const request = Object.freeze({
        kind,
        noteId,
        recipient,
        ...(partial ? { unshieldAmount: requestedAmount.toString() } : {}),
      });
      const baseline = selected(account, owners, request);
      assert.equal(inputAmount, baseline.note.amount);
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
          if (unshield) assert.equal(recipient, submitter);
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
            fullNote: !partial,
            ...(partial
              ? {
                  inputAmount: inputAmount.toString(),
                  unshieldAmount: requestedAmount.toString(),
                  changeAmount: (inputAmount - requestedAmount).toString(),
                  entireInputConsumed: true,
                  changeRecipient: 'same-private-account',
                  unshieldAmountIncludesProtocolFee: true,
                  changeRequiresConfirmedScan: true,
                  changeSpendRequiresSeparatePoiSubmission: true,
                  changePoiDisclosure:
                    'Spending change requires a later, separately reviewed combined POI submission and list acceptance. That submission links the blinded change to the public unshield recipient and amount at the aggregator; this operation does not publish it automatically.',
                }
              : {}),
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
                ...(partial ? ['gross-unshield-amount', 'encrypted-change-output'] : []),
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
  function prepareShield(amount, to) {
    try {
      assert.equal(mode, 'public');
      shape(amount, ['asset', 'amount']);
      shape(amount.asset, ['__type']);
      assert.equal(amount.asset.__type, 'native');
      assert.equal(typeof amount.amount, 'bigint');
      const value = shieldAmount(amount.amount.toString());
      const descriptor = assertRailgunIdentity(identity, parent);
      const recipient = descriptor.instanceId;
      assert.ok(typeof recipient === 'string' && recipient.length > 0);
      assert.ok(to === undefined || to === recipient);
      return start(async () => {
        const started = performance.now();
        const wallStarted = Date.now();
        publicBudget = {
          last: started,
          deadline: started + PUBLIC_MS,
          wallStarted,
          wallDeadline: wallStarted + PUBLIC_MS,
        };
        timer = setTimeout(close, PUBLIC_MS);
        timer.unref?.();
        current();
        const funding = fundingRecord();
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
        const protocolSubject = { ...getPrivacyContext(parent).subject, role: 'protocol-rpc' };
        delete protocolSubject.operation;
        const protocolHandle = preview.getContext(protocolSubject);
        const protocolRpc = createPrivateRpc(protocolHandle, 'protocol-rpc');
        const protocolObservation = getPrivateRpcDestination(protocolRpc, protocolHandle);
        const protocolDetails = getPrivateRpcDestinationDetails(protocolObservation);
        const transactionHandle = preview.getContext({
          kind: 'public-address',
          principal: funding.address,
          chainId: pins.chainId,
          role: 'transaction-rpc',
        });
        const transactionRpc = createPrivateRpc(transactionHandle, 'transaction-rpc');
        const transactionObservation = getPrivateRpcDestination(transactionRpc, transactionHandle);
        const transactionDetails = getPrivateRpcDestinationDetails(transactionObservation);
        constraints = [];
        for (const observation of [protocolObservation, transactionObservation]) {
          const constraint = createPrivateRpcDestinationConstraint({
            observation,
            signal: controller.signal,
            deadline: publicBudget.deadline,
          });
          constraints.push(constraint);
          constraint.signal.addEventListener('abort', close, { once: true });
        }
        const destinationConstraints = Object.freeze({
          protocol: constraints[0].constraint,
          transaction: constraints[1].constraint,
        });
        const guard = () => {
          current();
          assert.deepEqual(fundingRecord(), funding);
          assert.deepEqual(configuredRpc(), configuration);
          assert.equal(assertRailgunIdentity(identity, parent).instanceId, recipient);
          assert.ok(constraints.every((constraint) => !constraint.signal.aborted));
          assert.equal(getPrivateRpcDestination(protocolRpc, protocolHandle), protocolObservation);
          assert.equal(
            getPrivateRpcDestination(transactionRpc, transactionHandle),
            transactionObservation
          );
        };
        reviewedCurrent = guard;
        const protocolFee = (value * BigInt(pins.shieldFeeBps)) / 10000n;
        const summary = freeze({
          purpose: 'railgun-public-shield-preparation',
          operation: 'railgun-native-shield',
          chainId: pins.chainId,
          asset: { __type: 'native' },
          amount: value.toString(),
          recipient,
          funding,
          wrappedAsset: pins.wrappedNative,
          shieldFeeBps: pins.shieldFeeBps,
          protocolFee: protocolFee.toString(),
          noteValue: (value - protocolFee).toString(),
          destinations: {
            protocolRpc: protocolDetails.url,
            transactionRpc: transactionDetails.url,
          },
          exposures: {
            protocolRpc: [
              'chain-id',
              'deployment-code',
              'proxy-slots',
              'shield-fee',
              'token-blocklist',
              'canonical-block',
            ],
            transactionRpc: [
              'public-funding-address',
              'native-amount',
              'relay-adapt-shield-calldata',
              'encrypted-note',
              'eth_estimateGas',
              'eth_call',
              'code',
              'balance',
              'nonce',
              'fee-estimates',
            ],
          },
          viewingKeyVerification: true,
          privateSpendSigning: false,
          poiQueries: false,
          sourceQueries: false,
          permitsSimulation: true,
          permitsSigning: false,
          broadcastsTransaction: false,
          broadcastSimulationBeforeTransactionReview: true,
          rpcAdmissionDestinationPinned: true,
          chainStateVerified: false,
          automaticRetry: false,
        });
        state = 'reviewing-preparation';
        guard();
        reviewHandoff = reserveRailgunAccountWalletHandoff(account, owners);
        const approved = await runReview(resources.reviewPreparation, summary);
        guard();
        assert.equal(approved, true);
        state = 'preparing';
        await closeAccount(account);
        account = null;
        guard();
        // Recovery rejects handoff tokens. Release and enter the genuine host
        // in this same turn; it claims its own phase before starting a utility.
        reviewHandoff.release();
        reviewHandoff = null;
        const opened = await openRailgunShieldOperation({
          identity,
          enrollment,
          archive: resources.archive,
          amount: value.toString(),
          owner: funding.address,
          signal: controller.signal,
          destinationConstraints,
        });
        // Adopt late resources and the never-rejecting logical drain first.
        shield = opened;
        try {
          const barrier = shield.closed;
          assert.ok(barrier && typeof barrier.then === 'function');
          track(
            Promise.resolve(barrier).catch(() => {
              cleanupFailed = true;
              close();
            })
          );
        } catch {
          cleanupFailed = true;
          close();
          throw fail();
        }
        shield.signal.addEventListener('abort', close, { once: true });
        if (closed || shield.signal.aborted) {
          try {
            shield.close();
          } catch {
            cleanupFailed = true;
          }
          close();
        }
        guard();
        operation = Object.freeze({ __type: 'publicOperation' });
        state = 'prepared';
        return operation;
      });
    } catch {
      return Promise.reject(fail());
    }
  }
  function submitPublic(token) {
    try {
      current();
      assert.equal(mode, 'public');
      assert.ok(!busy && operation && token === operation && shield && !shield.signal.aborted);
    } catch {
      return Promise.reject(fail());
    }
    operation = null;
    busy = true;
    state = 'broadcasting';
    let preservedError;
    const pending = Promise.resolve()
      .then(async () => {
        reviewedCurrent();
        const signer = require('./signers').getSigner(0);
        reviewedCurrent();
        try {
          const outcome = await shield.submit({
            signer,
            gasLimit: resources.gasLimit,
            maxGasFee: resources.maxGasFee,
            review: async (summary) => {
              reviewedCurrent();
              const approved = await runReview(resources.reviewTransaction, summary);
              reviewedCurrent();
              return approved === true;
            },
          });
          recoveryRequired = true;
          return outcome;
        } catch (error) {
          // Only the genuine Shield controller's journal outcomes are preserved;
          // it sanitizes exceptions thrown by the reviewer and signer callbacks.
          if (
            ['PRIVATE_BROADCAST_UNCERTAIN', 'PRIVATE_SUBMISSION_UNRESOLVED'].includes(error?.code)
          ) {
            preservedError = error;
            recoveryRequired = true;
          }
          throw error;
        }
      })
      .catch((error) => {
        throw preservedError && error === preservedError ? error : fail();
      })
      .finally(() => {
        close();
        busy = false;
        finish();
      });
    track(pending);
    // The controller bounds outward callback cancellation; its separate closed
    // promise, already tracked, keeps our ownership through original work.
    return pending;
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
    instanceId: () => {
      if (mode !== 'public') return read('instanceId', []);
      try {
        current();
        return Promise.resolve(publicInstanceId);
      } catch {
        return Promise.reject(fail());
      }
    },
    balance: (assets) => read('balance', [assets]),
    notes: (assets, includeSpent) => read('notes', [assets, includeSpent]),
    ...(mode === 'private'
      ? {
          prepareTransfer: (amount, to) => prepare('railgun-private-transfer', amount, to),
          prepareUnshield: (amount, to, opts) =>
            prepare('railgun-token-unshield', amount, to, opts),
        }
      : mode === 'public'
        ? { prepareShield }
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
  instances.set(plugin, { mode, current, submit, submitPublic });
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
function assertRailgunKohakuPublicPlugin(plugin) {
  try {
    const entry = instances.get(plugin);
    assert.equal(entry?.mode, 'public');
    entry.current();
  } catch {
    throw fail();
  }
}
function submitRailgunKohakuPublicOperation(plugin, operation) {
  try {
    assertRailgunKohakuPublicPlugin(plugin);
    return instances.get(plugin).submitPublic(operation);
  } catch {
    return Promise.reject(fail());
  }
}
module.exports = {
  createRailgunKohakuPlugin,
  assertRailgunKohakuPrivatePlugin,
  broadcastRailgunKohakuOperation,
  assertRailgunKohakuPublicPlugin,
  submitRailgunKohakuPublicOperation,
};
