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
