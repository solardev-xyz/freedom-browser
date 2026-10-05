const fs = require('fs');
const path = require('path');
const {
  createAppMock,
  createTempUserDataDir,
  removeTempUserDataDir,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function loadMigrationModule(userDataDir, options = {}) {
  return loadMainModule(require.resolve('./migrate-user-data'), {
    app: createAppMock({ isPackaged: options.isPackaged ?? true, userDataDir }),
    extraMocks: {
      [require.resolve('./logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    },
  }).mod;
}

function writeBeeData(userDataDir, { withKeystore = true, extras = [] } = {}) {
  const beeData = path.join(userDataDir, 'bee-data');
  fs.mkdirSync(path.join(beeData, 'keys'), { recursive: true });
  if (withKeystore) {
    fs.writeFileSync(path.join(beeData, 'keys', 'swarm.key'), '{"version":3}');
  }
  fs.writeFileSync(path.join(beeData, 'config.yaml'), 'password: bee-era-password\n');
  for (const extra of extras) {
    fs.mkdirSync(path.join(beeData, extra), { recursive: true });
    fs.writeFileSync(path.join(beeData, extra, 'data'), 'x');
  }
  return beeData;
}

describe('migrateBeeDataToAntData (bee → ant upgrade)', () => {
  let userDataDir;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
    delete process.env.FREEDOM_ANT_DATA;
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
    delete process.env.FREEDOM_ANT_DATA;
  });

  test('renames bee-data to ant-data when ant-data does not exist', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(true);

    const antData = path.join(userDataDir, 'ant-data');
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(false);
  });

  test('uses the active profile userData directory in dev mode', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    const mod = loadMigrationModule(userDataDir, { isPackaged: false });

    expect(mod.isBeeDataMigrationPending()).toBe(true);
    expect(mod.migrateBeeDataToAntData()).toBe(true);

    expect(fs.existsSync(path.join(userDataDir, 'ant-data', 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(false);
  });

  test('drops Bee-only LevelDB state but keeps stamperstore', () => {
    writeBeeData(userDataDir, {
      extras: ['statestore', 'localstore', 'kademlia-metrics', 'stamperstore'],
    });
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(true);

    const antData = path.join(userDataDir, 'ant-data');
    expect(fs.existsSync(path.join(antData, 'statestore'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'localstore'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'kademlia-metrics'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
  });

  test('merges into existing ant-data and removes antd self-generated identity', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    // antd already ran once on the empty dir and self-initialized.
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(antData, { recursive: true });
    fs.writeFileSync(path.join(antData, 'identity.json'), '{}');
    fs.writeFileSync(path.join(antData, 'signing.key'), 'throwaway');
    fs.writeFileSync(path.join(antData, 'config.yaml'), 'password: throwaway-password\n');

    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(true);

    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    // The injected keystore's password must win over the throwaway config.
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );
    expect(fs.existsSync(path.join(antData, 'identity.json'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'signing.key'))).toBe(false);
  });

  test('does nothing when bee-data has no injected keystore', () => {
    writeBeeData(userDataDir, { withKeystore: false });
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'ant-data'))).toBe(false);
  });

  test('does nothing when bee-data does not exist', () => {
    const mod = loadMigrationModule(userDataDir);
    expect(mod.migrateBeeDataToAntData()).toBe(false);
  });

  test('never clobbers an already-injected ant-data identity', () => {
    writeBeeData(userDataDir);
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(path.join(antData, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(antData, 'keys', 'swarm.key'), '{"version":3,"already":"injected"}');

    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.readFileSync(path.join(antData, 'keys', 'swarm.key'), 'utf-8')).toContain('already');
    expect(fs.existsSync(path.join(userDataDir, 'bee-data', 'keys', 'swarm.key'))).toBe(true);
  });

  test('is skipped entirely under the FREEDOM_ANT_DATA test override', () => {
    writeBeeData(userDataDir);
    process.env.FREEDOM_ANT_DATA = path.join(userDataDir, 'throwaway');
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(true);
  });

  test('is idempotent: second run is a no-op', () => {
    writeBeeData(userDataDir);
    const mod = loadMigrationModule(userDataDir);

    expect(mod.migrateBeeDataToAntData()).toBe(true);
    expect(mod.migrateBeeDataToAntData()).toBe(false);
  });

  test('a mid-merge failure before the keystore moves is retried cleanly on next launch', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    // Force the merge path by pre-creating ant-data.
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(antData, { recursive: true });
    fs.writeFileSync(path.join(antData, 'identity.json'), '{}');

    const mod = loadMigrationModule(userDataDir);

    // Simulate a Windows-EPERM-style failure on the stamperstore move. The
    // keystore moves last, so it must still be in bee-data afterwards and the
    // retry precondition must hold.
    const realRename = fs.renameSync.bind(fs);
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (String(src).includes('stamperstore')) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return realRename(src, dest);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data', 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(false);
    // config.yaml moved before the failure — the retry must tolerate that.
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );

    // Next launch: the lock is gone and the migration completes.
    spy.mockRestore();
    expect(mod.migrateBeeDataToAntData()).toBe(true);
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );
    expect(fs.existsSync(path.join(antData, 'identity.json'))).toBe(false);
  });

  test('a failure removing the stale antd identity keeps the migration retryable', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    // antd already self-initialized on the existing ant-data → merge path.
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(antData, { recursive: true });
    fs.writeFileSync(path.join(antData, 'identity.json'), '{}');
    fs.writeFileSync(path.join(antData, 'signing.key'), 'throwaway');

    const mod = loadMigrationModule(userDataDir);

    // Simulate a locked identity.json (Windows EPERM). The stale identity is
    // removed before the keystore moves — the commit point that clears the
    // retry precondition — so the migration must still be pending afterwards.
    // If it weren't, antd would keep the throwaway identity with no retry.
    const realRm = fs.rmSync.bind(fs);
    const spy = jest.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
      if (String(target).endsWith('identity.json')) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return realRm(target, opts);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data', 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(false);
    expect(mod.isBeeDataMigrationPending()).toBe(true);

    // Next launch: the lock is gone and the migration completes.
    spy.mockRestore();
    expect(mod.migrateBeeDataToAntData()).toBe(true);
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'identity.json'))).toBe(false);
    expect(fs.existsSync(path.join(antData, 'signing.key'))).toBe(false);
    expect(mod.isBeeDataMigrationPending()).toBe(false);
  });

  test('a locked Bee-only directory does not fail the completed migration', () => {
    writeBeeData(userDataDir, { extras: ['statestore', 'stamperstore'] });
    const mod = loadMigrationModule(userDataDir);

    // The Bee-only cleanup runs after the keystore landed; a stray lock on
    // dead LevelDB cache must not report the identity migration as failed —
    // neither the set-aside rename nor its in-place fallback.
    const lockErr = (code) =>
      Object.assign(new Error(`${code}: resource busy or locked`), { code });
    const realRename = fs.renameSync.bind(fs);
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (String(src).endsWith('statestore')) throw lockErr('EBUSY');
      return realRename(src, dest);
    });
    const realRm = fs.rmSync.bind(fs);
    const rmSpy = jest.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
      if (String(target).endsWith('statestore')) throw lockErr('EBUSY');
      return realRm(target, opts);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(true);
    renameSpy.mockRestore();
    rmSpy.mockRestore();

    const antData = path.join(userDataDir, 'ant-data');
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    expect(mod.isBeeDataMigrationPending()).toBe(false);
  });

  // #526: the delete of Bee-only state used to run synchronously before the
  // first window. The migration now only renames it aside; the delete runs
  // in a worker once the window is up.
  describe('Bee-only state is set aside, then purged off the main thread', () => {
    const SET_ASIDE = '.bee-only-data-pending-delete';
    const BEE_ONLY = ['statestore', 'localstore', 'kademlia-metrics'];

    // jest.resetModules() keeps doMock registrations; don't let one test's
    // fs-offload stub leak into the real-worker test.
    afterEach(() => {
      jest.dontMock(require.resolve('./fs-offload'));
    });

    test('the migration renames Bee-only dirs aside and never rmSyncs them', () => {
      writeBeeData(userDataDir, { extras: [...BEE_ONLY, 'stamperstore'] });
      const mod = loadMigrationModule(userDataDir);
      const rmSpy = jest.spyOn(fs, 'rmSync');

      expect(mod.migrateBeeDataToAntData()).toBe(true);
      const rmTargets = rmSpy.mock.calls.map(([target]) => path.basename(String(target)));
      rmSpy.mockRestore();

      expect(rmTargets.filter((name) => BEE_ONLY.includes(name))).toEqual([]);
      const antData = path.join(userDataDir, 'ant-data');
      for (const dir of BEE_ONLY) {
        expect(fs.existsSync(path.join(antData, dir))).toBe(false);
      }
      const setAside = fs.readdirSync(path.join(userDataDir, SET_ASIDE));
      for (const dir of BEE_ONLY) {
        expect(setAside.filter((name) => name.startsWith(`${dir}-`))).toHaveLength(1);
      }
      // Moved, not copied: the contents came along.
      const localstore = setAside.find((name) => name.startsWith('localstore-'));
      expect(fs.readFileSync(path.join(userDataDir, SET_ASIDE, localstore, 'data'), 'utf-8')).toBe(
        'x'
      );
      expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    });

    test('the merge path sets aside too, next to an earlier un-purged set-aside', () => {
      // Leftover from a launch that quit before its purge finished.
      const leftover = path.join(userDataDir, SET_ASIDE, 'statestore-1-1');
      fs.mkdirSync(leftover, { recursive: true });
      writeBeeData(userDataDir, { extras: ['statestore', 'stamperstore'] });
      const antData = path.join(userDataDir, 'ant-data');
      fs.mkdirSync(antData, { recursive: true });
      fs.writeFileSync(path.join(antData, 'identity.json'), '{}');
      // antd's own statestore from its throwaway identity: dropped on the
      // merge path, as before — now by moving it aside.
      fs.mkdirSync(path.join(antData, 'statestore'));
      fs.writeFileSync(path.join(antData, 'statestore', 'CURRENT'), 'antd');
      const mod = loadMigrationModule(userDataDir);

      expect(mod.migrateBeeDataToAntData()).toBe(true);
      expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
      expect(fs.existsSync(path.join(antData, 'statestore'))).toBe(false);
      const setAside = fs.readdirSync(path.join(userDataDir, SET_ASIDE));
      expect(setAside).toHaveLength(2);
      expect(setAside).toContain('statestore-1-1');
      const fresh = setAside.find((name) => name !== 'statestore-1-1');
      expect(fs.readFileSync(path.join(userDataDir, SET_ASIDE, fresh, 'CURRENT'), 'utf-8')).toBe(
        'antd'
      );
    });

    test('a failed set-aside rename falls back to deleting in place', () => {
      writeBeeData(userDataDir, { extras: ['localstore', 'stamperstore'] });
      const mod = loadMigrationModule(userDataDir);
      const realRename = fs.renameSync.bind(fs);
      const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
        if (String(dest).includes(SET_ASIDE)) {
          throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
        }
        return realRename(src, dest);
      });

      expect(mod.migrateBeeDataToAntData()).toBe(true);
      renameSpy.mockRestore();

      expect(fs.existsSync(path.join(userDataDir, 'ant-data', 'localstore'))).toBe(false);
      expect(fs.existsSync(path.join(userDataDir, 'ant-data', 'keys', 'swarm.key'))).toBe(true);
    });

    test('purgeSetAsideBeeData removes the set-aside dir through fs-offload', async () => {
      writeBeeData(userDataDir, { extras: [...BEE_ONLY, 'stamperstore'] });
      const removePath = jest.fn((target, options) => {
        fs.rmSync(target, options);
        return Promise.resolve();
      });
      const mod = loadMainModule(require.resolve('./migrate-user-data'), {
        app: createAppMock({ isPackaged: true, userDataDir }),
        extraMocks: {
          [require.resolve('./logger')]: () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
          }),
          [require.resolve('./fs-offload')]: () => ({ removePath }),
        },
      }).mod;

      expect(mod.migrateBeeDataToAntData()).toBe(true);
      expect(removePath).not.toHaveBeenCalled();
      await expect(mod.purgeSetAsideBeeData()).resolves.toBe(true);

      expect(removePath).toHaveBeenCalledTimes(1);
      expect(removePath).toHaveBeenCalledWith(path.join(userDataDir, SET_ASIDE), {
        recursive: true,
        force: true,
      });
      expect(fs.existsSync(path.join(userDataDir, SET_ASIDE))).toBe(false);
      // Only the set-aside went: the migrated identity is untouched.
      expect(fs.existsSync(path.join(userDataDir, 'ant-data', 'keys', 'swarm.key'))).toBe(true);
      expect(fs.existsSync(path.join(userDataDir, 'ant-data', 'stamperstore'))).toBe(true);
    });

    test('purgeSetAsideBeeData deletes for real in a worker (real fs-offload)', async () => {
      writeBeeData(userDataDir, { extras: ['localstore', 'statestore'] });
      const mod = loadMigrationModule(userDataDir);
      expect(mod.migrateBeeDataToAntData()).toBe(true);
      const rmSpy = jest.spyOn(fs, 'rmSync');

      await expect(mod.purgeSetAsideBeeData()).resolves.toBe(true);
      const mainThreadRms = rmSpy.mock.calls.length;
      rmSpy.mockRestore();

      expect(mainThreadRms).toBe(0);
      expect(fs.existsSync(path.join(userDataDir, SET_ASIDE))).toBe(false);
    });

    test('purgeSetAsideBeeData is a no-op without a set-aside dir', async () => {
      const removePath = jest.fn();
      const mod = loadMainModule(require.resolve('./migrate-user-data'), {
        app: createAppMock({ isPackaged: true, userDataDir }),
        extraMocks: {
          [require.resolve('./logger')]: () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
          }),
          [require.resolve('./fs-offload')]: () => ({ removePath }),
        },
      }).mod;

      await expect(mod.purgeSetAsideBeeData()).resolves.toBe(false);
      expect(removePath).not.toHaveBeenCalled();
    });

    test('a failed purge resolves false and leaves the dir for the next launch', async () => {
      const leftover = path.join(userDataDir, SET_ASIDE, 'localstore-1-1');
      fs.mkdirSync(leftover, { recursive: true });
      const warn = jest.fn();
      const removePath = jest.fn(() =>
        Promise.reject(Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' }))
      );
      const mod = loadMainModule(require.resolve('./migrate-user-data'), {
        app: createAppMock({ isPackaged: true, userDataDir }),
        extraMocks: {
          [require.resolve('./logger')]: () => ({ info: jest.fn(), warn, error: jest.fn() }),
          [require.resolve('./fs-offload')]: () => ({ removePath }),
        },
      }).mod;

      await expect(mod.purgeSetAsideBeeData()).resolves.toBe(false);
      expect(fs.existsSync(leftover)).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('will retry'), 'EBUSY: locked');
    });
  });

  test('isBeeDataMigrationPending tracks the migration lifecycle', () => {
    const mod = loadMigrationModule(userDataDir);

    // Nothing to migrate yet.
    expect(mod.isBeeDataMigrationPending()).toBe(false);

    // Bee-era keystore present, ant-data empty → pending.
    writeBeeData(userDataDir);
    expect(mod.isBeeDataMigrationPending()).toBe(true);

    // Suppressed under the throwaway-data-dir test override.
    process.env.FREEDOM_ANT_DATA = path.join(userDataDir, 'throwaway');
    expect(mod.isBeeDataMigrationPending()).toBe(false);
    delete process.env.FREEDOM_ANT_DATA;

    // Cleared once the migration completes.
    expect(mod.migrateBeeDataToAntData()).toBe(true);
    expect(mod.isBeeDataMigrationPending()).toBe(false);
  });

  test('falls back to item-by-item carry when the whole-directory rename fails', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore', 'statestore'] });
    const mod = loadMigrationModule(userDataDir);

    const antData = path.join(userDataDir, 'ant-data');
    const realRename = fs.renameSync.bind(fs);
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      // Fail only the whole-directory rename, not the per-item carries.
      if (String(src).endsWith('bee-data') && String(dest).endsWith('ant-data')) {
        const err = new Error('EXDEV: cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      }
      return realRename(src, dest);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(true);
    spy.mockRestore();

    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.existsSync(path.join(antData, 'stamperstore'))).toBe(true);
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(
      'bee-era-password'
    );
    // Bee-only state is never carried by the item list.
    expect(fs.existsSync(path.join(antData, 'statestore'))).toBe(false);
  });

  test('moves the keystore LAST on the merge path so an interrupt is always retryable', () => {
    writeBeeData(userDataDir, { extras: ['stamperstore'] });
    // Force the merge path: ant-data already exists (antd self-initialized),
    // so the whole-directory fast rename is skipped and items are carried
    // one by one in BEE_CARRY_ITEMS order.
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(antData, { recursive: true });
    fs.writeFileSync(path.join(antData, 'identity.json'), '{}');

    const mod = loadMigrationModule(userDataDir);

    const moveOrder = [];
    const realRename = fs.renameSync.bind(fs);
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (String(src).includes(`${path.sep}bee-data${path.sep}`)) {
        moveOrder.push(path.basename(String(src)));
      }
      return realRename(src, dest);
    });

    expect(mod.migrateBeeDataToAntData()).toBe(true);
    spy.mockRestore();

    // keys/ is the commit point that clears isBeeDataMigrationPending(): it
    // MUST move after config.yaml and stamperstore. If a refactor reordered
    // BEE_CARRY_ITEMS so keys moved earlier, an interrupted carry could strand
    // a keystore in ant-data whose password is still in bee-data, with no
    // retry — silently abandoning a funded identity. This locks the ordering.
    expect(moveOrder).toEqual(['config.yaml', 'stamperstore', 'keys']);
    expect(moveOrder[moveOrder.length - 1]).toBe('keys');
  });
});
