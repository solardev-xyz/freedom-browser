const { test, expect } = require('./fixtures');
const artifact = process.env.FREEDOM_PP_V2_PROCESS_ASAR;

test('PPv2 proves from ASAR in a managed utility process; cancellation, crash and egress fail closed', async ({ electronApp }, testInfo) => {
  test.skip(!artifact, 'Set FREEDOM_PP_V2_PROCESS_ASAR to the isolated pinned SDK fixture');
  test.setTimeout(120000);
  const report = await electronApp.evaluate(async ({ app }, artifact) => {
    const req = process.mainModule.require('module').createRequire(`${app.getAppPath()}/package.json`);
    const fs = req('fs'), path = req('path');
    const vault = req('./src/main/identity/vault');
    const directory = path.join(app.getPath('userData'), 'ppv2-process-vault');
    await vault.importVault(directory, 'fixture-password', 'test test test test test test test test test test test junk');
    await vault.unlockVault(directory, 'fixture-password', 0);
    const session = req('./src/main/wallet/privacy-session').openPrivacySession();
    const subject = { kind: 'private-account', principal: 'synthetic', protocol: 'ppv2-fixture', deployment: 'fixture', chainId: 11155111 };
    const manifest = JSON.parse(fs.readFileSync(`${artifact}/manifest.json`, 'utf8'));
    // ASAR verification keys and WASM are public. Copy to a dedicated local
    // artifact directory so the loader's O_NOFOLLOW/stat contract stays native.
    const artifactDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'ppv2-artifacts-'));
    for (const entry of manifest) fs.writeFileSync(path.join(artifactDir, entry.name), fs.readFileSync(`${artifact}/artifacts/${entry.name}`));
    const loader = req('./src/main/wallet/privacy-artifacts').createPrivacyArtifactLoader({
      handle: session.getContext({ ...subject, role: 'artifacts' }), directory: artifactDir, manifest,
    });
    const artifacts = {};
    for (const entry of manifest) artifacts[entry.kind] = await loader.load(entry.name);
    const run = req('./src/main/wallet/privacy-process').runPrivacyProcess;
    const handle = session.getContext({ ...subject, role: 'prover' });
    const args = { handle, filename: `${artifact}/job.cjs`, input: { sdkEntry: `${artifact}/sdk.cjs`, artifacts },
      validateResult: (value) => value?.verified === true && value?.tamperedRejected === true, timeoutMs: 60000 };
    const proof = await run(args);
    // Chromium's metrics snapshot may still list an already-reaped PID for a
    // moment after exit. Check OS liveness instead of treating that cache as a
    // running child (EPERM remains a failure, only ESRCH proves absence).
    const livePids = () => app.getAppMetrics().filter((entry) => entry.name === 'Freedom private computation')
      .map((entry) => entry.pid).filter((pid) => {
        try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
      });
    const afterProof = livePids();
    process.env.FREEDOM_PROCESS_TEST_SECRET = 'synthetic-environment-marker';
    const egress = await run({ ...args, input: { mode: 'egress' }, validateResult: (value) => value?.nested === true });
    delete process.env.FREEDOM_PROCESS_TEST_SECRET;
    const crash = await run({ ...args, input: { mode: 'crash' } }).then(() => null, (error) => error.code);
    const timeout = await run({ ...args, input: { mode: 'hang' }, timeoutMs: 500 }).then(() => null, (error) => error.code);
    const memory = await run({ ...args, input: { mode: 'memory' }, rssMb: 128 }).then(() => null, (error) => error.code);
    let started = false;
    const cancelled = await run({ ...args, onProgress: () => { started = true; vault.lockVault(); } }).then(() => null, (error) => error.code);
    const afterCancel = livePids();
    // Fresh vault lifetime can start and complete another actual proof.
    await vault.unlockVault(directory, 'fixture-password', 0);
    const next = req('./src/main/wallet/privacy-session').openPrivacySession().getContext({ ...subject, role: 'prover' });
    const recovered = await run({ ...args, handle: next });
    vault.lockVault();
    return { proof, egress, crash, timeout, memory, started, cancelled, afterProof, afterCancel, recovered,
      packaged: app.isPackaged, hostFromAsar: req.resolve('./src/main/wallet/privacy-process').includes('app.asar/') };
  }, artifact);
  await testInfo.attach('ppv2-process-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(report.proof.result).toMatchObject({ verified: true, tamperedRejected: true, fromAsar: true, sdkFromAsar: true });
  expect(report.proof.peakRssBytes).toBeGreaterThan(0);
  expect(report.egress.result).toMatchObject({ nested: true, inheritedSecret: null });
  expect(report.egress.result.refused).toEqual(['fetch', 'http', 'socket', 'dns', 'udp', 'http2', 'child', 'electron']);
  expect(report.crash).toBe('PRIVATE_PROCESS_FAILED');
  expect(report.timeout).toBe('PRIVACY_REQUEST_ABORTED');
  expect(report.memory).toBe('PRIVATE_PROCESS_MEMORY_LIMIT');
  expect(report.started).toBe(true);
  expect(report.cancelled).toBe('PRIVACY_CONTEXT_REVOKED');
  expect(report.afterProof).toEqual([]); expect(report.afterCancel).toEqual([]);
  expect(report.recovered.result.verified).toBe(true);
  if (report.packaged) expect(report.hostFromAsar).toBe(true);
});
