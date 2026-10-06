/** Qualification-only PUBLIC seed and quote builder. Never used by production. */
const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const { getAddress } = require('ethers');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { verifyRailgunEngineRuntime } = require('../../src/main/wallet/railgun-engine-runtime');
const { normalizeRailgunRelayQuote } = require('../../src/main/wallet/railgun-relay-quote-data');
const PUBLIC_KEY = '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c';
const MASTER = '2909249313491622489918853075318481888124291927931395517055225584602719351129';
function buildVectors(archive, createdAt) {
  assert.ok(Number.isSafeInteger(createdAt) && createdAt > 0);
  const verified = verifyRailgunEngineRuntime(archive);
  // Pure address codec only. Signature/point verification belongs to the job.
  const { encodeAddress } = require(
    path.join(verified, 'node_modules/@railgun-community/engine/dist/key-derivation/bech32')
  );
  const key = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, 10),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicDer = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  assert.equal(publicDer.toString('hex'), '302a300506032b6570032100' + PUBLIC_KEY);
  const address = (chainId, viewingKey = PUBLIC_KEY) =>
    encodeAddress({
      masterPublicKey: BigInt(MASTER),
      viewingPublicKey: Buffer.from(viewingKey, 'hex'),
      chain: { type: 0, id: chainId },
      version: 1,
    });
  const fields = {
    fees: {
      [pins.wrappedNative]: '0xde0b6b3a7640000',
      '0x1111111111111111111111111111111111111111': '0x1bc16d674ec80000',
    },
    feeExpiration: createdAt + 240000,
    feesID: 'public-native-quote-' + createdAt,
    railgunAddress: address(pins.chainId),
    availableWallets: 2,
    version: '8.0.0',
    relayAdapt: getAddress(pins.relayAdapt),
    requiredPOIListKeys: ['11'.repeat(32)],
    reliability: -1,
  };
  const gas = {
    transactionType: 0,
    gasEstimate: '84',
    gasPrice: '1',
    minGasPrice: '1',
  };
  const sign = (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      data: bytes.toString('hex'),
      signature: crypto.sign(null, bytes, key).toString('hex'),
    };
  };
  const baseline = sign(fields);
  const changedMessage = {
    ...baseline,
    data: Buffer.from(JSON.stringify({ ...fields, feesID: fields.feesID + '-changed' })).toString(
      'hex'
    ),
  };
  const cases = [
    { id: 'accepted', expected: 'accepted', quote: baseline },
    { id: 'signature-mismatch', expected: 'refused', quote: changedMessage },
    {
      id: 'wrong-chain',
      expected: 'refused',
      quote: sign({ ...fields, railgunAddress: address(1) }),
    },
    {
      id: 'identity-key',
      expected: 'refused',
      quote: sign({
        ...fields,
        railgunAddress: address(pins.chainId, '01' + '00'.repeat(31)),
      }),
    },
    {
      id: 'identity-r',
      expected: 'refused',
      quote: {
        ...baseline,
        signature: '01' + '00'.repeat(31) + baseline.signature.slice(64),
      },
    },
  ];
  for (const row of cases) {
    const binding = normalizeRailgunRelayQuote(row.quote, gas);
    assert.equal(binding.feeAmount, '100');
    assert.equal(binding.gasLimit, '100');
    assert.equal(binding.fields.reliability, -1);
    assert.equal(Object.hasOwn(binding.fields, 'identifier'), false);
    assert.equal(Object.keys(binding.fields.fees).length, 2);
  }
  assert.equal(verifyRailgunEngineRuntime(archive), verified);
  return {
    createdAt,
    publicKey: PUBLIC_KEY,
    masterPublicKey: MASTER,
    gas,
    cases,
  };
}
module.exports = { buildVectors, PUBLIC_KEY, MASTER };
