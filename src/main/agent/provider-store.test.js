'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentProviderStore } = require('./provider-store');

function createSafeStorage(available = true) {
  return {
    isEncryptionAvailable: jest.fn(() => available),
    encryptString: jest.fn((value) =>
      Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)
    ),
    decryptString: jest.fn((value) => {
      const encoded = value.toString().replace(/^encrypted:/, '');
      return Buffer.from(encoded, 'base64').toString();
    }),
  };
}

function createStore(options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-agent-store-'));
  const safeStorage = options.safeStorage || createSafeStorage();
  return {
    dataDir,
    safeStorage,
    store: new AgentProviderStore({
      dataDir,
      userDataDir: options.userDataDir || path.dirname(dataDir),
      profileId: options.profileId || 'profile-test',
      safeStorage,
    }),
  };
}

describe('AgentProviderStore', () => {
  test('favorites and privacy survive key replacement, model switches and reopening', () => {
    const { store, dataDir, safeStorage } = createStore();
    store.saveHosted({ providerId: 'venice', modelId: 'one', apiKey: 'first' });
    store.savePreferences('venice', { privacyPolicy: 'tee', favoriteModelIds: ['one', 'two'] });
    store.saveHosted({ providerId: 'venice', modelId: 'two', apiKey: 'replacement' });
    store.saveHosted({ providerId: 'openai', modelId: 'other', apiKey: 'other-key' });
    const reopened = createStore({ dataDir, safeStorage }).store;
    expect(reopened.getSelection('venice').apiKey).toBe('replacement');
    expect(reopened.getSelection().providerId).toBe('openai');
    expect(
      reopened.getPublicStatus().connections.find((item) => item.providerId === 'venice')
    ).toMatchObject({
      privacyPolicy: 'tee',
      favoriteModelIds: ['one', 'two'],
      modelId: 'two',
    });
    expect(JSON.stringify(reopened.getPublicStatus())).not.toMatch(
      /replacement|other-key|encryptedApiKey/
    );
  });

  test('stores hosted credentials as profile-bound ciphertext', () => {
    const safeStorage = createSafeStorage();
    const { dataDir, store } = createStore({ safeStorage });

    store.saveHosted({ providerId: 'anthropic', modelId: 'claude-test', apiKey: 'sk-secret' });

    expect(store.getPublicStatus()).toEqual({
      secureStorageAvailable: true,
      configured: true,
      connections: [
        {
          kind: 'hosted',
          providerId: 'anthropic',
          modelId: 'claude-test',
        },
      ],
      kind: 'hosted',
      providerId: 'anthropic',
      modelId: 'claude-test',
    });
    expect(store.getSelection()).toEqual({
      kind: 'hosted',
      providerId: 'anthropic',
      modelId: 'claude-test',
      apiKey: 'sk-secret',
    });
    const persisted = fs.readFileSync(path.join(dataDir, 'provider.json'), 'utf8');
    expect(persisted).not.toContain('sk-secret');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dataDir, 'provider.json')).mode & 0o777).toBe(0o600);
    }
  });

  test.each([1, 2, 3])(
    'retires a sole Free Pi connection from store version %s without decrypting it',
    (version) => {
      const { store, dataDir, safeStorage } = createStore();
      store.saveHosted({ providerId: 'freepi', modelId: 'retired-model', apiKey: 'retired-key' });
      const file = path.join(dataDir, 'provider.json');
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (version < 3) {
        payload.selection = payload.connections.freepi;
        delete payload.connections;
        delete payload.activeProviderId;
      }
      payload.version = version;
      fs.writeFileSync(file, JSON.stringify(payload));
      safeStorage.decryptString.mockClear();

      expect(store.getPublicStatus()).toMatchObject({ configured: false, connections: [] });
      expect(store.getSelection()).toBeNull();
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
        version: 3,
        connections: {},
        activeProviderId: null,
      });
      expect(fs.readFileSync(file, 'utf8')).not.toContain('freepi');
    }
  );

  test.each(['freepi', 'openai'])(
    'retirement preserves other connections and credentials (active: %s)',
    async (activeProviderId) => {
      const { store, dataDir, safeStorage } = createStore();
      const credentials = store.createCredentialStore();
      const oauth = {
        type: 'oauth',
        access: 'test-access',
        refresh: 'test-refresh',
        expires: Date.now() + 60000,
      };
      await credentials.modify('openai-codex', async () => oauth);
      store.saveSubscription({ providerId: 'openai-codex', modelId: 'codex-model' });
      store.saveHosted({ providerId: 'openai', modelId: 'model-b', apiKey: 'openai-key' });
      store.saveHosted({ providerId: 'freepi', modelId: 'retired-model', apiKey: 'retired-key' });
      const file = path.join(dataDir, 'provider.json');
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      payload.activeProviderId = activeProviderId;
      fs.writeFileSync(file, JSON.stringify(payload));
      safeStorage.decryptString.mockClear();

      const status = store.getPublicStatus();
      expect(status.configured).toBe(activeProviderId === 'openai');
      expect(status.connections.map(({ providerId }) => providerId)).toEqual([
        'openai-codex',
        'openai',
      ]);
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(persisted.connections.openai).toEqual(payload.connections.openai);
      expect(persisted.credentials).toEqual(payload.credentials);
      expect(persisted.activeProviderId).toBe(activeProviderId === 'freepi' ? null : 'openai');
      expect(await credentials.read('openai-codex')).toEqual(oauth);
      store.select('openai', 'model-b');
      expect(store.getSelection()).toMatchObject({ providerId: 'openai', apiKey: 'openai-key' });
    }
  );

  test('stores keyless loopback configuration without secure storage', () => {
    const safeStorage = createSafeStorage(false);
    const { store } = createStore({ safeStorage });

    store.saveOllama({ modelId: 'qwen:7b', baseUrl: 'http://127.0.0.1:11434/v1' });

    expect(store.getSelection()).toEqual({
      kind: 'ollama',
      providerId: 'ollama',
      modelId: 'qwen:7b',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(store.getPublicStatus()).toMatchObject({
      secureStorageAvailable: false,
      configured: true,
      kind: 'ollama',
    });
  });

  test('persists discovered Ollama models and replaces stale models on refresh', () => {
    const { store } = createStore();
    const baseUrl = 'http://127.0.0.1:11434/v1';
    store.saveOllama({ modelId: 'qwen3:8b', modelIds: ['qwen3:8b', 'llama3.2:3b'], baseUrl });
    store.select('ollama', 'llama3.2:3b');
    store.savePreferences('ollama', { favoriteModelIds: ['qwen3:8b', 'llama3.2:3b'] });
    expect(store.getPublicStatus().connections[0].modelIds).toEqual(['qwen3:8b', 'llama3.2:3b']);
    expect(store.getSelection().modelId).toBe('llama3.2:3b');
    store.saveOllama({ modelId: 'qwen3:8b', modelIds: ['qwen3:8b'], baseUrl });
    expect(store.getPublicStatus().connections[0]).toMatchObject({
      modelIds: ['qwen3:8b'], favoriteModelIds: ['qwen3:8b'],
    });
    expect(() => store.select('ollama', 'llama3.2:3b')).toThrow();
  });

  test('bounds Ollama model history without invalidating other provider credentials', async () => {
    const { store } = createStore();
    const credentials = store.createCredentialStore();
    const oauth = {
      type: 'oauth',
      access: 'access-secret',
      refresh: 'refresh-secret',
      expires: Date.now() + 60_000,
    };
    await credentials.modify('openai-codex', async () => oauth);
    store.saveSubscription({ providerId: 'openai-codex', modelId: 'gpt-codex-test' });

    for (let index = 0; index < 129; index += 1) {
      store.saveOllama({
        modelId: `local-model-${index}`,
        baseUrl: 'http://127.0.0.1:11434/v1',
      });
    }

    const ollama = store
      .getPublicStatus()
      .connections.find((connection) => connection.providerId === 'ollama');
    expect(ollama.modelIds).toHaveLength(128);
    expect(ollama.modelIds).not.toContain('local-model-0');
    expect(ollama.modelIds.at(-1)).toBe('local-model-128');
    expect(store.getSelection()).toMatchObject({
      providerId: 'ollama',
      modelId: 'local-model-128',
    });
    expect(await credentials.read('openai-codex')).toEqual(oauth);
  });

  test('stores and refreshes a Pi OAuth credential as profile-bound ciphertext', async () => {
    const { dataDir, store } = createStore();
    const credentials = store.createCredentialStore();
    const initial = {
      type: 'oauth',
      access: 'access-secret',
      refresh: 'refresh-secret',
      expires: Date.now() + 60_000,
      accountId: 'account-test',
    };

    await credentials.modify('openai-codex', async () => initial);
    store.saveSubscription({ providerId: 'openai-codex', modelId: 'gpt-codex-test' });

    expect(await credentials.read('openai-codex')).toEqual(initial);
    expect(await credentials.list()).toEqual([{ providerId: 'openai-codex', type: 'oauth' }]);
    expect(store.getSelection()).toEqual({
      kind: 'subscription',
      providerId: 'openai-codex',
      modelId: 'gpt-codex-test',
    });
    const persistedBeforeRefresh = fs.readFileSync(path.join(dataDir, 'provider.json'), 'utf8');
    expect(persistedBeforeRefresh).not.toContain('access-secret');
    expect(persistedBeforeRefresh).not.toContain('refresh-secret');

    await credentials.modify('openai-codex', async (current) => ({
      ...current,
      access: 'refreshed-access-secret',
      expires: Date.now() + 120_000,
    }));
    expect(await credentials.read('openai-codex')).toMatchObject({
      access: 'refreshed-access-secret',
      refresh: 'refresh-secret',
    });
    expect(fs.readFileSync(path.join(dataDir, 'provider.json'), 'utf8')).not.toContain(
      'refreshed-access-secret'
    );
  });

  test('removes subscription selection when Pi logs out', async () => {
    const { store } = createStore();
    const credentials = store.createCredentialStore();
    await credentials.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: Date.now() + 60_000,
    }));
    store.saveSubscription({ providerId: 'openai-codex', modelId: 'gpt-codex-test' });

    await credentials.delete('openai-codex');

    expect(await credentials.read('openai-codex')).toBeUndefined();
    expect(store.getPublicStatus()).toMatchObject({ configured: false });
  });

  test('does not resurrect a credential cleared during token refresh', async () => {
    const { store } = createStore();
    const credentials = store.createCredentialStore();
    await credentials.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: Date.now() + 60_000,
    }));
    store.saveSubscription({ providerId: 'openai-codex', modelId: 'gpt-codex-test' });
    let finishRefresh;
    let markRefreshStarted;
    const refreshStarted = new Promise((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshPending = credentials.modify(
      'openai-codex',
      (current) =>
        new Promise((resolve) => {
          markRefreshStarted();
          finishRefresh = () =>
            resolve({
              ...current,
              access: 'refreshed-access',
              expires: Date.now() + 120_000,
            });
        })
    );
    await refreshStarted;

    store.clear();
    finishRefresh();

    await expect(refreshPending).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_UNAVAILABLE' });
    expect(await credentials.read('openai-codex')).toBeUndefined();
    expect(store.getPublicStatus()).toMatchObject({ configured: false });
  });

  test('refuses hosted credentials when OS encryption is unavailable', () => {
    const { store } = createStore({ safeStorage: createSafeStorage(false) });
    expect(() =>
      store.saveHosted({ providerId: 'openai', modelId: 'gpt-test', apiKey: 'sk-secret' })
    ).toThrow('Secure credential storage is unavailable');
  });

  test('rejects copied or malformed provider files', () => {
    const safeStorage = createSafeStorage();
    const ctx = createStore({ safeStorage, profileId: 'profile-a' });
    ctx.store.saveHosted({ providerId: 'openai', modelId: 'gpt-test', apiKey: 'sk-secret' });
    const copied = new AgentProviderStore({
      dataDir: ctx.dataDir,
      userDataDir: path.dirname(ctx.dataDir),
      profileId: 'profile-b',
      safeStorage,
    });
    expect(() => copied.getSelection()).toThrow('does not belong to this profile');
  });

  test('reads version-one provider records and upgrades them on the next write', () => {
    const { dataDir, store } = createStore();
    store.saveHosted({ providerId: 'openai', modelId: 'gpt-test', apiKey: 'sk-secret' });
    const filePath = path.join(dataDir, 'provider.json');
    const legacy = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    legacy.version = 1;
    legacy.selection = legacy.connections.openai;
    delete legacy.connections;
    delete legacy.activeProviderId;
    delete legacy.credentials;
    fs.writeFileSync(filePath, JSON.stringify(legacy), { mode: 0o600 });

    expect(store.getSelection()).toMatchObject({
      kind: 'hosted',
      providerId: 'openai',
      apiKey: 'sk-secret',
    });
    store.saveOllama({ modelId: 'qwen:7b', baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toMatchObject({
      version: 3,
      credentials: {},
    });
  });

  test('keeps multiple provider connections and switches the active model', () => {
    const { store } = createStore();

    store.saveHosted({ providerId: 'openai', modelId: 'gpt-test', apiKey: 'sk-openai' });
    store.saveHosted({
      providerId: 'anthropic',
      modelId: 'claude-test',
      apiKey: 'sk-anthropic',
    });

    expect(store.getPublicStatus()).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-test',
      connections: [
        { providerId: 'openai', modelId: 'gpt-test' },
        { providerId: 'anthropic', modelId: 'claude-test' },
      ],
    });
    store.select('openai', 'gpt-next');
    expect(store.getSelection()).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-next',
      apiKey: 'sk-openai',
    });

    store.remove('openai');
    expect(store.getPublicStatus()).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-test',
      connections: [{ providerId: 'anthropic' }],
    });
  });

  test('clears credential material without deleting the bound store', () => {
    const { dataDir, store } = createStore();
    store.saveHosted({ providerId: 'openrouter', modelId: 'model', apiKey: 'secret' });

    store.clear();

    expect(store.getSelection()).toBeNull();
    expect(store.getPublicStatus()).toMatchObject({ configured: false });
    expect(fs.existsSync(path.join(dataDir, 'provider.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'provider.json'), 'utf8')).not.toContain('secret');
  });
});
