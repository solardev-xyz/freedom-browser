const { test, expect } = require('./fixtures');
const artifact = process.env.FREEDOM_PP_V2_PROCESS_ASAR;

test('PPv2 fresh single-thread verification accepts all circuits and rejects changed signals', async ({
  electronApp,
}, testInfo) => {
  test.skip(!artifact, 'Set FREEDOM_PP_V2_PROCESS_ASAR to the reviewed packed runtime');
  test.setTimeout(180000);
  const report = await electronApp.evaluate(async ({ app }, artifact) => {
    const req = process.mainModule
      .require('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const fs = req('fs'),
      path = req('path');
    const runtime = req('./src/main/wallet/ppv2-runtime').loadPPv2Runtime(artifact);
    const { createPrivacyScope } = req('./src/main/networks/privacy-context');
    const scope = createPrivacyScope({
      profileId: 'single-thread-verifier-fixture',
      signal: new AbortController().signal,
    });
    const handle = scope.getContext({
      kind: 'private-account',
      principal: 'synthetic',
      protocol: 'ppv2-fixture',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'prover',
    });
    const { ARTIFACTS, NATIVE, FIELD } = req('./src/main/wallet/ppv2-deposit-policy');
    const run = req('./src/main/wallet/privacy-process').runPrivacyProcess;
    const checks = [];
    try {
      for (const circuit of ['deposit', 'ragequit', 'transact_1x1']) {
        const manifest =
          circuit === 'deposit'
            ? ARTIFACTS
            : JSON.parse(fs.readFileSync(path.join(runtime.archive, 'exit-manifest.json'))).filter(
                (entry) => entry.circuit === circuit
              );
        const artifacts = {};
        for (const entry of manifest) {
          const bytes = fs.readFileSync(path.join(runtime.archive, 'artifacts', entry.name));
          artifacts[entry.kind] = Buffer.alloc(bytes.length);
          bytes.copy(artifacts[entry.kind]);
        }
        const proved = await run({
          handle,
          filename:
            circuit === 'deposit'
              ? req.resolve('./src/main/wallet/ppv2-deposit-job')
              : path.join(runtime.archive, 'exit-job.cjs'),
          input: {
            sdkEntry: runtime.sdkEntry,
            artifacts,
            ...(circuit === 'deposit'
              ? {
                  witness: {
                    tokenId: NATIVE,
                    value: '0x64',
                    context: '0x3',
                    noteAddressHash: '0x1',
                    depositSecret: '0x2',
                  },
                }
              : { circuit, singleThread: true, relayContext: '0x1234' }),
          },
          validateResult: (value) => value?.verified === true,
        });
        const proof =
          circuit === 'deposit' ? proved.result.proof : proved.result.publicFixture.proof;
        const changed = structuredClone(proof);
        changed.publicSignals[0] = `0x${((BigInt(changed.publicSignals[0]) + 1n) % FIELD).toString(16)}`;
        for (const [name, value, expected] of [
          ['valid', proof, true],
          ['changed-signal', changed, false],
        ]) {
          const verified = await run({
            handle,
            filename: req.resolve('./src/main/wallet/ppv2-proof-verify-job'),
            input: {
              sdkEntry: runtime.sdkEntry,
              proverEntry: runtime.proverEntry,
              circuit,
              proof: value,
              vkey: Uint8Array.from(artifacts.verificationKey),
            },
            timeoutMs: 30000,
            heapMb: 256,
            rssMb: 768,
            // A crash, timeout or malformed result is not a negative-control pass.
            validateResult: (value) => typeof value?.verified === 'boolean',
          });
          if (verified.result.verified !== expected) throw new Error('Verifier control mismatch');
          checks.push({
            circuit,
            name,
            verified: verified.result.verified,
            peakRssBytes: verified.peakRssBytes,
          });
        }
      }
      return {
        checks,
        logicalCores: req('os').cpus().length,
        runtimeSha256: req('./src/main/wallet/ppv2-runtime-manifest').sha256,
        enforcedByJobGuards: ['worker-creation-refused', 'shared-curve-cache-empty'],
        syntheticOnly: true,
        liveTransactionSubmitted: false,
      };
    } finally {
      scope.close();
    }
  }, artifact);
  expect(report.checks).toHaveLength(6);
  expect(report.checks.filter((check) => check.verified)).toHaveLength(3);
  await testInfo.attach('ppv2-single-thread-verifier-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});

test('PPv2 proves from ASAR in a managed utility process; cancellation, crash and egress fail closed', async ({
  electronApp,
}, testInfo) => {
  test.skip(!artifact, 'Set FREEDOM_PP_V2_PROCESS_ASAR to the isolated pinned SDK fixture');
  test.setTimeout(120000);
  const report = await electronApp.evaluate(async ({ app }, artifact) => {
    const req = process.mainModule
      .require('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const fs = req('fs'),
      path = req('path');
    const vault = req('./src/main/identity/vault');
    const directory = path.join(app.getPath('userData'), 'ppv2-process-vault');
    await vault.importVault(
      directory,
      'fixture-password',
      'test test test test test test test test test test test junk'
    );
    await vault.unlockVault(directory, 'fixture-password', 0);
    const session = req('./src/main/wallet/privacy-session').openPrivacySession();
    const subject = {
      kind: 'private-account',
      principal: 'synthetic',
      protocol: 'ppv2-fixture',
      deployment: 'fixture',
      chainId: 11155111,
    };
    const manifest = JSON.parse(fs.readFileSync(`${artifact}/manifest.json`, 'utf8'));
    // ASAR verification keys and WASM are public. Copy to a dedicated local
    // artifact directory so the loader's O_NOFOLLOW/stat contract stays native.
    const artifactDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'ppv2-artifacts-'));
    for (const entry of manifest)
      fs.writeFileSync(
        path.join(artifactDir, entry.name),
        fs.readFileSync(`${artifact}/artifacts/${entry.name}`)
      );
    const loader = req('./src/main/wallet/privacy-artifacts').createPrivacyArtifactLoader({
      handle: session.getContext({ ...subject, role: 'artifacts' }),
      directory: artifactDir,
      manifest,
    });
    const artifacts = {};
    for (const entry of manifest) artifacts[entry.kind] = await loader.load(entry.name);
    const run = req('./src/main/wallet/privacy-process').runPrivacyProcess;
    const handle = session.getContext({ ...subject, role: 'prover' });
    const args = {
      handle,
      filename: `${artifact}/job.cjs`,
      input: { sdkEntry: `${artifact}/sdk.cjs`, artifacts },
      validateResult: (value) => value?.verified === true && value?.tamperedRejected === true,
      timeoutMs: 60000,
    };
    const proof = await run(args);
    // Chromium's metrics snapshot may still list an already-reaped PID for a
    // moment after exit. Check OS liveness instead of treating that cache as a
    // running child (EPERM remains a failure, only ESRCH proves absence).
    const livePids = () =>
      app
        .getAppMetrics()
        .filter((entry) => entry.name === 'Freedom private computation')
        .map((entry) => entry.pid)
        .filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return error.code !== 'ESRCH';
          }
        });
    const afterProof = livePids();
    process.env.FREEDOM_PROCESS_TEST_SECRET = 'synthetic-environment-marker';
    const egress = await run({
      ...args,
      input: { mode: 'egress' },
      validateResult: (value) => value?.nested === true,
    });
    delete process.env.FREEDOM_PROCESS_TEST_SECRET;
    const crash = await run({ ...args, input: { mode: 'crash' } }).then(
      () => null,
      (error) => error.code
    );
    const timeout = await run({ ...args, input: { mode: 'hang' }, timeoutMs: 500 }).then(
      () => null,
      (error) => error.code
    );
    const memory = await run({ ...args, input: { mode: 'memory' }, rssMb: 128 }).then(
      () => null,
      (error) => error.code
    );
    let started = false;
    const cancelled = await run({
      ...args,
      onProgress: () => {
        started = true;
        vault.lockVault();
      },
    }).then(
      () => null,
      (error) => error.code
    );
    const afterCancel = livePids();
    // Fresh vault lifetime can start and complete another actual proof.
    await vault.unlockVault(directory, 'fixture-password', 0);
    const next = req('./src/main/wallet/privacy-session')
      .openPrivacySession()
      .getContext({ ...subject, role: 'prover' });
    const recovered = await run({ ...args, handle: next });
    vault.lockVault();
    return {
      proof,
      egress,
      crash,
      timeout,
      memory,
      started,
      cancelled,
      afterProof,
      afterCancel,
      recovered,
      packaged: app.isPackaged,
      hostFromAsar: req.resolve('./src/main/wallet/privacy-process').includes('app.asar/'),
    };
  }, artifact);
  await testInfo.attach('ppv2-process-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.proof.result).toMatchObject({
    verified: true,
    tamperedRejected: true,
    ownedArtifactBuffers: true,
    fromAsar: true,
    sdkFromAsar: true,
  });
  expect(report.proof.peakRssBytes).toBeGreaterThan(0);
  expect(report.egress.result).toMatchObject({ nested: true, inheritedSecret: null });
  expect(report.egress.result.refused).toEqual([
    'fetch',
    'http',
    'socket',
    'dns',
    'dns-resolver',
    'dns-promise-resolver',
    'dns-reverse',
    'udp',
    'udp-constructor',
    'http2',
    'child',
    'electron',
  ]);
  expect(report.crash).toBe('PRIVATE_PROCESS_FAILED');
  expect(report.timeout).toBe('PRIVACY_REQUEST_ABORTED');
  expect(report.memory).toBe('PRIVATE_PROCESS_MEMORY_LIMIT');
  expect(report.started).toBe(true);
  expect(report.cancelled).toBe('PRIVACY_CONTEXT_REVOKED');
  expect(report.afterProof).toEqual([]);
  expect(report.afterCancel).toEqual([]);
  expect(report.recovered.result.verified).toBe(true);
  if (report.packaged) expect(report.hostFromAsar).toBe(true);
});

