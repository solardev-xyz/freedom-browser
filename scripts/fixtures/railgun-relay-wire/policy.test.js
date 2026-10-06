const assert = require('node:assert/strict');
const {
  parseBoundedJson,
  parseSignedPacket,
  validateCandidateKey,
  validateQuoteFields,
  parseReply,
  validateCommonPlaintext,
} = require('./policy');
const policy = require('./policy.json');
const vectors = require('./vectors.json');
const encode = (value) => Buffer.from(JSON.stringify(value));
const clone = (value) => JSON.parse(JSON.stringify(value));
function check(name, run, refuses = false) {
  test(name, () => {
    if (refuses) assert.throws(run, undefined, name);
    else run();
  });
}
const parse = (text, limits = policy.limits, bound = policy.limits.signedDataBytes) =>
  parseBoundedJson(Buffer.from(text), limits, bound);
check('object arrays literals and valid surrogate pair', () =>
  assert.equal(parse('{"a":[true,null,-2.5e2,"\\uD83D\\uDE00"]}').a[3], '😀')
);
check('null prototype prevents prototype setter', () =>
  assert.equal(Object.getPrototypeOf(parse('{"__proto__":{"x":1}}')), null)
);
for (const [name, text] of [
  ['literal duplicate', '{"a":1,"a":2}'],
  ['escaped duplicate', '{"a":1,"\\u0061":2}'],
  ['nested escaped duplicate', '{"x":{"feesID":1,"fees\\u0049D":2}}'],
  ['prototype duplicate', '{"__proto__":1,"__proto__":2}'],
  ['trailing token', '{} null'],
  ['leading zero', '01'],
  ['trailing comma object', '{"a":1,}'],
  ['trailing comma array', '[1,]'],
  ['unclosed string', '"abc'],
  ['bad string escape', '"\\q"'],
  ['raw newline string', '"a\nb"'],
  ['nonfinite exponent', '1e999'],
  ['unpaired high surrogate', '"\\ud800"'],
  ['unpaired low surrogate', '"\\udc00"'],
  ['BOM', '\ufeff{}'],
])
  check(name, () => parse(text), true);
check('invalid UTF8', () => parseBoundedJson(Uint8Array.of(0xc0, 0xaf), policy.limits, 10), true);
for (const [name, text, extra, cap] of [
  ['bytes', '{}', {}, 1],
  ['depth', '[[[]]]', { jsonDepth: 1 }],
  ['members', '{"a":0,"b":1}', { jsonMembers: 1 }],
  ['values', '[0,1]', { jsonValues: 2 }],
  ['string', '"abc"', { jsonStringBytes: 2 }],
])
  check(`bound ${name}`, () => parse(text, { ...policy.limits, ...extra }, cap), true);
