let mockEnrollment, mockCreateCoordinator, mockSource, mockJobs;
const mockOpen = jest.fn(),
  mockAuthorities = new WeakSet();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-account-store', () => ({
  openRailgunAccountStore: (...args) => mockOpen(...args),
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'a'.repeat(64) }));
jest.mock('./railgun-public-run', () => ({ createRailgunPublicJobs: () => mockJobs }));
jest.mock('./railgun-scan-source', () => ({
  createRailgunScanSource: (options) => {
    mockSource = { ...options, close: jest.fn(), signal: options.ledger.signal };
    return mockSource;
  },
}));
jest.mock('./railgun-scan-coordinator', () => ({
  createRailgunScanCoordinator: (...args) => mockCreateCoordinator(...args),
  assertRailgunScanCoordinator: (v) => {
    if (!mockAuthorities.has(v) || v.signal.aborted) throw Error('coordinator');
  },
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { getPrivacyStoragePath } = require('./privacy-storage');
const {
  openRailgunAccountPublic,
  assertRailgunAccountPublic,
} = require('./railgun-account-public');
let scope, stores, controllers, opened, metadata, publicRecords, coordinatorOptions, journalPath;
beforeEach(() => {
  jest.clearAllMocks();
  stores = [];
  controllers = [];
  opened = [];
  metadata = 0;
  publicRecords = 0;
  scope = createPrivacyScope({
    profileId: 'account-public-test',
    signal: new AbortController().signal,
  });
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-account-public-'))
  );
  mockEnrollment = {
    directory,
    binding: 'b'.repeat(64),
    signal: scope.signal,
    getContext: (role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        ...(operation ? { operation } : {}),
      }),
    profileGuard: { assert: jest.fn() },
    withPublicKeys: async (use) => {
      const key = Buffer.alloc(32, 5);
      try {
        return await use({ 'scan-journal': key });
      } finally {
        key.fill(0);
      }
    },
  };
  journalPath = getPrivacyStoragePath(
    mockEnrollment.getContext('storage', 'railgun-scan-v1'),
    directory
  );
  mockOpen.mockImplementation(async ({ kind, create }) => {
    const filename = path.join(directory, kind + '.sqlite');
    if (create) fs.writeFileSync(filename, 'fixture');
    const controller = new AbortController();
    controllers.push(controller);
    let done;
    const closed = new Promise((resolve) => {
      done = resolve;
    });
    const session = {
      signal: controller.signal,
      closed,
      close: jest.fn(() => {
        controller.abort();
        done();
      }),
      inspectWalletState: async () => ({ count: publicRecords, bytes: publicRecords }),
      assertFresh: jest.fn(),
    };
    const ledger = {
      signal: controller.signal,
      assertEmpty: () => {
        if (metadata) throw Error('nonempty ledger');
      },
      close: () => session.close(),
    };
    const value = { session, ledger, storeId: (kind === 'source' ? '1' : '2').repeat(64) };
    stores.push(value);
    return value;
  });
  mockJobs = { project: jest.fn(async () => ({})), apply: jest.fn(async () => ({})) };
  mockCreateCoordinator = jest.fn(async (options) => {
    coordinatorOptions = options;
    fs.writeFileSync(journalPath, 'fixture');
    const controller = new AbortController();
    controllers.push(controller);
    const coordinator = {
      signal: controller.signal,
      close: () => {
        controller.abort();
        options.storeSession.close();
      },
    };
    mockAuthorities.add(coordinator);
    return coordinator;
  });
});
afterEach(async () => {
  await Promise.all(opened.map((v) => v.close()));
  scope.close();
});
async function open(create = false) {
  const result = await openRailgunAccountPublic({
    enrollment: mockEnrollment,
    archive: '/engine.asar',
    create,
  });
  opened.push(result);
  return result;
}
test('initializes only absent components, pins journal policy and attests only its own live coordinator', async () => {
  await expect(open()).rejects.toThrow();
  const first = await open(true);
  expect(mockOpen.mock.calls.map(([v]) => [v.kind, v.create])).toEqual([
    ['source', true],
    ['public', true],
  ]);
  expect(coordinatorOptions.journalStorage).toMatchObject({
    binding: mockEnrollment.binding,
    policy: first.policy,
    create: true,
  });
  expect(coordinatorOptions.journalStorage.key.every((v) => v === 0)).toBe(true);
  expect(assertRailgunAccountPublic(first.coordinator, mockEnrollment, first.policy)).toBe(
    first.policy
  );
  expect(() => assertRailgunAccountPublic({ ...first.coordinator }, mockEnrollment)).toThrow();
  expect(() =>
    assertRailgunAccountPublic(first.coordinator, mockEnrollment, 'c'.repeat(64))
  ).toThrow();
  await expect(open(true)).rejects.toThrow();
  await first.close();
  expect(() => assertRailgunAccountPublic(first.coordinator, mockEnrollment)).toThrow();
  const second = await open();
  expect(coordinatorOptions.journalStorage.create).toBe(false);
  await first.close();
  await expect(open()).rejects.toThrow();
  await second.close();
});
test.each(['source', 'public'])(
  'refuses a missing unregistered journal over nonempty %s state',
  async (kind) => {
    if (kind === 'source') metadata = 1;
    else publicRecords = 1;
    await expect(open(true)).rejects.toThrow();
    expect(mockCreateCoordinator).not.toHaveBeenCalled();
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(stores.every((v) => v.session.signal.aborted)).toBe(true);
  }
);
test('partial initialization resumes existing stores and never replaces them', async () => {
  fs.writeFileSync(path.join(mockEnrollment.directory, 'source.sqlite'), 'retained');
  await open(true);
  expect(mockOpen.mock.calls.map(([v]) => [v.kind, v.create])).toEqual([
    ['source', false],
    ['public', true],
  ]);
  expect(fs.readFileSync(path.join(mockEnrollment.directory, 'source.sqlite'), 'utf8')).toBe(
    'retained'
  );
});
test('closure drains a still-finishing job before releasing the account owner', async () => {
  const first = await open(true);
  let finish, started;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  mockJobs.project.mockImplementation(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const project = mockSource.projectRange({}, {});
  await running;
  let closed = false;
  const close = first.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  await expect(open()).rejects.toThrow();
  finish({});
  await project;
  await close;
  expect(stores.every((v) => v.session.signal.aborted)).toBe(true);
  await open();
});
test.each([0, 1])(
  'worker %s revocation closes the other worker and coordinator automatically',
  async (index) => {
    const first = await open(true);
    stores[index].session.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.signal.aborted).toBe(true);
    expect(first.coordinator.signal.aborted).toBe(true);
    expect(stores.every((v) => v.session.signal.aborted)).toBe(true);
  }
);
test('revocation during store opening drains a late worker before releasing ownership', async () => {
  let release, begun;
  const ready = new Promise((resolve) => {
    begun = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const original = mockOpen.getMockImplementation();
  mockOpen.mockImplementation(async (options) => {
    const result = await original(options);
    if (options.kind === 'public') {
      begun();
      await gate;
    }
    return result;
  });
  const opening = open(true);
  opening.catch(() => {});
  await ready;
  stores[0].session.close();
  await expect(open(true)).rejects.toThrow();
  expect(stores[1].session.signal.aborted).toBe(false);
  release();
  await expect(opening).rejects.toThrow();
  expect(stores.every((v) => v.session.signal.aborted)).toBe(true);
  mockOpen.mockImplementation(original);
  await open(true);
});
