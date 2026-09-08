/**
 * End-to-end v0.8.0 upgrade-path integration test (issue #107).
 *
 * Takes a realistic v0.7.x on-disk layout — a flat, pre-profile packaged
 * userData directory with a Bee-era Swarm node identity — and drives the
 * startup migration sequence index.js performs for the structural v0.8.0
 * changes:
 *
 *   1. initializeProfile()       — the pre-profile flat userData becomes the
 *                                  default profile *in place* (no file move),
 *                                  creating the catalog + profile.json
 *   2. migrateBeeDataToAntData() — bee-data/ → ant-data/, Swarm identity +
 *                                  postage stamps preserved (Bee → Ant swap)
 *   3. loadSettings()            — beeNodeMode→antNodeMode key rename
 *   4. network-registry load()   — legacy ENS settings → network-config.json
 *   5. IPFS (Kubo → freedom-ipfs) — no Kubo repo carryover; native node uses
 *                                  an isolated freedom-ipfs/ subdir
 *
 * The contract under test: an upgrading user keeps their bookmarks, history,
 * identity vault, Swarm keystore + postage stamps (stamperstore), and
 * permissions, the default profile + catalog are created in place, and no
 * data is lost anywhere along the chain. Each step runs against the real
 * filesystem; only Electron's `app`/logger are mocked.
 *
 * The separate "Freedom Browser" → "Freedom" userData rename
 * (migrateUserData()) predates this repository and is a no-op for every
 * version Freedom has shipped, so it is intentionally NOT part of this
 * upgrade scenario.
 */

const fs = require('fs');
const path = require('path');
const {
  createAppMock,
  createTempUserDataDir,
  removeTempUserDataDir,
  loadMainModule,
} = require('../../../../test/helpers/main-process-test-utils');

const NOW = '2026-06-16T00:00:00.000Z';
const BEE_PASSWORD = 'bee-era-keystore-password';
const SWARM_KEYSTORE = '{"version":3,"address":"abc123"}';

const silentLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

// Loads a main-process module fresh against the real on-disk `userDataDir`.
// Each call re-mocks Electron so the module sees `userDataDir` as userData
// while operating on actual files, letting the migration chain hand state
// from one step to the next exactly as it does at startup.
function loadModule(relModulePath, userDataDir, { isPackaged = true } = {}) {
  return loadMainModule(require.resolve(relModulePath), {
    app: createAppMock({ isPackaged, userDataDir }),
    extraMocks: {
      [require.resolve('../../logger')]: () => silentLogger(),
    },
  });
}

// Writes a believable pre-upgrade v0.7.x flat userData tree: the user's
// settings (with Bee-era keys + legacy ENS policy), bookmarks, history,
// identity vault, the injected Swarm keystore + postage stamps, and the
// Swarm/dApp permission stores — all directly under userData, with no
// profile catalog yet (the pre-profile layout).
function writeLegacyInstall(dir, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      theme: 'dark',
      beeNodeMode: 'light',
      startBeeAtLaunch: false,
      enableEnsCustomRpc: true,
      ensRpcUrl: 'https://my-eth-rpc.example',
      ...overrides.settings,
    })
  );

  fs.writeFileSync(
    path.join(dir, 'user-bookmarks.json'),
    JSON.stringify([{ url: 'bzz://feed', name: 'My Swarm Feed' }])
  );
  fs.writeFileSync(path.join(dir, 'history.sqlite'), 'SQLite format 3\u0000history-rows');

  // The identity vault (the mnemonic that regenerates the Bee overlay wallet
  // and Swarm feed publisher keys) lives at identity/identity-vault.json.
  fs.mkdirSync(path.join(dir, 'identity'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'identity', 'identity-vault.json'),
    JSON.stringify({ version: 1, encrypted: 'encrypted-seed-vault' })
  );

  fs.writeFileSync(
    path.join(dir, 'swarm-permissions.json'),
    JSON.stringify({ 'bzz://feed': 'granted' })
  );
  fs.writeFileSync(
    path.join(dir, 'dapp-permissions.json'),
    JSON.stringify({ 'https://app.example': { accounts: ['0xabc'] } })
  );

  // Bee-era node data: injected keystore + the config that decrypts it,
  // postage stamps (kept), and dead LevelDB state (dropped on migration).
  const beeData = path.join(dir, 'bee-data');
  fs.mkdirSync(path.join(beeData, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(beeData, 'keys', 'swarm.key'), SWARM_KEYSTORE);
  fs.writeFileSync(path.join(beeData, 'config.yaml'), `password: ${BEE_PASSWORD}\n`);
  fs.mkdirSync(path.join(beeData, 'stamperstore'), { recursive: true });
  fs.writeFileSync(path.join(beeData, 'stamperstore', 'batch'), 'postage-batch-data');
  fs.mkdirSync(path.join(beeData, 'statestore'), { recursive: true });
  fs.writeFileSync(path.join(beeData, 'statestore', 'CURRENT'), 'leveldb');
}

