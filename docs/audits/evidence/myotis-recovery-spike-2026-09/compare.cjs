// Compare one actual Myotis finalized observation with an independently verified
// Colibri proof at exactly that execution height. This is evidence, not a read gate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.C4_DISABLE_NATIVE = '1';
const packagePath =
  process.env.COLIBRI_PACKAGE ||
  path.resolve(__dirname, '../../../../node_modules/@corpus-core/colibri-stateless');
assert.equal(require(path.join(packagePath, 'package.json')).version, '2.0.6');
const { default: Colibri, Strategy, decode_proof } = require(packagePath);
const [chainArg, logPath, out] = process.argv.slice(2);
const chainId = Number(chainArg);
assert.ok([1, 100].includes(chainId));
const observed = fs
  .readFileSync(logPath, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((row) => row.event === 'status' && row.state === 'SYNCED' && row.execution)
  .at(-1);
assert.ok(observed, 'No synced execution observation');
assert.equal(observed.chainId, chainId);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(out);
const checkpointOrigin =
  chainId === 1 ? 'https://mainnet.checkpoint.sigp.io' : 'https://checkpoint.gnosischain.com';
const prover =
  chainId === 1 ? 'https://mainnet1.colibri-proof.tech' : 'https://gnosis.colibri-proof.tech';
const evidence = {
  started: new Date().toISOString(),
  chainId,
  observed,
  requests: [],
  outcome: 'pending',
};
const store = new Map();
const client = new Colibri({
  chainId,
  zk_proof: true,
  proofStrategy: Strategy.VerifiedOnly,
  privacy_mode: 'basic',
  checkpointz: [checkpointOrigin],
  beacon_apis: [],
  prover: [],
  fetch: async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, checkpointOrigin);
    assert.equal(options.method || 'GET', 'GET');
    assert.match(url.pathname, /^\/eth\/v1\/beacon\/blocks\/\d+\/root$/);
    const response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    evidence.requests.push({ url: String(url), status: response.status });
    fs.writeFileSync(path.join(out, `checkpoint-${evidence.requests.length}.json`), bytes);
    return new Response(bytes, { status: response.status, headers: response.headers });
  },
});
const timer = setTimeout(() => {
  console.error('Comparison timed out');
  process.exit(2);
}, 90000);
(async () => {
  await Colibri.register_storage({
    get: (k) => store.get(k) || null,
    set: (k, v) => store.set(k, Buffer.from(v)),
    del: (k) => store.delete(k),
  });
  assert.ok(Number.isSafeInteger(observed.execution.number));
  const params = ['0x' + observed.execution.number.toString(16), false];
  const response = await fetch(prover, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'eth_getBlockByNumber',
      params,
      version: 131078,
      zk_proof: true,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, `Prover HTTP ${response.status}`);
  const proof = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(path.join(out, 'proof.ssz'), proof);
  evidence.proofSha256 = crypto.createHash('sha256').update(proof).digest('hex');
  const verified = await client.verifyProof('eth_getBlockByNumber', params, proof);
  const decoded = await decode_proof(proof);
  const header = decoded.proof.header;
  const u64 = (n) => {
    const b = Buffer.alloc(32);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const root = (n) => {
    assert.match(n, /^0x[0-9a-f]{64}$/i);
    return Buffer.from(n.slice(2), 'hex');
  };
  let chunks = [
    u64(header.slot),
    u64(header.proposerIndex),
    root(header.parentRoot),
    root(header.stateRoot),
    root(header.bodyRoot),
    Buffer.alloc(32),
    Buffer.alloc(32),
    Buffer.alloc(32),
  ];
  while (chunks.length > 1) {
    const parents = [];
    for (let i = 0; i < chunks.length; i += 2)
      parents.push(
        crypto
          .createHash('sha256')
          .update(chunks[i])
          .update(chunks[i + 1])
          .digest()
      );
    chunks = parents;
  }
  const beaconRoot = '0x' + chunks[0].toString('hex');
  assert.equal(Number(BigInt(verified.number)), observed.execution.number);
  assert.equal(
    Number(BigInt(decoded.proof.executionPayload.blockNumber)),
    observed.execution.number
  );
  assert.equal(verified.hash, observed.execution.hash);
  assert.equal(verified.stateRoot, observed.execution.stateRoot);
  assert.equal(Number(BigInt(header.slot)), observed.finalizedSlot);
  assert.equal(beaconRoot, observed.finalizedRoot);
  evidence.compared = {
    executionNumber: observed.execution.number,
    executionHash: verified.hash,
    stateRoot: verified.stateRoot,
    beaconSlot: observed.finalizedSlot,
    beaconRoot,
  };
  evidence.outcome = 'matched';
})()
  .catch((error) => {
    evidence.outcome = 'failed';
    evidence.error = error.message;
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(timer);
    client.destroy();
    evidence.finished = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ out, ...evidence }));
  });
