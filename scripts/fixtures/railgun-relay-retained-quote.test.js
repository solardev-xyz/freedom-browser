// Structural controls only. No Ed25519, Poseidon, Groth16, signing or native job.
const mockNodeVerify = jest.fn();
const mockPublicKey = jest.fn();
const mockPublicCase = jest.fn();
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createPublicKey: (...args) => mockPublicKey(...args),
  verify: (...args) => mockNodeVerify(...args),
  createPrivateKey: () => {
    throw new Error('Private key forbidden');
  },
  sign: () => {
    throw new Error('Signing forbidden');
  },
}));
jest.mock('./railgun-relay-public-data', () => ({
  validatePublicCase: (...args) => mockPublicCase(...args),
}));
const { verifyRetainedQuote } = require('./railgun-relay-retained-quote');
const basis = require('./railgun-relay-retained-basis.json');
const { LIST, LIMITS } = require('./railgun-relay-wire-composition');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { createHash } = jest.requireActual('crypto');
const bytes = (v) => Buffer.from(JSON.stringify(v));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const word = (n) => '0x' + n.toString(16).padStart(64, '0');
const when = 1791230400000;
const address = '0zk1' + 'q'.repeat(123);
function original() {
  return {
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
      txidMerkleroot: word(21),
      poiMerkleroots: [word(22)],
      blindedCommitmentsOut: [word(23), word(24)],
      railgunTxidIfHasUnshield: '0x00',
    },
  };
}
function quote() {
  return {
    fees: { [pins.wrappedNative]: '0x' + (10n ** 18n).toString(16) },
    feeExpiration: when + LIMITS.quoteLifetimeMs,
    feesID: basis.feesID,
    railgunAddress: address,
    identifier: basis.identifier,
    availableWallets: 1,
    version: basis.version,
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: [LIST],
    reliability: 0.95,
  };
}
function packet(q = quote()) {
  return bytes({ data: bytes(q).toString('hex'), signature: '01'.repeat(64) });
}
function setup() {
  // Deliberately fake additive arithmetic; cannot establish real commitments.
  const poseidon = jest.fn((values) => values.reduce((a, b) => a + b, 0n) % 2n ** 250n);
  const master = poseidon([
    ...basis.feePublicCoordinates.map(BigInt),
    BigInt(basis.publicNullifyingValue),
  ]);
  const commitment = poseidon([
    poseidon([master, BigInt('0x' + basis.feeNoteRandomHex)]),
    BigInt(pins.wrappedNative),
    100n,
  ]);
  mockPublicCase.mockReturnValue({ transactionSignals: [1n, 2n, 3n, commitment, 5n] });
  const context = {
    poseidon,
    upstream: {
      encodeAddress: jest.fn(() => address),
      getRailgunWalletAddressData: jest.fn(() => ({
        masterPublicKey: master,
        viewingPublicKey: Buffer.from(basis.publicViewingKeyHex, 'hex'),
        chain: { type: 0, id: pins.chainId },
      })),
      verifyBroadcasterSignature: jest.fn(async () => true),
    },
    gas: {
      EVMGasType: { Type1: 1 },
      calculateGasLimit: jest.fn(() => 100n),
      calculateMaximumGas: jest.fn(() => 100n),
      calculateBroadcasterFeeERC20Amount: jest.fn(() => ({
        tokenAddress: pins.wrappedNative,
        amount: 100n,
      })),
    },
  };
  return { context, publicBytes: bytes(original()), quoteBytes: packet(), active: jest.fn() };
}
const invoke = (f) => verifyRetainedQuote(f.context, f.publicBytes, f.quoteBytes, f.active);
beforeEach(() => {
  jest.clearAllMocks();
  mockNodeVerify.mockReturnValue(true);
  mockPublicKey.mockReturnValue({ marker: 'public-only' });
});
test('public-only path joins exact bytes, fixed key and fee commitment; limits remain explicit', async () => {
  const f = setup(),
    result = await invoke(f);
  expect(result.publicCaseSha256).toBe(sha(f.publicBytes));
  expect(result.signedQuoteSha256).toBe(sha(f.quoteBytes));
  expect(result.historicalEvaluationAt).toBe(when);
  for (const name of [
    'historicalWallClockEstablished',
    'currentQuoteAdmission',
    'uniqueQuoteCalldataCommitment',
    'encryptionTranscriptReplayed',
    'feeCiphertextDecryptableByBroadcaster',
    'serviceAcceptanceQualified',
    'authorityGranted',
  ])
    expect(result[name]).toBe(false);
  expect(mockPublicKey.mock.calls[0][0].key.toString('hex')).toBe(
    '302a300506032b6570032100' + basis.publicViewingKeyHex
  );
  expect(mockPublicCase).toHaveBeenCalledTimes(1);
});
test.each(['upstream', 'node'])(
  'both signature checks are mandatory: %s refusal precedes semantic arithmetic',
  async (which) => {
    const f = setup();
    if (which === 'upstream')
      f.context.upstream.verifyBroadcasterSignature.mockResolvedValue(false);
    else mockNodeVerify.mockReturnValue(false);
    await expect(invoke(f)).rejects.toThrow();
    expect(f.context.gas.calculateGasLimit).not.toHaveBeenCalled();
    expect(mockPublicCase).not.toHaveBeenCalled();
    if (which === 'upstream') expect(mockNodeVerify).not.toHaveBeenCalled();
  }
);
test.each(['address', 'viewingPublicKey', 'masterPublicKey', 'chain'])(
  'candidate identity cannot replace independent expected %s',
  async (field) => {
    const f = setup();
    if (field === 'address') {
      const q = quote();
      q.railgunAddress = '0zk1' + 'p'.repeat(123);
      f.quoteBytes = packet(q);
    } else {
      const decoded = f.context.upstream.getRailgunWalletAddressData();
      decoded[field] =
        field === 'viewingPublicKey'
          ? Buffer.alloc(32)
          : field === 'masterPublicKey'
            ? 9n
            : { type: 0, id: 1 };
      f.context.upstream.getRailgunWalletAddressData.mockReturnValue(decoded);
    }
    await expect(invoke(f)).rejects.toThrow();
    expect(f.context.upstream.verifyBroadcasterSignature).not.toHaveBeenCalled();
  }
);
test.each(['fees', 'requiredPOIListKeys', 'feesID', 'relayAdapt', 'version'])(
  'signature success cannot bypass policy join %s',
  async (field) => {
    const f = setup(),
      q = quote();
    q[field] = {
      fees: { [pins.wrappedNative]: '0x1' },
      requiredPOIListKeys: [],
      feesID: 'OTHER',
      relayAdapt: '0x' + 'ff'.repeat(20),
      version: '8.1.0',
    }[field];
    f.quoteBytes = packet(q);
    await expect(invoke(f)).rejects.toThrow();
    expect(mockNodeVerify).toHaveBeenCalledTimes(1);
    expect(mockPublicCase).not.toHaveBeenCalled();
  }
);
test('actual result signal must equal recomputed quote-recipient fee commitment', async () => {
  const f = setup();
  mockPublicCase.mockReturnValue({ transactionSignals: [1n, 2n, 3n, 0n, 5n] });
  await expect(invoke(f)).rejects.toThrow();
  expect(mockPublicCase).toHaveBeenCalledTimes(1);
});
test.each(['amount', 'token'])('gas helper result %s must match bound fee', async (field) => {
  const f = setup();
  f.context.gas.calculateBroadcasterFeeERC20Amount.mockReturnValue({
    tokenAddress: field === 'token' ? '0x' + 'ff'.repeat(20) : pins.wrappedNative,
    amount: field === 'amount' ? 99n : 100n,
  });
  await expect(invoke(f)).rejects.toThrow();
  expect(mockPublicCase).not.toHaveBeenCalled();
});
test('raw formatted signed JSON is verified without canonicalizing and snapshots survive await mutation', async () => {
  const f = setup(),
    raw = Buffer.from(JSON.stringify(quote(), null, 2));
  f.quoteBytes = bytes({ data: raw.toString('hex'), signature: '01'.repeat(64) });
  const caseHash = sha(f.publicBytes),
    quoteHash = sha(f.quoteBytes);
  let release;
  f.context.upstream.verifyBroadcasterSignature.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      })
  );
  const pending = invoke(f);
  f.publicBytes.fill(0);
  f.quoteBytes.fill(0);
  release(true);
  const result = await pending;
  expect(result.publicCaseSha256).toBe(caseHash);
  expect(result.signedQuoteSha256).toBe(quoteHash);
  expect(mockNodeVerify.mock.calls[0][1]).toEqual(raw);
  expect(f.context.upstream.verifyBroadcasterSignature.mock.calls[0][1]).toBe(raw.toString('hex'));
});
test.each(['packet', 'signed-data'])(
  'duplicate escaped JSON fields refuse before signature: %s',
  async (which) => {
    const f = setup();
    const signed = bytes(quote())
      .toString()
      .replace('"feesID":', '"fees\\u0049D":"duplicate","feesID":');
    f.quoteBytes =
      which === 'signed-data'
        ? bytes({ data: Buffer.from(signed).toString('hex'), signature: '01'.repeat(64) })
        : Buffer.from(f.quoteBytes.toString().replace('"data":', '"d\\u0061ta":"00","data":'));
    await expect(invoke(f)).rejects.toThrow();
    expect(f.context.upstream.verifyBroadcasterSignature).not.toHaveBeenCalled();
  }
);
test('oversize public bytes refuse before upstream', async () => {
  const f = setup();
  f.publicBytes = Buffer.alloc(32769, 32);
  await expect(invoke(f)).rejects.toThrow();
  expect(f.context.upstream.verifyBroadcasterSignature).not.toHaveBeenCalled();
});
test('expired today is not silently relabeled fresh: historical evaluation is derived only', async () => {
  const f = setup();
  const spy = jest.spyOn(Date, 'now').mockImplementation(() => {
    throw new Error('Current admission forbidden');
  });
  try {
    const result = await invoke(f);
    expect(result.historicalEvaluationDerivedFromExpiry).toBe(true);
    expect(result.currentQuoteAdmission).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

test('requiring public-only entry imports no producer, signing fixture, generated bundle or serial prover', () => {
  const { execFileSync } = require('child_process');
  const entry = require.resolve('./railgun-relay-retained-job');
  const script = `require(${JSON.stringify(entry)}); const bad=Object.keys(require.cache).filter(p=>/railgun-relay-wire-crypto|railgun-relay-proof-job|railgun-relay-wire-producer-job|upstream\\.cjs|serial-prover/.test(p)); if(bad.length)throw new Error(JSON.stringify(bad));`;
  expect(() => execFileSync(process.execPath, ['-e', script])).not.toThrow();
});
test('job refuses malformed outer schema before build verification', async () => {
  let job;
  jest.isolateModules(() => {
    job = require('./railgun-relay-retained-job');
  });
  await expect(
    job.run('{}', {
      signal: new AbortController().signal,
      request: jest.fn(),
      guardReport: jest.fn(),
    })
  ).rejects.toThrow();
});
test('job real bad manifest digest refuses before generated module or runtime loads', async () => {
  let job;
  jest.isolateModules(() => {
    job = require('./railgun-relay-retained-job');
  });
  const f = setup();
  const input = {
    archive: '/does-not-exist/engine.asar',
    wireBuild: '/does-not-exist/build',
    wireBuildSha256: 'bad',
    gasBundle: '/does-not-exist/gas.cjs',
    gasBundleSha256: '0'.repeat(64),
    publicCaseText: f.publicBytes.toString(),
    signedQuoteText: f.quoteBytes.toString(),
  };
  const request = jest.fn(),
    guardReport = jest.fn();
  await expect(
    job.run(JSON.stringify(input), { signal: new AbortController().signal, request, guardReport })
  ).rejects.toThrow('Reviewed build manifest SHA256 required');
  expect(request).not.toHaveBeenCalled();
  expect(guardReport).not.toHaveBeenCalled();
});
