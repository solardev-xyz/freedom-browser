const { EventEmitter } = require('events');

/** A fake CoreClient: `handle(method, params)` returns a result or throws. */
class FakeCore extends EventEmitter {
  constructor(handle) {
    super();
    this.handle = handle;
    this.calls = [];
    this.ready = Promise.resolve();
  }

  async request(method, params, context) {
    this.calls.push({ method, params, context });
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

  test('radicle DID from raw public key bytes', async () => {
    const core = new FakeCore((method, params) => ({ did: `did:key:${params.public_key}` }));
    const { vaultBackend } = load(core);
    await expect(vaultBackend.radicleDid(Uint8Array.from([1, 255]))).resolves.toBe('did:key:01ff');
  });
});
