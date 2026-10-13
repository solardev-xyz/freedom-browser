const {
  WAIT_TIMEOUT_MS,
  accountKey,
  holdsAccountLock,
  reserve,
  withAccountLock,
} = require('./nonce-reservations');

const CHAIN = 100;
const SENDER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

// A stand-in for the intent store: a commit holds the nonce.
function fakeStore(held = []) {
  const nonces = held.map((nonce) => ({ chainId: CHAIN, sender: SENDER.toLowerCase(), nonce }));
  return {
    commits: nonces,
    commit(chainId, sender, nonce) {
      nonces.push({ chainId, sender: sender.toLowerCase(), nonce });
    },
    heldNonces: jest.fn((chainId, sender) =>
      nonces
        .filter((n) => n.chainId === chainId && n.sender === sender.toLowerCase())
        .map((n) => n.nonce)
    ),
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('reserve', () => {
  test('concurrent reservations get N and N+1, the second waiting for the first commit', async () => {
    const store = fakeStore();
    // The chain's pending count doesn't move: nothing has been broadcast.
    const readPending = jest.fn(async () => 7);
    const events = [];

    const first = reserve({ chainId: CHAIN, sender: SENDER, readPending, store }, async (nonce) => {
      events.push(`first got ${nonce}`);
      await delay(30); // a device approval
      store.commit(CHAIN, SENDER, nonce);
      events.push('first committed');
      return nonce;
    });
    const second = reserve(
      { chainId: CHAIN, sender: SENDER, readPending, store },
      async (nonce) => {
        events.push(`second got ${nonce}`);
        store.commit(CHAIN, SENDER, nonce);
        return nonce;
      }
    );

    expect(await Promise.all([first, second])).toEqual([7, 8]);
    expect(events).toEqual(['first got 7', 'first committed', 'second got 8']);
    // `pending` is read inside the lock, once per reservation.
    expect(readPending).toHaveBeenCalledTimes(2);
  });

  test('a rejection in the callback releases the reservation with nothing held', async () => {
    const store = fakeStore();
    const readPending = async () => 7;
    const rejected = Object.assign(new Error('Rejected on the device'), {
      code: 'LEDGER_USER_REJECTED',
    });

    await expect(
      reserve({ chainId: CHAIN, sender: SENDER, readPending, store }, async () => {
        throw rejected;
      })
    ).rejects.toBe(rejected);

    const nonce = await reserve(
      { chainId: CHAIN, sender: SENDER, readPending, store },
      async (n) => n
    );
    expect(nonce).toBe(7);
  });

  test('a failure reading pending releases the lock', async () => {
    const store = fakeStore();
    await expect(
      reserve(
        {
          chainId: CHAIN,
          sender: SENDER,
          readPending: async () => Promise.reject(new Error('RPC down')),
          store,
        },
        async () => 'unreachable'
      )
    ).rejects.toThrow('RPC down');
    await expect(
      reserve({ chainId: CHAIN, sender: SENDER, readPending: async () => 3, store }, async (n) => n)
    ).resolves.toBe(3);
  });

  test('the floor above pending wins: a new intent goes above every held one', async () => {
    // Held intents at 7 and 9 that the network hasn't seen.
    const store = fakeStore([7, 9]);
    const nonce = await reserve(
      { chainId: CHAIN, sender: SENDER, readPending: async () => 7, store },
      async (n) => n
    );
    expect(nonce).toBe(10);
    expect(store.heldNonces).toHaveBeenCalledWith(CHAIN, SENDER);
  });

  test('pending above the floor wins: other wallets sent from this account', async () => {
    const store = fakeStore([3]);
    const nonce = await reserve(
      { chainId: CHAIN, sender: SENDER, readPending: async () => 12, store },
      async (n) => n
    );
    expect(nonce).toBe(12);
  });

  test('accepts the RPC hex count, and refuses one that is not a nonce', async () => {
    const store = fakeStore();
    await expect(
      reserve(
        { chainId: CHAIN, sender: SENDER, readPending: async () => '0x1f', store },
        async (n) => n
      )
    ).resolves.toBe(31);
    for (const bad of ['0xnope', -1, 1.5, '0x' + 'f'.repeat(20)]) {
      await expect(
        reserve(
          { chainId: CHAIN, sender: SENDER, readPending: async () => bad, store },
          async (n) => n
        )
      ).rejects.toThrow('Invalid pending transaction count');
    }
  });

  test('waits for the store to load, and refuses when it cannot', async () => {
    const loaded = deferred();
    const store = { ...fakeStore([4]), ready: loaded.promise };
    const reserved = reserve(
      { chainId: CHAIN, sender: SENDER, readPending: async () => 0, store },
      async (n) => n
    );
    await delay(5);
    expect(store.heldNonces).not.toHaveBeenCalled();
    loaded.resolve();
    expect(await reserved).toBe(5);

    const broken = { ...fakeStore(), ready: Promise.reject(new Error('records unreadable')) };
    await expect(
      reserve(
        { chainId: CHAIN, sender: SENDER, readPending: async () => 0, store: broken },
        async (n) => n
      )
    ).rejects.toThrow('records unreadable');
  });

  test('two wallet indexes resolving to one address share the lock', async () => {
    const store = fakeStore();
    const readPending = async () => 0;
    // Index 0 and index 3 both answer the same address, in different case.
    const fromIndex0 = SENDER;
    const fromIndex3 = SENDER.toLowerCase();
    const order = [];

    const first = reserve({ chainId: CHAIN, sender: fromIndex0, readPending, store }, async (n) => {
      order.push('index 0 start');
      await delay(20);
      store.commit(CHAIN, fromIndex0, n);
      order.push('index 0 end');
      return n;
    });
    const second = reserve(
      { chainId: CHAIN, sender: fromIndex3, readPending, store },
      async (n) => {
        order.push('index 3 start');
        return n;
      }
    );

    expect(await Promise.all([first, second])).toEqual([0, 1]);
    expect(order).toEqual(['index 0 start', 'index 0 end', 'index 3 start']);
  });

  test('other accounts and other chains do not wait', async () => {
    const store = fakeStore();
    const gate = deferred();
    const holder = reserve(
      { chainId: CHAIN, sender: SENDER, readPending: async () => 0, store },
      () => gate.promise
    );
    await expect(
      reserve({ chainId: CHAIN, sender: OTHER, readPending: async () => 0, store }, async (n) => n)
    ).resolves.toBe(0);
    await expect(
      reserve({ chainId: 1, sender: SENDER, readPending: async () => 0, store }, async (n) => n)
    ).resolves.toBe(0);
    gate.resolve('done');
    await expect(holder).resolves.toBe('done');
  });

  test('a waiter times out with a clear error; the holder keeps the lock', async () => {
    const store = fakeStore();
    const gate = deferred();
    let holderLock;
    const holder = reserve(
      { chainId: CHAIN, sender: SENDER, readPending: async () => 0, store },
      async (n, lock) => {
        holderLock = lock;
        await gate.promise; // the user is still looking at the device
        store.commit(CHAIN, SENDER, n);
        return n;
      }
    );
    await delay(5);

    const patient = withAccountLock(
      { chainId: CHAIN, sender: SENDER, waitMs: 5000 },
      () => 'patient'
    );
    const impatient = reserve(
      { chainId: CHAIN, sender: SENDER, readPending: async () => 0, store, waitMs: 20 },
      async (n) => n
    );
    await expect(impatient).rejects.toMatchObject({
      code: 'NONCE_LOCK_TIMEOUT',
      message: 'Another transaction from this account is waiting for approval.',
    });

    // The timeout touched only the waiter.
    expect(holdsAccountLock(holderLock, CHAIN, SENDER)).toBe(true);
    let patientDone = false;
    patient.then(() => {
      patientDone = true;
    });
    await delay(20);
    expect(patientDone).toBe(false);

    gate.resolve();
    expect(await holder).toBe(0);
    expect(await patient).toBe('patient');
    expect(holdsAccountLock(holderLock, CHAIN, SENDER)).toBe(false);
  });

  test('waiters wait about three minutes by default', () => {
    expect(WAIT_TIMEOUT_MS).toBe(180_000);
  });
});

describe('withAccountLock', () => {
  test('never reads pending, and serializes with reservations', async () => {
    const store = fakeStore([5]);
    const readPending = jest.fn(async () => 0);
    const order = [];
    const replacement = withAccountLock({ chainId: CHAIN, sender: SENDER }, async () => {
      order.push('replacement');
      await delay(10);
      return 'replaced at 5';
    });
    const fresh = reserve({ chainId: CHAIN, sender: SENDER, readPending, store }, async (n) => {
      order.push(`new intent at ${n}`);
      return n;
    });
    expect(await replacement).toBe('replaced at 5');
    expect(await fresh).toBe(6);
    expect(order).toEqual(['replacement', 'new intent at 6']);
    expect(readPending).toHaveBeenCalledTimes(1);
  });

  test('its token is valid for that account only, and only while held', async () => {
    let kept;
    await withAccountLock({ chainId: CHAIN, sender: SENDER }, (lock) => {
      kept = lock;
      expect(holdsAccountLock(lock, CHAIN, SENDER.toLowerCase())).toBe(true);
      expect(holdsAccountLock(lock, CHAIN, OTHER)).toBe(false);
      expect(holdsAccountLock(lock, 1, SENDER)).toBe(false);
      // A look-alike object is not a token.
      expect(holdsAccountLock({ ...lock }, CHAIN, SENDER)).toBe(false);
    });
    expect(holdsAccountLock(kept, CHAIN, SENDER)).toBe(false);
    expect(holdsAccountLock(null, CHAIN, SENDER)).toBe(false);
  });

  test('a synchronous throw releases the lock', async () => {
    await expect(
      withAccountLock({ chainId: CHAIN, sender: SENDER }, () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(withAccountLock({ chainId: CHAIN, sender: SENDER }, () => 'free')).resolves.toBe(
      'free'
    );
  });

  test('refuses an account that is not one', async () => {
    await expect(withAccountLock({ chainId: 0, sender: SENDER }, () => {})).rejects.toThrow(
      'Invalid chain id'
    );
    await expect(withAccountLock({ chainId: CHAIN, sender: 'alice' }, () => {})).rejects.toThrow(
      'Invalid sender address'
    );
    expect(accountKey(CHAIN, SENDER)).toBe(`${CHAIN}:${SENDER.toLowerCase()}`);
  });
});
