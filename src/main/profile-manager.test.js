// The profile manager's operations through freedom-cored's subcommands
// (freedom-core design 0013, PRF-4), with the binary's answers given.
// profile-manager.integration.test.js runs the real binary.

const packagedProfile = {
  id: 'home',
  displayName: 'Home',
  source: 'catalog',
  appRoot: '/data/Freedom',
  userDataDir: '/data/Freedom/Profiles/home',
  isDev: false,
  checkoutHash: null,
  metadata: { version: 1, id: 'home', displayName: 'Home', slot: 1, nodes: {} },
};

function load({ backend = 'core', activeProfile = packagedProfile, run, stale = false } = {}) {
  jest.resetModules();
  let active = activeProfile;
  const resolver = {
    getActiveProfile: jest.fn(() => active),
    profileCatalogBackend: jest.fn(() => backend),
    updateActiveProfileMetadata: jest.fn((metadata) => {
      active = { ...active, displayName: metadata.displayName || active.displayName, metadata };
      return active;
    }),
    getProfileFocusTargetForActiveApp: jest.fn((id) => ({
      id,
      displayName: 'Work',
      userDataDir: `/data/Freedom/Profiles/${id}`,
      isDev: false,
      isLocked: false,
    })),
    listProfilesForActiveApp: jest.fn(() => ['js-list']),
    createProfileForActiveApp: jest.fn(() => 'js-create'),
    importProfileForActiveApp: jest.fn(() => 'js-import'),
    renameProfileForActiveApp: jest.fn(() => 'js-rename'),
    updateActiveProfileNodeConfig: jest.fn(() => 'js-update'),
    updateActiveProfileNodeConfigWhenIdle: jest.fn(async () => 'js-update-idle'),
    getReservedProfilePorts: jest.fn(() => new Set([1])),
    deleteProfileForActiveApp: jest.fn(async () => 'js-delete'),
  };
  const subcommands = { run: run || jest.fn(async () => ({ result: null })) };
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  jest.doMock('electron', () => ({ app: { isPackaged: true } }), { virtual: true });
  jest.doMock('./profile-resolver', () => resolver);
  jest.doMock('./profile-subcommands', () => subcommands);
  jest.doMock('./profile-lock', () => ({ hasStaleProfileLock: jest.fn(() => stale) }));
  jest.doMock('./logger', () => log);
  jest.doMock('./core/cored-binary', () => ({ getCoredBinaryPath: () => '/bin/freedom-cored' }));
  jest.doMock('./service-locks', () => ({ getLockDir: () => '/data/Freedom/locks' }));
  const manager = require('./profile-manager');
  return { manager, resolver, run: subcommands.run, log, active: () => active };
}

const answer = (result) => jest.fn(async () => ({ result }));
const refusing = (error) =>
  jest.fn(async () => {
    throw error;
  });

afterEach(() => {
  jest.resetModules();
  jest.useRealTimers();
});

