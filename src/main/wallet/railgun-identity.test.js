let mockVault, mockParent, mockOnJob, mockInputs, mockClosed, mockCurrent;
jest.mock('../identity/vault', () => ({
  getMnemonic: () =>
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  getSessionSignal: () => mockVault.signal,
}));
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
} = require('./railgun-identity');
let identity;
beforeEach(() => {
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
