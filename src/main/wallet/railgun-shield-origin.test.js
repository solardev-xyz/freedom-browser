jest.mock('./railgun-shield-origin-data', () => ({
  ...jest.requireActual('./railgun-shield-origin-data'),
  matchRailgunShieldOrigin: jest.fn((input) =>
    jest.requireActual('./railgun-shield-origin-data').matchRailgunShieldOrigin(input)
  ),
}));
// Real context, intent, receipt and matcher boundaries; owner registries and the
// existing reader are unit seams. This is not native enrollment/storage qualification.
jest.mock('./railgun-account-enrollment', () => ({ isRailgunAccountEnrollment: jest.fn() }));
jest.mock('./railgun-identity', () => ({ assertRailgunIdentity: jest.fn() }));
jest.mock('./railgun-account-wallet', () => ({ readRailgunAccountOwnedNotes: jest.fn() }));
jest.mock('./railgun-account-public', () => ({ getRailgunAccountPublicIdentity: jest.fn() }));
jest.mock('./private-submission-journal', () => ({
  readExistingPrivateSubmissionSnapshot: jest.fn(),
}));
jest.mock('../identity-manager', () => ({
  getWalletRecord: jest.fn(),
  WALLET_TYPES: { MNEMONIC: 'mnemonic' },
}));
jest.mock('../networks/privacy-context', () => ({
  ...jest.requireActual('../networks/privacy-context'),
  createPrivacyScope: jest.fn((options) =>
    jest.requireActual('../networks/privacy-context').createPrivacyScope(options)
  ),
}));
const { diagnoseRailgunShieldOrigin } = require('./railgun-shield-origin');
const context = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { readRailgunAccountOwnedNotes } = require('./railgun-account-wallet');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const { readExistingPrivateSubmissionSnapshot: reader } = require('./private-submission-journal');
const { getWalletRecord } = require('../identity-manager');
const { Interface, toBeHex } = require('ethers');
const { transactionIntent } = require('./private-transaction-intent');
const { SHIELD_ABI } = require('./railgun-shield-policy');
const { SHIELD_EVENT, inspectRailgunShieldReceipt } = require('./railgun-shield-receipt');
const { checkpointHash } = require('./railgun-wallet-coverage');
const pins = require('./railgun-shield-pins.json');
const prepared = require('../../../docs/qualification/railgun-shield-account-2026-10-03.json')
  .prepared[0];
const abi = new Interface([...SHIELD_ABI, SHIELD_EVENT]);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const owner = '0x' + 'ab'.repeat(20);
// Keep plain fixture objects in this Jest realm; Node structuredClone creates
// foreign-realm prototypes which the strict data boundary intentionally rejects.
const clone = (value) =>
  Array.isArray(value)
    ? value.map(clone)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]))
      : value;