const structurallyFakeAddress = 'STRUCTURAL-ONLY-NO-CRYPTO-ADDRESS';
const quote = {
  fees: { [policy.tokenAddress]: vectors.feePerUnitGas },
  feeExpiration: vectors.nowMs + vectors.quoteRemainingMs,
  feesID: vectors.feesID,
  railgunAddress: structurallyFakeAddress,
  identifier: vectors.identifier,
  availableWallets: vectors.availableWallets,
  version: vectors.version,
  relayAdapt: policy.relayAdapt,
  requiredPOIListKeys: [],
  reliability: vectors.reliability,
};
const context = {
  topic: policy.topic,
  chain: policy.chain,
  deployment: policy.deployment,
  nowMs: vectors.nowMs,
  previousNowMs: vectors.nowMs,
  activePOIListKeys: policy.activePOIListKeys,
};
const decoded = { chain: policy.chain, viewingPublicKey: Uint8Array.from({ length: 32 }, () => 9) };
const expected = { address: structurallyFakeAddress, publicKeyHex: '09'.repeat(32) };
check('structural candidate-key join only', () => validateCandidateKey(quote, decoded, expected));
check(
  'candidate key mismatch',
  () => validateCandidateKey(quote, decoded, { ...expected, publicKeyHex: '08'.repeat(32) }),
  true
);
check(
  'candidate address mismatch',
  () => validateCandidateKey({ ...quote, railgunAddress: 'other' }, decoded, expected),
  true
);
check('scoped quote', () =>
  assert.equal(
    validateQuoteFields(quote, decoded, context, policy).chainBinding,
    'signed-address-chain-plus-local-topic'
  )
);
check('all-chains quote limitation explicit', () =>
  assert.equal(
    validateQuoteFields(quote, {}, context, policy).chainBinding,
    'local-context-only-all-chains-address'
  )
);
check('nonempty required-list coverage', () =>
  validateQuoteFields(
    { ...quote, requiredPOIListKeys: policy.activePOIListKeys },
    decoded,
    context,
    policy
  )
);
check(
  'missing required-list coverage',
  () =>
    validateQuoteFields(
      { ...quote, requiredPOIListKeys: policy.activePOIListKeys },
      decoded,
      { ...context, activePOIListKeys: [] },
      policy
    ),
  true
);
for (const [name, edit] of [
  [
    'unknown field',
    (q) => {
      q.extra = true;
    },
  ],
  [
    'missing field',
    (q) => {
      delete q.feesID;
    },
  ],
  [
    'expiry string',
    (q) => {
      q.feeExpiration = String(q.feeExpiration);
    },
  ],
  [
    'expiry fraction',
    (q) => {
      q.feeExpiration += 0.5;
    },
  ],
  [
    'expiry too soon',
    (q) => {
      q.feeExpiration = vectors.nowMs + policy.quoteMinimumRemainingMs - 1;
    },
  ],
  [
    'expiry too far',
    (q) => {
      q.feeExpiration = vectors.nowMs + policy.quoteMaximumRemainingMs + 1;
    },
  ],
  [
    'no wallets',
    (q) => {
      q.availableWallets = 0;
    },
  ],
  [
    'wallet fraction',
    (q) => {
      q.availableWallets = 1.5;
    },
  ],
  [
    'wallet boolean',
    (q) => {
      q.availableWallets = true;
    },
  ],
  [
    'low reliability',
    (q) => {
      q.reliability = 0.7;
    },
  ],
  [
    'version below',
    (q) => {
      q.version = '7.9.9';
    },
  ],
  [
    'version above',
    (q) => {
      q.version = '9.0.0';
    },
  ],
  [
    'version suffix',
    (q) => {
      q.version = '8.0.0-beta';
    },
  ],
  [
    'wrong relay',
    (q) => {
      q.relayAdapt = policy.deployment;
    },
  ],
  [
    'missing selected token',
    (q) => {
      q.fees = { [policy.deployment]: '0x64' };
    },
  ],
  [
    'zero fee',
    (q) => {
      q.fees[policy.tokenAddress] = '0x0';
    },
  ],
  [
    'overflow fee',
    (q) => {
      q.fees[policy.tokenAddress] = '0x1' + '0'.repeat(64);
    },
  ],
  [
    'decimal fee',
    (q) => {
      q.fees[policy.tokenAddress] = '100';
    },
  ],
  [
    'long identifier',
    (q) => {
      q.identifier = 'x'.repeat(129);
    },
  ],
  [
    'duplicate POI',
    (q) => {
      q.requiredPOIListKeys = [policy.activePOIListKeys[0], policy.activePOIListKeys[0]];
    },
  ],
])
  check(
    `quote ${name}`,
    () => {
      const q = clone(quote);
      edit(q);
      validateQuoteFields(q, decoded, context, policy);
    },
    true
  );
for (const [name, change] of [
  ['topic', { topic: 'other' }],
  ['chain', { chain: { type: 0, id: 1 } }],
  ['deployment', { deployment: policy.tokenAddress }],
  ['clock rollback', { previousNowMs: vectors.nowMs + 1 }],
])
  check(
    `context ${name}`,
    () => validateQuoteFields(quote, decoded, { ...context, ...change }, policy),
    true
  );
check(
  'address different chain',
  () => validateQuoteFields(quote, { chain: { type: 1, id: 11155111 } }, context, policy),
  true
);
const packet = { data: encode(quote).toString('hex'), signature: '00'.repeat(64) };
check('packet exact original bytes', () =>
  assert.equal(
    parseSignedPacket(encode(packet), policy).signedBytes.toString(),
    JSON.stringify(quote)
  )
);
for (const [name, change] of [
  ['odd hex', { data: 'a' }],
  ['prefix data', { data: '0x00' }],
  ['bad hex', { data: 'gg' }],
  ['short signature', { signature: '00' }],
  ['unknown field', { extra: 1 }],
])
  check(`packet ${name}`, () => parseSignedPacket(encode({ ...packet, ...change }), policy), true);
