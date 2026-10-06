const { AbiCoder, Interface, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const ZERO = '0x' + '0'.repeat(40),
  abi = new Interface([TRANSACT_ABI]);
function fixture() {
  const peer = '0zk1' + 'q'.repeat(123),
    self = '0zk1' + 'p'.repeat(123);
  const fields = {
    fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
    feeExpiration: 1,
    feesID: 'unsigned-test',
    railgunAddress: peer,
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: [],
    reliability: -1,
  };
  const context = {
    walletId: '11'.repeat(32),
    self: { address: self, masterPublicKey: '7', viewingPublicKey: '02'.repeat(32) },
    peer: { address: peer, masterPublicKey: '8', viewingPublicKey: '03'.repeat(32) },
    quote: {
      data: Buffer.from(JSON.stringify(fields)).toString('hex'),
      signature: '04'.repeat(64),
    },
    gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
    inputAmount: '700',
    feeAmount: '100',
    selfAmount: '600',
    feeCap: '100',
  };
  const cipher = (n) => ({
    ciphertext: [hex(n), hex(n + 1), hex(n + 2), hex(n + 3)],
    blindedSenderViewingKey: hex(n + 4),
    blindedReceiverViewingKey: hex(n + 5),
    annotationData: '0x1122',
    memo: '0x',
  });
  const bound = {
    treeNumber: 0,
    minGasPrice: 1,
    unshield: 0,
    chainID: pins.chainId,
    adaptContract: ZERO,
    adaptParams: hex(0),
    commitmentCiphertext: [cipher(10), cipher(20)],
  };
  const inner = {
    proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
    merkleRoot: hex(7),
    nullifiers: [hex(8)],
    commitments: [hex(9), hex(10)],
    boundParams: bound,
    unshieldPreimage: {
      npk: hex(0),
      token: { tokenType: 0, tokenAddress: ZERO, tokenSubID: 0 },
      value: 0,
    },
  };
  const expected = {
    kind: 'railgun-relay-self-transfer',
    tree: 0,
    merkleRoot: hex(7),
    nullifier: hex(8),
    feeCommitment: hex(9),
    selfCommitment: hex(10),
    boundParamsHash: '',
  };
  const build = () => {
    expected.boundParamsHash = hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % FIELD
    );
    return {
      transaction: {
        chainId: pins.chainId,
        to: pins.proxy,
        value: '0',
        data: abi.encodeFunctionData('transact', [[inner]]),
      },
      expected: { ...expected },
      expectedHash: hex(11),
      context: JSON.parse(JSON.stringify(context)),
    };
  };
  return { context, inner, bound, expected, build };
}

const { normalizeRailgunRelayDraftCapsule: normalize } = require('./railgun-relay-capsule');
function draft() {
  return {
    schema: 'railgun-relay-unsigned-draft-v1',
    walletId: '11'.repeat(32),
    engineSha256: '22'.repeat(32),
    selection: { tree: 0, position: 7 },
    noteHash: hex(12),
    pathElements: Array.from({ length: 16 }, (_, i) => hex(i + 1)),
    intent: fixture().build(),
  };
}

const { buildRailgunRelayReviewSummary: buildSummary } = require('./railgun-relay-review-summary');
function input() {
  const value = draft();
  const normalized = normalize(value);
  return {
    draft: value,
    reconstruction: {
      draftDigest: normalized.digest,
      expectedHash: value.intent.expectedHash,
      recoveredOutputs: 2,
    },
    noteId: '0:7',
    checkpointHash: '33'.repeat(32),
    walletGenerationId: '44'.repeat(32),
    publicIdentity: {
      generationId: '55'.repeat(32),
      sourceId: '66'.repeat(32),
      publicId: '77'.repeat(32),
    },
  };
}
test('exact detached summary binds the reconstructed bytes without disclosing a capsule or granting authority', () => {
  const value = input(),
    result = buildSummary(value),
    summary = result.summary;
  expect(summary.amounts).toEqual({ input: '700', fee: '100', self: '600', cap: '100' });
  expect(summary.gas).toMatchObject({
    gasLimitMultiplierBps: 12000,
    gasLimit: '100',
    maximumGasWei: '100',
    rateDenominator: '1000000000000000000',
  });
  expect(summary.bindings.calldataSha256).toBe(
    require('crypto')
      .createHash('sha256')
      .update(Buffer.from(value.draft.intent.transaction.data.slice(2), 'hex'))
      .digest('hex')
  );
  expect(result.summaryDigest).toBe(
    require('crypto')
      .createHash('sha256')
      .update('freedom:railgun:relay-review-summary-v1\0' + JSON.stringify(summary))
      .digest('hex')
  );
  expect(Object.isFrozen(summary.peer)).toBe(true);
  expect(JSON.stringify(summary)).not.toContain(value.draft.intent.context.quote.data);
  for (const name of ['pathElements', 'preparation', 'draft', 'quoteData', 'signature'])
    expect(summary[name]).toBeUndefined();
  for (const name of [
    'gasEstimateVerified',
    'operatorTrusted',
    'reservationsChecked',
    'capsulePersisted',
    'signingEnabled',
    'proofAuthority',
    'poiQueriesPermitted',
    'relaySendPermitted',
  ])
    expect(summary[name]).toBe(false);
  value.publicIdentity.publicId = '88'.repeat(32);
  value.draft.intent.context.self.masterPublicKey = '19';
  expect(summary.state.publicIdentity.publicId).toBe('77'.repeat(32));
  expect(summary.self.masterPublicKey).toBe('7');
});
test.each([
  'checkpointHash',
  'walletGenerationId',
  'publicIdentity',
  'quote',
  'peer',
  'cap',
  'calldata',
  'path',
])('summary digest binds %s', (name) => {
  const value = input(),
    before = buildSummary(value);
  if (name === 'publicIdentity') value.publicIdentity.sourceId = '88'.repeat(32);
  else if (name === 'quote') value.draft.intent.context.quote.signature = '05'.repeat(64);
  else if (name === 'peer') value.draft.intent.context.peer.masterPublicKey = '19';
  else if (name === 'cap') value.draft.intent.context.feeCap = '101';
  else if (name === 'path') value.draft.pathElements[0] = hex(40);
  else if (name === 'calldata') {
    const changed = fixture();
    changed.bound.commitmentCiphertext[0].ciphertext[0] = hex(44);
    value.draft.intent = changed.build();
  } else value[name] = '88'.repeat(32);
  value.reconstruction.draftDigest = normalize(value.draft).digest;
  expect(buildSummary(value).summaryDigest).not.toBe(before.summaryDigest);
});
test.each(['getter', 'proxy', 'reconstruction', 'selection', 'extra', 'digest'])(
  'refuses %s without granting structural data authority',
  (kind) => {
    let value = input();
    const getter = jest.fn();
    if (kind === 'getter') Object.defineProperty(value, 'draft', { enumerable: true, get: getter });
    if (kind === 'proxy') value = new Proxy(value, { get: getter });
    if (kind === 'reconstruction') value.reconstruction.expectedHash = hex(25);
    if (kind === 'selection') value.noteId = '0:8';
    if (kind === 'extra') value.verified = true;
    if (kind === 'digest') value.checkpointHash = '{}';
    expect(() => buildSummary(value)).toThrow('Railgun relay review summary refused');
    expect(getter).not.toHaveBeenCalled();
  }
);
