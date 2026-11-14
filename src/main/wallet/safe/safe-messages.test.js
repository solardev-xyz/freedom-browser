const { hashMessage, TypedDataEncoder, getAddress } = require('ethers');
const {
  calculateSafeMessageHash,
  hashSafeMessage,
  buildSignatureBytes,
} = require('@safe-global/protocol-kit');

const { ownerWallet } = require('./__tests__/helpers/test-owners');

const OWNERS = [ownerWallet(0).address, ownerWallet(2).address, ownerWallet(4).address];
const SAFE_ADDRESS = getAddress('0x41aD4887971f90BB3fE4d83eCa65177281283261');

let mockTmpDir = require('os').tmpdir();
// Fake webContents per id — sessions bind to the requesting page's
// webContents and are dropped when it navigates or is destroyed.
const mockWebContentsById = new Map();
jest.mock('electron', () => ({
  app: { getPath: () => mockTmpDir },
  webContents: { fromId: (id) => mockWebContentsById.get(id) || null },
}));

function fakeWebContents(id) {
  const listeners = new Map();
  const contents = {
    id,
    destroyed: false,
    isDestroyed: () => contents.destroyed,
    on: (event, fn) => {
      listeners.set(event, [...(listeners.get(event) || []), fn]);
    },
    removeListener: (event, fn) => {
      listeners.set(
        event,
        (listeners.get(event) || []).filter((listener) => listener !== fn)
      );
    },
    emit: (event) => {
      for (const fn of [...(listeners.get(event) || [])]) fn();
    },
    listenerCount: (event) => (listeners.get(event) || []).length,
  };
  mockWebContentsById.set(id, contents);
  return contents;
}

function destroyWebContents(id) {
  const contents = mockWebContentsById.get(id);
  if (contents) {
    contents.destroyed = true;
    contents.emit('destroyed');
    mockWebContentsById.delete(id);
  }
}

// Records as vault-meta stores them: `deployed` holds the stored marks,
// which the record seam filters as identity-manager's does (#1066).
const mockWalletRecords = {
  0: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
  2: { index: 2, name: 'My Stax', address: OWNERS[1], type: 'ledger' },
  4: { index: 4, name: 'My Phone', address: OWNERS[2], type: 'remote' },
  5: {
    index: 5,
    name: 'Joint',
    address: SAFE_ADDRESS,
    type: 'safe',
    owners: [0, 2, 4],
    threshold: 2,
    saltNonce: '7508',
    deployed: { 100: { verified: true } },
  },
  6: {
    index: 6,
    name: 'Fresh',
    address: SAFE_ADDRESS.replace('41', '42'),
    type: 'safe',
    owners: [0, 2],
    threshold: 1,
    saltNonce: '9',
    deployed: {},
  },
  7: {
    index: 7,
    name: 'Backup',
    address: getAddress(SAFE_ADDRESS.toLowerCase().replace('0x41', '0x43')),
    type: 'safe',
    owners: [0, 2],
    threshold: 1,
    saltNonce: '11',
    deployed: { 100: { verified: true } },
  },
  // Marked deployed by a release before #1066, on one endpoint's answer.
  8: {
    index: 8,
    name: 'Old mark',
    address: getAddress(SAFE_ADDRESS.toLowerCase().replace('0x41', '0x44')),
    type: 'safe',
    owners: [0, 2],
    threshold: 1,
    saltNonce: '13',
    deployed: { 100: true },
  },
};
const mockIsVaultUnlocked = jest.fn(async () => true);
jest.mock('../../identity-manager', () => {
  const { verifiedDeployments } = jest.requireActual('./deployed-mark');
  return {
    getWalletRecord: (index) => {
      const record = mockWalletRecords[index];
      if (!record) return null;
      return record.type === 'safe'
        ? { ...record, deployed: verifiedDeployments(record.deployed) }
        : record;
    },
    isVaultUnlocked: (...args) => mockIsVaultUnlocked(...args),
    WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
  };
});

// Distinct 65-byte signature blobs per owner so concatenation order is
// visible in completeSafeMessage's output.
const sigDataOf = { 0: '0x' + '11'.repeat(65), 2: '0x' + '22'.repeat(65), 4: '0x' + '33'.repeat(65) };
const signatureOf = (index) => ({
  signer: OWNERS[index === 0 ? 0 : index === 2 ? 1 : 2],
  data: sigDataOf[index],
});
// As the owner's signer does: the caller's last check, if any, right
// before it signs (`signers.js`); `mockOwnersSigned` counts the signatures
// made past it.
let mockOwnersSigned = 0;
const mockCollectOwnerSignature = jest.fn(async ({ ownerIndex, beforeSign }) => {
  if (beforeSign) await beforeSign();
  mockOwnersSigned += 1;
  return signatureOf(ownerIndex);
});
jest.mock('./safe-executor', () => ({
  SAFE_VERSION: '1.4.1',
  collectOwnerSignature: (...args) => mockCollectOwnerSignature(...args),
  pickDefaultExecutor: jest.requireActual('./safe-executor').pickDefaultExecutor,
}));

// The identity core's typed_data.hash (freedom-core design 0002), simulated
// with ethers: the real core matches it for every input it accepts.
const mockTypedDataHash = jest.fn(async ({ domain, types, message }) =>
  require('ethers').TypedDataEncoder.hash(domain, types, message)
);
// The core's `approval.end` (freedom-core design 0012), and whether the
// core process that gave an approval has ended since.
const mockApprovalEnd = jest.fn(async () => ({}));
const mockProcessEnded = jest.fn(() => false);
jest.mock('../../core/vault-backend', () => ({
  vaultBackend: {
    typedDataHash: (...args) => mockTypedDataHash(...args),
    approval: { end: (...args) => mockApprovalEnd(...args) },
    coreProcess: () => ({ process: 'core' }),
    coreProcessEnded: (...args) => mockProcessEnded(...args),
  },
}));

jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => ({ request: jest.fn() }),
}));

const {
  startSafeMessage,
  signSafeMessage,
  completeSafeMessage,
  cancelSafeMessage,
  getSafeMessageState,
} = require('./safe-messages');
const { getSession, discardSession } = require('./message-sessions');
const { SAFE_MESSAGE_EXISTS } = require('./errors');
const safeApprovals = require('./safe-approvals');

