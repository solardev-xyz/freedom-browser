let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mock.enrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (value) => {
    if (value !== mock.identity || value.signal.aborted) throw Error('private identity detail');
    return value.descriptor;
  },
}));
jest.mock('./railgun-account-wallet', () => ({
  reserveRailgunAccountWalletHandoff: (account, owners) => {
    if (
      !mock.accounts.has(account) ||
      account.signal.aborted ||
      owners.enrollment !== mock.enrollment
    )
      throw Error('private account handoff');
    return mock.phases.get(account)?.reserveHandoff() || { release: jest.fn() };
  },
  readRailgunAccountOwnedNotes: (account, owners) => {
    if (
      !mock.accounts.has(account) ||
      account.signal.aborted ||
      owners.identity !== mock.identity ||
      owners.enrollment !== mock.enrollment ||
      owners.coordinator !== mock.coordinator
    )
      throw Error('private account detail');
    return mock.owned;
  },
}));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (coordinator, enrollment) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      coordinator.signal.aborted
    )
      throw Error('public owner');
    return mock.publicIdentity;
  },
  getRailgunAccountPublicDestination: () => {
    mock.sourceReads++;
    return mock.destination;
  },
  assertRailgunAccountPublicDestination: (_c, _e, value) => {
    if (value !== mock.destination) throw Error('source replaced');
    return value;
  },
}));
jest.mock('./railgun-transact-staging', () => ({
  stageRailgunTransactInput: (...args) => mock.stage(...args),
}));
jest.mock('./railgun-private-operation', () => ({
  proveRailgunAccountPrivateOperation: (...args) => mock.prove(...args),
}));
jest.mock('./railgun-private-submission', () => ({
  submitRailgunPrivateTransaction: (...args) => mock.submit(...args),
}));
jest.mock('../identity-manager', () => ({
  WALLET_TYPES: { MNEMONIC: 'mnemonic' },
  getWalletRecord: (index) => {
    if (index !== 0) throw Error('index');
    return mock.walletRecord;
  },
}));
jest.mock('./railgun-shield-operation', () => ({
  openRailgunShieldOperation: (...args) => mock.openShield(...args),
}));
jest.mock('./signers', () => ({
  getSigner: (index) => {
    if (index !== 0) throw Error('signer index');
    return mock.getSigner();
  },
}));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({ access: { readOrder: ['direct'] } }),
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: mock.rpcUrl } }],
  getEndpoints: () => [mock.rpcUrl],
}));
jest.mock('../networks/private-rpc', () => ({
  createPrivateRpc: (handle, role) => {
    require('../networks/privacy-context').getPrivacyContext(handle);
    mock.events.push('preview-client');
    const client = {};
    mock.clients.set(client, { handle, observation: Object.freeze({}), url: mock.rpcUrl, role });
    return client;
  },
  createPrivateRpcDestinationConstraint: ({ observation, signal, deadline }) => {
    if (!mock.details.has(observation)) throw Error('forged destination');
    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort(), { once: true });
    const result = Object.freeze({
      constraint: Object.freeze({}),
      signal: controller.signal,
      close: jest.fn(() => controller.abort()),
    });
    mock.constraints.push({ result, observation, deadline });
    return result;
  },
  getPrivateRpcDestination: (client, handle) => {
    const value = mock.clients.get(client);
    if (!value || value.handle !== handle) throw Error('wrong client');
    mock.details.set(value.observation, value);
    return value.observation;
  },
  getPrivateRpcDestinationDetails: (observation) => {
    if (observation === mock.destination) return { url: mock.sourceUrl };
    const value = mock.details.get(observation);
    if (!value) throw Error('forged destination');
    require('../networks/privacy-context').getPrivacyContext(value.handle);
    return { url: value.url };
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const {
  createRailgunKohakuPlugin,
  assertRailgunKohakuPublicPlugin,
  submitRailgunKohakuPublicOperation,
} = require('./railgun-kohaku-plugin');
const { createRailgunKohakuBroadcaster } = require('./railgun-kohaku-broadcaster');
const pins = require('./railgun-shield-pins.json');
const refusal = { code: 'RAILGUN_KOHAKU_REFUSED', message: 'Railgun Kohaku operation unavailable' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
let sequence = 0,
  scope,
  options,
  plugins,
  account,
  caller;
function makeAccount() {
  const controller = new AbortController();
  const value = {
    signal: controller.signal,
    generationId: 'wallet-generation',
    view: {
      instanceId: jest.fn(async () => mock.owned.read.instanceId),
      balance: jest.fn(async () => [
        { asset: mock.owned.read.received[0].asset, amount: 123n, tag: 'unverified' },
      ]),
      notes: jest.fn(async () => mock.owned.read.received),
    },
    close: jest.fn(() => {
      mock.events.push('account-close');
      controller.abort();
      return Promise.resolve();
    }),
  };
  mock.accounts.add(value);
  return value;
}
function create(overrides = {}) {
  const plugin = createRailgunKohakuPlugin({ ...options, ...overrides });
  plugins.push(plugin);
  return plugin;
}
function amount() {
  return { asset: { __type: 'erc20', contract: pins.wrappedNative }, amount: 123n, noteId: '0:1' };
}
function completion() {
  const controller = new AbortController();
  return {
    receipt: Object.freeze({}),
    signal: controller.signal,
    close: jest.fn(() => controller.abort()),
  };
}
function shieldController({ holdDrain = false } = {}) {
  const controller = new AbortController(),
    drain = deferred();
  const value = {
    signal: controller.signal,
    closed: drain.promise,
    close: jest.fn(() => {
      controller.abort();
      if (!holdDrain) drain.resolve();
    }),
    release: () => drain.resolve(),
    submit: jest.fn(async (args) => {
      try {
        return await mock.shieldSubmit(args);
      } finally {
        value.close();
      }
    }),
  };
  return value;
}
function publicPlugin(overrides = {}) {
  const { proverArchive: _prover, artifactDirectory: _artifacts, ...base } = options;
  const plugin = createRailgunKohakuPlugin({ ...base, mode: 'public', ...overrides });
  plugins.push(plugin);
  return plugin;
}
function nativeAmount(value = 100000000000000n) {
  return { asset: { __type: 'native' }, amount: value };
}
beforeEach(() => {
  mock = {
    events: [],
    sourceReads: 0,
    accounts: new WeakSet(),
    phases: new WeakMap(),
    clients: new WeakMap(),
    details: new WeakMap(),
    constraints: [],
    destination: Object.freeze({}),
    publicIdentity: { generationId: 'public', sourceId: 'source', publicId: 'store' },
    rpcUrl: 'https://rpc.example.test/exact-path',
    sourceUrl: 'https://retained.example.test/source-path',
    owned: {
      checkpointHash: 'a'.repeat(64),
      read: {
        instanceId: '0zk-self',
        received: [
          {
            id: '0:1',
            tree: 0,
            position: 1,
            hash: 'b'.repeat(64),
            txid: 'c'.repeat(64),
            spentTxid: false,
            amount: 123n,
            asset: { __type: 'erc20', contract: pins.wrappedNative },
          },
        ],
      },
      ownedPoi: [
        {
          id: '0:1',
          type: 'Shield',
          tree: 0,
          position: 1,
          hash: 'b'.repeat(64),
          txid: 'c'.repeat(64),
        },
      ],
    },
  };
  caller = new AbortController();
  scope = createPrivacyScope({ profileId: 'kohaku-test', signal: new AbortController().signal });
  const descriptor = { walletId: 'wallet', instanceId: '0zk-self' };
  mock.identity = { descriptor, signal: scope.signal };
  mock.coordinator = { signal: scope.signal };
  mock.enrollment = {
    descriptor,
    signal: scope.signal,
    directory: '/synthetic/kohaku-' + ++sequence,
    getContext: (role) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
      }),
  };
  account = makeAccount();
  mock.getAddress = jest.fn(async () => '0x' + '1'.repeat(40));
  mock.getSigner = jest.fn(() => ({
    getAddress: () => mock.getAddress(),
    signTransaction: jest.fn(),
  }));
  mock.walletRecord = { index: 0, type: 'mnemonic', address: '0x' + '1'.repeat(40) };
  mock.shieldSubmit = jest.fn(async ({ review }) => {
    const approved = await review({ operation: 'railgun-native-shield' });
    if (!approved) throw Error('Shield review refused');
    return Object.freeze({ hash: '0x' + '8'.repeat(64) });
  });
  mock.openShield = jest.fn(async () => {
    const phase = claimRailgunAccountPhase(mock.enrollment, 'recovery');
    phase.release();
    mock.shield = shieldController();
    return mock.shield;
  });
  mock.stage = jest.fn(async ({ account: old }) => {
    mock.events.push('stage');
    await old.close();
    const stagedController = new AbortController();
    mock.replacement = makeAccount();
    mock.staged = {
      status: 'staged',
      account: mock.replacement,
      receipt: Object.freeze({}),
      signal: stagedController.signal,
      close: jest.fn(() => stagedController.abort()),
    };
    return mock.staged;
  });
  mock.prove = jest.fn(async () => {
    mock.events.push('prove');
    mock.completion = completion();
    return { status: 'proved', completion: mock.completion, holdId: 'private-hold' };
  });
  mock.submit = jest.fn(async ({ review }) => {
    mock.events.push('submit');
    const approved = await review(
      Object.freeze({ operation: 'private-transfer', transaction: { opaque: 'review-only' } })
    );
    return Object.freeze(
      approved
        ? { status: 'submitted', hash: '0x' + 'd'.repeat(64) }
        : { status: 'recovery-required', stage: 'review' }
    );
  });
  options = {
    account,
    owners: { identity: mock.identity, enrollment: mock.enrollment, coordinator: mock.coordinator },
    signal: caller.signal,
    mode: 'private',
    archive: '/synthetic/engine.asar',
    proverArchive: '/synthetic/prover.asar',
    artifactDirectory: '/synthetic/artifacts',
    gasLimit: 500000n,
    maxGasFee: 1000000000000n,
    reviewPreparation: jest.fn(async () => {
      mock.events.push('preparation-review');
      return true;
    }),
    reviewTransaction: jest.fn(async () => {
      mock.events.push('transaction-review');
      return true;
    }),
  };
  plugins = [];
});
afterEach(async () => {
  plugins.forEach((plugin) => plugin.close());
  scope.close();
  await tick();
  jest.restoreAllMocks();
});

test('read capability has no preparation/broadcaster and reads only current genuine view', async () => {
  const plugin = createRailgunKohakuPlugin({
    account,
    owners: options.owners,
    signal: caller.signal,
  });
  plugins.push(plugin);
  expect(Object.keys(plugin).sort()).toEqual(
    ['balance', 'close', 'closed', 'instanceId', 'notes', 'signal', 'status'].sort()
  );
  expect(await plugin.instanceId()).toBe('0zk-self');
  expect((await plugin.balance())[0].tag).toBe('unverified');
  expect(await plugin.notes()).toBe(mock.owned.read.received);
  account.view.instanceId = jest.fn(async () => 'current-view');
  expect(await plugin.instanceId()).toBe('current-view');
  expect(() => createRailgunKohakuBroadcaster(plugin)).toThrow(refusal.message);
  expect(mock.events).toEqual([]);
});
test('private capability selects only current single-input transfer/full-unshield methods', async () => {
  const plugin = create();
  expect(Object.keys(plugin).sort()).toEqual(
    [
      'balance',
      'close',
      'closed',
      'instanceId',
      'notes',
      'signal',
      'status',
      'prepareTransfer',
      'prepareUnshield',
    ].sort()
  );
  for (const method of [
    'prepareShield',
    'prepareShieldMulti',
    'prepareTransferMulti',
    'prepareUnshieldMulti',
    'restore',
    'sendTransaction',
  ])
    expect(plugin[method]).toBeUndefined();
});
test.each([
  ['account', {}],
  ['owners', {}],
  ['signal', null],
  ['mode', 'all'],
  ['archive', 'relative'],
  ['reviewPreparation', true],
  ['reviewTransaction', undefined],
  ['gasLimit', 0n],
  ['gasLimit', 3000001n],
  ['maxGasFee', 2000000000000001n],
])('invalid constructor %s refuses before adoption', (key, value) => {
  expect(() => create({ [key]: value })).toThrow(refusal.message);
  expect(account.close).not.toHaveBeenCalled();
  const valid = create();
  valid.close();
});
test('two instances cannot own the same genuine account or enrollment directory', async () => {
  const plugin = create();
  expect(() => create()).toThrow(refusal.message);
  expect(() => create({ account: makeAccount() })).toThrow(refusal.message);
  plugin.close();
  await plugin.closed;
  const next = create({ account: makeAccount() });
  expect(next.signal.aborted).toBe(false);
  plugin.close();
  expect(() => create({ account: makeAccount() })).toThrow(refusal.message);
});
test('review describes exact configured and retained destinations and both selected disclosures before proving', async () => {
  const plugin = create();
  const op = await plugin.prepareTransfer(amount(), '0zk-self');
  expect(mock.events).toEqual(['preview-client', 'preview-client', 'preparation-review', 'prove']);
  const [summary, lifetime] = options.reviewPreparation.mock.calls[0];
  expect(summary.destinations).toEqual({
    retainedSource: mock.sourceUrl,
    protocolRpc: mock.rpcUrl,
    transactionRpc: mock.rpcUrl,
    txid: null,
    poi: 'https://ppoi.fdi.network',
  });
  expect(summary.exposures.poi).toContain('selected-blinded-commitment');
  expect(summary.exposures.privatePreflight).toContain('selected-nullifier');
  expect(summary.exposures.transactionRpc).toEqual(
    expect.arrayContaining([
      'proved-calldata',
      'recipient',
      'nullifier',
      'eth_estimateGas',
      'eth_call',
    ])
  );
  expect(summary.broadcastSimulationBeforeTransactionReview).toBe(true);
  expect(summary.selection).toEqual({
    noteId: '0:1',
    tree: 0,
    position: 1,
    checkpointHash: 'a'.repeat(64),
    walletGenerationId: 'wallet-generation',
    publicGenerationId: 'public',
  });
  expect(Object.isFrozen(summary.selection)).toBe(true);
  expect(summary.privateSigning).toBe(true);
  expect(summary.broadcastsTransaction).toBe(false);
  expect(summary.rpcAdmissionDestinationPinned).toBe(true);
  expect(lifetime.signal).toBe(plugin.signal);
  expect(Object.isFrozen(summary.exposures.poi)).toBe(true);
  expect(op).toEqual({ __type: 'privateOperation' });
  expect(Object.keys(op)).toEqual(['__type']);
  expect(Object.isFrozen(op)).toBe(true);
  expect(mock.submit).not.toHaveBeenCalled();
});
test.each([false, undefined, 1, { approved: true }])(
  'only exact true review permits follow-on work (%p)',
  async (response) => {
    options.reviewPreparation.mockResolvedValue(response);
    const plugin = create();
    await expect(plugin.prepareTransfer(amount(), '0zk-self')).rejects.toMatchObject(refusal);
    expect(mock.stage).not.toHaveBeenCalled();
    expect(mock.prove).not.toHaveBeenCalled();
    expect(mock.submit).not.toHaveBeenCalled();
    expect(plugin.status().state).toBe('ready');
    expect(account.close).not.toHaveBeenCalled();
  }
);
test('throwing review is sanitized and does no proving/signing', async () => {
  options.reviewPreparation.mockRejectedValue(Error('SECRET URL/private note'));
  const plugin = create();
  await expect(plugin.prepareTransfer(amount(), '0zk-self')).rejects.toMatchObject(refusal);
  expect(mock.prove).not.toHaveBeenCalled();
});
test('late approved review after close drains callback and retains ownership with zero follow-on work', async () => {
  const gate = deferred();
  options.reviewPreparation.mockReturnValue(gate.promise);
  const plugin = create();
  const work = plugin.prepareTransfer(amount(), '0zk-self');
  await tick();
  plugin.close();
  let drained = false;
  plugin.closed.then(() => {
    drained = true;
  });
  await tick();
  expect(drained).toBe(false);
  expect(() => create({ account: makeAccount() })).toThrow(refusal.message);
  gate.resolve(true);
  await expect(work).rejects.toMatchObject(refusal);
  await plugin.closed;
  expect(mock.prove).not.toHaveBeenCalled();
});
test('review monotonic timeout refuses late true even before timer dispatch', async () => {
  const original = performance.now();
  const clock = jest.spyOn(performance, 'now').mockReturnValue(original);
  options.reviewPreparation.mockImplementation(async () => {
    clock.mockReturnValue(original + 30000);
    return true;
  });
  const plugin = create();
  await expect(plugin.prepareTransfer(amount(), '0zk-self')).rejects.toMatchObject(refusal);
  expect(mock.prove).not.toHaveBeenCalled();
});
test.each(['destination', 'configuration', 'note', 'checkpoint', 'generation'])(
  'review-time %s drift refuses before stage/proof',
  async (change) => {
    options.reviewPreparation.mockImplementation(async () => {
      if (change === 'destination') mock.destination = {};
      if (change === 'configuration') mock.rpcUrl = 'https://other.example.test';
      if (change === 'note') mock.owned.read.received[0].hash = 'e'.repeat(64);
      if (change === 'checkpoint') mock.owned.checkpointHash = 'f'.repeat(64);
      if (change === 'generation') mock.publicIdentity.generationId = 'changed';
      return true;
    });
    const plugin = create();
    await expect(plugin.prepareTransfer(amount(), '0zk-self')).rejects.toMatchObject(refusal);
    expect(mock.stage).not.toHaveBeenCalled();
    expect(mock.prove).not.toHaveBeenCalled();
  }
);
test.each([
  (a) => {
    a.amount = 122n;
  },
  (a) => {
    a.amount = 124n;
  },
  (a) => {
    a.amount = '123';
  },
  (a) => {
    a.asset.__type = 'native';
  },
  (a) => {
    a.asset.contract = '0x' + '2'.repeat(40);
  },
  (a) => {
    a.noteId = '0:2';
  },
  (a) => {
    a.noteId = '00:1';
  },
  (a) => {
    a.permission = true;
  },
  (a) => {
    a.asset.tokenId = 0n;
  },
])('invalid asset/note/full-amount request refuses without review or work', async (mutate) => {
  const a = amount();
  mutate(a);
  const plugin = create();
  await expect(plugin.prepareTransfer(a, '0zk-self')).rejects.toMatchObject(refusal);
  expect(options.reviewPreparation).not.toHaveBeenCalled();
  expect(mock.prove).not.toHaveBeenCalled();
});
test('accessors and proxies in caller amount are rejected without running traps', async () => {
  const plugin = create(),
    getter = jest.fn(),
    trap = jest.fn();
  const a = amount();
  Object.defineProperty(a, 'amount', { get: getter });
  await expect(plugin.prepareTransfer(a, '0zk-self')).rejects.toMatchObject(refusal);
  await expect(
    plugin.prepareTransfer(new Proxy(amount(), { getPrototypeOf: trap }), '0zk-self')
  ).rejects.toMatchObject(refusal);
  expect(getter).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});
test.each([1n, 122n])(
  'partial withdrawal %s stays unavailable through the facade before review or work',
  async (value) => {
    const plugin = create();
    await expect(
      plugin.prepareUnshield({ ...amount(), amount: value }, '0x' + '1'.repeat(40))
    ).rejects.toMatchObject(refusal);
    expect(options.reviewPreparation).not.toHaveBeenCalled();
    expect(mock.stage).not.toHaveBeenCalled();
    expect(mock.prove).not.toHaveBeenCalled();
    expect(mock.submit).not.toHaveBeenCalled();
  }
);
test('internal controller has only the reviewed application importers and one proving caller', () => {
  const fs = require('fs'),
    path = require('path');
  const base = path.resolve(__dirname, '../..');
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(filename);
    }
  };
  for (const name of ['main', 'renderer', 'shared']) visit(path.join(base, name));
  const importers = [],
    callers = [];
  for (const filename of files) {
    if (filename === path.join(__dirname, 'railgun-private-operation.js')) continue;
    const text = fs.readFileSync(filename, 'utf8');
    const relative = path.relative(base, filename);
    if (text.includes('railgun-private-operation')) importers.push(relative);
    if (text.includes('proveRailgunAccountPrivateOperation')) callers.push(relative);
  }
  expect(importers.sort()).toEqual([
    'main/wallet/railgun-identity.js',
    'main/wallet/railgun-kohaku-plugin.js',
    'main/wallet/railgun-private-submission.js',
  ]);
  expect(callers).toEqual(['main/wallet/railgun-kohaku-plugin.js']);
});
test('no foreign recipient or tailCalls callback', async () => {
  const plugin = create(),
    tailCalls = jest.fn();
  await expect(plugin.prepareTransfer(amount(), '0zk-foreign')).rejects.toMatchObject(refusal);
  await expect(plugin.prepareUnshield(amount(), '0x' + '2'.repeat(40))).rejects.toMatchObject(
    refusal
  );
  await expect(
    plugin.prepareUnshield(amount(), '0x' + '1'.repeat(40), { tailCalls })
  ).rejects.toMatchObject(refusal);
  expect(tailCalls).not.toHaveBeenCalled();
  expect(options.reviewPreparation).not.toHaveBeenCalled();
});
test('whole unshield binds the genuine submitter and supported kind', async () => {
  const plugin = create();
  await plugin.prepareUnshield(amount(), '0x' + '1'.repeat(40), {});
  expect(mock.prove.mock.calls[0][0].request).toEqual({
    kind: 'railgun-token-unshield',
    noteId: '0:1',
    recipient: '0x' + '1'.repeat(40),
  });
});
test('caller mutation after admission cannot change review amount or request', async () => {
  const gate = deferred();
  mock.getAddress.mockReturnValue(gate.promise);
  const plugin = create(),
    a = amount();
  const pending = plugin.prepareTransfer(a, '0zk-self');
  a.amount = 999n;
  a.noteId = '0:2';
  gate.resolve('0x' + '1'.repeat(40));
  await pending;
  expect(options.reviewPreparation.mock.calls[0][0].amount).toBe('123');
  expect(mock.prove.mock.calls[0][0].request.noteId).toBe('0:1');
});
test('Transact staging adopts replacement and old account abort does not abort instance', async () => {
  mock.owned.ownedPoi[0].type = 'Transact';
  const plugin = create();
  const op = await plugin.prepareTransfer(amount(), '0zk-self');
  expect(plugin.signal.aborted).toBe(false);
  expect(mock.stage).toHaveBeenCalledTimes(1);
  expect(mock.prove.mock.calls[0][0].account).toBe(mock.replacement);
  expect(mock.prove.mock.calls[0][0].stagingReceipt).toBe(mock.staged.receipt);
  expect(options.reviewPreparation.mock.calls[0][0].exposures.txid).toContain(
    'txid-tree-index-root'
  );
  expect(await plugin.instanceId()).toBe('0zk-self');
  expect(mock.replacement.view.instanceId).toHaveBeenCalledTimes(1);
  expect(mock.staged.signal.aborted).toBe(true);
  expect(mock.completion.signal.aborted).toBe(false);
  expect((await createRailgunKohakuBroadcaster(plugin).broadcast(op)).status).toBe('submitted');
});
test('late staged replacement after cancellation is closed and never proved', async () => {
  mock.owned.ownedPoi[0].type = 'Transact';
  const gate = deferred();
  mock.stage.mockImplementation(async () => gate.promise);
  const plugin = create(),
    work = plugin.prepareTransfer(amount(), '0zk-self');
  await tick();
  caller.abort();
  const replacement = makeAccount(),
    staged = { status: 'staged', account: replacement, receipt: {}, close: jest.fn() };
  gate.resolve(staged);
  await expect(work).rejects.toMatchObject(refusal);
  await plugin.closed;
  expect(replacement.close).toHaveBeenCalled();
  expect(staged.close).toHaveBeenCalled();
  expect(mock.prove).not.toHaveBeenCalled();
});
test('staging unusable-old-account refusal never falls back to old handle', async () => {
  mock.owned.ownedPoi[0].type = 'Transact';
  mock.stage.mockResolvedValue({
    status: 'refused',
    originalAccountReusable: false,
    stage: 'txid',
  });
  const plugin = create();
  await expect(plugin.prepareTransfer(amount(), '0zk-self')).rejects.toMatchObject(refusal);
  await plugin.closed;
  expect(mock.prove).not.toHaveBeenCalled();
  await expect(plugin.instanceId()).rejects.toMatchObject(refusal);
});
test('busy preparation admission cannot revoke or replace first request', async () => {
  const gate = deferred();
  options.reviewPreparation.mockReturnValue(gate.promise);
  const plugin = create(),
    work = plugin.prepareTransfer(amount(), '0zk-self');
  await expect(plugin.prepareUnshield(amount(), '0x' + '1'.repeat(40))).rejects.toMatchObject(
    refusal
  );
  gate.resolve(true);
  await work;
  expect(mock.prove).toHaveBeenCalledTimes(1);
  expect(plugin.signal.aborted).toBe(false);
  await expect(plugin.prepareTransfer(amount(), '0zk-self')).rejects.toMatchObject(refusal);
});
test('late proved completion after cancel is revoked and durable hold requires recovery', async () => {
  const gate = deferred();
  mock.prove.mockReturnValue(gate.promise);
  const plugin = create(),
    work = plugin.prepareTransfer(amount(), '0zk-self');
  await tick();
  plugin.close();
  const completed = completion();
  gate.resolve({ status: 'proved', completion: completed });
  await expect(work).rejects.toMatchObject(refusal);
  await plugin.closed;
  expect(completed.close).toHaveBeenCalled();
  expect(plugin.status().recoveryRequired).toBe(true);
  expect(mock.submit).not.toHaveBeenCalled();
});
test('signed-unfinished is retained as recovery state, never automatically proved again', async () => {
  mock.prove.mockResolvedValue({
    status: 'signed-unfinished',
    stage: 'signing',
    holdId: 'private-hold',
  });
  const plugin = create();
  await expect(plugin.prepareTransfer(amount(), '0zk-self')).rejects.toMatchObject(refusal);
  await plugin.closed;
  expect(plugin.status().recoveryRequired).toBe(true);
  expect(JSON.stringify(plugin.status())).not.toContain('private-hold');
});
test('opaque completion expiration closes instance without submission or hold abandonment', async () => {
  const plugin = create();
  await plugin.prepareTransfer(amount(), '0zk-self');
  mock.completion.close();
  await plugin.closed;
  expect(plugin.status().recoveryRequired).toBe(true);
  expect(mock.submit).not.toHaveBeenCalled();
});
test('broadcaster closes/drains wallet before recovery, consumes once and preserves result', async () => {
  const plugin = create(),
    broadcaster = createRailgunKohakuBroadcaster(plugin);
  const op = await plugin.prepareTransfer(amount(), '0zk-self');
  const gate = deferred();
  account.close.mockImplementation(() => {
    mock.events.push('closing-held');
    return gate.promise;
  });
  const work = broadcaster.broadcast(op);
  await tick();
  expect(mock.submit).not.toHaveBeenCalled();
  await expect(broadcaster.broadcast(op)).rejects.toMatchObject(refusal);
  gate.resolve();
  const result = await work;
  expect(result.status).toBe('submitted');
  await plugin.closed;
  expect(mock.submit.mock.calls[0][0].completion).toBe(mock.completion.receipt);
  expect(mock.events.indexOf('closing-held')).toBeLessThan(mock.events.indexOf('submit'));
  await expect(broadcaster.broadcast(op)).rejects.toMatchObject(refusal);
});
test('forged/copied/public operations cannot consume authentic prepared operation', async () => {
  const plugin = create(),
    broadcaster = createRailgunKohakuBroadcaster(plugin);
  const op = await plugin.prepareTransfer(amount(), '0zk-self');
  for (const bad of [
    {},
    { ...op },
    { __type: 'publicOperation' },
    { __type: 'privateOperation', data: '0x' },
  ])
    await expect(broadcaster.broadcast(bad)).rejects.toMatchObject(refusal);
  expect(mock.submit).not.toHaveBeenCalled();
  expect((await broadcaster.broadcast(op)).status).toBe('submitted');
});
test('cross-instance operation refuses without consuming the other instance', async () => {
  const plugin = create(),
    op = await plugin.prepareTransfer(amount(), '0zk-self');
  const saved = mock.enrollment.directory;
  mock.enrollment.directory = saved + '-second';
  const other = create({ account: makeAccount() });
  mock.enrollment.directory = saved;
  const otherBroadcaster = createRailgunKohakuBroadcaster(other);
  await expect(otherBroadcaster.broadcast(op)).rejects.toMatchObject(refusal);
  expect((await createRailgunKohakuBroadcaster(plugin).broadcast(op)).status).toBe('submitted');
});
test.each(['unknown', 'recovery-required'])(
  'durable %s result passes through unchanged even after cancellation during drain',
  async (status) => {
    const result = Object.freeze({ status, stage: 'transport' });
    mock.submit.mockImplementation(async () => {
      caller.abort();
      return result;
    });
    const plugin = create(),
      broadcaster = createRailgunKohakuBroadcaster(plugin),
      op = await plugin.prepareTransfer(amount(), '0zk-self');
    expect(await broadcaster.broadcast(op)).toBe(result);
    await plugin.closed;
  }
);
test('cancellation while EOA review ignores abort retains owner until review/controller drain', async () => {
  const gate = deferred();
  options.reviewTransaction.mockReturnValue(gate.promise);
  const plugin = create(),
    op = await plugin.prepareTransfer(amount(), '0zk-self');
  const work = createRailgunKohakuBroadcaster(plugin).broadcast(op);
  await tick();
  caller.abort();
  let drained = false;
  plugin.closed.then(() => {
    drained = true;
  });
  await tick();
  expect(drained).toBe(false);
  expect(() => create({ account: makeAccount(), signal: new AbortController().signal })).toThrow(
    refusal.message
  );
  gate.resolve(true);
  expect((await work).status).toBe('recovery-required');
  await plugin.closed;
});
test('throwing account close refuses recovery admission and keeps directory excluded', async () => {
  account.close.mockImplementation(() => {
    throw Error('private close');
  });
  const plugin = create(),
    op = await plugin.prepareTransfer(amount(), '0zk-self');
  expect((await createRailgunKohakuBroadcaster(plugin).broadcast(op)).status).toBe(
    'recovery-required'
  );
  expect(mock.submit).not.toHaveBeenCalled();
  expect(() => create({ account: makeAccount() })).toThrow(refusal.message);
});
test('late local read cannot cross a completed Transact account replacement', async () => {
  mock.owned.ownedPoi[0].type = 'Transact';
  const gate = deferred();
  account.view.notes.mockReturnValue(gate.promise);
  const plugin = create();
  const read = plugin.notes();
  await plugin.prepareTransfer(amount(), '0zk-self');
  gate.resolve([{ stale: true }]);
  await expect(read).rejects.toMatchObject(refusal);
  expect(await plugin.notes()).toBe(mock.owned.read.received);
});
test('late local read cannot cross view replacement on same account', async () => {
  const gate = deferred();
  account.view.notes.mockReturnValue(gate.promise);
  const plugin = create(),
    read = plugin.notes();
  account.view = { ...account.view, notes: jest.fn(async () => []) };
  gate.resolve([{ stale: true }]);
  await expect(read).rejects.toMatchObject(refusal);
});
test('late local read cannot cross public generation change', async () => {
  const gate = deferred();
  account.view.notes.mockReturnValue(gate.promise);
  const plugin = create(),
    read = plugin.notes();
  mock.publicIdentity.generationId = 'replacement';
  gate.resolve([]);
  await expect(read).rejects.toMatchObject(refusal);
});
test('idle close retains ownership while physical account close remains pending', async () => {
  const gate = deferred();
  account.close.mockReturnValue(gate.promise);
  const plugin = create();
  plugin.close();
  expect(plugin.signal.aborted).toBe(true);
  let drained = false;
  plugin.closed.then(() => {
    drained = true;
  });
  await tick();
  expect(drained).toBe(false);
  expect(() => create({ account: makeAccount() })).toThrow(refusal.message);
  gate.resolve();
  await plugin.closed;
  expect(create({ account: makeAccount() }).signal.aborted).toBe(false);
});
test('throwing staged close cannot silently return a prepared operation', async () => {
  mock.owned.ownedPoi[0].type = 'Transact';
  mock.stage.mockImplementation(async () => ({
    status: 'staged',
    account: makeAccount(),
    receipt: {},
    close() {
      throw Error('private cleanup');
    },
  }));
  const plugin = create();
  await expect(plugin.prepareTransfer(amount(), '0zk-self')).rejects.toMatchObject(refusal);
  expect(mock.completion.close).toHaveBeenCalled();
  expect(() => create({ account: makeAccount() })).toThrow(refusal.message);
});
test('changed RPC configuration after preparation refuses without submission and preserves hold', async () => {
  const plugin = create(),
    op = await plugin.prepareTransfer(amount(), '0zk-self');
  mock.rpcUrl = 'https://replacement.example.test';
  expect((await createRailgunKohakuBroadcaster(plugin).broadcast(op)).status).toBe(
    'recovery-required'
  );
  expect(mock.submit).not.toHaveBeenCalled();
  await plugin.closed;
  expect(plugin.status().recoveryRequired).toBe(true);
});
test('caller and identity cancellation before review resolution both stop all follow-on work', async () => {
  const gate = deferred();
  options.reviewPreparation.mockReturnValue(gate.promise);
  const plugin = create(),
    pending = plugin.prepareTransfer(amount(), '0zk-self');
  await tick();
  scope.close();
  gate.resolve(true);
  await expect(pending).rejects.toMatchObject(refusal);
  await plugin.closed;
  expect(mock.prove).not.toHaveBeenCalled();
  expect(mock.stage).not.toHaveBeenCalled();
});
test('separate genuine protocol/public previews and constraints remain live through broadcast', async () => {
  const plugin = create(),
    op = await plugin.prepareTransfer(amount(), '0zk-self');
  expect(mock.constraints).toHaveLength(2);
  const values = mock.constraints.map((entry) => mock.details.get(entry.observation));
  expect(values.map((value) => value.role)).toEqual(['protocol-rpc', 'transaction-rpc']);
  const { getPrivacyContext } = require('../networks/privacy-context');
  expect(getPrivacyContext(values[1].handle).subject).toMatchObject({
    kind: 'public-address',
    principal: '0x' + '1'.repeat(40),
  });
  expect(mock.prove.mock.calls[0][0].destinationConstraints).toEqual({
    protocol: mock.constraints[0].result.constraint,
    transaction: mock.constraints[1].result.constraint,
  });
  for (const { result, deadline } of mock.constraints) {
    expect(result.signal.aborted).toBe(false);
    expect(result.close).not.toHaveBeenCalled();
    expect(deadline - performance.now()).toBeLessThanOrEqual(660000);
  }
  mock.submit.mockImplementation(async () => {
    values.forEach((value) => getPrivacyContext(value.handle));
    return { status: 'submitted' };
  });
  await createRailgunKohakuBroadcaster(plugin).broadcast(op);
  await plugin.closed;
  mock.constraints.forEach(({ result }) => expect(result.signal.aborted).toBe(true));
});
test('checksummed unshield recipient is validated and normalized before request/review', async () => {
  const lower = '0x52908400098527886e0f7030069857d2e4169ee7';
  mock.getAddress.mockResolvedValue(lower);
  const plugin = create();
  await plugin.prepareUnshield(amount(), require('ethers').getAddress(lower));
  expect(options.reviewPreparation.mock.calls[0][0].recipient).toBe(lower);
  expect(mock.prove.mock.calls[0][0].request.recipient).toBe(lower);
});
test('outward cancellation settles while original preparation callback still retains owner', async () => {
  const gate = deferred();
  options.reviewPreparation.mockReturnValue(gate.promise);
  const plugin = create(),
    pending = plugin.prepareTransfer(amount(), '0zk-self');
  await tick();
  caller.abort();
  await expect(pending).rejects.toMatchObject(refusal);
  expect(() => create({ account: makeAccount(), signal: new AbortController().signal })).toThrow(
    refusal.message
  );
  let closed = false;
  plugin.closed.then(() => {
    closed = true;
  });
  await tick();
  expect(closed).toBe(false);
  gate.resolve(true);
  await plugin.closed;
  expect(mock.prove).not.toHaveBeenCalled();
});
test('outward review-draining refusal does not release actual recovery callback', async () => {
  const gate = deferred();
  options.reviewTransaction.mockReturnValue(gate.promise);
  const plugin = create(),
    op = await plugin.prepareTransfer(amount(), '0zk-self');
  const pending = createRailgunKohakuBroadcaster(plugin).broadcast(op);
  await tick();
  caller.abort();
  expect(await pending).toEqual({ status: 'recovery-required', stage: 'review-draining' });
  let closed = false;
  plugin.closed.then(() => {
    closed = true;
  });
  await tick();
  expect(closed).toBe(false);
  gate.resolve(true);
  await plugin.closed;
});
test.each(['preparation', 'transaction'])(
  'actual %s review timer settles admission but retains callback exclusion',
  async (kind) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const gate = deferred();
    try {
      const plugin = create();
      let pending;
      if (kind === 'preparation') {
        options.reviewPreparation.mockReturnValue(gate.promise);
        pending = plugin.prepareTransfer(amount(), '0zk-self');
      } else {
        const op = await plugin.prepareTransfer(amount(), '0zk-self');
        options.reviewTransaction.mockReturnValue(gate.promise);
        pending = createRailgunKohakuBroadcaster(plugin).broadcast(op);
      }
      await tick();
      jest.advanceTimersByTime(30000);
      if (kind === 'preparation') await expect(pending).rejects.toMatchObject(refusal);
      else expect(await pending).toEqual({ status: 'recovery-required', stage: 'review-draining' });
      let drained = false;
      plugin.closed.then(() => {
        drained = true;
      });
      await tick();
      expect(drained).toBe(false);
      expect(() =>
        create({ account: makeAccount(), signal: new AbortController().signal })
      ).toThrow(refusal.message);
      gate.resolve(true);
      await plugin.closed;
    } finally {
      gate.resolve(false);
      jest.useRealTimers();
    }
  }
);
test('cancellation while wallet close drains never starts recovery submission', async () => {
  const plugin = create(),
    op = await plugin.prepareTransfer(amount(), '0zk-self');
  const gate = deferred();
  account.close.mockReturnValue(gate.promise);
  const pending = createRailgunKohakuBroadcaster(plugin).broadcast(op);
  await tick();
  caller.abort();
  expect(mock.submit).not.toHaveBeenCalled();
  gate.resolve();
  expect((await pending).status).toBe('recovery-required');
  await plugin.closed;
  expect(mock.submit).not.toHaveBeenCalled();
});
test.each(['acknowledged', 'uncertain'])(
  'structured %s controller result survives close while cleanup settles',
  async (status) => {
    const result = Object.freeze({
      hash: '0x' + 'd'.repeat(64),
      submission: Object.freeze({ status }),
    });
    mock.submit.mockImplementation(async () => {
      caller.abort();
      return result;
    });
    const plugin = create(),
      op = await plugin.prepareTransfer(amount(), '0zk-self');
    expect(await createRailgunKohakuBroadcaster(plugin).broadcast(op)).toBe(result);
    await plugin.closed;
  }
);
test('untrusted thrown hash is never converted into an acknowledged/uncertain result', async () => {
  mock.submit.mockRejectedValue(
    Object.assign(Error('raw sensitive failure'), { hash: '0x' + 'd'.repeat(64) })
  );
  const plugin = create(),
    op = await plugin.prepareTransfer(amount(), '0zk-self');
  expect(await createRailgunKohakuBroadcaster(plugin).broadcast(op)).toEqual({
    status: 'recovery-required',
    stage: 'kohaku',
  });
  await plugin.closed;
});
test('elapsed preparation budget refuses late proved result without waiting for timer dispatch', async () => {
  const started = performance.now();
  const clock = jest.spyOn(performance, 'now').mockReturnValue(started);
  mock.prove.mockImplementation(async () => {
    mock.completion = completion();
    clock.mockReturnValue(started + 540000);
    return { status: 'proved', completion: mock.completion };
  });
  const plugin = create();
  await expect(plugin.prepareTransfer(amount(), '0zk-self')).rejects.toMatchObject(refusal);
  expect(mock.prove).toHaveBeenCalledTimes(1);
  await plugin.closed;
  expect(mock.completion.close).toHaveBeenCalled();
  expect(plugin.status().recoveryRequired).toBe(true);
  expect(mock.submit).not.toHaveBeenCalled();
});
test('preparation budget is not reapplied to a timely completion during broadcast', async () => {
  const started = performance.now();
  const clock = jest.spyOn(performance, 'now').mockReturnValue(started);
  mock.prove.mockImplementation(async () => {
    clock.mockReturnValue(started + 539000);
    mock.completion = completion();
    return { status: 'proved', completion: mock.completion };
  });
  const plugin = create(),
    op = await plugin.prepareTransfer(amount(), '0zk-self');
  clock.mockReturnValue(started + 541000);
  expect((await createRailgunKohakuBroadcaster(plugin).broadcast(op)).status).toBe('submitted');
  await plugin.closed;
});

