const {
  LIMITS,
  POLICY,
  LIST,
  readPublicCase,
  selectRelayWireInput,
  assertSelectionCurrent,
  prePoiMap,
  publicCaseFromCommon,
  assertCaseUnchanged,
} = require('./railgun-relay-wire-composition');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const bytes = (v) => Buffer.from(JSON.stringify(v));
const copy = (v) => JSON.parse(JSON.stringify(v));
const field = (n) => n.toString(16).padStart(64, '0');
const now = 1791230400000;
const leaf = field(99);
const recipient = {
  address: '0zk1' + 'q'.repeat(123),
  viewingPublicKey: '0a'.repeat(32),
  masterPublicKey: '23',
};
// Public structural placeholders only: no valid signature, calldata or proof is
// claimed by this pure test suite. Actual crypto belongs to the later campaign.
const quote = () => ({
  fees: { [pins.wrappedNative]: '0x' + (10n ** 18n).toString(16) },
  feeExpiration: now + LIMITS.quoteLifetimeMs,
  feesID: 'PUBLIC-PROOF-WIRE-1',
  railgunAddress: recipient.address,
  identifier: 'PUBLIC FIXTURE ONLY',
  availableWallets: 1,
  version: '8.0.0',
  relayAdapt: pins.relayAdapt,
  requiredPOIListKeys: [LIST],
  reliability: 0.95,
});
const packet = (q = quote()) =>
  bytes({ data: bytes(q).toString('hex'), signature: '01'.repeat(64) });
const select = () => selectRelayWireInput(packet(), recipient, now, '100');
const publicCase = () => ({
  domain: 'public-fixture-relay-pre-poi-v1',
  minGasPrice: 1,
  transaction: { chainId: pins.chainId, to: pins.proxy, value: '0', data: '0x01020304' },
  poi: {
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    txidMerkleroot: '0x' + field(21),
    poiMerkleroots: ['0x' + field(22)],
    blindedCommitmentsOut: ['0x' + field(23), '0x' + field(24)],
    railgunTxidIfHasUnshield: '0x00',
  },
});
const common = () => ({
  transactType: 'COMMON',
  txidVersion: 'V2_PoseidonMerkle',
  to: pins.proxy,
  data: publicCase().transaction.data,
  broadcasterViewingKey: recipient.viewingPublicKey,
  chainID: pins.chainId,
  chainType: 0,
  minGasPrice: '1',
  feesID: quote().feesID,
  useRelayAdapt: false,
  devLog: false,
  minVersion: '8.0.0',
  maxVersion: '8.999.0',
  preTransactionPOIsPerTxidLeafPerList: prePoiMap(bytes(publicCase()), leaf),
});

