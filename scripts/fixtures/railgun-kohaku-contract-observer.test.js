/** Unit tests of fixture instrumentation. Mock exports here are not owners or
 * native authority; native call sites wrap the genuine registered entry. */
const wallet = '../../src/main/wallet/';
const hash = '0x' + 'ab'.repeat(32);
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(lane, delegate) {
  jest.resetModules();
  const name =
    lane === 'private' ? 'broadcastRailgunKohakuOperation' : 'submitRailgunKohakuPublicOperation';
  const facade = {
    [name]: jest.fn(delegate),
    assertRailgunKohakuPrivatePlugin: jest.fn(),
    assertRailgunKohakuPublicPlugin: jest.fn(),
  };
  jest.doMock(wallet + 'railgun-kohaku-plugin', () => facade);
  const observer = require('./railgun-kohaku-contract-observer').installSettlementObserver(lane);
  const instance = {},
    operation = Object.freeze({ __type: lane + 'Operation' });
  const adapter =
    lane === 'private'
      ? require(wallet + 'railgun-kohaku-broadcaster').createRailgunKohakuBroadcaster(instance)
          .broadcast
      : require(wallet + 'railgun-kohaku-public-submitter').createRailgunKohakuPublicSubmitter(
          instance
        ).submit;
  return { observer, adapter, instance, operation, facade, name };
}
afterEach(() => {
  jest.resetModules();
  jest.dontMock(wallet + 'railgun-kohaku-plugin');
});
test.each(['private', 'public'])(
  'real thin %s adapter forwards independently observed original object',
  async (lane) => {
    const result = { hash },
      pending = Promise.resolve(result);
    const state = setup(lane, () => pending);
    const checked = state.observer.begin(state.instance, state.operation, () =>
      state.adapter(state.operation)
    );
    expect(checked.promise).toBe(pending);
    expect(await checked.promise).toBe(result);
    await checked.assert({ outcome: 'acknowledged', hash });
    expect(state.observer.report()).toMatchObject({
      delegateCalls: 1,
      delegateSettlements: 1,
      checkedCalls: 1,
      acknowledged: 1,
    });
    await state.observer.close();
  }
);
test.each(['copy', 'void', 'rejection'])(
  'independent delegate capture catches caller %s mutation',
  async (mutation) => {
    const result = { hash },
      state = setup('private', async () => result);
    const checked = state.observer.begin(state.instance, state.operation, () =>
      state.adapter(state.operation).then((value) => {
        if (mutation === 'copy') return { ...value };
        if (mutation === 'void') return undefined;
        throw Error('adapter changed settlement');
      })
    );
    await expect(checked.assert({ outcome: 'acknowledged', hash })).rejects.toThrow();
    expect(state.observer.report().checkedCalls).toBe(0);
    await state.observer.close();
  }
);
test('private unknown status remains a fulfilled original value', async () => {
  const result = { transactionHash: hash, submissionStatus: 'unknown' };
  const state = setup('private', async () => result);
  const checked = state.observer.begin(state.instance, state.operation, () =>
    state.adapter(state.operation)
  );
  await checked.assert({ outcome: 'uncertain', hash });
  expect(await checked.promise).toBe(result);
  await state.observer.close();
});
test.each(['uncertain', 'unresolved', 'refused'])(
  'public original %s rejection is retained',
  async (outcome) => {
    const error = Object.assign(Error('fixture-only'), {
      code: {
        uncertain: 'PRIVATE_BROADCAST_UNCERTAIN',
        unresolved: 'PRIVATE_SUBMISSION_UNRESOLVED',
        refused: 'RAILGUN_KOHAKU_REFUSED',
      }[outcome],
      ...(outcome === 'uncertain' ? { transactionHash: hash, submissionStatus: 'unknown' } : {}),
    });
    const state = setup('public', async () => {
      throw error;
    });
    const checked = state.observer.begin(state.instance, state.operation, () =>
      state.adapter(state.operation)
    );
    await checked.assert({ outcome, ...(outcome === 'uncertain' ? { hash } : {}) });
    await expect(checked.promise).rejects.toBe(error);
    await state.observer.close();
  }
);
test('copied error with identical fields fails original rejection identity', async () => {
  const error = Object.assign(Error('fixture'), { code: 'RAILGUN_KOHAKU_REFUSED' });
  const state = setup('public', async () => {
    throw error;
  });
  const checked = state.observer.begin(state.instance, state.operation, () =>
    state.adapter(state.operation).catch((reason) => {
      throw Object.assign(Error(reason.message), reason);
    })
  );
  await expect(checked.assert({ outcome: 'refused' })).rejects.toThrow();
  await state.observer.close();
});
test.each(['missing', 'duplicate', 'wrong instance', 'wrong operation'])(
  'rejects %s delegate entry rather than fabricating an observation',
  async (mode) => {
    const state = setup('private', async () => ({ hash }));
    expect(() =>
      state.observer.begin(state.instance, state.operation, () => {
        if (mode === 'missing') return Promise.resolve({ hash });
        if (mode === 'duplicate') {
          state.adapter(state.operation);
          return state.adapter(state.operation);
        }
        return state.facade[state.name](
          mode === 'wrong instance' ? {} : state.instance,
          mode === 'wrong operation' ? {} : state.operation
        );
      })
    ).toThrow();
    await state.observer.close();
  }
);
test('close restores the delegate then waits the original held settlement', async () => {
  const held = gate(),
    state = setup('private', () => held.promise);
  const checked = state.observer.begin(state.instance, state.operation, () =>
    state.adapter(state.operation)
  );
  let closed = false;
  const closing = state.observer.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(state.observer.report().delegateSettlements).toBe(0);
  held.resolve({ hash });
  await checked.assert({ outcome: 'acknowledged', hash });
  await closing;
  expect(closed).toBe(true);
});
test('observer refuses installation after the adapter captured a delegate', () => {
  const state = setup('private', async () => ({ hash }));
  expect(() =>
    require('./railgun-kohaku-contract-observer').installSettlementObserver('private')
  ).toThrow();
  return state.observer.close();
});
test('resource meter preserves genuine task identity and observes detached nonconstant lifecycle counters', async () => {
  jest.resetModules();
  const utility = gate(),
    worker = gate(),
    readOnly = gate();
  const handles = [utility, worker, readOnly].map(({ promise }) => ({ closed: promise }));
  const runtime = { startRailgunProcess: jest.fn(() => handles[0]) };
  const session = {
    startRailgunSessionWorker: jest.fn(() => handles[1]),
    startRailgunReadOnlySessionWorker: jest.fn(() => handles[2]),
  };
  jest.doMock(wallet + 'railgun-process', () => runtime);
  jest.doMock(wallet + 'railgun-session-worker', () => session);
  const original = runtime.startRailgunProcess;
  const meter = require('./railgun-kohaku-contract-observer').installResourceMeter();
  const before = meter.snapshot();
  expect(runtime.startRailgunProcess({})).toBe(handles[0]);
  expect(session.startRailgunSessionWorker({})).toBe(handles[1]);
  expect(session.startRailgunReadOnlySessionWorker({})).toBe(handles[2]);
  expect(before).toEqual({
    utilityStarts: 0,
    utilitySettlements: 0,
    workerStarts: 0,
    workerSettlements: 0,
    rejectedBarriers: 0,
  });
  expect(meter.snapshot()).toMatchObject({
    utilityStarts: 1,
    workerStarts: 2,
    utilitySettlements: 0,
    workerSettlements: 0,
  });
  utility.resolve({});
  worker.resolve({});
  readOnly.reject(Error('fixture barrier'));
  await Promise.resolve();
  expect(meter.snapshot()).toMatchObject({
    utilitySettlements: 1,
    workerSettlements: 2,
    rejectedBarriers: 1,
  });
  await meter.close();
  expect(runtime.startRailgunProcess).toBe(original);
  jest.dontMock(wallet + 'railgun-process');
  jest.dontMock(wallet + 'railgun-session-worker');
});

