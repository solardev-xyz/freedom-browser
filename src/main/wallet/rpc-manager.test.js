/**
 * A keyed provider's resolved RPC URL carries the user's API key (#1040).
 * Main resolves and uses it; no renderer is answered with it.
 */
const fs = require('fs');
const path = require('path');
const {
  createIpcMainMock,
  createTempUserDataDir,
  removeTempUserDataDir,
  loadMainModule,
} = require('../../../test/helpers/main-process-test-utils');

const SHARED = path.join(__dirname, '..', '..', 'shared');
const readShared = (name) => JSON.parse(fs.readFileSync(path.join(SHARED, name), 'utf-8'));

// Built at runtime, so no key-shaped literal sits in the source.
const KEY = ['rpc', 'key', 'sentinel', process.pid.toString(36)].join('-');

const keyedProviderIds = Object.entries(readShared('endpoint-sources.json'))
  .filter(([, src]) => src.role === 'rpc' && src.keyed)
  .map(([id]) => id);
const chainIds = Object.keys(readShared('chains.json'));

let userDataDir;

beforeEach(() => {
  userDataDir = createTempUserDataDir('freedom-rpc-keys-');
  // Every keyed provider has a key, so each covered chain's pool has a
  // keyed URL in it.
  const keys = Object.fromEntries(
    keyedProviderIds.map((id) => [id, { apiKey: `${KEY}-${id}`, enabled: true, addedAt: 1 }])
  );
  fs.writeFileSync(path.join(userDataDir, 'rpc-api-keys.json'), JSON.stringify(keys));
});

afterEach(() => {
  removeTempUserDataDir(userDataDir);
});

function loadRpcManager() {
  const ipcMain = createIpcMainMock();
  const { mod } = loadMainModule(require.resolve('./rpc-manager'), { ipcMain, userDataDir });
  return { rpcManager: mod, ipcMain };
}

describe('rpc-manager keeps RPC API keys in main', () => {
  test('the fixture has keyed providers to check', () => {
    expect(keyedProviderIds.length).toBeGreaterThan(0);
    expect(chainIds).toContain('1');
  });

  test('main still resolves the keyed URLs for its own requests', () => {
    const { rpcManager } = loadRpcManager();
    for (const id of keyedProviderIds) {
      expect(rpcManager.getEffectiveRpcUrls(1).some((url) => url.includes(`${KEY}-${id}`))).toBe(true);
    }
  });

  test('offers no IPC registration: no channel answers with the RPC pool', () => {
    const { rpcManager, ipcMain } = loadRpcManager();
    for (const value of Object.values(rpcManager)) {
      if (typeof value === 'function' && /^register/.test(value.name)) value();
    }
    expect(Object.keys(rpcManager).filter((name) => /^register/.test(name))).toEqual([]);
    expect(ipcMain.handle).not.toHaveBeenCalled();
    expect(ipcMain.on).not.toHaveBeenCalled();
    expect(ipcMain.handlers.has('rpc:get-effective-urls')).toBe(false);
  });

  test('the keyless pool is the effective pool minus the keyed URLs, in its order', () => {
    const { rpcManager } = loadRpcManager();
    let keyedSeen = 0;
    for (const chainId of chainIds) {
      const effective = rpcManager.getEffectiveRpcUrls(chainId);
      const keyless = rpcManager.getKeylessRpcUrls(chainId);
      keyedSeen += effective.filter((url) => url.includes(KEY)).length;
      expect(keyless.filter((url) => url.includes(KEY))).toEqual([]);
      expect(keyless).toEqual(effective.filter((url) => !url.includes(KEY)));
    }
    expect(keyedSeen).toBeGreaterThan(0);
  });
});

describe('the settings page reads key presence, never a key', () => {
  test('every networks read answers without the key', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadMainModule(require.resolve('../networks/network-ipc'), {
      ipcMain,
      userDataDir,
      extraMocks: {
        [require.resolve('../networks/chain-catalog-host')]: () => ({
          searchChains: jest.fn(),
          getCatalogChain: jest.fn(),
        }),
        [require.resolve('../token-registry')]: () => ({}),
        [require.resolve('../settings-store')]: () => ({ loadSettings: () => ({}) }),
      },
    });
    mod.registerNetworkConfigIpc();

    const reads = [
      ['networks:get-config'],
      ['networks:get-chains'],
      ['networks:get-available-chains'],
      ...chainIds.flatMap((chainId) => [
        ['networks:get-chain', chainId],
        ['networks:is-chain-available', chainId],
      ]),
    ];
    for (const [channel, ...args] of reads) {
      const answer = await ipcMain.invoke(channel, ...args);
      expect(answer).toMatchObject({ success: true });
      expect(JSON.stringify(answer)).not.toContain(KEY);
    }

    const { sources } = await ipcMain.invoke('networks:get-config');
    for (const id of keyedProviderIds) {
      expect(sources.find((src) => src.id === id)).toMatchObject({ keyed: true, hasKey: true });
    }
  });
});
