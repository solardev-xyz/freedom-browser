'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BubblewrapExecutor } = require('./bubblewrap-backend');
const { createWorkspaceExecutionPolicy, insidePath } = require('./execution-policy');

jest.setTimeout(30_000);

function validateDestructiveFixtureRoot(fixtureRoot) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const canonical = fs.realpathSync(fixtureRoot);
  if (
    !insidePath(temporaryRoot, canonical) ||
    canonical === temporaryRoot ||
    path.dirname(canonical) !== temporaryRoot ||
    !path.basename(canonical).startsWith('freedom-sandbox-destructive-')
  ) {
    throw new Error('Refusing destructive qualification outside a validated synthetic root');
  }
  return canonical;
}

const destructiveTest = process.env.FREEDOM_SANDBOX_DESTRUCTIVE === '1' ? test : test.skip;

describe('gated destructive Bubblewrap qualification', () => {
  destructiveTest('contains deletion attempts to the synthetic workspace view', async () => {
    const fixtureRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'freedom-sandbox-destructive-')
    );
    validateDestructiveFixtureRoot(fixtureRoot);
    const workspaceRoot = path.join(fixtureRoot, 'workspace');
    const outsideRoot = path.join(fixtureRoot, 'outside');
    await fs.promises.mkdir(workspaceRoot, { mode: 0o700 });
    await fs.promises.mkdir(outsideRoot, { mode: 0o700 });
    const git = spawnSync('git', ['init', '--quiet', workspaceRoot], { encoding: 'utf8' });
    if (git.status !== 0) throw new Error(git.stderr || 'git init failed');
    await fs.promises.mkdir(path.join(workspaceRoot, 'tree', 'nested'), { recursive: true });
    await fs.promises.writeFile(
      path.join(workspaceRoot, 'tree', 'nested', 'delete-me'),
      'synthetic'
    );
    const outsideCanary = path.join(outsideRoot, 'survive-me');
    await fs.promises.writeFile(outsideCanary, 'outside-canary');

    try {
      const policy = await createWorkspaceExecutionPolicy({
        workspaceRoot,
        limits: { timeoutMs: 10_000, stdoutBytes: 16_384, stderrBytes: 16_384 },
      });
      const executor = new BubblewrapExecutor();
      const capabilities = await executor.detectCapabilities();
      if (!capabilities.available) {
        throw new Error(
          `Bubblewrap destructive qualification unavailable: ${capabilities.denial.code}`
        );
      }
      const receipt = await executor.execute(policy, {
        command: '/bin/sh',
        args: [
          '-c',
          [
            `rm -rf ${JSON.stringify(outsideRoot)}`,
            'rm -rf /workspace/tree',
            'rm -rf /tmp/*',
            "printf 'destructive-fixture-complete'",
          ].join('; '),
        ],
      });

      expect(receipt).toMatchObject({
        state: 'completed',
        stdout: 'destructive-fixture-complete',
      });
      await expect(fs.promises.stat(path.join(workspaceRoot, 'tree'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.promises.readFile(outsideCanary, 'utf8')).resolves.toBe('outside-canary');
      await expect(fs.promises.stat(path.join(workspaceRoot, '.git'))).resolves.toMatchObject({});
    } finally {
      validateDestructiveFixtureRoot(fixtureRoot);
      await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

module.exports = { validateDestructiveFixtureRoot };
