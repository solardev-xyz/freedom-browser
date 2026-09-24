// Run from the repo root: node <this script> <output-dir> [offline-source-index]
// Production quorum + real Colibri WASM. Only the selected source's transport
// failure is injected; all other responses are live. No user profile is opened.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyCheckpoint } = require('../../../../src/main/myotis/checkpoint-verifier-worker');
const { networkFor } = require('../../../../src/main/myotis/checkpoint-verifier');
const out = path.resolve(process.argv[2]);
const offline = process.argv[3] === undefined ? null : Number(process.argv[3]);
const config = networkFor(100);
if (offline !== null && ![0, 1, 2].includes(offline)) throw new Error('Invalid source index');
fs.mkdirSync(out, { recursive: true });
const started = Date.now();
const responses = {};
const diagnostics = [];
let proof;
const timer = setTimeout(() => {
  console.error('Capture deadline exceeded');
  process.exit(1);
}, 90000);
verifyCheckpoint(100, {
  onDiagnostic: (value) => diagnostics.push(value),
  fetch: async (url, options) => {
    if (offline !== null && new URL(url).origin === config.sources[offline]) {
      throw new Error('Injected provider outage');
    }
    const response = await fetch(url, options);
    if (url === config.prover) proof = Buffer.from(await response.clone().arrayBuffer());
    else responses[url] = { status: response.status, body: await response.clone().text() };
    return response;
  },
})
  .then((checkpoint) => {
    fs.writeFileSync(path.join(out, 'proof.ssz'), proof);
    fs.writeFileSync(path.join(out, 'responses.json'), JSON.stringify(responses, null, 2) + '\n');
    fs.writeFileSync(
      path.join(out, 'verified-checkpoint.json'),
      JSON.stringify(checkpoint, null, 2) + '\n'
    );
    const result = {
      startedAt: new Date(started).toISOString(),
      elapsedMs: Date.now() - started,
      offline: offline === null ? null : config.sources[offline],
      checkpoint,
      diagnostics,
      proofSha256: crypto.createHash('sha256').update(proof).digest('hex'),
    };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  })
  .catch((error) => {
    const result = {
      startedAt: new Date(started).toISOString(),
      elapsedMs: Date.now() - started,
      offline,
      code: error.code,
      diagnostics,
    };
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify(result, null, 2) + '\n');
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(timer));
