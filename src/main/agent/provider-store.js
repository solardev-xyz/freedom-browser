'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROVIDER_STORE_VERSION = 2;
const LEGACY_PROVIDER_STORE_VERSION = 1;
const PROVIDER_STORE_FILE = 'provider.json';
const MAX_PROVIDER_STORE_BYTES = 256 * 1024;

class AgentProviderStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentProviderStoreError';
    this.code = code;
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function resolvedPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function createBinding(profileId, userDataDir) {
  return {
    profileId: profileId || 'default',
    userDataDirHash: sha256Hex(resolvedPath(userDataDir)),
  };
}

function assertRegularFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AgentProviderStoreError(
      'AGENT_PROVIDER_STORE_UNSAFE',
      'Agent provider storage is not a regular file'
    );
  }
  if (stat.size > MAX_PROVIDER_STORE_BYTES) {
    throw new AgentProviderStoreError(
      'AGENT_PROVIDER_STORE_INVALID',
      'Agent provider storage is unexpectedly large'
    );
  }
}

function isStoredSelection(selection) {
  if (selection === null) return true;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return false;
  if (
    typeof selection.providerId !== 'string' ||
    typeof selection.modelId !== 'string' ||
    !selection.providerId ||
    !selection.modelId
  ) {
    return false;
  }
  if (selection.kind === 'hosted') {
    return (
      typeof selection.encryptedApiKey === 'string' &&
      selection.encryptedApiKey.length > 0 &&
      selection.encryptedApiKey.length <= 128 * 1024
    );
  }
  if (selection.kind === 'subscription') return selection.providerId === 'openai-codex';
  return selection.kind === 'ollama' && typeof selection.baseUrl === 'string';
}

function isStoredCredentialMap(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return false;
  return Object.entries(credentials).every(
    ([providerId, encryptedCredential]) =>
      providerId === 'openai-codex' &&
      typeof encryptedCredential === 'string' &&
      encryptedCredential.length > 0 &&
      encryptedCredential.length <= 192 * 1024
  );
}

function isOAuthCredential(credential) {
  return (
    credential !== null &&
    typeof credential === 'object' &&
    !Array.isArray(credential) &&
    credential?.type === 'oauth' &&
    typeof credential.access === 'string' &&
    credential.access.length > 0 &&
    credential.access.length <= 128 * 1024 &&
    typeof credential.refresh === 'string' &&
    credential.refresh.length > 0 &&
    credential.refresh.length <= 128 * 1024 &&
    Number.isFinite(credential.expires) &&
    credential.expires > 0
  );
}

class AgentProviderStore {
  constructor(options = {}) {
    if (!options.safeStorage) throw new TypeError('AgentProviderStore requires safeStorage');
    if (typeof options.dataDir !== 'string' || !options.dataDir) {
      throw new TypeError('AgentProviderStore requires a profile data directory');
    }
    this.safeStorage = options.safeStorage;
    this.dataDir = path.resolve(options.dataDir);
    this.filePath = path.join(this.dataDir, PROVIDER_STORE_FILE);
    this.binding = createBinding(options.profileId, options.userDataDir || this.dataDir);
    this.credentialOperations = new Map();
    this.credentialStore = this.#createCredentialStore();
  }

  isEncryptionAvailable() {
    return this.safeStorage.isEncryptionAvailable() === true;
  }

  getPublicStatus() {
    const payload = this.#read();
    const selection = payload.selection;
    return {
      secureStorageAvailable: this.isEncryptionAvailable(),
      configured: Boolean(selection),
      ...(selection && {
        kind: selection.kind,
        providerId: selection.providerId,
        modelId: selection.modelId,
        ...(selection.kind === 'ollama' && { baseUrl: selection.baseUrl }),
      }),
    };
  }