test.each(['close', 'caller-abort', 'external-account-close'])(
  'held preparation review excludes direct recovery after wallet drain: %s',
  async (action) => {
    const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
    mock.phases.set(account, phase);
    const originalClose = account.close;
    account.close = jest.fn(async () => {
      await originalClose();
      phase.release();
    });
    const gate = deferred();
    const plugin = create({ reviewPreparation: () => gate.promise });
    const work = plugin.prepareTransfer(amount(), '0zk-self');
    work.catch(() => {});
    let settled = false;
    plugin.closed.then(() => (settled = true));
    try {
      await tick();
      if (action === 'close') plugin.close();
      if (action === 'caller-abort') caller.abort();
      await account.close();
      await tick();
      expect(settled).toBe(false);
      let accidental;
      try {
        expect(() => {
          accidental = claimRailgunAccountPhase(mock.enrollment, 'recovery');
        }).toThrow(expect.objectContaining({ code: 'RAILGUN_ACCOUNT_PHASE_BUSY' }));
      } finally {
        accidental?.release();
      }
    } finally {
      plugin.close();
      gate.resolve(true);
      await expect(work).rejects.toMatchObject(refusal);
      await plugin.closed;
      phase.release();
    }
    expect(mock.stage).not.toHaveBeenCalled();
    expect(mock.prove).not.toHaveBeenCalled();
    expect(mock.submit).not.toHaveBeenCalled();
    const recovered = claimRailgunAccountPhase(mock.enrollment, 'recovery');
    recovered.release();
  }
);

