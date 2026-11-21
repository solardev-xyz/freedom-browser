/**
 * Set B's writes (freedom-core design 0013, "Which stores"; Q14, as the user
 * decided it on 2026-11-21): the settings and caches main keeps, each
 * replaced whole through lib/atomic-file.js. For every writer, on disk:
 *
 * - the write is a temp file beside the target, made exclusively, fsynced,
 *   then renamed over it and the rename flushed; the target is never opened
 *   to write, and ends owner-only (0600) in the store's own JSON text;
 * - a failure before the rename leaves the old file as it was, with no temp
 *   file left, and the store does what it did when its in-place write
 *   failed (swallowed and logged, refused, or thrown);
 * - a failed flush after the rename keeps the new file and logs
 *   `durable: false`;
 * - a fresh load after the write reads the new content back.
 */

const fs = require('fs');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');

const realFetch = global.fetch;
let userDataDir;
let logger;

beforeEach(() => {
  userDataDir = createTempUserDataDir('set-b-files-');
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  for (const level of ['log', 'warn', 'error']) {
    jest.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = realFetch;
  removeTempUserDataDir(userDataDir);
});

/** `relative` loaded fresh against the temp profile, its logger mocked. */
function load(relative, extraMocks = {}) {
  return loadMainModule(require.resolve(relative), {
    userDataDir,
    extraMocks: { [require.resolve('./logger')]: () => logger, ...extraMocks },
  }).mod;
}

const writeJson = (name, value, indent = 2) =>
  fs.writeFileSync(path.join(userDataDir, name), JSON.stringify(value, null, indent), 'utf-8');

const injected = (code) => Object.assign(new Error(`${code}: injected`), { code });

/** The temp files a write of `target` left beside it. */
function tempsOf(target) {
  const base = `${path.basename(target)}.`;
  return fs
    .readdirSync(path.dirname(target))
    .filter((name) => name.startsWith(base) && name.endsWith('.tmp'));
}

const sameFile = (file, target) =>
  typeof file === 'string' && path.resolve(file) === path.resolve(target);

/** Spies on every fs call that could write a file, calling through. */
function watchWrites() {
  const methods = [
    'openSync',
    'writeFileSync',
    'appendFileSync',
    'truncateSync',
    'copyFileSync',
    'fsyncSync',
    'renameSync',
  ];
  return Object.fromEntries(methods.map((method) => [method, jest.spyOn(fs, method)]));
}

/** `target` was replaced whole, atomic-file's way, and never written in place. */
function expectReplacedWhole(spies, target) {
  const at = (spy, i) => spy.mock.invocationCallOrder[i];
  const renames = spies.renameSync.mock.calls
    .map(([from, to], i) => ({ from, to, order: at(spies.renameSync, i) }))
    .filter(({ to }) => sameFile(to, target));
  expect(renames).toHaveLength(1);
  const [{ from, order: renamedAt }] = renames;

  // The temp file: beside the target, made exclusively, owner-only.
  expect(path.dirname(from)).toBe(path.dirname(target));
  expect(path.basename(from).startsWith(`${path.basename(target)}.`)).toBe(true);
  expect(from.endsWith('.tmp')).toBe(true);
  const tempOpen = spies.openSync.mock.calls.findIndex(([file]) => file === from);
  expect(spies.openSync.mock.calls[tempOpen]).toEqual([from, 'wx', 0o600]);
  const openedAt = at(spies.openSync, tempOpen);

  // Its data synced before the rename, and the rename flushed after it.
  const syncs = spies.fsyncSync.mock.invocationCallOrder;
  expect(syncs.some((order) => order > openedAt && order < renamedAt)).toBe(true);
  expect(syncs.some((order) => order > renamedAt)).toBe(true);

  // Nothing writes the target in place: no write, append, truncate or copy
  // names it, and the only open of it that could write is the Windows flush,
  // after the rename.
  for (const method of ['writeFileSync', 'appendFileSync', 'truncateSync']) {
    for (const [file] of spies[method].mock.calls) expect(sameFile(file, target)).toBe(false);
  }
  for (const [, to] of spies.copyFileSync.mock.calls) expect(sameFile(to, target)).toBe(false);
  spies.openSync.mock.calls.forEach(([file, flags], i) => {
    if (!sameFile(file, target) || flags === undefined || flags === 'r') return;
    expect(flags).toBe('r+');
    expect(at(spies.openSync, i)).toBeGreaterThan(renamedAt);
  });
}

/** The rename onto `target` fails: the last step before it is replaced. */
function failRenameOnto(target) {
  const realRename = fs.renameSync;
  jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (sameFile(to, target)) throw injected('EIO');
    return realRename(from, to);
  });
}

