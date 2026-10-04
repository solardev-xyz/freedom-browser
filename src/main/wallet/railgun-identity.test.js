let mockSignJob, mockPermitConsume, mockDerived;
let mockVault, mockParent, mockOnJob, mockInputs, mockClosed, mockCurrent;
jest.mock('../identity/vault', () => ({
  getMnemonic: () =>
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  getSessionSignal: () => mockVault.signal,
}));
jest.mock('./railgun-private-operation', () => ({
  consumeRailgunPrivateSigningPermit: (...args) => mockPermitConsume(...args),
}));
jest.mock('../identity/privacy-keys', () => {
  const actual = jest.requireActual('../identity/privacy-keys');
  return {
    ...actual,
    createRailgunKeystore: (...args) => {
      const store = actual.createRailgunKeystore(...args);
      return {
        ...store,
        deriveBytesAt: async (path) => {
          const key = await store.deriveBytesAt(path);
          mockDerived.push({ path, key });
          return key;
        },
      };
    },
  };
});
jest.mock('./privacy-session', () => ({ openPrivacySession: () => mockParent }));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (v) => {
    if (v !== '/fixture.asar') throw Error('bad archive');
    return v;
  },
}));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: (options) => {
    const input = JSON.parse(options.input);
    mockInputs.push(input);
    if (!input.purpose) {
      const controller = new AbortController();
      let finish, stopped;
      const closed = new Promise((resolve) => {
        finish = resolve;
      });
      const end = new Promise((_resolve, reject) => {
        stopped = reject;
      });
      const close = () => {
        controller.abort();
        finish({ code: 'RAILGUN_PROCESS_CLOSED' });
        stopped(Error('closed'));
      };
      options.broker.signal.addEventListener('abort', close, { once: true });
      return {
        closed,
        close,
        signal: controller.signal,
        ready: Promise.race([Promise.resolve().then(() => mockSignJob(options)), end]),
      };
    }

    let finish;
    const closed = new Promise((resolve) => {
      finish = resolve;
    });
    return {
      closed,
      close: () => {
        mockClosed++;
        finish({ code: 'RAILGUN_PROCESS_CLOSED' });
      },
      ready: (async () => {
        const key = await options.broker.dispatch(
          JSON.stringify({ id: 1, method: 'key', purpose: input.purpose })
        );
        try {
          if (mockOnJob) await mockOnJob({ input, options, key });
        } finally {
          key.fill(0);
        }
        const value =
          input.purpose === 'spending-public'
            ? { spendingPublicKey: ['1'.repeat(64), '2'.repeat(64)] }
            : {
                spendingPublicKey: input.spendingPublicKey,
                viewingPublicKey: '3'.repeat(64),
                masterPublicKey: '1'.repeat(64),
                walletId: '4'.repeat(64),
                instanceId: '0zk1' + 'q'.repeat(123),
              };
        await options.broker.dispatch(
          JSON.stringify({
            id: 2,
            method: 'result',
            value,
            guards: { attempts: 0, hooks: ['guard'], canaries: 1 },
          })
        );
      })(),
    };
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  openRailgunIdentity,
  assertRailgunIdentity,
  withRailgunViewingCredential,
  signRailgunPrivateIntent,
  assertRailgunPrivateSigner,
} = require('./railgun-identity');
let identity;
beforeEach(() => {
  mockDerived = [];
  mockPermitConsume = () => {
    throw Error('no permit');
  };
  mockSignJob = null;
  mockVault = new AbortController();
  mockOnJob = null;
  mockInputs = [];
  mockClosed = 0;
  mockCurrent = true;
  mockParent = createPrivacyScope({
    profileId: 'identity-unit',
    signal: mockVault.signal,
    isCurrent: () => mockCurrent,
  });
});
afterEach(() => {
  identity?.close();
  identity = null;
  mockParent.close();
});
test('separate one-use spending-public and viewing jobs yield an opaque immutable identity', async () => {
  const requests = [];
  mockOnJob = async ({ input, key }) => {
    requests.push({ purpose: input.purpose, key: key.toString('hex') });
  };
  identity = await openRailgunIdentity({ archive: '/fixture.asar', accountIndex: 0 });
  expect(mockInputs.map((v) => v.purpose)).toEqual(['spending-public', 'viewing-identity']);
  expect(mockClosed).toBe(4);
  expect(requests[0].key).not.toBe(requests[1].key);
  for (const request of requests) expect(JSON.stringify(mockInputs)).not.toContain(request.key);
  expect(Object.isFrozen(identity.descriptor.spendingPublicKey)).toBe(true);
  expect(() => assertRailgunIdentity({ ...identity })).toThrow();
  await expect(openRailgunIdentity({ archive: '/fixture.asar' })).rejects.toThrow();
  let retained;
  await withRailgunViewingCredential(identity, ({ viewingKey }) => {
    retained = viewingKey;
    expect(viewingKey.toString('hex')).toBe(requests[1].key);
  });
  expect(retained.equals(Buffer.alloc(32))).toBe(true);
});
test.each(['lock', 'profile', 'close'])(
  '%s revokes identity and credential access',
  async (mode) => {
    identity = await openRailgunIdentity({ archive: '/fixture.asar' });
    if (mode === 'lock') mockVault.abort();
    if (mode === 'profile') mockCurrent = false;
    if (mode === 'close') identity.close();
    expect(() => assertRailgunIdentity(identity)).toThrow();
    await expect(withRailgunViewingCredential(identity, () => {})).rejects.toThrow();
  }
);
test('locking during credential use wipes the borrowed buffer before the callback completes', async () => {
  identity = await openRailgunIdentity({ archive: '/fixture.asar' });
  await expect(
    withRailgunViewingCredential(identity, async ({ viewingKey }) => {
      mockVault.abort();
      expect(viewingKey.equals(Buffer.alloc(32))).toBe(true);
    })
  ).rejects.toThrow();
});
test('key-request replay aborts enrollment, waits for process exit and permits a fresh retry', async () => {
  mockOnJob = async ({ options, input }) => {
    await options.broker.dispatch(JSON.stringify({ id: 1, method: 'key', purpose: input.purpose }));
  };
  await expect(openRailgunIdentity({ archive: '/fixture.asar' })).rejects.toMatchObject({
    code: 'RAILGUN_IDENTITY_REFUSED',
  });
  expect(mockClosed).toBeGreaterThan(0);
  mockOnJob = null;
  identity = await openRailgunIdentity({ archive: '/fixture.asar' });
  expect(assertRailgunIdentity(identity).accountIndex).toBe(0);
});
test('foreign key purpose cannot obtain another key', async () => {
  mockOnJob = async ({ options }) => {
    await options.broker.dispatch(
      JSON.stringify({ id: 2, method: 'key', purpose: 'viewing-identity' })
    );
  };
  await expect(openRailgunIdentity({ archive: '/fixture.asar' })).rejects.toThrow();
  expect(mockInputs).toHaveLength(1);
});
test('invalid archive and account indices cause no utility or key request', async () => {
  await expect(openRailgunIdentity({ archive: '/wrong.asar' })).rejects.toThrow();
  for (const accountIndex of [-1, 65536, 1.5])
    await expect(openRailgunIdentity({ archive: '/fixture.asar', accountIndex })).rejects.toThrow();
  expect(mockInputs).toHaveLength(0);
});