test('aborted preparation keeps handoff until callback and delayed account close both drain', async () => {
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  mock.phases.set(account, phase);
  const callback = deferred(),
    worker = deferred();
  const originalClose = account.close;
  account.close = jest.fn(async () => {
    await originalClose();
    await worker.promise;
    phase.release();
  });
  const plugin = create({ reviewPreparation: () => callback.promise });
  const work = plugin.prepareTransfer(amount(), '0zk-self');
  work.catch(() => {});
  let drained = false;
  plugin.closed.then(() => (drained = true));
  try {
    await tick();
    plugin.close();
    await expect(work).rejects.toMatchObject(refusal);
    callback.resolve(true);
    await tick();
    expect(drained).toBe(false);
    // The actual wallet grant still exists, and its handoff remains reserved.
    expect(() => phase.reserveHandoff()).toThrow(
      expect.objectContaining({ code: 'RAILGUN_ACCOUNT_PHASE_BUSY' })
    );
    expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow(
      expect.objectContaining({ code: 'RAILGUN_ACCOUNT_PHASE_BUSY' })
    );
    expect(mock.prove).not.toHaveBeenCalled();
  } finally {
    callback.resolve(true);
    worker.resolve();
    plugin.close();
    await plugin.closed;
    phase.release();
  }
  const recovered = claimRailgunAccountPhase(mock.enrollment, 'recovery');
  recovered.release();
});

