/** Public-vector AES authentication semantics in the actual Electron bootstrap. */
const assert = require('assert/strict'),
  path = require('path'),
  { createRequire } = require('module');
async function run(_input, { request, guardReport }) {
  const fixture = path.join(__dirname, 'railgun-engine');
  const inventory = require('../railgun-fixture-integrity').assertRailgunFixture(
    path.join(fixture, 'node_modules')
  );
  const r = createRequire(path.join(fixture, 'package.json')),
    root = path.dirname(r.resolve('@railgun-community/engine'));
  const { AES } = require(path.join(root, 'utils/encryption/aes'));
  const key = Buffer.alloc(32, 17),
    plaintext = '22'.repeat(32);
  const encrypted = AES.encryptGCM([plaintext], key);
  assert.deepEqual(AES.decryptGCM(encrypted, key), [plaintext]);
  let authentication;
  try {
    AES.decryptGCM({ ...encrypted, tag: '33'.repeat(16) }, key);
  } catch (error) {
    authentication = { message: error.message, cause: error.cause?.message };
  }
  assert.deepEqual(authentication, {
    message: 'Unable to decrypt ciphertext.',
    cause: 'Unsupported state or unable to authenticate data',
  });
  key.fill(0);
  assert.equal(guardReport().attempts, 0);
  const reply = JSON.parse(
    await request(
      JSON.stringify({
        id: 1,
        method: 'result',
        value: {
          inventory: inventory.sha256,
          authentication,
          guards: guardReport(),
          electron: process.versions.electron,
        },
      })
    )
  );
  assert.deepEqual(reply, { id: 1, value: null });
}
module.exports = { run };
