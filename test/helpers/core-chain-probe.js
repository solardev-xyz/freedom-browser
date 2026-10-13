/**
 * Whether a freedom-cored binary runs the chain thread (freedom-core
 * design 0005): one without it answers `chain.configure` unknown_method.
 * Asked once, before a suite, by a child that plays main (the handshake
 * first), so a suite is skipped whole when it doesn't (the pinned v0.3.0
 * has no chain thread).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scrubbedEnv } = require('../../src/main/core/core-client');

function servesChain(binary) {
  if (!binary) return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-chain-probe-'));
  const probe = `
    const { spawn } = require('child_process');
    const { encodeFrame, FrameDecoder } = require(process.argv[1]);
    const [binary, root] = process.argv.slice(2);
    const core = spawn(binary, ['serve', '--data-dir', root + '/identity', '--lock-dir', root + '/locks'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const request = (id, method, params) =>
      core.stdin.write(encodeFrame({ type: 'request', id, method, params, context: { caller: 'shell' } }));
    const decoder = new FrameDecoder();
    const done = (answer) => {
      process.stdout.write(answer);
      core.kill('SIGKILL');
      process.exit(0);
    };
    core.stdout.on('data', (chunk) => {
      for (const { message } of decoder.push(chunk)) {
        if (message?.id === 1) request(2, 'chain.configure', { chains: [] });
        if (message?.id === 2) done(message.result !== undefined ? 'yes' : 'no');
      }
    });
    core.on('exit', () => done('no'));
    request(1, 'core.hello', { protocol: 1, shell_version: 'jest', auto_lock_ms: 60000 });
  `;
  try {
    const run = spawnSync(
      process.execPath,
      ['-e', probe, require.resolve('../../src/main/core/frame'), binary, root],
      { env: scrubbedEnv(), timeout: 15_000 }
    );
    return String(run.stdout) === 'yes';
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { servesChain };