// A page's Safe approval, as the core gives one at the spend of its
// `safe-message` token or its site's rule: held for the page's PageContext.
const PAGE = Object.freeze({ origin: 'https://app.example', top_origin: 'https://app.example', frame: 2, navigation: 6, agent: false });
let approvalCount = 0;
const newApproval = (page = PAGE) => ({ id: (++approvalCount).toString(16).padStart(32, '0'), page });
const endedIds = () => mockApprovalEnd.mock.calls.map(([id]) => id);

// "hello" hex-encoded, the way dApps send personal_sign payloads.
const HEX_MESSAGE = '0x68656c6c6f';

const DAPP_TYPED_DATA = {
  domain: { name: 'Test Dapp', chainId: 100, verifyingContract: '0x' + 'ab'.repeat(20) },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Order: [{ name: 'amount', type: 'uint256' }],
  },
  primaryType: 'Order',
  message: { amount: '12' },
};

const DISPLAY = { site: 'app.example', method: 'personal_sign' };

// Two live dApp pages: the legitimate requester and a second tab on a
// different site.
const TAB_A = { origin: 'app.example', webContentsId: 101 };
const TAB_B = { origin: 'other.example', webContentsId: 202 };

const startPersonal = (safeIndex = 5, message = HEX_MESSAGE, requester = TAB_A) =>
  startSafeMessage({
    approval: newApproval(PAGE),
    safeIndex,
    request: { method: 'personal_sign', params: [message, SAFE_ADDRESS] },
    display: DISPLAY,
    requester,
  });

// Microtasks, immediates, and the (zero) waits before an end is asked again.
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const busy = () => Object.assign(new Error('Too many requests'), { code: 'busy' });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsVaultUnlocked.mockResolvedValue(true);
  mockApprovalEnd.mockReset().mockResolvedValue({});
  mockProcessEnded.mockReset().mockReturnValue(false);
  for (const index of [5, 6, 7, 8]) discardSession(index);
  safeApprovals._reset({ retryDelays: [0, 0] });
  mockWebContentsById.clear();
  fakeWebContents(TAB_A.webContentsId);
  fakeWebContents(TAB_B.webContentsId);
});