/** The flush after the rename onto `target` fails (its open, as on either
 * platform's path). */
function failFlushAfterRenameOnto(target) {
  const realRename = fs.renameSync;
  const realOpen = fs.openSync;
  let renamed = false;
  jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    realRename(from, to);
    if (sameFile(to, target)) renamed = true;
  });
  jest.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (renamed) {
      renamed = false;
      throw injected('EACCES');
    }
    return realOpen(...args);
  });
}

/** What `write` returned or threw. */
async function outcomeOf(write) {
  try {
    return { result: await write() };
  } catch (error) {
    return { error };
  }
}

const LEGACY_RPC_SETTINGS = { enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' };
const CHEQUEBOOK = '0x1111111111111111111111111111111111111111';
const LEDGER = { since: 5, peers: { aa: '7' }, buckets: [[3600000, '7']] };
const CATALOG = [
  {
    chainId: 4242,
    name: 'Fetched Chain',
    shortName: 'fc',
    nativeCurrency: { symbol: 'FC', decimals: 18 },
    rpc: ['https://rpc.fetched.example'],
  },
];
const legacyProfile = () => ({
  id: 'test',
  displayName: 'Test',
  source: 'test-user-data',
  userDataDir,
  metadata: null,
});
const promptLegacy = (mod) =>
  mod.promptForDefaultExternalCandidates(legacyProfile(), {
    enabledProtocols: { bee: true },
    logger,
    now: '2026-11-21T00:00:00.000Z',
    presentCandidates: jest.fn().mockResolvedValue({ bee: 'external' }),
    probeEndpoint: jest.fn().mockResolvedValue(true),
    findOwnLiveAntd: jest.fn().mockResolvedValue(false),
  });
const fetchCatalog = () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => CATALOG });
};
const offline = () => {
  global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
};