function fixture() {
  const transaction = {
    chainId: '0xaa36a7',
    from: owner,
    to: pins.relayAdapt,
    value: '0x' + BigInt(prepared.value).toString(16),
    input: prepared.data,
    hash: hex(101),
    nonce: '0x0',
    blockHash: hex(102),
    blockNumber: '0xb4911f',
  };
  const [, calls] = abi.decodeFunctionData('multicall', transaction.input);
  const [requests] = abi.decodeFunctionData('shield', calls[1].data);
  const log = {
    ...abi.encodeEventLog('Shield', [
      0,
      123,
      [[prepared.npk, [0, pins.wrappedNative, 0], BigInt(prepared.noteValue)]],
      [requests[0].ciphertext],
      [BigInt(prepared.value) - BigInt(prepared.noteValue)],
    ]),
    address: pins.proxy,
    transactionHash: transaction.hash,
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber,
    logIndex: '0x4',
    removed: false,
  };
  const receipt = {
    transactionHash: transaction.hash,
    from: owner,
    to: pins.relayAdapt,
    status: '0x1',
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber,
    logs: [log],
  };
  const blockNumber = Number(BigInt(transaction.blockNumber));
  const record = {
    hash: transaction.hash,
    nonce: 0,
    state: 'submitted',
    attemptedAt: 1,
    revision: 2,
    intent: transactionIntent('railgun-native-shield', { ...transaction, data: transaction.input }),
    observation: {
      status: 'included',
      trust: 'unverified',
      observedAt: 2,
      confirmations: 13,
      blockNumber,
      blockHash: transaction.blockHash,
    },
  };
  const shield = inspectRailgunShieldReceipt(record, transaction, receipt);
  expect(shield.status).toBe('matched');
  record.resolution = {
    minimumConfirmations: 3,
    reviewedAt: 3,
    blockHash: transaction.blockHash,
    railgun: {
      outcome: 'matched',
      finalizedBlockNumber: blockNumber + 12,
      finalizedBlockHash: hex(103),
      shield,
    },
  };
  const checkpoint = {
    from: 0,
    previousHash: hex(0),
    to: { number: blockNumber, hash: transaction.blockHash },
    anchor: { number: blockNumber + 12, hash: hex(103) },
    logs: { count: 1, sha256: '1'.repeat(64) },
    source: {
      level: 'unverified-rpc',
      providersSha256: '2'.repeat(64),
      ledgerId: '3'.repeat(64),
      ledgerSha256: '4'.repeat(64),
    },
    state: {
      schema: 'public-records-v1',
      storeId: '5'.repeat(64),
      trees: [{ tree: 0, length: 124, root: hex(104) }],
      commitments: { count: 124, sha256: '6'.repeat(64) },
      nullifiers: { count: 0, sha256: '7'.repeat(64) },
      unshields: { count: 0, sha256: '8'.repeat(64) },
    },
  };
  const owned = {
    checkpointHash: checkpointHash(checkpoint),
    trees: clone(checkpoint.state.trees),
    read: {
      instanceId: 'synthetic-view-only-data',
      received: [
        {
          id: '0:123',
          tree: 0,
          position: 123,
          txid: transaction.hash,
          hash: hex(10),
          tokenHash: toBeHex(BigInt(pins.wrappedNative), 32),
          asset: { __type: 'erc20', contract: pins.wrappedNative },
          amount: BigInt(prepared.noteValue),
          spentTxid: false,
          tag: 'unverified',
        },
      ],
      sent: [],
    },
    ownedPoi: [
      {
        id: '0:123',
        type: 'Shield',
        txid: transaction.hash,
        hash: hex(10),
        npk: prepared.npk,
        nullifier: hex(11),
        blindedCommitment: hex(12),
        blockNumber,
      },
    ],
  };
  return { record, transaction, receipt, owned, checkpoint, submitter: owner };
}

