// Real encrypted paired ledger/recovery/floor storage and their actual mutation
// capabilities. Only enrollment/account issuers and crypto job completion are
// structural seams. Disposable public fixture keys; no runtime or native fence.
const mock = {};
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment: (owner) => mock.fence(owner),
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (...args) => mock.identity(...args),
  signRailgunRelayIntent: () => {
    throw Error('cold must never sign');
  },
}));
jest.mock('./railgun-account-wallet', () => ({
  readRailgunCompletedAccountRelayState: (...args) => mock.state(...args),
  completeRailgunAccountRelayProof: (...args) => mock.complete(...args),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { createPrivacyProfileGuard } = require('./privacy-profile-guard');
const { createRailgunPrivateReservations } = require('./railgun-private-reservations');
const { createRailgunRelayRecoveryStore } = require('./railgun-relay-recovery-store');
const {
  createRailgunRelayMainProofData,
} = require('../../../scripts/fixtures/railgun-relay-main-proof-data');
const api = require('./railgun-relay-operation');
const { digestRailgunRelayLocalIntent } = require('./railgun-relay-recovery-data');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
let f;
async function setup() {
  const supplied = createRailgunRelayMainProofData();
  const row = { ...supplied.record, state: 'held', signature: null, proved: null };
  row.history.note.type = 'Shield';
  row.history.event.signedPOIEvent.type = 'Shield';
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cold-controller-'))
  );
  const profile = { id: 'public-cold-controller', userDataDir: directory };
  const profileId = createHash('sha256')
    .update(JSON.stringify([profile.id, profile.userDataDir]))
    .digest('hex');
  const scope = createPrivacyScope({ profileId, signal: new AbortController().signal });
  const subject = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
  };
  const handle = (operation) => scope.getContext({ ...subject, operation });
  const guard = createPrivacyProfileGuard({
    handle: handle('guard'),
    profile,
    seed: Buffer.alloc(64, 8),
  });
  const accountDirectory = path.join(directory, 'wallet-railgun-accounts', 'account-' + hex(900));
  fs.mkdirSync(accountDirectory, { recursive: true });
  const floors = createPrivacyStorage({
    handle: handle('cold-floor'),
    directory: accountDirectory,
    key: Buffer.alloc(32, 9),
    profileGuard: guard,
  });
  const controller = new AbortController();
  let live = true;
  const descriptor = { walletId: row.walletId };
  const enrollment = {
    binding: row.binding,
    descriptor,
    directory: accountDirectory,
    profileGuard: guard,
    signal: scope.signal,
    getContext: (role, operation) => (role === 'engine' ? handle('engine') : handle(operation)),
  };
  mock.fence = jest.fn((value) => {
    if (value !== enrollment || !live) throw Error('foreign issuer');
  });
  mock.identity = jest.fn((value, parent) => {
    if (value !== identity || parent !== enrollment.getContext('engine')) throw Error('identity');
    mock.fence(enrollment);
    return descriptor;
  });
  const identity = { signal: scope.signal },
    owners = { identity, enrollment, coordinator: { signal: scope.signal } };
  const common = {
    enrollment,
    directory: accountDirectory,
    binding: row.binding,
    walletId: row.walletId,
    profileGuard: guard,
  };
  const floor = (key) => ({
    readFloor: async () => {
      const text = await floors.get(key);
      return text === null ? null : JSON.parse(text);
    },
    advanceFloor: async (v) => floors.set(key, JSON.stringify(v)),
  });
  const ledgerOptions = {
    ...common,
    handle: enrollment.getContext('storage', 'railgun-private-reservations-v1:' + row.walletId),
    key: Buffer.alloc(32, 17),
    ...floor('ledger-floor'),
    claimRecovery: () => {
      throw Error('not private recovery');
    },
    authorizeSigning: () => {
      throw Error('not private signing');
    },
  };
  const recoveryOptions = {
    ...common,
    handle: enrollment.getContext('storage', 'railgun-relay-local-recovery-v4:' + row.walletId),
    key: Buffer.alloc(32, 7),
    ...floor('recovery-floor'),
  };
  let ledger = await createRailgunPrivateReservations({ ...ledgerOptions, create: true }),
    recovery = await createRailgunRelayRecoveryStore({ ...recoveryOptions, create: true });
  const stores = [ledger, recovery];
  enrollment.openReservations = jest.fn(async (options) => {
    expect(options).toEqual({ existingOnly: true });
    return ledger;
  });
  enrollment.openRelayRecoveryStore = jest.fn(async (options) => {
    expect(options).toEqual({ existingOnly: true });
    return recovery;
  });
  const input = row.draft.intent.context;
  const id = `${row.draft.selection.tree}:${row.draft.selection.position}`;
  const owned = {
    read: {
      instanceId: input.self.address,
      received: [
        {
          id,
          spentTxid: false,
          hash: row.draft.noteHash,
          txid: '0x' + hex(1000),
          asset: { __type: 'erc20', contract: require('./railgun-shield-pins.json').wrappedNative },
          amount: BigInt(input.inputAmount),
        },
      ],
    },
    ownedPoi: [
      {
        id,
        hash: row.draft.noteHash,
        txid: '0x' + hex(1000),
        nullifier: row.draft.intent.expected.nullifier,
        blindedCommitment: row.history.note.blindedCommitment,
        type: 'Shield',
      },
    ],
    trees: [{ tree: row.draft.selection.tree, length: row.draft.selection.position + 1 }],
  };
  const account = { signal: controller.signal, generationId: hex(1001) };
  let accountBusy = false;
  const state = {
    owned,
    deadline: performance.now() + 180000,
    signal: controller.signal,
    generationId: account.generationId,
    walletId: row.walletId,
    binding: row.binding,
    checkpointHash: hex(1002),
    assertCurrent() {
      if (!live || controller.signal.aborted || performance.now() >= state.deadline)
        throw Error('expired');
    },
  };
  mock.state = jest.fn((a, o) => {
    expect(a).toBe(account);
    expect(o).toEqual(owners);
    if (accountBusy) throw Error('busy');
    state.assertCurrent();
    return Object.freeze(state);
  });
  const events = [];
  mock.complete = jest.fn(async (a, o, { permit, signal }) => {
    const value = api.consumeRailgunRelayProofPermit(permit, a, o);
    accountBusy = true;
    try {
      expect(signal).toBe(controller.signal);
      value.assertCurrent();
      const before = await ledger.readRelay(recovery, value.operationId);
      expect(value.recordText).toBe(JSON.stringify(before.record));
      if (before.record.state === 'signed') {
        events.push('A-original-closed', 'C-original-closed', 'canonical-refresh');
        await recovery.saveProof(value.operationId, {
          transaction: supplied.proof.transaction,
          payload: supplied.proof.payload,
        });
        events.push('save-proof');
      } else {
        events.push('C-original-closed', 'canonical-refresh');
        expect(before.record.state).toBe('ready-local');
      }
      value.assertCurrent();
      return { status: 'ready-local', operationId: value.operationId };
    } finally {
      accountBusy = false;
    }
  });
  const base = { account, owners, signal: controller.signal };
  async function seed(stateName = 'signed', idValue = row.id) {
    let current = { ...row, id: idValue };
    const held = await ledger.reserveRelay(recovery, JSON.stringify(current));
    if (stateName === 'held') return held;
    const signing = await ledger.markRelaySigning(recovery, held.receipt);
    if (stateName === 'signing-local') return signing;
    await recovery.saveSignature(idValue, supplied.record.signature);
    if (stateName === 'ready-local')
      await recovery.saveProof(idValue, {
        transaction: supplied.proof.transaction,
        payload: supplied.proof.payload,
      });
    return ledger.readRelay(recovery, idValue);
  }
  return {
    base,
    row,
    scope,
    controller,
    state,
    events,
    ledgerOptions,
    recoveryOptions,
    stores,
    owned,
    descriptor,
    get ledger() {
      return ledger;
    },
    get recovery() {
      return recovery;
    },
    seed,
    async reopen() {
      ledger.close();
      recovery.close();
      ledger = await createRailgunPrivateReservations({ ...ledgerOptions, create: false });
      recovery = await createRailgunRelayRecoveryStore({ ...recoveryOptions, create: false });
      stores.push(ledger, recovery);
    },
    revoke() {
      live = false;
    },
    files() {
      return [
        getPrivacyStoragePath(ledgerOptions.handle, accountDirectory),
        getPrivacyStoragePath(recoveryOptions.handle, accountDirectory),
      ];
    },
  };
}
beforeEach(async () => {
  f = await setup();
});
afterEach(() => {
  f.stores.forEach((s) => s.close());
  f.scope.close();
  f.controller.abort();
  jest.restoreAllMocks();
});
const list = (after = null) => api.listRailgunAccountRelayOperations({ ...f.base, after });
const discard = (operationId = f.row.id) =>
  api.discardRailgunAccountRelayOperation({ ...f.base, operationId });
const resume = (operationId = f.row.id) =>
  api.resumeRailgunAccountRelayOperation({
    ...f.base,
    operationId,
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
  });
const privateInput = () => ({
  tree: f.row.draft.selection.tree,
  position: f.row.draft.selection.position,
  nullifier: f.row.draft.intent.expected.nullifier,
  noteHash: f.row.draft.noteHash,
  kind: 'railgun-private-transfer',
  intentDigest: '0x' + hex(500),
  checkpointHash: f.row.checkpointHash,
  poiDigest: hex(501),
});
test('real encrypted cold signed custody resumes with original signature and historical generation/root facts untouched', async () => {
  await f.seed();
  await f.reopen();
  expect(f.state.generationId).not.toBe(f.row.generationId);
  expect(f.state.checkpointHash).not.toBe(f.row.checkpointHash);
  const before = await f.recovery.read(f.row.id);
  expect(await resume()).toEqual({ status: 'ready-local', operationId: f.row.id });
  const after = await f.recovery.read(f.row.id);
  expect(digestRailgunRelayLocalIntent(JSON.stringify(after))).toBe(
    digestRailgunRelayLocalIntent(JSON.stringify(before))
  );
  expect(after.signature).toEqual(before.signature);
  expect(after.generationId).toBe(before.generationId);
  expect(f.events).toEqual([
    'A-original-closed',
    'C-original-closed',
    'canonical-refresh',
    'save-proof',
  ]);
});
test('ready-local re-verifies stored proof without producer or any ciphertext rewrite', async () => {
  await f.seed('ready-local');
  await f.reopen();
  const before = f.files().map((p) => fs.readFileSync(p));
  expect((await resume()).status).toBe('ready-local');
  expect(f.events).toEqual(['C-original-closed', 'canonical-refresh']);
  expect(f.files().map((p) => fs.readFileSync(p))).toEqual(before);
});
test.each(['held', 'signing-local'])(
  'resume of %s refuses without signing or custody mutation',
  async (state) => {
    await f.seed(state);
    const before = f.files().map((p) => fs.readFileSync(p));
    expect(await resume()).toMatchObject({ status: 'refused' });
    expect(mock.complete).not.toHaveBeenCalled();
    expect(f.files().map((p) => fs.readFileSync(p))).toEqual(before);
  }
);
test.each(['held', 'signing-local', 'signed', 'ready-local'])(
  'explicit local discard of %s uses genuine tombstone before releasing same-nullifier private conflict',
  async (state) => {
    await f.seed(state);
    await expect(f.ledger.reserve(privateInput())).rejects.toMatchObject({
      code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
    });
    const before = await f.recovery.read(f.row.id);
    const result = await discard();
    expect(result.status).toBe(state === 'held' ? 'cancelled-unsigned' : 'discarded-signed');
    const after = await f.recovery.read(f.row.id);
    expect(after.signature).toEqual(before.signature);
    expect(after.proved).toEqual(before.proved);
    expect((await f.ledger.readRelay(f.recovery, f.row.id)).interruptedStep).toBeNull();
    expect(await f.ledger.reserve(privateInput())).toBeDefined();
  }
);
test('history returns detached selectors only and independently authenticates next page', async () => {
  await f.seed('held', hex(3));
  await discard(hex(3));
  await f.seed('signed', hex(2));
  await discard(hex(2));
  await f.seed('held', hex(1));
  const history = await list();
  expect(history.records.map((v) => v.operationId)).toEqual([hex(1), hex(2), hex(3)]);
  expect(history.nextAfter).toBeNull();
  expect(Object.keys(history.records[0])).toEqual([
    'operationId',
    'reservationState',
    'localState',
    'interruptedStep',
  ]);
  expect(Object.isFrozen(history.records)).toBe(true);
  expect((await list(hex(1))).records.map((v) => v.operationId)).toEqual([hex(2), hex(3)]);
  expect(JSON.stringify(history)).not.toContain('signature');
});
test.each(['walletId', 'binding'])(
  'different current %s refuses before existing-only storage open',
  async (field) => {
    f.state[field] = hex(999);
    await expect(list()).rejects.toMatchObject({ code: 'RAILGUN_RELAY_OPERATION_REFUSED' });
    expect(f.base.owners.enrollment.openReservations).not.toHaveBeenCalled();
  }
);
test('selected owned-note mismatch denies resume but does not rewrite historical record', async () => {
  await f.seed();
  f.owned.ownedPoi[0].nullifier = '0x' + hex(999);
  const before = f.files().map((p) => fs.readFileSync(p));
  expect((await resume()).status).toBe('refused');
  expect(mock.complete).not.toHaveBeenCalled();
  expect(f.files().map((p) => fs.readFileSync(p))).toEqual(before);
});
test('missing registered recovery file fails closed and discovery never recreates it', async () => {
  await f.seed();
  f.recovery.close();
  const recoveryPath = f.files()[1],
    renamed = recoveryPath + '.preserved';
  fs.renameSync(recoveryPath, renamed);
  f.base.owners.enrollment.openRelayRecoveryStore.mockImplementation(async () =>
    createRailgunRelayRecoveryStore({ ...f.recoveryOptions, create: false })
  );
  await expect(list()).rejects.toThrow();
  expect(fs.existsSync(recoveryPath)).toBe(false);
  expect(fs.existsSync(renamed)).toBe(true);
});
test('held original cold proof retains exclusion across abort until settlement', async () => {
  await f.seed();
  const hold = deferred(),
    entered = deferred();
  mock.complete.mockImplementation(async (a, o, { permit }) => {
    const p = api.consumeRailgunRelayProofPermit(permit, a, o);
    entered.resolve();
    await hold.promise;
    p.assertCurrent();
  });
  const work = resume();
  let done = false;
  work.then(() => {
    done = true;
  });
  await entered.promise;
  f.controller.abort();
  await new Promise(setImmediate);
  expect(done).toBe(false);
  expect((await discard()).status).toBe('refused');
  hold.resolve();
  expect((await work).status).toBe('refused');
  expect((await f.recovery.read(f.row.id)).state).toBe('signed');
});
test('unknown original cold child retains exclusion against discard and discovery', async () => {
  await f.seed();
  mock.complete.mockRejectedValue(
    Object.assign(Error('unknown child'), { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' })
  );
  await expect(resume()).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect((await discard()).status).toBe('refused');
  await expect(list()).rejects.toThrow();
  expect((await f.recovery.read(f.row.id)).state).toBe('signed');
});
test('completed deadline cannot renew through repeated cold admission', async () => {
  await f.seed();
  f.state.deadline = performance.now() - 1;
  expect((await resume()).status).toBe('refused');
  expect(mock.complete).not.toHaveBeenCalled();
  expect(f.base.owners.enrollment.openReservations).not.toHaveBeenCalled();
});

test('authenticated ledger-first orphan is discoverable and cancelled only as never-signed', async () => {
  const recoveryPath = f.files()[1],
    rename = fs.renameSync;
  const stop = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === recoveryPath) throw Error('public fixture interrupted append');
    return rename(from, to);
  });
  await expect(f.seed('held')).rejects.toThrow();
  stop.mockRestore();
  await f.reopen();
  expect((await list()).records).toEqual([
    {
      operationId: f.row.id,
      reservationState: 'held',
      localState: 'record-unavailable',
      interruptedStep: 'append-held',
    },
  ]);
  expect(await discard()).toEqual({ status: 'cancelled-unsigned', operationId: f.row.id });
  expect(await f.recovery.lookup(f.row.id)).toBeNull();
  expect(await f.ledger.reserve(privateInput())).toBeDefined();
});
test('interrupted signing marker is repaired only for explicit discard, never resume/resign', async () => {
  const held = await f.seed('held'),
    recoveryPath = f.files()[1],
    rename = fs.renameSync;
  const stop = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === recoveryPath) throw Error('public fixture interrupted marker');
    return rename(from, to);
  });
  await expect(f.ledger.markRelaySigning(f.recovery, held.receipt)).rejects.toThrow();
  stop.mockRestore();
  await f.reopen();
  expect((await list()).records[0].interruptedStep).toBe('mark-recovery-signing');
  expect((await resume()).status).toBe('refused');
  expect(mock.complete).not.toHaveBeenCalled();
  expect(await discard()).toEqual({ status: 'discarded-signed', operationId: f.row.id });
  expect((await f.recovery.read(f.row.id)).signature).toBeNull();
  expect(await f.ledger.reserve(privateInput())).toBeDefined();
});
test('tombstone-first interrupted discard retains conflict until explicit recovery reauthenticates release', async () => {
  await f.seed('signed');
  const ledgerPath = f.files()[0],
    rename = fs.renameSync;
  const stop = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === ledgerPath) throw Error('public fixture interrupted release');
    return rename(from, to);
  });
  expect((await discard()).status).toBe('refused');
  stop.mockRestore();
  await f.reopen();
  const pair = await f.ledger.readRelay(f.recovery, f.row.id);
  expect(pair.interruptedStep).toBe('release-signed');
  expect(pair.record.state).toBe('discarded-signed');
  await expect(f.ledger.reserve(privateInput())).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
  });
  expect(await discard()).toEqual({ status: 'discarded-signed', operationId: f.row.id });
  expect(await f.ledger.reserve(privateInput())).toBeDefined();
});
test('stored-proof C rejection leaves exact retained ciphertexts and signature unchanged', async () => {
  await f.seed('ready-local');
  const before = f.files().map((p) => fs.readFileSync(p));
  mock.complete.mockRejectedValue(Error('proof mismatch'));
  expect((await resume()).status).toBe('refused');
  expect(f.files().map((p) => fs.readFileSync(p))).toEqual(before);
});
test('repeated local discard is idempotent and does not prune history', async () => {
  await f.seed('signed');
  const first = await discard(),
    before = f.files().map((p) => fs.readFileSync(p));
  expect(await discard()).toEqual(first);
  expect(f.files().map((p) => fs.readFileSync(p))).toEqual(before);
  expect((await list()).records[0].localState).toBe('discarded-signed');
});

