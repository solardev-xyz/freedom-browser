/**
 * The running generation's identity, and write admission, on freedom-radicled
 * (freedom-core design 0008, Main's side, "The active identity belongs to
 * the generation", "The next start's identity", "Main no longer reads
 * keys/"; Tests first, "Keys", "vault changes without a restart"; the
 * radicled step-5 plan's B10).
 *
 * Main's own modules run here, under FREEDOM_RADICLE_BACKEND=service:
 * radicle-manager.js with a real RadicledNode on an in-process fake service
 * (fake-radicled.js), radicle-embedded.js and cob-service.js on it, the
 * provider's executeRadicleMethod with the real Radicle permission store,
 * and identity-manager.js's getIdentityStatus. Only the core is faked: its
 * vault, which the test creates, locks, unlocks and deletes while a node
 * runs, the seal it answers each start with, and the derived DID
 * `keys.addresses` names.
 *
 * A write the provider admits is the service's `rad.write` (plan B11), which
 * the fake service answers; the test counts what reached it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const { fakeRadicled } = require('../../../test/helpers/fake-radicled');

const DERIVED_DID = 'did:key:z6MkderivedFromTheVaultMnemonic00000000000000';
const DERIVED_NID = 'z6MkderivedFromTheVaultMnemonic00000000000000';
// What an old key file in the home names: main must never show it.
const KEY_FILE_DID = 'did:key:z6MkfromAKeyFileMainMustNotRead000000000000';
const ORIGIN = `bzz://${'a'.repeat(64)}`;
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const ISSUE = { rid: RID, title: 'Bug', description: 'Steps' };
const NEEDS_VAULT = {
  code: 4900,
  message:
    "Radicle is running with a throwaway key and can't publish. Restart Radicle once your identity is set up.",
  data: { reason: 'needs_vault' },
};
const SEALED = Object.freeze({
  enc: Buffer.alloc(32, 0xa5).toString('base64'),
  ciphertext: Buffer.alloc(48, 0x5a).toString('base64'),
});

const coded = (code, message = code) => Object.assign(new Error(message), { code });

/**
 * The core's vault as main and the node see it (core/vault-backend.js):
 * its state, the seal each start asks for, `keys.addresses`, and its
 * events. `create`, `lock`, `unlock` and `remove` change it as the user
 * would, while a node runs.
 */
function fakeVaultBackend({ exists, unlocked }) {
  const listeners = new Set();
  const emit = (name, data = {}) => {
    for (const listener of [...listeners]) listener(name, data);
  };
  const vault = {
    state: { exists, unlocked },
    status: jest.fn(async () => ({
      exists: vault.state.exists,
      unlocked: vault.state.unlocked,
      epoch: null,
      fingerprint: null,
    })),
    addresses: jest.fn(async ({ accounts = [] } = {}) => {
      if (!vault.state.exists) throw coded('no_vault', 'No vault exists');
      if (!vault.state.unlocked) throw coded('vault_locked', 'Vault is locked');
      return {
        user_wallets: accounts.map((account) => ({ account, address: `0xderived${account}` })),
        bee_wallet: '0xbee',
        publishers: [],
        radicle: { public_key: '00', did: DERIVED_DID, node_id: DERIVED_NID },
      };
    }),
    sealRadicleKey: jest.fn(async () => {
      if (!vault.state.exists) throw coded('no_vault', 'No vault exists');
      if (!vault.state.unlocked) throw coded('vault_locked', 'Vault is locked');
      return { ...SEALED };
    }),
    writeNodeIdentity: jest.fn(async () => ({ status: 'installed' })),
    onVaultEvent: jest.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    create() {
      vault.state = { exists: true, unlocked: true };
      emit('vault.unlocked', { epoch: 1 });
    },
    lock() {
      vault.state.unlocked = false;
      emit('vault.locked', { reason: 'manual' });
    },
    unlock() {
      vault.state.unlocked = true;
      emit('vault.unlocked', { epoch: 2 });
    },
    remove() {
      vault.state = { exists: false, unlocked: false };
      emit('vault.locked', { reason: 'deleted' });
    },
  };
  return vault;
}