test('a foreign profile or account handle cannot borrow the identity', async () => {
  identity = await openRailgunIdentity({ archive: '/fixture.asar' });
  const subject = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
  };
  expect(() => assertRailgunIdentity(identity, mockParent.getContext(subject))).not.toThrow();
  expect(() =>
    assertRailgunIdentity(identity, mockParent.getContext({ ...subject, principal: 'railgun:1' }))
  ).toThrow();
  const foreign = createPrivacyScope({
    profileId: 'another-profile',
    signal: new AbortController().signal,
  });
  expect(() => assertRailgunIdentity(identity, foreign.getContext(subject))).toThrow();
  foreign.close();
});
test('a vault lock while deriving public keys refuses enrollment and releases after job exit', async () => {
  mockOnJob = async () => {
    mockVault.abort();
  };
  await expect(openRailgunIdentity({ archive: '/fixture.asar' })).rejects.toThrow();
  expect(mockClosed).toBeGreaterThan(0);
  mockDerived = [];
  mockPermitConsume = () => {
    throw Error('no permit');
  };
  mockSignJob = null;
  mockVault = new AbortController();
  mockOnJob = null;
  mockParent = createPrivacyScope({ profileId: 'identity-unit', signal: mockVault.signal });
  identity = await openRailgunIdentity({ archive: '/fixture.asar' });
  expect(assertRailgunIdentity(identity).accountIndex).toBe(0);
});
test('profile invalidation during derivation refuses the descriptor', async () => {
  mockOnJob = async () => {
    mockCurrent = false;
  };
  await expect(openRailgunIdentity({ archive: '/fixture.asar' })).rejects.toThrow();
  expect(mockInputs).toHaveLength(1);
  expect(mockClosed).toBeGreaterThan(0);
});