test('actual cold capability rejects wrong window/owner and cannot replay after original completion', async () => {
  await f.seed();
  const real = mock.complete.getMockImplementation();
  let token;
  mock.complete.mockImplementation(async (a, o, input) => {
    token = input.permit;
    expect(() => api.consumeRailgunRelayProofPermit(token, a, o, {})).toThrow();
    expect(() => api.consumeRailgunRelayProofPermit(token, a, { ...o, identity: {} })).toThrow();
    return real(a, o, input);
  });
  expect((await resume()).status).toBe('ready-local');
  expect(() => api.consumeRailgunRelayProofPermit(token, f.base.account, f.base.owners)).toThrow();
});
test('aborted discovery drains real held floor work and leaves borrowed stores usable', async () => {
  await f.seed();
  const entered = deferred(),
    release = deferred(),
    readFloor = f.ledgerOptions.readFloor;
  let held = false;
  f.ledgerOptions.readFloor = async () => {
    if (held) {
      entered.resolve();
      await release.promise;
    }
    return readFloor();
  };
  await f.reopen();
  held = true;
  const work = list();
  let settled = false;
  work.catch(() => {
    settled = true;
  });
  await entered.promise;
  f.controller.abort();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  await expect(list()).rejects.toThrow();
  release.resolve();
  await expect(work).rejects.toMatchObject({ code: 'RAILGUN_RELAY_OPERATION_REFUSED' });
  held = false;
  expect((await f.ledger.readRelay(f.recovery, f.row.id)).record.state).toBe('signed');
});