let state;
const expected = (matched = false) => ({
  status: matched ? 'matched' : 'refused',
  trust: 'supplied-data',
  ownershipAuthenticated: false,
  canonicalityVerified: false,
  spendingEnabled: false,
  poiBypassEnabled: false,
  localJournalAuthenticated: matched,
  localAccountSnapshotSourceAuthenticated: matched,
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  jest.clearAllMocks();
  const data = fixture();
  const controls = Object.fromEntries(
    ['caller', 'account', 'identity', 'enrollment', 'coordinator'].map((key) => [
      key,
      new AbortController(),
    ])
  );
  const parent = jest
    .requireActual('../networks/privacy-context')
    .createPrivacyScope({ profileId: 'unit-profile', signal: controls.identity.signal });
  const engine = parent.getContext({
    kind: 'private-account',
    principal: 'unit-account',
    chainId: 11155111,
    protocol: 'railgun',
    deployment: 'sepolia',
    role: 'engine',
  });
  const identity = { signal: controls.identity.signal, close: jest.fn() };
  const enrollment = {
    signal: controls.enrollment.signal,
    getContext: jest.fn(() => engine),
    close: jest.fn(),
  };
  const coordinator = { signal: controls.coordinator.signal, close: jest.fn() };
  const account = {
    signal: controls.account.signal,
    generationId: '9'.repeat(64),
    get view() {
      return state.view;
    },
    close: jest.fn(),
  };
  const owners = { identity, enrollment, coordinator };
  state = {
    data,
    controls,
    parent,
    engine,
    owners,
    account,
    view: {},
    publicIdentity: {
      generationId: 'a'.repeat(64),
      sourceId: 'b'.repeat(64),
      publicId: 'c'.repeat(64),
    },
    journal: { records: [data.record], archive: [] },
    busy: false,
  };
  state.input = {
    account,
    owners,
    noteId: '0:123',
    signal: controls.caller.signal,
    transaction: data.transaction,
    receipt: data.receipt,
    checkpoint: data.checkpoint,
  };
  isRailgunAccountEnrollment.mockImplementation((value) => value === enrollment);
  assertRailgunIdentity.mockImplementation((value, handle) => {
    expect(value).toBe(identity);
    expect(handle).toBe(engine);
    context.getPrivacyContext(handle);
  });
  readRailgunAccountOwnedNotes.mockImplementation((value, bindings) => {
    if (value !== account) throw Error('unknown account');
    expect(bindings).toEqual(owners);
    if (state.busy) throw Error('busy');
    return state.data.owned;
  });
  getRailgunAccountPublicIdentity.mockImplementation((value, binding) => {
    expect(value).toBe(coordinator);
    expect(binding).toBe(enrollment);
    return state.publicIdentity;
  });
  getWalletRecord.mockReturnValue({ index: 0, type: 'mnemonic', address: owner });
  reader.mockImplementation(async (handle) => {
    const entry = context.getPrivacyContext(handle);
    expect(entry.profileId).toBe('unit-profile');
    expect(entry.subject).toEqual({
      kind: 'public-address',
      principal: owner,
      chainId: 11155111,
      role: 'transaction-rpc',
      protocol: null,
      deployment: null,
      operation: null,
    });
    return clone(state.journal);
  });
});
afterEach(() => {
  state.parent.close();
  jest.useRealTimers();
});
function borrowedRemainOpen() {
  for (const owner of [state.account, ...Object.values(state.owners)])
    expect(owner.close).not.toHaveBeenCalled();
  for (const control of Object.values(state.controls)) expect(control.signal.aborted).toBe(false);
}
test('returns detached false-authority diagnostic after two existing reads; closes only child', async () => {
  const before = clone(state.data);
  const result = await diagnoseRailgunShieldOrigin(state.input);
  expect(result).toEqual(expected(true));
  expect(Object.isFrozen(result)).toBe(true);
  expect(state.data).toEqual(before);
  expect(reader).toHaveBeenCalledTimes(2);
  expect(context.createPrivacyScope).toHaveBeenCalledTimes(1);
  expect(() => context.getPrivacyContext(reader.mock.calls[0][0])).toThrow();
  context.getPrivacyContext(state.engine);
  borrowedRemainOpen();
});
test.each(['account', 'identity', 'enrollment', 'coordinator'])(
  'forged %s refuses before reader',
  async (key) => {
    if (key === 'account') state.input.account = {};
    else state.input.owners = { ...state.owners, [key]: {} };
    expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
    expect(reader).not.toHaveBeenCalled();
  }
);
test.each(['account', 'identity', 'enrollment', 'coordinator', 'caller'])(
  '%s cancellation drains admitted reader before refusal',
  async (key) => {
    const gate = deferred();
    reader.mockImplementationOnce(() => gate.promise);
    let settled = false;
    const work = diagnoseRailgunShieldOrigin(state.input).then((value) => {
      settled = true;
      return value;
    });
    expect(reader).toHaveBeenCalledTimes(1);
    state.controls[key].abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve(clone(state.journal));
    expect(await work).toEqual(expected());
    expect(reader).toHaveBeenCalledTimes(1);
    for (const item of [state.account, ...Object.values(state.owners)])
      expect(item.close).not.toHaveBeenCalled();
  }
);
test('deadline does not abandon a held reader or renew on a second read', async () => {
  jest.useFakeTimers();
  const gate = deferred();
  reader.mockImplementationOnce(() => gate.promise);
  let settled = false;
  const work = diagnoseRailgunShieldOrigin(state.input).then((v) => {
    settled = true;
    return v;
  });
  jest.advanceTimersByTime(10001);
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.resolve(clone(state.journal));
  expect(await work).toEqual(expected());
  expect(reader).toHaveBeenCalledTimes(1);
  borrowedRemainOpen();
});
const races = {
  view: () => {
    state.view = {};
  },
  walletGeneration: () => {
    state.account.generationId = 'f'.repeat(64);
  },
  publicGeneration: () => {
    state.publicIdentity.generationId = 'f'.repeat(64);
  },
  publicSource: () => {
    state.publicIdentity.sourceId = 'f'.repeat(64);
  },
  publicId: () => {
    state.publicIdentity.publicId = 'f'.repeat(64);
  },
  checkpoint: () => {
    state.data.owned.checkpointHash = 'f'.repeat(64);
  },
  note: () => {
    state.data.owned.read.received[0].amount += 1n;
  },
  poi: () => {
    state.data.owned.ownedPoi[0].nullifier = hex(50);
  },
  metadata: () => {
    getWalletRecord.mockReturnValue({
      index: 0,
      type: 'mnemonic',
      address: '0x' + 'cd'.repeat(20),
    });
  },
  busy: () => {
    state.busy = true;
  },
  parentClosed: () => {
    state.parent.close();
  },
  engineReplaced: () => {
    state.owners.enrollment.getContext.mockReturnValue({});
  },
};
test.each(Object.keys(races))('refuses %s changed during second read', async (key) => {
  const original = reader.getMockImplementation();
  reader.mockImplementationOnce(original).mockImplementationOnce(async (handle) => {
    const value = await original(handle);
    races[key]();
    return value;
  });
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  expect(reader).toHaveBeenCalledTimes(2);
});
test.each(['revision', 'observation', 'resolution', 'unresolved', 'archive'])(
  'journal %s changed on reread refuses',
  async (key) => {
    const first = clone(state.journal),
      second = clone(state.journal);
    if (key === 'revision') second.records[0].revision++;
    if (key === 'observation') second.records[0].observation.observedAt++;
    if (key === 'resolution') second.records[0].resolution.reviewedAt++;
    if (key === 'unresolved') second.records.push({ resolution: null });
    if (key === 'archive') {
      second.archive = second.records;
      second.records = [];
    }
    reader.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  }
);
test.each([
  'unresolved',
  'duplicate',
  'archive',
  'thirdParty',
  'wrongPosition',
  'wrongKind',
  'missingNote',
  'duplicateNote',
  'duplicatePoi',
])('%s refuses selected active join', async (key) => {
  if (key === 'unresolved') state.journal.records.push({ resolution: null });
  if (key === 'duplicate') state.journal.records.push(clone(state.data.record));
  if (key === 'archive') {
    state.journal.archive = state.journal.records;
    state.journal.records = [];
  }
  if (key === 'thirdParty') state.data.transaction.from = '0x' + 'cd'.repeat(20);
  if (key === 'wrongPosition') state.input.noteId = '0:124';
  if (key === 'wrongKind') state.data.owned.ownedPoi[0].type = 'Transact';
  if (key === 'missingNote') state.data.owned.read.received = [];
  if (key === 'duplicateNote')
    state.data.owned.read.received.push(clone(state.data.owned.read.received[0]));
  if (key === 'duplicatePoi') state.data.owned.ownedPoi.push(clone(state.data.owned.ownedPoi[0]));
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
});
test.each(['transaction', 'receipt', 'checkpoint'])('wrong %s public hint refuses', async (key) => {
  if (key === 'transaction') state.input.transaction.input = '0x';
  if (key === 'receipt') state.input.receipt.status = '0x0';
  if (key === 'checkpoint') state.input.checkpoint.logs.sha256 = 'f'.repeat(64);
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
});
test('provider provenance is deliberately outside checkpoint binding', async () => {
  state.input.checkpoint.source.providersSha256 = 'f'.repeat(64);
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected(true));
});
test('snapshots hints before first await; later caller mutation cannot alter them', async () => {
  const gate = deferred();
  reader.mockImplementationOnce(() => gate.promise);
  const work = diagnoseRailgunShieldOrigin(state.input);
  state.input.transaction.input = '0x';
  state.input.checkpoint.logs.sha256 = 'f'.repeat(64);
  gate.resolve(clone(state.journal));
  expect(await work).toEqual(expected(true));
});
test.each([
  'getter',
  'proxy',
  'cycle',
  'deep',
  'oversize',
  'extra',
  'ownersGetter',
  'optionGetter',
])('rejects %s without executing supplied code or reading journal', async (key) => {
  const trap = jest.fn(() => {
    throw Error('must not run');
  });
  if (key === 'getter')
    Object.defineProperty(state.input.transaction, 'input', { enumerable: true, get: trap });
  if (key === 'proxy')
    state.input.receipt = new Proxy(state.input.receipt, {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
    });
  if (key === 'cycle') state.input.receipt.loop = state.input.receipt;
  if (key === 'deep') {
    let obj = state.input.receipt;
    for (let i = 0; i < 20; i++) obj = obj.next = {};
  }
  if (key === 'oversize') state.input.receipt.extra = 'x'.repeat(262145);
  if (key === 'extra') state.input.extra = true;
  if (key === 'ownersGetter')
    Object.defineProperty(state.input.owners, 'identity', { enumerable: true, get: trap });
  if (key === 'optionGetter')
    Object.defineProperty(state.input, 'receipt', { enumerable: true, get: trap });
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  expect(trap).not.toHaveBeenCalled();
  expect(reader).not.toHaveBeenCalled();
});
test.each([
  null,
  {},
  { index: 1, type: 'mnemonic', address: owner },
  { index: 0, type: 'hardware', address: owner },
  { index: 0, type: 'mnemonic', address: '0x' + '00'.repeat(20) },
])('invalid funding metadata refuses before journal', async (value) => {
  getWalletRecord.mockReturnValue(value);
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  expect(reader).not.toHaveBeenCalled();
});
test.each([1, 2])('reader %s failure sanitizes and closes child', async (which) => {
  if (which === 2) reader.mockResolvedValueOnce(clone(state.journal));
  reader.mockRejectedValueOnce(Error('private internal diagnostic'));
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  expect(() => context.getPrivacyContext(reader.mock.calls[0][0])).toThrow();
  borrowedRemainOpen();
});

