const { createHash } = require('crypto');
const {
  assertRailgunPoiCreatorEvents: eventsFor,
  normalizeRailgunPoiCreatorWitness: witnessFor,
  assertRailgunPoiCreatorVerification: verificationFor,
} = require('./railgun-poi-creator-data');
const { classifyRailgunTxidContinuity } = require('./railgun-txid-omissions');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const detach = (v) => JSON.parse(JSON.stringify(v));
function sample(mixed = true) {
  // Public structural witness only. The shared predicate performs no crypto.
  const row = {
    version: 'V2',
    graphID: hex(30) + '0'.repeat(128),
    commitments: mixed ? [hex(20), hex(21)] : [hex(20)],
    nullifiers: [hex(10)],
    boundParamsHash: hex(9),
    blockNumber: 30,
    txid: hex(40).slice(2),
    timestamp: 1,
    utxoTreeIn: 0,
    utxoTreeOut: 1,
    utxoBatchStartPositionOut: 123,
    verificationHash: hex(8),
    ...(mixed
      ? {
          unshield: {
            tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
            toAddress: '0x' + '12'.repeat(20),
            value: '400',
          },
        }
      : {}),
  };
  const note = {
    type: 'Transact',
    txid: hex(40),
    hash: hex(20),
    tree: 1,
    position: 123,
    blockNumber: 30,
  };
  const state = { count: 2, root: hex(1).slice(2), transcript: hex(2).slice(2), breaks: [] };
  const noteWitness = {
    note: detach(note),
    outputIndex: 0,
    witness: {
      row,
      leaf: hex(3).slice(2),
      railgunTxid: hex(4).slice(2),
      rowSha256: sha(row),
      index: 0,
      elements: Array(16).fill(hex(0).slice(2)),
      root: state.root,
      checkpointIndex: 1,
      transcript: state.transcript,
      continuity: classifyRailgunTxidContinuity(1, []),
      globalTxidCompleteness: false,
    },
    ownershipVerified: false,
    eventCoverageVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  };
  const events = [
    { name: 'Nullified', logIndex: 1, tree: 0, values: [hex(10)] },
    ...(mixed
      ? [
          {
            name: 'Unshield',
            logIndex: 2,
            to: row.unshield.toAddress,
            token: pins.wrappedNative,
            type: 0,
            subID: '0',
            value: '400',
          },
        ]
      : []),
    { name: 'Transact', logIndex: 3, tree: 1, start: 123, hashes: [hex(20)] },
  ];
  const verification = {
    pathVerified: true,
    suppliedCreatorEventsMatched: true,
    utilityExitObserved: true,
    coverage: {
      matchedRows: 1,
      knownOmissions: 0,
      boundParamsChecked: false,
      unshieldCommitmentHashesChecked: false,
      globalTxidCompleteness: false,
    },
    ...(mixed ? { unshieldCommitmentVerified: true } : {}),
  };
  return { note, state, noteWitness, events, verification };
}
const refused = {
  code: 'RAILGUN_POI_CREATOR_DATA_REFUSED',
  message: 'Railgun POI creator data unavailable',
};
function fails(fn) {
  try {
    fn();
    throw Error('accepted');
  } catch (e) {
    expect(e).toMatchObject(refused);
  }
}
test.each([false, true])(
  'returns detached frozen %s event and witness data without authority',
  (mixed) => {
    const input = sample(mixed),
      original = detach(input);
    const e = eventsFor(input),
      w = witnessFor(input),
      n = verificationFor(input);
    expect(e).toEqual({ events: original.events, hasUnshield: mixed });
    expect(w).toEqual({ noteWitness: original.noteWitness, hasUnshield: mixed });
    expect(n).toEqual(original.noteWitness);
    for (const v of [
      e,
      e.events,
      e.events[0],
      e.events[0].values,
      w,
      w.noteWitness,
      w.noteWitness.witness.row,
      w.noteWitness.witness.elements,
    ])
      expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(input.events[0])).toBe(false);
    expect(Object.isFrozen(input.noteWitness.witness.row)).toBe(false);
    input.events[0].values[0] = hex(22);
    input.noteWitness.witness.elements[0] = hex(22).slice(2);
    expect(e.events).toEqual(original.events);
    expect(w.noteWitness).toEqual(original.noteWitness);
    expect(n.spendingEnabled).toBe(false);
  }
);
test('event canonical field order is stable across supplied key order', () => {
  const v = sample();
  const expected = JSON.stringify(eventsFor(v));
  v.events = v.events.map((e) => Object.fromEntries(Object.entries(e).reverse()));
  expect(JSON.stringify(eventsFor(v))).toBe(expected);
});
test.each([
  [
    'raw log',
    (v) => {
      v.events[0] = { address: pins.proxy, data: '0x', topics: [], logIndex: 1 };
    },
  ],
  [
    'wrong order',
    (v) => {
      v.events.reverse();
    },
  ],
  [
    'extra event',
    (v) => {
      v.events.push({ ...v.events[0], logIndex: 4 });
    },
  ],
  [
    'missing Nullified',
    (v) => {
      v.events.shift();
    },
  ],
  [
    'extra nullifier',
    (v) => {
      v.events[0].values.push(hex(11));
    },
  ],
  [
    'extra output',
    (v) => {
      v.events.at(-1).hashes.push(hex(21));
    },
  ],
  [
    'nullifier field bound',
    (v) => {
      v.events[0].values[0] = '0x' + 'f'.repeat(64);
    },
  ],
  [
    'foreign hash',
    (v) => {
      v.events.at(-1).hashes[0] = hex(21);
    },
  ],
  [
    'foreign tree',
    (v) => {
      v.events.at(-1).tree = 2;
    },
  ],
  [
    'offset-one selection',
    (v) => {
      v.events.at(-1).start = 122;
    },
  ],
  [
    'tree overflow',
    (v) => {
      v.note.tree = v.events.at(-1).tree = 65536;
    },
  ],
  [
    'position overflow',
    (v) => {
      v.note.position = v.events.at(-1).start = 65536;
    },
  ],
  [
    'unsafe log index',
    (v) => {
      v.events.at(-1).logIndex = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'equal log index',
    (v) => {
      v.events[1].logIndex = 1;
    },
  ],
  [
    'foreign token',
    (v) => {
      v.events[1].token = pins.proxy;
    },
  ],
  [
    'NFT',
    (v) => {
      v.events[1].type = 1;
    },
  ],
  [
    'subID',
    (v) => {
      v.events[1].subID = '1';
    },
  ],
  [
    'noncanonical subID',
    (v) => {
      v.events[1].subID = '00';
    },
  ],
  [
    'zero gross',
    (v) => {
      v.events[1].value = '0';
    },
  ],
  [
    'negative gross',
    (v) => {
      v.events[1].value = '-1';
    },
  ],
  [
    'noncanonical gross',
    (v) => {
      v.events[1].value = '0400';
    },
  ],
  [
    'numeric gross',
    (v) => {
      v.events[1].value = 400;
    },
  ],
  [
    'uint120 overflow',
    (v) => {
      v.events[1].value = (1n << 120n).toString();
    },
  ],
  [
    'uppercase recipient',
    (v) => {
      v.events[1].to = '0x' + 'AB'.repeat(20);
    },
  ],
  [
    'extra event property',
    (v) => {
      v.events[1].accepted = true;
    },
  ],
  [
    'extra note property',
    (v) => {
      v.note.authorized = true;
    },
  ],
  [
    'Shield note',
    (v) => {
      v.note.type = 'Shield';
    },
  ],
])('refuses event shape/binding %s', (_name, change) => {
  const v = sample();
  change(v);
  fails(() => eventsFor(v));
});
test('accepts uint120 maximum and does not cap historical foreign creator at current spend cap', () => {
  const v = sample();
  v.events[1].value = ((1n << 120n) - 1n).toString();
  expect(eventsFor(v).hasUnshield).toBe(true);
  v.noteWitness.witness.row.unshield.value = v.events[1].value;
  v.noteWitness.witness.rowSha256 = sha(v.noteWitness.witness.row);
  expect(witnessFor(v).hasUnshield).toBe(true);
});
test('rejects event accessors and proxies without executing their hooks', () => {
  const v = sample();
  const hook = jest.fn(() => 'Unshield');
  Object.defineProperty(v.events[1], 'name', { enumerable: true, get: hook });
  fails(() => eventsFor(v));
  expect(hook).not.toHaveBeenCalled();
  v.events[1] = new Proxy({}, { get: hook, ownKeys: hook });
  fails(() => eventsFor(v));
  expect(hook).not.toHaveBeenCalled();
});
test.each([
  ['extra nullifier', (r) => r.nullifiers.push(hex(11))],
  ['extra commitment', (r) => r.commitments.push(hex(22))],
  ['missing unshield commitment', (r) => r.commitments.pop()],
  [
    'non-WETH',
    (r) => {
      r.unshield.tokenData.tokenAddress = pins.proxy;
    },
  ],
  [
    'NFT',
    (r) => {
      r.unshield.tokenData.tokenType = 1;
    },
  ],
  [
    'nonzero subID',
    (r) => {
      r.unshield.tokenData.tokenSubID = hex(1);
    },
  ],
  [
    'zero unshield',
    (r) => {
      r.unshield.value = '0';
    },
  ],
  [
    'null unshield',
    (r) => {
      r.unshield = null;
    },
  ],
])('refuses coherently rehashed mixed row %s', (_name, change) => {
  const v = sample();
  change(v.noteWitness.witness.row);
  v.noteWitness.witness.rowSha256 = sha(v.noteWitness.witness.row);
  fails(() => witnessFor(v));
});
test('bounded helper refuses non-unshield multi-input/output (generic host must remain broader)', () => {
  const v = sample(false);
  v.noteWitness.witness.row.commitments.push(hex(21));
  v.noteWitness.witness.row.nullifiers.push(hex(11));
  v.noteWitness.witness.rowSha256 = sha(v.noteWitness.witness.row);
  fails(() => witnessFor(v));
});
test.each(['root', 'transcript', 'checkpointIndex', 'rowSha256', 'elements'])(
  'rejects stale normalized witness %s',
  (key) => {
    const v = sample();
    v.noteWitness.witness[key] =
      key === 'checkpointIndex' ? 0 : key === 'elements' ? [] : '0'.repeat(64);
    fails(() => witnessFor(v));
  }
);
test('final unshield commitment cannot be selected as an ordinary note', () => {
  const v = sample();
  v.note.hash = hex(21);
  v.note.position++;
  v.noteWitness.note = detach(v.note);
  v.noteWitness.outputIndex = 1;
  fails(() => witnessFor(v));
});
test.each([
  [
    'missing flag',
    (v) => {
      delete v.verification.unshieldCommitmentVerified;
    },
  ],
  [
    'false flag',
    (v) => {
      v.verification.unshieldCommitmentVerified = false;
    },
  ],
  [
    'numeric flag',
    (v) => {
      v.verification.unshieldCommitmentVerified = 1;
    },
  ],
  [
    'path',
    (v) => {
      v.verification.pathVerified = false;
    },
  ],
  [
    'events',
    (v) => {
      v.verification.suppliedCreatorEventsMatched = false;
    },
  ],
  [
    'exit',
    (v) => {
      v.verification.utilityExitObserved = false;
    },
  ],
  [
    'extra row',
    (v) => {
      v.verification.coverage.matchedRows = 2;
    },
  ],
  [
    'omission',
    (v) => {
      v.verification.coverage.knownOmissions = 1;
    },
  ],
  [
    'boundParams claim',
    (v) => {
      v.verification.coverage.boundParamsChecked = true;
    },
  ],
  [
    'structural crypto claim',
    (v) => {
      v.verification.coverage.unshieldCommitmentHashesChecked = true;
    },
  ],
  [
    'global claim',
    (v) => {
      v.verification.coverage.globalTxidCompleteness = true;
    },
  ],
  [
    'missing coverage',
    (v) => {
      delete v.verification.coverage;
    },
  ],
])('requires exact drained mixed diagnostic %s', (_name, change) => {
  const v = sample();
  change(v);
  fails(() => verificationFor(v));
});
test.each([true, false, undefined])(
  'legacy must omit new hash diagnostic even value %p',
  (value) => {
    const v = sample(false);
    v.verification.unshieldCommitmentVerified = value;
    fails(() => verificationFor(v));
  }
);
