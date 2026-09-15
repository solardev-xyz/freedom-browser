// Standalone experiment; does not change Freedom's verification policy.
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
const chainId = Number(process.argv[2]);
const mode = process.argv[3] || 'live';
assert.ok([1, 100].includes(chainId));
assert.ok(['live', 'wrong-root', 'unavailable'].includes(mode));
const out = process.argv[4] || path.join(__dirname, 'runs', `${chainId}-${mode}-${Date.now()}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(out); // Refuse reuse: failed attempts must never leave an older success artifact.
const config =
  chainId === 1
    ? {
        prover: 'https://mainnet1.colibri-proof.tech',
        checkpoint: 'https://mainnet.checkpoint.sigp.io',
        genesis: 1606824023,
        seconds: 12,
      }
    : {
        prover: 'https://gnosis.colibri-proof.tech',
        checkpoint: 'https://checkpoint.gnosischain.com',
        genesis: 1638993340,
        seconds: 5,
      };
const evidence = {
  chainId,
  mode,
  started: new Date().toISOString(),
  colibriVersion: '2.0.6',
  requests: [],
  outcome: 'pending',
};
const save = () =>
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest();
const hex32 = (s) => {
  assert.match(s, /^(0x)?[0-9a-f]{64}$/i);
  return Buffer.from(s.replace(/^0x/i, ''), 'hex');
};
function headerRoot(header) {
  const u64 = (n) => {
    const b = Buffer.alloc(32);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  let chunks = [
    u64(header.slot),
    u64(header.proposerIndex),
    hex32(header.parentRoot),
    hex32(header.stateRoot),
    hex32(header.bodyRoot),
    Buffer.alloc(32),
    Buffer.alloc(32),
    Buffer.alloc(32),
  ];
  while (chunks.length > 1) {
    const next = [];
    for (let i = 0; i < chunks.length; i += 2)
      next.push(hash(Buffer.concat([chunks[i], chunks[i + 1]])));
    chunks = next;
  }
  return '0x' + chunks[0].toString('hex');
}
const storage = new Map();
const client = new Colibri({
  chainId,
  zk_proof: true,
  proofStrategy: Strategy.VerifiedOnly,
  privacy_mode: 'basic',
  max_latest_age_seconds: 60,
  checkpointz: [config.checkpoint],
  beacon_apis: [],
  prover: [],
  fetch: async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, config.checkpoint, 'Unapproved checkpoint source');
    assert.equal(options.method || 'GET', 'GET');
    assert.match(url.pathname, /^\/eth\/v1\/beacon\/blocks\/\d+\/root$/);
    const req = { url: String(url), started: new Date().toISOString() };
    evidence.requests.push(req);
    if (mode === 'unavailable') throw new Error('Synthetic checkpoint unavailability');
    const response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    req.status = response.status;
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(path.join(out, `checkpoint-${evidence.requests.length}.json`), bytes);
    if (response.ok) {
      req.slot = Number(url.pathname.split('/').at(-2));
      req.root = '0x' + hex32(JSON.parse(bytes).data.root).toString('hex');
    }
    save();
    if (mode === 'wrong-root')
      return new Response(JSON.stringify({ data: { root: '0x' + '00'.repeat(32) } }), {
        status: 200,
      });
    return new Response(bytes, { status: response.status, headers: response.headers });
  },
});
const timer = setTimeout(() => {
  evidence.outcome = 'timeout';
  save();
  process.exit(2);
}, 90000);
(async () => {
  await Colibri.register_storage({
    get: (k) => storage.get(k) || null,
    set: (k, v) => storage.set(k, Buffer.from(v)),
    del: (k) => storage.delete(k),
  });
  // Fetch proof bytes directly, then verify exactly those bytes with a cold local verifier.
  const response = await fetch(config.prover, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
      version: 131078,
      zk_proof: true,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, `Prover HTTP ${response.status}`);
  const proof = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(path.join(out, 'proof.ssz'), proof);
  evidence.proofSha256 = hash(proof).toString('hex');
  evidence.prover = config.prover;
  const verified = await client.verifyProof('eth_getBlockByNumber', ['latest', false], proof);
  assert.equal(mode, 'live', 'Negative control unexpectedly verified');
  const decoded = await decode_proof(proof);
  const sync = decoded.sync_data;
  assert.equal(sync.pubkeys.length, 512);
  const header = sync.checkpoint.header;
  assert.ok(
    sync.checkpoint.aggregate_pubkey && sync.checkpoint.proof,
    'Require EthCheckpointProof variant'
  );
  const slot = Number(BigInt(header.slot));
  assert.ok(Number.isSafeInteger(slot));
  const root = headerRoot(header);
  assert.ok(
    evidence.requests.some((r) => r.status === 200 && r.slot === slot && r.root === root),
    'Checkpoint header must match independently fetched root at same slot'
  );
  const ageSeconds = Math.floor(Date.now() / 1000) - (config.genesis + slot * config.seconds);
  assert.ok(
    ageSeconds >= 0 && ageSeconds <= 3600,
    `Checkpoint must be at most one hour old: ${ageSeconds}s`
  );
  // The ordinary block proof does not prove finality. Obtain an explicit finality
  // assertion from the same selected external trust authority and require equality.
  const finalityUrl = config.checkpoint + '/eth/v1/beacon/states/head/finality_checkpoints';
  const finalityResponse = await fetch(finalityUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(finalityResponse.status, 200, 'Finality source unavailable');
  const finality = await finalityResponse.json();
  fs.writeFileSync(path.join(out, 'finality.json'), JSON.stringify(finality, null, 2) + '\n');
  assert.notEqual(finality.execution_optimistic, true);
  assert.equal(
    '0x' + hex32(finality.data.finalized.root).toString('hex'),
    root,
    'Checkpoint does not match explicitly finalized root; obtain a new proof'
  );
  const epochStart = Number(finality.data.finalized.epoch) * (chainId === 1 ? 32 : 16);
  assert.ok(
    Number.isSafeInteger(epochStart) && slot <= epochStart,
    'Checkpoint slot exceeds finalized epoch boundary'
  );
  assert.ok(
    epochStart <= Math.floor((Date.now() / 1000 - config.genesis) / config.seconds),
    'Finalized epoch is in the future'
  );
  const output = {
    chainId,
    network: chainId === 1 ? 'mainnet' : 'gnosis',
    root,
    slot,
    ageSeconds,
    verifiedAt: new Date().toISOString(),
    trustSource: config.checkpoint,
    finalitySource: finalityUrl,
    finalizedEpoch: finality.data.finalized.epoch,
    proofSha256: evidence.proofSha256,
    committeeKeyCount: sync.pubkeys.length,
    proofRequestLatestBlock: { number: verified.number, hash: verified.hash },
    beaconHeader: header,
  };
  fs.writeFileSync(
    path.join(out, 'verified-checkpoint.json'),
    JSON.stringify(output, null, 2) + '\n'
  );
  evidence.checkpoint = output;
  evidence.storageKeys = [...storage.keys()];
  evidence.outcome = 'verified';
})()
  .catch((error) => {
    evidence.outcome = 'rejected';
    evidence.error = error.message;
    // Negative controls only pass if rejection occurred inside verification, after fetching a proof.
    evidence.expectedRejection =
      !!evidence.proofSha256 &&
      evidence.requests.length > 0 &&
      ((mode === 'wrong-root' &&
        /Weak subjectivity check failed: checkpoint mismatch/.test(error.message)) ||
        (mode === 'unavailable' && /Synthetic checkpoint unavailability/.test(error.message)));
    if (!evidence.expectedRejection) process.exitCode = 1;
  })
  .finally(() => {
    evidence.finished = new Date().toISOString();
    save();
    clearTimeout(timer);
    client.destroy();
    console.log(JSON.stringify({ out, ...evidence }));
  });
