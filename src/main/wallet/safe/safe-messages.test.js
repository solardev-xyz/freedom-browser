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
    deployed: { 100: true },
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
    deployed: { 100: true },
  },
};
const mockIsVaultUnlocked = jest.fn(async () => true);
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockWalletRecords[index] || null,
  isVaultUnlocked: (...args) => mockIsVaultUnlocked(...args),
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));

// Distinct 65-byte signature blobs per owner so concatenation order is
// visible in completeSafeMessage's output.
const sigDataOf = { 0: '0x' + '11'.repeat(65), 2: '0x' + '22'.repeat(65), 4: '0x' + '33'.repeat(65) };
const signatureOf = (index) => ({
  signer: OWNERS[index === 0 ? 0 : index === 2 ? 1 : 2],
  data: sigDataOf[index],
});
const mockCollectOwnerSignature = jest.fn(async ({ ownerIndex }) => signatureOf(ownerIndex));
jest.mock('./safe-executor', () => ({
  SAFE_VERSION: '1.4.1',
  collectOwnerSignature: (...args) => mockCollectOwnerSignature(...args),
  pickDefaultExecutor: jest.requireActual('./safe-executor').pickDefaultExecutor,
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
    safeIndex,
    request: { method: 'personal_sign', params: [message, SAFE_ADDRESS] },
    display: DISPLAY,
    requester,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsVaultUnlocked.mockResolvedValue(true);
  for (const index of [5, 6, 7]) discardSession(index);
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
      startSafeMessage({ safeIndex: 5, request: { method: 'eth_sign', params: [] }, display: {} })
    ).rejects.toThrow(/unsupported/i);
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
    expect(getSafeMessageState(5, token)).toBeNull();
  });

  test('destroying the requesting page drops its session', async () => {
    const { token } = await startPersonal();
    destroyWebContents(TAB_A.webContentsId);
    expect(getSafeMessageState(5, token)).toBeNull();
  });

  test('completion unhooks the lifecycle listeners', async () => {
    const { token } = await startPersonal(7); // 1-of-N, complete right away
    completeSafeMessage(7, token);

    const contents = mockWebContentsById.get(TAB_A.webContentsId);
    expect(contents.listenerCount('destroyed')).toBe(0);
    expect(contents.listenerCount('did-navigate')).toBe(0);

    // a later navigation must not touch the NEXT session on that safe
    const next = await startPersonal(7, 'next message', TAB_B);
    contents.emit('did-navigate');
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
    expect(() => cancelSafeMessage(5, token)).toThrow(/current step/i);
    expect(() => completeSafeMessage(5, token)).toThrow(/current step/i);
    // the SEND flow's guard is the same lock — one ceremony per Safe, full stop
    const { cancelSafeSend } = require('./safe-transactions');
    expect(() => cancelSafeSend(5)).toThrow(/current step/i);

    resolveSign(signatureOf(2));
    await inFlight;
    expect(getSafeMessageState(5, token).collected).toBe(2);
  });
});

describe('completeSafeMessage', () => {
  test('returns the sorted concatenated signature bytes and closes the session', async () => {
    const { token } = await startPersonal();
    await signSafeMessage(5, 2, token);

    const { signature } = completeSafeMessage(5, token);

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
    expect(() => completeSafeMessage(5, token)).toThrow(/not enough signatures/i);
    expect(getSafeMessageState(5, token)).not.toBeNull(); // session survives
  });

  test('refuses a wrong or missing token — no cross-page signature handout', async () => {
    const { token } = await startPersonal();
    await signSafeMessage(5, 2, token); // threshold met

    expect(() => completeSafeMessage(5, 'not-the-token')).toThrow(/different page/i);
    expect(() => completeSafeMessage(5)).toThrow(/different page/i);
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
    cancelSafeMessage(5, token);
    expect(getSafeMessageState(5, token)).toBeNull();
    // cancelling again is a no-op, not an error
    expect(() => cancelSafeMessage(5, token)).not.toThrow();
  });

  test('cancel with a wrong token is refused and leaves the session', async () => {
    const { token } = await startPersonal();
    expect(() => cancelSafeMessage(5, 'not-the-token')).toThrow(/different page/i);
    expect(() => cancelSafeMessage(5)).toThrow(/different page/i);
    expect(getSafeMessageState(5, token)).not.toBeNull();
  });

  test('a stale token cannot cancel a successor session', async () => {
    const first = await startPersonal();
    destroyWebContents(TAB_A.webContentsId);
    const next = await startPersonal(5, 'a different message', TAB_B);

    expect(() => cancelSafeMessage(5, first.token)).toThrow(/different page/i);
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
