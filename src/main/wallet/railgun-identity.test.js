let mockSignJob,
  mockPermitConsume,
  mockRelayPermitConsume,
  mockSignTask,
  mockScopeClose,
  mockDerived,
  mockViewingDerived,
  mockDeferViewing,
  mockDeferSpending;
let mockVault, mockParent, mockOnJob, mockInputs, mockClosed, mockCurrent;
jest.mock('../networks/privacy-context', () => {
  const actual = jest.requireActual('../networks/privacy-context');
  return {
    ...actual,
    createPrivacyScope: (...args) => {
      const scope = actual.createPrivacyScope(...args);
      return mockScopeClose ? { ...scope, close: mockScopeClose(scope.close) } : scope;
    },
  };
});
jest.mock('../identity/vault', () => ({
  getMnemonic: () =>
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  getSessionSignal: () => mockVault.signal,
}));
jest.mock('./railgun-private-operation', () => ({
  consumeRailgunPrivateSigningPermit: (...args) => mockPermitConsume(...args),
}));
jest.mock(
  './railgun-relay-operation',
  () => ({
    consumeRailgunRelaySigningPermit: (...args) => mockRelayPermitConsume(...args),
  }),
  { virtual: true }
);
jest.mock('../identity/privacy-keys', () => {
  const actual = jest.requireActual('../identity/privacy-keys');
  return {
    ...actual,
    createRailgunViewingKeystore: (...args) => {
      const store = actual.createRailgunViewingKeystore(...args);
      return {
        ...store,
        deriveBytesAt: async (path) => {
          const key = await store.deriveBytesAt(path);
          mockViewingDerived.push({ path, key });
          if (mockDeferViewing) await mockDeferViewing(key);
          return key;
        },
      };
    },
    createRailgunKeystore: (...args) => {
      const store = actual.createRailgunKeystore(...args);
      return {
        ...store,
        deriveBytesAt: async (path) => {
          const key = await store.deriveBytesAt(path);
          mockDerived.push({ path, key });
          if (mockDeferSpending) await mockDeferSpending(key);
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
      const task = {
        closed,
        close,
        signal: controller.signal,
        ready: Promise.race([Promise.resolve().then(() => mockSignJob(options)), end]),
      };
      mockSignTask?.(task, options);
      return task;
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
  quarantineRailgunIdentityCredentials,
  withRailgunViewingCredential,
  signRailgunPrivateIntent,
  assertRailgunPrivateSigner,
  signRailgunRelayIntent,
  assertRailgunRelaySigner,
  assertRailgunRelayCredentialIssuance,
} = require('./railgun-identity');
let identity;
beforeEach(() => {
  mockDerived = [];
  mockViewingDerived = [];
  mockDeferViewing = mockDeferSpending = undefined;
  mockPermitConsume = () => {
    throw Error('no permit');
  };
  mockRelayPermitConsume = () => {
    throw Error('no relay permit');
  };
  mockSignTask = undefined;
  mockScopeClose = undefined;
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

test.each([false, true])(
  'partial signing uses existing genuine B registry and permit gate: granted=%s',
  async (granted) => {
    const options = await signingFixture();
    const { preparation } =
      require('../../../scripts/fixtures/railgun-partial-capsule-data').createRailgunPartialCapsuleData()
        .capsule;
    const onKeyRequest = jest.fn(async (_request, token) => {
      expect(() =>
        assertRailgunPrivateSigner(token, identity, { ...options, ...preparation })
      ).not.toThrow();
      expect(() =>
        assertRailgunPrivateSigner(token, identity, {
          ...options,
          ...preparation,
          expected: { ...preparation.expected, unshieldAmount: '401' },
        })
      ).toThrow();
      return {};
    });
    let checks = 0;
    if (granted)
      mockPermitConsume = () => ({
        assertCurrent: async () => {
          checks++;
        },
      });
    const jobsBefore = mockInputs.length;
    const work = signRailgunPrivateIntent({ ...options, ...preparation, onKeyRequest });
    if (granted) {
      await expect(work).resolves.toHaveProperty('signature');
      expect(mockDerived).toHaveLength(1);
      expect(checks).toBe(2);
      expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
    } else {
      await expect(work).rejects.toMatchObject({ code: 'RAILGUN_PRIVATE_SIGNING_REFUSED' });
      expect(mockDerived).toHaveLength(0);
    }
    expect(mockInputs).toHaveLength(jobsBefore + 1);
    expect(onKeyRequest).toHaveBeenCalledTimes(1);
  }
);

function quarantineDeferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let quarantineProfile = 0;
describe('process-lifetime credential quarantine', () => {
  // Different test profiles isolate permanent state. No reset API or simulated
  // relock clears the production registry in these tests.
  let profileId;
  beforeEach(() => {
    mockParent.close();
    profileId = `identity-quarantine-${++quarantineProfile}`;
    mockParent = createPrivacyScope({ profileId, signal: mockVault.signal });
  });
  function relock() {
    mockVault.abort();
    mockParent.close();
    mockVault = new AbortController();
    mockParent = createPrivacyScope({ profileId, signal: mockVault.signal });
  }
  test.each(['current', 'closed', 'locked'])(
    'genuine %s identity quarantines its stable account before any reopening derivation',
    async (state) => {
      identity = await openRailgunIdentity({ archive: '/fixture.asar' });
      if (state === 'closed') identity.close();
      if (state === 'locked') relock();
      quarantineRailgunIdentityCredentials(identity);
      expect(identity.signal.aborted).toBe(true);
      expect(() => quarantineRailgunIdentityCredentials(identity)).not.toThrow();
      const spending = mockDerived.length,
        viewing = mockViewingDerived.length,
        jobs = mockInputs.length;
      const use = jest.fn();
      await expect(withRailgunViewingCredential(identity, use)).rejects.toMatchObject({
        code: 'RAILGUN_IDENTITY_REFUSED',
      });
      await expect(signRailgunPrivateIntent({ identity })).rejects.toMatchObject({
        code: 'RAILGUN_PRIVATE_SIGNING_REFUSED',
      });
      relock();
      await expect(openRailgunIdentity({ archive: '/fixture.asar' })).rejects.toMatchObject({
        code: 'RAILGUN_IDENTITY_REFUSED',
      });
      expect(mockDerived).toHaveLength(spending);
      expect(mockViewingDerived).toHaveLength(viewing);
      expect(mockInputs).toHaveLength(jobs);
      expect(use).not.toHaveBeenCalled();
    }
  );
  test('copied/forged identity cannot quarantine a healthy account or select another owner', async () => {
    identity = await openRailgunIdentity({ archive: '/fixture.asar' });
    for (const value of [{}, { ...identity }, { owner: [profileId, 0] }, null])
      expect(() => quarantineRailgunIdentityCredentials(value)).toThrow(
        'Railgun identity unavailable'
      );
    expect(() => assertRailgunIdentity(identity)).not.toThrow();
    await withRailgunViewingCredential(identity, ({ viewingKey }) =>
      expect(viewingKey.some((v) => v !== 0)).toBe(true)
    );
    identity.close();
    identity = await openRailgunIdentity({ archive: '/fixture.asar' });
    expect(identity.signal.aborted).toBe(false);
  });
  test('another account remains current and may derive after quarantining account zero', async () => {
    identity = await openRailgunIdentity({ archive: '/fixture.asar' });
    const other = await openRailgunIdentity({ archive: '/fixture.asar', accountIndex: 1 });
    try {
      quarantineRailgunIdentityCredentials(identity);
      expect(assertRailgunIdentity(other).accountIndex).toBe(1);
      await withRailgunViewingCredential(other, ({ viewingKey }) =>
        expect(viewingKey.some((v) => v !== 0)).toBe(true)
      );
    } finally {
      other.close();
    }
  });
  test('same account index in another profile remains issuable', async () => {
    identity = await openRailgunIdentity({ archive: '/fixture.asar' });
    quarantineRailgunIdentityCredentials(identity);
    mockParent.close();
    mockParent = createPrivacyScope({ profileId: profileId + '-other', signal: mockVault.signal });
    identity = await openRailgunIdentity({ archive: '/fixture.asar' });
    expect(assertRailgunIdentity(identity).accountIndex).toBe(0);
  });
  test('old closed identity quarantines a reopened sibling and wipes its held viewing loan immediately', async () => {
    const original = await openRailgunIdentity({ archive: '/fixture.asar' });
    original.close();
    identity = await openRailgunIdentity({ archive: '/fixture.asar' });
    const entered = quarantineDeferred(),
      release = quarantineDeferred();
    let key,
      settled = false;
    const work = withRailgunViewingCredential(identity, async ({ viewingKey }) => {
      key = viewingKey;
      entered.resolve();
      await release.promise;
    }).catch((error) => {
      settled = true;
      return error;
    });
    await entered.promise;
    quarantineRailgunIdentityCredentials(original);
    expect(identity.signal.aborted).toBe(true);
    expect(key.equals(Buffer.alloc(32))).toBe(true);
    expect(settled).toBe(false);
    release.resolve();
    expect(await work).toMatchObject({ code: 'RAILGUN_IDENTITY_REFUSED' });
  });
  test('quarantine blocks reentrant reopen from an abort listener before any key work', async () => {
    identity = await openRailgunIdentity({ archive: '/fixture.asar' });
    let reopening;
    identity.signal.addEventListener(
      'abort',
      () => {
        reopening = openRailgunIdentity({ archive: '/fixture.asar' }).catch((error) => error);
      },
      { once: true }
    );
    const count = mockDerived.length;
    quarantineRailgunIdentityCredentials(identity);
    expect(await reopening).toMatchObject({ code: 'RAILGUN_IDENTITY_REFUSED' });
    expect(mockDerived).toHaveLength(count);
  });
  test('late viewing derivation is wiped without callback admission after quarantine', async () => {
    identity = await openRailgunIdentity({ archive: '/fixture.asar' });
    const entered = quarantineDeferred(),
      release = quarantineDeferred();
    let key;
    mockDeferViewing = async (value) => {
      key = value;
      entered.resolve();
      await release.promise;
    };
    const use = jest.fn();
    const work = withRailgunViewingCredential(identity, use).catch((error) => error);
    await entered.promise;
    quarantineRailgunIdentityCredentials(identity);
    release.resolve();
    expect(await work).toMatchObject({ code: 'RAILGUN_IDENTITY_REFUSED' });
    expect(key.equals(Buffer.alloc(32))).toBe(true);
    expect(use).not.toHaveBeenCalled();
  });
  test('quarantine of an old issuer closes a replacement still deriving its initial descriptor', async () => {
    const original = await openRailgunIdentity({ archive: '/fixture.asar' });
    original.close();
    const entered = quarantineDeferred(),
      release = quarantineDeferred();
    let key;
    mockDeferSpending = async (value) => {
      key = value;
      entered.resolve();
      await release.promise;
    };
    const jobs = mockInputs.length;
    const opening = openRailgunIdentity({ archive: '/fixture.asar' }).catch((error) => error);
    await entered.promise;
    quarantineRailgunIdentityCredentials(original);
    release.resolve();
    expect(await opening).toMatchObject({ code: 'RAILGUN_IDENTITY_REFUSED' });
    expect(key.equals(Buffer.alloc(32))).toBe(true);
    expect(mockInputs).toHaveLength(jobs + 1);
  });
  test('spending permit callback cannot derive after quarantine', async () => {
    const options = await signingFixture();
    options.onKeyRequest = async () => {
      quarantineRailgunIdentityCredentials(identity);
      return {};
    };
    await expect(signRailgunPrivateIntent(options)).rejects.toMatchObject({
      code: 'RAILGUN_PRIVATE_SIGNING_REFUSED',
    });
    expect(mockDerived).toHaveLength(0);
  });
  test('quarantine wipes a spending loan immediately and retains its unfinished gate callback', async () => {
    const options = await signingFixture();
    const entered = quarantineDeferred(),
      release = quarantineDeferred();
    let checks = 0,
      settled = false;
    mockPermitConsume = () => ({
      assertCurrent: async () => {
        if (++checks === 2) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const work = signRailgunPrivateIntent(options).catch((error) => {
      settled = true;
      return error;
    });
    await entered.promise;
    quarantineRailgunIdentityCredentials(identity);
    expect(mockDerived[0].key.equals(Buffer.alloc(32))).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect(await work).toMatchObject({ code: 'RAILGUN_PRIVATE_SIGNING_REFUSED' });
  });
  test('late spending derivation after quarantine is wiped and never passed to the signer', async () => {
    const options = await signingFixture();
    const entered = quarantineDeferred(),
      release = quarantineDeferred();
    const attest = jest.fn(async () => {});
    mockPermitConsume = () => ({ assertCurrent: attest });
    let key;
    mockDeferSpending = async (value) => {
      key = value;
      entered.resolve();
      await release.promise;
    };
    const work = signRailgunPrivateIntent(options).catch((error) => error);
    await entered.promise;
    quarantineRailgunIdentityCredentials(identity);
    release.resolve();
    expect(await work).toMatchObject({ code: 'RAILGUN_PRIVATE_SIGNING_REFUSED' });
    expect(key.equals(Buffer.alloc(32))).toBe(true);
    expect(attest).toHaveBeenCalledTimes(1);
  });
});

async function relaySigningFixture() {
  identity = await openRailgunIdentity({ archive: '/fixture.asar' });
  mockDerived = [];
  const fixture =
    require('../../../scripts/fixtures/railgun-relay-unsigned-data').createRailgunRelayUnsignedData();
  const options = {
    identity,
    archive: '/fixture.asar',
    intent: fixture.draft.intent,
    recordDigest: '12'.repeat(32),
    signal: new AbortController().signal,
    onKeyRequest: async () => ({}),
  };
  const checked = require('./railgun-relay-intent').normalizeRailgunRelayUnsignedIntent(
    options.intent
  );
  const request = {
    id: 1,
    method: 'key',
    purpose: 'relay-sign',
    recordDigest: options.recordDigest,
    intentDigest: checked.digest,
    expectedHash: checked.data.expectedHash,
  };
  const result = {
    signature: {
      R8: ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)],
      S: '0x' + '0'.repeat(63) + '3',
    },
    message: checked.data.expectedHash,
    recordDigest: options.recordDigest,
    intentDigest: checked.digest,
    guards: { attempts: 0, canaries: 1, hooks: ['fixture.guard'] },
    inventory: require('./railgun-engine-manifest.json').inventory.sha256,
  };
  mockSignJob = async (job) => {
    expect(job.filename).toBe(require.resolve('./railgun-relay-sign-job'));
    expect(job.binaryKey).toBe(true);
    expect(JSON.parse(job.input)).toEqual({
      archive: '/fixture.asar',
      intent: checked.data,
      recordDigest: options.recordDigest,
      spendingPublicKey: identity.descriptor.spendingPublicKey.map((v) => '0x' + v),
    });
    const key = await job.broker.dispatch(JSON.stringify(request));
    expect(key.some((v) => v !== 0)).toBe(true);
    key.fill(0);
    await job.broker.dispatch(JSON.stringify({ id: 2, method: 'result', value: result }));
  };
  return { options, request, result };
}
const relayGate = () => ({ assertCurrent: async () => {}, issued() {} });
const relayRefused = { code: 'RAILGUN_RELAY_SIGNING_REFUSED' };

test('relay signer binds live token and exact intent; issuance exists only in synchronous issued extent', async () => {
  const { options, request, result } = await relaySigningFixture();
  let token,
    checks = 0,
    issued = 0,
    later;
  options.spendingPublicKey = ['caller cannot replace descriptor'];
  options.onKeyRequest = async (bound, value) => {
    token = value;
    expect(bound).toEqual({
      recordDigest: request.recordDigest,
      intentDigest: request.intentDigest,
      expectedHash: request.expectedHash,
    });
    expect(Object.isFrozen(bound)).toBe(true);
    expect(assertRailgunRelaySigner(token, identity, options)).toBeInstanceOf(AbortSignal);
    expect(() => assertRailgunRelayCredentialIssuance(token, identity, options)).toThrow();
    expect(() => assertRailgunPrivateSigner(token, identity, options)).toThrow();
    expect(() => assertRailgunRelaySigner({}, identity, options)).toThrow();
    expect(() => assertRailgunRelaySigner(token, {}, options)).toThrow();
    expect(() =>
      assertRailgunRelaySigner(token, identity, { ...options, recordDigest: '13'.repeat(32) })
    ).toThrow();
    const changed = JSON.parse(JSON.stringify(options.intent));
    changed.expectedHash = '0x' + '0'.repeat(63) + 'c';
    expect(() =>
      assertRailgunRelaySigner(token, identity, { ...options, intent: changed })
    ).toThrow();
    return { fixedPermit: true };
  };
  mockRelayPermitConsume = (permit, who, signer) => {
    expect(permit).toEqual({ fixedPermit: true });
    expect(who).toBe(identity);
    expect(signer).toBe(token);
    return {
      assertCurrent: async () => {
        checks++;
        expect(mockDerived).toHaveLength(checks - 1);
        expect(() => assertRailgunRelayCredentialIssuance(token, identity, options)).toThrow();
      },
      issued() {
        issued++;
        expect(checks).toBe(2);
        expect(mockDerived).toHaveLength(1);
        expect(assertRailgunRelayCredentialIssuance(token, identity, options)).toBeInstanceOf(
          AbortSignal
        );
        later = Promise.resolve().then(() =>
          expect(() => assertRailgunRelayCredentialIssuance(token, identity, options)).toThrow()
        );
      },
    };
  };
  const value = await signRailgunRelayIntent(options);
  await later;
  expect(value).toEqual({
    signature: result.signature,
    message: result.message,
    recordDigest: result.recordDigest,
    intentDigest: result.intentDigest,
  });
  expect(Object.isFrozen(value.signature.R8)).toBe(true);
  expect(issued).toBe(1);
  expect(checks).toBe(2);
  expect(mockDerived).toHaveLength(1);
  expect(mockDerived[0].path).toBe("m/44'/1984'/0'/0'/0'");
  expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
  expect(() => assertRailgunRelaySigner(token, identity, options)).toThrow();
  expect(() => assertRailgunRelayCredentialIssuance(token, identity, options)).toThrow();
});
test('absent fixed production consumer fails before derivation', async () => {
  const { options } = await relaySigningFixture();
  mockRelayPermitConsume = () =>
    jest.requireActual('./railgun-relay-operation').consumeRailgunRelaySigningPermit();
  await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
  expect(mockDerived).toHaveLength(0);
});
test.each(['purpose', 'recordDigest', 'intentDigest', 'expectedHash', 'extra', 'id'])(
  'relay key request %s mismatch refuses before permit callback',
  async (field) => {
    const { options, request } = await relaySigningFixture();
    options.onKeyRequest = jest.fn(async () => ({}));
    request[field] = field === 'id' ? 2 : 'changed';
    await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
    expect(options.onKeyRequest).not.toHaveBeenCalled();
    expect(mockDerived).toHaveLength(0);
  }
);
test.each(['signature', 'message', 'recordDigest', 'intentDigest', 'guards', 'inventory', 'extra'])(
  'untrusted relay signature result %s mismatch refuses',
  async (field) => {
    const { options, result } = await relaySigningFixture();
    mockRelayPermitConsume = relayGate;
    result[field] = 'changed';
    await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
    expect(mockDerived).toHaveLength(1);
    expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
  }
);
test.each([
  'missing issued',
  'first gate',
  'second gate',
  'issued throws',
  'issued return',
  'issued async',
  'issued closes',
])('relay %s fails closed and never makes a second loan', async (mode) => {
  const { options } = await relaySigningFixture();
  let checks = 0,
    issued = 0;
  mockRelayPermitConsume = () => {
    const gate = {
      assertCurrent: async () => {
        checks++;
        if ((mode === 'first gate' && checks === 1) || (mode === 'second gate' && checks === 2))
          throw Error('expired');
      },
      issued() {
        issued++;
        if (mode === 'issued throws') throw Error('marker');
        if (mode === 'issued return') return true;
        if (mode === 'issued async') return Promise.resolve();
        if (mode === 'issued closes') identity.close();
      },
    };
    if (mode === 'missing issued') delete gate.issued;
    return gate;
  };
  await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
  expect(mockDerived).toHaveLength(['missing issued', 'first gate'].includes(mode) ? 0 : 1);
  if (mockDerived.length) expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
  expect(issued).toBe(mode.startsWith('issued') ? 1 : 0);
});
test('relay callback remains original pending after child closure and excludes private and relay signing', async () => {
  const { options } = await relaySigningFixture();
  const entered = quarantineDeferred(),
    release = quarantineDeferred(),
    caller = new AbortController();
  options.signal = caller.signal;
  options.onKeyRequest = async () => {
    entered.resolve();
    await release.promise;
    return {};
  };
  let settled = false;
  const work = signRailgunRelayIntent(options).catch((error) => {
    settled = true;
    return error;
  });
  await entered.promise;
  caller.abort();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  const jobs = mockInputs.length;
  const competingRelay = signRailgunRelayIntent({
    ...options,
    signal: new AbortController().signal,
  }).catch((error) => error);
  const privateOptions = require('../../../scripts/fixtures/railgun-capsule-data').capsule(
    identity.descriptor.walletId
  ).preparation;
  const competingPrivate = signRailgunPrivateIntent({
    ...options,
    ...privateOptions,
    signal: new AbortController().signal,
  }).catch((error) => error);
  try {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockDerived).toHaveLength(0);
    expect(mockInputs).toHaveLength(jobs);
  } finally {
    release.resolve();
    await Promise.allSettled([work, competingRelay, competingPrivate]);
  }
  expect(await competingRelay).toMatchObject(relayRefused);
  expect(await competingPrivate).toMatchObject({ code: 'RAILGUN_PRIVATE_SIGNING_REFUSED' });
  expect(await work).toMatchObject(relayRefused);
});
test('pending private signer excludes relay and private token cannot impersonate relay', async () => {
  const options = await signingFixture(),
    entered = quarantineDeferred(),
    release = quarantineDeferred();
  const relayIntent =
    require('../../../scripts/fixtures/railgun-relay-unsigned-data').createRailgunRelayUnsignedData()
      .draft.intent;
  options.onKeyRequest = async (_request, token) => {
    expect(() =>
      assertRailgunRelaySigner(token, identity, {
        intent: relayIntent,
        recordDigest: '12'.repeat(32),
      })
    ).toThrow();
    entered.resolve();
    await release.promise;
    return {};
  };
  const work = signRailgunPrivateIntent(options).catch((error) => error);
  await entered.promise;
  const jobs = mockInputs.length;
  await expect(
    signRailgunRelayIntent({ ...options, intent: relayIntent, recordDigest: '12'.repeat(32) })
  ).rejects.toMatchObject(relayRefused);
  expect(mockInputs).toHaveLength(jobs);
  release.resolve();
  await work;
  expect(mockDerived).toHaveLength(0);
});
test.each(['derive', 'second gate'])(
  'relay revocation during pending original %s waits and wipes before issuance',
  async (stage) => {
    const { options } = await relaySigningFixture();
    const entered = quarantineDeferred(),
      release = quarantineDeferred(),
      caller = new AbortController();
    options.signal = caller.signal;
    let checks = 0,
      issued = 0,
      settled = false;
    if (stage === 'derive')
      mockDeferSpending = async () => {
        entered.resolve();
        await release.promise;
      };
    mockRelayPermitConsume = () => ({
      assertCurrent: async () => {
        if (++checks === 2 && stage === 'second gate') {
          entered.resolve();
          await release.promise;
        }
      },
      issued() {
        issued++;
      },
    });
    const work = signRailgunRelayIntent(options).catch((error) => {
      settled = true;
      return error;
    });
    await entered.promise;
    caller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    if (stage === 'second gate') expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
    release.resolve();
    expect(await work).toMatchObject(relayRefused);
    expect(issued).toBe(0);
    expect(mockDerived).toHaveLength(1);
    expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
  }
);
test('relay success waits for the original child closure', async () => {
  const { options } = await relaySigningFixture();
  const closed = quarantineDeferred(),
    closing = quarantineDeferred();
  mockRelayPermitConsume = relayGate;
  mockSignTask = (task) => {
    const close = task.close;
    task.close = () => {
      close();
      closing.resolve();
    };
    task.closed = closed.promise;
  };
  let settled = false;
  const work = signRailgunRelayIntent(options).then((value) => {
    settled = true;
    return value;
  });
  await closing.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  closed.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
  await work;
  expect(settled).toBe(true);
});
test('relay duplicate key request cannot obtain another loan', async () => {
  const { options, request } = await relaySigningFixture();
  mockRelayPermitConsume = relayGate;
  mockSignJob = async (job) => {
    const bytes = await job.broker.dispatch(JSON.stringify(request));
    bytes.fill(0);
    await job.broker.dispatch(JSON.stringify(request));
  };
  await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
  expect(mockDerived).toHaveLength(1);
});

test.each([undefined, null, new Error('declined')])(
  'ordinary rejected relay callback %p settles without quarantining a healthy identity',
  async (error) => {
    const { options } = await relaySigningFixture();
    options.onKeyRequest = async () => {
      throw error;
    };
    await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
    expect(mockDerived).toHaveLength(0);
    expect(() => assertRailgunIdentity(identity)).not.toThrow();
    options.onKeyRequest = async () => ({});
    mockRelayPermitConsume = relayGate;
    await expect(signRailgunRelayIntent(options)).resolves.toHaveProperty('signature');
    expect(mockDerived).toHaveLength(1);
  }
);
test('non-native relay callback thenable is not invoked and cannot grant a permit', async () => {
  const { options } = await relaySigningFixture();
  const then = jest.fn();
  options.onKeyRequest = () => ({ then });
  await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
  expect(then).not.toHaveBeenCalled();
  expect(mockDerived).toHaveLength(0);
  expect(() => assertRailgunIdentity(identity)).not.toThrow();
});
test('invalid asynchronous issued hook is drained without returning credential bytes', async () => {
  const { options } = await relaySigningFixture();
  const entered = quarantineDeferred(),
    release = quarantineDeferred();
  mockRelayPermitConsume = () => ({
    assertCurrent: async () => {},
    issued() {
      entered.resolve();
      return release.promise;
    },
  });
  let settled = false;
  const work = signRailgunRelayIntent(options).catch((error) => {
    settled = true;
    return error;
  });
  await entered.promise;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
  release.resolve();
  expect(await work).toMatchObject(relayRefused);
});
describe('relay unknown-original quarantine', () => {
  let serial = 0;
  beforeEach(() => {
    mockParent.close();
    mockParent = createPrivacyScope({
      profileId: `relay-unknown-${serial++}`,
      signal: mockVault.signal,
    });
  });
  test('rejected original child closure quarantines identity and cannot enable a replacement', async () => {
    const { options } = await relaySigningFixture();
    mockSignTask = (task) => {
      task.closed = Promise.reject(Error('unobserved child exit'));
    };
    await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
    expect(mockDerived).toHaveLength(0);
    expect(() => assertRailgunIdentity(identity)).toThrow();
    identity.close();
    await expect(openRailgunIdentity({ archive: '/fixture.asar' })).rejects.toMatchObject({
      code: 'RAILGUN_IDENTITY_REFUSED',
    });
  });
  test.each(['constructor', 'species'])(
    'unobservable original callback %s retains exclusion and quarantines without derivation',
    async (kind) => {
      const { options } = await relaySigningFixture();
      const original = quarantineDeferred();
      if (kind === 'constructor')
        Object.defineProperty(original.promise, 'constructor', {
          get() {
            throw Error('constructor');
          },
        });
      else
        Object.defineProperty(original.promise, 'constructor', {
          value: {
            get [Symbol.species]() {
              throw Error('species');
            },
          },
        });
      options.onKeyRequest = () => original.promise;
      await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
      expect(mockDerived).toHaveLength(0);
      expect(() => assertRailgunIdentity(identity)).toThrow();
      original.resolve({});
      await expect(signRailgunRelayIntent(options)).rejects.toMatchObject(relayRefused);
      expect(mockDerived).toHaveLength(0);
      identity.close();
      await expect(openRailgunIdentity({ archive: '/fixture.asar' })).rejects.toMatchObject({
        code: 'RAILGUN_IDENTITY_REFUSED',
      });
    }
  );
});

test.each(['resolve', 'reject'])(
  'early relay result synchronously revokes while original callback held, then %s cannot repair it',
  async (settlement) => {
    const { options, request, result } = await relaySigningFixture();
    const entered = quarantineDeferred(),
      release = quarantineDeferred(),
      sent = quarantineDeferred();
    let keyRequest,
      resultRequest,
      brokerSignal,
      synchronouslyRevoked,
      settled = false;
    options.onKeyRequest = async () => {
      entered.resolve();
      await release.promise;
      if (settlement === 'reject') throw Error('late original rejection');
      return {};
    };
    mockRelayPermitConsume = relayGate;
    mockSignJob = async (job) => {
      brokerSignal = job.broker.signal;
      keyRequest = job.broker.dispatch(JSON.stringify(request)).catch((error) => error);
      await entered.promise;
      resultRequest = job.broker
        .dispatch(JSON.stringify({ id: 2, method: 'result', value: result }))
        .catch((error) => error);
      synchronouslyRevoked = brokerSignal.aborted;
      sent.resolve();
      // Deliberately report ready without awaiting the original broker work.
    };
    const original = signRailgunRelayIntent(options).catch((error) => {
      settled = true;
      return error;
    });
    await sent.promise;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    try {
      expect(synchronouslyRevoked).toBe(true);
      expect(settled).toBe(false);
      expect(mockDerived).toHaveLength(0);
    } finally {
      release.resolve();
      await Promise.allSettled([original, resultRequest, keyRequest]);
    }
    expect(await original).toMatchObject(relayRefused);
    expect(require('util').types.isNativeError(await resultRequest)).toBe(true);
    expect(require('util').types.isNativeError(await keyRequest)).toBe(true);
    expect(mockDerived).toHaveLength(0);
  }
);
test.each(['scope', 'task', 'both'])(
  'throwing %s close cannot skip original callback, child barrier or loan cleanup',
  async (kind) => {
    const { options } = await relaySigningFixture();
    const entered = quarantineDeferred(),
      release = quarantineDeferred(),
      child = quarantineDeferred();
    let checks = 0,
      settled = false,
      taskCloseCalls = 0,
      scopeCloseCalls = 0;
    const caller = new AbortController();
    options.signal = caller.signal;
    mockRelayPermitConsume = () => ({
      assertCurrent: async () => {
        if (++checks === 2) {
          entered.resolve();
          await release.promise;
        }
      },
      issued() {},
    });
    if (kind === 'scope' || kind === 'both')
      mockScopeClose = (close) => () => {
        scopeCloseCalls++;
        close();
        throw Error('scope close failure');
      };
    mockSignTask = (task) => {
      task.closed = child.promise;
      const close = task.close;
      task.close = () => {
        taskCloseCalls++;
        close();
        if (kind === 'task' || kind === 'both') throw Error('task close failure');
      };
    };
    const original = signRailgunRelayIntent(options).catch((error) => {
      settled = true;
      return error;
    });
    await entered.promise;
    caller.abort();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockDerived).toHaveLength(1);
    expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
    expect(taskCloseCalls).toBeGreaterThan(0);
    if (kind !== 'task') expect(scopeCloseCalls).toBeGreaterThan(0);
    child.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    const jobs = mockInputs.length;
    await expect(
      signRailgunRelayIntent({ ...options, signal: new AbortController().signal })
    ).rejects.toMatchObject(relayRefused);
    expect(mockInputs).toHaveLength(jobs);
    release.resolve();
    expect(await original).toMatchObject(relayRefused);
    expect(mockDerived[0].key.every((v) => v === 0)).toBe(true);
  }
);