test('PPv2 runtime identity is checked in main and again inside the prover before SDK execution', async ({
  electronApp,
}, testInfo) => {
  test.skip(!artifact, 'Set FREEDOM_PP_V2_PROCESS_ASAR to the reviewed packed runtime');
  test.setTimeout(120000);
  const report = await electronApp.evaluate(async ({ app }, artifact) => {
    const req = process.mainModule
      .require('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const fs = req('original-fs'),
      virtualFs = req('fs'),
      path = req('path');
    const runtime = req('./src/main/wallet/ppv2-runtime');
    const archive = runtime.verifyPPv2Runtime(artifact);
    const directory = fs.mkdtempSync(path.join(app.getPath('userData'), 'ppv2-runtime-integrity-'));
    const copy = path.join(directory, 'runtime.asar');
    fs.copyFileSync(archive, copy);
    const loaded = runtime.loadPPv2Runtime(copy);
    const { createPrivacyScope } = req('./src/main/networks/privacy-context');
    const scope = createPrivacyScope({
      profileId: 'integrity-fixture',
      signal: new AbortController().signal,
    });
    const handle = scope.getContext({
      kind: 'private-account',
      principal: 'synthetic',
      protocol: 'ppv2-fixture',
      deployment: 'fixture',
      chainId: 11155111,
      role: 'prover',
    });
    const { ARTIFACTS, NATIVE } = req('./src/main/wallet/ppv2-deposit-policy');
    const artifacts = {};
    for (const entry of ARTIFACTS) {
      const bytes = virtualFs.readFileSync(`${archive}/artifacts/${entry.name}`);
      artifacts[entry.kind] = Buffer.alloc(bytes.length);
      bytes.copy(artifacts[entry.kind]);
    }
    const run = req('./src/main/wallet/privacy-process').runPrivacyProcess;
    let progressed;
    const args = {
      handle,
      filename: req.resolve('./src/main/wallet/ppv2-deposit-job'),
      input: {
        sdkEntry: loaded.sdkEntry,
        artifacts,
        witness: {
          tokenId: NATIVE,
          value: '0x64',
          context: '0x3',
          noteAddressHash: '0x1',
          depositSecret: '0x2',
        },
      },
      onProgress: () => {
        progressed = true;
      },
      validateResult: (value) => value?.verified === true,
    };
    try {
      const healthy = await run(args);
      const fd = fs.openSync(copy, 'r+'),
        last = Buffer.alloc(1),
        position = fs.fstatSync(fd).size - 1;
      try {
        fs.readSync(fd, last, 0, 1, position);
        last[0] ^= 1;
        fs.writeSync(fd, last, 0, 1, position);
      } finally {
        fs.closeSync(fd);
      }
      const refusal = (task) => {
        try {
          task();
          return null;
        } catch (error) {
          return error.code;
        }
      };
      const main = refusal(() => runtime.loadPPv2Runtime(copy));
      const staleCandidate = refusal(() => runtime.assertPPv2Candidate(loaded.candidate));
      progressed = false;
      const child = await run(args).then(
        () => null,
        (error) => error.code
      );
      return {
        healthy: healthy.result.verified,
        main,
        staleCandidate,
        child,
        progressed,
        packaged: app.isPackaged,
        liveTransactionSubmitted: false,
        archiveSha256: req('./src/main/wallet/ppv2-runtime-manifest').sha256,
      };
    } finally {
      scope.close();
    }
  }, artifact);
  await testInfo.attach('ppv2-runtime-integrity-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report).toMatchObject({
    healthy: true,
    main: 'PRIVATE_PPV2_RUNTIME_INVALID',
    staleCandidate: 'PRIVATE_PPV2_RUNTIME_INVALID',
    child: 'PRIVATE_PROCESS_FAILED',
    progressed: false,
    liveTransactionSubmitted: false,
  });
});
