/** Guarded retained public quote/fee job. No producer, private keys or signing. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const data = require('./railgun-relay-wire-composition');
const parser = require('./railgun-relay-wire/policy');
const inputs = require('./railgun-relay-wire/inputs');
const { verifyRetainedQuote } = require('./railgun-relay-retained-quote');
function checkedModule(filename, digest) {
  assert.ok(path.isAbsolute(filename) && fs.realpathSync(filename) === filename);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const bytes = fs.readFileSync(filename);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), digest);
  assert.equal(require.cache[require.resolve(filename)], undefined);
  return require(filename);
}
async function loadContext(input) {
  const manifest = inputs.verifyBuild(input.wireBuild, input.wireBuildSha256);
  const upstream = checkedModule(
    path.join(input.wireBuild, 'upstream.cjs'),
    manifest.outputs['upstream.cjs'].sha256
  );
  const gas = checkedModule(input.gasBundle, input.gasBundleSha256);
  assert.deepEqual(
    Object.keys(gas).sort(),
    [
      'EVMGasType',
      'calculateBroadcasterFeeERC20Amount',
      'calculateGasLimit',
      'calculateGasPrice',
      'calculateMaximumGas',
    ].sort()
  );
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const poseidonModule = require(
    path.join(archive, 'node_modules/@railgun-community/engine/dist/utils/poseidon')
  );
  await poseidonModule.initPoseidonPromise;
  const engineManifest = require('../../src/main/wallet/railgun-engine-manifest.json');
  return {
    upstream,
    gas,
    poseidon: poseidonModule.poseidon,
    engineArchiveIdentity: Object.freeze({
      sha256: engineManifest.sha256,
      bytes: engineManifest.size,
    }),
  };
}
let attempted = false;
async function run(text, { request, signal, guardReport }) {
  assert.equal(attempted, false);
  attempted = true;
  // Same existing process-envelope ceiling; never widen it for retained inputs.
  assert.equal(typeof text, 'string');
  assert.ok(Buffer.byteLength(text) <= 65536);
  const input = parser.parseBoundedJson(
    Buffer.from(text),
    { ...data.LIMITS, jsonStringBytes: 40000 },
    65536
  );
  assert.deepEqual(
    Object.keys(input).sort(),
    [
      'archive',
      'gasBundle',
      'gasBundleSha256',
      'publicCaseText',
      'signedQuoteText',
      'wireBuild',
      'wireBuildSha256',
    ].sort()
  );
  assert.equal(typeof input.publicCaseText, 'string');
  assert.equal(typeof input.signedQuoteText, 'string');
  const publicBytes = Buffer.from(input.publicCaseText),
    quoteBytes = Buffer.from(input.signedQuoteText);
  data.readPublicCase(publicBytes);
  parser.parseSignedPacket(quoteBytes, data.POLICY);
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  const context = await loadContext(input);
  active();
  const value = await verifyRetainedQuote(context, publicBytes, quoteBytes, active);
  active();
  // Repeat current source/tool/build verification after awaited crypto work.
  inputs.verifyBuild(input.wireBuild, input.wireBuildSha256);
  const gasBytes = fs.readFileSync(input.gasBundle);
  assert.equal(crypto.createHash('sha256').update(gasBytes).digest('hex'), input.gasBundleSha256);
  require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  const result = JSON.stringify({
    id: 1,
    method: 'result',
    value: {
      ...value,
      wireBuildSha256: input.wireBuildSha256,
      gasBundleSha256: input.gasBundleSha256,
      engineArchiveIdentity: context.engineArchiveIdentity,
      guards,
    },
  });
  assert.ok(Buffer.byteLength(result) <= data.LIMITS.resultBytes);
  assert.deepEqual(JSON.parse(await request(result)), { id: 1, value: null });
}
module.exports = { run };