check('reply hash', () =>
  assert.equal(parseReply(encode({ txHash: vectors.responseHash }), policy).kind, 'hash')
);
check('reply error', () =>
  assert.equal(parseReply(encode({ error: vectors.responseError }), policy).kind, 'error')
);
for (const [name, reply] of [
  ['both', { txHash: vectors.responseHash, error: 'x' }],
  ['unknown', { result: vectors.responseHash }],
  ['short hash', { txHash: '0x33' }],
  ['empty error', { error: '' }],
  ['long error', { error: 'x'.repeat(513) }],
  ['array', []],
])
  check(`reply ${name}`, () => parseReply(encode(reply), policy), true);
check(
  'duplicate escaped reply key',
  () => parseReply(Buffer.from('{"error":"x","err\\u006fr":"y"}'), policy),
  true
);
const commonExpected = {
  data: vectors.data,
  publicKeyHex: expected.publicKeyHex,
  minGasPrice: '0',
  feesID: vectors.feesID,
};
const common = {
  transactType: 'COMMON',
  txidVersion: policy.txidVersion,
  to: policy.deployment,
  data: vectors.data,
  broadcasterViewingKey: expected.publicKeyHex,
  chainID: policy.chain.id,
  chainType: policy.chain.type,
  minGasPrice: '0',
  feesID: vectors.feesID,
  useRelayAdapt: false,
  devLog: false,
  minVersion: policy.broadcasterVersion.min,
  maxVersion: policy.broadcasterVersion.max,
  preTransactionPOIsPerTxidLeafPerList: {},
};
check('COMMON structural join', () => validateCommonPlaintext(common, commonExpected, policy));
for (const [name, change] of [
  ['chain type', { chainType: 1 }],
  ['chain id', { chainID: 1 }],
  ['recipient key', { broadcasterViewingKey: '00'.repeat(32) }],
  ['fees ID', { feesID: 'other' }],
  ['gas number', { minGasPrice: 0 }],
  ['data', { data: '0x02' }],
  ['deployment', { to: policy.tokenAddress }],
  ['invented operation id', { operationId: 'invented' }],
])
  check(
    `COMMON ${name}`,
    () => validateCommonPlaintext({ ...common, ...change }, commonExpected, policy),
    true
  );

const { parseRequestEnvelope, validateEncryptedData } = require('./policy');
const raw = { pubkey: '11'.repeat(32), encryptedData: ['0x' + '22'.repeat(32), '0x33'] };
const bytes = (value) => Buffer.from(JSON.stringify(value));
const run = (name, work, refuses = true) =>
  test(name, () => {
    if (refuses) assert.throws(work);
    else work();
  });
run(
  'shape only synthetic envelope',
  () => assert.equal(parseRequestEnvelope(bytes(raw), policy).pubkey, raw.pubkey),
  false
);
for (const [name, value] of [
  ['wrong ephemeral length', { ...raw, pubkey: '11' }],
  ['extra request field', { ...raw, id: 1 }],
  ['missing request field', { encryptedData: raw.encryptedData }],
  ['odd ciphertext', { ...raw, encryptedData: [raw.encryptedData[0], '0x1'] }],
  ['truncated IV-tag', { ...raw, encryptedData: ['0x22', '0x33'] }],
  ['extra tuple item', { ...raw, encryptedData: [...raw.encryptedData, '0x44'] }],
])
  run(name, () => parseRequestEnvelope(bytes(value), policy));
run('ciphertext bound', () =>
  validateEncryptedData([raw.encryptedData[0], '0x' + '33'.repeat(3)], 2)
);
run('escaped duplicate encryptedData', () =>
  parseRequestEnvelope(
    Buffer.from('{"pubkey":"' + raw.pubkey + '","encryptedData":[],"encryptedD\\u0061ta":[]}'),
    policy
  )
);
