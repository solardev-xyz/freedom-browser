const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { checkBinary } = require('./fetch-tonutils-freedom');

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function probe(port) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'HEAD',
        headers: { Host: 'freedom-proxy-check.invalid' },
        timeout: 1000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 400);
      }
    );
    request.once('error', () => resolve(false));
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

async function waitForListener(port, child, getSpawnError = () => null) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('TON proxy exited before its listener became ready');
    }
    if (await probe(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`TON proxy did not listen on 127.0.0.1:${port} within ${START_TIMEOUT_MS}ms`);
}

function waitForExit(child, timeoutMs = STOP_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('TON proxy did not stop after SIGTERM')),
      timeoutMs
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function main() {
  const binary = checkBinary();
  if (!binary.available) throw new Error('TON proxy binary is missing; run npm run ton:download');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ton-smoke-'));
  const port = await reserveFreePort();
  const child = spawn(binary.path, ['-addr', `127.0.0.1:${port}`, '-verbosity', '0', '-no-http'], {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let spawnError = null;
  child.once('error', (err) => {
    spawnError = err;
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  let failure = null;
  try {
    await waitForListener(port, child, () => spawnError);
    console.log(`TON proxy smoke passed on 127.0.0.1:${port}`);
  } catch (err) {
    if (output.trim()) console.error(output.trim());
    failure = err;
  }

  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  try {
    await waitForExit(child);
  } catch (err) {
    child.kill('SIGKILL');
    await waitForExit(child, 2000).catch(() => {});
    failure ||= err;
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  if (failure) throw failure;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`TON proxy smoke failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, probe, reserveFreePort, waitForExit, waitForListener };
