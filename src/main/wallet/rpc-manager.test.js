/**
 * The RPC API keys through the identity core (freedom-core design 0013,
 * "RPC API keys"; PRF-6(e)), against a simulated core over the reference
 * key store (test/helpers/simulated-rpc-keys-core.js), so the file's text
 * is the reference's. The real core: rpc-manager.integration.test.js.
 *
 * - Main's copy of the keys is read from `secrets.rpc_api_keys` (`shell`) at
 *   each start of the core and after each set or remove; until then the
 *   keyed providers are left out of the registry's pool.
 * - A set or a remove goes as its caller's, after main's registry check,
 *   and the core's refusals reach the settings page in main's words.
 *
 * A keyed provider's resolved RPC URL carries the user's API key (#1040).
 * Main resolves and uses it; no renderer is answered with it.
 */
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createIpcMainMock,
  createTempUserDataDir,
  removeTempUserDataDir,
  loadMainModule,
} = require('../../../test/helpers/main-process-test-utils');
const { simulatedRpcKeysCore } = require('../../../test/helpers/simulated-rpc-keys-core');

const SHARED = path.join(__dirname, '..', '..', 'shared');
const readShared = (name) => JSON.parse(fs.readFileSync(path.join(SHARED, name), 'utf-8'));

// Built at runtime, so no key-shaped literal sits in the source.
const KEY = ['rpc', 'key', 'sentinel', process.pid.toString(36)].join('-');

const keyedProviderIds = Object.entries(readShared('endpoint-sources.json'))
  .filter(([, src]) => src.role === 'rpc' && src.keyed)
  .map(([id]) => id);
const chainIds = Object.keys(readShared('chains.json'));

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A keyed rpc source per id, in network-config.json, covering chain 1. */
function writeKeyedSources(userDataDir, ids) {
  const endpointSources = Object.fromEntries(
    ids.map((id) => [
      id,
      { role: 'rpc', keyed: true, name: id, coverage: { 1: `https://${id}.example/v2/{API_KEY}` } },
    ])
  );
  fs.writeFileSync(path.join(userDataDir, 'network-config.json'), JSON.stringify({ endpointSources }));
}

