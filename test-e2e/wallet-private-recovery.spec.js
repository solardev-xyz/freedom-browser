const { test, expect } = require('./fixtures');

test('an encrypted submission survives vault lock and a real Electron restart', async ({ electronApp, relaunchApp }) => {
  const created = await electronApp.evaluate(async ({ app }) => {
    const req = process.mainModule.require('module').createRequire(`${app.getAppPath()}/package.json`);
    const vault = req('./src/main/identity/vault');
    const directory = req('path').join(app.getPath('userData'), 'journal-vault-fixture');
    await vault.importVault(directory, 'fixture-password', 'test test test test test test test test test test test junk');
    await vault.unlockVault(directory, 'fixture-password', 0);
    const session = req('./src/main/wallet/privacy-session').openPrivacySession();
    const handle = session.getContext({ kind: 'public-address', principal: `0x${'a'.repeat(40)}`, chainId: 11155111, role: 'transaction-rpc' });
    const journal = req('./src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(handle);
    const hash = `0x${'b'.repeat(64)}`;
    await journal.begin(hash, 4);
    const profile = req('./src/main/profile-resolver').getActiveProfile();
    const fs = req('fs');
    const journalDir = req('path').join(profile.userDataDir, 'wallet-private-submissions');
    const encrypted = fs.readFileSync(req('path').join(journalDir, fs.readdirSync(journalDir)[0]), 'utf8');
    vault.lockVault();
    const locked = await journal.list().then(() => null, (error) => error.code);
    return { hash, locked, ciphertextContainsHash: encrypted.includes(hash), packaged: app.isPackaged, appPath: app.getAppPath() };
  });
  expect(created.locked).toBe('PRIVACY_CONTEXT_REVOKED');
  expect(created.ciphertextContainsHash).toBe(false);
  if (created.packaged) expect(created.appPath).toContain('app.asar');
  await electronApp.close();
  const restarted = await relaunchApp();
  const restored = await restarted.evaluate(async ({ app }) => {
    const req = process.mainModule.require('module').createRequire(`${app.getAppPath()}/package.json`);
    const vault = req('./src/main/identity/vault');
    await vault.unlockVault(req('path').join(app.getPath('userData'), 'journal-vault-fixture'), 'fixture-password', 0);
    const handle = req('./src/main/wallet/privacy-session').openPrivacySession().getContext({
      kind: 'public-address', principal: `0x${'a'.repeat(40)}`, chainId: 11155111, role: 'transaction-rpc',
    });
    const journal = req('./src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(handle);
    const records = await journal.list();
    const newSend = await journal.assertCanSubmit().then(() => null, (error) => error.code);
    vault.lockVault();
    return { records, newSend };
  });
  expect(restored.records).toEqual([expect.objectContaining({ hash: created.hash, nonce: 4, state: 'attempted' })]);
  expect(restored.newSend).toBe('PRIVATE_SUBMISSION_UNRESOLVED');
});