test('a swallowed assertion from a production-invoked observer stays fatal at the final sticky gate', async () => {
  const state = setup('private', async () => ({ hash }));
  await state.observer.close();
  let result;
  try {
    result = await state.adapter(state.operation);
  } catch {
    result = { status: 'refused' };
  } // Models a controller sanitizing its callback's throw.
  expect(result).toEqual({ status: 'refused' });
  const sticky = require('./railgun-native-assertions');
  expect(sticky.report()).toEqual([{ label: 'assert.equal', name: 'AssertionError' }]);
  expect(() => sticky.assertEmpty()).toThrow('masked by a production refusal');
});
test('rejected resource barrier is recorded before async meter close can pass its final gate', async () => {
  jest.resetModules();
  const held = gate();
  const runtime = { startRailgunProcess: () => ({ closed: held.promise }) };
  const session = { startRailgunSessionWorker() {}, startRailgunReadOnlySessionWorker() {} };
  jest.doMock(wallet + 'railgun-process', () => runtime);
  jest.doMock(wallet + 'railgun-session-worker', () => session);
  try {
    const meter = require('./railgun-kohaku-contract-observer').installResourceMeter();
    runtime.startRailgunProcess();
    let drained = false;
    const closing = meter.close().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    held.reject(Error('barrier rejected'));
    await closing;
    expect(meter.snapshot().rejectedBarriers).toBe(1);
    const sticky = require('./railgun-native-assertions');
    expect(sticky.report()).toEqual([
      { label: 'kohaku-contract.startRailgunProcess.closed', name: 'Error' },
    ]);
    expect(() => sticky.assertEmpty()).toThrow();
  } finally {
    jest.dontMock(wallet + 'railgun-process');
    jest.dontMock(wallet + 'railgun-session-worker');
  }
});
test('missing resource barrier swallowed into refusal cannot yield green qualification', async () => {
  jest.resetModules();
  const runtime = { startRailgunProcess: () => ({}) };
  const session = { startRailgunSessionWorker() {}, startRailgunReadOnlySessionWorker() {} };
  jest.doMock(wallet + 'railgun-process', () => runtime);
  jest.doMock(wallet + 'railgun-session-worker', () => session);
  try {
    const meter = require('./railgun-kohaku-contract-observer').installResourceMeter();
    let refused = false;
    try {
      runtime.startRailgunProcess();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    await meter.close();
    expect(() => require('./railgun-native-assertions').assertEmpty()).toThrow();
  } finally {
    jest.dontMock(wallet + 'railgun-process');
    jest.dontMock(wallet + 'railgun-session-worker');
  }
});
test.each(['railgun-process', 'railgun-session-worker'])(
  'cached provider %s refuses installation before any wrapper can replace it',
  (provider) => {
    jest.resetModules();
    const fs = require('fs'),
      vm = require('vm');
    const source = fs.readFileSync(require.resolve('./railgun-kohaku-contract-observer'), 'utf8');
    const loaded = [],
      module = { exports: {} };
    const lookup = (name) => {
      loaded.push(name);
      if (name === './railgun-native-assertions') return require(name);
      if (name === './railgun-kohaku-contract-oracle') return require(name);
      throw Error('Provider wrapper must not have been installed');
    };
    lookup.resolve = (name) => name;
    lookup.cache = { [wallet + provider]: {} };
    vm.runInNewContext(source, { require: lookup, module });
    expect(() => module.exports.installResourceMeter()).toThrow(
      'Install before resource providers'
    );
    expect(loaded).toEqual(['./railgun-native-assertions', './railgun-kohaku-contract-oracle']);
  }
);
test('complete current production provider-import inventory is explicit; future callers require review', () => {
  const fs = require('fs'),
    path = require('path');
  const root = path.resolve(__dirname, '../..');
  const found = { 'railgun-process': [], 'railgun-session-worker': [] };
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
        const source = fs.readFileSync(filename, 'utf8');
        const providers = new Set(
          [
            ...source.matchAll(
              /require\(\s*['"][^'"]*\/(railgun-process|railgun-session-worker)['"]\s*\)/g
            ),
          ].map((match) => match[1])
        );
        for (const provider of providers) found[provider].push(path.relative(root, filename));
      }
    }
  }
  visit(path.join(root, 'src'));
  for (const files of Object.values(found)) files.sort();
  expect(found).toEqual({
    'railgun-process': [
      'src/main/wallet/railgun-identity.js',
      'src/main/wallet/railgun-note-provenance.js',
      'src/main/wallet/railgun-own-poi-membership.js',
      'src/main/wallet/railgun-own-poi-proof.js',
      'src/main/wallet/railgun-own-selector.js',
      'src/main/wallet/railgun-own-txid-verifier.js',
      'src/main/wallet/railgun-poi-membership.js',
      'src/main/wallet/railgun-poi-output-recovery.js',
      'src/main/wallet/railgun-poi-shield-selector.js',
      'src/main/wallet/railgun-poi-verifier.js',
      'src/main/wallet/railgun-private-proof.js',
      'src/main/wallet/railgun-private-receive.js',
      'src/main/wallet/railgun-public-run.js',
      'src/main/wallet/railgun-relay-quote-verify.js',
      'src/main/wallet/railgun-shield-prepare.js',
      'src/main/wallet/railgun-shield-receive.js',
      'src/main/wallet/railgun-txid-runner.js',
      'src/main/wallet/railgun-wallet-run.js',
    ],
    'railgun-session-worker': [
      'src/main/wallet/railgun-account-public.js',
      'src/main/wallet/railgun-account-store.js',
      'src/main/wallet/railgun-process.js',
      'src/main/wallet/railgun-public-catalog.js',
      'src/main/wallet/railgun-source-ledger.js',
      'src/main/wallet/railgun-txid-runner.js',
      'src/main/wallet/railgun-wallet-catalog.js',
      'src/main/wallet/railgun-wallet-coverage-store.js',
    ],
  });
});

