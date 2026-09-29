// Capture public recovery evidence through the production worker. Run from the
// repository root: node docs/audits/evidence/colibri-v3-2026-09/capture.cjs 1 <dir>
// Use a new output directory for every attempt; failed attempts never look like
// an earlier successful capture. No Myotis node or user profile is modified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyCheckpoint } = require('../../../../src/main/myotis/checkpoint-verifier-worker');
const { networkFor } = require('../../../../src/main/myotis/checkpoint-verifier');
const version = require('@corpus-core/colibri-stateless/package.json').version;
assert.equal(version, '3.0.0');
const chainId = Number(process.argv[2]);
const config = networkFor(chainId);
const out = path.resolve(process.argv[3]);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(out);
const responses = {};
let proof;
let proofRequest;
const timer = setTimeout(() => {
  console.error('Capture deadline exceeded');
  process.exit(1);
}, 90000);
verifyCheckpoint(chainId, {
  fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (url === config.prover) {
      assert.equal(response.status, 200);
      proof = Buffer.from(await response.clone().arrayBuffer());
      proofRequest = JSON.parse(options.body);
    } else {
      responses[url] = { status: response.status, body: await response.clone().text() };
    }
    return response;
  },
})
  .then((checkpoint) => {
    fs.writeFileSync(path.join(out, 'proof.ssz'), proof);
    fs.writeFileSync(path.join(out, 'responses.json'), JSON.stringify(responses, null, 2) + '\n');
    fs.writeFileSync(
      path.join(out, 'verified-checkpoint.json'),
      JSON.stringify(
        {
          ...checkpoint,
          colibriVersion: version,
          proofRequest,
          proofSha256: crypto.createHash('sha256').update(proof).digest('hex'),
        },
        null,
        2
      ) + '\n'
    );
    console.log(JSON.stringify({ ok: true, checkpoint, bytes: proof.length }));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(timer));
