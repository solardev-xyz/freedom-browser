const { test, expect } = require('./fixtures');
const artifact = process.env.FREEDOM_PP_V2_PROCESS_ASAR;

for (const circuit of ['ragequit', 'transact_1x1']) {
for (const singleThread of [false, true]) {
  test(`real ${circuit} (${singleThread ? 'single-thread' : 'sdk-default'}) proving binds public signals and survives lock cancellation`, async ({ electronApp }, testInfo) => {
    test.skip(!artifact, 'Build the pinned SDK fixture with --exit-circuits');
    test.setTimeout(120000);
    const report = await electronApp.evaluate(async ({ app }, { artifact, circuit, singleThread }) => {
      const req = process.mainModule.require('module').createRequire(`${app.getAppPath()}/package.json`);
      const fs = req('fs'), path = req('path');
      const vault = req('./src/main/identity/vault');
      const directory = path.join(app.getPath('userData'), 'exit-circuit-vault');
      const manifest = JSON.parse(fs.readFileSync(`${artifact}/exit-manifest.json`, 'utf8')).filter((entry) => entry.circuit === circuit);
      const artifactDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'exit-circuit-artifacts-'));
      for (const entry of manifest) fs.writeFileSync(path.join(artifactDir, entry.name), fs.readFileSync(`${artifact}/artifacts/${entry.name}`));
      await vault.importVault(directory, 'fixture-password', 'test test test test test test test test test test test junk');
      await vault.unlockVault(directory, 'fixture-password', 0);
      const subject = { kind: 'private-account', principal: 'synthetic', protocol: 'ppv2-fixture', deployment: 'fixture', chainId: 11155111 };
      const session = req('./src/main/wallet/privacy-session').openPrivacySession();
      const loader = req('./src/main/wallet/privacy-artifacts').createPrivacyArtifactLoader({
        handle: session.getContext({ ...subject, role: 'artifacts' }), directory: artifactDir, manifest,
      });
      const artifacts = {};
      for (const entry of manifest) artifacts[entry.kind] = await loader.load(entry.name);
      const run = req('./src/main/wallet/privacy-process').runPrivacyProcess;
      const args = { handle: session.getContext({ ...subject, role: 'prover' }), filename: `${artifact}/exit-job.cjs`,
        input: { sdkEntry: `${artifact}/sdk.cjs`, artifacts, circuit, singleThread }, timeoutMs: 60000, rssMb: singleThread ? 768 : 2048,
        validateResult: (value) => value?.circuit === circuit && value?.verified === true && value?.publicSignalsBound === true && value?.tamperedAmountRejected === true };
      const livePids = () => app.getAppMetrics().filter((entry) => entry.name === 'Freedom private computation').map((entry) => entry.pid)
        .filter((pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
      try {
        const proof = await run(args);
        let started = false;
        const cancelled = await run({ ...args, onProgress: () => { started = true; vault.lockVault(); } })
          .then(() => null, (error) => error.code);
        const afterCancel = livePids();
        await vault.unlockVault(directory, 'fixture-password', 0);
        const next = req('./src/main/wallet/privacy-session').openPrivacySession().getContext({ ...subject, role: 'prover' });
        const recovered = await run({ ...args, handle: next });
        return { proof, started, cancelled, afterCancel, recovered, packaged: app.isPackaged,
          productionGate: req('./src/main/settings-store').isWalletTorExperimentAvailable(),
          hostFromAsar: req.resolve('./src/main/wallet/privacy-process').includes('app.asar/'),
          artifacts: manifest.map(({ name, size, sha256 }) => ({ name, size, sha256 })) };
      } finally { vault.lockVault(); }
    }, { artifact, circuit, singleThread });
    await testInfo.attach(`ppv2-${circuit}-${singleThread ? 'single-thread' : 'sdk-default'}-report`, { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(report.proof.result).toMatchObject({ circuit, verified: true, publicSignalsBound: true, tamperedAmountRejected: true,
      publicSignalCount: circuit === 'ragequit' ? 7 : 8, fromAsar: true, sdkFromAsar: true });
    expect(report.proof.peakRssBytes).toBeGreaterThan(0);
    expect(report.started).toBe(true); expect(report.cancelled).toBe('PRIVACY_CONTEXT_REVOKED');
    expect(report.afterCancel).toEqual([]); expect(report.recovered.result.verified).toBe(true);
    expect(report.productionGate).toBe(false); if (report.packaged) expect(report.hostFromAsar).toBe(true);
  });
}
}
