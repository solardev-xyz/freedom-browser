// Research harness for the pinned Colibri 2.0.6 package; no application integration.
require('node:assert/strict').equal(
  require(
    require('node:path').resolve(
      __dirname,
      '../../../../node_modules/@corpus-core/colibri-stateless/package.json'
    )
  ).version,
  '2.0.6'
);
const fs = require('node:fs');
process.env.C4_DISABLE_NATIVE = '1';
const { default: Colibri, Strategy, decode_proof } = require(
  require('node:path').resolve(__dirname, '../../../../node_modules/@corpus-core/colibri-stateless')
);
const chainId = Number(process.argv[2] || 1);
const mode = process.argv[3] || 'correct';
const base = require('node:path').join(
  process.env.COLIBRI_EVIDENCE_DIR || require('node:path').join(__dirname, 'captures'),
  `${chainId}-true-latest`
);
const captured = JSON.parse(fs.readFileSync(`${base}/result.json`));
const proof = fs.readFileSync(`${base}/response-0.bin`);
const rootIndex = captured.requests.findIndex((r) => r.method === 'GET' && r.status === 200);
const rootResponse = fs.readFileSync(`${base}/response-${rootIndex}.bin`);
const store = new Map();
const evidence = { chainId, mode, date: new Date().toISOString(), requests: [], results: [] };
const realNow = Date.now;
const clockOffset = 28 * 24 * 3600 * 1000;
const capturedNow = Date.parse(captured.started) + 2000;
Date.now = () => capturedNow;
evidence.simulatedColdTime = new Date(capturedNow).toISOString();
const client = new Colibri({
  chainId,
  zk_proof: true,
  proofStrategy: Strategy.VerifiedOnly,
  max_latest_age_seconds: 60,
  privacy_mode: 'basic',
  checkpoint_witness_keys: mode === 'missing-witness' ? '0x' + '00'.repeat(20) : undefined,
  fetch: async (url) => {
    evidence.requests.push(String(url));
    if (mode === 'unavailable') throw new Error('synthetic offline witness');
    if (!String(url).endsWith(new URL(captured.requests[rootIndex].url).pathname))
      throw new Error('unexpected synthetic request');
    const body =
      mode === 'wrong-root'
        ? JSON.stringify({ data: { root: '0x' + '00'.repeat(32) } })
        : rootResponse;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
});
async function check(label) {
  try {
    const value = await client.verifyProof(
      'eth_getBlockByNumber',
      [mode === 'finalized-tag' ? 'finalized' : 'latest', false],
      proof
    );
    evidence.results.push({
      label,
      ok: true,
      number: value.number,
      hash: value.hash,
      timestamp: value.timestamp,
    });
  } catch (e) {
    evidence.results.push({ label, ok: false, error: e.message });
  }
}
(async () => {
  await Colibri.register_storage({
    get: (k) => store.get(k) || null,
    set: (k, v) => store.set(k, Buffer.from(v)),
    del: (k) => store.delete(k),
  });
  await check('cold');
  if (mode === 'correct') {
    Date.now = () => capturedNow + clockOffset;
    await check('same proof 28 days later, warm verifier');
    Date.now = realNow;
  }
  evidence.storageKeys = [...store.keys()];
  client.destroy();
  const assert = require('node:assert/strict');
  assert.equal(evidence.results[0].ok, ['correct', 'finalized-tag', 'beacon-root'].includes(mode));
  if (mode === 'correct') {
    assert.equal(evidence.results[1].ok, false);
    assert.match(evidence.results[1].error, /proof for latest too old/);
  }
  if (mode === 'beacon-root') {
    // Decode only after verifying these exact proof bytes above.
    const decoded = await decode_proof(proof);
    const header = decoded.proof.header;
    assert.equal(decoded.proof.executionPayload.blockNumber, evidence.results[0].number);
    const uint64 = (value) => {
      const chunk = Buffer.alloc(32);
      chunk.writeBigUInt64LE(BigInt(value));
      return chunk;
    };
    const rootBytes = (value) => {
      assert.match(value, /^0x[0-9a-f]{64}$/i);
      return Buffer.from(value.slice(2), 'hex');
    };
    let chunks = [
      uint64(header.slot),
      uint64(header.proposerIndex),
      rootBytes(header.parentRoot),
      rootBytes(header.stateRoot),
      rootBytes(header.bodyRoot),
      Buffer.alloc(32),
      Buffer.alloc(32),
      Buffer.alloc(32),
    ];
    while (chunks.length > 1) {
      const parents = [];
      for (let i = 0; i < chunks.length; i += 2)
        parents.push(
          require('node:crypto')
            .createHash('sha256')
            .update(chunks[i])
            .update(chunks[i + 1])
            .digest()
        );
      chunks = parents;
    }
    const root = '0x' + chunks[0].toString('hex');
    const expected =
      chainId === 1
        ? '0xb517521829f9ff8b87164d729a6edf3f085249d3caa391c00d7ba9e957bf6fb4'
        : '0xb8364e5605c762de74934750437e8c2db3ef5386dffd891ef1b6104ad940c3de';
    assert.equal(root, expected);
    evidence.beaconHeader = { slot: Number(BigInt(header.slot)), root };
  }
  const output = require('node:path').join(
    require('node:os').tmpdir(),
    `colibri-replay-${chainId}-${mode}.json`
  );
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