test.each(['denied', 'throw', 'approved'])(
  'settled preparation review releases handoff while retaining wallet phase: %s',
  async (decision) => {
    const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
    mock.phases.set(account, phase);
    const originalClose = account.close;
    account.close = jest.fn(async () => {
      await originalClose();
      phase.release();
    });
    const plugin = create({
      reviewPreparation: async () => {
        if (decision === 'throw') throw Error('review failure');
        return decision === 'approved';
      },
    });
    try {
      const work = plugin.prepareTransfer(amount(), '0zk-self');
      if (decision === 'approved')
        await expect(work).resolves.toEqual({ __type: 'privateOperation' });
      else await expect(work).rejects.toMatchObject(refusal);
      const subsequent = phase.reserveHandoff();
      subsequent.release();
      expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow(
        expect.objectContaining({ code: 'RAILGUN_ACCOUNT_PHASE_BUSY' })
      );
    } finally {
      plugin.close();
      await plugin.closed;
      phase.release();
    }
  }
);

test('successful review releases its reservation before genuine Transact staging handoff', async () => {
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  mock.phases.set(account, phase);
  mock.owned.ownedPoi[0].type = 'Transact';
  const originalClose = account.close,
    originalStage = mock.stage.getMockImplementation();
  account.close = jest.fn(async () => {
    await originalClose();
    phase.release();
  });
  mock.stage.mockImplementation(async (args) => {
    const handoff = phase.reserveHandoff();
    try {
      return await originalStage(args);
    } finally {
      handoff.release();
    }
  });
  const plugin = create();
  try {
    await expect(plugin.prepareTransfer(amount(), '0zk-self')).resolves.toEqual({
      __type: 'privateOperation',
    });
    expect(mock.stage).toHaveBeenCalledTimes(1);
    expect(mock.prove).toHaveBeenCalledTimes(1);
  } finally {
    plugin.close();
    await plugin.closed;
    phase.release();
  }
});

