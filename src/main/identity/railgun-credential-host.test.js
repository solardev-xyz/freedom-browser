const { createHash, createHmac } = require('crypto');
let mockVault, mockProfile, mockMnemonic, mockDerive, mockGuard;
const mockSeeds = [],
  mockGuardCalls = [];
jest.mock('./vault', () => ({
  getSessionSignal: () => mockVault.signal,
  getMnemonic: () => mockMnemonic,
}));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
jest.mock('./privacy-keys', () => {
  const original = jest.requireActual('./privacy-keys');
  const wrap =
    (name) =>
    (...args) => {
      const store = original[name](...args);
      return {
        ...store,
        deriveBytesAt(path) {
          const derive = () => store.deriveBytesAt(path);
          return mockDerive ? mockDerive(derive, path) : derive();
        },
      };
    };
  return {
    createRailgunKeystore: wrap('createRailgunKeystore'),
    createRailgunViewingKeystore: wrap('createRailgunViewingKeystore'),
  };
});
jest.mock('../wallet/privacy-profile-guard', () => ({
  createPrivacyProfileGuard: (options) => {
    mockSeeds.push(options.seed);
    mockGuardCalls.push(options);
    if (mockGuard) return mockGuard(options);
    return Object.freeze({
      assert() {
        jest.requireActual('../networks/privacy-context').getPrivacyContext(options.handle);
      },
    });
  },
}));
const { mnemonicToSeedSync } = require('@scure/bip39');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunCredentialHost } = require('./railgun-credential-host');
const PUBLIC_MNEMONIC = 'test test test test test test test test test test test junk';
const vectors = [
  [
    'b0958f8bc286ae0832fa83b01b719a225a07ce7b861ff311323f221667b3bd50',
    '9da4b4f0b5493a6ba3f7df0611c3e0842f7e2bb3d640f313b235f1b75c1d80b9',
  ],
  [
    'b54486f7304ca8618bce1ba764b24473592c967fef9ee425b1dafcb1504fe210',
    '9960238a86a7ecff390b7f37f680e7468fa0c41ee3704fcc68f0be82d19be4b2',
  ],
];
let scope, port, operation;
const hash = (v) => createHash('sha256').update(v).digest('hex');
function request(purpose = 'viewing', index = 0, changes = {}) {
  const subject = {
    kind: 'private-account',
    principal: `railgun:${index}`,
    protocol: 'railgun',
    chainId: 11155111,
    deployment: 'sepolia',
    role: purpose === 'storage-root' ? 'storage' : 'keystore',
    operation:
      purpose === 'storage-root'
        ? 'railgun-account-enrollment-v1'
        : purpose === 'viewing'
          ? 'viewing-identity'
          : purpose,
    ...changes,
  };
  return {
    handle: scope.getContext(subject),
    vaultSession: mockVault.signal,
    accountIndex: index,
    purpose,
    signal: operation.signal,
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
  mockVault = new AbortController();
  operation = new AbortController();
  mockProfile = { id: 'public-fixture', userDataDir: '/tmp/public-railgun-credential-fixture' };
  mockMnemonic = PUBLIC_MNEMONIC;
  mockDerive = undefined;
  mockGuard = undefined;
  mockSeeds.length = 0;
  mockGuardCalls.length = 0;
  scope = createPrivacyScope({
    profileId: hash(JSON.stringify([mockProfile.id, mockProfile.userDataDir])),
    signal: mockVault.signal,
  });
  port = createRailgunCredentialHost();
});
afterEach(() => {
  scope.close();
  jest.restoreAllMocks();
});
test('bootstrap port has only closed operations and no dependency injection', () => {
  expect(Object.keys(port).sort()).toEqual(['currentSession', 'withMaterial']);
  expect(Object.isFrozen(port)).toBe(true);
  expect(port.currentSession()).toBe(mockVault.signal);
  expect(() => port.currentSession({})).toThrow();
  expect(() => createRailgunCredentialHost({})).toThrow();
  expect(Object.keys(require('./railgun-credential-host'))).toEqual([
    'createRailgunCredentialHost',
  ]);
});
test.each([0, 1])(
  'actual fixed spending/public/signing/viewing derivation matches old independent vectors at index%i',
  async (index) => {
    for (const purpose of ['spending-public', 'spending-sign', 'viewing']) {
      let borrowed;
      const result = await port.withMaterial(request(purpose, index), async (loan) => {
        expect(Object.keys(loan)).toEqual(['bytes']);
        expect(Object.isFrozen(loan)).toBe(true);
        borrowed = loan.bytes;
        expect(Buffer.from(borrowed).toString('hex')).toBe(
          vectors[index][purpose === 'viewing' ? 1 : 0]
        );
        expect(borrowed.byteOffset).toBe(0);
        expect(borrowed.buffer.byteLength).toBe(32);
      });
      expect(result).toBeUndefined();
      expect([...borrowed]).toEqual(Array(32).fill(0));
    }
  }
);
test('relay signing maps to same fixed spending derivation without minting a signing permit', async () => {
  await port.withMaterial(
    request('spending-sign', 0, { operation: 'relay-sign' }),
    async ({ bytes }) => {
      expect(Buffer.from(bytes).toString('hex')).toBe(vectors[0][0]);
    }
  );
});
test('saved identity viewing context without an operation remains supported', async () => {
  await port.withMaterial(request('viewing', 0, { operation: undefined }), async ({ bytes }) => {
    expect(Buffer.from(bytes).toString('hex')).toBe(vectors[0][1]);
  });
});
test('storage root and every existing child purpose/generation preserve original HMAC bytes; seed is wiped before use', async () => {
  const input = request('storage-root');
  let root, guard;
  const seed = mnemonicToSeedSync(PUBLIC_MNEMONIC);
  const expected = createHmac('sha256', seed)
    .update('Freedom Railgun account storage v1\0')
    .update(JSON.stringify([getPrivacyContext(input.handle).profileId, 0, 11155111, 'sepolia']))
    .digest();
  const purposes = [
    'account-manifest',
    'wallet-catalog',
    'private-reservations',
    'private-capsules',
    'poi-intents',
    'relay-local-recovery-v4',
    'public-catalog',
    'source-ledger',
    'public-store',
    'scan-journal',
    'wallet-store',
    'wallet-journal',
    'txid-store',
    'txid-journal',
  ];
  await port.withMaterial(input, async (loan) => {
    expect(Object.keys(loan)).toEqual(['bytes', 'profileGuard']);
    root = loan.bytes;
    guard = loan.profileGuard;
    expect(root).toEqual(expected);
    expect(mockSeeds[0].every((byte) => byte === 0)).toBe(true);
    expect(mockGuardCalls[0].handle).toBe(input.handle);
    expect(mockGuardCalls[0].profile).toEqual(mockProfile);
    for (const purpose of purposes)
      for (const generation of [
        null,
        '1'.repeat(64),
        ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
      ]) {
        expect(
          createHmac('sha256', root)
            .update(JSON.stringify([1, purpose, generation]))
            .digest()
        ).toEqual(
          createHmac('sha256', expected)
            .update(JSON.stringify([1, purpose, generation]))
            .digest()
        );
      }
  });
  expect([...root]).toEqual(Array(32).fill(0));
  // Guard belongs to original enrollment context, not the root-material loan.
  expect(() => guard.assert()).not.toThrow();
  scope.close();
  expect(() => guard.assert()).toThrow();
  seed.fill(0);
  expected.fill(0);
});
test('actual public synthetic profile guard survives root loan and preserves its inventory MAC domain', async () => {
  const fs = require('fs'),
    path = require('path'),
    os = require('os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-credential-public-'));
  scope.close();
  mockProfile = { id: 'public-fixture', userDataDir: fs.realpathSync(directory) };
  scope = createPrivacyScope({
    profileId: hash(JSON.stringify([mockProfile.id, mockProfile.userDataDir])),
    signal: mockVault.signal,
  });
  mockGuard = (options) =>
    jest.requireActual('../wallet/privacy-profile-guard').createPrivacyProfileGuard(options);
  let guard;
  const input = request('storage-root');
  await port.withMaterial(input, async (loan) => {
    guard = loan.profileGuard;
  });
  const file = path.join(
    mockProfile.userDataDir,
    'wallet-railgun-accounts',
    '0'.repeat(64) + '.json'
  );
  guard.assert(file);
  const inventory = JSON.parse(
    fs.readFileSync(path.join(directory, 'wallet-privacy-inventory.json'), 'utf8')
  );
  const seed = mnemonicToSeedSync(PUBLIC_MNEMONIC),
    key = createHmac('sha256', seed)
      .update('Freedom privacy inventory v1\0')
      .update(mockProfile.id)
      .digest();
  expect(inventory.mac).toBe(
    createHmac('sha256', key).update(JSON.stringify(inventory.state)).digest('hex')
  );
  scope.close();
  expect(() => guard.assert(file)).toThrow();
  seed.fill(0);
  key.fill(0);
  // Deliberately retained disposable public evidence; no unrelated profile is read.
});
test.each(['vault', 'operation', 'context'])(
  'abort%s wipes admitted bytes immediately but waits for original callback',
  async (mode) => {
    let borrowed, release;
    const original = new Promise((resolve) => {
      release = resolve;
    });
    let settled = false;
    const pending = port.withMaterial(request(), (loan) => {
      borrowed = loan.bytes;
      return original;
    });
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await turn();
    expect(borrowed.some((byte) => byte !== 0)).toBe(true);
    if (mode === 'vault') mockVault.abort();
    else if (mode === 'operation') operation.abort();
    else scope.close();
    expect(borrowed.every((byte) => byte === 0)).toBe(true);
    await turn();
    expect(settled).toBe(false);
    release();
    await expect(pending).rejects.toThrow();
    expect(settled).toBe(true);
  }
);
test('late original derivation after cancellation is wiped and never enters callback', async () => {
  let deliver, late;
  mockDerive = async (derive) => {
    late = await derive();
    await new Promise((resolve) => {
      deliver = resolve;
    });
    return late;
  };
  const use = jest.fn(async () => {}),
    pending = port.withMaterial(request(), use);
  await turn();
  operation.abort();
  deliver();
  await expect(pending).rejects.toThrow();
  expect(late.every((byte) => byte === 0)).toBe(true);
  expect(use).not.toHaveBeenCalled();
});
test.each(['vault', 'profile'])(
  'current%s identity is rechecked after original derivation',
  async (mode) => {
    let deliver, late;
    mockDerive = async (derive) => {
      late = await derive();
      await new Promise((resolve) => {
        deliver = resolve;
      });
      return late;
    };
    const use = jest.fn(async () => {}),
      pending = port.withMaterial(request(), use);
    await turn();
    if (mode === 'vault') mockVault = new AbortController();
    else mockProfile = { ...mockProfile, userDataDir: mockProfile.userDataDir + '-other' };
    deliver();
    await expect(pending).rejects.toThrow();
    expect(late.every((byte) => byte === 0)).toBe(true);
    expect(use).not.toHaveBeenCalled();
  }
);
test('request fields are captured before first await', async () => {
  let deliver;
  mockDerive = async (derive) => {
    const bytes = await derive();
    await new Promise((resolve) => {
      deliver = resolve;
    });
    return bytes;
  };
  const input = request();
  const pending = port.withMaterial(input, async ({ bytes }) => {
    expect(Buffer.from(bytes).toString('hex')).toBe(vectors[0][1]);
  });
  await turn();
  input.accountIndex = 1;
  input.purpose = 'spending-sign';
  input.handle = {};
  deliver();
  await pending;
});
test('callback rejection preserves the original internal error and wipes the loan', async () => {
  const error = Object.assign(Error('original callback'), {
    code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
  });
  let bytes;
  await expect(
    port.withMaterial(request(), async (loan) => {
      bytes = loan.bytes;
      throw error;
    })
  ).rejects.toBe(error);
  expect(bytes.every((byte) => byte === 0)).toBe(true);
});
test('native observation bypasses own then while retaining original settlement', async () => {
  let release, bytes;
  const original = new Promise((resolve) => {
    release = resolve;
  });
  const touched = jest.fn();
  Object.defineProperty(original, 'then', { get: touched });
  const pending = port.withMaterial(request(), (loan) => {
    bytes = loan.bytes;
    return original;
  });
  await turn();
  expect(touched).not.toHaveBeenCalled();
  release();
  await pending;
  expect(bytes.every((byte) => byte === 0)).toBe(true);
});
test.each(['constructor', 'species'])(
  'unobservable native %s never claims callback drain and wipes immediately',
  async (mode) => {
    let release, bytes;
    const original = new Promise((resolve) => {
      release = resolve;
    });
    if (mode === 'constructor')
      Object.defineProperty(original, 'constructor', {
        get() {
          throw Error('constructor');
        },
      });
    else Object.defineProperty(original, 'constructor', { value: { [Symbol.species]: {} } });
    let settled = false;
    const pending = port.withMaterial(request(), (loan) => {
      bytes = loan.bytes;
      return original;
    });
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await turn();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    operation.abort();
    release();
    await turn();
    expect(settled).toBe(false);
  }
);
test.each(['sync-bytes', 'async-bytes', 'thenable', 'sync-undefined'])(
  'no callback result can export key material: %s',
  async (mode) => {
    let bytes;
    const touched = jest.fn();
    await expect(
      port.withMaterial(request(), (loan) => {
        bytes = loan.bytes;
        if (mode === 'sync-bytes') return bytes;
        if (mode === 'async-bytes') return Promise.resolve(bytes);
        if (mode === 'thenable')
          return {
            get then() {
              touched();
              throw Error('thenable');
            },
          };
      })
    ).rejects.toThrow();
    expect(touched).not.toHaveBeenCalled();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  }
);
test.each([
  ['purpose', 'anything'],
  ['accountIndex', -0],
  ['accountIndex', -1],
  ['accountIndex', 65536],
  ['accountIndex', 1.5],
  ['handle', {}],
  ['vaultSession', new AbortController().signal],
  ['signal', {}],
])('closed request rejects %s', async (field, value) => {
  const use = jest.fn(async () => {});
  await expect(port.withMaterial({ ...request(), [field]: value }, use)).rejects.toThrow();
  expect(use).not.toHaveBeenCalled();
});
test.each([
  ['kind', 'service'],
  ['principal', 'railgun:1'],
  ['protocol', 'ppv2'],
  ['deployment', 'mainnet'],
  ['chainId', 1],
  ['role', 'engine'],
  ['operation', 'spending-public'],
])('genuine context must match exact credential account/purpose: %s', async (field, value) => {
  const use = jest.fn(async () => {});
  await expect(port.withMaterial(request('viewing', 0, { [field]: value }), use)).rejects.toThrow();
  expect(use).not.toHaveBeenCalled();
});
test.each(['path', 'mnemonic', 'seed', 'generation', 'derive', 'extra-symbol', 'getter', 'proxy'])(
  'closed request refuses forbidden %s without evaluating it',
  async (mode) => {
    const input = request(),
      touched = jest.fn();
    let value = input;
    if (mode === 'extra-symbol') input[Symbol('x')] = 1;
    else if (mode === 'getter') Object.defineProperty(input, 'purpose', { get: touched });
    else if (mode === 'proxy')
      value = new Proxy(input, {
        getOwnPropertyDescriptor() {
          touched();
          throw Error('proxy');
        },
      });
    else input[mode] = 'forbidden';
    await expect(port.withMaterial(value, async () => {})).rejects.toThrow();
    expect(touched).not.toHaveBeenCalled();
  }
);
test('storage guard failure wipes original seed without entering material callback', async () => {
  const error = Error('original guard');
  mockGuard = () => {
    throw error;
  };
  const use = jest.fn(async () => {});
  await expect(port.withMaterial(request('storage-root'), use)).rejects.toBe(error);
  expect(mockSeeds[0].every((byte) => byte === 0)).toBe(true);
  expect(use).not.toHaveBeenCalled();
});