describe('startSafeMessage', () => {
  test('wraps a hex personal message: EIP-191 digest over the BYTES in the SafeMessage envelope', async () => {
    const state = await startPersonal();

    // digest = what an EOA signer / verifying dApp computes: EIP-191
    // over the decoded bytes ("hello"), never the "0x…" text as UTF-8
    const digest = hashMessage('hello');
    expect(state.hash).toBe(calculateSafeMessageHash(SAFE_ADDRESS, digest, '1.4.1', 100n));

    // the payload every owner signs is the SafeMessage envelope
    expect(mockCollectOwnerSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        typedData: expect.objectContaining({
          primaryType: 'SafeMessage',
          domain: { chainId: 100, verifyingContract: SAFE_ADDRESS },
          message: { message: digest },
        }),
        ownerIndex: 0,
      })
    );

    // only the free (mnemonic) owner was asked — devices never cold-called
    expect(mockCollectOwnerSignature).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      safeIndex: 5,
      kind: 'message',
      chainId: 100,
      threshold: 2,
      collected: 1,
      complete: false,
      display: DISPLAY,
      owners: [
        { index: 0, type: 'mnemonic', signed: true },
        { index: 2, type: 'ledger', signed: false },
        { index: 4, type: 'remote', signed: false },
      ].map((owner) => expect.objectContaining(owner)),
    });
    // the session capability every follow-up call must present
    expect(typeof state.token).toBe('string');
    expect(state.token.length).toBeGreaterThanOrEqual(32);
  });

  test('plain-text personal messages hash as UTF-8', async () => {
    const state = await startPersonal(5, 'gm world');
    expect(state.hash).toBe(
      calculateSafeMessageHash(SAFE_ADDRESS, hashMessage('gm world'), '1.4.1', 100n)
    );
  });

  test('wraps dApp typed data (JSON-string param), matching protocol-kit hashing', async () => {
    const state = await startSafeMessage({
      approval: newApproval(PAGE),
      safeIndex: 5,
      request: {
        method: 'eth_signTypedData_v4',
        params: [SAFE_ADDRESS, JSON.stringify(DAPP_TYPED_DATA)],
      },
      display: { site: 'app.example', method: 'eth_signTypedData_v4' },
      requester: TAB_A,
    });

    const digest = TypedDataEncoder.hash(
      DAPP_TYPED_DATA.domain,
      { Order: DAPP_TYPED_DATA.types.Order },
      DAPP_TYPED_DATA.message
    );
    expect(digest).toBe(hashSafeMessage(DAPP_TYPED_DATA)); // parity with protocol-kit
    expect(state.hash).toBe(calculateSafeMessageHash(SAFE_ADDRESS, digest, '1.4.1', 100n));
    // The inner digest came from the core, with EIP712Domain and
    // primaryType removed.
    const [input] = mockTypedDataHash.mock.calls.at(-1);
    expect(input.types.EIP712Domain).toBeUndefined();
    expect(input).not.toHaveProperty('primaryType');
  });

  describe('while the core hashes the request (an await)', () => {
    const typedRequest = { method: 'eth_signTypedData_v4', params: [SAFE_ADDRESS, DAPP_TYPED_DATA] };
    // Holds the core's hash until released.
    const pauseHash = () => {
      let release;
      mockTypedDataHash.mockImplementationOnce(
        (data) =>
          new Promise((resolve) => {
            release = () =>
              resolve(require('ethers').TypedDataEncoder.hash(data.domain, data.types, data.message));
          })
      );
      return () => release();
    };
    const start = () =>
      startSafeMessage({
        approval: newApproval(PAGE),
        safeIndex: 5,
        request: typedRequest,
        display: { site: 'app.example', method: 'eth_signTypedData_v4' },
        requester: TAB_A,
      });

    test.each([
      ['navigates', () => mockWebContentsById.get(TAB_A.webContentsId).emit('did-navigate')],
      ['closes', () => destroyWebContents(TAB_A.webContentsId)],
    ])('a page that %s meanwhile gets no session and no signatures', async (_label, leave) => {
      const release = pauseHash();
      const starting = start();
      leave();
      release();
      await expect(starting).rejects.toThrow('went away');
      expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
      // Nothing was left behind: another tab can start right away.
      fakeWebContents(TAB_B.webContentsId);
      await expect(
        startSafeMessage({
          approval: newApproval(PAGE),
          safeIndex: 5,
          request: typedRequest,
          display: { site: 'app.example', method: 'eth_signTypedData_v4' },
          requester: TAB_B,
        })
      ).resolves.toMatchObject({ collected: expect.any(Number) });
    });

    test('an account deleted meanwhile gets no session', async () => {
      const release = pauseHash();
      const starting = start();
      const saved = mockWalletRecords[5];
      delete mockWalletRecords[5];
      try {
        release();
        await expect(starting).rejects.toThrow();
        expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
      } finally {
        mockWalletRecords[5] = saved;
      }
    });

    test('a record left with only an old deployed mark meanwhile gets no session (#1066)', async () => {
      const release = pauseHash();
      const starting = start();
      const saved = mockWalletRecords[5];
      // Same address, but only a mark no verified check wrote.
      mockWalletRecords[5] = { ...saved, deployed: { 100: true } };
      try {
        release();
        await expect(starting).rejects.toThrow('changed while');
        expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
        expect(getSession(5)).toBeFalsy();
      } finally {
        mockWalletRecords[5] = saved;
      }
    });

    test('the page listeners are removed once hashing is done', async () => {
      await start();
      const contents = mockWebContentsById.get(TAB_A.webContentsId);
      // Only the session's own lifecycle listeners remain.
      expect(contents.listenerCount('did-navigate')).toBe(1);
      expect(contents.listenerCount('destroyed')).toBe(1);
    });
  });

  test('a typed-data request the core refuses never reaches the owners', async () => {
    mockTypedDataHash.mockRejectedValueOnce(
      Object.assign(new Error('bool takes only true or false'), { code: 'invalid_argument' })
    );
    await expect(
      startSafeMessage({
        approval: newApproval(PAGE),
        safeIndex: 5,
        request: { method: 'eth_signTypedData_v4', params: [SAFE_ADDRESS, DAPP_TYPED_DATA] },
        display: { site: 'app.example', method: 'eth_signTypedData_v4' },
        requester: TAB_A,
      })
    ).rejects.toThrow('bool takes only true or false');
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
  });

  // A page's standing rule (design 0012), read by main as a signer's last
  // check: after the request's preparation (the core's digest) and the
  // vault's state, right before each free owner signs.
  describe("the caller's last check (`beforeSign`)", () => {
    const deferred = () => {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const flush = async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    const startTyped = (beforeSign) =>
      startSafeMessage({
        approval: newApproval(),
        safeIndex: 5,
        request: { method: 'eth_signTypedData_v4', params: [SAFE_ADDRESS, DAPP_TYPED_DATA] },
        display: { site: 'app.example', method: 'eth_signTypedData_v4' },
        requester: TAB_A,
        owner: 'main',
        beforeSign,
      });

    test.each([
      ['the preparation (the core\'s digest)', 'prepare'],
      ['the vault\'s state', 'status'],
    ])('refusing once %s is past: the session ends, no owner signs', async (_label, boundary) => {
      mockOwnersSigned = 0;
      const held = deferred();
      if (boundary === 'prepare') {
        const real = mockTypedDataHash.getMockImplementation();
        mockTypedDataHash.mockImplementationOnce(async (data) => {
          await held.promise;
          return real(data);
        });
      } else {
        mockIsVaultUnlocked.mockImplementationOnce(async () => {
          await held.promise;
          return true;
        });
      }
      let allowed = true;
      const refusal = Object.assign(new Error("The site's rule no longer answers this request"), { code: 'STANDING_WITHDRAWN' });
      const beforeSign = jest.fn(async () => {
        if (!allowed) throw refusal;
      });
      const started = startTyped(beforeSign);
      await flush();
      expect(beforeSign).not.toHaveBeenCalled();
      // The rule revoked (or the tab taken into custody) during the wait.
      allowed = false;
      held.resolve();
      await expect(started).rejects.toBe(refusal);
      expect(beforeSign).toHaveBeenCalledTimes(1);
      expect(mockOwnersSigned).toBe(0);
      expect(getSession(5)).toBeNull();
    });

    test('a check that passes: the free owner signs past it, once', async () => {
      mockOwnersSigned = 0;
      const beforeSign = jest.fn(async () => {});
      const state = await startTyped(beforeSign);
      expect(beforeSign).toHaveBeenCalledTimes(1);
      expect(mockOwnersSigned).toBe(1);
      expect(state.collected).toBe(1);
      expect(mockCollectOwnerSignature).toHaveBeenCalledWith(expect.objectContaining({ ownerIndex: 0, beforeSign: expect.any(Function) }));
    });

    test("an owner's own failure still degrades to a manual row; only the check's refusal ends the session", async () => {
      mockCollectOwnerSignature.mockRejectedValueOnce(new Error('derivation hiccup'));
      const state = await startTyped(jest.fn(async () => {}));
      expect(state.collected).toBe(0);
      expect(getSession(5)).not.toBeNull();
    });
  });

  test('a 1-of-N session is complete right after the free signature', async () => {
    const state = await startPersonal(7);
    expect(state).toMatchObject({ collected: 1, threshold: 1, complete: true });
  });

  test('a locked vault collects nothing', async () => {
    mockIsVaultUnlocked.mockResolvedValue(false);
    const state = await startPersonal();
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
    expect(state.collected).toBe(0);
  });

  test('refuses undeployed safes, non-safe accounts, and unsupported methods', async () => {
    await expect(startPersonal(6)).rejects.toThrow(/activate/i);
    await expect(startPersonal(0)).rejects.toThrow(/not a Safe/i);
    await expect(
      startSafeMessage({ approval: newApproval(PAGE), safeIndex: 5, request: { method: 'eth_sign', params: [] }, display: {} })
    ).rejects.toThrow(/unsupported/i);
  });

  test('refuses a Safe whose deployed mark no verified check wrote (#1066)', async () => {
    // Pending until getSafeStatus's verified read marks it again.
    await expect(startPersonal(8)).rejects.toThrow(/activate/i);
    expect(getSession(8)).toBeFalsy();
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
  });

  test('re-requesting the SAME message from the SAME page resumes, signatures intact', async () => {
    // A dApp retrying its own request (without navigating) — the
    // collected signatures are still valid for the identical hash.
    const { token } = await startPersonal();
    await signSafeMessage(5, 2, token);
    mockCollectOwnerSignature.mockClear();

    const resumed = await startPersonal();
    expect(resumed).toMatchObject({ collected: 2, complete: true, token });
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
  });

  test('the SAME message from a DIFFERENT page never resumes the session', async () => {
    // Tab B asks for the identical digest while tab A's ceremony is
    // live: handing B the resumed (possibly threshold-met) session
    // would let B collect a signature the user approved for A.
    const first = await startPersonal();
    await signSafeMessage(5, 2, first.token);

    await expect(startPersonal(5, HEX_MESSAGE, TAB_B)).rejects.toMatchObject({
      code: SAFE_MESSAGE_EXISTS,
    });
    // …and A's session is untouched
    expect(getSafeMessageState(5, first.token)).toMatchObject({ collected: 2, token: first.token });
  });

  test('the same site in ANOTHER tab is another caller — no resume across tabs', async () => {
    const first = await startPersonal();
    const sameSiteOtherTab = { origin: TAB_A.origin, webContentsId: TAB_B.webContentsId };
    await expect(startPersonal(5, HEX_MESSAGE, sameSiteOtherTab)).rejects.toMatchObject({
      code: SAFE_MESSAGE_EXISTS,
    });
    expect(getSafeMessageState(5, first.token)).not.toBeNull();
  });

  test('a NEW request is refused while another live request is open (no silent replace)', async () => {
    const first = await startPersonal();
    await signSafeMessage(5, 2, first.token);

    await expect(startPersonal(5, 'a different message', TAB_B)).rejects.toMatchObject({
      code: SAFE_MESSAGE_EXISTS,
    });
    // the live session keeps its identity and signatures
    expect(getSafeMessageState(5, first.token)).toMatchObject({
      collected: 2,
      hash: calculateSafeMessageHash(SAFE_ADDRESS, hashMessage('hello'), '1.4.1', 100n),
    });
  });

  test('a leftover from a CLOSED page is dead — a new request replaces it', async () => {
    const first = await startPersonal();
    destroyWebContents(TAB_A.webContentsId);

    const replaced = await startPersonal(5, 'a different message', TAB_B);
    expect(replaced.collected).toBe(1); // fresh session, fresh free sweep
    expect(replaced.token).not.toBe(first.token);
    expect(replaced.hash).toBe(
      calculateSafeMessageHash(SAFE_ADDRESS, hashMessage('a different message'), '1.4.1', 100n)
    );
    // the dead session's token opens nothing
    expect(getSafeMessageState(5, first.token)).toBeNull();
  });
});

