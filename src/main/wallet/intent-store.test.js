const fs = require('fs');
const path = require('path');
const { Wallet, keccak256 } = require('ethers');
const FakeBetterSqlite3PaymentsDatabase = require('../../../test/helpers/fake-better-sqlite3-payments');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../../test/helpers/main-process-test-utils');
const { encodeLine, readJournal } = require('../lib/durable-journal');

// Deterministic test keys (not real wallets)
const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const BOB = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const CHAIN = 100;
const RECIPIENT = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const POSIX = process.platform !== 'win32';

let userDataDir;
let intentId = 0;

beforeEach(() => {
  userDataDir = createTempUserDataDir('intent-store-');
});

afterEach(() => {
  jest.restoreAllMocks();
  removeTempUserDataDir(userDataDir);
});

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

// A fresh module, as after a restart of main: a new run, the same userData.
function start({ limits, extraMocks = {} } = {}) {
  const { mod } = loadMainModule(require.resolve('./intent-store'), {
    userDataDir,
    extraMocks: {
      [require.resolve('../logger')]: () => logger,
      'better-sqlite3': () => FakeBetterSqlite3PaymentsDatabase,
      ...extraMocks,
    },
  });
  const store = limits
    ? mod.createIntentStore({ filePath: path.join(userDataDir, mod.FILE_NAME), limits })
    : mod.getIntentStore();
  // The same module registry as the store's, so the lock tokens agree.
  const reservations = require('./nonce-reservations');
  return { mod, store, reservations };
}

async function started(options) {
  const running = start(options);
  await running.store.load();
  return running;
}

const filePath = () => path.join(userDataDir, 'wallet-intents.jsonl');
const records = async () => (await readJournal(filePath())).records;

function newId() {
  intentId += 1;
  return `intent-${String(intentId).padStart(4, '0')}`;
}