// Execute only the actual qualifier's cleanup block with inert owned-resource
// doubles. This is a cleanup control, not execution of main() or native owners.
function finalCleanup(resources, sticky, failClose = false, owners = {}) {
  const fs = require('fs'),
    vm = require('vm');
  const source = fs.readFileSync(require.resolve('../qualify-railgun-wallet-journal'), 'utf8');
  const ast = require('acorn').parse(source, { ecmaVersion: 'latest' });
  const main = ast.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'main'
  );
  const block = main.body.body.filter((node) => node.type === 'TryStatement').at(-1).finalizer;
  const close = main.body.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'close'
  );
  return vm.runInNewContext(
    '(async () => { ' +
      source.slice(close.start, close.end) +
      ' return (async () => ' +
      source.slice(block.start, block.end) +
      ')(); })()',
    {
      walletJournal: {
        close() {
          if (failClose) throw Error('owner cleanup failed');
        },
      },
      walletSession: undefined,
      publicAccount: undefined,
      catalog: undefined,
      coordinator: undefined,
      source: undefined,
      ledger: undefined,
      session: undefined,
      scope: undefined,
      enrollment: undefined,
      accountIdentity: undefined,
      vault: undefined,
      kohaku: undefined,
      restoreContractRuntime() {},
      contractResources: resources,
      nativeAssertions: sticky,
      ...owners,
    }
  );
}
test.each([false, true])(
  'actual final cleanup cannot hide a sticky hook failure; earlier cleanup throw=%s',
  async (failClose) => {
    jest.resetModules();
    const sticky = require('./railgun-native-assertions'),
      held = gate();
    try {
      sticky.assert.equal('unexpected callback value', 'expected');
    } catch {
      /* Simulated sanitized refusal. */
    }
    const resources = { close: jest.fn(() => held.promise) };
    let settled = false;
    const work = finalCleanup(resources, sticky, failClose).finally(() => {
      settled = true;
    });
    const rejected = expect(work).rejects.toThrow('masked by a production refusal');
    try {
      await new Promise(setImmediate);
      expect(resources.close).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      held.resolve();
      await rejected;
    }
  }
);