test('requested real second note cannot select a journal record for the first note', async () => {
  const note = clone(state.data.owned.read.received[0]);
  const poi = clone(state.data.owned.ownedPoi[0]);
  note.id = poi.id = '0:124';
  note.position = 124;
  state.data.owned.read.received.push(note);
  state.data.owned.ownedPoi.push(poi);
  state.input.noteId = note.id;
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  expect(reader).toHaveBeenCalledTimes(1);
});

test('fixed deadline also drains a second admitted reader without renewing', async () => {
  jest.useFakeTimers();
  const first = deferred();
  const second = deferred();
  reader.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  let settled = false;
  const work = diagnoseRailgunShieldOrigin(state.input).then((value) => {
    settled = true;
    return value;
  });
  jest.advanceTimersByTime(9000);
  first.resolve(clone(state.journal));
  await Promise.resolve();
  expect(reader).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(1001);
  await Promise.resolve();
  expect(settled).toBe(false);
  second.resolve(clone(state.journal));
  expect(await work).toEqual(expected());
  borrowedRemainOpen();
});

test('already aborted caller refuses before an admitted read', async () => {
  state.controls.caller.abort();
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  expect(reader).not.toHaveBeenCalled();
});

test('a forged account lifetime getter is never invoked before registry refusal', async () => {
  const trap = jest.fn(() => {
    throw Error('untrusted getter');
  });
  state.input.account = {
    get signal() {
      return trap();
    },
  };
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  expect(trap).not.toHaveBeenCalled();
  expect(reader).not.toHaveBeenCalled();
});