test('selection retains exact signed bytes and absolute expiry, detached before producer', () => {
  const q = quote(),
    r = { ...recipient },
    input = packet(q);
  const result = selectRelayWireInput(input, r, now, '100');
  const before = copy(result);
  input.fill(0);
  q.feeExpiration++;
  r.masterPublicKey = '24';
  expect(copy(result)).toEqual(before);
  expect(result.signedDataHex).toBe(bytes(quote()).toString('hex'));
  expect(Object.isFrozen(result.quote.fees)).toBe(true);
  expect(Object.isFrozen(result.recipient)).toBe(true);
  expect(result).toMatchObject({
    gasEstimate: '84',
    gasPrice: '1',
    feeAmount: '100',
    maximumFee: '100',
  });
});
test.each([
  [
    'recipient',
    (q) => {
      q.railgunAddress = '0zk1' + 'p'.repeat(123);
    },
  ],
  [
    'token',
    (q) => {
      q.fees = { ['0x' + '1'.repeat(40)]: '0x64' };
    },
  ],
  [
    'rate',
    (q) => {
      q.fees[pins.wrappedNative] = '0x64';
    },
  ],
  [
    'renewed expiry',
    (q) => {
      q.feeExpiration++;
    },
  ],
  [
    'short expiry',
    (q) => {
      q.feeExpiration--;
    },
  ],
  [
    'missing list',
    (q) => {
      q.requiredPOIListKeys = [];
    },
  ],
  [
    'wrong list',
    (q) => {
      q.requiredPOIListKeys = ['55'.repeat(32)];
    },
  ],
  [
    'relay adapt',
    (q) => {
      q.relayAdapt = '0x' + '1'.repeat(40);
    },
  ],
])('selection refuses changed %s', (_label, change) => {
  const q = quote();
  change(q);
  expect(() => selectRelayWireInput(packet(q), recipient, now, '100')).toThrow();
});
test.each(['99', '101', 100, true])('selection refuses changed budget %s', (budget) =>
  expect(() => selectRelayWireInput(packet(), recipient, now, budget)).toThrow()
);
test('selection refuses duplicate signed quote fields before semantic use', () => {
  const text = JSON.stringify(quote()).replace('"feesID":', '"feesID":"other","feesID":');
  expect(() =>
    selectRelayWireInput(
      bytes({ data: Buffer.from(text).toString('hex'), signature: '01'.repeat(64) }),
      recipient,
      now,
      '100'
    )
  ).toThrow('Duplicate');
});
test('before/after encryption checks reject a stalled or expired operation without renewing', () => {
  const selection = select();
  expect(() => assertSelectionCurrent(selection, now + 1000, now)).not.toThrow();
  expect(() => assertSelectionCurrent(selection, now + LIMITS.outerMs, now + 1000)).not.toThrow();
  expect(() => assertSelectionCurrent(selection, now + LIMITS.outerMs + 1, now)).toThrow();
  expect(() => assertSelectionCurrent(selection, selection.expiresAt, now)).toThrow();
  expect(() => assertSelectionCurrent(selection, now + 1, now + 2)).toThrow();
  expect(() => assertSelectionCurrent(selection, now, now - 1)).toThrow();
});
test('nonempty map uses list→unprefixed leaf, snarkProof and exact upstream root/blind formats', () => {
  const raw = publicCase(),
    map = prePoiMap(bytes(raw), leaf);
  expect(Object.keys(map)).toEqual([LIST]);
  expect(Object.keys(map[LIST])).toEqual([leaf]);
  expect(map[LIST][leaf]).toEqual({
    snarkProof: raw.poi.proof,
    txidMerkleroot: field(21),
    poiMerkleroots: [field(22)],
    blindedCommitmentsOut: raw.poi.blindedCommitmentsOut,
    railgunTxidIfHasUnshield: '0x00',
  });
  expect(Object.isFrozen(map[LIST][leaf].snarkProof.pi_a)).toBe(true);
});
test('decrypted COMMON reconstructs exact public case without any original-case argument', () => {
  const result = publicCaseFromCommon(bytes(common()), select(), leaf);
  expect(copy(result)).toEqual(publicCase());
  expect(Object.isFrozen(result.poi.proof)).toBe(true);
  expect(() => assertCaseUnchanged(bytes(publicCase()), result)).not.toThrow();
});
test('distinguishes original-case substitution: decrypted changed proof/data reaches verifier input', () => {
  const original = publicCase(),
    wire = copy(common());
  wire.data = '0x05060708';
  wire.preTransactionPOIsPerTxidLeafPerList[LIST][leaf].snarkProof.pi_a[0] = '9';
  const reconstructed = publicCaseFromCommon(bytes(wire), select(), leaf);
  expect(reconstructed.transaction.data).toBe(wire.data);
  expect(reconstructed.poi.proof.pi_a[0]).toBe('9');
  expect(() => assertCaseUnchanged(bytes(original), reconstructed)).toThrow();
  // Returning the original case instead would conceal these changes and fail
  // the expectations above. The real verifier later rejects changed crypto.
});
test.each([
  'transactType',
  'txidVersion',
  'to',
  'broadcasterViewingKey',
  'chainID',
  'chainType',
  'minGasPrice',
  'feesID',
  'useRelayAdapt',
  'devLog',
  'minVersion',
  'maxVersion',
])('COMMON refuses changed %s', (key) => {
  const wire = copy(common());
  wire[key] = typeof wire[key] === 'string' ? 'wrong' : true;
  expect(() => publicCaseFromCommon(bytes(wire), select(), leaf)).toThrow();
});
test.each([
  'missing',
  'extra',
  'wrong leaf',
  'prefixed leaf',
  'proof rename',
  'prefixed root',
  'bare blind',
  'wrong unshield',
])('POI map refuses %s', (mode) => {
  const wire = copy(common()),
    map = wire.preTransactionPOIsPerTxidLeafPerList;
  const poi = map[LIST][leaf];
  if (mode === 'missing') delete map[LIST];
  if (mode === 'extra') map[LIST][field(100)] = copy(poi);
  if (mode === 'wrong leaf') {
    delete map[LIST][leaf];
    map[LIST][field(100)] = poi;
  }
  if (mode === 'prefixed leaf') {
    delete map[LIST][leaf];
    map[LIST]['0x' + leaf] = poi;
  }
  if (mode === 'proof rename') {
    poi.proof = poi.snarkProof;
    delete poi.snarkProof;
  }
  if (mode === 'prefixed root') poi.txidMerkleroot = '0x' + poi.txidMerkleroot;
  if (mode === 'bare blind') poi.blindedCommitmentsOut[0] = field(23);
  if (mode === 'wrong unshield') poi.railgunTxidIfHasUnshield = '0x01';
  expect(() => publicCaseFromCommon(bytes(wire), select(), leaf)).toThrow();
});
test.each(['data', 'chainID', 'to', 'preTransactionPOIsPerTxidLeafPerList'])(
  'no fallback for absent decrypted %s',
  (key) => {
    const wire = copy(common());
    delete wire[key];
    expect(() => publicCaseFromCommon(bytes(wire), select(), leaf)).toThrow();
  }
);
test('parser rejects duplicate COMMON and malformed UTF8 with no crypto dependency', () => {
  const text = JSON.stringify(common()).replace('"data":', '"data":"0x00","data":');
  expect(() => publicCaseFromCommon(Buffer.from(text), select(), leaf)).toThrow('Duplicate');
  expect(() => publicCaseFromCommon(Buffer.from([255]), select(), leaf)).toThrow();
});
test('byte budgets and calldata/proof shape reject oversized and noncanonical public inputs', () => {
  expect(() => readPublicCase(Buffer.alloc(LIMITS.publicCaseBytes + 1))).toThrow('bound');
  expect(() =>
    publicCaseFromCommon(Buffer.alloc(LIMITS.plaintextBytes + 1), select(), leaf)
  ).toThrow('bound');
  const raw = publicCase();
  raw.transaction.data = '0x' + '00'.repeat(4097);
  expect(() => readPublicCase(bytes(raw))).toThrow();
  raw.transaction.data = '0x00';
  raw.poi.proof.pi_a[0] = '01';
  expect(() => readPublicCase(bytes(raw))).toThrow();
});
test('existing empty-map policy remains unchanged and still refuses this nonempty map', () => {
  const { validateCommonPlaintext } = require('./railgun-relay-wire/policy');
  expect(() =>
    validateCommonPlaintext(
      common(),
      {
        data: publicCase().transaction.data,
        publicKeyHex: recipient.viewingPublicKey,
        minGasPrice: '1',
        feesID: quote().feesID,
      },
      POLICY
    )
  ).toThrow('empty synthetic POI map');
});

// Structural casing normalization is distinct from the guarded EIP-55 check.
test('COMMON mixed-case address preserves exact target bytes when reconstructed', () => {
  const input = common();
  input.to = '0x' + pins.proxy.slice(2).toUpperCase();
  expect(publicCaseFromCommon(bytes(input), select(), leaf).transaction.to).toBe(pins.proxy);
});
test.each(['0x' + 'ab'.repeat(20), pins.proxy.slice(2), pins.proxy + '00'])(
  'COMMON wrong or malformed target refuses %s',
  (target) => {
    const input = common();
    input.to = target;
    expect(() => publicCaseFromCommon(bytes(input), select(), leaf)).toThrow();
  }
);