test('rejected first barrier still closes the second owner before meter drainage and refuses', async () => {
  jest.resetModules();
  const sticky = require('./railgun-native-assertions');
  const worker = gate();
  const failure = Error('first wallet barrier rejected');
  const walletSession = { close: jest.fn(), closed: Promise.reject(failure) };
  const session = { close: jest.fn(() => worker.resolve()), closed: worker.promise };
  const publicAccount = {
    close: jest.fn(() => {
      throw Error('public owner close failed');
    }),
  };
  const resources = { close: jest.fn(() => worker.promise) };
  const work = finalCleanup(resources, sticky, false, { walletSession, publicAccount, session });
  // The timeout is a test watchdog only; production must retain unknown drains.
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('cleanup stranded second worker')), 1000);
  });
  try {
    await expect(Promise.race([work, watchdog])).rejects.toThrow('masked by a production refusal');
    expect(walletSession.close).toHaveBeenCalledTimes(1);
    expect(publicAccount.close).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(resources.close).toHaveBeenCalledTimes(1);
    expect(sticky.report().map(({ label }) => label)).toEqual([
      'wallet-journal.walletSession.closed',
      'wallet-journal.publicAccount.close',
    ]);
  } finally {
    clearTimeout(timer);
    worker.resolve();
    await work.catch(() => {});
  }
});