describe('the catalog operations, through the subcommands', () => {
  test('list names the active profile', async () => {
    const { manager, run } = load({ run: answer([{ id: 'home' }]) });
    await expect(manager.listProfiles()).resolves.toEqual([{ id: 'home' }]);
    expect(run).toHaveBeenCalledWith('/bin/freedom-cored', [
      'profile',
      'list',
      '--app-root',
      '/data/Freedom',
      '--active',
      'home',
    ], undefined);
  });

  test("create and import pass a dev build's checkout", async () => {
    const dev = { ...packagedProfile, isDev: true, checkoutHash: 'abcd0123' };
    const { manager, run } = load({ activeProfile: dev, run: answer({ record: { id: 'x' } }) });
    await manager.createProfile({ displayName: 'Lab', id: 'lab' });
    expect(run.mock.calls[0][1]).toEqual([
      'profile',
      'create',
      '--app-root',
      '/data/Freedom',
      '--dev',
      '--checkout-hash',
      'abcd0123',
      '--display-name',
      'Lab',
      '--id',
      'lab',
    ]);
    await manager.createProfile({ displayName: 'Lab' });
    expect(run.mock.calls[1][1]).not.toContain('--id');
    await manager.importProfile('old');
    expect(run.mock.calls[2][1]).toEqual([
      'profile',
      'import',
      '--app-root',
      '/data/Freedom',
      '--dev',
      '--checkout-hash',
      'abcd0123',
      '--id',
      'old',
    ]);
  });

  test("the active profile's rename and node settings update it in main", async () => {
    const metadata = { ...packagedProfile.metadata, displayName: 'Casa' };
    const { manager, run, resolver } = load({
      run: answer({ record: { id: 'home' }, metadata }),
    });
    await manager.renameProfile('home', 'Casa');
    expect(run.mock.calls[0][1]).toEqual([
      'profile',
      'rename',
      '--app-root',
      '/data/Freedom',
      '--id',
      'home',
      '--display-name',
      'Casa',
    ]);
    expect(resolver.updateActiveProfileMetadata).toHaveBeenCalledWith(metadata);

    await manager.updateNodeConfig('tor', { socksPort: 9150 });
    expect(run.mock.calls[1][1]).toEqual([
      'profile',
      'update-nodes',
      '--app-root',
      '/data/Freedom',
      '--id',
      'home',
      '--user-data-dir',
      '/data/Freedom/Profiles/home',
      '--protocol',
      'tor',
      '--updates',
      '{"socksPort":9150}',
      '--metadata',
      JSON.stringify({ ...packagedProfile.metadata, displayName: 'Casa' }),
    ]);
  });

  test("another profile's rename leaves the active one alone", async () => {
    const { manager, resolver } = load({ run: answer({ record: { id: 'work' }, metadata: {} }) });
    await manager.renameProfile('work', 'Job');
    expect(resolver.updateActiveProfileMetadata).not.toHaveBeenCalled();
  });

  test('a busy catalog is waited out for a node manager, up to its bound', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'busy' });
    let calls = 0;
    const run = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw busy;
      return { result: { metadata: { nodes: {} } } };
    });
    const { manager } = load({ run });
    await expect(
      manager.updateNodeConfigWhenIdle('bee', { apiPort: 1 }, { retryMs: 1 })
    ).resolves.toEqual({ metadata: { nodes: {} } });
    expect(run).toHaveBeenCalledTimes(3);

    const stuck = load({ run: refusing(busy) });
    await expect(
      stuck.manager.updateNodeConfigWhenIdle('bee', {}, { timeoutMs: 5, retryMs: 2 })
    ).rejects.toBe(busy);
    // Anything but busy isn't retried.
    const refused = Object.assign(new Error('nope'), { code: 'refused' });
    const once = load({ run: refusing(refused) });
    await expect(once.manager.updateNodeConfigWhenIdle('bee', {})).rejects.toBe(refused);
    expect(once.run).toHaveBeenCalledTimes(1);
  });

  test('reserved ports exclude the active profile, as a Set', async () => {
    const { manager, run } = load({ run: answer([11633, 12633, 'x']) });
    await expect(manager.getReservedPorts()).resolves.toEqual(new Set([11633, 12633]));
    expect(run.mock.calls[0][1]).toEqual([
      'profile',
      'reserved-ports',
      '--app-root',
      '/data/Freedom',
      '--exclude',
      'home',
    ]);
  });

  test('without a catalog there is nothing to do', async () => {
    const { manager, run } = load({
      activeProfile: { id: 'test', source: 'test-user-data', userDataDir: '/tmp/t' },
    });
    await expect(manager.listProfiles()).resolves.toBeNull();
    await expect(manager.createProfile({ displayName: 'x' })).resolves.toBeNull();
    await expect(manager.deleteProfile('x', 'X')).resolves.toBeNull();
    await expect(manager.getReservedPorts()).resolves.toEqual(new Set());
    expect(run).not.toHaveBeenCalled();
  });

  test('a development build without freedom-cored runs the JS reference', async () => {
    const { manager, resolver, run } = load({ backend: 'js' });
    await expect(manager.listProfiles()).resolves.toEqual(['js-list']);
    await expect(manager.createProfile({ displayName: 'x' })).resolves.toBe('js-create');
    await expect(manager.importProfile('x')).resolves.toBe('js-import');
    await expect(manager.renameProfile('x', 'X')).resolves.toBe('js-rename');
    await expect(manager.updateNodeConfig('tor', {})).resolves.toBe('js-update');
    await expect(manager.updateNodeConfigWhenIdle('tor', {})).resolves.toBe('js-update-idle');
    await expect(manager.getReservedPorts()).resolves.toEqual(new Set([1]));
    const gates = { withCoreGate: jest.fn() };
    await expect(manager.deleteProfile('work', 'Work', gates)).resolves.toBe('js-delete');
    expect(resolver.deleteProfileForActiveApp).toHaveBeenCalledWith('work', 'Work', gates);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('deletion through profile delete', () => {
  test('runs unbounded under every gate, and logs the items to forget', async () => {
    const { manager, run, log } = load({
      run: answer({ catalog: {}, record: { id: 'work' }, forget: [{ policy: 'p', item: 'a'.repeat(32) }] }),
    });
    await expect(manager.deleteProfile('work', 'Work')).resolves.toEqual(
      expect.objectContaining({ record: { id: 'work' } })
    );
    expect(run.mock.calls[0][1]).toEqual([
      'profile',
      'delete',
      '--app-root',
      '/data/Freedom',
      '--lock-dir',
      '/data/Freedom/locks',
      '--id',
      'work',
      '--confirm-display-name',
      'Work',
    ]);
    expect(run.mock.calls[0][2]).toEqual({ timeoutMs: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('key-store items'),
      expect.objectContaining({ items: 1 })
    );
  });

  test('the active profile is refused before anything runs', async () => {
    const { manager, run } = load();
    await expect(manager.deleteProfile('home', 'Home')).rejects.toThrow(
      'The active profile cannot be deleted'
    );
    expect(run).not.toHaveBeenCalled();
  });

  test('a held gate refuses it, saying which', async () => {
    const held = (gate) => Object.assign(new Error('x'), { code: 'lock_held', gate });
    for (const [gate, text] of [
      ['profile', 'Profile is currently open: Work'],
      ['core', "The profile's identity data is in use"],
      ['ipfs', 'The IPFS data is in use'],
      ['radicle', 'The Radicle data is in use'],
    ]) {
      const { manager } = load({ run: refusing(held(gate)) });
      await expect(manager.deleteProfile('work', 'Work')).rejects.toEqual(
        expect.objectContaining({ code: 'lock_held', gate, message: expect.stringContaining(text) })
      );
    }
    const refused = Object.assign(new Error('Profile display name confirmation did not match'), {
      code: 'refused',
    });
    const { manager } = load({ run: refusing(refused) });
    await expect(manager.deleteProfile('work', 'Wrong')).rejects.toBe(refused);
  });
});

describe('"open": a fresh lock, or a stale one with the gate held', () => {
  test('a fresh lock reads open without asking', async () => {
    const { manager, resolver, run } = load();
    resolver.getProfileFocusTargetForActiveApp.mockReturnValue({ id: 'work', isLocked: true });
    await expect(manager.getProfileFocusTarget('work')).resolves.toEqual(
      expect.objectContaining({ isLocked: true })
    );
    expect(run).not.toHaveBeenCalled();
  });

  test('no lock at all reads closed without asking', async () => {
    const { manager, run } = load({ stale: false });
    await expect(manager.getProfileFocusTarget('work')).resolves.toEqual(
      expect.objectContaining({ isLocked: false })
    );
    expect(run).not.toHaveBeenCalled();
  });

  test('a stale lock is asked about: its gate held reads open', async () => {
    const { manager, run } = load({
      stale: true,
      run: answer([{ user_data_dir: '/p', open: true, lock_fresh: false, gate_held: true }]),
    });
    await expect(manager.getProfileFocusTarget('work')).resolves.toEqual(
      expect.objectContaining({ isLocked: true })
    );
    expect(run.mock.calls[0][1]).toEqual([
      'profile',
      'status',
      '--lock-dir',
      '/data/Freedom/locks',
      '--user-data-dir',
      '/data/Freedom/Profiles/work',
    ]);

    const free = load({
      stale: true,
      run: answer([{ user_data_dir: '/p', open: false, lock_fresh: false, gate_held: false }]),
    });
    await expect(free.manager.getProfileFocusTarget('work')).resolves.toEqual(
      expect.objectContaining({ isLocked: false })
    );

    const failing = load({ stale: true, run: refusing(Object.assign(new Error('x'), { code: 'failed' })) });
    await expect(failing.manager.getProfileFocusTarget('work')).resolves.toEqual(
      expect.objectContaining({ isLocked: true })
    );
  });

  test("without the core there is no gate: a stale lock reads closed, as before", async () => {
    const { manager, run } = load({ backend: 'js', stale: true });
    await expect(manager.getProfileFocusTarget('work')).resolves.toEqual(
      expect.objectContaining({ isLocked: false })
    );
    expect(run).not.toHaveBeenCalled();
  });

  test("a profile that has quit is waited on until its gate is free", async () => {
    let calls = 0;
    const run = jest.fn(async () => {
      calls += 1;
      return { result: [{ gate_held: calls < 3 }] };
    });
    const { manager } = load({ run });
    const target = { userDataDir: '/p/work', isDev: true };
    await expect(
      manager.waitForProfileGateFree(target, { deadline: Date.now() + 5_000, intervalMs: 1 })
    ).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0][1]).toContain('--dev');

    const held = load({ run: answer([{ gate_held: true }]) });
    await expect(
      held.manager.waitForProfileGateFree(target, { deadline: Date.now() + 20, intervalMs: 5 })
    ).resolves.toBe(false);
  });
});