describe('session lifecycle follows the requesting page', () => {
  test('navigating the requesting page drops its session', async () => {
    const { token } = await startPersonal();
    mockWebContentsById.get(TAB_A.webContentsId).emit('did-navigate');
    await flush();
    expect(getSafeMessageState(5, token)).toBeNull();
  });

  test('destroying the requesting page drops its session', async () => {
    const { token } = await startPersonal();
    destroyWebContents(TAB_A.webContentsId);
    await flush();
    expect(getSafeMessageState(5, token)).toBeNull();
  });

  test('completion unhooks the lifecycle listeners', async () => {
    const { token } = await startPersonal(7); // 1-of-N, complete right away
    await completeSafeMessage(7, token);
    const contents = mockWebContentsById.get(TAB_A.webContentsId);
    expect(contents.listenerCount('destroyed')).toBe(0);
    expect(contents.listenerCount('did-navigate')).toBe(0);

    // a later navigation must not touch the NEXT session on that safe
    const next = await startPersonal(7, 'next message', TAB_B);
    contents.emit('did-navigate');
    await flush();
    expect(getSafeMessageState(7, next.token)).not.toBeNull();
  });
});

describe('signSafeMessage', () => {
  test('signs exactly the requested owner; idempotent for signed ones', async () => {
    const { token } = await startPersonal(); // owner 0 free-signed
    mockCollectOwnerSignature.mockClear();

    const state = await signSafeMessage(5, 2, token);
    expect(state).toMatchObject({ collected: 2, complete: true });

    mockCollectOwnerSignature.mockClear();
    const again = await signSafeMessage(5, 2, token);
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
    expect(again.collected).toBe(2);
  });

  test('ownerless call sweeps the free signatures (board reopen after unlock)', async () => {
    mockIsVaultUnlocked.mockResolvedValue(false);
    const { token } = await startPersonal();
    mockIsVaultUnlocked.mockResolvedValue(true);

    const state = await signSafeMessage(5, undefined, token);
    expect(state.collected).toBe(1);
    expect(state.owners.find((o) => o.index === 0).signed).toBe(true);
  });

  test('rejects non-owners and sessions that do not exist', async () => {
    const { token } = await startPersonal();
    await expect(signSafeMessage(5, 3, token)).rejects.toThrow(/not an owner/i);
    await expect(signSafeMessage(7, 0, token)).rejects.toThrow(/no signature request/i);
  });

  test('rejects a wrong or missing session token', async () => {
    const { token } = await startPersonal();
    await expect(signSafeMessage(5, 2, 'not-the-token')).rejects.toThrow(/different page/i);
    await expect(signSafeMessage(5, 2)).rejects.toThrow(/different page/i);
    expect(mockCollectOwnerSignature).toHaveBeenCalledTimes(1); // only the free sweep at start
    expect(getSafeMessageState(5, token).collected).toBe(1); // session intact
  });

  test('a device failure leaves the session and its signatures intact', async () => {
    const { token } = await startPersonal();
    mockCollectOwnerSignature.mockRejectedValueOnce(
      Object.assign(new Error('Ledger not connected'), { code: 'LEDGER_NOT_CONNECTED' })
    );
    await expect(signSafeMessage(5, 2, token)).rejects.toMatchObject({
      code: 'LEDGER_NOT_CONNECTED',
    });
    expect(getSafeMessageState(5, token).collected).toBe(1);
  });

  test('a live ceremony blocks concurrent steps, cancel, and the send flow (shared lock)', async () => {
    const { token } = await startPersonal();
    let resolveSign;
    mockCollectOwnerSignature.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSign = resolve))
    );

    const inFlight = signSafeMessage(5, 2, token);
    await new Promise((resolve) => setImmediate(resolve));

    await expect(signSafeMessage(5, 4, token)).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    await expect(completeSafeMessage(5, token)).rejects.toThrow(/current step/i);
    // the SEND flow's guard is the same lock — one ceremony per Safe, full stop
    const { cancelSafeSend } = require('./safe-transactions');
    await expect(cancelSafeSend(5)).rejects.toThrow(/current step/i);
    // A cancel meanwhile ends its approval first, then waits for the step.
    await expect(cancelSafeMessage(5, token)).rejects.toThrow(/current step/i);
    expect(safeApprovals.held('message', 5, getSession(5).hash)).toBeNull();

    resolveSign(signatureOf(2));
    await inFlight;
    expect(getSafeMessageState(5, token).collected).toBe(2);
  });
});

