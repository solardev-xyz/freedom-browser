/**
 * vault-backend against the real freedom-cored binary: the wire contract end
 * to end. Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored npx jest src/main/core
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Wallet, TypedDataEncoder } = require('ethers');
const { CoreClient } = require('./core-client');
const { toCoreTransaction, toCoreTypedData } = require('../wallet/signing-utils');

const binary = process.env.FREEDOM_CORED_PATH;
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ABANDON_WALLET = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ABANDON_KEY = '0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727';

describeIfBinary('vault-backend with the real freedom-cored', () => {
  let root;
  let core;
  let vaultBackend;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-backend-'));
    core = new CoreClient({
      spawn,
      command: binary,
      args: [
        'serve',
        '--data-dir',
        path.join(root, 'identity'),
        '--lock-dir',
        path.join(root, 'locks'),
      ],
      log: quietLog,
      shellVersion: 'jest',
    });
    jest.resetModules();
    jest.doMock('./core-process', () => ({ getCoreClient: () => core }));
    ({ vaultBackend } = require('./vault-backend'));
    await core.start();
  });

  afterEach(async () => {
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('vault lifecycle and keys', async () => {
    expect(await vaultBackend.status()).toMatchObject({ exists: false, unlocked: false });
    const { addresses } = await vaultBackend.importVault('testpass1', ABANDON);
    expect(addresses.user_wallet).toBe(ABANDON_WALLET);
    expect(await vaultBackend.status()).toMatchObject({ exists: true, unlocked: true });

    const derived = await vaultBackend.addresses({ accounts: [0, 1], publishers: [0] });
    expect(derived.user_wallets[0]).toEqual({ account: 0, address: ABANDON_WALLET });
    expect(derived.radicle.did).toMatch(/^did:key:z6Mk/);
    await expect(
      vaultBackend.radicleDid(Buffer.from(derived.radicle.public_key, 'hex'))
    ).resolves.toBe(derived.radicle.did);

    await expect(vaultBackend.compat.privateKey(0)).resolves.toBe(ABANDON_KEY);
    await expect(vaultBackend.exportPrivateKey('testpass1', 0)).resolves.toBe(ABANDON_KEY);
    await expect(vaultBackend.exportMnemonic('testpass1')).resolves.toBe(ABANDON);

    await vaultBackend.lock();
    await expect(vaultBackend.compat.privateKey(0)).rejects.toMatchObject({
      code: 'vault_locked',
      message: 'Vault is locked',
    });
    await expect(vaultBackend.unlock('wrong-password')).rejects.toMatchObject({
      message: 'Incorrect password',
    });
    await expect(vaultBackend.unlock('testpass1')).resolves.toMatchObject({
      addresses: { user_wallet: ABANDON_WALLET },
    });

    await vaultBackend.changePassword('testpass1', 'testpass2');
    await expect(vaultBackend.verifyPassword('testpass1')).rejects.toMatchObject({
      message: 'Incorrect password',
    });
    await vaultBackend.verifyPassword('testpass2');
    await expect(vaultBackend.changePassword('testpass2', 'short')).rejects.toMatchObject({
      message: 'Password must be at least 8 characters',
    });

    await vaultBackend.deleteVault('testpass2');
    expect(await vaultBackend.status()).toMatchObject({ exists: false, unlocked: false });
  }, 60_000);

  test('mnemonics and creation', async () => {
    const phrase = await vaultBackend.generateMnemonic(128);
    expect(phrase.split(' ')).toHaveLength(12);
    await expect(vaultBackend.validateMnemonic(phrase)).resolves.toBe(true);
    await expect(vaultBackend.validateMnemonic('not a phrase')).resolves.toBe(false);
    const created = await vaultBackend.createVault('testpass1', 256);
    expect(created.mnemonic.split(' ')).toHaveLength(24);
    expect(created.addresses.user_wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
    await expect(vaultBackend.createVault('testpass1')).rejects.toMatchObject({
      code: 'vault_exists',
      message: 'Vault already exists. Use importVault to replace.',
    });
  }, 60_000);

  test('signing in the core matches ethers (freedom-core design 0002)', async () => {
    await vaultBackend.importVault('testpass1', ABANDON);
    const wallet = new Wallet(ABANDON_KEY);
    const key = { kind: 'account', index: 0 };
    const to = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
    for (const request of [
      {
        type: 2,
        chainId: 100n,
        nonce: 5,
        gasLimit: 21000n,
        to,
        value: 1n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      },
      { type: 0, chainId: 1, nonce: 0, gasLimit: 50000, to, value: 0, data: '0x1234', gasPrice: 7 },
      {
        chainId: 8453,
        nonce: 1,
        gasLimit: 21000,
        to: null,
        data: '0x6000',
        maxFeePerGas: 3,
        maxPriorityFeePerGas: 3,
      },
    ]) {
      const { tx } = toCoreTransaction(request);
      const { raw } = await vaultBackend.sign.transaction(key, tx);
      expect(raw).toBe(await wallet.signTransaction(request));
    }
    for (const message of [Buffer.from('hi'), Buffer.alloc(0), Buffer.from('ff00', 'hex')]) {
      expect(await vaultBackend.sign.message(key, message)).toBe(await wallet.signMessage(message));
    }
    const domain = { name: 'Ether Mail', version: '1', chainId: 1 };
    const types = {
      Mail: [
        { name: 'contents', type: 'string' },
        { name: 'amount', type: 'uint256' },
      ],
    };
    const message = { contents: 'gm', amount: 10n ** 18n };
    const data = toCoreTypedData({ domain, types: { ...types, EIP712Domain: [] }, message });
    expect(await vaultBackend.sign.typedData(key, data)).toBe(
      await wallet.signTypedData(domain, types, message)
    );
    expect(await vaultBackend.typedDataHash(data)).toBe(
      TypedDataEncoder.hash(domain, types, message)
    );
    // Stricter than ethers: a bool given "false".
    const bool = {
      domain: {},
      types: { M: [{ name: 'b', type: 'bool' }] },
      message: { b: 'false' },
    };
    await expect(vaultBackend.sign.typedData(key, bool)).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    // Bee and publisher keys sign only chunks.
    await expect(
      vaultBackend.sign.message({ kind: 'bee_wallet' }, Buffer.from('x'))
    ).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    // Locked: no signing, but the public hash still works.
    await vaultBackend.lock();
    await expect(vaultBackend.sign.message(key, Buffer.from('hi'))).rejects.toMatchObject({
      code: 'vault_locked',
      message: 'Vault is locked',
    });
    expect(await vaultBackend.typedDataHash(data)).toBe(
      TypedDataEncoder.hash(domain, types, message)
    );
  }, 60_000);

  test('node identities', async () => {
    await vaultBackend.importVault('testpass1', ABANDON);
    const bee = path.join(root, 'bee');
    const written = await vaultBackend.writeNodeIdentity(
      { node: 'bee', data_dir: bee, api_port: 1633, p2p_port: 1634 },
      'op-bee'
    );
    expect(written).toMatchObject({ status: 'installed' });
    expect(written.address).toMatch(/^0x/);
    expect(fs.existsSync(path.join(bee, 'keys', 'swarm.key'))).toBe(true);
    expect(fs.readFileSync(path.join(bee, 'config.yaml'), 'utf8')).toContain(
      'api-addr: 127.0.0.1:1633'
    );
    const home = path.join(root, 'radicle');
    const radicle = await vaultBackend.writeNodeIdentity(
      { node: 'radicle', home, alias: 'FreedomBrowser' },
      'op-radicle'
    );
    expect(radicle.did).toMatch(/^did:key:z6Mk/);
    expect(fs.existsSync(path.join(home, 'keys', 'radicle.pub'))).toBe(true);
  }, 60_000);
});
