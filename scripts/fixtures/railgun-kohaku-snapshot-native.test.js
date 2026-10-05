/** Fixture controls use mocked owner registries/files; native ownership is not claimed. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const mockRead = jest.fn();
const mockPublic = jest.fn();
const mockInventory = jest.fn();
jest.mock('../../src/main/wallet/railgun-account-wallet', () => ({
  readRailgunAccountOwnedNotes: (...args) => mockRead(...args),
}));
jest.mock('../../src/main/wallet/railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (...args) => mockPublic(...args),
}));
jest.mock('./railgun-public-cold-data', () => ({ inventory: (...args) => mockInventory(...args) }));
const native = require('./railgun-kohaku-snapshot-native');
const pluginModule = require('../../src/main/wallet/railgun-kohaku-snapshot-plugin');
const { snapshotFixture } = require('./railgun-kohaku-snapshot-conformance');
const {
  projectRailgunKohakuBalance,
  projectRailgunKohakuNotes,
} = require('../../src/main/wallet/railgun-kohaku-read-data');
const zero = {
  brokerMessages: 0,
  utilityStarts: 0,
  utilitySettlements: 0,
  workerStarts: 0,
  workerSettlements: 0,
  rejectedBarriers: 0,
  rpcFactories: 0,
  rpcRequests: 0,
  transportFactories: 0,
  signerFactories: 0,
  railgunKeyRequests: 0,
  railgunKeyReplies: 0,
  applications: 0,
  walletRestores: 0,
};
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
let f;
beforeEach(() => {
  const read = snapshotFixture();
  read.received = read.received.slice(0, 3);
  read.received[0].amount = 2000n;
  read.received[1].amount = 1000n;
  read.received[1].spentTxid = '0x' + '1'.repeat(64);
  read.received[2].amount = 700n;
  read.received[2].spentTxid = false;
  deepFreeze(read);
  const signal = new AbortController().signal;
  const owners = {
    identity: { signal, descriptor: { instanceId: read.instanceId } },
    enrollment: { signal },
    coordinator: { signal },
  };
  const baseline = deepFreeze({ read, checkpointHash: 'fixture', ownedPoi: [] });
  const view = {
    balance: jest.fn(async () => projectRailgunKohakuBalance(read.received, null)),
    notes: jest.fn(async () => projectRailgunKohakuNotes(read.received, null, true)),
  };
  const account = { view, signal, generationId: 'fixture-generation', close: jest.fn() };
  f = {
    read,
    baseline,
    account,
    owners,
    signal,
    profile: '/virtual-snapshot-profile',
    walletDirectory: '/virtual-snapshot-profile/wallet',
    measure: jest.fn(() => ({ ...zero })),
    inventory: { 'wallet.sqlite': 'fixture-bytes' },
    eoaExists: false,
  };
  mockRead.mockImplementation((actual, joined) => {
    if (
      actual !== account ||
      joined.identity !== owners.identity ||
      joined.enrollment !== owners.enrollment ||
      joined.coordinator !== owners.coordinator
    )
      throw Error('Mock registry refused');
    return baseline;
  });
  mockPublic.mockImplementation(() => ({ checkpoint: 'fixture' }));
  mockInventory.mockImplementation(() => ({ ...f.inventory }));
  const lstat = fs.lstatSync,
    readFile = fs.readFileSync;
  jest.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    if (!String(file).startsWith(f.profile)) return lstat(file, ...args);
    if (String(file).endsWith('wallet-private-submissions') && !f.eoaExists)
      throw Object.assign(Error('absent'), { code: 'ENOENT' });
    const marker = String(file).endsWith('.json');
    return {
      isDirectory: () => !marker,
      isFile: () => marker,
      isSymbolicLink: () => false,
      nlink: 1,
    };
  });
  jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((file, ...args) =>
      String(file).startsWith(f.profile)
        ? Buffer.from('fixture-inventory')
        : readFile(file, ...args)
    );
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
test('actual restricted adapter over mocked registry runs 13 reads, isolates data, drains and leaves borrowed view usable', async () => {
  const create = pluginModule.createRailgunKohakuSnapshotPlugin;
  let methods;
  jest.spyOn(pluginModule, 'createRailgunKohakuSnapshotPlugin').mockImplementation((options) => {
    const actual = create(options);
    methods = Object.fromEntries(
      ['instanceId', 'balance', 'notes'].map((name) => [
        name,
        jest.fn((...args) => actual[name](...args)),
      ])
    );
    return Object.freeze({ ...actual, ...methods });
  });
  const result = await native.qualify(f);
  expect(
    Object.fromEntries(
      Object.entries(methods).map(([name, call]) => [name, call.mock.calls.length])
    )
  ).toEqual({ instanceId: 3, balance: 7, notes: 7 });
  expect(result).toEqual({
    schema: 'railgun-kohaku-snapshot-native-v1',
    scenario: 'enrolled-stage30-restore',
    instances: 1,
    sharedReadVectors: 9,
    successfulAdapterReads: 13,
    postCloseRefusals: 3,
    hostAbortRefusals: 1,
    inFlightReadRefusedAtClose: 1,
    borrowedViewReadsAfterClose: 2,
    receivedRecords: 3,
    unspentRecords: 2,
    spentRecords: 1,
    genuineAccountAndOwners: true,
    comparedToGenuineOwnedSnapshot: true,
    detachedMutationIsolation: true,
    borrowedAccountRemainsUsable: true,
    adapterClosedObserved: true,
    durableEncryptedFilesAndNamesUnchanged: true,
    wholeBrowserProfileByteIdentity: false,
    provenance: 'host-supplied',
    zeroAdditionalMeasuredWork: true,
    deltas: zero,
    eligibilityGranted: false,
    spendingAuthorityGranted: false,
    typescriptConformance: false,
    genericHostQualified: false,
    physicalSocketDrainQualified: false,
  });
  expect(f.account.view.balance).toHaveBeenCalledTimes(1);
  expect(f.account.view.notes).toHaveBeenCalledTimes(1);
  expect(f.account.close).not.toHaveBeenCalled();
  expect(f.eoaExists).toBe(false);
});
test.each(Object.keys(zero))('refuses extra observed %s work', async (key) => {
  let calls = 0;
  f.measure.mockImplementation(() => ({ ...zero, [key]: ++calls === 1 ? 0 : 1 }));
  await expect(native.qualify(f)).rejects.toThrow();
  expect(f.account.close).not.toHaveBeenCalled();
});
test.each(['bytes', 'filename', 'eoa-directory'])(
  'refuses durable %s mutation without adopting files',
  async (kind) => {
    let calls = 0;
    f.measure.mockImplementation(() => {
      if (++calls === 2) {
        if (kind === 'bytes') f.inventory['wallet.sqlite'] = 'changed';
        if (kind === 'filename') f.inventory['new-entry'] = 'added';
        if (kind === 'eoa-directory') f.eoaExists = true;
      }
      return { ...zero };
    });
    await expect(native.qualify(f)).rejects.toThrow();
  }
);
test('refuses shared asset output, distinguishing detached values from shallow array copy', async () => {
  const create = pluginModule.createRailgunKohakuSnapshotPlugin;
  jest.spyOn(pluginModule, 'createRailgunKohakuSnapshotPlugin').mockImplementation((options) => {
    const actual = create(options);
    return {
      ...actual,
      balance: async (...args) =>
        (await actual.balance(...args)).map((item) => ({
          ...item,
          asset: f.read.received[0].asset,
        })),
    };
  });
  await expect(native.qualify(f)).rejects.toThrow();
});
test('waits held closed before borrowed reads and never closes the owner', async () => {
  let release, closedCalled;
  const entered = new Promise((resolve) => {
    closedCalled = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const create = pluginModule.createRailgunKohakuSnapshotPlugin;
  jest.spyOn(pluginModule, 'createRailgunKohakuSnapshotPlugin').mockImplementation((options) => {
    const actual = create(options);
    return {
      ...actual,
      closed: held,
      close() {
        actual.close();
        closedCalled();
      },
    };
  });
  let settled = false;
  const pending = native.qualify(f).finally(() => {
    settled = true;
  });
  await entered;
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.account.view.balance).not.toHaveBeenCalled();
  release();
  await pending;
  expect(f.account.close).not.toHaveBeenCalled();
});
test('throwing adapter close remains refusal and still observes closed', async () => {
  let observed = 0;
  const create = pluginModule.createRailgunKohakuSnapshotPlugin;
  jest.spyOn(pluginModule, 'createRailgunKohakuSnapshotPlugin').mockImplementation((options) => {
    const actual = create(options);
    return {
      ...actual,
      closed: {
        then(resolve, reject) {
          observed++;
          return actual.closed.then(resolve, reject);
        },
      },
      close() {
        actual.close();
        throw Error('close-fault');
      },
    };
  });
  await expect(native.qualify(f)).rejects.toThrow('close-fault');
  expect(observed).toBeGreaterThan(0);
  expect(f.account.close).not.toHaveBeenCalled();
});
test('borrowed owner closure cannot be passed off as adapter-only close', async () => {
  const create = pluginModule.createRailgunKohakuSnapshotPlugin;
  jest.spyOn(pluginModule, 'createRailgunKohakuSnapshotPlugin').mockImplementation((options) => {
    const actual = create(options);
    return {
      ...actual,
      close() {
        actual.close();
        mockRead.mockImplementation(() => {
          throw Error('Owner closed');
        });
      },
    };
  });
  await expect(native.qualify(f)).rejects.toThrow('Owner closed');
});
function installer(cached = []) {
  const source = fs.readFileSync(require.resolve('./railgun-kohaku-snapshot-native'), 'utf8');
  const signers = { getSigner: jest.fn(() => ({ exact: true })) },
    resources = { snapshot: () => ({ fixture: 1 }), close: jest.fn(async () => {}) };
  const resourceInstall = jest.fn(() => resources);
  const req = (name) => {
    if (name === './railgun-native-assertions') return { assert: require('assert/strict') };
    if (name === './railgun-kohaku-contract-observer')
      return { installResourceMeter: resourceInstall };
    if (name.endsWith('/signers')) return signers;
    return require(name);
  };
  req.resolve = (name) => name;
  req.cache = Object.fromEntries(cached.map((name) => ['../../src/main/wallet/' + name, {}]));
  const module = { exports: {} };
  vm.runInNewContext(source, { require: req, module, Buffer, AbortController });
  return { run: module.exports.install, signers, resourceInstall, resources };
}
test.each([
  'signers',
  'railgun-account-wallet',
  'railgun-kohaku-snapshot-host',
  'railgun-kohaku-snapshot-plugin',
])('late %s import refuses before provider installation', (name) => {
  const probe = installer([name]);
  expect(probe.run).toThrow('installed late');
  expect(probe.resourceInstall).not.toHaveBeenCalled();
});
test('signer wrapper delegates exact result and restores without allocating signer in installer', () => {
  const probe = installer(),
    original = probe.signers.getSigner;
  const installed = probe.run();
  expect(original).not.toHaveBeenCalled();
  const receiver = Object.freeze({ fixtureReceiver: true });
  const first = Object.freeze({ fixtureArgument: true }),
    second = Symbol('argument');
  const result = Reflect.apply(probe.signers.getSigner, receiver, [first, second]);
  expect(original.mock.contexts[0]).toBe(receiver);
  expect(original.mock.calls[0][0]).toBe(first);
  expect(original.mock.calls[0][1]).toBe(second);
  expect(result).toBe(original.mock.results[0].value);
  expect(installed.measure({ applications: 0, walletRestores: 0 }).signerFactories).toBe(1);
  installed.close();
  installed.close();
  expect(probe.signers.getSigner).toBe(original);
});
test('default-off selected inventory remains exact and cannot load snapshot fixture', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../qualify-railgun-wallet-journal.js'),
    'utf8'
  );
  const start = source.indexOf('  const sources = [') + '  const sources = '.length;
  const end = source.indexOf('\n  ];', start) + '\n  ]'.length;
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const expression = source.slice(start, end);
  const evaluate = (snapshotProbe) =>
    vm.runInNewContext(expression, {
      kohaku: null,
      publicShield: false,
      snapshotProbe,
      require: () => {
        throw Error('Unexpected off import');
      },
    });
  const off = evaluate(null),
    on = evaluate({});
  expect(
    off.some(
      (name) =>
        name.includes('snapshot-native') ||
        name.includes('snapshot-host') ||
        name.includes('snapshot-plugin')
    )
  ).toBe(false);
  expect(on.length - off.length).toBe(12);
  expect(on).toContain('src/main/wallet/railgun-kohaku-snapshot-host.js');
  expect(source).toContain("snapshotFlag === undefined || snapshotFlag === '1'");
  expect(source).toContain("snapshotProbe && stage === 30 && attempt === 'restore'");
});

test('signer restoration failure still drains provider meter', async () => {
  const probe = installer();
  const installed = probe.run();
  probe.signers.getSigner = () => null;
  await expect(installed.resources.close()).rejects.toThrow();
  expect(probe.resources.close).toHaveBeenCalledTimes(1);
});
test('healthy resource close restores signer before provider drain', async () => {
  const probe = installer(),
    original = probe.signers.getSigner;
  const installed = probe.run();
  probe.resources.close.mockImplementation(async () => {
    expect(probe.signers.getSigner).toBe(original);
  });
  await installed.resources.close();
  expect(probe.resources.close).toHaveBeenCalledTimes(1);
});
test('file measurement rejects symlink metadata without reading target', () => {
  fs.lstatSync.mockImplementation(() => ({ isDirectory: () => true, isSymbolicLink: () => true }));
  const before = mockInventory.mock.calls.length;
  expect(() => native.encryptedFiles(f.profile, f.walletDirectory)).toThrow();
  expect(mockInventory.mock.calls.length).toBe(before);
});

test('premature closed promise cannot qualify while actual admitted read remains pending', async () => {
  const create = pluginModule.createRailgunKohakuSnapshotPlugin;
  jest.spyOn(pluginModule, 'createRailgunKohakuSnapshotPlugin').mockImplementation((options) => {
    const actual = create(options);
    return { ...actual, closed: Promise.resolve() };
  });
  await expect(native.qualify(f)).rejects.toThrow('Adapter closed before admitted read settled');
  expect(f.account.close).not.toHaveBeenCalled();
});
test('probe revokes only its local genuine host lifetime while borrowed owners remain live', async () => {
  const hosts = require('../../src/main/wallet/railgun-kohaku-snapshot-host');
  const create = hosts.createRailgunKohakuSnapshotHost;
  let host;
  jest.spyOn(hosts, 'createRailgunKohakuSnapshotHost').mockImplementation((options) => {
    expect(options.account).toBe(f.account);
    expect(options.owners).toBe(f.owners);
    expect(options.signal).not.toBe(f.signal);
    host = create(options);
    return host;
  });
  const result = await native.qualify(f);
  expect(result.hostAbortRefusals).toBe(1);
  expect(host.signal.aborted).toBe(true);
  expect(() => host.capture()).toThrow('Kohaku snapshot host unavailable');
  expect(f.signal.aborted).toBe(false);
  expect(f.account.close).not.toHaveBeenCalled();
});
test('actual qualifier counts every broker entry before parsing, including non-key and malformed messages', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../qualify-railgun-wallet-journal.js'),
    'utf8'
  );
  const start = source.indexOf('async dispatch(wire) {') + 'async dispatch(wire) {'.length;
  const end = source.indexOf("if (message.method === 'key')", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const prefix = source.slice(start, end);
  const counts = [];
  const context = { messages: 0, snapshotProbe: { count: (key) => counts.push(key) } };
  const dispatch = vm.runInNewContext('(wire) => {' + prefix + '; return message; }', context);
  for (const method of ['key', 'txCommit', 'unknown'])
    expect(dispatch(JSON.stringify({ method })).method).toBe(method);
  expect(() => dispatch('malformed')).toThrow();
  expect(context.messages).toBe(4);
  expect(counts).toEqual(Array(4).fill('brokerMessages'));
  context.snapshotProbe = null;
  expect(dispatch('{"method":"off"}').method).toBe('off');
  expect(counts).toHaveLength(4);
});
