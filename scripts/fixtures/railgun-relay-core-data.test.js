/** Pure arithmetic/shape seams. No engine import, runtime or signature execution. */
const subject = require('./railgun-relay-core-data');
const { createRailgunRelayUnsignedData } = require('./railgun-relay-unsigned-data');
const {
  normalizeRailgunRelayDraftCapsule,
} = require('../../src/main/wallet/railgun-relay-capsule');
const hex = subject.hex;
const hash = (values) => values[0] * 17n + values[1] * 31n + 1n;
const text = () =>
  JSON.stringify(normalizeRailgunRelayDraftCapsule(createRailgunRelayUnsignedData().draft).data);
test('two-leaf growth has both real leaf paths and preserves original path', () => {
  const zeros = Array(16).fill(hex(0));
  const pair = subject.treePair(7n, 9n, zeros, hash);
  expect(pair.original.elements).toEqual(zeros);
  expect(pair.grown.elements).toEqual([hex(9), ...zeros.slice(1)]);
  expect(pair.original.root).not.toBe(pair.grown.root);
  expect(subject.rootFor(9n, [hex(7), ...zeros.slice(1)], 1, hash)).toBe(pair.grown.root);
  expect(pair.original.leaf).toBe(pair.grown.leaf);
  expect(zeros).toEqual(Array(16).fill(hex(0)));
});
test('refuses same appended leaf or wrong tree depth', () => {
  expect(() => subject.treePair(7n, 7n, Array(16).fill(hex(0)), hash)).toThrow();
  expect(() => subject.treePair(7n, 8n, Array(15).fill(hex(0)), hash)).toThrow();
});
test('captured history preserves exact event and independently archived path', () => {
  const draftText = text(),
    history = subject.capturedHistory(draftText);
  const report = require('../../docs/qualification/railgun-poi-read-2026-10-03.json');
  const event = require('./railgun-poi-signed-event.json')[0];
  expect(history.proof).toEqual(report.membership.proofs[0]);
  expect(history.event.signedPOIEvent).toEqual(event.signedPOIEvent);
  expect(history.draftDigest).toBe(normalizeRailgunRelayDraftCapsule(JSON.parse(draftText)).digest);
  expect(history.note.blindedCommitment).toBe('0x' + history.proof.leaf);
  expect(history.event.validatedMerkleroot).not.toBe(history.proof.root);
  expect(Object.isFrozen(history)).toBe(true);
});
test('noncanonical draft refused before attaching history', () => {
  expect(() => subject.capturedHistory(' ' + text())).toThrow();
});
test('producer returns only exact canonical public bytes and clears fixture key scope', async () => {
  jest.resetModules();
  const draft = normalizeRailgunRelayDraftCapsule(createRailgunRelayUnsignedData().draft).data;
  const close = jest.fn(),
    active = jest.fn();
  jest.doMock('./railgun-relay-core-data', () => ({
    createVector: jest.fn(async () => ({
      args: { archive: 'fixture' },
      request: {},
      active,
      close,
    })),
    sha: subject.sha,
  }));
  jest.doMock('../../src/main/wallet/railgun-relay-witness', () => ({
    prepareRailgunRelayDraft: jest.fn(async () => draft),
  }));
  const { EXPECTED_GUARDS } = require('../qualify-railgun-relay-proof');
  const request = jest.fn(async (text) => {
    const row = JSON.parse(text);
    expect(Object.keys(row.value).sort()).toEqual([
      'draftSha256',
      'draftText',
      'guards',
      'syntheticQuoteUnsigned',
    ]);
    expect(row.value.draftText).toBe(JSON.stringify(draft));
    return JSON.stringify({ id: 1, value: null });
  });
  try {
    await require('./railgun-relay-core-producer-job').run(JSON.stringify({ archive: 'fixture' }), {
      request,
      signal: new AbortController().signal,
      guardReport: () => EXPECTED_GUARDS,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(require('./railgun-relay-core-producer-job').run('{}', {})).rejects.toThrow();
  } finally {
    jest.dontMock('./railgun-relay-core-data');
    jest.dontMock('../../src/main/wallet/railgun-relay-witness');
    jest.resetModules();
  }
});

describe('recovery job with explicit controlled core/math seams', () => {
  function setup(fault) {
    jest.resetModules();
    const draft = normalizeRailgunRelayDraftCapsule(createRailgunRelayUnsignedData().draft).data;
    // The canonical data is immutable; changes use a detached copy.
    const raw = subject.copy(draft);
    raw.selection.position = 0;
    raw.intent.context.inputAmount = '1000';
    raw.intent.context.selfAmount = '900';
    const value = normalizeRailgunRelayDraftCapsule(raw),
      draftText = JSON.stringify(value.data);
    const history = subject.capturedHistory(draftText);
    const priv = {
      tokenAddress: 9n,
      randomIn: [1n],
      valueIn: [1000n],
      pathElements: [value.data.pathElements.map(BigInt)],
      leavesIndices: [0n],
      valueOut: [100n, 900n],
      publicKey: [...subject.SPENDING_PUBLIC],
      npkOut: [5n, 6n],
      nullifyingKey: 4n,
    };
    const expected = value.data.intent.expected;
    const coreResult = {
      publicReconstruction: {
        draftDigest: value.digest,
        expectedHash: value.data.intent.expectedHash,
        recoveredOutputs: 2,
      },
      witness: {
        privateInputs: priv,
        publicInputs: {
          merkleRoot: BigInt(expected.merkleRoot),
          boundParamsHash: BigInt(expected.boundParamsHash),
          nullifiers: [BigInt(expected.nullifier)],
          commitmentsOut: [BigInt(expected.feeCommitment), BigInt(expected.selfCommitment)],
        },
      },
      prePoi: {
        inputNoteType: 'Shield',
        inputNpk: 3n,
        token: hex(9),
        randomsIn: [hex(1)],
        valuesIn: [1000n],
        valuesOut: [100n, 900n],
        utxoPositionsIn: [0],
        utxoTreeIn: 0,
        npksOut: [5n, 6n],
      },
    };
    const originalRoot = expected.merkleRoot.slice(2),
      grownRoot = hex(99),
      inputBlind =
        '0x' + hex(BigInt(history.note.blindedCommitment) + (fault === 'blind-equal' ? 0n : 1n));
    const close = jest.fn();
    const args = {
      archive: 'fixture',
      wallet: { getNullifyingKey: () => 4n },
      descriptor: {},
      checkpoint: { state: { trees: [{ tree: 0, length: 1, root: '0x' + originalRoot }] } },
      scan: { ownedPoi: [{ blindedCommitment: inputBlind }] },
      signal: new AbortController().signal,
    };
    const binding = {
      blindedCommitmentsOut: ['0x' + hex(2), '0x' + hex(3)],
      txidMerkleroot: hex(11),
      listWitness: history.proof,
    };
    const poseidon = jest.fn((items) =>
      items[2] === 0n
        ? BigInt(inputBlind)
        : items[2] === 100n
          ? BigInt(expected.feeCommitment)
          : BigInt(expected.selfCommitment)
    );
    const vector = {
      args,
      note: { tokenHash: hex(9), random: hex(1), hash: 12n, notePublicKey: 3n },
      roots: {
        original: { root: originalRoot, elements: value.data.pathElements.map((v) => v.slice(2)) },
        grown: { root: grownRoot, elements: [hex(99), ...Array(15).fill(hex(0))] },
      },
      active: () => {},
      close,
      imp: (name) => {
        if (name === 'utils/poseidon') return { poseidon };
        if (name === 'models/merkletree-types') return { MERKLE_ZERO_VALUE_BIGINT: 1n };
        throw Error('Unexpected engine import');
      },
    };
    const fail = (code) => Object.assign(Error('Controlled refusal'), { code });
    const reconstruct = jest.fn(async (input) => {
      if (input.checkpoint.state.trees[0].length === 2 && fault !== 'fresh-admits-grown')
        throw fail('RAILGUN_RELAY_RECONSTRUCTION_REFUSED');
      return coreResult;
    });
    const diagnostic = jest.fn(async (input) => {
      if (input.checkpoint.state.trees[0].length === 2)
        throw fail('RAILGUN_RELAY_RECONSTRUCTION_REFUSED');
      return coreResult.publicReconstruction;
    });
    const local = jest.fn(async (input) => {
      if (input.draftText !== draftText) throw fail('RAILGUN_RELAY_RECONSTRUCTION_REFUSED');
      return fault === 'local-changed' ? { ...coreResult, extra: true } : coreResult;
    });
    jest.doMock('./railgun-relay-core-data', () => ({
      ...subject,
      createVector: async () => vector,
      capturedHistory: () => history,
      bindingFor: () => binding,
    }));
    jest.doMock('../../src/main/wallet/railgun-relay-reconstruct', () => ({
      reconstructRailgunRelayWitness: reconstruct,
      reconstructRailgunRelayDraft: diagnostic,
      reconstructRailgunRelayLocalWitness: local,
    }));
    jest.doMock('../../src/main/wallet/railgun-relay-pre-poi-math', () => ({
      verifyRailgunRelayPrePoiPublicMath: jest.fn(async (input) => {
        if (JSON.stringify(input.history) !== JSON.stringify(history))
          throw fail('RAILGUN_RELAY_PRE_POI_MATH_REFUSED');
        return {
          historicalEventSignatureVerified: true,
          historicalMembershipPathVerified: true,
          outputBlindingVerified: false,
          inputOwnershipVerified: false,
          proofVerified: fault === 'math-promotes-proof',
          currentMembershipVerified: false,
          authorityGranted: false,
          publicSignals: [2n, 3n, 0n, 11n, 0n, BigInt('0x' + history.proof.root), 1n, 1n],
        };
      }),
    }));
    const assemble = jest.fn(async (input) => {
      expect(Object.keys(input).sort()).toEqual([
        'archive',
        'checkpoint',
        'descriptor',
        'draftText',
        'history',
        'scan',
        'signal',
        'wallet',
      ]);
      if (fault !== 'assembler-skips-core')
        await require('../../src/main/wallet/railgun-relay-reconstruct').reconstructRailgunRelayWitness(
          input
        );
      if (fault !== 'assembler-accepts') throw fail('RAILGUN_RELAY_PRE_POI_WITNESS_REFUSED');
      return {};
    });
    jest.doMock('../../src/main/wallet/railgun-relay-pre-poi-witness', () => ({
      prepareRailgunRelayPrePoiWitness: assemble,
    }));
    const { EXPECTED_GUARDS } = require('../qualify-railgun-relay-proof');
    const rows = [];
    const request = jest.fn(async (text) => {
      rows.push(JSON.parse(text));
      return JSON.stringify({ id: 1, value: null });
    });
    const run = () =>
      require('./railgun-relay-core-recovery-job').run(
        JSON.stringify({ archive: 'fixture', draftText }),
        { request, signal: args.signal, guardReport: () => EXPECTED_GUARDS }
      );
    return { run, rows, close, reconstruct, assemble };
  }
  afterEach(() => {
    for (const name of [
      './railgun-relay-core-data',
      '../../src/main/wallet/railgun-relay-reconstruct',
      '../../src/main/wallet/railgun-relay-pre-poi-math',
      '../../src/main/wallet/railgun-relay-pre-poi-witness',
    ])
      jest.dontMock(name);
    jest.resetModules();
  });
  test('observes original core completion inside assembler and emits only bounded public result', async () => {
    const f = setup();
    await f.run();
    expect(f.rows).toHaveLength(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.assemble).toHaveBeenCalledTimes(1);
    expect(f.rows[0].value.assemblerOriginalCoreCompleted).toBe(true);
    for (const name of [
      'witness',
      'privateInputs',
      'prePoi',
      'randomsIn',
      'nullifyingKey',
      'draftText',
    ])
      expect(Object.hasOwn(f.rows[0].value, name)).toBe(false);
    expect(
      require('../../src/main/wallet/railgun-relay-reconstruct').reconstructRailgunRelayWitness
    ).toBe(f.reconstruct);
  });
  test.each([
    'assembler-skips-core',
    'assembler-accepts',
    'fresh-admits-grown',
    'local-changed',
    'math-promotes-proof',
    'blind-equal',
  ])('withholds every result on %s', async (fault) => {
    const f = setup(fault);
    await expect(f.run()).rejects.toThrow();
    expect(f.rows).toEqual([]);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(
      require('../../src/main/wallet/railgun-relay-reconstruct').reconstructRailgunRelayWitness
    ).toBe(f.reconstruct);
  });
});