/**
 * The fake service's answers: a sealed start runs as the derived key, an
 * ephemeral one as a new throwaway key each time, and `rad.read`'s
 * `identity` names the process's own.
 */
function serviceScript() {
  let throwaways = 0;
  return {
    identity: (message, child) => {
      if (message.params?.ephemeral) {
        throwaways += 1;
        child.radIdentity = {
          did: `did:key:z6MkThrowaway${throwaways}`,
          nid: `z6MkThrowaway${throwaways}`,
          ephemeral: true,
        };
      } else {
        child.radIdentity = { did: DERIVED_DID, nid: DERIVED_NID, ephemeral: false };
      }
      child.result(message.id, child.radIdentity);
    },
    start: (message, child) =>
      child.result(message.id, {
        did: child.radIdentity.did,
        nid: child.radIdentity.nid,
        alias: message.params?.alias ?? null,
      }),
    write: (message, child) => child.result(message.id, { id: 'c'.repeat(40) }),
    read: (message, child) => {
      if (message.params?.op !== 'identity') {
        child.error(message.id, 'not_found', 'not found');
        return;
      }
      const { did, nid } = child.radIdentity;
      child.readReply(message.id, JSON.stringify({ did, nid, alias: 'FreedomBrowser' }));
    },
  };
}

let root;
let home;
let saved;
let vault;
let service;
let manager;
let identity;
let provider;
let cob;
let permissions;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-generation-identity-'));
  home = path.join(root, 'R');
  fs.mkdirSync(home, { recursive: true });
  saved = {
    backend: process.env.FREEDOM_RADICLE_BACKEND,
    data: process.env.FREEDOM_RADICLE_DATA,
    identity: process.env.FREEDOM_IDENTITY_DATA,
    addon: process.env.FREEDOM_RADICLE_ADDON,
  };
  process.env.FREEDOM_RADICLE_BACKEND = 'service';
  process.env.FREEDOM_RADICLE_DATA = home;
  process.env.FREEDOM_IDENTITY_DATA = path.join(root, 'identity');
  // An add-on that must never load.
  process.env.FREEDOM_RADICLE_ADDON = path.join(root, 'no-such', 'libradicle.node');
});