test('throwing public owner still closes ledger/session and awaits both actual barriers', async () => {
  jest.resetModules();
  const sticky = require('./railgun-native-assertions');
  const left = gate(),
    right = gate();
  const failure = Error('public close rejected');
  const publicAccount = {
    close: jest.fn(() => {
      throw failure;
    }),
  };
  const ledger = { close: jest.fn(), closed: left.promise };
  const session = { close: jest.fn(), closed: right.promise };
  const resources = { close: jest.fn() };
  let settled = false;
  const work = finalCleanup(resources, sticky, false, { publicAccount, ledger, session }).finally(
    () => {
      settled = true;
    }
  );
  const rejected = expect(work).rejects.toThrow('masked by a production refusal');
  try {
    await new Promise(setImmediate);
    expect(ledger.close).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(resources.close).not.toHaveBeenCalled();
    left.resolve();
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    expect(resources.close).not.toHaveBeenCalled();
    right.resolve();
    await rejected;
    expect(resources.close).toHaveBeenCalledTimes(1);
  } finally {
    left.resolve();
    right.resolve();
    await rejected;
  }
});

function integrationCleanup(lane, context) {
  const fs = require('fs'),
    vm = require('vm');
  const file =
    lane === 'private' ? './railgun-kohaku-integration' : './railgun-kohaku-public-integration';
  const source = fs.readFileSync(require.resolve(file), 'utf8');
  const ast = require('acorn').parse(source, { ecmaVersion: 'latest' });
  const blocks = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'TryStatement' &&
      node.finalizer &&
      source.slice(node.finalizer.start, node.finalizer.end).includes('plugins.map')
    )
      blocks.push(node.finalizer);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  const bounded = ast.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'bounded'
  );
  return vm.runInNewContext(
    (bounded ? source.slice(bounded.start, bounded.end) : '') +
      '\n(async () => ' +
      source.slice(block.start, block.end) +
      ')()',
    {
      setTimeout,
      clearTimeout,
      nativeAssertions: require('./railgun-native-assertions'),
      ...context,
    }
  );
}

