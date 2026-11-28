/**
 * Bee in its dev mode (`bee dev`, `npm run bee-dev:download`): one offline
 * process with mocked postage and chain and a real local store, for the
 * e2e legs that need an upload to succeed and stay (freedom-core design
 * 0015, SWM-7; the SWM-6 to SWM-9 plan's PR 7.7, Codex round 1 on #1395).
 *
 * The bundled antd can't be that node: a light node pushes each upload to
 * a peer as it takes it, reads anything past one chunk from peers, and
 * peers only with full Bee nodes (it serves no pushsync or retrieval of its
 * own), so offline its uploads fail and two of them can't keep each
 * other's. `bee dev` answers an upload with its reference, keeps its
 * chunks, and serves them back (`/bzz`, `/bytes`, `/chunks`); nothing is
 * put in its store but what it is sent.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { freePort, sleep } = require('./antd-node');
const { binaryPath, PINNED_RELEASE_TAG } = require('../../scripts/fetch-bee-dev');

const BEE_DEV = binaryPath();

/**
 * Starts `bee dev` with its API on a free loopback port and buys it one
 * batch (`POST /stamps`: dev mode mocks the chain, so it is usable at
 * once). Resolves `{ origin, port, batch, log, stop() }` once the batch is
 * listed usable. Its config is an empty file and its environment has no
 * `BEE_*` variable, so nothing on the host changes how it runs.
 */
async function startBeeDev({ depth = 20, amount = '100000000000' } = {}) {
  if (!fs.existsSync(BEE_DEV)) {
    throw new Error(
      `Bee ${PINNED_RELEASE_TAG} is missing at ${BEE_DEV}: run npm run bee-dev:download`
    );
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bee-dev-'));
  const config = path.join(dir, 'bee.yaml');
  fs.writeFileSync(config, '');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^BEE_/i.test(name))
  );
  const child = spawn(
    BEE_DEV,
    ['dev', '--config', config, '--api-addr', `127.0.0.1:${port}`, '--verbosity', '2'],
    { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true }
  );
  const node = { child, origin, port, batch: null, log: '' };
  const keep = (chunk) => {
    node.log += String(chunk);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  node.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  const failed = async (why) => {
    await node.stop();
    throw new Error(
      `bee dev did not start (${why}, exit ${child.exitCode}):\n${node.log.slice(-8192)}`
    );
  };
  for (let waited = 0; ; waited += 200) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break;
    } catch {
      // Not yet listening.
    }
    if (waited > 30_000 || child.exitCode !== null) return failed('no /health');
    await sleep(200);
  }
  const bought = await fetch(`${origin}/stamps/${amount}/${depth}`, { method: 'POST' });
  if (!bought.ok) return failed(`POST /stamps answered ${bought.status}`);
  node.batch = (await bought.json()).batchID;
  for (let waited = 0; ; waited += 200) {
    const { stamps = [] } = await (await fetch(`${origin}/stamps`)).json();
    if (stamps.some((s) => s.batchID === node.batch && s.usable)) break;
    if (waited > 30_000) return failed(`batch ${node.batch} never usable`);
    await sleep(200);
  }
  return node;
}

module.exports = { BEE_DEV, startBeeDev };