test('unresolved archived rows do not replace or block the selected active resolution', async () => {
  state.journal.archive.push({ resolution: null });
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected(true));
});

test('child cleanup error suppresses successful diagnostic without closing borrowers', async () => {
  context.createPrivacyScope.mockImplementationOnce((options) => {
    const scope = jest.requireActual('../networks/privacy-context').createPrivacyScope(options);
    return {
      ...scope,
      close() {
        scope.close();
        throw Error('cleanup failed');
      },
    };
  });
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  expect(reader).toHaveBeenCalledTimes(2);
  expect(() => context.getPrivacyContext(reader.mock.calls[0][0])).toThrow();
  borrowedRemainOpen();
});

test('parent context abort immediately revokes child while admitted reader still drains', async () => {
  const gate = deferred();
  let child;
  reader.mockImplementationOnce((handle) => {
    child = context.getPrivacyContext(handle);
    return gate.promise;
  });
  let settled = false;
  const work = diagnoseRailgunShieldOrigin(state.input).then((value) => {
    settled = true;
    return value;
  });
  state.parent.close();
  expect(child.signal.aborted).toBe(true);
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.resolve(clone(state.journal));
  expect(await work).toEqual(expected());
});

test('monotonic deadline refuses when second matching expires budget before delayed timer', async () => {
  jest.useFakeTimers();
  const { performance } = require('perf_hooks');
  const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
  const { matchRailgunShieldOrigin: matcher } = require('./railgun-shield-origin-data');
  const actual = jest.requireActual('./railgun-shield-origin-data').matchRailgunShieldOrigin;
  matcher.mockImplementationOnce(actual).mockImplementationOnce((input) => {
    const matched = actual(input);
    expect(matched.status).toBe('matched');
    // Timer callbacks remain deliberately unrun. Only the monotonic clock changes.
    clock.mockReturnValue(10001);
    return matched;
  });
  try {
    expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
    expect(matcher).toHaveBeenCalledTimes(2);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    borrowedRemainOpen();
  } finally {
    clock.mockRestore();
  }
});

test('refusal leaves the same borrowed owners and normal read usable after repaired local condition', async () => {
  const originalView = state.account.view;
  const originalOwners = state.owners;
  state.journal.records.push({ resolution: null });
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected());
  const refusedChild = reader.mock.calls[0][0];
  expect(() => context.getPrivacyContext(refusedChild)).toThrow();
  borrowedRemainOpen();
  state.journal.records.pop();
  expect(readRailgunAccountOwnedNotes(state.account, originalOwners)).toBe(state.data.owned);
  expect(state.account.view).toBe(originalView);
  context.getPrivacyContext(state.engine);
  expect(await diagnoseRailgunShieldOrigin(state.input)).toEqual(expected(true));
  expect(state.owners).toBe(originalOwners);
  expect(reader).toHaveBeenCalledTimes(3);
  expect(reader.mock.calls[1][0]).not.toBe(refusedChild);
  borrowedRemainOpen();
});