test('public lane exposes only native Shield preparation and separate genuine submit helper', async () => {
  const plugin = publicPlugin();
  expect(Object.keys(plugin).sort()).toEqual(
    [
      'instanceId',
      'balance',
      'notes',
      'prepareShield',
      'status',
      'signal',
      'closed',
      'close',
    ].sort()
  );
  expect(() => assertRailgunKohakuPublicPlugin(plugin)).not.toThrow();
  expect(() => createRailgunKohakuBroadcaster(plugin)).toThrow(refusal.message);
  expect(() => assertRailgunKohakuPublicPlugin({ ...plugin })).toThrow(refusal.message);
  const op = await plugin.prepareShield(nativeAmount());
  expect(op).toEqual({ __type: 'publicOperation' });
  expect(Object.isFrozen(op)).toBe(true);
  expect(plugin.status()).toMatchObject({
    state: 'prepared',
    recoveryRequired: false,
    accountOpen: false,
  });
  await expect(plugin.balance()).rejects.toMatchObject(refusal);
  await expect(plugin.notes()).rejects.toMatchObject(refusal);
  expect(mock.sourceReads).toBe(0);
  expect(mock.stage).not.toHaveBeenCalled();
  expect(mock.prove).not.toHaveBeenCalled();
  expect(mock.submit).not.toHaveBeenCalled();
});
test.each(['proverArchive', 'artifactDirectory'])(
  'public configuration refuses even explicitly undefined %s',
  (key) => {
    expect(() => publicPlugin({ [key]: undefined })).toThrow(refusal.message);
    expect(mock.openShield).not.toHaveBeenCalled();
    expect(mock.getSigner).not.toHaveBeenCalled();
  }
);
test.each([
  { asset: { __type: 'erc20', contract: pins.wrappedNative }, amount: 1n },
  { asset: { __type: 'native', contract: pins.wrappedNative }, amount: 1n },
  { asset: { __type: 'native' }, amount: 0n },
  { asset: { __type: 'native' }, amount: -1n },
  { asset: { __type: 'native' }, amount: 10000000000000001n },
  { asset: { __type: 'native' }, amount: '1' },
  { asset: { __type: 'native' }, amount: 1 },
  { asset: { __type: 'native' }, amount: 1n, noteId: '0:1' },
])('public Shield strict native amount refuses %p before review', async (value) => {
  const plugin = publicPlugin();
  await expect(plugin.prepareShield(value)).rejects.toMatchObject(refusal);
  expect(options.reviewPreparation).not.toHaveBeenCalled();
  expect(mock.openShield).not.toHaveBeenCalled();
  expect(mock.getSigner).not.toHaveBeenCalled();
});
test.each([null, '0zk-foreign', {}, '0x' + '1'.repeat(40)])(
  'foreign or invalid Shield recipient %p refuses',
  async (to) => {
    await expect(publicPlugin().prepareShield(nativeAmount(), to)).rejects.toMatchObject(refusal);
    expect(options.reviewPreparation).not.toHaveBeenCalled();
    expect(mock.openShield).not.toHaveBeenCalled();
  }
);
test.each([1n, 10000000000000000n])(
  'public native boundary %s preserves integer fee and exact self recipient',
  async (value) => {
    const plugin = publicPlugin();
    await plugin.prepareShield(nativeAmount(value), mock.identity.descriptor.instanceId);
    const summary = options.reviewPreparation.mock.calls[0][0];
    expect(summary.amount).toBe(String(value));
    expect(summary.protocolFee).toBe(String((value * 25n) / 10000n));
    expect(summary.noteValue).toBe(String(value - (value * 25n) / 10000n));
  }
);
test.each([
  null,
  {},
  { index: 1, type: 'mnemonic', address: '0x' + '1'.repeat(40) },
  { index: 0, type: 'ledger', address: '0x' + '1'.repeat(40) },
  { index: 0, type: 'remote', address: '0x' + '1'.repeat(40) },
  { index: 0, type: 'safe', address: '0x' + '1'.repeat(40) },
  { index: 0, type: 'mnemonic', address: null },
  { index: 0, type: 'mnemonic', address: '0x' + '0'.repeat(40) },
])('metadata-only funding refusal has no signer fallback: %p', async (record) => {
  mock.walletRecord = record;
  const plugin = publicPlugin();
  await expect(plugin.prepareShield(nativeAmount())).rejects.toMatchObject(refusal);
  expect(options.reviewPreparation).not.toHaveBeenCalled();
  expect(mock.getSigner).not.toHaveBeenCalled();
  expect(mock.getAddress).not.toHaveBeenCalled();
  expect(mock.openShield).not.toHaveBeenCalled();
  await plugin.closed;
});
test('first review discloses exact preview destinations/simulation without deriving funding address', async () => {
  options.reviewPreparation.mockImplementation(async (summary) => {
    expect(mock.getSigner).not.toHaveBeenCalled();
    expect(mock.getAddress).not.toHaveBeenCalled();
    expect(mock.openShield).not.toHaveBeenCalled();
    expect(account.close).not.toHaveBeenCalled();
    expect(mock.sourceReads).toBe(0);
    expect(mock.constraints).toHaveLength(2);
    expect(summary).toMatchObject({
      purpose: 'railgun-public-shield-preparation',
      operation: 'railgun-native-shield',
      funding: { index: 0, type: 'mnemonic', address: mock.walletRecord.address },
      recipient: '0zk-self',
      destinations: { protocolRpc: mock.rpcUrl, transactionRpc: mock.rpcUrl },
      permitsSimulation: true,
      permitsSigning: false,
      broadcastsTransaction: false,
      sourceQueries: false,
      poiQueries: false,
      viewingKeyVerification: true,
      privateSpendSigning: false,
      broadcastSimulationBeforeTransactionReview: true,
    });
    expect(summary.exposures.transactionRpc).toEqual(
      expect.arrayContaining([
        'eth_estimateGas',
        'eth_call',
        'encrypted-note',
        'relay-adapt-shield-calldata',
      ])
    );
    expect(Object.isFrozen(summary.funding)).toBe(true);
    return true;
  });
  const plugin = publicPlugin();
  const op = await plugin.prepareShield(nativeAmount());
  expect(mock.getSigner).not.toHaveBeenCalled();
  const call = mock.openShield.mock.calls[0][0];
  expect(call).toMatchObject({
    identity: mock.identity,
    enrollment: mock.enrollment,
    amount: '100000000000000',
    owner: mock.walletRecord.address,
    destinationConstraints: {
      protocol: mock.constraints[0].result.constraint,
      transaction: mock.constraints[1].result.constraint,
    },
  });
  expect(call.signal).toBe(plugin.signal);
  expect(mock.constraints.every(({ result }) => !result.signal.aborted)).toBe(true);
  expect((await submitRailgunKohakuPublicOperation(plugin, op)).hash).toBe('0x' + '8'.repeat(64));
  expect(mock.getSigner).toHaveBeenCalledTimes(1);
  expect(mock.sourceReads).toBe(0);
  await plugin.closed;
});
test.each(['deny', 'throw', 'late-approval'])(
  'first review %s permits zero Shield jobs/signers and retains handoff through original callback',
  async (mode) => {
    const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
    mock.phases.set(account, phase);
    const original = account.close;
    account.close = jest.fn(async () => {
      await original();
      phase.release();
    });
    const gate = deferred();
    const plugin = publicPlugin({ reviewPreparation: () => gate.promise });
    const work = plugin.prepareShield(nativeAmount());
    work.catch(() => {});
    try {
      await tick();
      if (mode === 'late-approval') {
        caller.abort();
        await account.close();
        let accidental;
        try {
          expect(() => {
            accidental = claimRailgunAccountPhase(mock.enrollment, 'recovery');
          }).toThrow(expect.objectContaining({ code: 'RAILGUN_ACCOUNT_PHASE_BUSY' }));
        } finally {
          accidental?.release();
        }
        gate.resolve(true);
      } else if (mode === 'throw') gate.reject(Error('private review detail'));
      else gate.resolve(false);
      await expect(work).rejects.toMatchObject(refusal);
      await plugin.closed;
      expect(mock.openShield).not.toHaveBeenCalled();
      expect(mock.getSigner).not.toHaveBeenCalled();
      expect(plugin.status().recoveryRequired).toBe(false);
      const recovered = claimRailgunAccountPhase(mock.enrollment, 'recovery');
      recovered.release();
    } finally {
      gate.resolve(false);
      plugin.close();
      phase.release();
    }
  }
);
test('approved public review keeps real handoff through awaited account close then synchronously enters recovery host', async () => {
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  mock.phases.set(account, phase);
  const worker = deferred(),
    original = account.close;
  account.close = jest.fn(async () => {
    await original();
    phase.release();
    await worker.promise;
  });
  const plugin = publicPlugin();
  const work = plugin.prepareShield(nativeAmount());
  try {
    await tick();
    expect(mock.openShield).not.toHaveBeenCalled();
    let accidental;
    try {
      expect(() => {
        accidental = claimRailgunAccountPhase(mock.enrollment, 'recovery');
      }).toThrow(expect.objectContaining({ code: 'RAILGUN_ACCOUNT_PHASE_BUSY' }));
    } finally {
      accidental?.release();
    }
    worker.resolve();
    await expect(work).resolves.toEqual({ __type: 'publicOperation' });
    expect(mock.openShield).toHaveBeenCalledTimes(1);
  } finally {
    worker.resolve();
    plugin.close();
    await plugin.closed;
    phase.release();
  }
});
test.each(['address', 'index', 'type', 'endpoint', 'generation', 'recipient'])(
  'changed %s during first review refuses before account handoff/Shield jobs',
  async (change) => {
    options.reviewPreparation.mockImplementation(async () => {
      if (change === 'address') mock.walletRecord.address = '0x' + '2'.repeat(40);
      if (change === 'index') mock.walletRecord.index = 1;
      if (change === 'type') mock.walletRecord.type = 'ledger';
      if (change === 'endpoint') mock.rpcUrl += '/same-host-other-path';
      if (change === 'generation') mock.publicIdentity.generationId = 'other';
      if (change === 'recipient') mock.identity.descriptor.instanceId = '0zk-changed';
      return true;
    });
    const plugin = publicPlugin();
    await expect(plugin.prepareShield(nativeAmount())).rejects.toMatchObject(refusal);
    expect(mock.openShield).not.toHaveBeenCalled();
    expect(mock.getSigner).not.toHaveBeenCalled();
    await plugin.closed;
  }
);
test('public tokens reject forgery/copy/private tokens and consume synchronously once', async () => {
  const plugin = publicPlugin(),
    op = await plugin.prepareShield(nativeAmount());
  for (const token of [
    {},
    { ...op },
    JSON.parse(JSON.stringify(op)),
    { __type: 'privateOperation' },
  ])
    await expect(submitRailgunKohakuPublicOperation(plugin, token)).rejects.toMatchObject(refusal);
  expect(mock.shield.submit).not.toHaveBeenCalled();
  const gate = deferred();
  mock.shieldSubmit.mockReturnValue(gate.promise);
  const sent = submitRailgunKohakuPublicOperation(plugin, op);
  await expect(submitRailgunKohakuPublicOperation(plugin, op)).rejects.toMatchObject(refusal);
  gate.resolve({ hash: '0x' + '8'.repeat(64) });
  await sent;
  await plugin.closed;
  expect(mock.shield.submit).toHaveBeenCalledTimes(1);
});
test.each(['prepared', 'broadcasting'])(
  'public monotonic deadline remains enforced while %s even without timer dispatch',
  async (when) => {
    let now = 100;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    options.reviewPreparation.mockImplementation(async () => {
      now = 200;
      return true;
    });
    const plugin = publicPlugin(),
      op = await plugin.prepareShield(nativeAmount());
    expect(mock.constraints.map(({ deadline }) => deadline)).toEqual([120100, 120100]);
    if (when === 'prepared') {
      now = 120100;
      await expect(submitRailgunKohakuPublicOperation(plugin, op)).rejects.toMatchObject(refusal);
      expect(mock.getSigner).not.toHaveBeenCalled();
      expect(mock.shield.submit).not.toHaveBeenCalled();
    } else {
      mock.shieldSubmit.mockImplementation(async ({ review }) => {
        now = 120100;
        await review({});
      });
      await expect(submitRailgunKohakuPublicOperation(plugin, op)).rejects.toMatchObject(refusal);
      expect(options.reviewTransaction).not.toHaveBeenCalled();
    }
    await plugin.closed;
  }
);
test('public prepared expiry has no private capsule recovery claim and closes idle controller', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  try {
    const plugin = publicPlugin();
    await plugin.prepareShield(nativeAmount());
    jest.advanceTimersByTime(120000);
    await plugin.closed;
    expect(mock.shield.close).toHaveBeenCalled();
    expect(plugin.status()).toMatchObject({ state: 'closed', recoveryRequired: false });
  } finally {
    jest.useRealTimers();
  }
});
test('cancelled opening adopts late Shield controller and waits its separate drain before owner release', async () => {
  const open = deferred();
  mock.openShield.mockReturnValue(open.promise);
  const plugin = publicPlugin(),
    work = plugin.prepareShield(nativeAmount());
  work.catch(() => {});
  let closed = false;
  plugin.closed.then(() => {
    closed = true;
  });
  await tick();
  caller.abort();
  const late = shieldController({ holdDrain: true });
  open.resolve(late);
  await expect(work).rejects.toMatchObject(refusal);
  expect(late.close).toHaveBeenCalled();
  expect(closed).toBe(false);
  expect(() =>
    publicPlugin({ account: makeAccount(), signal: new AbortController().signal })
  ).toThrow(refusal.message);
  late.release();
  await plugin.closed;
  expect(
    publicPlugin({ account: makeAccount(), signal: new AbortController().signal })
  ).toBeDefined();
});
test('failed opening keeps owner until original opening cleanup settles', async () => {
  const open = deferred();
  mock.openShield.mockReturnValue(open.promise);
  const plugin = publicPlugin(),
    work = plugin.prepareShield(nativeAmount());
  work.catch(() => {});
  await tick();
  caller.abort();
  await tick();
  expect(() =>
    publicPlugin({ account: makeAccount(), signal: new AbortController().signal })
  ).toThrow(refusal.message);
  open.reject(Error('private failed cleanup'));
  await expect(work).rejects.toMatchObject(refusal);
  await plugin.closed;
});
test.each(['acknowledged', 'PRIVATE_BROADCAST_UNCERTAIN', 'PRIVATE_SUBMISSION_UNRESOLVED'])(
  'genuine %s controller outcome survives late closure while its drain retains owner',
  async (kind) => {
    const inner = shieldController({ holdDrain: true });
    mock.openShield.mockResolvedValue(inner);
    const plugin = publicPlugin(),
      op = await plugin.prepareShield(nativeAmount());
    const result = Object.freeze({ hash: '0x' + '8'.repeat(64) });
    const error = Object.assign(Error('journal outcome'), {
      code: kind,
      transactionHash: result.hash,
    });
    mock.shieldSubmit.mockImplementation(async () => {
      caller.abort();
      if (kind !== 'acknowledged') throw error;
      return result;
    });
    const sent = submitRailgunKohakuPublicOperation(plugin, op);
    if (kind === 'acknowledged') expect(await sent).toBe(result);
    else await expect(sent).rejects.toBe(error);
    expect(plugin.status().recoveryRequired).toBe(true);
    expect(() =>
      publicPlugin({ account: makeAccount(), signal: new AbortController().signal })
    ).toThrow(refusal.message);
    inner.release();
    await plugin.closed;
  }
);
test('untrusted signer-factory error cannot fabricate journal uncertainty', async () => {
  const plugin = publicPlugin(),
    op = await plugin.prepareShield(nativeAmount());
  mock.getSigner.mockImplementation(() => {
    throw Object.assign(Error('secret'), {
      code: 'PRIVATE_BROADCAST_UNCERTAIN',
      transactionHash: 'forged',
    });
  });
  await expect(submitRailgunKohakuPublicOperation(plugin, op)).rejects.toMatchObject(refusal);
  expect(mock.shield.submit).not.toHaveBeenCalled();
  await plugin.closed;
});

