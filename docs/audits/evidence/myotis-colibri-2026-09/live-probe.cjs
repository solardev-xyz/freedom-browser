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
const crypto = require('node:crypto');
process.env.C4_DISABLE_NATIVE = '1';
const { default: Colibri, Strategy } = require(
  require('node:path').resolve(__dirname, '../../../../node_modules/@corpus-core/colibri-stateless')
);
const chainId = Number(process.argv[2] || 1);
const zkProof = process.argv[3] !== 'false';
const tag = process.argv[4] || 'finalized';
const out = require('node:path').join(
  process.env.COLIBRI_EVIDENCE_DIR ||
    require('node:path').join(require('node:os').tmpdir(), 'freedom-colibri-research'),
  `${chainId}-${zkProof}-${tag}`
);
fs.mkdirSync(out, { recursive: true });
const evidence = {
  started: new Date().toISOString(),
  chainId,
  zkProof,
  tag,
  runtime: 'WASM, exact installed 2.0.6',
  requests: [],
  results: [],
};
const storage = new Map();
const save = () => fs.writeFileSync(`${out}/result.json`, JSON.stringify(evidence, null, 2));
const timer = setTimeout(() => {
  evidence.timeout = true;
  save();
  process.exit(2);
}, 90000);
const originalFetch = globalThis.fetch;
const client = new Colibri({
  chainId,
  prover: [
    chainId === 1 ? 'https://mainnet1.colibri-proof.tech' : 'https://gnosis.colibri-proof.tech',
  ],
  zk_proof: zkProof,
  proofStrategy: Strategy.VerifiedOnly,
  privacy_mode: 'basic',
  max_latest_age_seconds: 60,
  fetch: async (url, options = {}) => {
    const req = {
      url: String(url),
      method: options.method || 'GET',
      body: options.body,
      started: Date.now(),
    };
    evidence.requests.push(req);
    try {
      const response = await originalFetch(url, { ...options, signal: AbortSignal.timeout(12000) });
      req.status = response.status;
      const bytes = Buffer.from(await response.clone().arrayBuffer());
      req.bytes = bytes.length;
      req.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (response.ok)
        fs.writeFileSync(`${out}/response-${evidence.requests.indexOf(req)}.bin`, bytes);
      return response;
    } catch (e) {
      req.error = e.message;
      throw e;
    } finally {
      req.durationMs = Date.now() - req.started;
      save();
    }
  },
});
(async () => {
  await Colibri.register_storage({
    get: (key) => storage.get(key) || null,
    set: (key, value) => storage.set(key, Buffer.from(value)),
    del: (key) => storage.delete(key),
  });
  for (const method of ['eth_getBlockByNumber', 'eth_getBlockHeader']) {
    const params = method === 'eth_getBlockByNumber' ? [tag, false] : [tag];
    const result = { method, params };
    try {
      result.support = await client.getMethodSupport(method, params);
      result.value = await client.request({ method, params });
    } catch (e) {
      result.error = e.message;
    }
    result.zkAfter = client.config.zk_proof;
    evidence.results.push(result);
    save();
  }
  evidence.storageKeys = [...storage.keys()];
  evidence.finished = new Date().toISOString();
  save();
  clearTimeout(timer);
  client.destroy();
  console.log(
    JSON.stringify({
      out,
      results: evidence.results.map((r) => ({
        method: r.method,
        support: r.support,
        error: r.error,
        number: r.value?.number,
        hash: r.value?.hash,
        keys: r.value && Object.keys(r.value),
        zkAfter: r.zkAfter,
      })),
      requests: evidence.requests.map((r) => ({ url: r.url, status: r.status, error: r.error })),
      storageKeys: evidence.storageKeys,
    })
  );
})().catch((e) => {
  evidence.error = e.stack;
  save();
  console.error(e);
  clearTimeout(timer);
  process.exitCode = 1;
});
