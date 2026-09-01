'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkspaceExecutionPolicy, insidePath } = require('./execution-policy');
const { SeatbeltExecutor } = require('./seatbelt-backend');

function validateDestructiveFixtureRoot(fixtureRoot) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const canonical = fs.realpathSync(fixtureRoot);
  if (
    !insidePath(temporaryRoot, canonical) ||
    canonical === temporaryRoot ||
    path.dirname(canonical) !== temporaryRoot ||
    !path.basename(canonical).startsWith('freedom-seatbelt-destructive-')
  ) {
    throw new Error('Refusing macOS destructive qualification outside a validated synthetic root');
  }
  return canonical;
}

const destructiveTest =
  process.platform === 'darwin' &&
  process.env.FREEDOM_SANDBOX_DESTRUCTIVE === '1' &&
  process.env.FREEDOM_REQUIRE_SEATBELT === '1'
    ? test
    : test.skip;

describe('gated destructive macOS Seatbelt qualification', () => {
  destructiveTest('fails closed before the destructive payload and preserves both canaries', async () => {
    const fixtureRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'freedom-seatbelt-destructive-')
    );
    validateDestructiveFixtureRoot(fixtureRoot);
    const workspaceRoot = path.join(fixtureRoot, 'workspace');
    const outsideRoot = path.join(fixtureRoot, 'outside');
    await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
    await fs.promises.mkdir(outsideRoot, { mode: 0o700 });
    const git = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
    if (git.status !== 0) throw new Error(git.stderr || 'git init failed');
    const workspaceCanary = path.join(workspaceRoot, 'workspace-canary');
    const outsideCanary = path.join(outsideRoot, 'outside-canary');
    await fs.promises.writeFile(workspaceCanary, 'workspace');
    await fs.promises.writeFile(outsideCanary, 'outside');

    try {
      const policy = await createWorkspaceExecutionPolicy({ workspaceRoot });
      const receipt = await new SeatbeltExecutor().execute(policy, {
        command: '/bin/rm',
        args: ['-rf', workspaceRoot, outsideRoot],
      });
      expect(receipt).toMatchObject({
        state: 'sandbox_denied',
        error: { code: 'DESCENDANT_CANCELLATION_UNAVAILABLE' },
      });
      await expect(fs.promises.readFile(workspaceCanary, 'utf8')).resolves.toBe('workspace');
      await expect(fs.promises.readFile(outsideCanary, 'utf8')).resolves.toBe('outside');
    } finally {
      validateDestructiveFixtureRoot(fixtureRoot);
      await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

module.exports = { validateDestructiveFixtureRoot };
