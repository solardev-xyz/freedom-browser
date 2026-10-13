/**
 * Whether a freedom-cored binary runs the chain thread (freedom-core
 * design 0005): one without it answers `chain.configure` unknown_method.
 * Asked once, before a suite, by a child that plays main (the handshake
 * first), so a suite is skipped whole when it doesn't (the pinned v0.3.0
 * has no chain thread). `servesChainHtml` asks the same of `chain.html`
 * (design 0006), which v0.4.0 doesn't serve.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scrubbedEnv } = require('../../src/main/core/core-client');

function servesChain(binary) {
  return probe(binary, 'chain.configure', { chains: [] });
}

function servesChainHtml(binary) {
  return probe(binary, 'chain.html', {
    chain_id: 1,
    contract: `0x${'11'.repeat(20)}`,
    origin: 'web3://probe',
    deadline_ms: 1000,
  });
}

/** Whether `binary` answers `method` with anything but unknown_method. */
function probe(binary, method, params) {
  if (!binary) return false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-chain-probe-'));
  const script = `
    const { spawn } = require('child_process');
    const { encodeFrame, FrameDecoder } = require(process.argv[1]);
    const [binary, root] = process.argv.slice(2, 4);
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
        if (message?.id === 1) request(2, process.argv[4], JSON.parse(process.argv[5]));
        if (message?.id === 2) done(message.error?.code === 'unknown_method' ? 'no' : 'yes');
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
        script,
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

module.exports = { servesChain, servesChainHtml };