test.each(['private', 'public'])(
  'actual %s helper closes sibling owners/tasks and observer after first plugin throws',
  async (lane) => {
    jest.resetModules();
    const worker = gate(),
      pluginDrain = gate();
    const failure = Error('first plugin close failed');
    const first = {
      close: jest.fn(() => {
        throw failure;
      }),
      closed: Promise.resolve(),
    };
    const second = { close: jest.fn(), closed: pluginDrain.promise };
    const task = { close: jest.fn(() => worker.resolve()), closed: worker.promise };
    const account = {
      close: jest.fn(() => {
        if (lane === 'public') worker.resolve();
      }),
    };
    const txid = { close: jest.fn() },
      preflight = { close: jest.fn() },
      service = { close: jest.fn() };
    const settlements = { close: jest.fn(() => worker.promise) };
    const release = jest.fn(),
      abort = jest.fn(),
      observeKeys = jest.fn();
    const work = integrationCleanup(lane, {
      reviewGates: [{ release: { resolve: release } }],
      gates: [{ release: { resolve: release } }],
      signalController: { abort },
      plugins: [first, second],
      adapterHosts: [],
      seedTask: task,
      txid,
      preflightSources: [preflight],
      serviceInstances: [service],
      preparingAccount: account,
      account,
      accounts: [account],
      tasks: [worker.promise],
      observeKeys,
      sendObserver: undefined,
      poi: {},
      preflight: {},
      services: {},
      signerModule: {},
      identities: {},
      processHost: {},
      saved: { poi: {}, preflight: {}, service: () => {}, signer: () => {} },
      genuineSigner() {},
      originalViewing() {},
      originalStart() {},
      settlements,
    });
    const rejected = expect(work).rejects.toThrow('masked by a production refusal');
    try {
      await new Promise(setImmediate);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(second.close).toHaveBeenCalledTimes(1);
      expect(account.close).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalledTimes(1);
      expect(settlements.close).not.toHaveBeenCalled();
      pluginDrain.resolve();
      // Worker resolves only from its owner close above; no external release.
      let timer;
      try {
        await Promise.race([
          rejected,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('owner skipped worker close')), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      expect(account.close).toHaveBeenCalled();
      if (lane === 'private') {
        expect(task.close).toHaveBeenCalledTimes(1);
        expect(txid.close).toHaveBeenCalledTimes(1);
        expect(preflight.close).toHaveBeenCalledTimes(1);
        expect(service.close).toHaveBeenCalledTimes(1);
      }
      expect(settlements.close).toHaveBeenCalledTimes(1);
      expect(observeKeys).toHaveBeenCalledWith(null);
    } finally {
      // Emergency cleanup after a failing control cannot make its assertions pass.
      task.close();
      pluginDrain.resolve();
      await work.catch(() => {});
    }
  }
);

test('healthy wallet and public owner barriers preserve dependency order through final scope/vault cleanup', async () => {
  jest.resetModules();
  const sticky = require('./railgun-native-assertions');
  const walletDone = gate(),
    publicDone = gate(),
    ledgerDone = gate(),
    sessionDone = gate();
  const calls = [];
  const owner = (label, result) => ({
    close: jest.fn(() => {
      calls.push(label);
      return result;
    }),
  });
  const publicAccount = owner('public', publicDone.promise);
  const coordinator = owner('coordinator'),
    source = owner('source');
  const ledger = { ...owner('ledger'), closed: ledgerDone.promise };
  const session = { ...owner('session'), closed: sessionDone.promise };
  const scope = {
    close: jest.fn(() => {
      calls.push('scope');
      sessionDone.resolve();
    }),
  };
  const vault = { lockVault: jest.fn(() => calls.push('vault')) };
  const resources = { close: jest.fn(() => calls.push('meter')) };
  const work = finalCleanup(resources, sticky, false, {
    walletSession: { ...owner('wallet'), closed: walletDone.promise },
    publicAccount,
    coordinator,
    source,
    ledger,
    session,
    scope,
    vault,
    kohaku: owner('kohaku'),
  });
  try {
    await new Promise(setImmediate);
    expect(calls).toEqual(['wallet']);
    walletDone.resolve();
    await new Promise(setImmediate);
    expect(calls).toEqual(['wallet', 'public']);
    publicDone.resolve();
    await new Promise(setImmediate);
    expect(calls).toEqual([
      'wallet',
      'public',
      'coordinator',
      'source',
      'ledger',
      'session',
      'scope',
    ]);
    expect(scope.close).toHaveBeenCalledTimes(1);
    expect(vault.lockVault).not.toHaveBeenCalled();
    // Session drainage is released only by scope.close, while ledger drainage
    // remains genuinely held. Neither barrier is replaced with a fake success.
    ledgerDone.resolve();
    await work;
    expect(calls).toEqual([
      'wallet',
      'public',
      'coordinator',
      'source',
      'ledger',
      'session',
      'scope',
      'vault',
      'kohaku',
      'meter',
    ]);
  } finally {
    walletDone.resolve();
    publicDone.resolve();
    ledgerDone.resolve();
    sessionDone.resolve();
    await work;
  }
});

test('never-settling actual resource barrier produces bounded sticky failure without claimed settlement', async () => {
  jest.resetModules();
  jest.useFakeTimers();
  const held = gate();
  const runtime = { startRailgunProcess: jest.fn(() => ({ closed: held.promise })) };
  const session = {
    startRailgunSessionWorker: jest.fn(),
    startRailgunReadOnlySessionWorker: jest.fn(),
  };
  jest.doMock(wallet + 'railgun-process', () => runtime);
  jest.doMock(wallet + 'railgun-session-worker', () => session);
  const meter = require('./railgun-kohaku-contract-observer').installResourceMeter();
  runtime.startRailgunProcess({});
  const close = meter.close();
  const rejected = expect(close).rejects.toThrow('resource-drain-timeout');
  try {
    await jest.advanceTimersByTimeAsync(149999);
    expect(meter.snapshot().utilitySettlements).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    await rejected;
    expect(meter.snapshot().utilitySettlements).toBe(0);
    const sticky = require('./railgun-native-assertions');
    expect(sticky.report()).toEqual([
      { label: 'kohaku-contract.resources.resource-drain-timeout', name: 'Error' },
    ]);
    expect(() => sticky.assertEmpty()).toThrow('masked by a production refusal');
    expect(meter.close()).toBe(close);
  } finally {
    held.resolve();
    await Promise.resolve();
    jest.useRealTimers();
  }
});

function publicAcknowledged() {
  return {
    hash,
    nonce: 0,
    from: '0x' + 'ab'.repeat(20),
    to: '0x' + 'cd'.repeat(20),
    value: '1000',
    chainId: 11155111,
    broadcastSource: 'direct',
    explorerUrl: null,
  };
}
test.each(['acknowledged', 'uncertain', 'refused'])(
  'hidden public %s keeps original error/value identity with distinct genuine token',
  async (outcome) => {
    const result =
      outcome === 'acknowledged'
        ? publicAcknowledged()
        : Object.assign(
            Error('original'),
            outcome === 'uncertain'
              ? {
                  code: 'PRIVATE_BROADCAST_UNCERTAIN',
                  transactionHash: hash,
                  submissionStatus: 'unknown',
                }
              : { code: 'RAILGUN_KOHAKU_REFUSED' }
          );
    const state = setup('public', () =>
      outcome === 'acknowledged' ? Promise.resolve(result) : Promise.reject(result)
    );
    const token = Object.freeze({ __type: 'publicOperation' });
    const checked = state.observer.beginHiddenPublic(token, () =>
      state.adapter(state.operation).then((v) => v)
    );
    expect(
      await checked.assert({
        outcome,
        ...(outcome === 'refused' ? {} : { hash }),
        requestedAmount: '1000',
      })
    ).toMatchObject({
      status: outcome === 'acknowledged' ? 'fulfilled' : 'rejected',
      originalValueOrErrorIdentity: true,
      genuinePublicFacadeTokenDistinct: true,
    });
    expect(state.facade.assertRailgunKohakuPublicPlugin).toHaveBeenLastCalledWith(state.instance);
    expect(state.observer.report()).toMatchObject({ delegateCalls: 1, checkedCalls: 1 });
    await state.observer.close();
  }
);
test.each(['copy', 'void', 'schema', 'wrong-value'])(
  'hidden public detects %s settlement mutation',
  async (kind) => {
    const result = publicAcknowledged();
    if (kind === 'schema') result.nonce = '0';
    if (kind === 'wrong-value') result.value = '1001';
    const state = setup('public', () => Promise.resolve(result));
    const checked = state.observer.beginHiddenPublic(
      Object.freeze({ __type: 'publicOperation' }),
      () =>
        state
          .adapter(state.operation)
          .then((v) => (kind === 'copy' ? { ...v } : kind === 'void' ? undefined : v))
    );
    await expect(
      checked.assert({ outcome: 'acknowledged', hash, requestedAmount: '1000' })
    ).rejects.toThrow();
    await expect(state.observer.close()).rejects.toThrow();
  }
);
test('hidden public original rejection cannot be fulfilled as a private union', async () => {
  const error = Object.assign(Error('unknown'), {
    code: 'PRIVATE_BROADCAST_UNCERTAIN',
    transactionHash: hash,
    submissionStatus: 'unknown',
  });
  const state = setup('public', () => Promise.reject(error));
  const checked = state.observer.beginHiddenPublic(
    Object.freeze({ __type: 'publicOperation' }),
    () =>
      state.adapter(state.operation).catch((reason) => ({
        transactionHash: reason.transactionHash,
        submissionStatus: 'unknown',
      }))
  );
  await expect(checked.assert({ outcome: 'uncertain', hash })).rejects.toThrow();
  await expect(state.observer.close()).rejects.toThrow();
});
test('hidden public refuses exposing the facade token as portable token', async () => {
  const state = setup('public', () => Promise.resolve(publicAcknowledged()));
  expect(() =>
    state.observer.beginHiddenPublic(state.operation, () => state.adapter(state.operation))
  ).toThrow('tokens differ');
  await expect(state.observer.close()).rejects.toThrow();
});
test('hidden public assertion waits for outward settlement, not delegate settlement alone', async () => {
  const held = gate(),
    value = publicAcknowledged(),
    state = setup('public', () => Promise.resolve(value));
  const checked = state.observer.beginHiddenPublic(
    Object.freeze({ __type: 'publicOperation' }),
    () => {
      state.adapter(state.operation);
      return held.promise;
    }
  );
  let checkedDone = false;
  const assertion = checked
    .assert({ outcome: 'acknowledged', hash, requestedAmount: '1000' })
    .then(() => {
      checkedDone = true;
    });
  await Promise.resolve();
  await Promise.resolve();
  expect(checkedDone).toBe(false);
  held.resolve(value);
  await assertion;
  await state.observer.close();
});
