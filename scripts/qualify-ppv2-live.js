#!/usr/bin/env node
/** Opt-in, read-only Sepolia qualification. Uses a dedicated bundled Arti
 * process and the wallet's real context/TLS/SOCKS transport. No vault, signer,
 * transaction submission, direct fallback or persistent wallet state.
 * node scripts/qualify-ppv2-live.js [absolute report directory]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { once } = require('events');
const { createHash, randomUUID } = require('crypto');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { createWalletTorTransport } = require('../src/main/networks/wallet-tor-transport');
const {
  CANDIDATE,
  inspectSepoliaDeployment,
} = require('../src/main/wallet/ppv2-sepolia-preflight');
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const RPCS = Object.freeze({
  publicnode: RPC,
  onfinality: 'https://eth-sepolia.api.onfinality.io/public',
  ethpandaops: 'https://rpc.sepolia.ethpandaops.io',
  tenderly: 'https://gateway.tenderly.co/public/sepolia',
  sentio: 'https://sepolia.rpc.sentio.xyz',
});
// Read-only JSON-RPC methods. A transaction receipt is a public read of a
// known hash; no method that submits, signs or simulates a send is admitted.
const READ_METHODS = new Set([
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_call',
  'eth_gasPrice',
  'eth_getLogs',
  'eth_getTransactionReceipt',
]);
function assertReadMethod(method) {
  if (!READ_METHODS.has(method)) throw new Error('Live qualification cannot submit transactions');
}

async function openLiveTransport(output, onProgress = () => {}, source = 'publicnode') {
  if (!Object.hasOwn(RPCS, source)) throw new Error('Unknown qualification RPC');
  const rpcUrl = RPCS[source]; // Explicit selection only; never fall back after a failed request.
  if (!path.isAbsolute(output)) throw new Error('Absolute qualification directory required');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(output, 'arti-'));
  for (const name of ['cache', 'state']) fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
  const platform = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  const binary = path.resolve(
    __dirname,
    '..',
    'arti-bin',
    `${platform}-${process.arch}`,
    process.platform === 'win32' ? 'arti.exe' : 'arti'
  );
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  const binarySha256 = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const config = path.join(directory, 'arti.toml');
  fs.writeFileSync(
    config,
    `[proxy]\nsocks_listen = ${port}\n[storage]\ncache_dir = ${JSON.stringify(path.join(directory, 'cache'))}\nstate_dir = ${JSON.stringify(path.join(directory, 'state'))}\n[logging]\nconsole = "info"\n`,
    { mode: 0o600 }
  );
  const lifetime = new AbortController();
  const child = spawn(binary, ['proxy', '-c', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '',
    stopped = false;
  const append = (chunk) => {
    log = (log + chunk.toString()).slice(-1024 * 1024);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', () => lifetime.abort());
  child.once('exit', () => lifetime.abort());
  const abort = () => lifetime.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const scope = createPrivacyScope({
    profileId: 'public-sepolia-preflight',
    signal: lifetime.signal,
  });
  const handles = new Map();
  const handle = (role) => {
    if (!handles.has(role))
      handles.set(
        role,
        scope.getContext({
          kind: 'service',
          principal: 'public-deployment-probe',
          protocol: 'privacy-pools-v2',
          deployment: 'sepolia',
          chainId: CANDIDATE.chainId,
          role,
        })
      );
    return handles.get(role);
  };
  const endpoint = Object.freeze({ host: '127.0.0.1', port, signal: lifetime.signal });
  const transport = createWalletTorTransport({ getEndpoint: () => endpoint });
  const trace = [];
  async function close() {
    if (stopped) return;
    stopped = true;
    transport.close();
    scope.close();
    lifetime.abort();
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    } finally {
      clearTimeout(force);
      fs.writeFileSync(path.join(directory, 'arti.log'), log, { mode: 0o600 });
    }
  }
  const started = Date.now();
  try {
    while (
      !/Bootstrapped 100%|100%: ready|Sufficiently bootstrapped; proxy now functional/i.test(log)
    ) {
      if (lifetime.signal.aborted || Date.now() - started > 180000)
        throw new Error('Arti bootstrap unavailable');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const bootstrapMs = Date.now() - started;
    onProgress(`Tor ready in ${bootstrapMs} ms`);
    async function json(role, url, body, label) {
      const started = Date.now();
      let status;
      try {
        const response = await transport.request(handle(role), url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          timeoutMs: 45000,
        });
        status = response.status;
        // The staging relayer creates quotes with 201; RPC and GET remain 200.
        if (
          response.status !== 200 &&
          !(role === 'relayer' && body !== undefined && response.status === 201)
        )
          throw new Error('Unexpected HTTP status');
        const value = JSON.parse(response.body.toString('utf8'));
        trace.push({
          role,
          label,
          elapsedMs: Date.now() - started,
          bytes: response.body.length,
          passed: true,
        });
        return value;
      } catch (error) {
        trace.push({
          role,
          label,
          elapsedMs: Date.now() - started,
          passed: false,
          ...(status ? { status } : {}),
          ...(typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
            ? { code: error.code }
            : {}),
        });
        // Remote error objects can contain bodies or URLs; retain only the sanitized trace.
        throw new Error('Bounded Tor request failed', {
          // eslint-disable-next-line preserve-caught-error -- Never retain remote payloads as an error cause.
          cause: { code: trace.at(-1).code || 'REQUEST_FAILED', status },
        });
      }
    }
    function target(role, pathname) {
      if (
        !['asp', 'relayer'].includes(role) ||
        typeof pathname !== 'string' ||
        !pathname.startsWith('/') ||
        pathname.startsWith('//')
      )
        throw new Error('Unsupported service');
      const base = CANDIDATE[role],
        url = new URL(pathname, base);
      if (url.origin !== base || url.hash || url.username || url.password)
        throw new Error('Unsupported service path');
      return url.href;
    }
    return {
      close,
      signal: lifetime.signal,
      trace,
      transport,
      scope,
      endpoint,
      metadata: {
        version,
        binarySha256,
        bootstrapMs,
        rpc: rpcUrl,
        transport: 'wallet HTTP/TLS over dedicated bundled Arti',
        circuitIsolation: 'not independently observed in this run',
      },
      async rpc(method, params) {
        assertReadMethod(method);
        const id = randomUUID();
        const data = await json(
          'protocol-rpc',
          rpcUrl,
          { jsonrpc: '2.0', id, method, params },
          method
        );
        if (
          data?.id !== id ||
          data.jsonrpc !== '2.0' ||
          Object.hasOwn(data, 'error') ||
          !Object.hasOwn(data, 'result')
        )
          throw new Error('Invalid RPC response');
        return data.result;
      },
      getJson: (role, pathname) =>
        json(role, target(role, pathname), undefined, pathname.split('?')[0]),
      postJson: (role, pathname, body) => {
        if (role !== 'relayer' || pathname !== '/v1/quote/evm/11155111/receive')
          throw new Error('Live qualification cannot relay transactions');
        return json(role, target(role, pathname), body, pathname);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  const output = path.resolve(
    process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ppv2-live-'))
  );
  let client;
  try {
    client = await openLiveTransport(output, console.log, process.argv[3] || 'publicnode');
    const report = await inspectSepoliaDeployment({
      ...client,
      onStep: (name) => console.log(`Checking ${name}`),
    });
    fs.writeFileSync(
      path.join(output, 'preflight.json'),
      JSON.stringify({ ...report, transport: client.metadata, requests: client.trace }, null, 2) +
        '\n'
    );
    console.log(
      JSON.stringify({
        output,
        consistent: report.observationsConsistent,
        failures: report.checks.filter((c) => !c.passed),
        quote: report.quote,
      })
    );
    if (!report.observationsConsistent) process.exitCode = 1;
  } finally {
    await client?.close();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error('Read-only qualification failed');
    process.exitCode = 1;
  });
module.exports = { openLiveTransport, assertReadMethod };
