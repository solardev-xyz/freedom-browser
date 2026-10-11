/**
 * Runs CoreClient against the real freedom-cored binary. Skipped unless
 * FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-core/target/debug/freedom-cored npx jest src/main/core
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CoreClient } = require('./core-client');

const binary = process.env.FREEDOM_CORED_PATH;
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };

function client(dataDir, lockDir) {
  return new CoreClient({
    spawn,
    command: binary,
    args: [
      'serve',
      '--data-dir',
      dataDir,
      '--lock-dir',
      lockDir,
      '--parent-pid',
      String(process.pid),
    ],
    log: quietLog,
    shellVersion: 'jest',
  });
}

describeIfBinary('CoreClient with the real freedom-cored', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-core-client-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('handshake, status, shutdown', async () => {
    const core = client(path.join(root, 'identity'), path.join(root, 'locks'));
    const hello = await core.start();
    expect(hello.protocol).toBe(1);
    expect(hello.capabilities).toContain('vault.status');
    await expect(core.request('vault.status')).resolves.toEqual({
      exists: false,
      unlocked: false,
      epoch: null,
      fingerprint: null,
    });
    await expect(core.request('vault.nope')).rejects.toMatchObject({ code: 'unknown_method' });
    await core.stop();
    expect(core.state).toBe('stopped');
  });

  test('a second core on the same identity directory fails without retrying', async () => {
    const first = client(path.join(root, 'identity'), path.join(root, 'locks'));
    await first.start();
    const second = client(path.join(root, 'identity'), path.join(root, 'locks'));
    await expect(second.start()).rejects.toMatchObject({ code: 'core_unavailable' });
    expect(second.state).toBe('failed');
    await first.stop();
  }, 20_000);
});
