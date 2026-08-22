'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentProviderStore } = require('./provider-store');

function createSafeStorage(available = true) {
  return {
    isEncryptionAvailable: jest.fn(() => available),
    encryptString: jest.fn((value) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)),
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
