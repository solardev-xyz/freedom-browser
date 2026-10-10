#!/usr/bin/env node
/** Opt-in live-network qualification using synthetic labels and the shipped
 * Arti binary. No wallet, account address, keys, or user profile is loaded.
 * Run: node scripts/qualify-wallet-tor.js [absolute output directory]
 * Each connection is new; only the SOCKS isolation token is reused.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const tls = require('tls');
const { spawn, execFileSync } = require('child_process');
const { once } = require('events');
const { stripVTControlCharacters } = require('util');
const { createHash, randomBytes } = require('crypto');
const { connectIsolatedSocks } = require('../src/main/networks/isolated-socks');

async function main() {
  const output =
    process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-tor-qualification-'));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const name of ['cache', 'state'])
    fs.mkdirSync(path.join(output, name), { recursive: true, mode: 0o700 });
  const platform = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
  const binary = path.resolve(
    __dirname,
    '..',
    'arti-bin',
    `${platform}-${process.arch}`,
    process.platform === 'win32' ? 'arti.exe' : 'arti'
  );
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  const sha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const config = path.join(output, 'arti.toml');
  fs.writeFileSync(
    config,
    `[proxy]\nsocks_listen = ${port}\n[storage]\ncache_dir = ${JSON.stringify(path.join(output, 'cache'))}\nstate_dir = ${JSON.stringify(path.join(output, 'state'))}\n[logging]\nconsole = "info,arti_client::client=debug"\n`
  );
  const lifetime = new AbortController();
  const child = spawn(binary, ['proxy', '-c', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const started = Date.now();
  const report = {
    version,
    sha256,
    platform: process.platform,
    arch: process.arch,
    startedAt: new Date().toISOString(),
    target: 'example.com:443',
    requests: [],
    qualified: false,
  };
  const append = (chunk) => {
    log += stripVTControlCharacters(chunk.toString());
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', () => lifetime.abort());
  child.once('exit', () => lifetime.abort());
  const stop = () => lifetime.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (
      !/Bootstrapped 100%|100%: ready|Sufficiently bootstrapped; proxy now functional/i.test(log)
    ) {
      if (lifetime.signal.aborted || Date.now() - started > 180000)
        throw new Error('Arti bootstrap failed or timed out');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    report.bootstrapMs = Date.now() - started;
    console.log(`Arti ready after ${report.bootstrapMs} ms; opening fresh A/B connections`);
    const tokens = { A: randomBytes(32).toString('hex'), B: randomBytes(32).toString('hex') };
    for (const label of ['A', 'A', 'B', 'B', 'A', 'B']) {
      const offset = log.length;
      const requestStart = Date.now();
      const deadline = AbortSignal.timeout(45000);
      const signal = AbortSignal.any([lifetime.signal, deadline]);
      const socket = await connectIsolatedSocks({
        endpoint: { host: '127.0.0.1', port, signal: lifetime.signal },
        hostname: 'example.com',
        port: 443,
        token: tokens[label],
        signal,
        timeoutMs: 45000,
      });
      const status = await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: 'example.com', rejectUnauthorized: true });
        const abort = () => secure.destroy(new Error('Probe cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        secure.once('close', () => signal.removeEventListener('abort', abort));
        secure.once('secureConnect', () =>
          secure.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n')
        );
        let data = '';
        secure.on('data', (chunk) => {
          data += chunk.toString();
          if (data.includes('\r\n')) {
            const match = /^HTTP\/1\.[01] (\d{3}) /.exec(data);
            secure.destroy();
            if (match) resolve(Number(match[1]));
            else reject(new Error('Invalid HTTP response'));
          }
        });
        secure.once('error', reject);
        secure.once('end', () => reject(new Error('Ended before HTTP status')));
        if (signal.aborted) abort();
        socket.resume();
      });
      // The SOCKS success arrives only after the matching circuit event, but
      // allow the child stdout pipe to drain before assigning its identifier.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const events = circuitIds(log.slice(offset));
      if (events.length !== 1)
        throw new Error(`Expected one circuit event for ${label}, observed ${events.length}`);
      const sample = { label, tunnelId: events[0], status, elapsedMs: Date.now() - requestStart };
      report.requests.push(sample);
      console.log(JSON.stringify(sample));
    }
    const a = new Set(report.requests.filter((r) => r.label === 'A').map((r) => r.tunnelId));
    const b = new Set(report.requests.filter((r) => r.label === 'B').map((r) => r.tunnelId));
    report.crossContextOverlap = [...a].filter((id) => b.has(id));
    report.sameContextReuse = { A: a.size < 3, B: b.size < 3 };
    if (report.crossContextOverlap.length)
      throw new Error('Different isolation tokens shared a circuit');
    if (!report.sameContextReuse.A || !report.sameContextReuse.B)
      throw new Error('Same-context circuit reuse was not observed');
    report.qualified = true;
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    lifetime.abort();
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    force.unref();
    if (child.exitCode === null && child.signalCode === null)
      await once(child, 'exit').catch(() => {});
    clearTimeout(force);
    fs.writeFileSync(path.join(output, 'arti.log'), log, { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`Qualification report: ${path.join(output, 'report.json')}`);
  }
}

function circuitIds(log) {
  return [...log.matchAll(/Got a circuit for [^\n]*tunnel_id=(Circ [0-9]+\.[0-9]+)/g)].map(
    (match) => match[1]
  );
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { circuitIds };
