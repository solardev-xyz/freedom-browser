// Structural public fixtures and actual pure normalizers only. The selector
// seam stops before utility launch; neither it nor this helper authenticates T.
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn(() => {
    throw Error('test stops before utility launch');
  }),
}));
const { createHash } = require('crypto');
const {
  getRailgunOwnPoiShape: getShape,
  assertRailgunOwnPoiPayloadShape: assertShape,
} = require('./railgun-own-poi-shape-data');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { bindRailgunOwnPoiPayload } = require('./railgun-own-poi-proof-data');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { createPrivacyScope } = require('../networks/privacy-context');
const { deriveRailgunOwnSelector } = require('./railgun-own-selector');
const { startRailgunProcess } = require('./railgun-process');
const {
  createRailgunPartialCapsuleData,
  createRailgunLegacyCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const TRANSFER = 'railgun-private-transfer';
const FULL = 'railgun-token-unshield';
const PARTIAL = 'railgun-partial-unshield';
const KINDS = [TRANSFER, FULL, PARTIAL];
const SELECTOR_GOLDENS = {
  [TRANSFER]: '6e222be8548e6d4735db19d664cead992ac07528840e143060e67dc29952262a',
  [FULL]: '4f4ff2ef419f6f52859996b6c1bc70d42165db44c6f5d91ed423d5f50a3a7a51',
  [PARTIAL]: '01ccd9e321ae5454a425e93f6b884535d004d932acc927897714f8035819244c',
};
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const clone = (v) => JSON.parse(JSON.stringify(v));
function capsule(kind) {
  return (
    kind === PARTIAL ? createRailgunPartialCapsuleData() : createRailgunLegacyCapsuleData(kind)
  ).capsule;
}
function payload(kind) {
  return {
    listKey: REQUIRED_LIST,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    poiMerkleroots: [hex(3).slice(2)],
    txidMerkleroot: hex(4).slice(2),
    txidMerklerootIndex: 6,
    blindedCommitmentsOut: kind === FULL ? [] : [hex(5)],
    railgunTxidIfHasUnshield: kind === TRANSFER ? '0x00' : hex(6),
  };
}

beforeEach(() => jest.clearAllMocks());
test('exposes only the two pure shape functions', () => {
  expect(Object.keys(require('./railgun-own-poi-shape-data')).sort()).toEqual([
    'assertRailgunOwnPoiPayloadShape',
    'getRailgunOwnPoiShape',
  ]);
});
test.each(KINDS)(
  'normalizes full %s capsule and returns frozen bounded shape without identifiers',
  (kind) => {
    const c = capsule(kind);
    expect(normalizeRailgunPrivateCapsule(c)).toEqual(c);
    const before = JSON.stringify(c);
    const result = getShape(c);
    expect(result).toEqual({
      kind,
      capsuleVersion: kind === PARTIAL ? 2 : 1,
      outputCount: kind === FULL ? 0 : 1,
      hasPrivateOutput: kind !== FULL,
      hasUnshield: kind !== TRANSFER,
      selectorDomain:
        kind === PARTIAL
          ? 'freedom:railgun:own-selector-v2\0'
          : 'freedom:railgun:own-selector-v1\0',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(c)).toBe(before);
    c.selection.kind = 'forged';
    expect(result.kind).toBe(kind);
    expect(startRailgunProcess).not.toHaveBeenCalled();
  }
);
test.each(
  KINDS.flatMap((kind) =>
    [0, 1, 2, 3, '1', undefined]
      .filter((v) => v !== (kind === PARTIAL ? 2 : 1))
      .map((version) => [kind, version])
  )
)('refuses forbidden kind/version pair %s/%s', (kind, version) => {
  const c = capsule(kind);
  c.version = version;
  expect(() => getShape(c)).toThrow();
  expect(() => assertShape(payload(kind), c)).toThrow();
});
test.each([
  [
    'unknown kind',
    (c) => {
      c.selection.kind = 'partial';
    },
  ],
  [
    'extra partial flag',
    (c) => {
      c.partial = true;
    },
  ],
  [
    'missing preparation',
    (c) => {
      delete c.preparation;
    },
  ],
  [
    'changed input amount',
    (c) => {
      c.preparation.inputAmount = '999';
    },
  ],
  [
    'changed change amount',
    (c) => {
      c.preparation.changeAmount = '599';
    },
  ],
  [
    'changed expected commitment',
    (c) => {
      c.preparation.expected.changeCommitment = hex(42);
    },
  ],
  [
    'changed selector amount',
    (c) => {
      c.selection.unshieldAmount = '401';
    },
  ],
  [
    'short original path',
    (c) => {
      c.pathElements.pop();
    },
  ],
  ['array capsule', (c) => Object.assign([], c)],
])('refuses malformed capsule: %s', (_name, mutate) => {
  const c = capsule(PARTIAL);
  const changed = mutate(c) || c;
  expect(() => getShape(changed)).toThrow();
});
test.each([null, undefined, {}, [], true, 'capsule'])('refuses noncapsule %p', (value) => {
  expect(() => getShape(value)).toThrow();
});
test.each(KINDS.flatMap((kind) => KINDS.map((payloadKind) => [kind, payloadKind])))(
  'exact shape pairing capsule %s / payload %s',
  (kind, payloadKind) => {
    const c = capsule(kind),
      p = payload(payloadKind);
    expect(normalizeRailgunPoiPayload(p)).toEqual(p);
    if (kind === payloadKind) expect(assertShape(p, c)).toBeUndefined();
    else expect(() => assertShape(p, c)).toThrow();
  }
);
test.each([
  [
    'short nonzero marker',
    (p) => {
      p.railgunTxidIfHasUnshield = '0x01';
    },
  ],
  [
    'full zero marker',
    (p) => {
      p.railgunTxidIfHasUnshield = hex(0);
    },
  ],
  [
    'uppercase marker',
    (p) => {
      p.railgunTxidIfHasUnshield = '0x' + 'A'.repeat(64);
    },
  ],
  [
    'field overflow marker',
    (p) => {
      p.railgunTxidIfHasUnshield = hex(FIELD);
    },
  ],
  [
    'extra output',
    (p) => {
      p.blindedCommitmentsOut.push(hex(7));
    },
  ],
  [
    'zero change',
    (p) => {
      p.blindedCommitmentsOut[0] = hex(0);
    },
  ],
  [
    'unknown payload field',
    (p) => {
      p.partial = true;
    },
  ],
  [
    'malformed proof',
    (p) => {
      p.proof.pi_a = ['1'];
    },
  ],
])('refuses malformed payload: %s', (_name, mutate) => {
  const p = payload(PARTIAL);
  mutate(p);
  expect(() => assertShape(p, capsule(PARTIAL))).toThrow();
});
test('empty output and zero marker refuses for every operation', () => {
  const p = payload(FULL);
  p.railgunTxidIfHasUnshield = '0x00';
  for (const kind of KINDS) expect(() => assertShape(p, capsule(kind))).toThrow();
});
test.each([FULL, PARTIAL])(
  'keeps leading-zero nonzero marker intact for %s without claiming exact TXID',
  (kind) => {
    const c = capsule(kind),
      p = payload(kind);
    p.railgunTxidIfHasUnshield = hex(1);
    const before = JSON.stringify({ c, p });
    expect(assertShape(p, c)).toBeUndefined();
    expect(JSON.stringify({ c, p })).toBe(before);
    const expected = {
      listKey: p.listKey,
      poiMerkleroots: p.poiMerkleroots,
      txidMerkleroot: p.txidMerkleroot,
      txidMerklerootIndex: p.txidMerklerootIndex,
      railgunTxidIfHasUnshield: hex(2),
      outputCount: p.blindedCommitmentsOut.length,
    };
    // Real downstream pure binder rejects the mismatching T although category
    // passes. These expected fields are structural test data, not authentication.
    expect(() => bindRailgunOwnPoiPayload(p, expected)).toThrow();
    expected.railgunTxidIfHasUnshield = hex(1);
    expect(bindRailgunOwnPoiPayload(p, expected)).toEqual(p);
  }
);
test.each(KINDS)(
  'actual selector producer agrees with capsule domain for %s before mocked launch',
  async (kind) => {
    const c = capsule(kind),
      shape = getShape(c);
    const scope = createPrivacyScope({
      profileId: 'pure-shape-parity',
      signal: new AbortController().signal,
    });
    try {
      await expect(
        deriveRailgunOwnSelector({
          handle: scope.getContext({
            kind: 'private-account',
            protocol: 'railgun',
            deployment: 'sepolia',
            chainId: 11155111,
            principal: 'fixture-account',
            role: 'engine',
            operation: 'own-txid-selector',
          }),
          archive: '/test/runtime.asar',
          provedTransaction: c.preparation.transaction,
          signal: scope.signal,
        })
      ).rejects.toMatchObject({ code: 'RAILGUN_OWN_SELECTOR_REFUSED' });
      expect(startRailgunProcess).toHaveBeenCalledTimes(1);
      const actual = JSON.parse(startRailgunProcess.mock.calls[0][0].input);
      const expectedDigest = createHash('sha256')
        .update(shape.selectorDomain)
        .update(JSON.stringify(c.preparation.transaction))
        .digest('hex');
      expect(actual.bindingDigest).toBe(expectedDigest);
      expect(actual.bindingDigest).toBe(SELECTOR_GOLDENS[kind]);
      expect(shape.selectorDomain.charCodeAt(shape.selectorDomain.length - 1)).toBe(0);
      const wrongDomain =
        kind === PARTIAL
          ? 'freedom:railgun:own-selector-v1\0'
          : 'freedom:railgun:own-selector-v2\0';
      expect(actual.bindingDigest).not.toBe(
        createHash('sha256')
          .update(wrongDomain)
          .update(JSON.stringify(c.preparation.transaction))
          .digest('hex')
      );
      expect(actual.facts.commitments).toEqual(
        kind === PARTIAL
          ? [c.preparation.expected.changeCommitment, c.preparation.expected.unshieldCommitment]
          : [c.preparation.expected.commitment]
      );
    } finally {
      scope.close();
    }
  }
);
test('canonical frozen inputs remain usable without mutation or authority result', () => {
  const c = normalizeRailgunPrivateCapsule(capsule(PARTIAL));
  const p = normalizeRailgunPoiPayload(payload(PARTIAL));
  const before = clone({ c, p });
  expect(assertShape(p, c)).toBeUndefined();
  expect({ c, p }).toEqual(before);
});