// Each writer: the file it replaces, what is on disk before (`seed`), the
// write, the JSON text's indent, what the new file and a fresh load read,
// and its documented behaviour when the write fails before the rename.
const WRITERS = [
  {
    name: 'settings-store: a load that migrates the file',
    file: 'settings.json',
    seed: () => writeJson('settings.json', { theme: 'dark', startBeeAtLaunch: false }),
    load: () => load('./settings-store'),
    write: (mod) => mod.loadSettings(),
    written: (json) => expect(json).toEqual({ theme: 'dark', startAntAtLaunch: false }),
    reread: (mod) => {
      expect(mod.loadSettings()).toMatchObject({ theme: 'dark', startAntAtLaunch: false });
    },
    // Logged; the migrated settings are used anyway.
    failed: ({ result }) => {
      expect(result).toMatchObject({ theme: 'dark', startAntAtLaunch: false });
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to persist migrated settings:',
        expect.objectContaining({ code: 'EIO' })
      );
    },
    warned: () => logger.warn,
  },
  {
    name: 'settings-store: saveSettings',
    file: 'settings.json',
    seed: () => writeJson('settings.json', { theme: 'dark' }),
    load: () => load('./settings-store'),
    write: (mod) => mod.saveSettings({ theme: 'light' }),
    written: (json) => expect(json.theme).toBe('light'),
    reread: (mod) => expect(mod.loadSettings().theme).toBe('light'),
    // Refused: false, logged, and the settings stay as they were.
    failed: ({ result }, mod) => {
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to save settings:',
        expect.objectContaining({ code: 'EIO' })
      );
      expect(mod.loadSettings().theme).toBe('dark');
    },
    warned: () => logger.warn,
  },
  {
    name: "network-registry: a legacy settings file's migration",
    file: 'network-config.json',
    seed: () => writeJson('settings.json', LEGACY_RPC_SETTINGS),
    load: () => load('./networks/network-registry'),
    write: (mod) => mod.getNetwork(1),
    written: (json) => expect(json.networks['1'].verification.primary).toBe('direct'),
    reread: (mod) => {
      expect(mod.getNetwork(1).verification.primary).toBe('direct');
      expect(mod.getEndpoints(1, 'rpc')).toContain(LEGACY_RPC_SETTINGS.ensRpcUrl);
    },
    // Logged; the migrated config is used in memory.
    failed: ({ result }) => {
      expect(result.verification.primary).toBe('direct');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[network-registry] failed to persist migration: EIO')
      );
    },
    warned: () => logger.warn,
  },
  {
    name: 'network-registry: updateNetwork',
    file: 'network-config.json',
    seed: () =>
      writeJson('network-config.json', {
        networks: { 1: { verification: { primary: 'quorum' } } },
        endpointSources: {},
        removedSources: [],
      }),
    load: () => load('./networks/network-registry'),
    write: (mod) => mod.updateNetwork(1, { verification: { primary: 'direct' } }),
    written: (json) => expect(json.networks['1'].verification.primary).toBe('direct'),
    reread: (mod) => expect(mod.getNetwork(1).verification.primary).toBe('direct'),
    // Thrown to the caller; the registry still answers the old config.
    failed: ({ error }, mod) => {
      expect(error.code).toBe('EIO');
      expect(mod.getNetwork(1).verification.primary).toBe('quorum');
    },
    warned: () => logger.warn,
  },
  {
    name: 'network-registry: addCustomChain',
    file: 'custom-chains.json',
    seed: () =>
      writeJson('custom-chains.json', {
        8453: { chainId: 8453, name: 'Base', nativeSymbol: 'ETH', rpcUrls: [] },
      }),
    load: () => load('./networks/network-registry'),
    write: (mod) => mod.addCustomChain({ chainId: 4242, name: 'Mine', nativeSymbol: 'MINE' }),
    written: (json) => expect(Object.keys(json).sort()).toEqual(['4242', '8453']),
    reread: (mod) => {
      expect(mod.getNetwork(4242)).toMatchObject({ name: 'Mine', builtin: false });
      expect(mod.getNetwork(8453)).toMatchObject({ name: 'Base' });
    },
    // Thrown to the caller; the chain isn't added.
    failed: ({ error }, mod) => {
      expect(error.code).toBe('EIO');
      expect(mod.getNetwork(4242)).toBeFalsy();
    },
    warned: () => logger.warn,
  },
  {
    name: 'token-registry: addCustomToken',
    file: 'custom-tokens.json',
    seed: () =>
      writeJson('custom-tokens.json', {
        '8453:0xold': {
          chainId: 8453,
          address: '0xold',
          symbol: 'OLD',
          decimals: 18,
          builtin: false,
        },
      }),
    load: () => load('./token-registry'),
    write: (mod) =>
      mod.addCustomToken({ chainId: 8453, address: '0xabc', symbol: 'DEGEN', decimals: 18 }),
    written: (json) => expect(Object.keys(json)).toEqual(['8453:0xold', '8453:0xabc']),
    reread: (mod) => {
      expect(mod.getToken('8453:0xabc')).toMatchObject({ symbol: 'DEGEN' });
      expect(mod.getToken('8453:0xold')).toMatchObject({ symbol: 'OLD' });
    },
    // Refused, logged, and the token isn't added.
    failed: ({ result }, mod) => {
      expect(result).toEqual({ success: false, error: 'Failed to save custom token' });
      expect(console.error).toHaveBeenCalledWith(
        '[TokenRegistry] Failed to save custom tokens:',
        expect.objectContaining({ code: 'EIO' })
      );
      expect(mod.getToken('8453:0xabc')).toBeNull();
    },
    warned: () => console.warn,
  },
  {
    name: 'permissions-store: setDecision',
    file: 'permissions.json',
    seed: () => writeJson('permissions.json', { 'https://a.example': { camera: 'allow' } }),
    load: () => load('./permissions/permissions-store'),
    write: (mod) => mod.setDecision('https://b.example', 'camera', 'deny'),
    written: (json) =>
      expect(json).toEqual({
        'https://a.example': { camera: 'allow' },
        'https://b.example': { camera: 'deny' },
      }),
    reread: (mod) => {
      expect(mod.getDecision('https://b.example', 'camera')).toBe('deny');
      expect(mod.getDecision('https://a.example', 'camera')).toBe('allow');
    },
    // Swallowed and logged: the decision holds for this run.
    failed: ({ result }, mod) => {
      expect(result).toBe(true);
      expect(console.error).toHaveBeenCalledWith(
        '[SitePermissions] Failed to save permissions:',
        expect.objectContaining({ code: 'EIO' })
      );
      expect(mod.getDecision('https://b.example', 'camera')).toBe('deny');
    },
    warned: () => console.warn,
  },
  {
    name: 'adblock allowlist-store: addAllowlistedHost',
    file: 'adblock-allowlist.json',
    seed: () => writeJson('adblock-allowlist.json', { hosts: ['a.example'] }),
    load: () =>
      load('./adblock/allowlist-store', {
        [require.resolve('./adblock/service')]: () => ({ setAllowlistedHosts: jest.fn() }),
      }),
    write: (mod) => mod.addAllowlistedHost('b.example'),
    written: (json) => expect(json).toEqual({ hosts: ['a.example', 'b.example'] }),
    reread: (mod) => expect(mod.getAllowlistedHosts()).toEqual(['a.example', 'b.example']),
    // Swallowed and logged: the host is allowed for this run.
    failed: ({ result }, mod) => {
      expect(result).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        '[adblock] failed to save allowlist: EIO: injected'
      );
      expect(mod.getAllowlistedHosts()).toEqual(['a.example', 'b.example']);
    },
    warned: () => logger.warn,
  },
  {
    name: 'balance-cache: setCachedBalances',
    file: 'balance-cache.json',
    seed: () =>
      writeJson('balance-cache.json', {
        version: 2,
        balances: { '0xaaa': { updatedAt: 1, '1:native': { formatted: '2.0', symbol: 'ETH' } } },
      }),
    load: () => load('./wallet/balance-cache'),
    write: (mod) =>
      mod.setCachedBalances('0xBBB', {
        '1:native': { formatted: '1.0', symbol: 'ETH', raw: '1000000000000000000', decimals: 18 },
      }),
    written: (json) => expect(Object.keys(json.balances)).toEqual(['0xaaa', '0xbbb']),
    reread: (mod) => {
      expect(mod.getCachedBalances('0xbbb')['1:native'].formatted).toBe('1.0');
      expect(mod.getCachedBalances('0xaaa')['1:native'].formatted).toBe('2.0');
    },
    // Swallowed and logged: the balance is cached for this run.
    failed: (_outcome, mod) => {
      expect(console.error).toHaveBeenCalledWith(
        '[BalanceCache] Failed to save cache:',
        'EIO: injected'
      );
      expect(mod.getCachedBalances('0xbbb')['1:native'].formatted).toBe('1.0');
    },
    warned: () => console.warn,
  },
  {
    name: "chain-catalog: a stale cache's refresh",
    file: 'chain-catalog.json',
    indent: undefined,
    seed: () => {
      writeJson('chain-catalog.json', { fetchedAt: 0, chains: [] }, undefined);
      fetchCatalog();
    },
    load: () => load('./networks/chain-catalog'),
    write: (mod) => mod.getCatalogChain(4242),
    written: (json) => expect(json.chains).toEqual(CATALOG),
    // Read from the disk, with no network.
    reread: async (mod) => {
      offline();
      await expect(mod.getCatalogChain(4242)).resolves.toMatchObject({ name: 'Fetched Chain' });
      expect(global.fetch).not.toHaveBeenCalled();
    },
    // Logged; the fetched catalog is answered anyway.
    failed: ({ result }) => {
      expect(result).toMatchObject({ name: 'Fetched Chain' });
      expect(logger.error).toHaveBeenCalledWith(
        '[chain-catalog] failed to write cache: EIO: injected'
      );
    },
    warned: () => logger.warn,
  },
  {
    name: 'browsing-credit-service: the spend store',
    file: 'swarm-browsing-credit.json',
    indent: undefined,
    seed: () =>
      writeJson(
        'swarm-browsing-credit.json',
        { version: 1, chequebooks: { '0xold': { since: 1, peers: {}, buckets: [] } } },
        undefined
      ),
    load: () =>
      load('./swarm/browsing-credit-service').createSpendStore(
        path.join(userDataDir, 'swarm-browsing-credit.json')
      ),
    write: (store) => store.set(CHEQUEBOOK, LEDGER),
    written: (json) => expect(Object.keys(json.chequebooks)).toEqual(['0xold', CHEQUEBOOK]),
    reread: (store) => expect(store.get(CHEQUEBOOK)).toEqual(LEDGER),
    // Swallowed and logged: the ledger holds for this run.
    failed: (_outcome, store) => {
      expect(logger.warn).toHaveBeenCalledWith(
        '[BrowsingCredit] could not save spend history: EIO: injected'
      );
      expect(store.get(CHEQUEBOOK)).toEqual(LEDGER);
    },
    warned: () => logger.warn,
  },
  {
    name: "profile-external-candidates: a legacy profile's answer",
    file: 'external-node-decisions.json',
    seed: () =>
      writeJson('external-node-decisions.json', {
        ipfs: { choice: 'managed', checkedAt: '2026-10-09T00:00:00.000Z', endpoints: [] },
      }),
    load: () => load('./profile-external-candidates'),
    write: (mod) => promptLegacy(mod),
    written: (json) => {
      expect(Object.keys(json)).toEqual(['ipfs', 'bee']);
      expect(json.bee.choice).toBe('external');
    },
    reread: (mod) => {
      expect(mod.getLegacyExternalCandidateChoice(legacyProfile(), 'bee')).toBe('external');
    },
    // Thrown to the prompt's caller; nothing is saved.
    failed: ({ error }, mod) => {
      expect(error.code).toBe('EIO');
      expect(mod.getLegacyExternalCandidateChoice(legacyProfile(), 'bee')).toBeNull();
    },
    warned: () => logger.warn,
  },
];

