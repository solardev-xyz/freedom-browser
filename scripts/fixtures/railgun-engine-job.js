/** Offline qualification only. All keys are public test fixtures, never user keys. */
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const { assertRailgunFixture } = require('../railgun-fixture-integrity');
const { createPrivacyScope } = require('../../src/main/networks/privacy-context');
const { createRailgunStore } = require('../../src/main/wallet/railgun-store');
const { createRailgunLeveldown } = require('../../src/main/wallet/railgun-leveldown');
const {
  createRailgunHostProvider,
  lockRailgunHttp,
} = require('../../src/main/networks/railgun-host-provider');
const { installPPv2EgressTripwire } = require('./ppv2-egress-tripwire');

async function main() {
  const [directory, mode, fixture = path.join(__dirname, 'railgun-engine')] = process.argv.slice(2);
  assert.ok(path.isAbsolute(directory));
  assert.ok(['create', 'fault', 'restore'].includes(mode));
  const inventory = assertRailgunFixture(path.join(fixture, 'node_modules'));
  const r = createRequire(path.join(fixture, 'package.json'));
  const pendingTimers = new Map();
  const nativeTimeout = global.setTimeout,
    nativeClearTimeout = global.clearTimeout;
  global.setTimeout = (callback, delay, ...args) => {
    const source = new Error().stack;
    const timer = nativeTimeout(
      function (...values) {
        pendingTimers.delete(timer);
        callback.apply(this, values);
      },
      delay,
      ...args
    );
    pendingTimers.set(timer, { delay, source });
    return timer;
  };
  global.clearTimeout = (timer) => {
    pendingTimers.delete(timer);
    return nativeClearTimeout(timer);
  };
  const tripwire = installPPv2EgressTripwire();
  const ethers = r('ethers');
  assert.equal(ethers.version, '6.14.3');
  lockRailgunHttp(ethers.FetchRequest);
  const engine = r('@railgun-community/engine');
  const engineDirectory = path.dirname(r.resolve('@railgun-community/engine'));
  const { WalletNode } = require(path.join(engineDirectory, 'key-derivation/wallet-node.js'));
  const { getPublicSpendingKey, signEDDSA, verifyEDDSA } = require(
    path.join(engineDirectory, 'utils/keys-utils.js')
  );
  const { poseidon } = require(path.join(engineDirectory, 'utils/poseidon.js'));
  const { encodeAddress, decodeAddress } = require(
    path.join(engineDirectory, 'key-derivation/bech32.js')
  );
  const checks = [];
  const check = async (name, fn) => {
    await fn();
    checks.push(name);
  };
  const scope = createPrivacyScope({
    profileId: 'public-railgun-fixture',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture0',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'storage',
  });
  const store = createRailgunStore({
    handle,
    filename: path.join(directory, 'engine.sqlite'),
    onFatal: () => scope.close(),
    key: Buffer.alloc(32, 7),
    binding: 'a'.repeat(64),
    create: mode === 'create',
  });
  const leveldown = createRailgunLeveldown({ ...r('abstract-leveldown'), store });
  const refused = async () => {
    throw new Error('Unqualified engine capability refused');
  };
  const blocked = {
    assertArtifactExists: () => {
      throw new Error('Unqualified artifact');
    },
    getArtifacts: refused,
    getArtifactsPOI: refused,
  };
  const debuggerErrors = [];
  let instance, provider;
  try {
    instance = await engine.RailgunEngine.initForWallet(
      'freedomfixture',
      leveldown,
      blocked,
      refused,
      refused,
      refused,
      refused,
      {
        log() {},
        error(error) {
          debuggerErrors.push({ name: error?.name, code: error?.code });
        },
      },
      false
    );
    await check('identity-public-key-vectors', async () => {
      const { mnemonicToSeedSync } = require('@scure/bip39');
      const { deriveRailgunKey } = require('../../src/main/identity/railgun-key-derivation');
      const phrase =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      const seed = mnemonicToSeedSync(phrase),
        key = deriveRailgunKey(seed, "m/0'");
      try {
        const expected = [
          1700559105542139805112168139351320601853033442476682590258553412078471731431n,
          20772987336827599306927277921643441679141423747083423413320022373456048866305n,
        ];
        assert.deepEqual(getPublicSpendingKey(key), expected);
        assert.deepEqual(
          WalletNode.fromMnemonic(phrase).derive("m/0'").getSpendingKeyPair().pubkey,
          expected
        );
        assert.equal(
          Buffer.from(await engine.getPublicViewingKey(key)).toString('hex'),
          '0debf77d8e9436fc07a0dc3fe8bd90c2f592a08cab8dbe5f972a4783465cd6d4'
        );
        const hash = poseidon([1n, 2n]),
          signature = signEDDSA(key, hash);
        assert.equal(verifyEDDSA(hash, signature, expected), true);
        assert.equal(verifyEDDSA(hash + 1n, signature, expected), false);
      } finally {
        key.fill(0);
        seed.fill(0);
      }
    });
    await check('product-path-hardware-address-equivalence', async () => {
      const { mnemonicToSeedSync } = require('@scure/bip39');
      const { deriveRailgunKey } = require('../../src/main/identity/railgun-key-derivation');
      const phrase =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      const seed = mnemonicToSeedSync(phrase),
        spending = deriveRailgunKey(seed, "m/44'/1984'/0'/0'/0'"),
        viewing = deriveRailgunKey(seed, "m/420'/1984'/0'/0'/0'");
      try {
        const expected = await instance.createWalletFromMnemonic('09'.repeat(32), phrase, 0);
        const hardware = new engine.HardwareWallet(
          'synthetic-public-identity',
          instance.db,
          { privateKey: viewing, pubkey: await engine.getPublicViewingKey(viewing) },
          getPublicSpendingKey(spending),
          undefined,
          instance.prover
        );
        assert.equal(hardware.getAddress(), expected.getAddress());
        assert.equal(
          hardware.generateShareableViewingKey(),
          expected.generateShareableViewingKey()
        );
        instance.unloadWallet(expected.id);
      } finally {
        spending.fill(0);
        viewing.fill(0);
        seed.fill(0);
      }
    });
    await check('upstream-address-vector', () => {
      const address =
        '0zk1qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqunpd9kxwatwqyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhshkca';
      const data = {
        masterPublicKey: 0n,
        viewingPublicKey: new Uint8Array(32),
        chain: { type: 0, id: 1 },
        version: 1,
      };
      assert.equal(encodeAddress(data), address);
      assert.deepEqual(decodeAddress(address), data);
    });
    await check('engine-database-encodings-and-atomic-batch', async () => {
      if (mode !== 'create') {
        assert.deepEqual(await instance.db.get(['aa'], 'json'), { fixture: true });
        for (const key of ['late-key', 'atomic-before-error', 'test-a', 'test-b', 'test-c'])
          await assert.rejects(instance.db.level.get(key));
        await assert.rejects(instance.db.get(['ad'], 'utf8'));
        assert.deepEqual(await instance.db.level.get('batch-key', { valueEncoding: 'json' }), {
          fixture: 'batch',
        });
      }
      await instance.db.put(['aa'], { fixture: true }, 'json');
      await instance.db.put(['ab'], 'ff0011', 'hex');
      await instance.db.put(['ac'], 'fixture-value', 'utf8');
      assert.deepEqual(await instance.db.get(['aa'], 'json'), { fixture: true });
      assert.equal(await instance.db.get(['ab'], 'hex'), 'ff0011');
      assert.equal(await instance.db.get(['ac'], 'utf8'), 'fixture-value');
      await instance.db.batch(
        [{ type: 'put', key: 'batch-key', value: { fixture: 'batch' } }],
        'json'
      );
      assert.deepEqual(await instance.db.level.get('batch-key', { valueEncoding: 'json' }), {
        fixture: 'batch',
      });
      const values = await instance.db.level.getMany(['batch-key', 'absent'], {
        valueEncoding: 'json',
      });
      assert.deepEqual(values, [{ fixture: 'batch' }, undefined]);
    });
    const call = (method, ...args) =>
      new Promise((resolve, reject) =>
        leveldown[method](...args, (error, ...result) => (error ? reject(error) : resolve(result)))
      );
    await check('ordered-snapshot-range-seek-and-atomic-clear', async () => {
      await call(
        'batch',
        [
          { type: 'put', key: 'test-a', value: '1' },
          { type: 'put', key: 'test-b', value: '2' },
          { type: 'put', key: 'test-c', value: '3' },
        ],
        {}
      );
      const iterator = leveldown.iterator({
        gte: 'test-a',
        lt: 'test-d',
        reverse: true,
        limit: 2,
        keyAsBuffer: false,
        valueAsBuffer: false,
      });
      await call('put', 'test-b', 'changed', {});
      assert.deepEqual(await iterator.next(), ['test-c', '3']);
      iterator.seek('test-b');
      assert.deepEqual(await iterator.next(), ['test-b', '2']);
      assert.equal(await iterator.next(), undefined);
      await iterator.end();
      await call('clear', { gte: 'test-a', lte: 'test-c', limit: -1 });
      await assert.rejects(call('get', 'test-b', {}), /NotFound/);
    });
    // Public vector copied from upstream hardware-wallet.test.ts. No spending
    // private key is used by the HardwareWallet connector in this fixture.
    const shared =
      '82a57670726976d94034326232623861643234306331323630396633623265363865656137613636373330306437373332633335346238373338343266373433313135313836303066a473707562d94061316166356531353935616330303736303734646465653034323737356230363365366434653666313966613632633333323935636336643363646635313165';
    let connectorCalls = 0;
    const connector = {
      requestBatchApproval: refused,
      sign: async (hash, inputs, session) => {
        connectorCalls++;
        assert.equal(
          hash,
          poseidon([
            inputs.merkleRoot,
            inputs.boundParamsHash,
            ...inputs.nullifiers,
            ...inputs.commitmentsOut,
          ])
        );
        if (session !== 'public-fixture') throw new Error('Fixture signing session refused');
        throw new Error('Signing intentionally unavailable');
      },
    };
    let wallet;
    await check('hardware-wallet-create-or-fresh-process-restore', async () => {
      if (mode === 'create') {
        wallet = await instance.createHardwareWalletFromShareableViewingKey(
          '08'.repeat(32),
          shared,
          undefined,
          connector
        );
        fs.writeFileSync(
          path.join(directory, 'public-wallet-id.json'),
          JSON.stringify({ id: wallet.id, address: wallet.getAddress() })
        );
      } else {
        const state = JSON.parse(fs.readFileSync(path.join(directory, 'public-wallet-id.json')));
        wallet = await instance.loadExistingHardwareWallet('08'.repeat(32), state.id, connector);
        assert.equal(wallet.getAddress(), state.address);
      }
      assert.equal(wallet.generateShareableViewingKey(), shared);
      assert.deepEqual((await wallet.getSpendingKeyPair('unused')).privateKey, new Uint8Array(32));
      await assert.rejects(
        wallet.sign(
          { merkleRoot: 1n, boundParamsHash: 2n, nullifiers: [3n], commitmentsOut: [4n] },
          'public-fixture'
        ),
        /Signing intentionally unavailable/
      );
      assert.equal(connectorCalls, 1);
      await assert.rejects(wallet.requestBatchApproval([]));
      await assert.rejects(
        wallet.sign(
          { merkleRoot: 1n, boundParamsHash: 2n, nullifiers: [3n], commitmentsOut: [4n] },
          ''
        ),
        /Fixture signing session refused/
      );
    });
    const abort = new AbortController(),
      calls = [];
    provider = createRailgunHostProvider({
      PollingJsonRpcProvider: engine.PollingJsonRpcProvider,
      chainId: 11155111,
      signal: abort.signal,
      provider: {
        signal: abort.signal,
        request: async ({ method }) => {
          calls.push(method);
          if (method === 'eth_blockNumber') return '0x123';
          if (method === 'eth_chainId') return '0xaa36a7';
          if (method === 'eth_getLogs') return [];
          throw new Error('Unexpected fixture RPC');
        },
      },
    });
    await check('actual-engine-provider-host-only-and-revoked', async () => {
      assert.equal(await provider.getBlockNumber(), 291);
      assert.deepEqual(
        await provider.getLogs({ address: '0x' + '11'.repeat(20), fromBlock: 1, toBlock: 2 }),
        []
      );
      const before = calls.length;
      await assert.rejects(
        provider._send([
          { id: 1, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },
          { id: 2, jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: ['0x'] },
        ])
      );
      assert.equal(calls.length, before);
      await instance.loadNetwork(
        { type: 0, id: 11155111 },
        '0x' + '11'.repeat(20),
        '0x' + '22'.repeat(20),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        provider,
        provider,
        { [engine.TXIDVersion.V2_PoseidonMerkle]: 1, [engine.TXIDVersion.V3_PoseidonMerkle]: 1 },
        2,
        false
      );
      assert.ok(
        instance.getUTXOMerkletree(engine.TXIDVersion.V2_PoseidonMerkle, { type: 0, id: 11155111 })
      );
      // Exercise current upstream unload behavior; host revocation below is the
      // authority. This fixture must not imply unload removes the global state.
      await instance.unloadNetwork({ type: 0, id: 11155111 });
      assert.ok(
        instance.getUTXOMerkletree(engine.TXIDVersion.V2_PoseidonMerkle, { type: 0, id: 11155111 })
      );
      abort.abort();
      await assert.rejects(
        provider._send({ id: 3, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] })
      );
    });
    await check('unqualified-artifacts-and-validation-refused', async () => {
      await assert.rejects(instance.validateRailgunTxidMerkleroot());
      await assert.rejects(instance.getLatestValidatedRailgunTxid());
      await assert.rejects(instance.quickSyncEvents());
      await assert.rejects(blocked.getArtifacts());
    });
    await check('write-failure-or-lock-revokes-session', async () => {
      if (mode === 'fault') {
        await assert.rejects(
          instance.db.level.batch(
            [
              { type: 'put', key: 'atomic-before-error', value: 'must-not-commit' },
              { type: 'put', key: 'too-large', value: Buffer.alloc(1024 * 1024 + 1) },
            ],
            { valueEncoding: 'binary' }
          )
        );
        assert.equal(store.signal.aborted, true);
        assert.throws(() => store.get(Buffer.from('atomic-before-error')));
        await assert.rejects(instance.db.put(['ad'], 'not-committed', 'utf8'));
        return;
      }
      const iterator = leveldown.iterator({});
      const pending = call('put', 'late-key', 'late-value', {});
      scope.close();
      await assert.rejects(pending);
      await assert.rejects(iterator.next());
      await iterator.end();
      await assert.rejects(instance.db.put(['ad'], 'not-committed', 'utf8'));
    });
    await instance.db.close();
    // Let ethers cached-read expiry timers (250 ms) drain after revocation.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await new Promise(setImmediate);
    const resources = process.getActiveResourcesInfo();
    assert.equal(resources.filter((name) => name === 'Timeout').length, 2);
    assert.ok(
      resources.every((name) => ['Timeout', 'PipeWrap', 'TTYWrap'].includes(name)),
      JSON.stringify(resources)
    );
    assert.equal(pendingTimers.size, 2);
    const timeoutCensus = [...pendingTimers.values()].map(({ delay, source }) => {
      assert.equal(delay, 60000);
      assert.ok(source.includes(path.join(engineDirectory, 'utils/promises.js')));
      return { delay, source: 'engine/dist/utils/promises.js' };
    });
    assert.deepEqual(debuggerErrors, []);
    const root = path.resolve(__dirname, '../..');
    const allowedFiles = new Set(
      [
        'scripts/fixtures/railgun-engine-job.js',
        'scripts/fixtures/ppv2-egress-tripwire.js',
        'scripts/railgun-fixture-integrity.js',
        'scripts/fixtures/railgun-engine/runtime-integrity.json',
        'src/main/networks/privacy-context.js',
        'src/main/networks/railgun-host-provider.js',
        'src/main/wallet/railgun-store.js',
        'src/main/wallet/railgun-leveldown.js',
        'src/main/identity/railgun-key-derivation.js',
      ].map((name) => path.join(root, name))
    );
    const allowedPackages = [
      'better-sqlite3',
      'bindings',
      'file-uri-to-path',
      '@scure/bip39',
      '@noble/hashes',
    ];
    const loadedNativeFiles = [];
    for (const file of Object.keys(require.cache)) {
      const inFixture = file.startsWith(path.join(fixture, 'node_modules') + path.sep);
      const inAllowedPackage = allowedPackages.some((name) =>
        file.startsWith(path.join(root, 'node_modules', name) + path.sep)
      );
      assert.ok(
        inFixture || inAllowedPackage || allowedFiles.has(file),
        'Unexpected module resolution: ' + file
      );
      if (inFixture)
        for (const child of require.cache[file].children) {
          assert.ok(
            child.filename.startsWith(path.join(fixture, 'node_modules') + path.sep),
            'Fixture dependency escaped its closure: ' + child.filename
          );
        }
      if (file.endsWith('.node')) loadedNativeFiles.push(path.relative(root, file));
    }
    tripwire.assertClean();
    const egress = tripwire.report();
    process.stdout.write(
      JSON.stringify({
        mode,
        checks,
        inventory,
        platform: process.platform,
        arch: process.arch,
        loadedNativeFiles,
        activeResourcesBeforeExit: resources,
        timeoutCensus,
        debuggerErrors,
        ethers: ethers.version,
        directAttempts: egress.attempts.length,
        refusalCanaries: egress.refusedCanaries.length,
        hooks: egress.hooks,
        actualEngine: true,
        signingEnabled: false,
        controlledNetworkLoaded: true,
        contractHistoryScanned: false,
        upstreamUnloadLeavesTree: true,
        termination: 'explicit-process-exit-after-revocation',
        productionEnabled: false,
      }) + '\n'
    );
  } finally {
    provider?.destroy();
    scope.close();
    store.close();
    // Keep tripwires installed through child process shutdown.
  }
}
main().then(
  () => process.stdout.write('', () => process.exit(0)),
  (error) => {
    process.stderr.write(error.stack + '\n', () => process.exit(1));
  }
);