describe('completeSafeMessage', () => {
  test('returns the sorted concatenated signature bytes and closes the session', async () => {
    const { token } = await startPersonal();
    await signSafeMessage(5, 2, token);

    const { signature } = await completeSafeMessage(5, token);

    // protocol-kit sorts by signer address — byte-identical output
    expect(signature).toBe(buildSignatureBytes([signatureOf(0), signatureOf(2)]));
    const inOrder = [signatureOf(0), signatureOf(2)]
      .sort((a, b) => a.signer.toLowerCase().localeCompare(b.signer.toLowerCase()))
      .map((sig) => sig.data.slice(2))
      .join('');
    expect(signature).toBe('0x' + inOrder);

    expect(getSafeMessageState(5, token)).toBeNull();
  });

  test('refuses below the threshold', async () => {
    const { token } = await startPersonal();
    await expect(completeSafeMessage(5, token)).rejects.toThrow(/not enough signatures/i);
    expect(getSafeMessageState(5, token)).not.toBeNull(); // session survives
  });

  test('refuses a wrong or missing token — no cross-page signature handout', async () => {
    const { token } = await startPersonal();
    await signSafeMessage(5, 2, token); // threshold met

    await expect(completeSafeMessage(5, 'not-the-token')).rejects.toThrow(/different page/i);
    await expect(completeSafeMessage(5)).rejects.toThrow(/different page/i);
    expect(getSafeMessageState(5, token)).toMatchObject({ collected: 2 }); // still open
  });
});

describe('getSafeMessageState / cancelSafeMessage', () => {
  test('null when nothing is open; cancel clears; both are token-gated', async () => {
    expect(getSafeMessageState(5, 'anything')).toBeNull();
    const { token } = await startPersonal();
    expect(getSafeMessageState(5, token)).not.toBeNull();
    // another page's probe sees nothing
    expect(getSafeMessageState(5, 'not-the-token')).toBeNull();
    expect(getSafeMessageState(5)).toBeNull();
    await cancelSafeMessage(5, token);
    expect(getSafeMessageState(5, token)).toBeNull();
    // cancelling again is a no-op, not an error
    await expect(cancelSafeMessage(5, token)).resolves.toBeUndefined();
  });

  test('cancel with a wrong token is refused and leaves the session', async () => {
    const { token } = await startPersonal();
    await expect(cancelSafeMessage(5, 'not-the-token')).rejects.toThrow(/different page/i);
    await expect(cancelSafeMessage(5)).rejects.toThrow(/different page/i);
    expect(getSafeMessageState(5, token)).not.toBeNull();
  });

  test('a stale token cannot cancel a successor session', async () => {
    const first = await startPersonal();
    destroyWebContents(TAB_A.webContentsId);
    const next = await startPersonal(5, 'a different message', TAB_B);

    await expect(cancelSafeMessage(5, first.token)).rejects.toThrow(/different page/i);
    expect(getSafeMessageState(5, next.token)).not.toBeNull();
  });

  test('sessions are independent from pending sends (no cross-blocking)', async () => {
    // a message session on 5 does not create a pending SEND
    await startPersonal();
    const { getSafeSendState } = require('./safe-transactions');
    expect(getSafeSendState(5)).toBeNull();
  });

  test('discardSession force-drops a session regardless of token (Safe deletion path)', async () => {
    const { token } = await startPersonal();
    expect(getSession(5)).not.toBeNull();
    expect(discardSession(5)).toBe(true);
    expect(getSession(5)).toBeNull();
    expect(getSafeMessageState(5, token)).toBeNull();
    expect(discardSession(5)).toBe(false); // idempotent
  });
});

// freedom-core design 0011, PRQ-5a: a session main opens for a page's
// request is main's to answer. Nothing resumes it, and the chrome can't
// complete it: its board only collects the device owners' signatures.
describe('a session main owns', () => {
  const startOwned = (requester = TAB_A) =>
    startSafeMessage({
      approval: newApproval(PAGE),
      safeIndex: 5,
      request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] },
      display: DISPLAY,
      requester,
      owner: 'main',
    });

  test('the same request from the same page never resumes it', async () => {
    const first = await startOwned();
    await expect(startOwned()).rejects.toMatchObject({ code: SAFE_MESSAGE_EXISTS });
    await expect(startPersonal()).rejects.toMatchObject({ code: SAFE_MESSAGE_EXISTS });
    expect(getSafeMessageState(5, first.token)).not.toBeNull();
  });

  test("nor does a session main owns resume the chrome's", async () => {
    const chromes = await startPersonal();
    await expect(startOwned()).rejects.toMatchObject({ code: SAFE_MESSAGE_EXISTS });
    expect(getSafeMessageState(5, chromes.token)).not.toBeNull();
  });

  // The chrome has no way to complete one (PRQ-9 removed
  // wallet:safe-message-complete): main completes it.
  test('the chrome may sign it on its board, and main completes it', async () => {
    const { token } = await startOwned();
    await signSafeMessage(5, 2, token);
    expect(getSafeMessageState(5, token)).toMatchObject({ collected: 2 });
    const { signature } = await completeSafeMessage(5, token);
    expect(signature).toBe(buildSignatureBytes([signatureOf(0), signatureOf(2)]));
  });
});

