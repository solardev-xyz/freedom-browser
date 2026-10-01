/** Internal utility-process bootstrap. Receives no vault or renderer authority.
 * These tripwires stop accidental network/process use by reviewed prover code;
 * they are not a sandbox against malicious native code or arbitrary file IO.
 */
const { syncBuiltinESMExports } = require('module');
const threads = require('worker_threads');
for (const key of Object.keys(process.env)) delete process.env[key];
const refuse = () => {
  throw new Error('Private computation capability refused');
};
globalThis.fetch = refuse;
globalThis.WebSocket = class {
  constructor() {
    refuse();
  }
};
for (const name of ['http', 'https']) {
  const module = require(name);
  module.request = refuse;
  module.get = refuse;
}
require('net').Socket.prototype.connect = refuse;
require('net').connect = refuse;
require('net').createConnection = refuse;
require('tls').connect = refuse;
require('http2').connect = refuse;
const dgram = require('dgram');
dgram.createSocket = refuse;
dgram.Socket.prototype.send = refuse;
dgram.Socket.prototype.connect = refuse;
dgram.Socket.prototype.bind = refuse;
const dns = require('dns');
for (const api of [dns, dns.promises]) {
  for (const name of Object.keys(api))
    if (/^(lookup|resolve|reverse)/.test(name)) api[name] = refuse;
  // Resolver methods live on a parent prototype in some Node releases.
  for (const name of [
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCaa',
    'resolveCname',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTlsa',
    'resolveTxt',
    'reverse',
  ]) {
    api.Resolver.prototype[name] = refuse;
  }
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  require('child_process')[name] = refuse;
// Electron APIs exist in the utility process, not in its nested Node workers.
// A source checkout's npm electron shim can mask this distinction.
if (threads.isMainThread) {
  const { net } = require('electron');
  if (net) {
    net.request = refuse;
    net.fetch = refuse;
  }
}
syncBuiltinESMExports();
// snarkjs uses nested Node workers. Ensure each receives the same tripwires
// before its entrypoint runs, without changing its workerData or threading API.
const Worker = threads.Worker;
threads.Worker = class extends Worker {
  constructor(filename, options = {}) {
    super(filename, { ...options, env: {}, execArgv: ['--require', __filename] });
  }
};
syncBuiltinESMExports();

if (threads.isMainThread && process.parentPort) {
  process.parentPort.once('message', async ({ data }) => {
    try {
      const job = require(data.filename);
      const value = await job.run(data.input, {
        progress: () => process.parentPort.postMessage({ type: 'progress', phase: 'proving' }),
      });
      process.parentPort.postMessage({ type: 'result', value });
    } catch {
      process.parentPort.postMessage({ type: 'failure' });
    }
  });
}
