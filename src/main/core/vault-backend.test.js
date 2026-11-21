const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/** A fake CoreClient: `handle(method, params)` returns a result or throws. */
class FakeCore extends EventEmitter {
  constructor(handle) {
    super();
    this.handle = handle;
    this.calls = [];
    this.ready = Promise.resolve();
  }

  async request(method, params, context, options) {
    this.calls.push({ method, params, context, options });
    return this.handle(method, params, this);
  }

  whenReady() {
    return this.ready;
  }
}

function coreError(code, message) {
  return Object.assign(new Error(message), { code });
}

function load(core) {
  jest.resetModules();
  jest.doMock('./core-process', () => ({ getCoreClient: () => core }));
  const mod = require('./vault-backend');
  mod._internal.reset();
  return mod;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const FP = 'a'.repeat(64);

describe('vaultBackend', () => {
  test('requests go out as shell with base64 secrets; results decode', async () => {
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: false, fingerprint: null };
      if (method === 'vault.create') {
        return { mnemonic_b64: b64('abandon about'), addresses: { user_wallet: '0x1' } };
      }
      if (method === 'vault.export_private_key') return { private_key_hex: '0xabc' };
      return {};
    });
    const { vaultBackend } = load(core);
    const created = await vaultBackend.createVault('pässwörd1', 128);
    expect(created).toEqual({ mnemonic: 'abandon about', addresses: { user_wallet: '0x1' } });
    const create = core.calls.find((c) => c.method === 'vault.create');
    expect(create.context).toEqual({ caller: 'shell' });
    expect(create.params).toMatchObject({ password_b64: b64('pässwörd1'), words: 12 });
    await expect(vaultBackend.exportPrivateKey('pw', 2)).resolves.toBe('0xabc');
    expect(core.calls.at(-1).params).toEqual({ password_b64: b64('pw'), account: 2 });
  });

  test('core errors keep their JS message and code', async () => {
    const core = new FakeCore(() => {
      throw coreError('incorrect_password', 'Incorrect password');
    });
    const { vaultBackend } = load(core);
    await expect(vaultBackend.unlock('nope')).rejects.toMatchObject({
      code: 'incorrect_password',
      message: 'Incorrect password',
    });
  });

  // freedom-core design 0013, "One writer per store": a store's requests
  // pass `requiresStore(name)`, checked by the client against the hello of
  // the process the request is written to; every other request none.
  test('call passes requires through to the client, and null without one', async () => {
    const core = new FakeCore(() => ({ count: 0 }));
    const { _internal } = load(core);
    const requires = () => true;
    await _internal.call('payments.get_count', { filters: {} }, null, { requires });
    await _internal.call('payments.get_count', { filters: {} }, 'chrome', { requires });
    await _internal.call('vault.status');
    expect(core.calls.map(({ method, context, options }) => [method, context, options])).toEqual([
      ['payments.get_count', { caller: 'shell' }, { watchdogMs: 15_000, requires }],
      ['payments.get_count', { caller: 'chrome' }, { watchdogMs: 15_000, requires }],
      ['vault.status', { caller: 'shell' }, { watchdogMs: 15_000, requires: null }],
    ]);
  });

  test('a requirement the core client refuses keeps its code', async () => {
    const core = new FakeCore(() => {
      throw coreError('requirement_unmet', "The core can't take this request");
    });
    const { _internal } = load(core);
    await expect(
      _internal.call('payments.get_count', { filters: {} }, null, { requires: () => false })
    ).rejects.toMatchObject({ name: 'VaultBackendError', code: 'requirement_unmet' });
  });

  // vault-meta.json's methods (design 0013, PRF-6(a)): each with
  // `requires: requiresStore('vault_meta')`, as the chrome or as main, the
  // reference's refusals with their codes.
  test('accounts.*: wire shapes, callers and requires', async () => {
    const core = new FakeCore((method) => {
      switch (method) {
        case 'accounts.list':
          return { wallets: [{ index: 0 }] };
        case 'accounts.meta':
          return { meta: { userKnowsPassword: true } };
        case 'accounts.active':
          return { index: 2 };
        case 'accounts.record_address_check':
          return { address_check: 'matched' };
        case 'accounts.add_mnemonic':
        case 'accounts.add_ledger':
        case 'accounts.add_remote':
        case 'accounts.add_safe':
          return { wallet: { index: 7 } };
        default:
          return { durable: false };
      }
    });
    const { vaultBackend } = load(core);
    const { accounts } = vaultBackend;
    await expect(accounts.list('chrome')).resolves.toEqual([{ index: 0 }]);
    await expect(accounts.list()).resolves.toEqual([{ index: 0 }]);
    await expect(accounts.meta('chrome')).resolves.toEqual({ userKnowsPassword: true });
    await expect(accounts.active()).resolves.toBe(2);
    await expect(accounts.addMnemonic('Spare', 'chrome')).resolves.toEqual({ index: 7 });
    await expect(accounts.addMnemonic(undefined)).resolves.toEqual({ index: 7 });
    await accounts.addLedger({ name: '', address: '0xA', path: "44'/60'/0'/0/0" });
    await accounts.addRemote({ address: '0xB' });
    await expect(accounts.recordAddressCheck('remote', 1000000, false)).resolves.toBe('matched');
    await accounts.addSafe({ name: 'S', address: '0xC', owners: [0, 1], threshold: 1, saltNonce: '5' });
    await accounts.markSafeDeployed(1000001, 100);
    await accounts.setActive(2, 'chrome');
    await accounts.rename(2, 'Two', 'chrome');
    await accounts.remove(2, [{ origin: 'a.eth' }], 'chrome');
    expect(core.calls.map(({ method, params, context }) => [method, params, context.caller])).toEqual([
      ['accounts.list', {}, 'chrome'],
      ['accounts.list', {}, 'shell'],
      ['accounts.meta', {}, 'chrome'],
      ['accounts.active', {}, 'shell'],
      ['accounts.add_mnemonic', { name: 'Spare' }, 'chrome'],
      ['accounts.add_mnemonic', {}, 'shell'],
      ['accounts.add_ledger', { name: '', address: '0xA', path: "44'/60'/0'/0/0" }, 'shell'],
      ['accounts.add_remote', { address: '0xB' }, 'shell'],
      ['accounts.record_address_check', { type: 'remote', index: 1000000, matched: false }, 'shell'],
      [
        'accounts.add_safe',
        { name: 'S', address: '0xC', owners: [0, 1], threshold: 1, salt_nonce: '5' },
        'shell',
      ],
      ['accounts.mark_safe_deployed', { index: 1000001, chain_id: 100 }, 'shell'],
      ['accounts.set_active', { index: 2 }, 'chrome'],
      ['accounts.rename', { index: 2, name: 'Two' }, 'chrome'],
      ['accounts.remove', { index: 2, swarm_references: [{ origin: 'a.eth' }] }, 'chrome'],
    ]);
    for (const { options } of core.calls) {
      expect(options.watchdogMs).toBe(45_000);
      expect(options.requires({ store_moved: ['vault_meta'] })).toBe(true);
      expect(options.requires({ store_moved: ['payments'] })).toBe(false);
    }
  });

  test("accounts.*: a refusal's data.code becomes its code; the Swarm refusal gets main's references back", async () => {
    const references = [{ origin: 'myapp.eth', identityId: 'ethereum-wallet:2', active: true }];
    const core = new FakeCore((method) => {
      const refusal = (message, data) =>
        Object.assign(new Error(message), { code: 'invalid_argument', data });
      if (method === 'accounts.add_safe') {
        throw refusal('"L" can\'t own a Safe until …', { code: 'LEDGER_ACCOUNT_UNCHECKED' });
      }
      if (method === 'accounts.remove') {
        throw refusal('Cannot delete wallet with index 2; …', {
          code: 'SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE',
        });
      }
      if (method === 'accounts.rename') throw refusal('Wallet with index 9 does not exist');
      throw coreError('requirement_unmet', "The core can't take this request");
    });
    const { vaultBackend } = load(core);
    await expect(
      vaultBackend.accounts.addSafe({ address: '0xC', owners: [0, 1], threshold: 1, saltNonce: '1' })
    ).rejects.toMatchObject({ code: 'LEDGER_ACCOUNT_UNCHECKED', message: '"L" can\'t own a Safe until …' });
    const swarm = await vaultBackend.accounts.remove(2, references).catch((e) => e);
    expect(swarm).toMatchObject({ code: 'SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE', references });
    await expect(vaultBackend.accounts.rename(9, 'x')).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Wallet with index 9 does not exist',
    });
    await expect(vaultBackend.accounts.list()).rejects.toMatchObject({ code: 'requirement_unmet' });
  });

  // safe-pending.json's methods (design 0013, PRF-6(d)): main's own, each
  // with `requires: requiresStore('safe_pending')`; the core's errors as
  // they come.
  test('safePending.*: wire shapes, shell and requires', async () => {
    const entry = { safeTxHash: '0x05', signatures: [] };
    const core = new FakeCore((method, params) => {
      switch (method) {
        case 'safe_pending.get':
          return { entry: params.index === 5 ? entry : null };
        case 'safe_pending.list':
          return { indices: [5] };
        case 'safe_pending.set':
          return { durable: false };
        case 'safe_pending.clear':
          if (params.index === 6) {
            throw Object.assign(new Error('The pending Safe transactions could not be written'), {
              code: 'storage',
              data: { store: 'safe_pending' },
            });
          }
          return { cleared: true, durable: true };
        default:
          throw coreError('unknown_method', 'Unknown method');
      }
    });
    const { vaultBackend } = load(core);
    const { safePending } = vaultBackend;
    await expect(safePending.get(5)).resolves.toEqual(entry);
    await expect(safePending.get(6)).resolves.toBeNull();
    await expect(safePending.list()).resolves.toEqual([5]);
    await expect(safePending.set(5, entry)).resolves.toEqual({ durable: false });
    await expect(safePending.clear(5)).resolves.toEqual({ cleared: true, durable: true });
    await expect(safePending.clear(6)).rejects.toMatchObject({
      code: 'storage',
      message: 'The pending Safe transactions could not be written',
      data: { store: 'safe_pending' },
    });
    expect(core.calls.map(({ method, params, context }) => [method, params, context.caller])).toEqual([
      ['safe_pending.get', { index: 5 }, 'shell'],
      ['safe_pending.get', { index: 6 }, 'shell'],
      ['safe_pending.list', {}, 'shell'],
      ['safe_pending.set', { index: 5, entry }, 'shell'],
      ['safe_pending.clear', { index: 5 }, 'shell'],
      ['safe_pending.clear', { index: 6 }, 'shell'],
    ]);
    for (const { options } of core.calls) {
      expect(options.watchdogMs).toBe(15_000);
      expect(options.requires({ store_moved: ['safe_pending'] })).toBe(true);
      expect(options.requires({ store_moved: ['vault_meta'] })).toBe(false);
    }
  });

  test('no core: a typed unavailable error', async () => {
    const { vaultBackend } = load(null);
    await expect(vaultBackend.status()).rejects.toMatchObject({ code: 'core_unavailable' });
  });

  test('strengths follow @scure/bip39', () => {
    const { _internal } = load(new FakeCore(() => ({})));
    expect(_internal.wordsFor()).toBe(24);
    expect(_internal.wordsFor(128)).toBe(12);
    expect(() => _internal.wordsFor('256')).toThrow('expected number, got string');
    expect(() => _internal.wordsFor(null)).toThrow('expected number, got object');
    expect(() => _internal.wordsFor(-32)).toThrow('expected integer >= 0, got -32');
    expect(() => _internal.wordsFor(100)).toThrow('Invalid entropy');
    expect(() => _internal.wordsFor(512)).toThrow('Invalid entropy');
    expect(() => _internal.wordsFor(64)).toThrow('invalid entropy length');
  });

  test('ill-formed mnemonics are rejected locally', async () => {
    const core = new FakeCore(() => ({ valid: true }));
    const { vaultBackend } = load(core);
    const lone = 'abandon ' + String.fromCharCode(0xd800);
    await expect(vaultBackend.validateMnemonic(lone)).resolves.toBe(false);
    await expect(vaultBackend.importVault('password1', lone)).rejects.toMatchObject({
      message: 'Invalid mnemonic',
    });
    expect(core.calls).toHaveLength(0);
  });

  test('a lost create reply is reconciled and installs', async () => {
    let created = false;
    const core = new FakeCore((method, params) => {
      if (method === 'vault.status') return { exists: created, fingerprint: created ? FP : null };
      if (method === 'vault.create') {
        created = true;
        throw coreError('core_unavailable', 'The core exited');
      }
      if (method === 'vault.reconcile') {
        expect(params).toMatchObject({ op: 'create', fingerprint_before: null, install: true });
        return { status: 'committed', mnemonic_b64: b64('m'), addresses: { user_wallet: '0x2' } };
      }
      return {};
    });
    const { vaultBackend } = load(core);
    await expect(vaultBackend.createVault('password1')).resolves.toEqual({
      mnemonic: 'm',
      addresses: { user_wallet: '0x2' },
    });
  });

  test('a lock during the lost mutation means no install', async () => {
    const core = new FakeCore((method, params, self) => {
      if (method === 'vault.status') return { exists: true, fingerprint: FP };
      if (method === 'vault.import') {
        self.emit('event', 'vault.locked', { reason: 'manual' });
        throw coreError('core_unavailable', 'The core exited');
      }
      if (method === 'vault.reconcile') {
        expect(params.install).toBe(false);
        expect(params.mnemonic_b64).toBe(b64('abandon about'));
        return { status: 'committed', addresses: { user_wallet: '0x3' } };
      }
      return {};
    });
    const { vaultBackend } = load(core);
    await expect(
      vaultBackend.importVault('password1', 'abandon about', { overwrite: true })
    ).resolves.toEqual({ addresses: { user_wallet: '0x3' } });
  });

  // freedom-core design 0013, PRF-6(a): the core writes vault-meta.json with
  // the vault, so a create, an import and their reconcile go only to a core
  // that took `vault_meta`, and both send `user_knows_password`.
  test('create and import send user_knows_password and require vault_meta; other mutations require nothing', async () => {
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: false, fingerprint: null };
      if (method === 'vault.create') return { mnemonic_b64: b64('m'), addresses: {} };
      return { addresses: {} };
    });
    const { vaultBackend } = load(core);
    const { requiresStore } = require('./core-client');
    await vaultBackend.createVault('pw1', 256, { userKnowsPassword: false });
    await vaultBackend.importVault('pw2', 'abandon about', { userKnowsPassword: false });
    await vaultBackend.importVault('pw3', 'abandon about');
    await vaultBackend.changePassword('pw3', 'pw4');
    const sent = core.calls.filter((c) => c.method !== 'vault.status');
    expect(sent.map((c) => [c.method, c.params.user_knows_password])).toEqual([
      ['vault.create', false],
      ['vault.import', false],
      ['vault.import', true],
      ['vault.change_password', undefined],
    ]);
    const [create, imported, , change] = sent.map((c) => c.options.requires);
    for (const requires of [create, imported]) {
      expect(requires({ store_moved: ['vault_meta'] })).toBe(true);
      expect(requires({ store_moved: [] })).toBe(false);
    }
    expect(create.toString()).toBe(requiresStore('vault_meta').toString());
    expect(change).toBeNull();
    for (const c of core.calls.filter((call) => call.method === 'vault.status')) {
      expect(c.options.requires).toBeNull();
    }
  });

  test('a core that did not take vault_meta: create fails requirement_unmet, nothing pending', async () => {
    const core = new FakeCore((method, params, self) => {
      if (method === 'vault.status') return { exists: false, fingerprint: null };
      const requires = self.calls.at(-1).options.requires;
      if (requires && !requires({ store_moved: [] })) {
        throw coreError('requirement_unmet', "The core can't take this request");
      }
      return {};
    });
    const { vaultBackend, _internal } = load(core);
    await expect(vaultBackend.createVault('pw1')).rejects.toMatchObject({ code: 'requirement_unmet' });
    await expect(vaultBackend.importVault('pw1', 'abandon about')).rejects.toMatchObject({
      code: 'requirement_unmet',
    });
    expect(_internal.hasPending()).toBe(false);
  });

  test.each(['written', 'pending'])(
    "a lost create whose reconcile answers meta: '%s' resolves with its result; main writes nothing",
    async (meta) => {
      let created = false;
      const core = new FakeCore((method, params, self) => {
        if (method === 'vault.status') return { exists: created, fingerprint: created ? FP : null };
        if (method === 'vault.create') {
          created = true;
          throw coreError('core_unavailable', 'The core exited');
        }
        if (method === 'vault.reconcile') {
          expect(self.calls.at(-1).options.requires({ store_moved: ['vault_meta'] })).toBe(true);
          expect(self.calls.at(-1).options.requires({ store_moved: [] })).toBe(false);
          return { status: 'committed', meta, mnemonic_b64: b64('m'), addresses: { user_wallet: '0x2' } };
        }
        return {};
      });
      const { vaultBackend } = load(core);
      const writes = ['writeFileSync', 'renameSync', 'openSync', 'mkdirSync'].map((name) =>
        jest.spyOn(fs, name)
      );
      try {
        await expect(vaultBackend.createVault('password1', 256, { userKnowsPassword: false })).resolves.toEqual({
          mnemonic: 'm',
          addresses: { user_wallet: '0x2' },
        });
        for (const spy of writes) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of writes) spy.mockRestore();
      }
    }
  );

  test('a lost import reconciles under vault_meta; a lost password change requires nothing', async () => {
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: true, fingerprint: FP };
      if (method === 'vault.import' || method === 'vault.change_password') {
        throw coreError('core_unavailable', 'The core exited');
      }
      if (method === 'vault.reconcile') return { status: 'committed', meta: 'written', addresses: {} };
      return {};
    });
    const { vaultBackend } = load(core);
    await vaultBackend.importVault('pw1', 'abandon about', { overwrite: true });
    await vaultBackend.changePassword('pw1', 'pw2');
    const reconciles = core.calls.filter((c) => c.method === 'vault.reconcile');
    expect(reconciles.map((c) => c.params.op)).toEqual(['import', 'change_password']);
    expect(reconciles[0].options.requires({ store_moved: ['vault_meta'] })).toBe(true);
    expect(reconciles[1].options.requires).toBeNull();
  });

  test('not committed: the original error', async () => {
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: true, fingerprint: FP };
      if (method === 'vault.delete') throw coreError('core_unavailable', 'The core exited');
      if (method === 'vault.reconcile') return { status: 'not_committed' };
      return {};
    });
    const { vaultBackend } = load(core);
    await expect(vaultBackend.deleteVault('password1')).rejects.toMatchObject({
      code: 'core_unavailable',
    });
  });

  test('an unreconcilable mutation stays pending and gates the next one', async () => {
    let up = false;
    const onCommitted = jest.fn();
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: false, fingerprint: null };
      if (method === 'vault.create') throw coreError('core_unavailable', 'The core exited');
      if (method === 'vault.reconcile') {
        if (!up) throw coreError('core_unavailable', 'The core is not running');
        return { status: 'committed', mnemonic_b64: b64('m'), addresses: {} };
      }
      return {};
    });
    const { vaultBackend, _internal } = load(core);
    await expect(vaultBackend.createVault('password1', 256, { onCommitted })).rejects.toMatchObject(
      {
        code: 'core_unavailable',
      }
    );
    expect(_internal.hasPending()).toBe(true);
    // Still down: the next mutation refuses.
    await expect(vaultBackend.changePassword('password1', 'password2')).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    expect(core.calls.some((c) => c.method === 'vault.change_password')).toBe(false);
    // Back: the pending create is settled (continuation runs), then the new one.
    up = true;
    await vaultBackend.deleteVault('password1');
    expect(onCommitted).toHaveBeenCalledWith(expect.objectContaining({ status: 'committed' }));
    expect(_internal.hasPending()).toBe(false);
  });

  test('create checks an existing vault before the strength', async () => {
    const core = new FakeCore((method) =>
      method === 'vault.status' ? { exists: true, fingerprint: FP } : {}
    );
    const { vaultBackend } = load(core);
    await expect(vaultBackend.createVault('password1', 100)).rejects.toMatchObject({
      code: 'vault_exists',
      message: 'Vault already exists. Use importVault to replace.',
    });
  });

  test('node writes reconcile through op_status', async () => {
    const core = new FakeCore((method, params) => {
      if (method === 'nodes.write_identity') throw coreError('core_unavailable', 'The core exited');
      if (method === 'nodes.op_status') {
        expect(params).toEqual({ op_id: 'op-1' });
        return { status: 'installed' };
      }
      return {};
    });
    const { vaultBackend } = load(core);
    await expect(
      vaultBackend.writeNodeIdentity(
        { node: 'bee', data_dir: '/d', api_port: 1, p2p_port: 2 },
        'op-1'
      )
    ).resolves.toEqual({ status: 'installed', reconciled: true });
  });

  test('mutations run one at a time, through reconciliation (M1)', async () => {
    let releaseImport;
    const order = [];
    const core = new FakeCore(async (method) => {
      order.push(method);
      if (method === 'vault.status') return { exists: true, fingerprint: FP };
      if (method === 'vault.import') {
        await new Promise((resolve) => (releaseImport = resolve));
        throw coreError('core_unavailable', 'The core exited');
      }
      if (method === 'vault.reconcile') return { status: 'committed', addresses: {} };
      return {};
    });
    const { vaultBackend } = load(core);
    const importing = vaultBackend.importVault('password1', 'abandon about', { overwrite: true });
    const changing = vaultBackend.changePassword('password1', 'password2');
    await new Promise((resolve) => setImmediate(resolve));
    // The change waits for the import, including its reconciliation.
    expect(order).not.toContain('vault.change_password');
    releaseImport();
    await expect(importing).resolves.toMatchObject({ addresses: {} });
    await changing;
    expect(order.indexOf('vault.reconcile')).toBeLessThan(order.indexOf('vault.change_password'));
  });

  test('whileVaultHeld runs between mutations: after one queued, before one queued later (0013 PRF-2b)', async () => {
    let releaseChange;
    const order = [];
    const core = new FakeCore(async (method) => {
      order.push(method);
      if (method === 'vault.status') return { exists: true, fingerprint: FP };
      if (method === 'vault.change_password') await new Promise((resolve) => (releaseChange = resolve));
      return {};
    });
    const { vaultBackend } = load(core);
    const changing = vaultBackend.changePassword('password1', 'password2');
    let releaseHeld;
    const held = vaultBackend.whileVaultHeld(async () => {
      order.push('held');
      await new Promise((resolve) => (releaseHeld = resolve));
      // Unlocks stay outside the queue: no deadlock inside the hold.
      await vaultBackend.unlock('password2');
      return 'done';
    });
    const deleting = vaultBackend.deleteVault('password2');
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).not.toContain('held');
    releaseChange();
    await changing;
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toContain('held');
    expect(order).not.toContain('vault.delete');
    releaseHeld();
    await expect(held).resolves.toBe('done');
    await deleting;
    expect(order.indexOf('vault.unlock')).toBeLessThan(order.indexOf('vault.delete'));
  });

  test('a pending mutation is settled as soon as the core is ready (M2)', async () => {
    let up = false;
    const onCommitted = jest.fn();
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: false, fingerprint: null };
      if (method === 'vault.import') throw coreError('core_unavailable', 'The core exited');
      if (method === 'vault.reconcile') {
        if (!up) throw coreError('core_unavailable', 'The core is not running');
        return { status: 'committed', addresses: { user_wallet: '0x1' } };
      }
      return {};
    });
    const { vaultBackend, _internal } = load(core);
    await expect(
      vaultBackend.importVault('password1', 'abandon about', { onCommitted })
    ).rejects.toMatchObject({ code: 'core_unavailable' });
    expect(_internal.hasPending()).toBe(true);
    up = true;
    core.emit('ready', {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(onCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ addresses: { user_wallet: '0x1' } })
    );
    expect(_internal.hasPending()).toBe(false);
  });

  test('a failed continuation stays pending and is retried (N1)', async () => {
    const onCommitted = jest
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    let reconciles = 0;
    let up = false;
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: false, fingerprint: null };
      if (method === 'vault.create') throw coreError('core_unavailable', 'The core exited');
      if (method === 'vault.reconcile') {
        if (!up) throw coreError('core_unavailable', 'The core is not running');
        reconciles += 1;
        return { status: 'committed', mnemonic_b64: b64('m'), addresses: {} };
      }
      return {};
    });
    const { vaultBackend, _internal } = load(core);
    await expect(vaultBackend.createVault('password1', 256, { onCommitted })).rejects.toThrow();
    up = true;
    // The continuation fails: still pending, and the delete isn't sent.
    await expect(vaultBackend.deleteVault('password1')).rejects.toThrow('disk full');
    expect(_internal.hasPending()).toBe(true);
    expect(core.calls.some((c) => c.method === 'vault.delete')).toBe(false);
    // Retried without reconciling again; then the delete runs.
    await vaultBackend.deleteVault('password1');
    expect(onCommitted).toHaveBeenCalledTimes(2);
    expect(reconciles).toBe(1);
    expect(core.calls.some((c) => c.method === 'vault.delete')).toBe(true);
  });

  test('retrying the same lost request returns what it committed', async () => {
    let up = false;
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: !!up, fingerprint: up ? FP : null };
      if (method === 'vault.create') throw coreError('core_unavailable', 'The core exited');
      if (method === 'vault.reconcile') {
        if (!up) throw coreError('core_unavailable', 'The core is not running');
        return { status: 'committed', mnemonic_b64: b64('abandon about'), addresses: {} };
      }
      return {};
    });
    const { vaultBackend } = load(core);
    await expect(vaultBackend.createVault('password1', 128)).rejects.toThrow();
    up = true;
    // Not "vault exists": the same create, committed by the first attempt.
    await expect(vaultBackend.createVault('password1', 128)).resolves.toMatchObject({
      mnemonic: 'abandon about',
    });
    expect(core.calls.filter((c) => c.method === 'vault.create')).toHaveLength(1);
    // A different create still finds the vault.
    await expect(vaultBackend.createVault('other-pass1', 128)).rejects.toMatchObject({
      code: 'vault_exists',
    });
  });

  test('a same-request retry after the automatic settlement still gets its result', async () => {
    let up = false;
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: !!up, fingerprint: up ? FP : null };
      if (method === 'vault.create') throw coreError('core_unavailable', 'The core exited');
      if (method === 'vault.reconcile') {
        if (!up) throw coreError('core_unavailable', 'The core is not running');
        return { status: 'committed', mnemonic_b64: b64('abandon about'), addresses: {} };
      }
      return {};
    });
    const { vaultBackend, _internal } = load(core);
    await expect(vaultBackend.createVault('password1', 128)).rejects.toThrow();
    up = true;
    core.emit('ready', {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(_internal.hasPending()).toBe(false);
    await expect(vaultBackend.createVault('password1', 128)).resolves.toMatchObject({
      mnemonic: 'abandon about',
    });
    // Consumed: the next one sees the vault.
    await expect(vaultBackend.createVault('password1', 128)).rejects.toMatchObject({
      code: 'vault_exists',
    });
  });

  test('node writes: an unknown or uncommitted outcome throws; others report status', async () => {
    let status = 'pending_recovery';
    let ready = true;
    const core = new FakeCore((method) => {
      if (method === 'nodes.write_identity') throw coreError('core_unavailable', 'The core exited');
      if (method === 'nodes.op_status') {
        if (!ready) throw coreError('core_unavailable', 'The core is not running');
        return { status };
      }
      return {};
    });
    const { vaultBackend } = load(core);
    const write = () => vaultBackend.writeNodeIdentity({ node: 'radicle', home: '/h' }, 'op-2');
    await expect(write()).resolves.toEqual({ status: 'pending_recovery', reconciled: true });
    status = 'corrupt';
    await expect(write()).resolves.toEqual({ status: 'corrupt', reconciled: true });
    status = 'not_committed';
    await expect(write()).rejects.toMatchObject({ code: 'core_unavailable' });
    ready = false;
    await expect(write()).rejects.toMatchObject({ code: 'core_unavailable' });
  });

  test("the Radicle node key, sealed to the service's recipient: only enc and the ciphertext come back", async () => {
    const recipient = Buffer.alloc(32, 7).toString('base64');
    const sealed = {
      enc: Buffer.alloc(32, 1).toString('base64'),
      ciphertext: Buffer.alloc(48, 2).toString('base64'),
    };
    const core = new FakeCore((method, params) => {
      if (method !== 'nodes.seal_radicle_key') return {};
      if (params.recipient !== recipient) throw coreError('invalid_argument', 'Invalid recipient');
      return { ...sealed, extra: 'ignored' };
    });
    const { vaultBackend } = load(core);
    await expect(vaultBackend.sealRadicleKey(recipient)).resolves.toEqual(sealed);
    expect(core.calls.at(-1)).toMatchObject({
      method: 'nodes.seal_radicle_key',
      params: { recipient },
      context: { caller: 'shell' },
    });
  });

  // Design 0012, API: `approval.revoke` is open to a page (its own key), to
  // the chrome (its settings' narrowing) and to main itself.
  test("a revoke's caller: a page under its PageContext, the chrome's as chrome, main's own as shell", async () => {
    const core = new FakeCore(() => ({ revoked: true }));
    const { vaultBackend } = load(core);
    const page = { origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 1, agent: false };
    const params = { store: 'dapp', key: 'https://app.example', what: 'grant' };
    await vaultBackend.approval.revoke(params, page);
    await vaultBackend.approval.revoke(params, 'chrome');
    await vaultBackend.approval.revoke(params);
    expect(core.calls.map(({ method, context }) => [method, context])).toEqual([
      ['approval.revoke', { caller: 'page', page }],
      ['approval.revoke', { caller: 'chrome' }],
      ['approval.revoke', { caller: 'shell' }],
    ]);
  });

  test.each([
    ['no_vault', 'No vault exists'],
    ['vault_locked', 'Vault is locked'],
  ])("the seal's %s keeps its code: the node decides what it means", async (code, message) => {
    const core = new FakeCore(() => {
      throw coreError(code, message);
    });
    const { vaultBackend } = load(core);
    await expect(vaultBackend.sealRadicleKey('x')).rejects.toMatchObject({ code, message });
  });

  // Design 0013, "The re-wrap"; cored 0.17.0's callers: enroll is main's
  // own (`shell`), the other five the chrome's, after main's Touch ID.
  test("quick unlock: enroll as shell, the rest as chrome; secrets as base64", async () => {
    const core = new FakeCore((method) => {
      if (method === 'quick_unlock.status') return { enabled: true, policy: 'unattended', available: true };
      if (method === 'quick_unlock.unlock') return { addresses: { user_wallet: '0x1' } };
      if (method === 'quick_unlock.export_mnemonic') return { mnemonic_b64: b64('abandon about') };
      if (method === 'quick_unlock.export_private_key') return { private_key_hex: '0xabc' };
      return {};
    });
    const { vaultBackend } = load(core);
    await expect(vaultBackend.quickUnlockStatus()).resolves.toEqual({
      enabled: true,
      policy: 'unattended',
      available: true,
    });
    await expect(vaultBackend.quickUnlockEnroll('pässwörd1')).resolves.toBeUndefined();
    await expect(vaultBackend.quickUnlock()).resolves.toEqual({ addresses: { user_wallet: '0x1' } });
    await expect(vaultBackend.quickExportMnemonic()).resolves.toBe('abandon about');
    await expect(vaultBackend.quickExportPrivateKey(3)).resolves.toBe('0xabc');
    await expect(vaultBackend.quickUnlockDisable()).resolves.toBeUndefined();
    expect(core.calls.map(({ method, params, context }) => [method, params, context])).toEqual([
      ['quick_unlock.status', {}, { caller: 'chrome' }],
      ['quick_unlock.enroll', { password_b64: b64('pässwörd1') }, { caller: 'shell' }],
      ['quick_unlock.unlock', {}, { caller: 'chrome' }],
      ['quick_unlock.export_mnemonic', {}, { caller: 'chrome' }],
      ['quick_unlock.export_private_key', { account: 3 }, { caller: 'chrome' }],
      ['quick_unlock.disable', {}, { caller: 'chrome' }],
    ]);
  });

  test('import with quick unlock sends quick_unlock: true; without, no member at all', async () => {
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: false, fingerprint: null };
      return { addresses: { user_wallet: '0x1' } };
    });
    const { vaultBackend } = load(core);
    await vaultBackend.importVault('pw', 'abandon about', { quickUnlock: true });
    await vaultBackend.importVault('pw2', 'abandon about');
    const imports = core.calls.filter((c) => c.method === 'vault.import');
    expect(imports[0].params).toEqual({
      password_b64: b64('pw'),
      mnemonic_b64: b64('abandon about'),
      overwrite: false,
      user_knows_password: true,
      quick_unlock: true,
    });
    expect(imports[1].params).not.toHaveProperty('quick_unlock');
  });

  // The core's bare "Storage error" / "The key store is unavailable" /
  // "Cancelled" become main's wording; code and data stay.
  test.each([
    ['storage', { kind: 'malformed', file: 'secrets' }, /secrets\.json.*damaged/],
    ['key_store_unavailable', { reason: 'timeout' }, /didn't answer in time/],
    ['key_store_cancelled', undefined, /cancelled/],
  ])('a %s refusal gets a cause and a way forward, its code and data kept', async (code, data, message) => {
    const core = new FakeCore(() => {
      throw Object.assign(coreError(code, 'Storage error'), { data });
    });
    const { vaultBackend } = load(core);
    const refused = await vaultBackend.changePassword('a', 'b').catch((err) => err);
    expect(refused).toMatchObject({ code, data });
    expect(refused.message).toMatch(message);
  });

  test("other storage errors keep the core's message", async () => {
    const core = new FakeCore(() => {
      throw Object.assign(coreError('storage', 'Storage error'), { data: { kind: 'permission' } });
    });
    const { vaultBackend } = load(core);
    await expect(vaultBackend.verifyPassword('a')).rejects.toMatchObject({
      code: 'storage',
      message: 'Storage error',
    });
  });

  test("onVaultEvent: the core's vault events, until unsubscribed", async () => {
    const core = new FakeCore(() => ({}));
    const { vaultBackend } = load(core);
    const seen = [];
    const unsubscribe = vaultBackend.onVaultEvent((name, data) => seen.push([name, data]));
    core.emit('event', 'vault.unlocked', { epoch: 3 });
    core.emit('event', 'naming.changed', {});
    core.emit('event', 'vault.locked', { reason: 'auto', epoch: 3 });
    unsubscribe();
    core.emit('event', 'vault.unlocked', { epoch: 4 });
    expect(seen).toEqual([
      ['vault.unlocked', { epoch: 3 }],
      ['vault.locked', { reason: 'auto', epoch: 3 }],
    ]);
    expect(core.listenerCount('event')).toBe(0);
    // No core: nothing to subscribe to.
    expect(typeof load(null).vaultBackend.onVaultEvent(() => {})).toBe('function');
  });

  test('radicle DID from raw public key bytes', async () => {
    const core = new FakeCore((method, params) => ({ did: `did:key:${params.public_key}` }));
    const { vaultBackend } = load(core);
    await expect(vaultBackend.radicleDid(Uint8Array.from([1, 255]))).resolves.toBe('did:key:01ff');
  });

  test("every request carries its method's hang watchdog (design 0001)", async () => {
    // 45 s on the vault queue (its 30 s deadline + 15 s), 135 s for a
    // session (120 s + 15 s: `phone.result`, which may read the network for
    // a payment's transaction), 15 s otherwise.
    const SESSION = new Set(['phone.result']);
    const VAULT_QUEUE = new Set([
      'vault.unlock',
      'vault.verify_password',
      'vault.change_password',
      'vault.delete',
      'vault.export_mnemonic',
      'vault.export_private_key',
      'vault.create',
      'vault.import',
      'vault.reconcile',
      'nodes.write_identity',
      'nodes.op_status',
      'quick_unlock.enroll',
      'quick_unlock.unlock',
      'quick_unlock.export_mnemonic',
      'quick_unlock.export_private_key',
      'quick_unlock.disable',
      'accounts.list',
      'accounts.meta',
      'accounts.active',
      'accounts.add_mnemonic',
      'accounts.add_ledger',
      'accounts.add_remote',
      'accounts.record_address_check',
      'accounts.add_safe',
      'accounts.mark_safe_deployed',
      'accounts.set_active',
      'accounts.rename',
      'accounts.remove',
    ]);
    let lose = true;
    const core = new FakeCore((method) => {
      if (method === 'vault.status') return { exists: false, fingerprint: null };
      // One lost reply each, so reconciliation's requests go too.
      if ((method === 'vault.import' || method === 'nodes.write_identity') && lose) {
        throw coreError('core_unavailable', 'The core exited');
      }
      if (method === 'vault.reconcile') return { status: 'committed', addresses: {} };
      if (method === 'nodes.op_status') return { status: 'installed' };
      return {
        mnemonic_b64: b64('abandon about'),
        addresses: {},
        valid: true,
        did: 'did:key:z',
        signature: '0x',
        hash: '0x',
        private_key_hex: '0x',
      };
    });
    const { vaultBackend } = load(core);
    const key = { kind: 'account', index: 0 };
    const page = { origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 1 };
    await vaultBackend.status();
    await vaultBackend.generateMnemonic(128);
    await vaultBackend.validateMnemonic('abandon about');
    await vaultBackend.createVault('password1', 128);
    await vaultBackend.importVault('password1', 'abandon about');
    await vaultBackend.writeNodeIdentity({ node: 'radicle', home: '/h' }, 'op-1');
    lose = false;
    await vaultBackend.unlock('password1');
    await vaultBackend.lock();
    vaultBackend.touch();
    await vaultBackend.verifyPassword('password1');
    await vaultBackend.changePassword('password1', 'password2');
    await vaultBackend.exportMnemonic('password2');
    await vaultBackend.exportPrivateKey('password2', 0);
    await vaultBackend.addresses({ accounts: [0] });
    await vaultBackend.radicleDid(Uint8Array.from([1]));
    await vaultBackend.sealRadicleKey(Buffer.alloc(32, 9).toString('base64'));
    await vaultBackend.sign.transaction(key, {});
    await vaultBackend.sign.message(key, Uint8Array.from([1]));
    await vaultBackend.sign.typedData(key, {});
    await vaultBackend.sign.soc(key, { identifier: Buffer.alloc(32), payload: Buffer.alloc(1) });
    await vaultBackend.approval.issue({ kind: 'wallet-send', account: 0, payload: { tx: {} } });
    await vaultBackend.approval.spend({ token: 't', kind: 'intent-close', payload: {} });
    await vaultBackend.approval.remember({ receipt: 'r' }, { ...page, agent: false });
    await vaultBackend.approval.discard('t');
    await vaultBackend.approval.end('s');
    await vaultBackend.approval.check({ request: {} }, { ...page, agent: false });
    await vaultBackend.approval.grant({ store: 'dapp', change: {} }, { ...page, agent: false });
    await vaultBackend.approval.grant({ store: 'swarm', change: { op: 'connect' } }, page);
    await vaultBackend.approval.revoke({ store: 'dapp', key: 'https://app.example', what: 'grant' });
    await vaultBackend.approval.revoke({ store: 'swarm', key: 'https://app.example', what: 'grant' }, 'chrome');
    await vaultBackend.approval.touch({ store: 'dapp' }, { ...page, agent: false });
    await vaultBackend.approval.touch({ store: 'radicle' }, page);
    await vaultBackend.approval.radicleWrite({ key: 'https://app.example' }, { ...page, agent: false });
    await vaultBackend.approval.forgetAccount(0);
    await vaultBackend.approval.grants({ store: 'dapp' });
    await vaultBackend.approval.grants({ store: 'radicle' });
    await vaultBackend.typedDataHash({});
    await vaultBackend.phone.job({ account: 0, method: 'message', payload: {}, target: 7 }, { ...page, agent: false });
    await vaultBackend.phone.sent({ job: 'j', sender: 7 });
    await vaultBackend.phone.result({ job: 'j', sender: 7, result: null });
    await vaultBackend.quickUnlockStatus();
    await vaultBackend.quickUnlockEnroll('password2');
    await vaultBackend.quickUnlock();
    await vaultBackend.quickExportMnemonic();
    await vaultBackend.quickExportPrivateKey(0);
    await vaultBackend.quickUnlockDisable();
    await vaultBackend.deleteVault('password2');
    const { accounts } = vaultBackend;
    await accounts.list();
    await accounts.meta();
    await accounts.active();
    await accounts.addMnemonic('n');
    await accounts.addLedger({ address: '0xA', path: 'p' });
    await accounts.addRemote({ address: '0xB' });
    await accounts.recordAddressCheck('ledger', 1, true);
    await accounts.addSafe({ address: '0xC', owners: [0, 1], threshold: 1, saltNonce: '1' });
    await accounts.markSafeDeployed(1, 100);
    await accounts.setActive(0);
    await accounts.rename(0, 'm');
    await accounts.remove(1, []);
    const { safePending } = vaultBackend;
    await safePending.get(1);
    await safePending.list();
    await safePending.set(1, {});
    await safePending.clear(1);

    const sent = new Set(core.calls.map((c) => c.method));
    // Every method vault-backend.js sends was sent above.
    const source = fs.readFileSync(path.join(__dirname, 'vault-backend.js'), 'utf8');
    const named = new Set(
      [...source.matchAll(/(?:call|mutate|accountsCall)\(\s*'([a-z_.]+)'/g)].map((m) => m[1])
    );
    expect([...named].sort()).toEqual([...sent].sort());
    // vault-meta.json's requests, and the create and import that write it
    // with the vault, require `vault_meta` (design 0013, PRF-6(a)).
    const metaWrites = (method, params) =>
      method.startsWith('accounts.') ||
      method === 'vault.create' ||
      method === 'vault.import' ||
      (method === 'vault.reconcile' && ['create', 'import'].includes(params.op));
    for (const { method, params, options } of core.calls) {
      const { requires, ...rest } = options;
      expect([method, rest]).toEqual([
        method,
        { watchdogMs: VAULT_QUEUE.has(method) ? 45_000 : SESSION.has(method) ? 135_000 : 15_000 },
      ]);
      if (metaWrites(method, params)) {
        expect([method, requires({ store_moved: ['vault_meta'] })]).toEqual([method, true]);
        expect([method, requires({ store_moved: [] })]).toEqual([method, false]);
      } else if (method.startsWith('safe_pending.')) {
        // safe-pending.json's (PRF-6(d)) require `safe_pending`.
        expect([method, requires({ store_moved: ['safe_pending'] })]).toEqual([method, true]);
        expect([method, requires({ store_moved: ['vault_meta'] })]).toEqual([method, false]);
      } else {
        expect([method, requires]).toEqual([method, null]);
      }
    }
  });

  // Design 0012, APB-3: the moved files' write methods name their caller (a
  // page's own under `page`, the chrome's narrowing, main's own as `shell`),
  // and a page's SOC goes under `page` with its authorization.
  test('grant writes and SOCs go as the page, the chrome or main itself', async () => {
    const core = new FakeCore(() => ({}));
    const { vaultBackend } = load(core);
    const page = { origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false };
    const chunk = { identifier: Buffer.alloc(32), payload: Buffer.alloc(1) };
    const authorization = { swarm: 'user', soc: 'raw' };
    await vaultBackend.approval.grant({ store: 'swarm', change: { op: 'connect' } }, page);
    await vaultBackend.approval.grant({ store: 'swarm', change: { op: 'connect', key: page.origin } });
    await vaultBackend.approval.revoke({ store: 'radicle', key: page.origin, what: 'grant' }, 'chrome');
    await vaultBackend.approval.touch({ store: 'radicle' }, page);
    await vaultBackend.approval.remember({ receipt: 'e'.repeat(32) }, page);
    await vaultBackend.approval.grants({ store: 'swarm' });
    await vaultBackend.approval.radicleWrite({ key: page.origin }, page);
    await vaultBackend.sign.soc({ kind: 'bee_wallet' }, chunk, { page, authorization });
    await vaultBackend.sign.soc({ kind: 'bee_wallet' }, chunk);
    expect(core.calls.map(({ method, context, params }) => [method, context, params.authorization])).toEqual([
      ['approval.grant', { caller: 'page', page }, undefined],
      ['approval.grant', { caller: 'shell' }, undefined],
      ['approval.revoke', { caller: 'chrome' }, undefined],
      ['approval.touch', { caller: 'page', page }, undefined],
      // A device send's receipt (design 0012, "A device send's rule"): under
      // the page it was spent for.
      ['approval.remember', { caller: 'page', page }, undefined],
      ['approval.grants', { caller: 'shell' }, undefined],
      // A page's Radicle write, counted in R-6 (design 0012, "A page's
      // Radicle write"): under its page, for its own key.
      ['approval.radicle_write', { caller: 'page', page }, undefined],
      ['swarm.sign_soc', { caller: 'page', page }, authorization],
      ['swarm.sign_soc', { caller: 'shell' }, undefined],
    ]);
  });

  // Design 0012, PHN-2: a phone job opens under the page it is for (main's
  // own as `shell`); the chrome's "sent" mark and answer go as `chrome`, and
  // main's own end of a job (its timeout) as `shell`.
  test('phone jobs go as the page or main, their marks and answers as the chrome or main', async () => {
    const core = new FakeCore(() => ({}));
    const { vaultBackend } = load(core);
    const page = { origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false };
    const job = { account: 1, address: '0xabc', method: 'message', payload: { message: '0x00' }, target: 7 };
    await vaultBackend.phone.job({ ...job, authorization: { token: 't' } }, page);
    await vaultBackend.phone.job(job);
    await vaultBackend.phone.sent({ job: 'j-1', sender: 7 });
    await vaultBackend.phone.result({ job: 'j-1', sender: 7, result: '0x' });
    await vaultBackend.phone.result({ job: 'j-1', sender: 7, error: { code: 'REMOTE_TIMEOUT' } }, null);
    expect(core.calls.map(({ method, context, params }) => [method, context, params])).toEqual([
      ['phone.job', { caller: 'page', page }, { ...job, authorization: { token: 't' } }],
      ['phone.job', { caller: 'shell' }, job],
      ['phone.sent', { caller: 'chrome' }, { job: 'j-1', sender: 7 }],
      ['phone.result', { caller: 'chrome' }, { job: 'j-1', sender: 7, result: '0x' }],
      ['phone.result', { caller: 'shell' }, { job: 'j-1', sender: 7, error: { code: 'REMOTE_TIMEOUT' } }],
    ]);
  });

  // fc-protocol's PageContext: a null origin (or any field the core can't
  // decode) is a protocol error, and the core exits. Main never sends one.
  test("a PageContext the core can't decode is refused invalid_argument, never sent", async () => {
    const core = new FakeCore(() => ({}));
    const { vaultBackend } = load(core);
    const page = { origin: 'https://app.example', top_origin: 'https://app.example', frame: 1, navigation: 2, agent: false };
    const chunk = { identifier: Buffer.alloc(32), payload: Buffer.alloc(1) };
    const undecodable = [
      { ...page, origin: null },
      { ...page, top_origin: null },
      { ...page, origin: undefined, top_origin: undefined },
      { ...page, origin: 7 },
      { ...page, frame: null },
      { ...page, frame: -1 },
      { ...page, navigation: undefined },
      { ...page, navigation: 1.5 },
      { ...page, agent: 'yes' },
      // cored 0.21.0 exits on a transport key that isn't a string or null.
      { ...page, transport_key: 7 },
      { ...page, transport_key: false },
      { ...page, transport_key: ['ipns://k51'] },
      { ...page, transport_key: { key: 'ipns://k51' } },
      'https://app.example',
    ];
    for (const bad of undecodable) {
      for (const send of [
        () => vaultBackend.approval.touch({ store: 'dapp', chain_id: 1 }, bad),
        () => vaultBackend.approval.radicleWrite({ key: page.origin }, bad),
        () => vaultBackend.sign.soc({ kind: 'bee_wallet' }, chunk, { page: bad, authorization: { swarm: 'user', soc: 'raw' } }),
      ]) {
        await expect(send()).rejects.toMatchObject({ name: 'VaultBackendError', code: 'invalid_argument' });
      }
    }
    expect(core.calls).toEqual([]);
    // An empty origin decodes: the core answers it (from 0.18.0, with its
    // own invalid_argument). No agent field, or a null one, decodes too:
    // the core then lets no standing rule answer.
    // A transport key absent, null or a string decodes (cored 0.21.0).
    const named = { ...page, origin: 'docs.example.org', top_origin: 'docs.example.org', transport_key: 'ipns://k51abc' };
    const goods = [
      { ...page, origin: '', top_origin: '' },
      { ...page, agent: undefined },
      { ...page, agent: null },
      named,
      { ...page, transport_key: null },
      { ...page, transport_key: undefined },
    ];
    for (const good of goods) {
      await vaultBackend.approval.touch({ store: 'dapp', chain_id: 1 }, good);
    }
    expect(core.calls.map(({ context }) => context)).toEqual(goods.map((good) => ({ caller: 'page', page: good })));
  });

  // A Safe approval lives in the memory of the core process that gave it
  // (freedom-core design 0012): main tells that process's end from another
  // failure of `approval.end` (safe-approvals.js).
  test("the core process's mark: ended once it exits, or once main stops its client", () => {
    let current = null;
    jest.resetModules();
    const gen = { exited: false };
    const core = new FakeCore(() => ({}));
    core.current = gen;
    core.serves = (g) => g === gen && !g.exited;
    jest.doMock('./core-process', () => ({ getCoreClient: () => current }));
    const { vaultBackend } = require('./vault-backend');
    expect(vaultBackend.coreProcess()).toBeNull();
    current = core;
    const mark = vaultBackend.coreProcess();
    expect(mark).not.toBeNull();
    expect(vaultBackend.coreProcessEnded(mark)).toBe(false);
    // None answered: ended. Not a mark: not proof of anything.
    expect(vaultBackend.coreProcessEnded(null)).toBe(true);
    expect(vaultBackend.coreProcessEnded(undefined)).toBe(false);
    expect(vaultBackend.coreProcessEnded({})).toBe(false);
    // Exited (a crash, a hang killed, a restart under way).
    gen.exited = true;
    expect(vaultBackend.coreProcessEnded(mark)).toBe(true);
    expect(vaultBackend.coreProcess()).toBeNull();
    // Stopped by main, the process still winding down.
    gen.exited = false;
    expect(vaultBackend.coreProcessEnded(mark)).toBe(false);
    current = null;
    expect(vaultBackend.coreProcessEnded(mark)).toBe(true);
  });
});