// freedom-core design 0012, APB-1c: every owner presents the session's Safe
// approval, which main ends at the threshold's last signature, and before
// the join, a cancel, or the drop of a session whose page went away.
describe("a session's Safe approval", () => {
  test('without one, no session opens; one given for none is ended', async () => {
    await expect(
      startSafeMessage({ safeIndex: 5, request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] }, display: DISPLAY, requester: TAB_A })
    ).rejects.toThrow(/not confirmed/);
    expect(getSession(5)).toBeNull();
    const refused = newApproval();
    await expect(
      startSafeMessage({ approval: refused, safeIndex: 6, request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] }, display: DISPLAY, requester: TAB_A })
    ).rejects.toThrow(/activate/i);
    expect(endedIds()).toEqual([refused.id]);
  });

  test('each owner presents it; the last signature of the threshold ends it, under its page', async () => {
    const approval = newApproval();
    const state = await startSafeMessage({
      approval,
      safeIndex: 5,
      request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] },
      display: DISPLAY,
      requester: TAB_A,
    });
    expect(mockCollectOwnerSignature).toHaveBeenCalledWith(expect.objectContaining({ ownerIndex: 0, approval }));
    expect(mockApprovalEnd).not.toHaveBeenCalled();
    await signSafeMessage(5, 2, state.token);
    expect(mockCollectOwnerSignature).toHaveBeenLastCalledWith(expect.objectContaining({ ownerIndex: 2, approval }));
    expect(mockApprovalEnd).toHaveBeenCalledWith(approval.id, PAGE);
    expect(safeApprovals.held('message', 5, state.hash)).toBeNull();
    // Ended again before the join: the core answers {} whatever it was.
    mockApprovalEnd.mockClear();
    await completeSafeMessage(5, state.token);
    expect(endedIds()).toEqual([]);
  });

  test('ended before the join, the Safe held meanwhile', async () => {
    const approval = newApproval();
    safeApprovals._reset();
    const state = await startSafeMessage({
      approval,
      safeIndex: 7, // 1-of-N: complete after the free signature, which ends it
      request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] },
      display: DISPLAY,
      requester: TAB_A,
    });
    expect(endedIds()).toEqual([approval.id]);
    expect(state.complete).toBe(true);
    await expect(completeSafeMessage(7, state.token)).resolves.toMatchObject({ signature: expect.any(String) });
  });

  test('ended before a cancel, and before a session whose page went away is dropped', async () => {
    const first = newApproval();
    const one = await startSafeMessage({
      approval: first,
      safeIndex: 5,
      request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] },
      display: DISPLAY,
      requester: TAB_A,
    });
    mockApprovalEnd.mockImplementationOnce(async () => {
      expect(getSession(5)).not.toBeNull();
      return {};
    });
    await cancelSafeMessage(5, one.token);
    expect(endedIds()).toEqual([first.id]);
    expect(getSession(5)).toBeNull();

    const second = newApproval();
    await startSafeMessage({
      approval: second,
      safeIndex: 5,
      request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] },
      display: DISPLAY,
      requester: TAB_A,
    });
    destroyWebContents(TAB_A.webContentsId);
    await flush();
    expect(endedIds()).toEqual([first.id, second.id]);
    expect(getSession(5)).toBeNull();
  });

  // Review of #1245, round 1: the page-gone drop waits for the core's end
  // (which the core answers after a signature already presenting it), one
  // drop at a time, and a free signature that lands after it never brings
  // the session back.
  describe('a page that goes while a free signature is being made', () => {
    const begin = (approval) =>
      startSafeMessage({
        approval,
        safeIndex: 5,
        request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] },
        display: DISPLAY,
        requester: TAB_A,
      });

    test("its approval's end is awaited before the drop, the navigation's and the close's one drop", async () => {
      const signing = deferred();
      const ending = deferred();
      mockCollectOwnerSignature.mockImplementationOnce(() => signing.promise);
      mockApprovalEnd.mockImplementationOnce(() => ending.promise);
      const approval = newApproval();
      const started = begin(approval);
      await flush();
      const entry = getSession(5);
      expect(entry).not.toBeNull();
      mockWebContentsById.get(TAB_A.webContentsId).emit('did-navigate');
      destroyWebContents(TAB_A.webContentsId);
      await flush();
      expect(endedIds()).toEqual([approval.id]);
      // Not dropped before the core has ended it, and no longer presented.
      expect(getSession(5)).toBe(entry);
      expect(safeApprovals.held('message', 5, entry.hash)).toBeNull();
      // The core answers the signature first, then the end.
      signing.resolve(signatureOf(0));
      await flush();
      ending.resolve({});
      await started;
      await flush();
      expect(getSession(5)).toBeNull();
      expect(mockApprovalEnd).toHaveBeenCalledTimes(1);
      expect(mockCollectOwnerSignature).toHaveBeenCalledTimes(1);
    });

    test('a signature that lands after the drop is dropped too: the session stays gone', async () => {
      const signing = deferred();
      mockCollectOwnerSignature.mockImplementationOnce(() => signing.promise);
      const started = begin(newApproval());
      await flush();
      expect(getSession(5)).not.toBeNull();
      mockWebContentsById.get(TAB_A.webContentsId).emit('did-navigate');
      await flush();
      expect(getSession(5)).toBeNull();
      signing.resolve(signatureOf(0));
      await started;
      await flush();
      expect(getSession(5)).toBeNull();
    });

    test('an end that fails keeps the session and its approval; the next event drops it', async () => {
      const approval = newApproval();
      const { hash } = await begin(approval);
      mockApprovalEnd.mockRejectedValue(busy());
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockWebContentsById.get(TAB_A.webContentsId).emit('did-navigate');
      await flush();
      expect(getSession(5)).not.toBeNull();
      expect(safeApprovals.held('message', 5, hash)).toEqual({ id: approval.id, page: PAGE });
      expect(mockApprovalEnd).toHaveBeenCalledTimes(3);
      mockApprovalEnd.mockReset().mockResolvedValue({});
      destroyWebContents(TAB_A.webContentsId);
      await flush();
      expect(getSession(5)).toBeNull();
      expect(endedIds()).toEqual([approval.id]);
      console.warn.mockRestore();
    });
  });

  // Review of #1245, round 2: a session whose page went away has ended for
  // good, even while its approval's end fails: a device's signature that
  // lands for it is dropped, no board action signs it, and it is kept only
  // for the end to be tried again.
  describe('a session whose page went away, its end failing', () => {
    test.each([
      ['a Ledger', 2],
      ['a phone', 4],
    ])("%s owner's signature in flight is dropped, and no new one is made", async (_label, ownerIndex) => {
      const approval = newApproval();
      const state = await startSafeMessage({
        approval,
        safeIndex: 5,
        request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] },
        display: DISPLAY,
        requester: TAB_A,
      });
      const device = deferred();
      mockCollectOwnerSignature.mockImplementationOnce(() => device.promise);
      const signing = signSafeMessage(5, ownerIndex, state.token);
      await flush();
      expect(mockCollectOwnerSignature).toHaveBeenLastCalledWith(expect.objectContaining({ ownerIndex }));
      // The page leaves; the core doesn't confirm the end, three times.
      mockApprovalEnd.mockRejectedValue(busy());
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockWebContentsById.get(TAB_A.webContentsId).emit('did-navigate');
      await flush();
      expect(mockApprovalEnd).toHaveBeenCalledTimes(3);
      const entry = getSession(5);
      expect(entry).not.toBeNull();
      // The device answers: dropped, not stored.
      device.resolve(signatureOf(ownerIndex));
      await expect(signing).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
      expect(entry.signatures).toHaveLength(1);
      // Nothing more signs it, or shows it, or joins it.
      mockCollectOwnerSignature.mockClear();
      for (const owner of [2, 4, undefined]) {
        await expect(signSafeMessage(5, owner, state.token)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
      }
      expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
      expect(getSafeMessageState(5, state.token)).toBeNull();
      await expect(completeSafeMessage(5, state.token)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
      // Kept only for its end: a cancel tries it again, and then drops it.
      mockApprovalEnd.mockReset().mockResolvedValue({});
      await cancelSafeMessage(5, state.token);
      expect(getSession(5)).toBeNull();
      expect(endedIds()).toEqual([approval.id]);
      console.warn.mockRestore();
    });

    test('the same page asking again gets a new session, never the ended one', async () => {
      const first = await startPersonal();
      mockApprovalEnd.mockRejectedValue(busy());
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockWebContentsById.get(TAB_A.webContentsId).emit('did-navigate');
      await flush();
      expect(getSession(5)?.token).toBe(first.token);
      mockApprovalEnd.mockReset().mockResolvedValue({});
      const second = await startPersonal();
      expect(second.token).not.toBe(first.token);
      expect(getSession(5).token).toBe(second.token);
      console.warn.mockRestore();
    });
  });

  // Review of #1245, round 1: an end the core didn't confirm (and whose
  // process still runs) is an error, and nothing that waited on it happens.
  test('an end that fails: no join and no cancel; the session and its approval stay', async () => {
    const approval = newApproval();
    const state = await startSafeMessage({
      approval,
      safeIndex: 5,
      request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] },
      display: DISPLAY,
      requester: TAB_A,
    });
    mockApprovalEnd.mockRejectedValue(busy());
    await expect(cancelSafeMessage(5, state.token)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
    expect(getSession(5)).not.toBeNull();
    expect(safeApprovals.held('message', 5, state.hash)).toEqual({ id: approval.id, page: PAGE });
    // The threshold's last signature: kept, with the approval; the board hears the failure.
    await expect(signSafeMessage(5, 2, state.token)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
    expect(getSession(5).signatures).toHaveLength(2);
    await expect(completeSafeMessage(5, state.token)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_END_FAILED' });
    expect(getSession(5)).not.toBeNull();
    // The core's process ended meanwhile: its approvals went with it.
    mockProcessEnded.mockReturnValue(true);
    await expect(completeSafeMessage(5, state.token)).resolves.toMatchObject({ signature: expect.any(String) });
    expect(getSession(5)).toBeNull();
  });

  test('none held, or one the core no longer knows: an owner is refused before any ceremony', async () => {
    const state = await startSafeMessage({
      approval: newApproval(),
      safeIndex: 5,
      request: { method: 'personal_sign', params: [HEX_MESSAGE, SAFE_ADDRESS] },
      display: DISPLAY,
      requester: TAB_A,
    });
    mockCollectOwnerSignature.mockRejectedValueOnce(
      Object.assign(new Error('Signing was not confirmed: unknown'), { code: 'SIGNING_NOT_CONFIRMED', reason: 'unknown_token' })
    );
    await expect(signSafeMessage(5, 2, state.token)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_NEEDED' });
    expect(safeApprovals.held('message', 5, state.hash)).toBeNull();
    mockCollectOwnerSignature.mockClear();
    await expect(signSafeMessage(5, 2, state.token)).rejects.toMatchObject({ code: 'SAFE_APPROVAL_NEEDED' });
    expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
  });
});

