/**
 * The error Colibri's worker posts for a read while its prover is down
 * (#1059): the real SDK, through colibri-runtime and the worker's own error
 * serializer, in a child process whose fetch answers every request itself
 * with a 503, so nothing leaves the machine. A child because Jest cannot load
 * the WASM runtime. Returns `{ name, message, code }`, revived as the worker
 * host revives it.
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ENS = path.join(__dirname, '..', '..', 'src', 'main', 'ens');

function proverOutageError({
  method = 'eth_getBalance',
  params = ['0x00000000000000000000000000000000000000aa', 'latest'],
} = {}) {
  const child = `
    const runtime = require(${JSON.stringify(path.join(ENS, 'colibri-runtime.js'))});
    const { serializeError } = require(${JSON.stringify(path.join(ENS, 'colibri-worker.js'))});
    globalThis.fetch = async () => new Response('prover down', { status: 503 });
    runtime.Colibri.register_storage({ get: () => null, set() {}, del() {} })
      .then(() => new runtime.Colibri({
        chainId: 1, prover: ['https://prover.invalid'], privacy_mode: 'basic',
        proofStrategy: runtime.Strategy.VerifiedOnly,
      }).request({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }))
      .then(
        () => { console.log('null'); process.exit(0); },
        (err) => { console.log(JSON.stringify(serializeError(err))); process.exit(0); },
      );
  `;
  const serialized = JSON.parse(
    execFileSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 60_000 })
      .trim()
      .split('\n')
      .pop()
  );
  if (!serialized) throw new Error(`${method} answered with the prover down`);
  return Object.assign(new Error(serialized.message), {
    name: serialized.name,
    code: serialized.code,
  });
}

module.exports = { proverOutageError };