// Runs the index.js startup migration chain against the flat userData dir and
// returns the resolved default profile.
function runUpgrade(userDataDir) {
  const resolver = loadModule('../../profile-resolver', userDataDir);
  const profile = resolver.mod.initializeProfile(resolver.app, {
    argv: ['electron', '.'],
    env: {},
    now: NOW,
  });

  const beeAnt = loadModule('../../migrate-user-data', userDataDir);
  const beeMigrated = beeAnt.mod.migrateBeeDataToAntData();

  return { profile, beeMigrated };
}

describe('v0.8.0 upgrade path (end-to-end, in place)', () => {
  let userDataDir;

  beforeEach(() => {
    userDataDir = createTempUserDataDir('freedom-v08-upgrade-');
    delete process.env.FREEDOM_ANT_DATA;
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
    delete process.env.FREEDOM_ANT_DATA;
  });

  test('adopts the flat userData as the default profile in place and preserves all user data', () => {
    writeLegacyInstall(userDataDir);

    const { profile, beeMigrated } = runUpgrade(userDataDir);

    // 1. Default profile + catalog created *in place* (no file move): the
    //    pre-profile flat userData becomes the default profile directory.
    expect(profile.id).toBe('default');
    expect(profile.userDataDir).toBe(userDataDir);
    expect(profile.appRoot).toBe(userDataDir);
    expect(fs.existsSync(path.join(userDataDir, 'profile-registry.json'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'profile.json'))).toBe(true);
    const catalog = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'profile-registry.json'), 'utf-8')
    );
    expect(catalog.profiles.map((p) => p.id)).toEqual(['default']);
    expect(catalog.profiles[0].dir).toBe(userDataDir);

    // 2. bee-data → ant-data: identity + postage stamps survive, dead
    //    LevelDB state is dropped, and the old dir is gone.
    expect(beeMigrated).toBe(true);
    const antData = path.join(userDataDir, 'ant-data');
    expect(fs.readFileSync(path.join(antData, 'keys', 'swarm.key'), 'utf-8')).toBe(
      SWARM_KEYSTORE
    );
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(BEE_PASSWORD);
    expect(fs.readFileSync(path.join(antData, 'stamperstore', 'batch'), 'utf-8')).toBe(
      'postage-batch-data'
    );
    expect(fs.existsSync(path.join(antData, 'statestore'))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'bee-data'))).toBe(false);

    // 3. Browser data is intact after the whole chain.
    expect(fs.readFileSync(path.join(userDataDir, 'user-bookmarks.json'), 'utf-8')).toContain(
      'My Swarm Feed'
    );
    expect(fs.readFileSync(path.join(userDataDir, 'history.sqlite'), 'utf-8')).toContain(
      'history-rows'
    );
    expect(
      fs.readFileSync(path.join(userDataDir, 'identity', 'identity-vault.json'), 'utf-8')
    ).toContain('encrypted-seed-vault');
    expect(fs.readFileSync(path.join(userDataDir, 'swarm-permissions.json'), 'utf-8')).toContain(
      'granted'
    );
    expect(fs.readFileSync(path.join(userDataDir, 'dapp-permissions.json'), 'utf-8')).toContain(
      '0xabc'
    );
  });

  test('migrates Bee-era settings keys and legacy ENS policy on upgrade', () => {
    writeLegacyInstall(userDataDir);
    runUpgrade(userDataDir);

    // Bee-named settings keys are rewritten to their ant-named replacements.
    const settings = loadModule('../../settings-store', userDataDir);
    const loaded = settings.mod.loadSettings();
    expect(loaded.antNodeMode).toBe('light');
    expect(loaded.startAntAtLaunch).toBe(false);
    expect(loaded).not.toHaveProperty('beeNodeMode');
    expect(loaded).not.toHaveProperty('startBeeAtLaunch');

    const persisted = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8')
    );
    expect(persisted.antNodeMode).toBe('light');
    expect(persisted).not.toHaveProperty('beeNodeMode');

    // The legacy ENS custom-RPC policy produces a network-config.json with the
    // expected mainnet verification strategy + a migrated endpoint source.
    const net = loadModule('../../networks/network-registry', userDataDir, {
      isPackaged: false,
    });
    expect(net.mod.getNetwork(1).verification.primary).toBe('direct');
    expect(fs.existsSync(path.join(userDataDir, 'network-config.json'))).toBe(true);
    const networkConfig = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'network-config.json'), 'utf-8')
    );
    expect(networkConfig.networks['1']).toEqual({
      verification: {
        primary: 'direct',
        order: ['myotis', 'direct', 'quorum'],
        preferVerified: false,
      },
    });
    expect(networkConfig.endpointSources['migrated-eth-custom']).toEqual({
      role: 'rpc',
      keyed: false,
      coverage: { '1': 'https://my-eth-rpc.example' },
    });
  });

  test('is idempotent: re-running the whole chain churns no data', () => {
    writeLegacyInstall(userDataDir);
    runUpgrade(userDataDir);

    const registryBefore = fs.readFileSync(
      path.join(userDataDir, 'profile-registry.json'),
      'utf-8'
    );
    const keystoreBefore = fs.readFileSync(
      path.join(userDataDir, 'ant-data', 'keys', 'swarm.key'),
      'utf-8'
    );

    // Second launch: every migration must be a no-op.
    const beeAnt = loadModule('../../migrate-user-data', userDataDir);
    expect(beeAnt.mod.migrateBeeDataToAntData()).toBe(false);
    expect(beeAnt.mod.isBeeDataMigrationPending()).toBe(false);

    const resolver = loadModule('../../profile-resolver', userDataDir);
    resolver.mod.initializeProfile(resolver.app, {
      argv: ['electron', '.'],
      env: {},
      now: NOW,
    });

    expect(
      fs.readFileSync(path.join(userDataDir, 'ant-data', 'keys', 'swarm.key'), 'utf-8')
    ).toBe(keystoreBefore);
    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'profile-registry.json'), 'utf-8')
    );
    expect(registryAfter.profiles.map((p) => p.id)).toEqual(['default']);
    // The catalog still references exactly one in-place default profile.
    expect(JSON.parse(registryBefore).profiles.length).toBe(1);
  });

  test('a named profile gets fresh, isolated data and never touches the default', () => {
    writeLegacyInstall(userDataDir);
    runUpgrade(userDataDir);

    // Launching --profile=work after upgrade creates an isolated profile dir.
    const resolver = loadModule('../../profile-resolver', userDataDir);
    const work = resolver.mod.initializeProfile(resolver.app, {
      argv: ['electron', '.', '--profile=work'],
      env: {},
      now: NOW,
    });

    expect(work.id).toBe('work');
    expect(work.userDataDir).toBe(path.join(userDataDir, 'Profiles', 'work'));
    // The named profile uses the next managed port slot, not the default's.
    expect(work.metadata.nodes.bee.apiPort).toBe(11634);

    // The named profile has none of the default profile's data.
    expect(fs.existsSync(path.join(work.userDataDir, 'user-bookmarks.json'))).toBe(false);
    expect(fs.existsSync(path.join(work.userDataDir, 'ant-data'))).toBe(false);
    expect(fs.existsSync(path.join(work.userDataDir, 'identity'))).toBe(false);

    // The default profile's data is untouched.
    expect(fs.readFileSync(path.join(userDataDir, 'user-bookmarks.json'), 'utf-8')).toContain(
      'My Swarm Feed'
    );
    expect(fs.existsSync(path.join(userDataDir, 'ant-data', 'keys', 'swarm.key'))).toBe(true);
  });

  test('starts cleanly on a Kubo-era ipfs-data tree without carrying over its repo', () => {
    writeLegacyInstall(userDataDir);
    // A v0.7.x install also had a Kubo IPFS repo. By design freedom-ipfs
    // carries over NO Kubo repo/blocks/pins (see docs/freedom-ipfs-native-
    // desktop.md): native IPFS identity is ephemeral and content reloads from
    // the network. The Kubo data is left orphaned (cleanup tracked in #101).
    const kuboData = path.join(userDataDir, 'ipfs-data');
    fs.mkdirSync(path.join(kuboData, 'blocks'), { recursive: true });
    fs.writeFileSync(
      path.join(kuboData, 'config'),
      JSON.stringify({ Identity: { PeerID: 'Qm-kubo' } })
    );
    fs.writeFileSync(path.join(kuboData, 'blocks', 'CIQ.data'), 'kubo-block');
    fs.mkdirSync(path.join(kuboData, 'datastore'), { recursive: true });

    runUpgrade(userDataDir);

    const ipfs = loadModule('../../ipfs-manager', userDataDir, { isPackaged: false });
    const nativeDataPath = ipfs.mod.getIpfsDataPath();

    // The native node lives in its own freedom-ipfs/ subdir, isolated from the
    // Kubo layout — no Kubo identity, blocks, or pins are consumed.
    expect(nativeDataPath).toBe(path.join(userDataDir, 'ipfs-data', 'freedom-ipfs'));
    expect(fs.existsSync(nativeDataPath)).toBe(true);
    expect(fs.readdirSync(nativeDataPath)).toEqual([]);

    // The orphaned Kubo repo is left in place (not migrated, not deleted).
    expect(fs.existsSync(path.join(userDataDir, 'ipfs-data', 'config'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, 'ipfs-data', 'blocks', 'CIQ.data'))).toBe(true);
  });

  // A crash mid bee→ant migration must be recoverable on the next launch —
  // no lost keystore, no duplicated/corrupted data. This drives the merge path
  // (ant-data already present because antd self-generated a throwaway identity),
  // injects a Windows-EPERM-style failure part way through the carry, then
  // relaunches and asserts the identity + postage stamps land intact.
  test('recovers a crash-interrupted bee→ant migration on the next launch', () => {
    writeLegacyInstall(userDataDir);
    // antd already ran once and self-generated a throwaway identity into
    // ant-data/ — forcing the item-by-item carry (not the whole-dir rename).
    const antData = path.join(userDataDir, 'ant-data');
    fs.mkdirSync(antData, { recursive: true });
    fs.writeFileSync(path.join(antData, 'identity.json'), JSON.stringify({ throwaway: true }));

    const beeAnt = loadModule('../../migrate-user-data', userDataDir);

    // Interrupt the carry on the stamperstore move — before the keystore, which
    // moves LAST, is committed (see BEE_CARRY_ITEMS ordering in the migrator).
    const realRename = fs.renameSync.bind(fs);
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      if (String(dest).endsWith(`${path.sep}stamperstore`)) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return realRename(src, dest);
    });

    // First launch crashes part way: it reports failure and stays pending.
    expect(beeAnt.mod.migrateBeeDataToAntData()).toBe(false);
    expect(beeAnt.mod.isBeeDataMigrationPending()).toBe(true);
    // The keystore never moved, so it's still safe in bee-data (nothing to lose).
    expect(fs.existsSync(path.join(antData, 'keys', 'swarm.key'))).toBe(false);
    expect(
      fs.readFileSync(path.join(userDataDir, 'bee-data', 'keys', 'swarm.key'), 'utf-8')
    ).toBe(SWARM_KEYSTORE);

    spy.mockRestore();

    // Relaunch: the migration finishes and no data is lost or duplicated.
    expect(beeAnt.mod.migrateBeeDataToAntData()).toBe(true);
    expect(beeAnt.mod.isBeeDataMigrationPending()).toBe(false);
    expect(fs.readFileSync(path.join(antData, 'keys', 'swarm.key'), 'utf-8')).toBe(SWARM_KEYSTORE);
    expect(fs.readFileSync(path.join(antData, 'stamperstore', 'batch'), 'utf-8')).toBe(
      'postage-batch-data'
    );
    expect(fs.readFileSync(path.join(antData, 'config.yaml'), 'utf-8')).toContain(BEE_PASSWORD);
    // antd's throwaway identity was dropped — it must not win over the migrated key.
    expect(fs.existsSync(path.join(antData, 'identity.json'))).toBe(false);
  });

  // A v0.7.x install kept its Radicle identity in a profile-local
  // radicle-data/. On upgrade the default profile is catalog-managed, so the
  // Radicle home moves to the short, app-owned <appRoot>/R/<slot> (the runtime
  // canonicalizes RAD_HOME before binding its control.sock, which has a hard
  // sockaddr_un length limit). This exercises copyProfileRadicleDataIfNeeded on
  // the full upgrade path — the pre-upgrade identity must be carried across.
  test('carries the Radicle identity to the short Radicle home on the full upgrade path', () => {
    writeLegacyInstall(userDataDir);
    const legacyRadicle = path.join(userDataDir, 'radicle-data');
    fs.mkdirSync(path.join(legacyRadicle, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(legacyRadicle, 'keys', 'radicle.pub'), 'radicle-public-key');

    // Load profile-paths and resolve the default profile in the SAME module
    // graph so getRadicleDataDir() sees the active catalog profile.
    const paths = loadModule('../../profile-paths', userDataDir);
    const resolver = require('../../profile-resolver');
    resolver.initializeProfile(paths.app, { argv: ['electron', '.'], env: {}, now: NOW });

    const radicleDir = paths.mod.getRadicleDataDir();

    // The default profile (slot 0) uses the short app-owned Radicle home, which
    // is shorter than the profile-local radicle-data/ it replaces.
    expect(radicleDir).toBe(path.join(userDataDir, 'R', '0'));
    expect(radicleDir.length).toBeLessThan(legacyRadicle.length);
    // The pre-upgrade Radicle identity is carried into the short home...
    expect(fs.readFileSync(path.join(radicleDir, 'keys', 'radicle.pub'), 'utf-8')).toBe(
      'radicle-public-key'
    );
    // ...by copy, not move: the original profile-local data is left in place.
    expect(fs.existsSync(path.join(legacyRadicle, 'keys', 'radicle.pub'))).toBe(true);
  });
});
