const { test, expect } = require('./fixtures');

for (const reviewed of [false, true]) {
  test(`an encrypted ${reviewed ? 'reviewed' : 'uncertain'} submission survives vault lock and a real Electron restart`, async ({
    electronApp,
    relaunchApp,
  }) => {
    const created = await electronApp.evaluate(async ({ app }, reviewed) => {
      const req = process.mainModule
        .require('module')
        .createRequire(`${app.getAppPath()}/package.json`);
      const vault = req('./src/main/identity/vault');
      const directory = req('path').join(app.getPath('userData'), 'journal-vault-fixture');
      await vault.importVault(
        directory,
        'fixture-password',
        'test test test test test test test test test test test junk'
      );
      await vault.unlockVault(directory, 'fixture-password', 0);
      const session = req('./src/main/wallet/privacy-session').openPrivacySession();
      const handle = session.getContext({
        kind: 'public-address',
        principal: `0x${'a'.repeat(40)}`,
        chainId: 11155111,
        role: 'transaction-rpc',
      });
      const journal = req(
        './src/main/wallet/private-submission-journal'
      ).getPrivateSubmissionJournal(handle);
      const hash = `0x${'b'.repeat(64)}`;
      await journal.begin(hash, 4);
      if (reviewed) {
        const blockHash = `0x${'c'.repeat(64)}`;
        const rpc = {
          signal: session.signal,
          request: async (method, _params, validate) => {
            const result = {
              eth_getTransactionReceipt: {
                transactionHash: hash,
                from: `0x${'a'.repeat(40)}`,
                status: '0x1',
                blockHash,
                blockNumber: '0x10',
              },
              eth_getBlockByNumber: { hash: blockHash, number: '0x10' },
              eth_blockNumber: '0x11',
            }[method];
            if (!validate(result)) throw new Error('Invalid fixture');
            return { result };
          },
        };
        const reconciler = req(
          './src/main/wallet/private-submission-reconciler'
        ).createSubmissionReconciler({
          rpc,
          journal,
          principal: `0x${'a'.repeat(40)}`,
          assertActive: () => req('./src/main/networks/privacy-context').getPrivacyContext(handle),
        });
        await reconciler.resolve(hash, {
          minimumConfirmations: 2,
          review: async () => ({ allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' }),
        });
      }
      const profile = req('./src/main/profile-resolver').getActiveProfile();
      const fs = req('fs');
      const journalDir = req('path').join(profile.userDataDir, 'wallet-private-submissions');
      const encrypted = fs.readFileSync(
        req('path').join(journalDir, fs.readdirSync(journalDir)[0]),
        'utf8'
      );
      vault.lockVault();
      const locked = await journal.list().then(
        () => null,
        (error) => error.code
      );
      return {
        hash,
        locked,
        ciphertextContainsHash: encrypted.includes(hash),
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
      };
    }, reviewed);
    expect(created.locked).toBe('PRIVACY_CONTEXT_REVOKED');
    expect(created.ciphertextContainsHash).toBe(false);
    if (created.packaged) expect(created.appPath).toContain('app.asar');
    await electronApp.close();
    const restarted = await relaunchApp();
    const restored = await restarted.evaluate(async ({ app }) => {
      const req = process.mainModule
        .require('module')
        .createRequire(`${app.getAppPath()}/package.json`);
      const vault = req('./src/main/identity/vault');
      await vault.unlockVault(
        req('path').join(app.getPath('userData'), 'journal-vault-fixture'),
        'fixture-password',
        0
      );
      const handle = req('./src/main/wallet/privacy-session')
        .openPrivacySession()
        .getContext({
          kind: 'public-address',
          principal: `0x${'a'.repeat(40)}`,
          chainId: 11155111,
          role: 'transaction-rpc',
        });
      const journal = req(
        './src/main/wallet/private-submission-journal'
      ).getPrivateSubmissionJournal(handle);
      const records = await journal.list();
      const newSend = await journal.assertCanSubmit().then(
        () => null,
        (error) => error.code
      );
      if (records[0].resolution) {
        await journal.observe(
          records[0].hash,
          {
            status: 'reorged',
            blockNumber: null,
            blockHash: null,
            confirmations: 0,
            observedAt: Date.now(),
            trust: 'unverified',
          },
          records[0].revision
        );
      }
      const afterReorg = await journal.assertCanSubmit().then(
        () => null,
        (error) => error.code
      );
      vault.lockVault();
      return { records, newSend, afterReorg };
    });
    expect(restored.records).toEqual([
      expect.objectContaining({ hash: created.hash, nonce: 4, state: 'attempted' }),
    ]);
    expect(restored.newSend).toBe(reviewed ? null : 'PRIVATE_SUBMISSION_UNRESOLVED');
    expect(restored.afterReorg).toBe('PRIVATE_SUBMISSION_UNRESOLVED');
  });
}

test('local artifact checks and CPU-bound worker cancellation run in Electron', async ({
  electronApp,
}) => {
  const result = await electronApp.evaluate(async ({ app }) => {
    const req = process.mainModule
      .require('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const fs = req('fs'),
      path = req('path');
    const directory = fs.mkdtempSync(path.join(app.getPath('userData'), 'prover-fixture-'));
    const controller = new AbortController();
    const scope = req('./src/main/networks/privacy-context').createPrivacyScope({
      profileId: 'fixture',
      signal: controller.signal,
    });
    const subject = {
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'ppv2-fixture',
      deployment: 'sepolia-fixture',
      chainId: 11155111,
    };
    const data = Buffer.from('synthetic public artifact');
    fs.writeFileSync(path.join(directory, 'circuit.wasm'), data);
    const loader = req('./src/main/wallet/privacy-artifacts').createPrivacyArtifactLoader({
      handle: scope.getContext({ ...subject, role: 'artifacts' }),
      directory,
      manifest: [
        {
          name: 'circuit.wasm',
          size: data.length,
          sha256: req('crypto').createHash('sha256').update(data).digest('hex'),
        },
      ],
    });
    const loaded = (await loader.load('circuit.wasm')).equals(data);
    fs.writeFileSync(path.join(directory, 'circuit.wasm'), Buffer.alloc(data.length));
    const tampered = await loader.load('circuit.wasm').then(
      () => null,
      (error) => error.code
    );
    const filename = path.join(directory, 'worker.cjs');
    fs.writeFileSync(
      filename,
      `const { workerData } = require('worker_threads');
      const state = new Int32Array(workerData); Atomics.store(state, 0, 1); while (true) Atomics.add(state, 1, 1);`
    );
    const shared = new SharedArrayBuffer(8),
      state = new Int32Array(shared);
    const task = req('./src/main/wallet/privacy-worker')
      .runPrivacyWorker({
        handle: scope.getContext({ ...subject, role: 'prover' }),
        filename,
        workerData: shared,
        validateResult: () => false,
        timeoutMs: 5000,
      })
      .then(
        () => null,
        (error) => error.code
      );
    const start = Date.now();
    while (!Atomics.load(state, 0) && Date.now() - start < 3000)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Atomics.load(state, 0) === 1;
    controller.abort();
    const cancelled = await task;
    const counter = Atomics.load(state, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { loaded, tampered, started, cancelled, stopped: counter === Atomics.load(state, 1) };
  });
  expect(result).toEqual({
    loaded: true,
    tampered: 'PRIVATE_ARTIFACT_INVALID',
    started: true,
    cancelled: 'PRIVACY_CONTEXT_REVOKED',
    stopped: true,
  });
});
