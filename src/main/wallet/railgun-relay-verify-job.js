/** Fixed independent keyless verification entrypoint. No wallet, key request,
 * private witness or signing interface is available in this job. */
const assert = require('assert/strict');
const path = require('path');
const { shape } = require('./railgun-relay-quote-data');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const { createRailgunRelayVerifyRecordReader } = require('./railgun-relay-record-stream');
let attempted = false;
exports.run = async (inputText, { request, signal, guardReport }) => {
  assert.equal(attempted, false);
  attempted = true;
  assert.ok(typeof inputText === 'string' && Buffer.byteLength(inputText) <= 65536);
  const input = JSON.parse(inputText);
  shape(input, ['archive', 'proverArchive', 'artifactDirectory', 'identityText', 'recordStream']);
  for (const key of ['archive', 'proverArchive', 'artifactDirectory'])
    assert.ok(typeof input[key] === 'string' && path.isAbsolute(input[key]));
  for (const key of ['archive', 'proverArchive']) assert.equal(path.extname(input[key]), '.asar');
  assert.ok(typeof input.identityText === 'string' && Buffer.byteLength(input.identityText) <= 512);
  const identity = JSON.parse(input.identityText);
  assert.equal(JSON.stringify(identity), input.identityText);
  shape(identity, ['walletId', 'spendingPublicKey']);
  assert.match(identity.walletId, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(identity.spendingPublicKey) && identity.spendingPublicKey.length === 2);
  for (const value of identity.spendingPublicKey) assert.match(value, /^[0-9a-f]{64}$/);
  const active = () => assertRailgunRelaySignal(signal);
  active();
  let sequence = 0;
  const exchange = async (message) => {
    active();
    const id = ++sequence,
      wire = JSON.stringify({ id, ...message });
    assert.ok(Buffer.byteLength(wire) < 65536);
    const reply = await request(wire);
    active();
    assert.ok(typeof reply === 'string' && Buffer.byteLength(reply) < 65536);
    const response = JSON.parse(reply);
    shape(response, ['id', 'value']);
    assert.equal(response.id, id);
    return response.value;
  };
  const recordText = await createRailgunRelayVerifyRecordReader({
    manifest: input.recordStream,
    request: exchange,
    signal,
  }).read();
  active();
  const result = await require('./railgun-relay-proof-verifier').verifyRailgunRelayProofs({
    archive: input.archive,
    proverArchive: input.proverArchive,
    artifactDirectory: input.artifactDirectory,
    identityText: input.identityText,
    recordText,
    signal,
  });
  active();
  shape(result, [
    'engineSha256',
    'proverSha256',
    'artifactVkeys',
    'recordDigest',
    'draftDigest',
    'historyDigest',
    'expectedHash',
    'transactionDigest',
    'payloadDigest',
    'transactionVerified',
    'prePoiVerified',
    'historicalEventSignatureVerified',
    'historicalMembershipPathVerified',
    'inputOwnershipVerified',
    'currentMembershipVerified',
    'authorityGranted',
  ]);
  for (const key of [
    'transactionVerified',
    'prePoiVerified',
    'historicalEventSignatureVerified',
    'historicalMembershipPathVerified',
  ])
    assert.equal(result[key], true);
  for (const key of ['inputOwnershipVerified', 'currentMembershipVerified', 'authorityGranted'])
    assert.equal(result[key], false);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.equal(await exchange({ method: 'result', value: { ...result, guards } }), null);
  active();
};