async function sign({
  nonce,
  signer = ALICE,
  chainId = CHAIN,
  to = RECIPIENT,
  value = 1000n,
  maxFeePerGas = 2_000_000_000n,
}) {
  const raw = await signer.signTransaction({
    type: 2,
    chainId,
    nonce,
    to,
    value,
    data: '0x',
    gasLimit: 21000n,
    maxFeePerGas,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  return { raw, hash: keccak256(raw) };
}

// A signed original commit of a new intent, as the send path will make it.
async function commitNew(
  store,
  { nonce, signer = ALICE, key, kind = 'wallet-send', ...rest } = {}
) {
  const { raw, hash } = await sign({ nonce, signer, ...rest });
  return store.commit({
    intentId: newId(),
    chainId: rest.chainId ?? CHAIN,
    sender: signer.address,
    nonce,
    hash,
    raw,
    via: 'original',
    context: { kind, origin: null, key: key ?? null, walletIndex: 0 },
  });
}

async function sendNotSent(store, id) {
  const { handoffId } = await store.handoff(id);
  return store.outcome({ intentId: id, handoffId, outcome: 'not_sent', source: null });
}

function underLock(reservations, intent, fn) {
  return reservations.withAccountLock({ chainId: intent.chainId, sender: intent.sender }, fn);
}

describe('commit', () => {
  test('a raw signed at another nonce, chain or sender, or of another hash, is refused', async () => {
    const { store } = await started();
    const { raw, hash } = await sign({ nonce: 7 });
    const base = {
      intentId: newId(),
      chainId: CHAIN,
      sender: ALICE.address,
      nonce: 7,
      hash,
      raw,
      via: 'original',
      context: { kind: 'wallet-send' },
    };
    const other = await sign({ nonce: 8 });

    const refusals = [
      [{ nonce: 8 }, 'signed at nonce 7, not 8'],
      [{ chainId: 1 }, 'signed for chain 100, not 1'],
      [{ sender: BOB.address }, "not signed by the intent's sender"],
      [{ hash: other.hash }, "does not hash to the intent's hash"],
      [{ raw: other.raw }, 'signed at nonce 8, not 7'],
      [{ raw: '0x02f8' }, 'does not decode'],
    ];
    for (const [change, message] of refusals) {
      await expect(store.commit({ ...base, ...change })).rejects.toMatchObject({
        code: 'INTENT_INVALID',
        message: expect.stringContaining(message),
      });
    }
    // Nothing was written, not even the file.
    expect(fs.existsSync(filePath())).toBe(false);
    expect(store.held()).toEqual([]);
  });

  test('an unsigned transaction and an unsupported type are refused', async () => {
    const { store } = await started();
    const { Transaction } = require('ethers');
    const unsigned = Transaction.from({
      type: 2,
      chainId: CHAIN,
      nonce: 0,
      to: RECIPIENT,
      gasLimit: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    }).unsignedSerialized;
    await expect(
      store.commit({
        intentId: newId(),
        chainId: CHAIN,
        sender: ALICE.address,
        nonce: 0,
        hash: keccak256(unsigned),
        raw: unsigned,
        via: 'original',
        context: { kind: 'wallet-send' },
      })
    ).rejects.toMatchObject({
      code: 'INTENT_INVALID',
      message: expect.stringContaining('not signed'),
    });

    const accessList = await ALICE.signTransaction({
      type: 1,
      chainId: CHAIN,
      nonce: 0,
      to: RECIPIENT,
      gasLimit: 21000n,
      gasPrice: 1n,
    });
    await expect(
      store.commit({
        intentId: newId(),
        chainId: CHAIN,
        sender: ALICE.address,
        nonce: 0,
        hash: keccak256(accessList),
        raw: accessList,
        via: 'original',
        context: { kind: 'wallet-send' },
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('type 1 is not supported') });
  });

  test('commit, then a restart: the intent is held with its hash and raw', async () => {
    const first = await started();
    const { raw, hash } = await sign({ nonce: 7 });
    const id = newId();
    const committed = await first.store.commit({
      intentId: id,
      chainId: CHAIN,
      sender: ALICE.address,
      nonce: 7,
      hash,
      raw,
      via: 'original',
      context: { kind: 'dapp-send', origin: 'https://app.example', key: null, walletIndex: 2 },
    });
    expect(committed).toMatchObject({ intentId: id, state: 'held', recovered: false, hash, raw });

    const { store } = await started();
    expect(store.get(id)).toMatchObject({
      intentId: id,
      chainId: CHAIN,
      sender: ALICE.address.toLowerCase(),
      nonce: 7,
      state: 'held',
      recovered: true,
      hash,
      raw,
      hashes: [{ hash, raw, via: 'original' }],
      context: { kind: 'dapp-send', origin: 'https://app.example', key: null, walletIndex: 2 },
      fields: {
        type: 2,
        to: RECIPIENT.toLowerCase(),
        value: '1000',
        data: '0x',
        gasLimit: '21000',
        maxFeePerGas: '2000000000',
        maxPriorityFeePerGas: '1000000000',
        gasPrice: null,
      },
    });
    expect(store.heldNonces(CHAIN, ALICE.address)).toEqual([7]);
    expect(store.held().map((intent) => intent.intentId)).toEqual([id]);
  });

  test('the commit is on disk when it resolves, with this run on the line', async () => {
    const { store, mod } = await started();
    const intent = await commitNew(store, { nonce: 0 });
    const [line] = await records();
    expect(line).toMatchObject({
      type: 'commit',
      run: mod.RUN_ID,
      intent_id: intent.intentId,
      chain_id: CHAIN,
      sender: ALICE.address.toLowerCase(),
      nonce: 0,
      hash: intent.hash,
      raw: intent.raw,
      via: 'original',
      context: { kind: 'wallet-send', origin: null, key: null, wallet_index: 0 },
      fields: expect.objectContaining({ type: 2, gas_limit: '21000' }),
    });
    if (POSIX) expect(fs.statSync(filePath()).mode & 0o777).toBe(0o600);

    // The next run writes its own run id.
    const next = await started();
    await sendNotSent(next.store, intent.intentId);
    const lines = await records();
    expect(next.mod.RUN_ID).not.toBe(mod.RUN_ID);
    expect(lines.slice(1).map((record) => record.run)).toEqual([next.mod.RUN_ID, next.mod.RUN_ID]);
  });

  test("a new intent must go above the account's held nonces, and keys stay unique", async () => {
    const { store } = await started();
    await commitNew(store, { nonce: 5, key: 'safe-exec:100:0xabc' });
    await expect(commitNew(store, { nonce: 5 })).rejects.toMatchObject({
      message: expect.stringContaining('not above'),
    });
    await expect(commitNew(store, { nonce: 4 })).rejects.toMatchObject({ code: 'INTENT_INVALID' });
    await expect(commitNew(store, { nonce: 6, key: 'safe-exec:100:0xabc' })).rejects.toMatchObject({
      message: expect.stringContaining('same key'),
    });
    // Other accounts have their own nonces.
    await expect(commitNew(store, { nonce: 0, signer: BOB })).resolves.toMatchObject({ nonce: 0 });
    expect(store.byKey('safe-exec:100:0xabc')).toMatchObject({ nonce: 5 });
    expect(store.byKey('safe-exec:100:0xdef')).toBeNull();
  });

  test('a replacement keeps the nonce and the payment; anything else is refused', async () => {
    const { store } = await started();
    const intent = await commitNew(store, { nonce: 3 });
    const bump = await sign({ nonce: 3, maxFeePerGas: 3_000_000_000n });
    const replace = (signed, change = {}) =>
      store.commit({
        intentId: intent.intentId,
        chainId: CHAIN,
        sender: ALICE.address,
        nonce: 3,
        ...signed,
        via: 'replacement',
        ...change,
      });

    const replaced = await replace(bump);
    expect(replaced.hashes.map((entry) => entry.hash)).toEqual([intent.hash, bump.hash]);
    expect(replaced).toMatchObject({ hash: bump.hash, raw: bump.raw, nonce: 3 });

    // One nonce per intent, for good.
    const elsewhere = await sign({ nonce: 4, maxFeePerGas: 4_000_000_000n });
    await expect(replace(elsewhere, { nonce: 4 })).rejects.toMatchObject({
      message: expect.stringContaining('must keep its chain, sender and nonce'),
    });
    const otherPayment = await sign({ nonce: 3, value: 5n, maxFeePerGas: 5_000_000_000n });
    await expect(replace(otherPayment)).rejects.toMatchObject({
      message: expect.stringContaining('must pay what the original pays'),
    });
    await expect(replace(bump)).rejects.toMatchObject({
      message: expect.stringContaining('already committed'),
    });
    await expect(
      store.commit({
        intentId: 'nobody-here',
        chainId: CHAIN,
        sender: ALICE.address,
        nonce: 3,
        ...bump,
        via: 'replacement',
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('unknown intent') });
  });
});

describe('handoffs and outcomes', () => {
  test('a handoff names the bytes to send; its outcome is recorded against it', async () => {
    const { store } = await started();
    const intent = await commitNew(store, { nonce: 0 });
    const handoff = await store.handoff(intent.intentId);
    expect(handoff).toEqual({
      handoffId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      hash: intent.hash,
      raw: intent.raw,
    });
    const after = await store.outcome({
      intentId: intent.intentId,
      handoffId: handoff.handoffId,
      outcome: 'uncertain',
      source: 'myotis',
    });
    expect(after.handoffs).toEqual([
      {
        handoffId: handoff.handoffId,
        hash: intent.hash,
        at: expect.any(Number),
        outcome: {
          outcome: 'uncertain',
          source: 'myotis',
          reasonClass: null,
          at: expect.any(Number),
        },
      },
    ]);
    // One outcome per handoff.
    await expect(
      store.outcome({
        intentId: intent.intentId,
        handoffId: handoff.handoffId,
        outcome: 'not_sent',
      })
    ).rejects.toMatchObject({ message: expect.stringContaining('already has its outcome') });
    await expect(
      store.outcome({ intentId: intent.intentId, handoffId: handoff.handoffId, outcome: 'lost' })
    ).rejects.toMatchObject({ code: 'INTENT_INVALID' });
  });

  test('open handoffs per intent are bounded; finished ones are not', async () => {
    const { store } = await started({ limits: { openHandoffsPerIntent: 2 } });
    const intent = await commitNew(store, { nonce: 0 });
    const first = await store.handoff(intent.intentId);
    await store.handoff(intent.intentId);
    await expect(store.handoff(intent.intentId)).rejects.toMatchObject({
      code: 'INTENT_HANDOFF_LIMIT',
    });
    await store.outcome({ intentId: intent.intentId, handoffId: first.handoffId, outcome: 'sent' });
    await expect(store.handoff(intent.intentId)).resolves.toMatchObject({ hash: intent.hash });
  });
});

describe('settle and void', () => {
  test('a settlement survives a restart, and its bytes are dropped from the file', async () => {
    const first = await started();
    const paid = await commitNew(first.store, { nonce: 0 });
    const taken = await commitNew(first.store, { nonce: 1 });
    const kept = await commitNew(first.store, { nonce: 2 });
    await first.store.settle({
      intentId: paid.intentId,
      label: 'paid',
      hash: paid.hash,
      block: 120,
    });
    const settled = await first.store.settle({
      intentId: taken.intentId,
      label: 'taken',
      hash: null,
      block: 121,
    });
    expect(settled).toMatchObject({
      state: 'settled',
      raw: null,
      fields: null,
      settlement: { label: 'taken', hash: null, block: 121 },
    });
    await expect(
      first.store.settle({ intentId: kept.intentId, label: 'paid', hash: paid.hash, block: 1 })
    ).rejects.toMatchObject({ message: expect.stringContaining('is not committed to intent') });
    await expect(first.store.handoff(paid.intentId)).rejects.toMatchObject({
      code: 'INTENT_NOT_HELD',
      message: 'This payment is already settled.',
    });

    const { store } = await started();
    expect(store.heldNonces(CHAIN, ALICE.address)).toEqual([2]);
    expect(store.held().map((intent) => intent.intentId)).toEqual([kept.intentId]);
    expect(store.get(paid.intentId)).toMatchObject({ state: 'settled', raw: null });
    // Startup compaction left tombstones of the settled ones, without bytes.
    expect((await records()).map((record) => [record.type, record.intent_id])).toEqual([
      ['tombstone', paid.intentId],
      ['tombstone', taken.intentId],
      ['held', kept.intentId],
    ]);
    expect(fs.readFileSync(filePath(), 'utf8')).not.toContain(paid.raw.slice(2));
  });

  test('a void survives a restart, also when its compaction failed', async () => {
    const first = await started();
    const voided = await commitNew(first.store, { nonce: 4 });
    const fsp = require('fs/promises');
    jest
      .spyOn(fsp, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    const result = await underLock(first.reservations, voided, (lock) =>
      first.store.void(voided.intentId, lock)
    );
    expect(result).toMatchObject({ state: 'voided', raw: null, voidedAt: expect.any(Number) });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Compaction after a void failed')
    );
    // The void line is in the file; the bytes are still there until compaction.
    expect((await records()).map((record) => record.type)).toEqual(['commit', 'void']);

    const { store } = await started();
    expect(store.get(voided.intentId)).toMatchObject({ state: 'voided', raw: null });
    expect(store.heldNonces(CHAIN, ALICE.address)).toEqual([]);
    expect(await records()).toEqual([
      expect.objectContaining({ type: 'tombstone', intent_id: voided.intentId, closed: 'voided' }),
    ]);
    expect(fs.readFileSync(filePath(), 'utf8')).not.toContain(voided.raw.slice(2));
  });

  test("voiding needs the account's lock token", async () => {
    const { store, reservations } = await started();
    const intent = await commitNew(store, { nonce: 0 });
    await expect(store.void(intent.intentId)).rejects.toMatchObject({
      code: 'INTENT_LOCK_REQUIRED',
    });
    await expect(
      store.void(intent.intentId, { chainId: CHAIN, sender: intent.sender })
    ).rejects.toMatchObject({
      code: 'INTENT_LOCK_REQUIRED',
    });
    await expect(
      reservations.withAccountLock({ chainId: CHAIN, sender: BOB.address }, (lock) =>
        store.void(intent.intentId, lock)
      )
    ).rejects.toMatchObject({ code: 'INTENT_LOCK_REQUIRED' });
    let stale;
    await underLock(reservations, intent, (lock) => {
      stale = lock;
    });
    await expect(store.void(intent.intentId, stale)).rejects.toMatchObject({
      code: 'INTENT_LOCK_REQUIRED',
    });
    expect(store.get(intent.intentId).state).toBe('held');
  });

  test('an intent with no handoffs, created in this run, can be voided: nothing was sent', async () => {
    const { store, reservations } = await started();
    const intent = await commitNew(store, { nonce: 0 });
    expect(store.voidRefusal(intent.intentId)).toBeNull();
    await expect(
      underLock(reservations, intent, (lock) => store.void(intent.intentId, lock))
    ).resolves.toMatchObject({ state: 'voided' });
    // Final.
    await expect(
      underLock(reservations, intent, (lock) => store.void(intent.intentId, lock))
    ).rejects.toMatchObject({ code: 'INTENT_NOT_HELD', message: 'This payment was voided.' });
  });

  test.each(['sent', 'uncertain', 'rejected'])(
    'a handoff that ended %s keeps the record',
    async (outcome) => {
      const { store, reservations } = await started();
      const intent = await commitNew(store, { nonce: 0 });
      await sendNotSent(store, intent.intentId);
      const { handoffId } = await store.handoff(intent.intentId);
      await store.outcome({ intentId: intent.intentId, handoffId, outcome });
      await expect(
        underLock(reservations, intent, (lock) => store.void(intent.intentId, lock))
      ).rejects.toMatchObject({
        code: 'INTENT_VOID_REFUSED',
        message: expect.stringContaining(`a handoff ended ${outcome}`),
      });
    }
  );

  test('a handoff with no outcome keeps the record', async () => {
    const { store, reservations } = await started();
    const intent = await commitNew(store, { nonce: 0 });
    await store.handoff(intent.intentId);
    await expect(
      underLock(reservations, intent, (lock) => store.void(intent.intentId, lock))
    ).rejects.toMatchObject({ message: expect.stringContaining('no recorded outcome') });
  });

  test('a lost first reply, a restart, then a later not_sent: never voidable', async () => {
    const first = await started();
    const intent = await commitNew(first.store, { nonce: 0 });
    const lost = await first.store.handoff(intent.intentId);
    // Main dies before the reply is recorded.

    const { store, reservations } = await started();
    // That handoff's outcome can't be recorded by a later run: it was folded
    // into the summary as possibly sent.
    await expect(
      store.outcome({ intentId: intent.intentId, handoffId: lost.handoffId, outcome: 'not_sent' })
    ).rejects.toMatchObject({ message: expect.stringContaining('unknown handoff') });
    expect(store.get(intent.intentId)).toMatchObject({ handoffCount: 1, possiblySent: true });
    // Sent again in this run, and that one provably wasn't sent.
    await sendNotSent(store, intent.intentId);

    expect(store.voidRefusal(intent.intentId)).toMatch(/recovered from disk/);
    await expect(
      underLock(reservations, intent, (lock) => store.void(intent.intentId, lock))
    ).rejects.toMatchObject({ code: 'INTENT_VOID_REFUSED' });
  });

  test('an intent recovered at startup is never voidable, even with every handoff not_sent', async () => {
    const first = await started();
    const intent = await commitNew(first.store, { nonce: 0 });
    await sendNotSent(first.store, intent.intentId);
    await sendNotSent(first.store, intent.intentId);
    expect(first.store.voidRefusal(intent.intentId)).toBeNull();

    const { store, reservations } = await started();
    expect(store.get(intent.intentId).recovered).toBe(true);
    await expect(
      underLock(reservations, intent, (lock) => store.void(intent.intentId, lock))
    ).rejects.toMatchObject({
      code: 'INTENT_VOID_REFUSED',
      message: expect.stringContaining('recovered from disk'),
    });
    expect(store.held()).toHaveLength(1);
  });

  test('A@7 and B@8 held: voiding A is refused; B first, then A', async () => {
    const { store, reservations } = await started();
    const a = await commitNew(store, { nonce: 7 });
    const b = await commitNew(store, { nonce: 8 });
    await sendNotSent(store, a.intentId);

    await expect(
      underLock(reservations, a, (lock) => store.void(a.intentId, lock))
    ).rejects.toMatchObject({
      code: 'INTENT_VOID_REFUSED',
      message: expect.stringContaining(`held intent ${b.intentId} has a higher nonce`),
    });
    await underLock(reservations, b, (lock) => store.void(b.intentId, lock));
    await underLock(reservations, a, (lock) => store.void(a.intentId, lock));
    expect(store.heldNonces(CHAIN, ALICE.address)).toEqual([]);
  });

  test('a void and a resend racing for the lock: the resend refuses the voided intent', async () => {
    const { store, reservations } = await started();
    const intent = await commitNew(store, { nonce: 0 });
    let resendRan = false;

    const voiding = underLock(reservations, intent, async (lock) => {
      // The resend is already waiting for the lock.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return store.void(intent.intentId, lock);
    });
    const resend = underLock(reservations, intent, async () => {
      resendRan = true;
      const current = store.get(intent.intentId);
      expect(current).toMatchObject({ state: 'voided', raw: null });
      return store.handoff(intent.intentId);
    });

    await expect(voiding).resolves.toMatchObject({ state: 'voided' });
    await expect(resend).rejects.toMatchObject({
      code: 'INTENT_NOT_HELD',
      message: 'This payment was voided.',
    });
    expect(resendRan).toBe(true);
    // Nor can a replacement revive it.
    const bump = await sign({ nonce: 0, maxFeePerGas: 9_000_000_000n });
    await expect(
      store.commit({
        intentId: intent.intentId,
        chainId: CHAIN,
        sender: ALICE.address,
        nonce: 0,
        ...bump,
        via: 'replacement',
      })
    ).rejects.toMatchObject({ code: 'INTENT_NOT_HELD' });
  });

  test('a resend that wins the lock first keeps the intent: its handoff is open', async () => {
    const { store, reservations } = await started();
    const intent = await commitNew(store, { nonce: 0 });
    const resend = underLock(reservations, intent, () => store.handoff(intent.intentId));
    const voiding = underLock(reservations, intent, (lock) => store.void(intent.intentId, lock));
    await expect(resend).resolves.toMatchObject({ hash: intent.hash });
    await expect(voiding).rejects.toMatchObject({ code: 'INTENT_VOID_REFUSED' });
  });

  test('an eligible void in this run frees the nonce: the next reservation gets N', async () => {
    const { store, reservations } = await started();
    const readPending = async () => 7;
    const account = { chainId: CHAIN, sender: ALICE.address, readPending, store };

    const intent = await reservations.reserve(account, (nonce) => commitNew(store, { nonce }));
    expect(intent.nonce).toBe(7);
    expect(await reservations.reserve(account, async (nonce) => nonce)).toBe(8);

    await sendNotSent(store, intent.intentId);
    await underLock(reservations, intent, (lock) => store.void(intent.intentId, lock));

    expect(await reservations.reserve(account, async (nonce) => nonce)).toBe(7);
    // The voided intent's bytes are gone from the file too: a tombstone stays.
    expect((await records()).map((record) => record.type)).toEqual(['tombstone']);
    expect(fs.readFileSync(filePath(), 'utf8')).not.toContain(intent.raw.slice(2));
  });
});

describe('loading', () => {
  test('a missing file behaves as a restore: nothing held, nothing to send again', async () => {
    const { store, reservations } = await started();
    expect(store.quarantined).toBeNull();
    expect(store.held()).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(store.byKey('safe-deploy:100:0xabc')).toBeNull();
    expect(store.heldNonces(CHAIN, ALICE.address)).toEqual([]);
    expect(fs.existsSync(filePath())).toBe(false);
    const nonce = await reservations.reserve(
      { chainId: CHAIN, sender: ALICE.address, readPending: async () => 12, store },
      async (n) => n
    );
    expect(nonce).toBe(12);
  });

  test('a damaged file is moved aside, and the store starts empty', async () => {
    const first = await started();
    const intent = await commitNew(first.store, { nonce: 0 });
    await commitNew(first.store, { nonce: 1 });
    const bytes = fs.readFileSync(filePath(), 'utf8');
    const lines = bytes.split('\n');
    lines[0] = lines[0].replace('"nonce":0', '"nonce":9');
    const damaged = lines.join('\n');
    fs.writeFileSync(filePath(), damaged);

    const { store } = await started();
    const quarantined = store.quarantined;
    expect(quarantined).toEqual({
      path: expect.stringMatching(/wallet-intents\.jsonl\.corrupt-\d+$/),
      at: expect.any(Number),
      reason: expect.stringContaining('1 damaged line(s), the first at line 1'),
    });
    expect(fs.readFileSync(quarantined.path, 'utf8')).toBe(damaged);
    expect(fs.existsSync(filePath())).toBe(false);
    expect(store.held()).toEqual([]);
    expect(store.get(intent.intentId)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('were damaged'));

    // It works again from empty.
    await commitNew(store, { nonce: 0 });
    expect(await records()).toHaveLength(1);
  });

  test('a well-formed line that breaks the rules quarantines the file too', async () => {
    const first = await started();
    const intent = await commitNew(first.store, { nonce: 3 });
    // A replacement at another nonce: the rule itself.
    const elsewhere = await sign({ nonce: 4 });
    const [commit] = await records();
    fs.appendFileSync(
      filePath(),
      encodeLine({
        ...commit,
        via: 'replacement',
        nonce: 4,
        hash: elsewhere.hash,
        raw: elsewhere.raw.toLowerCase(),
      })
    );

    const { store } = await started();
    expect(store.quarantined.reason).toContain('must keep its chain, sender and nonce');
    expect(store.get(intent.intentId)).toBeNull();
  });

  test('a void line its own run could not have written quarantines the file', async () => {
    const first = await started();
    const intent = await commitNew(first.store, { nonce: 0 });
    await sendNotSent(first.store, intent.intentId);
    // A void from another run: that run never saw the intent's handoff.
    fs.appendFileSync(
      filePath(),
      encodeLine({ type: 'void', run: 'another-run-of-main', at: 1, intent_id: intent.intentId })
    );

    const { store } = await started();
    expect(store.quarantined.reason).toContain('not all of it happened in this run of main');
    expect(store.held()).toEqual([]);
  });

  test('a torn last line is dropped quietly, without quarantine', async () => {
    const first = await started();
    const intent = await commitNew(first.store, { nonce: 0 });
    fs.appendFileSync(filePath(), '{"v":1,"sha256":"00');

    const { store } = await started();
    expect(store.quarantined).toBeNull();
    expect(store.get(intent.intentId)).toMatchObject({ state: 'held' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unfinished last line'));
    expect((await readJournal(filePath())).tornTail).toBe(0);
  });

  test('reads wait for the load; writes start it', async () => {
    const { store } = start();
    expect(() => store.held()).toThrow(
      expect.objectContaining({ code: 'INTENT_STORE_UNAVAILABLE' })
    );
    const intent = await commitNew(store, { nonce: 0 });
    expect(store.get(intent.intentId)).toMatchObject({ state: 'held' });
  });

  test('a load that fails leaves the store unavailable, and is tried again', async () => {
    const fsp = require('fs/promises');
    const { store } = start();
    jest
      .spyOn(fsp, 'readdir')
      .mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(store.load()).rejects.toMatchObject({ code: 'INTENT_STORE_UNAVAILABLE' });
    await expect(commitNew(store, { nonce: 0 })).resolves.toMatchObject({ state: 'held' });
  });

  test('a write that fails records nothing and applies nothing', async () => {
    const { store } = await started();
    const fsp = require('fs/promises');
    jest
      .spyOn(fsp, 'open')
      .mockRejectedValueOnce(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    await expect(commitNew(store, { nonce: 0 })).rejects.toMatchObject({
      code: 'INTENT_WRITE_FAILED',
    });
    expect(store.held()).toEqual([]);
    expect(fs.existsSync(filePath())).toBe(false);
  });
});

describe('bounds', () => {
  test('32 held intents per account; the 33rd is refused with a clear error', async () => {
    const { store } = await started();
    for (let nonce = 0; nonce < 32; nonce += 1) await commitNew(store, { nonce });
    await expect(commitNew(store, { nonce: 32 })).rejects.toMatchObject({
      code: 'INTENT_ACCOUNT_LIMIT',
      message:
        'This account already has 32 payments waiting to confirm. ' +
        'Wait for some of them before sending another.',
    });
    // Other accounts are not affected, and a settled intent makes room.
    await expect(commitNew(store, { nonce: 0, signer: BOB })).resolves.toBeTruthy();
    const oldest = store.held().find((intent) => intent.sender === ALICE.address.toLowerCase());
    await store.settle({ intentId: oldest.intentId, label: 'paid', hash: oldest.hash, block: 9 });
    await expect(commitNew(store, { nonce: 32 })).resolves.toMatchObject({ nonce: 32 });
  });

  test('a new intent past the budget is refused, after compaction has tried to make room', async () => {
    // One small intent's budget, measured.
    const scratch = await started();
    await commitNew(scratch.store, { nonce: 0 });
    const perIntent = scratch.store.usage().budget;
    fs.rmSync(filePath());

    // Room for two intents' budgets, not three.
    const { store } = await started({ limits: { journalBytes: Math.floor(perIntent * 2.5) } });
    const first = await commitNew(store, { nonce: 0 });
    await commitNew(store, { nonce: 1 });
    const size = fs.statSync(filePath()).size;
    await expect(commitNew(store, { nonce: 2 })).rejects.toMatchObject({
      code: 'INTENT_STORE_FULL',
      message: expect.stringContaining('are full'),
    });
    expect(fs.statSync(filePath()).size).toBe(size);

    // Settling one turns its budget into a tombstone's: room for one more.
    await store.settle({ intentId: first.intentId, label: 'paid', hash: first.hash, block: 1 });
    await expect(commitNew(store, { nonce: 2 })).resolves.toMatchObject({ nonce: 2 });
    expect(fs.statSync(filePath()).size).toBeLessThanOrEqual(Math.floor(perIntent * 2.5));
  });

  test('a transaction too large for any txpool is refused', async () => {
    const { store } = await started({ limits: { rawBytes: 100 } });
    await expect(commitNew(store, { nonce: 0 })).rejects.toMatchObject({
      code: 'INTENT_TOO_LARGE',
    });
  });
});

describe('separate from payment history', () => {
  test('payment-history.clear() leaves the intent records intact', async () => {
    const { store } = await started();
    const intent = await commitNew(store, { nonce: 0 });
    const before = fs.readFileSync(filePath());

    const paymentHistory = require('../payment-history');
    paymentHistory.append({
      kind: 'wallet-send',
      chainId: CHAIN,
      txHash: intent.hash,
      amount: '1000',
    });
    expect(paymentHistory.clear()).toBe(1);
    expect(paymentHistory.getCount()).toBe(0);
    paymentHistory.closeDb();

    expect(fs.readFileSync(filePath())).toEqual(before);
    const next = await started();
    expect(next.store.get(intent.intentId)).toMatchObject({ state: 'held', raw: intent.raw });
  });

  test('main loads the records at startup, near the other wallet stores', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const load = source.indexOf('getIntentStore()');
    expect(load).toBeGreaterThan(source.indexOf('registerWalletIpc();'));
    expect(source.slice(load, load + 120)).toContain('.load()');
  });

  test('neither payment history nor the vault code knows the file', () => {
    for (const file of ['../payment-history.js', '../identity-manager.js', './vault-access.js']) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/wallet-intents|intent-store/);
    }
  });
});

describe('review fixes (#702)', () => {
  const EIO = () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
  const voidUnderLock = (running, intent) =>
    underLock(running.reservations, intent, (lock) => running.store.void(intent.intentId, lock));

  describe('702-M1, durability HIGH: closed is final, across reloads and compactions', () => {
    test.each(['voided', 'settled'])('a %s id is never committed or sent again', async (closed) => {
      let running = await started();
      const intent = await commitNew(running.store, { nonce: 7 });
      if (closed === 'voided') {
        await voidUnderLock(running, intent);
      } else {
        await running.store.settle({
          intentId: intent.intentId,
          label: 'paid',
          hash: intent.hash,
          block: 1,
        });
      }
      await running.store.compact();
      const elsewhere = await sign({ nonce: 8 });
      const bump = await sign({ nonce: 7, maxFeePerGas: 3_000_000_000n });

      for (let restart = 0; restart < 3; restart += 1) {
        running = await started();
        await running.store.compact();
        expect(running.store.quarantined).toBeNull();
        expect(running.store.get(intent.intentId)).toMatchObject({ state: closed, raw: null });
        // The reviewer's probe: the same id as a new original at another nonce.
        await expect(
          running.store.commit({
            intentId: intent.intentId,
            chainId: CHAIN,
            sender: ALICE.address,
            nonce: 8,
            ...elsewhere,
            via: 'original',
            context: { kind: 'wallet-send' },
          })
        ).rejects.toMatchObject({
          code: 'INTENT_INVALID',
          message: expect.stringContaining('already committed'),
        });
        await expect(
          running.store.commit({
            intentId: intent.intentId,
            chainId: CHAIN,
            sender: ALICE.address,
            nonce: 7,
            ...bump,
            via: 'replacement',
          })
        ).rejects.toMatchObject({ code: 'INTENT_NOT_HELD' });
        await expect(running.store.handoff(intent.intentId)).rejects.toMatchObject({
          code: 'INTENT_NOT_HELD',
        });
      }
      expect(await records()).toEqual([
        expect.objectContaining({ type: 'tombstone', intent_id: intent.intentId, closed }),
      ]);
    });

    test('a late outcome after settlement and compaction is ignored, and the file stays sound', async () => {
      // The durability review's probe.
      const first = await started();
      const a = await commitNew(first.store, { nonce: 0 });
      const handoff = await first.store.handoff(a.intentId);
      await first.store.settle({ intentId: a.intentId, label: 'paid', hash: a.hash, block: 10 });
      await first.store.compact();
      const b = await commitNew(first.store, { nonce: 1 });
      const before = fs.readFileSync(filePath());

      await expect(
        first.store.outcome({ intentId: a.intentId, handoffId: handoff.handoffId, outcome: 'sent' })
      ).resolves.toMatchObject({ state: 'settled' });
      expect(fs.readFileSync(filePath())).toEqual(before);

      const { store } = await started();
      expect(store.quarantined).toBeNull();
      expect(store.held().map((intent) => intent.intentId)).toEqual([b.intentId]);
    });

    test('a late outcome before compaction is ignored too', async () => {
      const first = await started();
      const a = await commitNew(first.store, { nonce: 0 });
      const handoff = await first.store.handoff(a.intentId);
      await first.store.settle({ intentId: a.intentId, label: 'paid', hash: a.hash, block: 10 });
      await first.store.outcome({
        intentId: a.intentId,
        handoffId: handoff.handoffId,
        outcome: 'sent',
      });
      expect((await records()).map((record) => record.type)).toEqual([
        'commit',
        'handoff',
        'settle',
      ]);
      const { store } = await started();
      expect(store.quarantined).toBeNull();
    });
  });

  describe('702-M2: a whole last record whose newline was lost', () => {
    test.each(['void', 'settle'])(
      'a terminal %s still closes the intent on reload',
      async (kind) => {
        const first = await started();
        const intent = await commitNew(first.store, { nonce: 7 });
        if (kind === 'void') {
          // Its compaction fails, so the void line stays the file's last.
          jest.spyOn(require('fs/promises'), 'rename').mockRejectedValueOnce(EIO());
          await voidUnderLock(first, intent);
        } else {
          await first.store.settle({
            intentId: intent.intentId,
            label: 'taken',
            hash: null,
            block: 3,
          });
        }
        const bytes = fs.readFileSync(filePath());
        expect((await records()).at(-1).type).toBe(kind);
        fs.writeFileSync(filePath(), bytes.subarray(0, bytes.length - 1));

        const { store } = await started();
        expect(store.quarantined).toBeNull();
        expect(store.get(intent.intentId)).toMatchObject({
          state: kind === 'void' ? 'voided' : 'settled',
          raw: null,
        });
        await expect(store.handoff(intent.intentId)).rejects.toMatchObject({
          code: 'INTENT_NOT_HELD',
        });
      }
    );
  });

  describe('702-M3, durability MEDIUM: the file never outgrows what the reader takes', () => {
    test('64 handoffs of one intent keep the file within journalBytes, and it reloads', async () => {
      // The durability review's probe, at production's ratio of the bounds.
      const limits = { journalBytes: 6000, readBytes: 48000 };
      const first = await started({ limits });
      const intent = await commitNew(first.store, { nonce: 0 });
      for (let n = 0; n < 64; n += 1) {
        await sendNotSent(first.store, intent.intentId);
        expect(fs.statSync(filePath()).size).toBeLessThanOrEqual(limits.journalBytes);
      }

      const { store } = await started({ limits });
      expect(store.quarantined).toBeNull();
      expect(store.get(intent.intentId)).toMatchObject({ state: 'held', handoffCount: 64 });
    });

    test('a bound too small for an intent refuses the intent, and loses nothing', async () => {
      // The safety review's scaled limits: no room for even one intent's budget.
      const limits = { journalBytes: 2000, readBytes: 4000 };
      const { store } = await started({ limits });
      await expect(commitNew(store, { nonce: 7 })).rejects.toMatchObject({
        code: 'INTENT_STORE_FULL',
      });
      expect(fs.existsSync(filePath())).toBe(false);
    });

    test('random operations keep the file within journalBytes, and every reload is clean', async () => {
      // Deterministic pseudo-random walk over commits, sends, outcomes,
      // replacements, settlements, voids and restarts, at a bound tight
      // enough to make compaction and refusals happen often.
      let seed = 702;
      const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const limits = { journalBytes: 24000, readBytes: 192000 };
      const signers = [ALICE, BOB];
      const nextNonce = new Map(signers.map((signer) => [signer.address, 0]));
      const open = new Map();
      let running = await started({ limits });
      let refused = 0;

      for (let step = 0; step < 220; step += 1) {
        const held = running.store.held();
        const pick = random();
        const intent = held.length ? held[Math.floor(random() * held.length)] : null;
        try {
          if (pick < 0.3 || !intent) {
            const signer = signers[Math.floor(random() * signers.length)];
            const nonce = nextNonce.get(signer.address);
            await commitNew(running.store, { nonce, signer });
            nextNonce.set(signer.address, nonce + 1);
          } else if (pick < 0.65) {
            const handoff = await running.store.handoff(intent.intentId);
            if (random() < 0.85) {
              const outcomes = ['sent', 'uncertain', 'rejected', 'not_sent'];
              await running.store.outcome({
                intentId: intent.intentId,
                handoffId: handoff.handoffId,
                outcome: outcomes[Math.floor(random() * outcomes.length)],
              });
            } else {
              open.set(handoff.handoffId, intent.intentId);
            }
          } else if (pick < 0.72) {
            const signer = signers.find((s) => s.address.toLowerCase() === intent.sender);
            const bump = await sign({
              nonce: intent.nonce,
              signer,
              maxFeePerGas: BigInt(3_000_000_000 + step),
            });
            await running.store.commit({
              intentId: intent.intentId,
              chainId: CHAIN,
              sender: intent.sender,
              nonce: intent.nonce,
              ...bump,
              via: 'replacement',
            });
          } else if (pick < 0.85) {
            await running.store.settle({
              intentId: intent.intentId,
              label: 'taken',
              hash: null,
              block: step,
            });
          } else if (pick < 0.93) {
            await voidUnderLock(running, intent);
          } else {
            running = await started({ limits });
            expect(running.store.quarantined).toBeNull();
            open.clear();
          }
        } catch (error) {
          expect(error.code).toMatch(
            /^INTENT_(STORE_FULL|VOID_REFUSED|REPLACEMENT_LIMIT|HANDOFF_LIMIT|ACCOUNT_LIMIT)$/
          );
          refused += 1;
        }
        if (fs.existsSync(filePath())) {
          expect(fs.statSync(filePath()).size).toBeLessThanOrEqual(limits.journalBytes);
        }
      }
      expect(refused).toBeGreaterThan(0);
      const { store } = await started({ limits });
      expect(store.quarantined).toBeNull();
    });

    test('the arithmetic: the reader cap is above anything the store can write', () => {
      const { mod } = start();
      const { LIMITS, LINE_MAX } = mod;
      // The file never exceeds journalBytes (`budget` in intent-store.js).
      // Even a file written under other bounds, at journalBytes, can only
      // grow by the lines still owed to it before its first compaction.
      const owedMax =
        LIMITS.held * (LINE_MAX.terminal + LIMITS.openHandoffsPerIntent * LINE_MAX.outcome);
      expect(LIMITS.journalBytes + owedMax).toBeLessThan(LIMITS.readBytes);
      // 256 × (403 + 8 × 686) = 1,508,096 bytes: 8 MiB + 1.44 MiB < 16 MiB.
      expect(LINE_MAX).toEqual({ handoff: 442, outcome: 686, terminal: 403 });
      expect(owedMax).toBe(1_508_096);
    });
  });

  describe('702-M4: no lifetime cap strands a nonce', () => {
    test('64 not_sent handoffs and a restart: send again and a replacement still work', async () => {
      // The safety review's probe.
      const first = await started();
      const intent = await commitNew(first.store, { nonce: 7 });
      for (let n = 0; n < 64; n += 1) await sendNotSent(first.store, intent.intentId);

      const running = await started();
      expect(running.store.get(intent.intentId)).toMatchObject({
        recovered: true,
        handoffCount: 64,
        possiblySent: false,
      });
      await expect(running.store.handoff(intent.intentId)).resolves.toMatchObject({
        raw: intent.raw,
      });
      await expect(voidUnderLock(running, intent)).rejects.toMatchObject({
        code: 'INTENT_VOID_REFUSED',
      });
      const bump = await sign({ nonce: 7, maxFeePerGas: 3_000_000_000n });
      await running.store.commit({
        intentId: intent.intentId,
        chainId: CHAIN,
        sender: ALICE.address,
        nonce: 7,
        ...bump,
        via: 'replacement',
      });
      await expect(running.store.handoff(intent.intentId)).resolves.toMatchObject({
        hash: bump.hash,
        raw: bump.raw,
      });
    });

    test('replacements per intent are bounded', async () => {
      const { store } = await started({ limits: { hashesPerIntent: 2 } });
      const intent = await commitNew(store, { nonce: 0 });
      const replace = async (fee) =>
        store.commit({
          intentId: intent.intentId,
          chainId: CHAIN,
          sender: ALICE.address,
          nonce: 0,
          ...(await sign({ nonce: 0, maxFeePerGas: fee })),
          via: 'replacement',
        });
      await replace(3_000_000_000n);
      await expect(replace(4_000_000_000n)).rejects.toMatchObject({
        code: 'INTENT_REPLACEMENT_LIMIT',
      });
    });
  });

  describe('702-M5: reload recovers the signer', () => {
    test('bytes signed by another account than the record names quarantine the file', async () => {
      // The safety review's probe.
      const first = await started();
      await commitNew(first.store, { nonce: 7 });
      const [commit] = await records();
      fs.writeFileSync(filePath(), encodeLine({ ...commit, sender: BOB.address.toLowerCase() }));

      const { store } = await started();
      expect(store.quarantined.reason).toContain('not signed by its sender');
      expect(store.held()).toEqual([]);
    });

    test('so do they in a snapshot', async () => {
      const first = await started();
      await commitNew(first.store, { nonce: 7 });
      await started(); // compacts the commit into a snapshot
      const [held] = await records();
      expect(held.type).toBe('held');
      fs.writeFileSync(filePath(), encodeLine({ ...held, sender: BOB.address.toLowerCase() }));

      const { store } = await started();
      expect(store.quarantined.reason).toContain('not signed by its sender');
    });
  });

  describe('702-M6: replay applies the live cross-intent rules', () => {
    test('two originals at one nonce of one account quarantine the file', async () => {
      // The safety review's probe.
      const first = await started();
      await commitNew(first.store, { nonce: 7 });
      const [commit] = await records();
      const other = await sign({ nonce: 7, value: 2n });
      fs.appendFileSync(
        filePath(),
        encodeLine({
          ...commit,
          ...other,
          raw: other.raw.toLowerCase(),
          fields: { ...commit.fields, value: '2' },
          intent_id: 'another-intent-0001',
        })
      );

      const { store } = await started();
      expect(store.quarantined.reason).toContain("not above the account's held nonce 7");
      expect(store.held()).toEqual([]);
    });

    test('two held intents with one key quarantine the file', async () => {
      const first = await started();
      await commitNew(first.store, { nonce: 7, key: 'safe-exec:100:0xabc' });
      const [commit] = await records();
      const other = await sign({ nonce: 8 });
      fs.appendFileSync(
        filePath(),
        encodeLine({
          ...commit,
          ...other,
          raw: other.raw.toLowerCase(),
          nonce: 8,
          intent_id: 'another-intent-0002',
        })
      );

      const { store } = await started();
      expect(store.quarantined.reason).toContain('same key');
    });

    test.each(['void', 'settle'])(
      'a %s, then a new intent at the same nonce, is a valid history',
      async (kind) => {
        const first = await started();
        const a = await commitNew(first.store, { nonce: 7, key: 'safe-deploy:100:0xabc' });
        if (kind === 'void') {
          jest.spyOn(require('fs/promises'), 'rename').mockRejectedValueOnce(EIO());
          await voidUnderLock(first, a);
        } else {
          await first.store.settle({
            intentId: a.intentId,
            label: 'failed',
            hash: a.hash,
            block: 9,
          });
        }
        const c = await commitNew(first.store, {
          nonce: 7,
          value: 5n,
          key: 'safe-deploy:100:0xabc',
        });
        expect((await records()).map((record) => record.type)).toEqual(['commit', kind, 'commit']);

        // The whole history, then its compacted form.
        for (let restart = 0; restart < 2; restart += 1) {
          const { store } = await started();
          expect(store.quarantined).toBeNull();
          expect(store.heldNonces(CHAIN, ALICE.address)).toEqual([7]);
          expect(store.get(c.intentId).state).toBe('held');
          expect(store.get(a.intentId).state).toBe(kind === 'void' ? 'voided' : 'settled');
          expect(store.byKey('safe-deploy:100:0xabc').intentId).toBe(c.intentId);
        }
      }
    );
  });

  describe('bounds', () => {
    test('held intents are bounded in all, across accounts', async () => {
      const { store } = await started({ limits: { held: 3 } });
      await commitNew(store, { nonce: 0 });
      await commitNew(store, { nonce: 1 });
      await commitNew(store, { nonce: 0, signer: BOB });
      await expect(commitNew(store, { nonce: 1, signer: BOB })).rejects.toMatchObject({
        code: 'INTENT_STORE_LIMIT',
      });
    });

    test('the newest tombstones are kept; an older id is forgotten, and nothing can be sent for it', async () => {
      const first = await started({ limits: { tombstones: 2 } });
      const closed = [];
      for (let nonce = 0; nonce < 3; nonce += 1) {
        const intent = await commitNew(first.store, { nonce });
        await first.store.settle({
          intentId: intent.intentId,
          label: 'taken',
          hash: null,
          block: nonce,
        });
        closed.push(intent);
      }
      await first.store.compact();
      expect((await records()).map((record) => record.intent_id)).toEqual([
        closed[1].intentId,
        closed[2].intentId,
      ]);

      const { store } = await started({ limits: { tombstones: 2 } });
      expect(store.get(closed[0].intentId)).toBeNull();
      expect(store.get(closed[2].intentId)).toMatchObject({ state: 'settled' });
      await expect(store.handoff(closed[0].intentId)).rejects.toMatchObject({
        code: 'INTENT_UNKNOWN',
      });
    });
  });

  describe('snapshots', () => {
    test('a held intent compacts to one line: its latest bytes, every hash, a handoff summary', async () => {
      const first = await started();
      const intent = await commitNew(first.store, { nonce: 3 });
      const bump = await sign({ nonce: 3, maxFeePerGas: 3_000_000_000n });
      await first.store.commit({
        intentId: intent.intentId,
        chainId: CHAIN,
        sender: ALICE.address,
        nonce: 3,
        ...bump,
        via: 'replacement',
      });
      await sendNotSent(first.store, intent.intentId);
      const sent = await first.store.handoff(intent.intentId);
      await first.store.outcome({
        intentId: intent.intentId,
        handoffId: sent.handoffId,
        outcome: 'sent',
      });
      await first.store.handoff(intent.intentId); // open when this run ends

      const second = await started();
      const [held] = await records();
      expect(held).toMatchObject({
        type: 'held',
        intent_id: intent.intentId,
        hash: bump.hash,
        raw: bump.raw.toLowerCase(),
        hashes: [
          expect.objectContaining({ hash: intent.hash, via: 'original' }),
          expect.objectContaining({ hash: bump.hash, via: 'replacement' }),
        ],
        handoffs: { count: 3, possibly_sent: true },
      });
      expect(await records()).toHaveLength(1);
      expect(second.store.get(intent.intentId)).toMatchObject({
        raw: bump.raw.toLowerCase(),
        hashes: [{ raw: null }, { raw: bump.raw.toLowerCase() }],
        handoffCount: 3,
        possiblySent: true,
      });
      await expect(second.store.handoff(intent.intentId, intent.hash)).rejects.toMatchObject({
        message: expect.stringContaining('no longer kept'),
      });

      // Already compact: a restart leaves the file as it is.
      const bytes = fs.readFileSync(filePath());
      await started();
      expect(fs.readFileSync(filePath())).toEqual(bytes);
    });

    test("a compaction mid-run keeps this run's open handoffs, so their outcomes replay", async () => {
      const first = await started();
      const intent = await commitNew(first.store, { nonce: 0 });
      const handoff = await first.store.handoff(intent.intentId);
      await first.store.compact();
      expect((await records()).map((record) => record.type)).toEqual(['held', 'handoff']);
      await first.store.outcome({
        intentId: intent.intentId,
        handoffId: handoff.handoffId,
        outcome: 'not_sent',
      });

      const { store } = await started();
      expect(store.quarantined).toBeNull();
      expect(store.get(intent.intentId)).toMatchObject({ handoffCount: 1, possiblySent: false });
    });

    test('a void after a compaction mid-run replays as valid', async () => {
      const first = await started();
      const intent = await commitNew(first.store, { nonce: 0 });
      await sendNotSent(first.store, intent.intentId);
      await first.store.compact();
      jest.spyOn(require('fs/promises'), 'rename').mockRejectedValueOnce(EIO());
      await voidUnderLock(first, intent);
      expect((await records()).map((record) => record.type)).toEqual(['held', 'void']);

      const { store } = await started();
      expect(store.quarantined).toBeNull();
      expect(store.get(intent.intentId).state).toBe('voided');
    });
  });
});