  getSelection() {
    const selection = this.#read().selection;
    if (!selection) return null;
    if (selection.kind === 'ollama' || selection.kind === 'subscription') return { ...selection };
    if (!this.isEncryptionAvailable()) {
      throw new AgentProviderStoreError(
        'AGENT_SECURE_STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable'
      );
    }
    let apiKey;
    try {
      apiKey = this.safeStorage.decryptString(Buffer.from(selection.encryptedApiKey, 'base64'));
    } catch {
      throw new AgentProviderStoreError(
        'AGENT_CREDENTIAL_UNAVAILABLE',
        'The saved provider credential could not be decrypted'
      );
    }
    if (!apiKey) {
      throw new AgentProviderStoreError(
        'AGENT_CREDENTIAL_UNAVAILABLE',
        'The saved provider credential is empty'
      );
    }
    return { kind: 'hosted', providerId: selection.providerId, modelId: selection.modelId, apiKey };
  }

  saveHosted({ providerId, modelId, apiKey }) {
    if (!this.isEncryptionAvailable()) {
      throw new AgentProviderStoreError(
        'AGENT_SECURE_STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable'
      );
    }
    const encryptedApiKey = this.safeStorage.encryptString(apiKey).toString('base64');
    this.#write({
      selection: { kind: 'hosted', providerId, modelId, encryptedApiKey },
      credentials: {},
    });
  }

  saveOllama({ modelId, baseUrl }) {
    this.#write({
      selection: { kind: 'ollama', providerId: 'ollama', modelId, baseUrl },
      credentials: {},
    });
  }

  saveSubscription({ providerId, modelId }) {
    if (!this.#readOAuthCredential(providerId)) {
      throw new AgentProviderStoreError(
        'AGENT_CREDENTIAL_UNAVAILABLE',
        'The saved provider credential is unavailable'
      );
    }
    const payload = this.#read();
    this.#write({
      selection: { kind: 'subscription', providerId, modelId },
      credentials: payload.credentials,
    });
  }

  createCredentialStore() {
    return this.credentialStore;
  }

  clear() {
    this.#write({ selection: null, credentials: {} });
  }

  #read() {
    if (!fs.existsSync(this.filePath)) return { selection: null, credentials: {} };
    assertRegularFile(this.filePath);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      throw new AgentProviderStoreError(
        'AGENT_PROVIDER_STORE_INVALID',
        'Agent provider storage could not be read'
      );
    }
    const isLegacy = payload?.version === LEGACY_PROVIDER_STORE_VERSION;
    if (
      (!isLegacy && payload?.version !== PROVIDER_STORE_VERSION) ||
      payload?.profileId !== this.binding.profileId ||
      payload?.userDataDirHash !== this.binding.userDataDirHash ||
      !isStoredSelection(payload.selection) ||
      (!isLegacy && !isStoredCredentialMap(payload.credentials))
    ) {
      throw new AgentProviderStoreError(
        'AGENT_PROVIDER_STORE_INVALID',
        'Agent provider storage does not belong to this profile'
      );
    }
    return { ...payload, credentials: isLegacy ? {} : payload.credentials };
  }

  #write({ selection, credentials }) {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    assertRegularFile(this.filePath);
    const payload = Buffer.from(
      JSON.stringify(
        {
          version: PROVIDER_STORE_VERSION,
          ...this.binding,
          selection,
          credentials,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    );
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const descriptor = fs.openSync(
      this.filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow,
      0o600
    );
    try {
      fs.writeFileSync(descriptor, payload);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows may not implement POSIX permission bits.
    }
  }

  #readOAuthCredential(providerId) {
    const encryptedCredential = this.#read().credentials[providerId];
    if (!encryptedCredential) return undefined;
    if (!this.isEncryptionAvailable()) {
      throw new AgentProviderStoreError(
        'AGENT_SECURE_STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable'
      );
    }
    let credential;
    try {
      const serialized = this.safeStorage.decryptString(Buffer.from(encryptedCredential, 'base64'));
      credential = JSON.parse(serialized);
    } catch {
      throw new AgentProviderStoreError(
        'AGENT_CREDENTIAL_UNAVAILABLE',
        'The saved provider credential could not be decrypted'
      );
    }
    if (!isOAuthCredential(credential)) {
      throw new AgentProviderStoreError(
        'AGENT_CREDENTIAL_UNAVAILABLE',
        'The saved provider credential is invalid'
      );
    }
    return structuredClone(credential);
  }

  #writeOAuthCredential(providerId, credential) {
    if (providerId !== 'openai-codex' || !isOAuthCredential(credential)) {
      throw new AgentProviderStoreError(
        'AGENT_CREDENTIAL_UNAVAILABLE',
        'The provider credential is invalid'
      );
    }
    if (!this.isEncryptionAvailable()) {
      throw new AgentProviderStoreError(
        'AGENT_SECURE_STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable'
      );
    }
    const serialized = JSON.stringify(credential);
    if (Buffer.byteLength(serialized, 'utf8') > 128 * 1024) {
      throw new AgentProviderStoreError(
        'AGENT_CREDENTIAL_UNAVAILABLE',
        'The provider credential is unexpectedly large'
      );
    }
    const payload = this.#read();
    this.#write({
      selection: payload.selection,
      credentials: {
        ...payload.credentials,
        [providerId]: this.safeStorage.encryptString(serialized).toString('base64'),
      },
    });
  }

  #deleteOAuthCredential(providerId) {
    const payload = this.#read();
    const credentials = { ...payload.credentials };
    delete credentials[providerId];
    this.#write({
      selection:
        payload.selection?.kind === 'subscription' && payload.selection.providerId === providerId
          ? null
          : payload.selection,
      credentials,
    });
  }

  #enqueueCredentialOperation(providerId, operation) {
    const previous = this.credentialOperations.get(providerId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.credentialOperations.set(providerId, current);
    return current.finally(() => {
      if (this.credentialOperations.get(providerId) === current) {
        this.credentialOperations.delete(providerId);
      }
    });
  }

  #createCredentialStore() {
    return Object.freeze({
      read: async (providerId, options = {}) => {
        options.signal?.throwIfAborted();
        const credential = this.#readOAuthCredential(providerId);
        options.signal?.throwIfAborted();
        return credential;
      },
      list: async (options = {}) => {
        options.signal?.throwIfAborted();
        const credentials = Object.keys(this.#read().credentials).map((providerId) => ({
          providerId,
          type: 'oauth',
        }));
        options.signal?.throwIfAborted();
        return credentials;
      },
      modify: (providerId, modify, options = {}) =>
        this.#enqueueCredentialOperation(providerId, async () => {
          options.signal?.throwIfAborted();
          const expectedCiphertext = this.#read().credentials[providerId];
          const current = this.#readOAuthCredential(providerId);
          const next = await modify(current);
          options.signal?.throwIfAborted();
          if (next !== undefined) {
            const latestCiphertext = this.#read().credentials[providerId];
            if (latestCiphertext !== expectedCiphertext) {
              throw new AgentProviderStoreError(
                'AGENT_CREDENTIAL_UNAVAILABLE',
                'The provider credential changed during an update'
              );
            }
            this.#writeOAuthCredential(providerId, next);
          }
          return next === undefined ? current : structuredClone(next);
        }),
      delete: (providerId, options = {}) =>
        this.#enqueueCredentialOperation(providerId, async () => {
          options.signal?.throwIfAborted();
          this.#deleteOAuthCredential(providerId);
        }),
    });
  }
}

module.exports = {
  MAX_PROVIDER_STORE_BYTES,
  PROVIDER_STORE_FILE,
  PROVIDER_STORE_VERSION,
  AgentProviderStore,
  AgentProviderStoreError,
  createBinding,
  isOAuthCredential,
  isStoredCredentialMap,
  isStoredSelection,
};