// Review of #1245, round 3: a session a page's standing rule answers keeps
// its last check (`beforeSign`), and every later owner's signer awaits it
// right before it signs, from the board as at the opening. Its refusal ends
// the session there (its approval ended, then the session dropped).
describe("a rule's session: its last check before every later owner", () => {
  const REFUSALS = {
    rule: Object.assign(new Error("The site's rule no longer answers this request"), {
      code: 'STANDING_WITHDRAWN',
      answer: { error: { code: 4100, message: 'rule gone' } },
    }),
    custody: Object.assign(new Error("The site's rule no longer answers this request"), {
      code: 'STANDING_WITHDRAWN',
      answer: { error: { code: 4100, message: 'agent custody' } },
    }),
  };
  // The site's rule as the core reads it, and whether an agent holds the tab.
  let rule;
  let custody;
  const beforeSign = jest.fn(async () => {
    if (custody) throw REFUSALS.custody;
    if (!rule) throw REFUSALS.rule;
  });
  const startRule = (approval = newApproval()) =>
    startSafeMessage({
      approval,
      safeIndex: 5,
      request: { method: 'eth_signTypedData_v4', params: [SAFE_ADDRESS, DAPP_TYPED_DATA] },
      display: { site: 'app.example', method: 'eth_signTypedData_v4' },
      requester: TAB_A,
      owner: 'main',
      beforeSign,
    });
  // What each end saw: whether the session was still there (ended first),
  // and ended for good already.
  const watchEnds = () => {
    const seen = [];
    mockApprovalEnd.mockImplementation(async (id) => {
      seen.push({ id, session: getSession(5) !== null, dead: getSession(5)?.dead === true });
      return {};
    });
    return seen;
  };
  const WITHDRAWALS = [
    ['its rule is revoked', () => {
      rule = false;
    }, 'rule'],
    ['custody begins', () => {
      custody = true;
    }, 'custody'],
  ];

  beforeEach(() => {
    rule = true;
    custody = false;
    mockOwnersSigned = 0;
    beforeSign.mockClear();
  });

  test.each(WITHDRAWALS)(
    '%s after the first owner signed: a later owner chosen on the board is refused, nothing signed, the approval ended before the drop',
    async (_label, withdraw, which) => {
      const approval = newApproval();
      const state = await startRule(approval);
      // The vault owner signed past the check at the opening.
      expect(state.collected).toBe(1);
      expect(mockOwnersSigned).toBe(1);
      withdraw();
      const seen = watchEnds();
      await expect(signSafeMessage(5, 2, state.token)).rejects.toBe(REFUSALS[which]);
      // The check ran in the Ledger owner's signer, and stopped it.
      expect(mockCollectOwnerSignature).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerIndex: 2, beforeSign: expect.any(Function) })
      );
      expect(beforeSign).toHaveBeenCalledTimes(2);
      expect(mockOwnersSigned).toBe(1);
      expect(seen).toEqual([{ id: approval.id, session: true, dead: true }]);
      expect(getSession(5)).toBeNull();
      expect(safeApprovals.stepRunning(5)).toBe(false);
      // Nothing more signs it.
      await expect(signSafeMessage(5, 4, state.token)).rejects.toThrow('No signature request is open');
      expect(mockOwnersSigned).toBe(1);
    }
  );

  test.each(WITHDRAWALS)(
    "%s after a device owner signed: the board's sweep of a vault owner is refused the same way",
    async (_label, withdraw, which) => {
      // Locked at the opening: no free signature then.
      mockIsVaultUnlocked.mockResolvedValueOnce(false);
      const approval = newApproval();
      const state = await startRule(approval);
      expect(state.collected).toBe(0);
      // The Ledger owner signs from the board, past the check.
      await signSafeMessage(5, 2, state.token);
      expect(beforeSign).toHaveBeenCalledTimes(1);
      expect(mockOwnersSigned).toBe(1);
      withdraw();
      const seen = watchEnds();
      // The board opens again after an unlock: its sweep reaches the vault
      // owner.
      await expect(signSafeMessage(5, undefined, state.token)).rejects.toBe(REFUSALS[which]);
      expect(mockCollectOwnerSignature).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerIndex: 0, beforeSign: expect.any(Function) })
      );
      expect(mockOwnersSigned).toBe(1);
      expect(seen).toEqual([{ id: approval.id, session: true, dead: true }]);
      expect(getSession(5)).toBeNull();
      expect(safeApprovals.stepRunning(5)).toBe(false);
    }
  );

  test('while the rule still answers, a later owner signs past it', async () => {
    const state = await startRule();
    await signSafeMessage(5, 2, state.token);
    expect(beforeSign).toHaveBeenCalledTimes(2);
    expect(mockOwnersSigned).toBe(2);
    expect(getSafeMessageState(5, state.token)).toMatchObject({ collected: 2, complete: true });
  });

  test("a token's session has no last check: its later owners sign as before", async () => {
    const state = await startPersonal();
    await signSafeMessage(5, 2, state.token);
    expect(mockCollectOwnerSignature).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ beforeSign: expect.anything() })
    );
    expect(getSafeMessageState(5, state.token)).toMatchObject({ collected: 2 });
  });

  test('an end that fails on the refusal: the refusal is heard, the session kept ended, nothing more signs it', async () => {
    const approval = newApproval();
    const state = await startRule(approval);
    rule = false;
    mockApprovalEnd.mockRejectedValue(busy());
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(signSafeMessage(5, 2, state.token)).rejects.toBe(REFUSALS.rule);
    expect(getSession(5)).toMatchObject({ token: state.token, dead: true });
    // Not even with the rule back.
    rule = true;
    for (const owner of [2, 4, undefined]) {
      await expect(signSafeMessage(5, owner, state.token)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    }
    expect(mockOwnersSigned).toBe(1);
    // Its drop, again, by a cancel.
    mockApprovalEnd.mockReset().mockResolvedValue({});
    await cancelSafeMessage(5, state.token);
    expect(getSession(5)).toBeNull();
    expect(endedIds()).toEqual([approval.id]);
    console.warn.mockRestore();
  });
});