test('public descriptor instanceId remains available after account handoff while balance and notes refuse', async () => {
  const plugin = publicPlugin();
  expect(await plugin.instanceId()).toBe('0zk-self');
  await plugin.prepareShield(nativeAmount());
  expect(await plugin.instanceId()).toBe('0zk-self');
  expect(account.view.instanceId).not.toHaveBeenCalled();
  await expect(plugin.balance()).rejects.toMatchObject(refusal);
  await expect(plugin.notes()).rejects.toMatchObject(refusal);
  mock.identity.descriptor.instanceId = '0zk-other';
  await expect(plugin.instanceId()).rejects.toMatchObject(refusal);
  plugin.close();
  await plugin.closed;
  await expect(plugin.instanceId()).rejects.toMatchObject(refusal);
});
test.each(['account-close', 'controller-open'])(
  'public preparation cancellation settles outward before held %s drains without releasing ownership',
  async (held) => {
    const gate = deferred();
    if (held === 'account-close') {
      const original = account.close;
      account.close = jest.fn(async () => {
        await original();
        await gate.promise;
      });
    } else mock.openShield.mockReturnValue(gate.promise);
    const plugin = publicPlugin(),
      work = plugin.prepareShield(nativeAmount());
    const refused = expect(work).rejects.toMatchObject(refusal);
    let closed = false;
    plugin.closed.then(() => {
      closed = true;
    });
    await tick();
    caller.abort();
    await refused;
    expect(closed).toBe(false);
    expect(() =>
      publicPlugin({ account: makeAccount(), signal: new AbortController().signal })
    ).toThrow(refusal.message);
    if (held === 'account-close') gate.resolve();
    else gate.resolve(shieldController());
    await plugin.closed;
    if (held === 'account-close') expect(mock.openShield).not.toHaveBeenCalled();
    expect(mock.getSigner).not.toHaveBeenCalled();
  }
);