describe.each(WRITERS)('$name', (writer) => {
  const target = () => path.join(userDataDir, writer.file);
  const indent = 'indent' in writer ? writer.indent : 2;
  const readBack = () => JSON.parse(fs.readFileSync(target(), 'utf-8'));

  beforeEach(() => writer.seed());

  test('replaces the file through atomic-file: a temp file, fsynced, renamed over it', async () => {
    const before = fs.existsSync(target()) ? fs.readFileSync(target(), 'utf-8') : null;
    const mod = writer.load();
    const spies = watchWrites();

    await writer.write(mod);

    expectReplacedWhole(spies, target());
    const text = fs.readFileSync(target(), 'utf-8');
    expect(text).not.toBe(before);
    // The store's own JSON text, as its in-place write made it.
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, indent));
    writer.written(JSON.parse(text));
    expect(tempsOf(target())).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(target()).mode & 0o777).toBe(0o600);
  });

  test("a failure before the rename leaves the old file as it was, and the store's error behaviour", async () => {
    const before = fs.existsSync(target()) ? fs.readFileSync(target(), 'utf-8') : null;
    const mod = writer.load();
    failRenameOnto(target());

    const outcome = await outcomeOf(() => writer.write(mod));

    expect(fs.existsSync(target()) ? fs.readFileSync(target(), 'utf-8') : null).toBe(before);
    expect(tempsOf(target())).toEqual([]);
    await writer.failed(outcome, mod);
  });

  test('a failed flush after the rename keeps the new file and logs durable: false', async () => {
    const mod = writer.load();
    failFlushAfterRenameOnto(target());

    const outcome = await outcomeOf(() => writer.write(mod));

    expect(outcome.error).toBeUndefined();
    writer.written(readBack());
    expect(writer.warned()).toHaveBeenCalledWith(expect.stringContaining('(durable: false)'));
  });

  test('a fresh load reads the new content back', async () => {
    await writer.write(writer.load());
    await writer.reread(writer.load());
  });
});
