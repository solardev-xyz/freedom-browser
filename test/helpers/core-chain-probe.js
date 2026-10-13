/**
 * Whether a freedom-cored binary serves a method: one that doesn't answers
 * it `unknown_method`. Asked once, before a suite, by a child that plays
 * main (the handshake first), so a suite is skipped whole when it doesn't.
 *
 * - `servesChain`: the chain thread (freedom-core design 0005); the pinned
 *   v0.3.0 has none.
 * - `servesDweb`: `dweb.open` (design 0006); the pinned v0.4.0 has none.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scrubbedEnv } = require('../../src/main/core/core-client');

function serves(binary, method, params) {
  if (!binary) return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-core-probe-'));
  const probe = `
    const { spawn } = require('child_process');
    const { encodeFrame, FrameDecoder } = require(process.argv[1]);
    const [binary, root, method, params] = process.argv.slice(2);
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
        if (message?.id === 1) request(2, method, JSON.parse(params));
        if (message?.id === 2) done(message.result !== undefined ? 'yes' : 'no');
      }
    });
    core.on('exit', () => done('no'));
    request(1, 'core.hello', { protocol: 1, shell_version: 'jest', auto_lock_ms: 60000 });
  `;
  try {
    const run = spawnSync(
      process.execPath,
      [
        '-e',
        probe,
        require.resolve('../../src/main/core/frame'),
        binary,
        root,
        method,
        JSON.stringify(params),
      ],
      { env: scrubbedEnv(), timeout: 15_000 }
    );
    return String(run.stdout) === 'yes';
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function servesChain(binary) {
  return serves(binary, 'chain.configure', { chains: [] });
}

function servesDweb(binary) {
  return serves(binary, 'dweb.open', {
    url: `bzz://${'ab'.repeat(32)}/`,
    method: 'GET',
    headers: [],
    backend: { ant: 'bundled', up: true },
    private: false,
    deadline_ms: 10_000,
  });
}

module.exports = { servesChain, servesDweb };