test('public token from a closed predecessor cannot submit through a fresh instance', async () => {
  const first = publicPlugin(),
    stale = await first.prepareShield(nativeAmount());
  first.close();
  await first.closed;
  const next = publicPlugin({ account: makeAccount() }),
    currentToken = await next.prepareShield(nativeAmount());
  await expect(submitRailgunKohakuPublicOperation(next, stale)).rejects.toMatchObject(refusal);
  expect(mock.shield.submit).not.toHaveBeenCalled();
  await submitRailgunKohakuPublicOperation(next, currentToken);
  await next.closed;
});
test.each(['endpoint', 'funding', 'constraint'])(
  'changed %s while public token waits refuses before signer/controller submit',
  async (change) => {
    const plugin = publicPlugin(),
      op = await plugin.prepareShield(nativeAmount());
    if (change === 'endpoint') mock.rpcUrl += '/changed-path';
    if (change === 'funding') mock.walletRecord.address = '0x' + '2'.repeat(40);
    if (change === 'constraint') mock.constraints[0].result.close();
    await expect(submitRailgunKohakuPublicOperation(plugin, op)).rejects.toMatchObject(refusal);
    expect(mock.getSigner).not.toHaveBeenCalled();
    expect(mock.shield.submit).not.toHaveBeenCalled();
    await plugin.closed;
  }
);
test('public rejected controller barrier revokes admission and never releases uncertain cleanup owner', async () => {
  const drain = deferred(),
    inner = shieldController({ holdDrain: true });
  inner.closed = drain.promise;
  mock.openShield.mockResolvedValue(inner);
  const plugin = publicPlugin();
  await plugin.prepareShield(nativeAmount());
  let settled = false;
  plugin.closed.then(() => {
    settled = true;
  });
  drain.reject(Error('private cleanup reason'));
  await tick();
  expect(plugin.signal.aborted).toBe(true);
  expect(settled).toBe(false);
  expect(() => publicPlugin({ account: makeAccount() })).toThrow(refusal.message);
});
test('late controller close failure preserves account exclusion without masking an outward prepare refusal', async () => {
  const open = deferred(),
    inner = shieldController();
  inner.close = jest.fn(() => {
    throw Error('private close reason');
  });
  mock.openShield.mockReturnValue(open.promise);
  const plugin = publicPlugin(),
    work = plugin.prepareShield(nativeAmount());
  const refused = expect(work).rejects.toMatchObject(refusal);
  await tick();
  caller.abort();
  await refused;
  open.resolve(inner);
  await tick();
  inner.release();
  await tick();
  expect(() =>
    publicPlugin({ account: makeAccount(), signal: new AbortController().signal })
  ).toThrow(refusal.message);
});
test('a direct phase contender acquired on account close causes zero-job refusal, never an unprotected continuation', async () => {
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  mock.phases.set(account, phase);
  const original = account.close;
  account.close = jest.fn(async () => {
    await original();
    phase.release();
  });
  let contender;
  mock.openShield.mockImplementation(async () => {
    // The released handoff permits a real competing owner; the host must fail.
    contender = claimRailgunAccountPhase(mock.enrollment, 'txid');
    claimRailgunAccountPhase(mock.enrollment, 'recovery');
    throw Error('must not reach utility');
  });
  const plugin = publicPlugin();
  try {
    await expect(plugin.prepareShield(nativeAmount())).rejects.toMatchObject(refusal);
    expect(mock.getSigner).not.toHaveBeenCalled();
    await plugin.closed;
    let accidental;
    try {
      expect(() => {
        accidental = claimRailgunAccountPhase(mock.enrollment, 'recovery');
      }).toThrow(expect.objectContaining({ code: 'RAILGUN_ACCOUNT_PHASE_BUSY' }));
    } finally {
      accidental?.release();
    }
  } finally {
    contender?.release();
    phase.release();
  }
});
test('held public transaction review may settle outward while original controller drain retains owner', async () => {
  const inner = shieldController({ holdDrain: true });
  mock.openShield.mockResolvedValue(inner);
  const reviewGate = deferred();
  options.reviewTransaction.mockReturnValue(reviewGate.promise);
  let originalReview;
  mock.shieldSubmit.mockImplementation(async ({ review }) => {
    originalReview = review({ operation: 'railgun-native-shield' });
    originalReview.catch(() => {});
    await new Promise((resolve) =>
      caller.signal.addEventListener('abort', resolve, { once: true })
    );
    throw Error('sanitized controller cancellation');
  });
  const plugin = publicPlugin(),
    op = await plugin.prepareShield(nativeAmount());
  const sent = submitRailgunKohakuPublicOperation(plugin, op);
  const refused = expect(sent).rejects.toMatchObject(refusal);
  await tick();
  caller.abort();
  await refused;
  expect(() =>
    publicPlugin({ account: makeAccount(), signal: new AbortController().signal })
  ).toThrow(refusal.message);
  reviewGate.resolve(true);
  await expect(originalReview).rejects.toBeDefined();
  inner.release();
  await plugin.closed;
});

test.each(['review-expiry', 'token-expiry', 'wall-regression'])(
  'public outer wall clock %s refuses with monotonic clock fixed and no timer dispatch',
  async (mode) => {
    let wall = 1000000;
    jest.spyOn(Date, 'now').mockImplementation(() => wall);
    jest.spyOn(performance, 'now').mockReturnValue(100);
    if (mode === 'review-expiry')
      options.reviewPreparation.mockImplementation(async () => {
        wall += 120000;
        return true;
      });
    const plugin = publicPlugin();
    if (mode === 'review-expiry') {
      await expect(plugin.prepareShield(nativeAmount())).rejects.toMatchObject(refusal);
      expect(mock.openShield).not.toHaveBeenCalled();
    } else {
      const token = await plugin.prepareShield(nativeAmount());
      wall = mode === 'token-expiry' ? 1120000 : 999999;
      await expect(submitRailgunKohakuPublicOperation(plugin, token)).rejects.toMatchObject(
        refusal
      );
      expect(mock.shield.submit).not.toHaveBeenCalled();
    }
    expect(mock.getSigner).not.toHaveBeenCalled();
    expect(plugin.signal.aborted).toBe(true);
    await plugin.closed;
  }
);