// Review of #1245, round 3: the requesting page is watched through every
// wait before its session holds its approval, a leftover's drop (its end
// asked again) and the approval's hold included: a page gone by then gets
// no session and no owner's signature, and its approval is ended.
describe('a page that goes before its session opens', () => {
  const LEAVES = [
    ['navigates', (id) => mockWebContentsById.get(id).emit('did-navigate')],
    ['closes', (id) => destroyWebContents(id)],
  ];
  const personal = (message) => ({ method: 'personal_sign', params: [message, SAFE_ADDRESS] });

  test.each(LEAVES)(
    "one that %s while a leftover's end is asked again: no owner signs, its approval is ended",
    async (_label, leave) => {
      // TAB_A's session, its page gone and its end failing: kept, ended.
      await startSafeMessage({ approval: newApproval(), safeIndex: 5, request: personal(HEX_MESSAGE), display: DISPLAY, requester: TAB_A });
      mockApprovalEnd.mockRejectedValue(busy());
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      destroyWebContents(TAB_A.webContentsId);
      await flush();
      const leftover = getSession(5);
      expect(leftover).toMatchObject({ dead: true });
      const leftoverId = endedIds()[0];

      // TAB_B asks: the leftover's end is asked again, and waits.
      const gate = deferred();
      mockApprovalEnd.mockReset().mockImplementationOnce(() => gate.promise).mockResolvedValue({});
      mockCollectOwnerSignature.mockClear();
      const approval = newApproval();
      const starting = startSafeMessage({ approval, safeIndex: 5, request: personal('another message'), display: DISPLAY, requester: TAB_B });
      await flush();
      expect(endedIds()).toEqual([leftoverId]);
      leave(TAB_B.webContentsId);
      gate.resolve({});
      await expect(starting).rejects.toThrow('went away');
      expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
      expect(getSession(5)).toBeNull();
      expect(endedIds()).toEqual([leftoverId, approval.id]);
      expect(safeApprovals.stepRunning(5)).toBe(false);
      console.warn.mockRestore();
    }
  );

  test.each(LEAVES)(
    'one that %s while its approval is being held: no owner signs, the approval held is ended',
    async (_label, leave) => {
      // An approval left in the Safe's message slot with no session: the
      // hold ends it first, and that waits.
      const older = newApproval();
      await safeApprovals.hold(safeApprovals.KINDS.MESSAGE, 5, older, '0x' + 'ab'.repeat(32));
      const gate = deferred();
      mockApprovalEnd.mockImplementationOnce(() => gate.promise);
      const approval = newApproval();
      const starting = startSafeMessage({ approval, safeIndex: 5, request: personal(HEX_MESSAGE), display: DISPLAY, requester: TAB_A });
      await flush();
      expect(endedIds()).toEqual([older.id]);
      leave(TAB_A.webContentsId);
      gate.resolve({});
      await expect(starting).rejects.toThrow('went away');
      expect(mockCollectOwnerSignature).not.toHaveBeenCalled();
      expect(getSession(5)).toBeNull();
      expect(endedIds()).toEqual([older.id, approval.id]);
      expect(safeApprovals.stepRunning(5)).toBe(false);
    }
  );
});