describe('rpc-manager over the identity core (PRF-6(e))', () => {
  let userDataDir;
  let keysPath;
  let core;
  let rpc;
  let onApiKeysChanged;
  let logged;

  function load({ keyStore = false } = {}) {
    core = simulatedRpcKeysCore({ keyStore });
    onApiKeysChanged = jest.fn(() => require('../networks/network-registry').invalidate());
    ({ mod: rpc } = loadMainModule(require.resolve('./rpc-manager'), {
      userDataDir,
      extraMocks: {
        [require.resolve('../core/vault-backend')]: () => ({
          vaultBackend: { secrets: core.secrets },
        }),
        [require.resolve('./provider-manager')]: () => ({ onApiKeysChanged }),
      },
    }));
    return rpc;
  }

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-keys-core-'));
    keysPath = path.join(userDataDir, 'rpc-api-keys.json');
    logged = [];
    for (const level of ['log', 'warn', 'error']) {
      jest.spyOn(console, level).mockImplementation((...args) => logged.push(args));
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const fileText = () => fs.readFileSync(keysPath, 'utf8');
  const keyedUrls = () => rpc.getEffectiveRpcUrls(1).filter((url) => url.includes(KEY));

  test("before the core's first answer, main's copy is empty and no file is read", () => {
    fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: KEY, enabled: true } }));
    load();
    const read = jest.spyOn(fs, 'readFileSync');
    const open = jest.spyOn(fs, 'openSync');
    expect(rpc.hasApiKey('alchemy')).toBe(false);
    expect(rpc.cachedApiKeys().size).toBe(0);
    expect(keyedUrls()).toEqual([]);
    const touched = [...read.mock.calls, ...open.mock.calls].filter(([target]) =>
      String(target).includes('rpc-api-keys')
    );
    expect(touched).toEqual([]);
    expect(core.calls).toEqual([]);
  });

  test("each start of the core reads the keys as main's, and a change drops the providers", async () => {
    fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: KEY, enabled: true } }));
    load();
    const listener = jest.fn();
    rpc.onKeysChanged(listener);
    const client = new EventEmitter();
    rpc.attachCore(client);
    rpc.attachCore(client);

    client.emit('ready');
    await tick();
    expect(core.calls).toEqual([{ method: 'secrets.rpc_api_keys', caller: 'shell', id: undefined }]);
    expect(rpc.hasApiKey('alchemy')).toBe(true);
    expect(rpc.cachedApiKeys().get('alchemy')).toBe(KEY);
    expect(keyedUrls()).toHaveLength(1);
    expect(onApiKeysChanged).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    // A restarted core with the same keys changes nothing.
    client.emit('ready');
    await tick();
    expect(core.calls).toHaveLength(2);
    expect(onApiKeysChanged).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    // A key that isn't counted (`enabled` false) isn't answered, so it goes.
    fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: KEY, enabled: false } }));
    client.emit('ready');
    await tick();
    expect(rpc.hasApiKey('alchemy')).toBe(false);
    expect(keyedUrls()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('an earlier read answered after a later one is dropped', async () => {
    load();
    const answers = [];
    core.secrets.rpcApiKeys = () => new Promise((resolve) => answers.push(resolve));
    const first = rpc.refreshKeys();
    const second = rpc.refreshKeys();
    answers[1]({ keys: [{ id: 'alchemy', api_key: `${KEY}-new` }] });
    await expect(second).resolves.toBe(true);
    answers[0]({ keys: [{ id: 'alchemy', api_key: `${KEY}-old` }] });
    await expect(first).resolves.toBe(false);
    expect(rpc.cachedApiKeys().get('alchemy')).toBe(`${KEY}-new`);
  });

  describe('each read takes a new generation: only the latest started applies', () => {
    function heldReads() {
      const held = [];
      core.secrets.rpcApiKeys = () =>
        new Promise((resolve, reject) => held.push({ resolve, reject }));
      return held;
    }
    const answer = (key) => ({ keys: [{ id: 'alchemy', api_key: key }] });

    test('an older read answered while a newer one is still out is dropped', async () => {
      load();
      const held = heldReads();
      const older = rpc.refreshKeys();
      const newer = rpc.refreshKeys();
      held[0].resolve(answer(`${KEY}-old`));
      await expect(older).resolves.toBe(false);
      expect(rpc.cachedApiKeys().size).toBe(0);
      expect(onApiKeysChanged).not.toHaveBeenCalled();
      held[1].resolve(answer(`${KEY}-new`));
      await expect(newer).resolves.toBe(true);
      expect(rpc.cachedApiKeys().get('alchemy')).toBe(`${KEY}-new`);
    });

    test('an older read answered after a newer one failed is dropped', async () => {
      load();
      const held = heldReads();
      const older = rpc.refreshKeys();
      const newer = rpc.refreshKeys();
      held[1].reject(Object.assign(new Error('core gone'), { code: 'unavailable' }));
      await expect(newer).rejects.toMatchObject({ code: 'unavailable' });
      held[0].resolve(answer(`${KEY}-old`));
      await expect(older).resolves.toBe(false);
      expect(rpc.cachedApiKeys().size).toBe(0);
      expect(onApiKeysChanged).not.toHaveBeenCalled();
    });
  });

  describe("a set or remove the core took is applied before it's read back (fail closed)", () => {
    const failRead = () =>
      core.failNext('secrets.rpc_api_keys', { code: 'unavailable', message: 'core gone' });

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    async function loadWithKey() {
      fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: KEY, enabled: true, addedAt: 1 } }));
      load();
      await rpc.refreshKeys();
      onApiKeysChanged.mockClear();
      const listener = jest.fn();
      rpc.onKeysChanged(listener);
      return listener;
    }

    test('a rotation whose read back fails reports success and serves only the new key', async () => {
      const listener = await loadWithKey();
      failRead();
      await expect(rpc.setApiKey('alchemy', `${KEY}-new`, { caller: 'chrome' })).resolves.toEqual({
        success: true,
      });
      expect(core.calls.slice(-2).map(({ method }) => method)).toEqual([
        'secrets.set_rpc_api_key',
        'secrets.rpc_api_keys',
      ]);
      expect(rpc.cachedApiKeys().get('alchemy')).toBe(`${KEY}-new`);
      expect(rpc.getEffectiveRpcUrls(1).filter((url) => url.includes(KEY))).toEqual([
        expect.stringContaining(`${KEY}-new`),
      ]);
      expect(onApiKeysChanged).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
      // The replaced key is kept for redaction only.
      expect(rpc.retiredApiKeys()).toEqual([KEY]);
      expect(JSON.stringify(logged)).toContain('core gone');
      expect(JSON.stringify(logged)).not.toContain(KEY);
    });

    test('a remove whose read back fails never serves the key again, even from an older read', async () => {
      const listener = await loadWithKey();
      // A read started before the remove, answered with the key after it.
      const held = [];
      const realRead = core.secrets.rpcApiKeys;
      core.secrets.rpcApiKeys = () => new Promise((resolve) => held.push(resolve));
      const older = rpc.refreshKeys();
      core.secrets.rpcApiKeys = realRead;

      failRead();
      await expect(rpc.removeApiKey('alchemy', { caller: 'chrome' })).resolves.toEqual({
        success: true,
      });
      expect(rpc.hasApiKey('alchemy')).toBe(false);
      expect(keyedUrls()).toEqual([]);
      expect(onApiKeysChanged).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);

      held[0]({ keys: [{ id: 'alchemy', api_key: KEY }] });
      await expect(older).resolves.toBe(false);
      expect(rpc.hasApiKey('alchemy')).toBe(false);
      expect(keyedUrls()).toEqual([]);
      expect(rpc.retiredApiKeys()).toEqual([KEY]);
    });

    test("a failed read back is retried with a backoff until it converges on the core's keys", async () => {
      await loadWithKey();
      failRead();
      await rpc.removeApiKey('alchemy', { caller: 'chrome' });
      const reads = () => core.calls.filter(({ method }) => method === 'secrets.rpc_api_keys').length;
      const before = reads();
      // Meanwhile the core holds another provider's key.
      fs.writeFileSync(keysPath, JSON.stringify({ infura: { apiKey: `${KEY}-i`, enabled: true } }));

      failRead();
      await jest.advanceTimersByTimeAsync(1000);
      expect(reads()).toBe(before + 1);
      expect(rpc.cachedApiKeys().size).toBe(0);

      await jest.advanceTimersByTimeAsync(1999);
      expect(reads()).toBe(before + 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(reads()).toBe(before + 2);
      expect([...rpc.cachedApiKeys()]).toEqual([['infura', `${KEY}-i`]]);
      expect(rpc.hasApiKey('alchemy')).toBe(false);

      // Confirmed: no more reads.
      await jest.advanceTimersByTimeAsync(60000);
      expect(reads()).toBe(before + 2);
    });

    describe('the committed-change fence', () => {
      const OTHER = ['infura', 'key', process.pid.toString(36)].join('-');
      const flush = async () => {
        for (let i = 0; i < 20; i += 1) await tick();
      };
      const callsOf = (method) => core.calls.filter((call) => call.method === method);

      test('a read back that still has the removed key never restores it; the remove goes again once', async () => {
        await loadWithKey();
        let reads = 0;
        // The core keeps answering with the removed key, beside another
        // provider's new one.
        core.secrets.rpcApiKeys = async () => {
          reads += 1;
          return {
            keys: [
              { id: 'alchemy', api_key: KEY },
              { id: 'infura', api_key: OTHER },
            ],
          };
        };
        await expect(rpc.removeApiKey('alchemy', { caller: 'chrome' })).resolves.toEqual({ success: true });
        expect(rpc.hasApiKey('alchemy')).toBe(false);
        expect(keyedUrls()).toEqual([]);
        // The unrelated provider's key applies.
        expect(rpc.cachedApiKeys().get('infura')).toBe(OTHER);
        // Sent again once, as its caller, and read back.
        expect(callsOf('secrets.remove_rpc_api_key').map(({ caller }) => caller)).toEqual(['chrome', 'chrome']);
        expect(reads).toBe(2);
        expect(rpc.retiredApiKeys()).toContain(KEY);

        // A later read in the same start of the core: still no key, and not sent again.
        await rpc.refreshKeys();
        expect(rpc.hasApiKey('alchemy')).toBe(false);
        expect(callsOf('secrets.remove_rpc_api_key')).toHaveLength(2);
        expect(rpc.retiredApiKeys()).toContain(KEY);
        expect(JSON.stringify(logged)).not.toContain(KEY);
      });

      test('a rotation the core called not durable, rolled back at a restart, keeps the new key and is sent again', async () => {
        const NEW = `${KEY}-new`;
        await loadWithKey();
        const client = new EventEmitter();
        rpc.attachCore(client);
        client.emit('ready');
        await flush();
        const served = [];
        rpc.onKeysChanged(() => served.push(rpc.cachedApiKeys().get('alchemy')));

        const realSet = core.secrets.setRpcApiKey;
        core.secrets.setRpcApiKey = async (...args) => ({ ...(await realSet(...args)), durable: false });
        await expect(rpc.setApiKey('alchemy', NEW, { caller: 'chrome' })).resolves.toEqual({ success: true });
        expect(rpc.cachedApiKeys().get('alchemy')).toBe(NEW);
        core.secrets.setRpcApiKey = realSet;

        // The core restarts without the change: its file has the old key.
        fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: KEY, enabled: true, addedAt: 1 } }));
        client.emit('ready');
        await flush();
        // The old key is never served; the set went again with main's key.
        expect(served).toEqual([NEW]);
        expect(rpc.cachedApiKeys().get('alchemy')).toBe(NEW);
        expect(callsOf('secrets.set_rpc_api_key').map(({ caller }) => caller)).toEqual(['chrome', 'chrome']);
        expect(JSON.parse(fileText()).alchemy.apiKey).toBe(NEW);

        // Confirmed, so the fence is gone: a later read applies as it is.
        fs.writeFileSync(keysPath, JSON.stringify({}));
        await rpc.refreshKeys();
        expect(rpc.hasApiKey('alchemy')).toBe(false);
        expect(callsOf('secrets.set_rpc_api_key')).toHaveLength(2);
      });

      test('a send again that fails keeps the change in force, logged without a key', async () => {
        await loadWithKey();
        core.secrets.rpcApiKeys = async () => ({ keys: [{ id: 'alchemy', api_key: KEY }] });
        const realRemove = core.secrets.removeRpcApiKey;
        let removes = 0;
        core.secrets.removeRpcApiKey = async (...args) => {
          removes += 1;
          if (removes > 1) throw Object.assign(new Error('core busy'), { code: 'unavailable' });
          return realRemove(...args);
        };
        await rpc.removeApiKey('alchemy', { caller: 'chrome' });
        expect(removes).toBe(2);
        expect(rpc.hasApiKey('alchemy')).toBe(false);
        expect(JSON.stringify(logged)).toContain('main keeps it in force');
        expect(JSON.stringify(logged)).not.toContain(KEY);
      });
    });

    test("the retries are bounded, and the core's next start reads again", async () => {
      await loadWithKey();
      core.secrets.rpcApiKeys = async () => {
        throw Object.assign(new Error('core gone'), { code: 'unavailable' });
      };
      await rpc.removeApiKey('alchemy', { caller: 'chrome' });
      let reads = 0;
      core.secrets.rpcApiKeys = async () => {
        reads += 1;
        throw Object.assign(new Error('core gone'), { code: 'unavailable' });
      };
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(reads).toBe(5);
      expect(JSON.stringify(logged)).toContain("main keeps its copy until the core's next start");
      expect(rpc.hasApiKey('alchemy')).toBe(false);

      core.secrets.rpcApiKeys = async () => {
        reads += 1;
        return { keys: [] };
      };
      const client = new EventEmitter();
      rpc.attachCore(client);
      client.emit('ready');
      await tick();
      expect(reads).toBe(6);
      await jest.advanceTimersByTimeAsync(60000);
      expect(reads).toBe(6);
      expect(rpc.cachedApiKeys().size).toBe(0);
    });
  });

  test('a read the core refuses leaves the copy as it was, logged without a key', async () => {
    fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: KEY, enabled: true } }));
    load();
    await rpc.refreshKeys();
    core.failNext('secrets.rpc_api_keys', {
      code: 'requirement_unmet',
      message: "The core can't take this request",
    });
    const client = new EventEmitter();
    rpc.attachCore(client);
    client.emit('ready');
    await tick();
    expect(rpc.hasApiKey('alchemy')).toBe(true);
    expect(JSON.stringify(logged)).toContain("The core can't take this request");
    expect(JSON.stringify(logged)).not.toContain(KEY);
  });

  test('a set goes as its caller, writes the reference text where there is no key store, and is read back', async () => {
    load();
    const listener = jest.fn();
    rpc.onKeysChanged(listener);

    await expect(rpc.setApiKey('alchemy', KEY, { caller: 'chrome' })).resolves.toEqual({
      success: true,
    });
    expect(core.calls.map(({ method, caller }) => [method, caller])).toEqual([
      ['secrets.set_rpc_api_key', 'chrome'],
      ['secrets.rpc_api_keys', 'shell'],
    ]);
    const stored = JSON.parse(fileText());
    expect(stored).toEqual({ alchemy: { apiKey: KEY, enabled: true, addedAt: expect.any(Number) } });
    expect(fileText()).toBe(JSON.stringify(stored, null, 2));
    expect(rpc.hasApiKey('alchemy')).toBe(true);
    expect(keyedUrls()).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    // Main's own set (none today) goes as `shell`.
    await rpc.setApiKey('alchemy', `${KEY}-2`);
    expect(core.calls[2]).toMatchObject({ method: 'secrets.set_rpc_api_key', caller: 'shell' });
    expect(rpc.cachedApiKeys().get('alchemy')).toBe(`${KEY}-2`);
    expect(JSON.stringify(logged)).not.toContain(KEY);
  });

  test('a provider not in the registry is refused before the core', async () => {
    load();
    for (const id of ['nope', '__proto__', 'constructor', 7, null]) {
      await expect(rpc.setApiKey(id, KEY, { caller: 'chrome' })).resolves.toEqual({
        success: false,
        error: `Unknown provider: ${id}`,
      });
    }
    expect(core.calls).toEqual([]);
  });

  test('a remove takes the key, and one with no key or provider is refused before the core', async () => {
    fs.writeFileSync(
      keysPath,
      JSON.stringify({
        alchemy: { apiKey: KEY, enabled: true, addedAt: 1 },
        'gone-provider': { apiKey: `${KEY}-gone`, enabled: true, addedAt: 1 },
      })
    );
    load();
    await rpc.refreshKeys();
    core.calls.length = 0;

    await expect(rpc.removeApiKey('nope', { caller: 'chrome' })).resolves.toEqual({
      success: false,
      error: 'No API key found for provider: nope',
    });
    expect(core.calls).toEqual([]);

    await expect(rpc.removeApiKey('alchemy', { caller: 'chrome' })).resolves.toEqual({
      success: true,
    });
    expect(core.calls.map(({ method, caller }) => [method, caller])).toEqual([
      ['secrets.remove_rpc_api_key', 'chrome'],
      ['secrets.rpc_api_keys', 'shell'],
    ]);
    expect(rpc.hasApiKey('alchemy')).toBe(false);
    // A key for a provider no longer in the registry stays removable.
    expect(rpc.hasApiKey('gone-provider')).toBe(true);
    await expect(rpc.removeApiKey('gone-provider', { caller: 'chrome' })).resolves.toEqual({
      success: true,
    });
    expect(JSON.parse(fileText())).toEqual({});
  });

  test('presence comes from the status, as its caller: never a key', async () => {
    fs.writeFileSync(keysPath, JSON.stringify({ infura: { apiKey: KEY, enabled: true } }));
    load();
    const withKey = await rpc.providersWithKeys({ caller: 'chrome' });
    expect([...withKey]).toEqual(['infura']);
    expect(core.calls).toEqual([
      { method: 'secrets.rpc_api_key_status', caller: 'chrome', id: undefined },
    ]);
    // A remove's answer names the provider `present: false`.
    core.secrets.rpcApiKeyStatus = async () => ({
      providers: [
        { id: 'alchemy', present: true },
        { id: 'infura', present: false },
      ],
    });
    expect([...(await rpc.providersWithKeys())]).toEqual(['alchemy']);
  });

  test('an id outside the entry form is refused by the core, in main words', async () => {
    writeKeyedSources(userDataDir, ['Custom_Up']);
    load();
    const answer = await rpc.setApiKey('Custom_Up', KEY, { caller: 'chrome' });
    expect(answer).toEqual({ success: false, error: expect.stringMatching(/1 to 52 lowercase/) });
    expect(fs.existsSync(keysPath)).toBe(false);
  });

  test('with a key store, a 17th key is refused and a replace at the bound taken', async () => {
    const ids = Array.from({ length: 17 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
    writeKeyedSources(userDataDir, ids);
    load({ keyStore: true });
    for (const id of ids.slice(0, 16)) {
      await expect(rpc.setApiKey(id, `${KEY}-${id}`)).resolves.toEqual({ success: true });
    }
    await expect(rpc.setApiKey('p17', KEY)).resolves.toEqual({
      success: false,
      error: 'Freedom keeps at most 16 RPC API keys. Remove one, then try again.',
    });
    await expect(rpc.setApiKey('p01', `${KEY}-again`)).resolves.toEqual({ success: true });
    expect(rpc.cachedApiKeys().size).toBe(16);
    expect(fs.existsSync(keysPath)).toBe(false);
  });

  test.each([
    [
      'an empty key',
      { code: 'invalid_argument', data: { rule: 'rpc-key-size' } },
      'An API key must be 1 to 1,024 bytes long.',
    ],
    ['a key that is not text', { code: 'invalid_argument' }, 'Invalid API key'],
    [
      'the keychain unavailable',
      { code: 'key_store_unavailable', data: { reason: 'timeout' } },
      /system keychain, so the API key wasn't saved/,
    ],
    [
      'the keychain prompt cancelled',
      { code: 'key_store_cancelled' },
      /system keychain, so the API key wasn't saved/,
    ],
    [
      'a secrets write that is not durable',
      { code: 'storage', data: { kind: 'not_durable', file: 'secrets' } },
      /previous key stays in use/,
    ],
    [
      'the key file not written',
      { code: 'storage', data: { kind: 'no_space', file: 'rpc_api_keys' } },
      /couldn't save the API key/,
    ],
    [
      'an older core',
      { code: 'requirement_unmet', message: "The core can't take this request" },
      "The core can't take this request",
    ],
    [
      'no core',
      { code: 'core_unavailable', message: 'The identity core is not running' },
      'The identity core is not running',
    ],
  ])("a set refused for %s answers the settings page's error", async (_name, failure, error) => {
    load();
    core.failNext('secrets.set_rpc_api_key', failure);
    const answer = await rpc.setApiKey('alchemy', KEY, { caller: 'chrome' });
    expect(answer).toEqual({ success: false, error: expect.anything() });
    if (error instanceof RegExp) expect(answer.error).toMatch(error);
    else expect(answer.error).toBe(error);
    expect(rpc.hasApiKey('alchemy')).toBe(false);
    expect(fs.existsSync(keysPath)).toBe(false);
  });

  test('a remove the keychain refuses says so, and keeps the key', async () => {
    fs.writeFileSync(keysPath, JSON.stringify({ alchemy: { apiKey: KEY, enabled: true } }));
    load();
    await rpc.refreshKeys();
    core.failNext('secrets.remove_rpc_api_key', { code: 'key_store_unavailable' });
    const answer = await rpc.removeApiKey('alchemy', { caller: 'chrome' });
    expect(answer).toEqual({ success: false, error: expect.stringMatching(/wasn't removed/) });
    expect(rpc.hasApiKey('alchemy')).toBe(true);
  });
});

describe('RPC API keys stay in main (#1040)', () => {
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

  const vaultBackendMock = () => {
    const core = simulatedRpcKeysCore();
    return () => ({ vaultBackend: { secrets: core.secrets } });
  };

  async function loadRpcManager() {
    const ipcMain = createIpcMainMock();
    const { mod } = loadMainModule(require.resolve('./rpc-manager'), {
      ipcMain,
      userDataDir,
      extraMocks: { [require.resolve('../core/vault-backend')]: vaultBackendMock() },
    });
    await mod.refreshKeys();
    return { rpcManager: mod, ipcMain };
  }

  describe('rpc-manager keeps RPC API keys in main', () => {
    test('the fixture has keyed providers to check', () => {
      expect(keyedProviderIds.length).toBeGreaterThan(0);
      expect(chainIds).toContain('1');
    });

    test('main still resolves the keyed URLs for its own requests', async () => {
      const { rpcManager } = await loadRpcManager();
      for (const id of keyedProviderIds) {
        expect(rpcManager.getEffectiveRpcUrls(1).some((url) => url.includes(`${KEY}-${id}`))).toBe(
          true
        );
      }
    });

    test('offers no IPC registration: no channel answers with the RPC pool', async () => {
      const { rpcManager, ipcMain } = await loadRpcManager();
      for (const value of Object.values(rpcManager)) {
        if (typeof value === 'function' && /^register/.test(value.name)) value();
      }
      expect(Object.keys(rpcManager).filter((name) => /^register/.test(name))).toEqual([]);
      expect(ipcMain.handle).not.toHaveBeenCalled();
      expect(ipcMain.on).not.toHaveBeenCalled();
      expect(ipcMain.handlers.has('rpc:get-effective-urls')).toBe(false);
    });

    test('the keyless pool is the effective pool minus the keyed URLs, in its order', async () => {
      const { rpcManager } = await loadRpcManager();
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
          [require.resolve('../core/vault-backend')]: vaultBackendMock(),
          [require.resolve('../ens-resolver')]: () => ({ invalidateCachedProvider: jest.fn() }),
          [require.resolve('../core/chain')]: () => ({ chainSettingsChanged: jest.fn() }),
        },
      });
      mod.registerNetworkConfigIpc();
      // Main's copy holds the keys, so a read that leaked them would show.
      await require('./rpc-manager').refreshKeys();

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
});