async function signingFixture() {
  identity = await openRailgunIdentity({ archive: '/fixture.asar' });
  mockDerived = [];
  const c = require('../../../scripts/fixtures/railgun-capsule-data').capsule(
    identity.descriptor.walletId
  );
  const options = {
    identity,
    archive: '/fixture.asar',
    ...c.preparation,
    signal: new AbortController().signal,
    onKeyRequest: async () => ({}),
  };
  mockSignJob = async (job) => {
    const payload = JSON.parse(job.input);
    const digest = require('./railgun-private-intent').validateRailgunPrivateSigningIntent(
      payload.transaction,
      payload.expected
    ).digest;
    const key = await job.broker.dispatch(
      JSON.stringify({
        id: 1,
        method: 'key',
        purpose: 'spending-sign',
        transactionDigest: digest,
        expectedHash: payload.expectedHash,
      })
    );
    expect(key.some((v) => v !== 0)).toBe(true);
    key.fill(0);
    await job.broker.dispatch(
      JSON.stringify({
        id: 2,
        method: 'result',
        value: {
          transactionDigest: digest,
          message: payload.expectedHash,
          signature: {
            R8: ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)],
            S: '0x' + '0'.repeat(63) + '3',
          },
          inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          guards: { attempts: 0, canaries: 1, hooks: ['fixture.guard'] },
        },
      })
    );
  };
  return options;
}
test('B token binds live signer, identity and exact public intent; gates bracket derivation', async () => {
  const options = await signingFixture();
  let token,
    checks = 0;
  options.onKeyRequest = async (_request, value) => {
    token = value;
    expect(() => assertRailgunPrivateSigner(token, identity, options)).not.toThrow();
    expect(() => assertRailgunPrivateSigner({}, identity, options)).toThrow();
    expect(() => assertRailgunPrivateSigner(token, {}, options)).toThrow();
    expect(() =>
      assertRailgunPrivateSigner(token, identity, { ...options, expectedHash: 'changed' })
    ).toThrow();
    return {};
  };
  mockPermitConsume = (_permit, actual, signer) => {
    expect(actual).toBe(identity);
    expect(signer).toBe(token);
    return {
      assertCurrent: async () => {
        checks++;
        expect(mockDerived).toHaveLength(checks - 1);
      },
    };
  };
  const result = await signRailgunPrivateIntent(options);
  expect(result.signature).toBeDefined();
  expect(checks).toBe(2);
  expect(mockDerived).toHaveLength(1);
  expect(mockDerived[0].path).toBe("m/44'/1984'/0'/0'/0'");
  expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
  expect(() => assertRailgunPrivateSigner(token, identity, options)).toThrow();
});
test('fabricated permit never derives a spending key', async () => {
  const options = await signingFixture();
  await expect(signRailgunPrivateIntent(options)).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_SIGNING_REFUSED',
  });
  expect(mockDerived).toHaveLength(0);
});
test('gate failure after derivation wipes the key before any supervisor reply', async () => {
  const options = await signingFixture();
  let checks = 0;
  mockPermitConsume = () => ({
    assertCurrent: async () => {
      if (++checks === 2) throw Error('expired');
    },
  });
  await expect(signRailgunPrivateIntent(options)).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_SIGNING_REFUSED',
  });
  expect(mockDerived).toHaveLength(1);
  expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
});
test('abort after derivation wipes the borrowed key while gate read-back is still pending', async () => {
  const options = await signingFixture();
  let checks = 0;
  mockPermitConsume = () => ({
    assertCurrent: async () => {
      if (++checks === 2) {
        mockVault.abort();
        expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
        await Promise.resolve();
      }
    },
  });
  await expect(signRailgunPrivateIntent(options)).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_SIGNING_REFUSED',
  });
  expect(mockDerived).toHaveLength(1);
  expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
});
test('a child exit does not release identity exclusion until its durable callback drains', async () => {
  const options = await signingFixture();
  const caller = new AbortController();
  options.signal = caller.signal;
  let entered, release;
  const enteredPromise = new Promise((r) => {
    entered = r;
  });
  const blocked = new Promise((r) => {
    release = r;
  });
  options.onKeyRequest = async () => {
    entered();
    await blocked;
    return {};
  };
  let settled = false;
  const pending = signRailgunPrivateIntent(options).finally(() => {
    settled = true;
  });
  const refused = expect(pending).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_SIGNING_REFUSED',
  });
  await enteredPromise;
  caller.abort();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(settled).toBe(false);
  await expect(
    signRailgunPrivateIntent({ ...options, signal: new AbortController().signal })
  ).rejects.toThrow();
  expect(mockDerived).toHaveLength(0);
  release();
  await refused;
  expect(settled).toBe(true);
});

test('valid partial signing intent refuses before a spending job, permit callback or key derivation', async () => {
  const options = await signingFixture();
  const {
    createRailgunPartialCapsuleData,
  } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const { preparation } = createRailgunPartialCapsuleData().capsule;
  expect(
    require('./railgun-private-intent').validateRailgunPrivateSigningIntent(
      preparation.transaction,
      preparation.expected
    ).kind
  ).toBe('railgun-partial-unshield');
  const onKeyRequest = jest.fn();
  const jobsBefore = mockInputs.length;
  await expect(
    signRailgunPrivateIntent({ ...options, ...preparation, onKeyRequest })
  ).rejects.toMatchObject({ code: 'RAILGUN_PRIVATE_SIGNING_REFUSED' });
  expect(mockInputs).toHaveLength(jobsBefore);
  expect(mockDerived).toHaveLength(0);
  expect(onKeyRequest).not.toHaveBeenCalled();
  expect(assertRailgunIdentity(identity)).toBe(identity.descriptor);
  // A rejected new kind does not occupy or revoke the genuine identity's signer slot.
  await expect(signRailgunPrivateIntent(options)).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_SIGNING_REFUSED',
  });
  expect(mockInputs).toHaveLength(jobsBefore + 1);
});