test.each(['renderer', 'utility', 'worker'])(
  'credential host refuses the %s realm without accessing the vault',
  (type) => {
    const vm = require('vm'),
      fs = require('fs'),
      box = { exports: {} };
    const source = fs.readFileSync(require.resolve('./railgun-credential-host'), 'utf8');
    vm.runInNewContext(source, {
      module: box,
      process: { type: type === 'worker' ? undefined : type },
      Promise,
      AbortSignal,
      EventTarget,
      require: (name) =>
        name === 'worker_threads' ? { isMainThread: type !== 'worker' } : require(name),
    });
    expect(() => box.exports.createRailgunCredentialHost()).toThrow(
      'Railgun credential unavailable'
    );
  }
);

const purposeContexts = ['spending-public', 'viewing', 'spending-sign', 'storage-root'].flatMap(
  (purpose) =>
    [
      ['keystore', 'spending-public'],
      ['keystore', 'viewing-identity'],
      ['keystore', undefined],
      ['keystore', 'spending-sign'],
      ['keystore', 'relay-sign'],
      ['storage', 'railgun-account-enrollment-v1'],
      ['engine', 'wallet-viewing'],
      ['engine', 'private-prepare'],
      ['engine', 'private-operate'],
      ['engine', 'spending-sign'],
    ].map(([role, operation]) => [purpose, role, operation])
);
test.each(purposeContexts)(
  'fixed host purpose/context table %s/%s/%s',
  async (purpose, role, operation) => {
    const allowed =
      purpose === 'storage-root'
        ? role === 'storage' && operation === 'railgun-account-enrollment-v1'
        : role === 'keystore' &&
          (purpose === 'viewing'
            ? [undefined, 'viewing-identity'].includes(operation)
            : purpose === 'spending-public'
              ? operation === 'spending-public'
              : ['spending-sign', 'relay-sign'].includes(operation));
    const use = jest.fn(async () => {}),
      pending = port.withMaterial(request(purpose, 0, { role, operation }), use);
    if (allowed) {
      await expect(pending).resolves.toBeUndefined();
      expect(use).toHaveBeenCalledTimes(1);
    } else {
      await expect(pending).rejects.toThrow();
      expect(use).not.toHaveBeenCalled();
    }
  }
);
test('cleanup uses intrinsic buffer/signal methods and preserves original typed unknown failure', async () => {
  const touched = jest.fn(() => {
      throw Error('overridden cleanup');
    }),
    error = Object.assign(Error('original'), { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  Object.defineProperty(operation.signal, 'addEventListener', { get: touched });
  Object.defineProperty(operation.signal, 'removeEventListener', { get: touched });
  let bytes;
  await expect(
    port.withMaterial(request(), async (loan) => {
      bytes = loan.bytes;
      Object.defineProperty(bytes, 'fill', { value: touched });
      throw error;
    })
  ).rejects.toBe(error);
  expect(touched).not.toHaveBeenCalled();
  expect([...bytes]).toEqual(Array(32).fill(0));
});

test.each(['', null, undefined])(
  'storage root refuses absent unlocked vault mnemonic %s',
  async (mnemonic) => {
    mockMnemonic = mnemonic;
    const use = jest.fn(async () => {});
    await expect(port.withMaterial(request('storage-root'), use)).rejects.toMatchObject({
      code: 'RAILGUN_CREDENTIAL_REFUSED',
    });
    expect(use).not.toHaveBeenCalled();
    expect(mockGuardCalls).toHaveLength(0);
  }
);

// Exact package-owned public vectors and repo-only harness; no runtime export.
const publicCredentialVectors = require('../../../test/fixtures/railgun/railgun-credential-vectors.json');
const {
  checkCredentialRow,
  checkStorageRootDrain,
} = require('../../../test/fixtures/railgun/railgun-credential-conformance.cjs');
test.each(publicCredentialVectors.rows)(
  'normative host conformance for $profile.id account $accountIndex',
  async (row) => {
    mockProfile = { ...row.profile };
    mockMnemonic = publicCredentialVectors.mnemonic;
    expect(hash(JSON.stringify([mockProfile.id, mockProfile.userDataDir]))).toBe(row.profileId);
    const results = await checkCredentialRow({
      host: port,
      row,
      createContext: (selected, purpose) => {
        const genuine = createPrivacyScope({
          profileId: selected.profileId,
          signal: mockVault.signal,
        });
        const handle = genuine.getContext({
          kind: 'private-account',
          principal: `railgun:${selected.accountIndex}`,
          protocol: 'railgun',
          chainId: publicCredentialVectors.chainId,
          deployment: publicCredentialVectors.deployment,
          role: purpose === 'storage-root' ? 'storage' : 'keystore',
          operation:
            purpose === 'storage-root'
              ? 'railgun-account-enrollment-v1'
              : purpose === 'viewing'
                ? 'viewing-identity'
                : purpose,
        });
        return {
          request: {
            handle,
            vaultSession: mockVault.signal,
            accountIndex: selected.accountIndex,
            purpose,
            signal: operation.signal,
          },
          assertProfileGuard(guard) {
            expect(mockGuardCalls.at(-1).handle).toBe(handle);
            expect(mockGuardCalls.at(-1).profile).toEqual(row.profile);
            expect(mockSeeds.at(-1).every((byte) => byte === 0)).toBe(true);
            expect(() => guard.assert()).not.toThrow();
          },
          close: () => genuine.close(),
        };
      },
    });
    expect(results).toHaveLength(4);
    expect(
      results.every(
        (result) =>
          result.vectorMatched && result.borrowedBufferWiped && result.originalPromiseRetained
      )
    ).toBe(true);
  }
);
test('normative vector fixture is byte-pinned with boundary account indices', () => {
  const fs = require('fs');
  expect(
    hash(
      fs.readFileSync(
        require.resolve('../../../test/fixtures/railgun/railgun-credential-vectors.json')
      )
    )
  ).toBe('b8a307b09928447bded772da46de8826e597ce013d80e4a51458a1d9946cd1af');
  expect(publicCredentialVectors.rows.map((row) => row.accountIndex)).toEqual([
    0, 1, 65535, 0, 1, 65535,
  ]);
});

test('storage-root teardown observes the original callback after context revocation', async () => {
  const input = request('storage-root');
  input.signal = scope.signal;
  let borrowed,
    release,
    settled = false;
  const original = new Promise((resolve) => {
    release = resolve;
  });
  const pending = port.withMaterial(input, (loan) => {
    borrowed = loan.bytes;
    return original;
  });
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await turn();
  expect(borrowed.some((byte) => byte !== 0)).toBe(true);
  scope.close();
  expect(borrowed.every((byte) => byte === 0)).toBe(true);
  await turn();
  expect(settled).toBe(false);
  release();
  await expect(pending).resolves.toBeUndefined();
  expect(settled).toBe(true);
  expect(() => getPrivacyContext(input.handle)).toThrow();
});

test.each(['operation-only', 'context-only'])(
  'storage-root teardown still refuses %s',
  async (mode) => {
    const input = request('storage-root');
    let release;
    const original = new Promise((resolve) => {
      release = resolve;
    });
    const pending = port.withMaterial(input, () => original);
    const observed = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_CREDENTIAL_REFUSED' });
    await turn();
    if (mode === 'operation-only') operation.abort();
    else scope.close();
    release();
    await observed;
  }
);
test.each(['reject', 'non-void'])(
  'storage-root teardown preserves the callback failure: %s',
  async (mode) => {
    const input = request('storage-root');
    input.signal = scope.signal;
    const failure = Object.assign(new Error('original cleanup failed'), {
      code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
    });
    let release, reject;
    const original = new Promise((yes, no) => {
      release = yes;
      reject = no;
    });
    const pending = port.withMaterial(input, () => original);
    const observed =
      mode === 'reject'
        ? expect(pending).rejects.toBe(failure)
        : expect(pending).rejects.toMatchObject({ code: 'RAILGUN_CREDENTIAL_REFUSED' });
    await turn();
    scope.close();
    if (mode === 'reject') reject(failure);
    else release({ notAuthority: true });
    await observed;
  }
);

test.each(['viewing', 'spending-public', 'spending-sign'])(
  'root-drain exception never applies to %s',
  async (purpose) => {
    const input = request(purpose);
    input.signal = scope.signal;
    let release;
    const original = new Promise((resolve) => {
      release = resolve;
    });
    const pending = port.withMaterial(input, () => original);
    const observed = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_CREDENTIAL_REFUSED' });
    await turn();
    scope.close();
    release();
    await observed;
  }
);

test.each(['vault-lock', 'vault-replace', 'profile-change'])(
  'storage-root has a drained void result after revoked teardown: %s',
  async (mode) => {
    const input = request('storage-root');
    input.signal = scope.signal;
    let borrowed, release;
    const original = new Promise((resolve) => {
      release = resolve;
    });
    const pending = port.withMaterial(input, (loan) => {
      borrowed = loan.bytes;
      return original;
    });
    await turn();
    if (mode === 'vault-lock') mockVault.abort();
    else scope.close();
    if (mode === 'vault-replace') mockVault = new AbortController();
    if (mode === 'profile-change') mockProfile = { ...mockProfile, id: 'new-profile' };
    expect(borrowed.every((byte) => byte === 0)).toBe(true);
    release();
    await expect(pending).resolves.toBeUndefined();
    expect(() => getPrivacyContext(input.handle)).toThrow();
  }
);
test.each(['vault-replace', 'profile-change'])(
  'storage-root still rejects currency changes without revoked teardown: %s',
  async (mode) => {
    const input = request('storage-root');
    let release;
    const original = new Promise((resolve) => {
      release = resolve;
    });
    const pending = port.withMaterial(input, () => original);
    const observed = expect(pending).rejects.toMatchObject({ code: 'RAILGUN_CREDENTIAL_REFUSED' });
    await turn();
    if (mode === 'vault-replace') mockVault = new AbortController();
    else mockProfile = { ...mockProfile, id: 'new-profile' };
    release();
    await observed;
  }
);

test('storage-root teardown never fabricates settlement of an unobservable callback', async () => {
  const input = request('storage-root');
  input.signal = scope.signal;
  let borrowed,
    settled = false;
  const original = Promise.resolve();
  Object.defineProperty(original, 'constructor', {
    get() {
      throw new Error('unobservable');
    },
  });
  const pending = port.withMaterial(input, (loan) => {
    borrowed = loan.bytes;
    return original;
  });
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await turn();
  scope.close();
  await turn();
  expect(borrowed.every((byte) => byte === 0)).toBe(true);
  expect(settled).toBe(false);
});
test('storage-root revocation before callback delivery still refuses', async () => {
  const input = request('storage-root');
  input.signal = scope.signal;
  mockGuard = () => {
    scope.close();
    return Object.freeze({});
  };
  const consume = jest.fn(async () => {});
  await expect(port.withMaterial(input, consume)).rejects.toMatchObject({
    code: 'RAILGUN_CREDENTIAL_REFUSED',
  });
  expect(consume).not.toHaveBeenCalled();
  expect(mockSeeds[0].every((byte) => byte === 0)).toBe(true);
});

test('package normative root-drain harness uses the genuine host context', async () => {
  const row = publicCredentialVectors.rows[0];
  mockProfile = { ...row.profile };
  mockMnemonic = publicCredentialVectors.mnemonic;
  const result = await checkStorageRootDrain({
    host: port,
    row,
    createContext: (selected, purpose) => {
      const genuine = createPrivacyScope({
        profileId: selected.profileId,
        signal: mockVault.signal,
      });
      const handle = genuine.getContext({
        kind: 'private-account',
        principal: `railgun:${selected.accountIndex}`,
        protocol: 'railgun',
        chainId: publicCredentialVectors.chainId,
        deployment: publicCredentialVectors.deployment,
        role: 'storage',
        operation: 'railgun-account-enrollment-v1',
      });
      return {
        request: {
          handle,
          vaultSession: mockVault.signal,
          accountIndex: selected.accountIndex,
          purpose,
          signal: genuine.signal,
        },
        assertProfileGuard(guard) {
          expect(mockGuardCalls.at(-1).handle).toBe(handle);
          expect(() => guard.assert()).not.toThrow();
        },
        close: () => genuine.close(),
      };
    },
  });
  expect(result).toHaveLength(1);
});