afterEach(async () => {
  await manager?.stopRadicle();
  manager = null;
  for (const [key, name] of [
    ['backend', 'FREEDOM_RADICLE_BACKEND'],
    ['data', 'FREEDOM_RADICLE_DATA'],
    ['identity', 'FREEDOM_IDENTITY_DATA'],
    ['addon', 'FREEDOM_RADICLE_ADDON'],
  ]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Main's modules over the fake core (`vaultState`) and the fake service. */
function load(vaultState) {
  vault = fakeVaultBackend(vaultState);
  service = fakeRadicled(serviceScript());
  const nodePath = require.resolve('./radicled-node');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const { mod } = loadMainModule(require.resolve('../identity-manager'), {
    userDataDir: userData,
    extraMocks: {
      [require.resolve('../logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
      [require.resolve('../core/vault-backend')]: () => ({ vaultBackend: vault }),
      [require.resolve('../service-grant')]: () => ({ radicleGrantRefusal: () => null }),
      // The real node, spawning the fake service: its core is the fake
      // vault (coreKeys over vault-backend.js).
      [nodePath]: () => {
        const actual = jest.requireActual(nodePath);
        class TestRadicledNode extends actual.RadicledNode {
          static isAvailable() {
            return true;
          }
          constructor(options) {
            super({
              ...options,
              command: 'freedom-radicled',
              spawn: service.spawn,
              removeStaleSocket: async () => false,
              guard: { blockReason: () => null, block: () => {}, unblock: () => {} },
            });
          }
        }
        return { ...actual, RadicledNode: TestRadicledNode };
      },
    },
  });
  identity = mod;
  // The core's hello reported startup recovery, with nothing outstanding.
  require('../core/node-identity-guard').setStartupRecovery(null);
  manager = require('../radicle-manager');
  provider = require('./radicle-provider-ipc');
  cob = require('./cob-service');
  permissions = require('./radicle-permissions');
  permissions.grantPermission(ORIGIN);
  permissions.grantSigning(ORIGIN);
}

/** The writes that reached the service, every process's. */
const writesSent = () => service.children.flatMap((child) => child.sent('rad.write')).length;

async function startNode() {
  const status = await manager.startRadicle();
  expect(status).toEqual({ status: 'running', error: null });
}

async function restartNode() {
  await manager.stopRadicle();
  await startNode();
}

/** A COB write as main's page path runs it, after the user's approval. */
async function write() {
  try {
    return {
      result: await provider.executeRadicleMethod('radicle_createIssue', ISSUE, ORIGIN, {
        approval: 'user',
      }),
    };
  } catch (error) {
    return { error };
  }
}

const throwaway = (n) => ({ did: `did:key:z6MkThrowaway${n}`, ephemeral: true });
const derived = { did: DERIVED_DID, ephemeral: false };
const WRITTEN = { result: { id: 'c'.repeat(40) } };

describe('vault changes without a restart (0008, Tests first, "Keys")', () => {
  test('a throwaway node keeps refusing writes after a vault is created; after a restart the derived identity follows the create', async () => {
    load({ exists: false, unlocked: false });
    await startNode();
    expect(manager.activeRadicleIdentity()).toMatchObject(throwaway(1));
    await expect(identity.getIdentityStatus()).resolves.toMatchObject({
      hasVault: false,
      radicleInjected: false,
      addresses: null,
      radicle: { active: throwaway(1), nextDid: null },
    });
    // Refused in main, before anything is sent.
    await expect(write()).resolves.toEqual({ error: NEEDS_VAULT });
    expect(writesSent()).toBe(0);
    // Reads work in either mode.
    await expect(cob.getIdentity()).resolves.toMatchObject({ did: throwaway(1).did });

    vault.create();
    // The running node's identity and its admission stay the generation's;
    // the derived DID is shown only as the next start's.
    await expect(identity.getIdentityStatus()).resolves.toMatchObject({
      hasVault: true,
      isUnlocked: true,
      addresses: { radicleDid: throwaway(1).did },
      radicle: { active: throwaway(1), nextDid: DERIVED_DID },
    });
    await expect(write()).resolves.toEqual({ error: NEEDS_VAULT });
    expect(writesSent()).toBe(0);
    expect(vault.sealRadicleKey).toHaveBeenCalledTimes(1);

    // The next start runs as the derived key, and writes go.
    await restartNode();
    expect(manager.activeRadicleIdentity()).toMatchObject(derived);
    await expect(identity.getIdentityStatus()).resolves.toMatchObject({
      addresses: { radicleDid: DERIVED_DID },
      radicle: { active: derived, nextDid: DERIVED_DID },
    });
    await expect(write()).resolves.toEqual(WRITTEN);
    expect(writesSent()).toBe(1);
    // cob-service's identity went with the throwaway generation.
    await expect(cob.getIdentity()).resolves.toMatchObject({ did: DERIVED_DID });
  });

  test('a derived node keeps admitting writes after a lock and after a delete; after a restart a throwaway one follows the delete', async () => {
    load({ exists: true, unlocked: true });
    await startNode();
    expect(manager.activeRadicleIdentity()).toMatchObject(derived);
    await expect(cob.getIdentity()).resolves.toMatchObject({ did: DERIVED_DID });
    await expect(write()).resolves.toEqual(WRITTEN);

    vault.lock();
    await expect(identity.getIdentityStatus()).resolves.toMatchObject({
      isUnlocked: false,
      addresses: { radicleDid: DERIVED_DID },
      // Locked: no next start's DID known.
      radicle: { active: derived, nextDid: null },
    });
    await expect(write()).resolves.toEqual(WRITTEN);

    vault.unlock();
    await expect(identity.getIdentityStatus()).resolves.toMatchObject({
      radicle: { active: derived, nextDid: DERIVED_DID },
    });
    await expect(write()).resolves.toEqual(WRITTEN);

    vault.remove();
    await expect(identity.getIdentityStatus()).resolves.toMatchObject({
      hasVault: false,
      addresses: null,
      radicle: { active: derived, nextDid: null },
    });
    await expect(write()).resolves.toEqual(WRITTEN);
    expect(writesSent()).toBe(4);
    expect(manager.activeRadicleIdentity()).toMatchObject(derived);

    // The next start, with no vault, runs as a throwaway key.
    await restartNode();
    expect(manager.activeRadicleIdentity()).toMatchObject(throwaway(1));
    await expect(identity.getIdentityStatus()).resolves.toMatchObject({
      radicle: { active: throwaway(1), nextDid: null },
    });
    await expect(write()).resolves.toEqual({ error: NEEDS_VAULT });
    expect(writesSent()).toBe(4);
    // The derived identity cob-service read went with its generation.
    await expect(cob.getIdentity()).resolves.toMatchObject({ did: throwaway(1).did });
  });

  test("each throwaway start is a new identity, and cob-service's identity follows it", async () => {
    load({ exists: false, unlocked: false });
    await startNode();
    await expect(cob.getIdentity()).resolves.toMatchObject({ did: throwaway(1).did });
    // Kept while the generation runs: no second read.
    const reads = () => service.children.flatMap((c) => c.sent('rad.read')).length;
    const before = reads();
    await expect(cob.getIdentity()).resolves.toMatchObject({ did: throwaway(1).did });
    expect(reads()).toBe(before);

    await restartNode();
    await expect(cob.getIdentity()).resolves.toMatchObject({ did: throwaway(2).did });
    await expect(identity.getIdentityStatus()).resolves.toMatchObject({
      radicle: { active: throwaway(2) },
    });
  });
});

describe("main no longer reads keys/ (0008, Main's side)", () => {
  /** Whether any of `spy`'s calls named a path under the home's keys/. */
  const touchedKeys = (spy) =>
    spy.mock.calls.some(
      ([file]) => typeof file === 'string' && file.startsWith(path.join(home, 'keys'))
    );

  test("an old key file is never read: no node running shows no DID, locked or not, and the status isn't 'injected'", async () => {
    fs.mkdirSync(path.join(home, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(home, 'keys', 'radicle'), 'not a key');
    fs.writeFileSync(
      path.join(home, 'keys', 'radicle.pub'),
      `ssh-ed25519 ${'A'.repeat(68)} ${KEY_FILE_DID}`
    );
    load({ exists: true, unlocked: false });
    const exists = jest.spyOn(fs, 'existsSync');
    const reads = jest.spyOn(fs, 'readFileSync');
    try {
      // Locked, no node running (deviation locked-did): no Radicle DID.
      await expect(identity.getIdentityStatus()).resolves.toMatchObject({
        radicleInjected: false,
        addresses: { radicleDid: null },
        radicle: { active: null, nextDid: null },
      });
      // Unlocked, no node running: the next start's DID, and none for the node.
      vault.unlock();
      await expect(identity.getIdentityStatus()).resolves.toMatchObject({
        radicleInjected: false,
        addresses: { radicleDid: null },
        radicle: { active: null, nextDid: DERIVED_DID },
      });
      expect(touchedKeys(exists)).toBe(false);
      expect(touchedKeys(reads)).toBe(false);
    } finally {
      exists.mockRestore();
      reads.mockRestore();
    }
  });
});
