/**
 * Approval tokens through the real freedom-cored (freedom-core design 0012,
 * APB-1): signing-confirmation.test.js's cases for the core's kinds, against
 * the pinned binary. Main mints every kind but x402's with `approval.issue`
 * (a wallet kind as `shell`, a page kind under `page` with its PageContext
 * and handle), a signature the core makes presents its token to `sign.*`,
 * and the kinds that sign nothing here spend theirs with `approval.spend`.
 * A spy on the core's requests checks the caller of each, and that main
 * calls none of the permission files' write methods. Skipped unless
 * FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/wallet/signing-confirmation.integration
 * or FREEDOM_CORED_APPROVALS_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Wallet, Transaction, TypedDataEncoder } = require('ethers');

const required = process.env.FREEDOM_CORED_APPROVALS_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH || (required ? require('../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_APPROVALS_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ABANDON_KEY = '0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727';

const SITE = 'https://app.example';
const OTHER_SITE = 'https://other.example';
const HANDLE = 'c'.repeat(64);
const OTHER_HANDLE = 'd'.repeat(64);
const SAFE_INDEX = 5000;
const SAFE_ADDRESS = '0x' + 'aa'.repeat(20);
const PAGE = Object.freeze({ origin: SITE, top_origin: SITE, frame: 4, navigation: 9, agent: false });

const TX = Object.freeze({
  chainId: 100,
  to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  value: '1000000000000000',
  data: '0x095ea7b3' + '00'.repeat(64),
  gasLimit: '21000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
});
const DAPP_TX = Object.freeze({ ...TX, origin: SITE });

const TYPED_DATA = Object.freeze({
  domain: { name: 'Permit', chainId: 100, verifyingContract: '0x' + '11'.repeat(20) },
  types: { Permit: [{ name: 'value', type: 'uint256' }] },
  primaryType: 'Permit',
  message: { value: '1' },
});

// The core's write methods for the four permission files: main calls them
// for a moved file only (`dapp` from APB-2; Swarm and Radicle from APB-3,
// x402 from X402-2).
const WRITE_METHODS = ['approval.grant', 'approval.revoke', 'approval.touch', 'approval.forget_account'];
const MOVED = new Set(['dapp', 'swarm', 'radicle']);
const unmovedWrites = (calls) =>
  calls.filter(
    (call) =>
      WRITE_METHODS.includes(call.method) && call.method !== 'approval.forget_account' && !MOVED.has(call.params?.store)
  );

describeIfBinary('approval tokens with the real freedom-cored (APB-1)', () => {
  let root;
  let core;
  let calls;
  let sc;
  let vaultBackend;
  let buildTransaction;
  let toCoreTransaction;
  let toCoreTypedData;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-tokens-'));
    const { CoreClient } = require('../core/core-client');
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    calls = [];
    const request = core.request.bind(core);
    core.request = (method, params, context, options) => {
      const reply = request(method, params, context, options);
      calls.push({ method, context, params, reply });
      return reply;
    };
    jest.resetModules();
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../identity-manager', () => ({
      getWalletRecord: (index) =>
        index === SAFE_INDEX ? { index, type: 'safe', address: SAFE_ADDRESS, owners: [0], threshold: 1 } : null,
      isHardwareWalletIndex: () => false,
      recordLedgerAddressCheck: () => {},
      recordRemoteAddressCheck: () => {},
      WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
    }));
    // Main's own signers (`signers.js`) for the vault: no device here.
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    jest.doMock('./ledger/signer', () => ({ createLedgerBackend: () => ({}) }));
    jest.doMock('./remote/signer', () => ({ createRemoteBackend: () => ({}) }));
    // Main's dApp file, written where the core reads it (its grant root).
    jest.doMock('../freedom-root', () => ({ getFreedomDataPath: (name) => path.join(root, name) }));
    sc = require('./signing-confirmation');
    ({ vaultBackend } = require('../core/vault-backend'));
    ({ buildTransaction } = require('./transaction-service'));
    ({ toCoreTransaction, toCoreTypedData } = require('./signing-utils'));
    await core.start();
    await vaultBackend.importVault('testpass1', ABANDON);
  });

  afterAll(async () => {
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    // Main calls none of the write methods of a file that hasn't moved.
    expect(unmovedWrites(calls)).toEqual([]);
  });

  // A send as main signs it: built as every send is, at the nonce main
  // chose, in the core's wire form (transaction-service, signers.js).
  const wire = (tx, nonce = 7) => toCoreTransaction(buildTransaction({ ...tx, nonce })).tx;
  const account = (index = 0) => ({ kind: 'account', index });

  async function refusal(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error('expected a refusal');
  }

  const reasonOf = async (promise) => {
    const err = await refusal(promise);
    expect(err.code).toBe('not_authorized');
    return err.data?.reason;
  };

  async function walletToken(kind, index, payload, options) {
    const { token } = await sc.issueConfirmation(kind, index, payload, options);
    return sc.confirmationFor(token, kind, index, payload);
  }

  const pageToken = (kind, index, payload, page = PAGE, handle = HANDLE, options) =>
    sc.issuePageConfirmation(kind, index, payload, { handle, context: page }, options);

  const signSend = (confirmation, tx, index = 0) =>
    vaultBackend.sign.transaction(account(index), wire(tx), sc.signingAuthorization(confirmation));

  describe('wallet kinds, minted by main itself', () => {
    test('a token signs exactly the request it was issued for, once', async () => {
      const confirmation = await walletToken('wallet-send', 0, TX);
      expect(confirmation.token).toMatch(/^[0-9a-f]{64}$/);
      const { raw } = await signSend(confirmation, TX);
      const signed = Transaction.from(raw);
      expect(signed.from).toBe(new Wallet(ABANDON_KEY).address);
      expect(signed.to).toBe(TX.to);
      // Burnt by its first presentation.
      expect(await reasonOf(signSend(confirmation, TX))).toBe('unknown_token');
      const issue = calls.find((call) => call.method === 'approval.issue');
      expect(issue.context).toEqual({ caller: 'shell' });
      expect(issue.params).toMatchObject({ kind: 'wallet-send', account: 0 });
      expect(calls.find((call) => call.method === 'sign.transaction').context).toEqual({ caller: 'shell' });
    });

    test('a mismatched presentation also burns the token (no retry to probe)', async () => {
      const confirmation = await walletToken('wallet-send', 0, TX);
      expect(await reasonOf(signSend(confirmation, { ...TX, value: '1' }))).toBe('mismatch');
      expect(await reasonOf(signSend(confirmation, TX))).toBe('unknown_token');
    });

    test('no token, an empty token or an unknown token refuses', async () => {
      expect(() => sc.confirmationFor(undefined, 'wallet-send', 0, TX)).toThrow(/no confirmation token/);
      expect(() => sc.confirmationFor('', 'wallet-send', 0, TX)).toThrow(/no confirmation token/);
      expect(await reasonOf(signSend({ token: 'f'.repeat(64) }, TX))).toBe('unknown_token');
    });

    test('a discarded token no longer signs', async () => {
      const confirmation = await walletToken('wallet-send', 0, TX);
      await sc.discardConfirmation(confirmation.token);
      expect(await reasonOf(signSend(confirmation, TX))).toBe('unknown_token');
      // A second discard, of a token already gone, answers as the first.
      await expect(sc.discardConfirmation(confirmation.token)).resolves.toBeUndefined();
    });

    describe('every bound transaction field refuses on mismatch', () => {
      const changes = {
        chainId: 1,
        to: '0x' + '22'.repeat(20),
        value: '2000000000000000',
        data: '0x',
        gasLimit: '21001',
        maxFeePerGas: '2000000001',
        maxPriorityFeePerGas: '1000000001',
      };
      for (const [field, value] of Object.entries(changes)) {
        test(field, async () => {
          const confirmation = await walletToken('wallet-send', 0, TX);
          expect(await reasonOf(signSend(confirmation, { ...TX, [field]: value }))).toBe('mismatch');
        });
      }

      test('a gas field dropped after confirming (another type)', async () => {
        const confirmation = await walletToken('wallet-send', 0, TX);
        const legacy = { ...TX, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined, gasPrice: '2000000000' };
        expect(await reasonOf(signSend(confirmation, legacy))).toBe('mismatch');
      });

      test('the signing account', async () => {
        const confirmation = await walletToken('wallet-send', 0, TX);
        expect(await reasonOf(signSend(confirmation, TX, 1))).toBe('mismatch');
      });

      test('the nonce is not bound: main chooses it after the confirmation', async () => {
        const confirmation = await walletToken('wallet-send', 0, TX);
        await expect(
          vaultBackend.sign.transaction(account(0), wire(TX, 41), sc.signingAuthorization(confirmation))
        ).resolves.toHaveProperty('raw');
      });
    });

    test('equivalent encodings of the same transaction match', async () => {
      const confirmation = await walletToken('wallet-send', 0, TX);
      const same = {
        ...TX,
        chainId: '100',
        to: TX.to.toLowerCase(),
        value: '0x38d7ea4c68000',
        data: TX.data.toUpperCase().replace(/^0X/, '0x'),
        gasLimit: 21000,
      };
      await expect(signSend(confirmation, same)).resolves.toHaveProperty('raw');
    });

    test('value and data default the same way at issue and at use', async () => {
      const bare = { ...TX, value: undefined, data: undefined };
      const confirmation = await walletToken('wallet-send', 0, bare);
      await expect(signSend(confirmation, { ...TX, value: '0', data: '0x' })).resolves.toHaveProperty('raw');
    });

    test("an executor-send binds the executor and the fee shown, and spends as no other kind's", async () => {
      const confirmation = await walletToken('executor-send', 1, TX);
      expect(await reasonOf(signSend(confirmation, { ...TX, maxFeePerGas: '3000000000' }, 1))).toBe('mismatch');
      const again = await walletToken('executor-send', 1, TX);
      // Spent as another kind through the core, it is refused and burnt.
      const asWallet = await refusal(sc.spendConfirmation({ ...again, kind: 'wallet-send' }));
      expect(asWallet.code).toBe('SIGNING_NOT_CONFIRMED');
      expect(await reasonOf(signSend(again, TX, 1))).toBe('unknown_token');
      const fresh = await walletToken('executor-send', 1, TX);
      await expect(signSend(fresh, TX, 1)).resolves.toHaveProperty('raw');
    });

    test("a token on another kind's route is refused before the core signs, and burnt (wallet-send, executor-send)", async () => {
      // Main checks the route's kind against the one it minted, as its JS
      // check did, before the core (which refuses another kind named) is asked.
      for (const [mintedAs, route] of [
        ['executor-send', 'wallet-send'],
        ['wallet-send', 'executor-send'],
      ]) {
        const { token } = await sc.issueConfirmation(mintedAs, 0, TX);
        calls.length = 0;
        expect(() => sc.confirmationFor(token, route, 0, TX)).toThrow(/request differs from what was confirmed/);
        // Nothing asked of the core but the burn.
        expect(calls.map((call) => call.method)).toEqual(['approval.discard']);
        await calls[0].reply;
        // Burnt in the core: not even its own kind's signature takes it now.
        expect(await reasonOf(signSend({ token }, TX))).toBe('unknown_token');
      }
    });

    test('a page kind is never minted by main itself', async () => {
      await expect(sc.issueConfirmation('dapp-send', 0, DAPP_TX)).rejects.toThrow(/issued for its page/);
      // The core refuses one under `shell` as well.
      const err = await refusal(vaultBackend.approval.issue({ kind: 'sign-message', account: 0, payload: { message: '0x68' } }));
      expect(err.code).toBe('forbidden');
    });

    test('malformed requests are not issued a token', async () => {
      await expect(sc.issueConfirmation('wallet-send', 0, { ...TX, chainId: 0 })).rejects.toThrow(/chainId/);
      await expect(sc.issueConfirmation('wallet-send', -1, TX)).rejects.toThrow(/wallet index/);
      await expect(sc.issueConfirmation('wallet-send', 0, { ...TX, to: 'nope' })).rejects.toThrow();
      await expect(sc.issueConfirmation('nonsense', 0, TX)).rejects.toThrow(/Unknown confirmation kind/);
      expect(calls.filter((call) => call.method === 'approval.issue')).toEqual([]);
    });

    test('outstanding tokens are capped: a 33rd drops the oldest', async () => {
      const first = await walletToken('wallet-send', 0, TX);
      for (let i = 0; i < 32; i += 1) await walletToken('wallet-send', 0, TX);
      expect(await reasonOf(signSend(first, TX))).toBe('unknown_token');
    });
  });

  describe('Safe requests: spent through the core, which gives a Safe approval', () => {
    const SAFE_TX = Object.freeze({ tx: { to: TX.to, value: '5', data: '0x' }, chainId: 100 });

    test("a wallet's safe-send binds the Safe, chain, to, value and data", async () => {
      const confirmation = await walletToken('safe-send', SAFE_INDEX, SAFE_TX);
      expect(confirmation.payload).toEqual({
        safe: SAFE_ADDRESS,
        chain_id: '100',
        tx: { to: TX.to.toLowerCase(), value: '5', data: '0x' },
      });
      const spent = await sc.spendSafeConfirmation(confirmation);
      expect(spent).toEqual({ bound: true, approval: { id: expect.stringMatching(/^[0-9a-f]{32}$/), page: null } });
      // The approval it gave is held for its signatures (APB-1c), not ended.
      const spend = calls.find((call) => call.method === 'approval.spend');
      expect(spend.context).toEqual({ caller: 'shell' });
      expect(calls.some((call) => call.method === 'approval.end')).toBe(false);
      await vaultBackend.approval.end(spent.approval.id);
      for (const change of [
        { chainId: 1 },
        { tx: { ...SAFE_TX.tx, to: '0x' + '33'.repeat(20) } },
        { tx: { ...SAFE_TX.tx, value: '6' } },
        { tx: { ...SAFE_TX.tx, data: '0x01' } },
      ]) {
        const token = (await sc.issueConfirmation('safe-send', SAFE_INDEX, SAFE_TX)).token;
        const other = sc.confirmationFor(token, 'safe-send', SAFE_INDEX, { ...SAFE_TX, ...change });
        await expect(sc.spendSafeConfirmation(other)).rejects.toThrow(/differs from what was confirmed/);
      }
    });

    test("a site's safe-send is a page kind: refused as a wallet's, and a wallet's as a site's", async () => {
      const site = await pageToken('safe-send', SAFE_INDEX, { ...SAFE_TX, origin: SITE });
      // Presented without its page, as main's own.
      await expect(sc.spendSafeConfirmation({ ...site, page: undefined, handle: undefined })).rejects.toThrow(
        /Signing was not confirmed/
      );
      const wallet = await walletToken('safe-send', SAFE_INDEX, SAFE_TX);
      await expect(sc.spendSafeConfirmation({ ...wallet, page: PAGE, handle: HANDLE })).rejects.toThrow(
        /Signing was not confirmed/
      );
      const fresh = await pageToken('safe-send', SAFE_INDEX, { ...SAFE_TX, origin: SITE });
      await expect(sc.spendSafeConfirmation(fresh)).resolves.toEqual({
        bound: true,
        approval: { id: expect.stringMatching(/^[0-9a-f]{32}$/), page: PAGE },
      });
      expect(calls.filter((call) => call.method === 'approval.spend').at(-1).context).toEqual({ caller: 'page', page: PAGE });
    });

    test('safe-message binds the Safe, the method and the params', async () => {
      const request = { method: 'personal_sign', params: ['0x68', SAFE_ADDRESS] };
      const confirmation = await pageToken('safe-message', SAFE_INDEX, request);
      expect(confirmation.payload).toEqual({ safe: SAFE_ADDRESS, chain_id: '100', ...request });
      await expect(sc.spendSafeConfirmation(confirmation)).resolves.toEqual({
        bound: true,
        approval: { id: expect.stringMatching(/^[0-9a-f]{32}$/), page: PAGE },
      });
      for (const other of [{ ...request, method: 'eth_signTypedData_v4' }, { ...request, params: ['0x69', SAFE_ADDRESS] }]) {
        const token = await pageToken('safe-message', SAFE_INDEX, request);
        const presented = { ...token, payload: { ...token.payload, method: other.method, params: other.params } };
        await expect(sc.spendSafeConfirmation(presented)).rejects.toThrow(/differs from what was confirmed/);
      }
    });
  });

  describe("a held intent's resend, replacement and close", () => {
    const SENDER = new Wallet(ABANDON_KEY).address.toLowerCase();
    const HASH = (n) => '0x' + n.repeat(64);
    const INTENT = Object.freeze({ intentId: 'intent-0001', chainId: 100, sender: SENDER, nonce: 7 });

    test('an intent-close binds the intent and each of its hashes, in order', async () => {
      const close = { ...INTENT, hashes: [HASH('a'), HASH('b')] };
      await expect(sc.spendConfirmation(await walletToken('intent-close', null, close))).resolves.toMatchObject({ bound: true });
      for (const other of [{ hashes: [HASH('b'), HASH('a')] }, { hashes: [HASH('a')] }, { nonce: 8 }, { intentId: 'intent-0002' }]) {
        const token = (await sc.issueConfirmation('intent-close', null, close)).token;
        await expect(sc.spendConfirmation(sc.confirmationFor(token, 'intent-close', null, { ...close, ...other }))).rejects.toThrow(
          /differs from what was confirmed/
        );
      }
    });

    test('an intent-resend binds the intent and the hash sent again', async () => {
      const resend = { ...INTENT, hash: HASH('a') };
      await expect(sc.spendConfirmation(await walletToken('intent-resend', null, resend))).resolves.toMatchObject({ bound: true });
      const token = (await sc.issueConfirmation('intent-resend', null, resend)).token;
      await expect(
        sc.spendConfirmation(sc.confirmationFor(token, 'intent-resend', null, { ...resend, hash: HASH('b') }))
      ).rejects.toThrow(/differs/);
    });

    test('an intent-replace signs again at its nonce, for its account and intent', async () => {
      const replace = { ...INTENT, ...TX, maxFeePerGas: '4000000000' };
      const present = async (index, nonce, id = INTENT.intentId) => {
        const confirmation = { ...(await walletToken('intent-replace', 0, replace)), intent: { id } };
        return vaultBackend.sign.transaction(account(index), wire(replace, nonce), sc.signingAuthorization(confirmation));
      };
      await expect(present(0, 7)).resolves.toHaveProperty('raw');
      // Its intent named, and no kind (cored 0.15.0, "Naming the kind").
      expect(calls.find((call) => call.method === 'sign.transaction').params.authorization).toEqual({
        token: expect.stringMatching(/^[0-9a-f]{64}$/),
        intent: { id: INTENT.intentId },
      });
      expect(await reasonOf(present(0, 8))).toBe('mismatch');
      expect(await reasonOf(present(1, 7))).toBe('mismatch');
      expect(await reasonOf(present(0, 7, 'intent-0002'))).toBe('mismatch');
    });
  });

  describe('a send names its kind (cored 0.15.0, design 0012 "Naming the kind")', () => {
    // The sends, each minted as main mints it, with what it signs and the key.
    const SENDS = [
      ['wallet-send', () => walletToken('wallet-send', 0, TX), TX, 0],
      ['executor-send', () => walletToken('executor-send', 1, TX), TX, 1],
      ['dapp-send', () => pageToken('dapp-send', 0, DAPP_TX), DAPP_TX, 0],
    ];
    const lastSigned = () => calls.filter((call) => call.method === 'sign.transaction').at(-1);

    test('each kind signs, named as the kind main minted it as, under its caller', async () => {
      for (const [kind, mint, tx, index] of SENDS) {
        const confirmation = await mint();
        await expect(signSend(confirmation, tx, index)).resolves.toHaveProperty('raw');
        const { context, params } = lastSigned();
        expect(params.authorization).toEqual({
          token: confirmation.token,
          kind,
          ...(kind === 'dapp-send' ? { handle: HANDLE } : {}),
        });
        expect(context).toEqual(kind === 'dapp-send' ? { caller: 'page', page: PAGE } : { caller: 'shell' });
      }
    });

    test('a send presented without its kind is refused and burnt', async () => {
      for (const [kind, mint, tx, index] of SENDS) {
        const confirmation = await mint();
        const { authorization, page } = sc.signingAuthorization(confirmation);
        const { kind: named, ...kindless } = authorization;
        expect(named).toBe(kind);
        const presented = vaultBackend.sign.transaction(account(index), wire(tx), { authorization: kindless, page });
        expect(await reasonOf(presented)).toBe('mismatch');
        // Burnt: not even named as its own kind does it sign now.
        expect(await reasonOf(signSend(confirmation, tx, index))).toBe('unknown_token');
      }
    });

    test('a send named as another kind is refused and burnt', async () => {
      for (const [kind, mint, tx, index] of SENDS) {
        for (const other of ['wallet-send', 'executor-send', 'dapp-send', 'intent-replace'].filter((k) => k !== kind)) {
          const confirmation = await mint();
          const { authorization, page } = sc.signingAuthorization(confirmation);
          const presented = vaultBackend.sign.transaction(account(index), wire(tx), {
            authorization: { ...authorization, kind: other },
            page,
          });
          expect(await reasonOf(presented)).toBe('mismatch');
          expect(await reasonOf(signSend(confirmation, tx, index))).toBe('unknown_token');
        }
      }
    });
  });

  describe('page kinds, minted by main for a page under `page`', () => {
    test('a dApp send signs under its page, once, for its document and handle', async () => {
      const confirmation = await pageToken('dapp-send', 0, DAPP_TX);
      expect(calls.find((call) => call.method === 'approval.issue')).toMatchObject({
        context: { caller: 'page', page: PAGE },
        params: { kind: 'dapp-send', account: 0, handle: HANDLE },
      });
      await expect(signSend(confirmation, DAPP_TX)).resolves.toHaveProperty('raw');
      expect(calls.find((call) => call.method === 'sign.transaction')).toMatchObject({
        context: { caller: 'page', page: PAGE },
        params: { authorization: { token: confirmation.token, kind: 'dapp-send', handle: HANDLE } },
      });
      expect(await reasonOf(signSend(confirmation, DAPP_TX))).toBe('unknown_token');
    });

    test('a page token is refused for another origin, frame, document, handle, or as main\'s own', async () => {
      const others = [
        { page: { ...PAGE, origin: OTHER_SITE } },
        { page: { ...PAGE, frame: 5 } },
        { page: { ...PAGE, navigation: 10 } },
        { handle: OTHER_HANDLE },
        { page: null, handle: undefined },
      ];
      for (const other of others) {
        const confirmation = await pageToken('dapp-send', 0, DAPP_TX);
        const presented = { ...confirmation, ...other };
        const err = await refusal(signSend(presented, DAPP_TX));
        expect(['not_authorized', 'invalid_argument']).toContain(err.code);
        // Burnt as it was presented.
        expect(await reasonOf(signSend(confirmation, DAPP_TX))).toBe('unknown_token');
      }
    });

    test("a dApp send without its site is refused before the core is asked", async () => {
      await expect(pageToken('dapp-send', 0, TX)).rejects.toThrow(/needs the site it is for/);
    });

    test('personal_sign: the exact message, its text and hex one message', async () => {
      const confirmation = await pageToken('sign-message', 0, 'hello');
      const sign = (c, text) =>
        vaultBackend.sign.message(account(0), Buffer.from(text, 'utf8'), sc.signingAuthorization(c));
      expect(await reasonOf(sign(confirmation, 'hellp'))).toBe('mismatch');
      const again = await pageToken('sign-message', 0, '0x68656c6c6f');
      await expect(sign(again, 'hello')).resolves.toMatch(/^0x[0-9a-f]{130}$/);
    });

    test('typed data: the token carries the core hash, key order does not matter, content does', async () => {
      const confirmation = await pageToken('sign-typed-data', 0, TYPED_DATA, PAGE, HANDLE, { chainId: 100 });
      const { types, domain, message } = TYPED_DATA;
      expect(confirmation.hash).toBe(TypedDataEncoder.hash(domain, types, message));
      expect(confirmation.view).toBeTruthy();
      const reordered = { message: { value: '1' }, primaryType: 'Permit', types, domain: { verifyingContract: domain.verifyingContract, chainId: 100, name: 'Permit' } };
      const sign = (c, data, hash = c.hash) =>
        vaultBackend.sign.typedData(account(0), toCoreTypedData(data), hash, {
          ...sc.signingAuthorization(c),
          primaryType: c.payload.primary_type,
          chainId: c.payload.chain_id,
        });
      await expect(sign(confirmation, reordered)).resolves.toMatch(/^0x[0-9a-f]{130}$/);
      const other = await pageToken('sign-typed-data', 0, TYPED_DATA, PAGE, HANDLE, { chainId: 100 });
      const changed = { ...TYPED_DATA, message: { value: '2' } };
      const err = await refusal(sign(other, changed, TypedDataEncoder.hash(domain, types, changed.message)));
      expect(err.code).toBe('not_authorized');
      // Told another chain beside the data, the view differs.
      const chained = await pageToken('sign-typed-data', 0, TYPED_DATA, PAGE, HANDLE, { chainId: 100 });
      const viewed = await refusal(
        vaultBackend.sign.typedData(account(0), toCoreTypedData(TYPED_DATA), chained.hash, {
          ...sc.signingAuthorization(chained),
          primaryType: 'Permit',
          chainId: '1',
        })
      );
      expect(viewed.code).toBe('not_authorized');
    });

    test('a message token cannot sign typed data, nor a typed-data token a message', async () => {
      const message = await pageToken('sign-message', 0, 'hello');
      const { domain, types, message: body } = TYPED_DATA;
      const err = await refusal(
        vaultBackend.sign.typedData(account(0), toCoreTypedData(TYPED_DATA), TypedDataEncoder.hash(domain, types, body), sc.signingAuthorization(message))
      );
      expect(err.code).toBe('not_authorized');
      const typed = await pageToken('sign-typed-data', 0, TYPED_DATA, PAGE, HANDLE, { chainId: 100 });
      expect(await reasonOf(vaultBackend.sign.message(account(0), Buffer.from('hello'), sc.signingAuthorization(typed)))).toBe(
        'mismatch'
      );
    });

    test("main's issuer mints only a page kind, with its handle and page", async () => {
      await expect(pageToken('wallet-send', 0, TX)).rejects.toThrow(/Not a page confirmation kind/);
      await expect(pageToken('safe-send', SAFE_INDEX, { tx: { to: TX.to }, chainId: 100 })).rejects.toThrow(
        /Not a page confirmation kind/
      );
      for (const [page, handle] of [
        [PAGE, 'xyz'],
        [PAGE, undefined],
        [null, HANDLE],
        [{ ...PAGE, origin: '' }, HANDLE],
      ]) {
        await expect(sc.issuePageConfirmation('sign-message', 0, '0x68', { handle, context: page })).rejects.toThrow(/needs its/);
      }
      expect(calls.filter((call) => call.method === 'approval.issue')).toEqual([]);
    });
  });

  describe("a site's standing rule: Q9's limited rule, written and judged by the core (APB-1b, APB-2)", () => {
    const SELECTOR = TX.data.slice(0, 10);
    const MESSAGE_SIGNER = new Wallet(ABANDON_KEY).address;
    let permissions;
    let getSigner;

    beforeAll(() => {
      permissions = require('./dapp-permissions');
      ({ getSigner } = require('./signers'));
    });

    afterEach(async () => {
      for (const site of [SITE, OTHER_SITE]) await permissions.revokePermission(site);
    });

    // The send main would sign under the rule: the page's call, quoted.
    const SEND = Object.freeze({
      to: TX.to,
      value: TX.value,
      data: TX.data,
      chainId: 100,
      gasLimit: TX.gasLimit,
      maxFeePerGas: TX.maxFeePerGas,
      maxPriorityFeePerGas: TX.maxPriorityFeePerGas,
    });
    const check = (request, page = PAGE) => sc.checkStanding(page, { account: 0, accountType: 'mnemonic', ...request });
    const ruled = (page) => getSigner(0, { page, standing: {}, chainId: 100 });
    const notConfirmed = async (promise) => {
      const err = await refusal(promise);
      expect(err.code).toBe('SIGNING_NOT_CONFIRMED');
      return err.reason;
    };
    // "Always allow" on a confirmed dApp send: the core signs it and writes
    // the contract rule (design 0012, The model, APB-2); its reply says so.
    async function flaggedSend(page = PAGE, send = SEND) {
      const confirmation = await pageToken('dapp-send', 0, { ...send, origin: page.origin }, page, HANDLE, { remember: true });
      const heard = [];
      const raw = await getSigner(0, { confirmation, onRule: (rule) => heard.push(rule) }).signTransaction(
        buildTransaction({ ...send, nonce: 7 })
      );
      expect(Transaction.from(raw).from).toBe(MESSAGE_SIGNER);
      return heard;
    }

    test('a signature the signing rule answers: chosen by the core, and signed under `page` with `{ standing }`', async () => {
      await permissions.grantPermission(SITE, 0, 100, PAGE);
      await permissions.setSigningAutoApprove(SITE, true, PAGE);
      expect(await check({ kind: 'message', payload: 'hello' })).toEqual({ covered: true, reason: null });
      expect(calls.at(-1)).toMatchObject({
        method: 'approval.check',
        context: { caller: 'page', page: PAGE },
        params: { request: { kind: 'message', account: 0, account_kind: 'vault', message: '0x68656c6c6f' } },
      });
      const signature = await ruled(PAGE).signMessage('hello');
      expect(require('ethers').verifyMessage('hello', signature)).toBe(MESSAGE_SIGNER);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.message',
        context: { caller: 'page', page: PAGE },
        params: { authorization: { standing: {} } },
      });

      // Typed data, viewed on the page's chain, as the core judges it.
      const { domain, types, message } = TYPED_DATA;
      const hash = TypedDataEncoder.hash(domain, types, message);
      expect(await check({ kind: 'typed_data', payload: TYPED_DATA, chainId: 100 })).toEqual({ covered: true, reason: null });
      expect(calls.at(-1).params).toMatchObject({ chain_id: 100, request: { kind: 'typed_data', primary_type: 'Permit' } });
      await expect(ruled(PAGE).signTypedData(TYPED_DATA, { expectedHash: hash })).resolves.toMatch(/^0x[0-9a-f]{130}$/);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.typed_data',
        context: { caller: 'page', page: PAGE },
        params: { chain_id: '100', primary_type: 'Permit', authorization: { standing: {} } },
      });
      // On another chain than the data's, the view warns: the prompt, and
      // no signature under the rule.
      expect(await check({ kind: 'typed_data', payload: TYPED_DATA, chainId: 1 })).toEqual({ covered: false, reason: 'warning' });
      const elsewhere = getSigner(0, { page: PAGE, standing: {}, chainId: 1 });
      expect(await notConfirmed(elsewhere.signTypedData(TYPED_DATA, { expectedHash: hash }))).toBe('warning');
      // Never 32 bytes (#89).
      const raw = '0x' + 'ab'.repeat(32);
      expect(await check({ kind: 'message', payload: raw })).toEqual({ covered: false, reason: 'warning' });
      expect(await notConfirmed(ruled(PAGE).signMessage(raw))).toBe('warning');
    });

    test('no rule answers another site, another account, a tab in custody, a rule turned off, or no grant', async () => {
      await permissions.grantPermission(SITE, 0, 100, PAGE);
      await permissions.setSigningAutoApprove(SITE, true, PAGE);
      const message = { kind: 'message', payload: 'hello' };
      expect(await check(message, { ...PAGE, origin: OTHER_SITE, top_origin: OTHER_SITE })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await check({ ...message, account: 1 })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await check(message, { ...PAGE, agent: true })).toEqual({ covered: false, reason: 'custody' });
      expect(await notConfirmed(ruled({ ...PAGE, agent: true }).signMessage('hello'))).toBe('custody');
      expect(await notConfirmed(ruled({ ...PAGE, origin: OTHER_SITE }).signMessage('hello'))).toBe('no_rule');
      // Turned off (main's own, from the chrome), or revoked: the core's next
      // check reads it.
      expect(await permissions.setSigningAutoApprove(SITE, false)).toBe(true);
      expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
      expect(await notConfirmed(ruled(PAGE).signMessage('hello'))).toBe('no_rule');
      await permissions.setSigningAutoApprove(SITE, true, PAGE);
      expect(await permissions.revokePermission(SITE)).toBe(true);
      expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
      // A request the core can't judge reads as not covered, unasked.
      calls.length = 0;
      expect(await sc.checkStanding(PAGE, { kind: 'message', account: 0, accountType: 'hardware', payload: 'hello' })).toEqual({
        covered: false,
        reason: 'invalid',
      });
      expect(calls).toEqual([]);
    });

    test("a send the contract rule answers: the rule the core wrote from a confirmed send, with main's pause, its value cap and the core's own fee check", async () => {
      await permissions.grantPermission(SITE, 0, 100, PAGE);
      expect(await flaggedSend()).toEqual([{ added: true }]);
      const send = (request) => check({ kind: 'transaction', payload: SEND, paused: false, ...request });
      // A phone picks its own fee: the rule, the account and the pause decide.
      expect(await send({ accountType: 'remote' })).toEqual({ covered: true, reason: null });
      expect(calls.at(-1).params).toMatchObject({
        chain_id: 100,
        paused: false,
        request: { kind: 'transaction', account_kind: 'phone', tx: { to: TX.to, value: TX.value, data: TX.data } },
      });
      expect(calls.at(-1).params.request.tx).not.toHaveProperty('nonce');
      // D12: paused, or a pause main didn't read, isn't covered.
      expect(await send({ accountType: 'remote', paused: true })).toEqual({ covered: false, reason: 'paused' });
      expect(await send({ accountType: 'remote', paused: undefined })).toEqual({ covered: false, reason: 'paused' });
      // More value than the confirmed send's, a plain transfer, another chain, a Safe.
      const more = { ...SEND, value: (BigInt(TX.value) + 1n).toString() };
      expect(await send({ accountType: 'remote', payload: more })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await send({ accountType: 'remote', payload: { ...SEND, data: '0x' } })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await send({ accountType: 'remote', payload: { ...SEND, chainId: 1 } })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await send({ accountType: 'safe' })).toEqual({ covered: false, reason: 'no_rule' });
      // A vault account's send needs the core's own fee evidence, which only
      // its `chain.fee_reference` gives: with none, the prompt.
      expect(await send({ accountType: 'mnemonic' })).toEqual({ covered: false, reason: 'fee_check' });
      // The signature itself: judged again by the core under `{ standing }`.
      const built = buildTransaction({ ...SEND, nonce: 7 });
      const signer = getSigner(0, { page: PAGE, standing: { paused: false } });
      expect(await notConfirmed(signer.signTransaction(built))).toBe('fee_check');
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.transaction',
        context: { caller: 'page', page: PAGE },
        params: { authorization: { standing: { paused: false } } },
      });
      expect(await notConfirmed(getSigner(0, { page: PAGE, standing: {} }).signTransaction(built))).toBe('paused');
      expect(await notConfirmed(getSigner(0, { page: { ...PAGE, agent: true }, standing: { paused: false } }).signTransaction(built))).toBe(
        'custody'
      );
      // Removed (main's own, from the chrome), the rule answers nothing.
      expect(await permissions.removeTransactionAutoApprove(SITE, TX.to, SELECTOR, 100)).toBe(true);
      expect(await send({ accountType: 'remote' })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await flaggedSend()).toEqual([{ added: true }]);
      await permissions.revokePermission(SITE);
      expect(await notConfirmed(signer.signTransaction(built))).toBe('no_rule');
    });

    test('"Always allow": the core writes the rule as it signs and says so; not ticked, or not connected, none', async () => {
      // Not connected: the core signs the confirmed send, and writes no rule.
      expect(await flaggedSend()).toEqual([{ added: false, reason: 'not_exposed' }]);
      await permissions.grantPermission(SITE, 0, 100, PAGE);
      expect(calls.find((call) => call.method === 'approval.grant')).toMatchObject({
        context: { caller: 'page', page: PAGE },
        params: { store: 'dapp', change: { op: 'connect', account: 0, chain_id: 100 } },
      });
      expect(await flaggedSend()).toEqual([{ added: true }]);
      expect(calls.filter((call) => call.method === 'approval.issue').at(-1).params.payload).toEqual({
        tx: expect.any(Object),
        remember: true,
      });
      // Not ticked: no flag, and no rule in the reply.
      const plain = await pageToken('dapp-send', 0, DAPP_TX);
      expect(calls.filter((call) => call.method === 'approval.issue').at(-1).params.payload).toEqual({ tx: expect.any(Object) });
      const heard = [];
      await getSigner(0, { confirmation: plain, onRule: (rule) => heard.push(rule) }).signTransaction(
        buildTransaction({ ...SEND, nonce: 7 })
      );
      expect(heard).toEqual([null]);
      // The file holds Q9's limited rule, where an older build doesn't look.
      const file = JSON.parse(fs.readFileSync(path.join(root, 'dapp-permissions.json'), 'utf8'));
      expect(file[SITE].autoApprove).toEqual({
        signing: false,
        transactions: [],
        limited: {
          signing: null,
          transactions: [
            { to: TX.to.toLowerCase(), selector: SELECTOR, chainId: 100, maxValue: TX.value, grantedAt: expect.any(Number) },
          ],
        },
      });
    });
  });

  // APB-1c: the Safe approval a Safe's spend gives, presented by each vault
  // owner's `sign.typed_data` and the executor's `sign.transaction` as
  // `{ safe }`, under the caller it was recorded for, until main ends it.
  describe("Safe approvals: each owner's and the executor's signature (APB-1c)", () => {
    const { Interface, hashMessage, concat } = require('ethers');
    const ZERO = '0x' + '00'.repeat(20);
    const OWNER = new Wallet(ABANDON_KEY).address;
    const SAFE_CALL = Object.freeze({ to: TX.to, value: '5', data: '0x' });
    const EXEC = new Interface([
      'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
    ]);
    const DOMAIN_TYPE = [
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ];
    // A SafeTx as safe-executor builds one for a call (protocol-kit's
    // createTransaction): operation 0, no refund.
    const safeTx = (call = SAFE_CALL, nonce = 3) => ({
      domain: { chainId: 100, verifyingContract: SAFE_ADDRESS },
      types: {
        EIP712Domain: DOMAIN_TYPE,
        SafeTx: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' },
          { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' },
          { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
      primaryType: 'SafeTx',
      message: {
        ...call,
        operation: 0,
        safeTxGas: '0',
        baseGas: '0',
        gasPrice: '0',
        gasToken: ZERO,
        refundReceiver: ZERO,
        nonce: String(nonce),
      },
    });
    // A SafeMessage as safe-messages builds one: the digest a verifier
    // computes for the page's request.
    const safeMessage = (digest) => ({
      domain: { chainId: 100, verifyingContract: SAFE_ADDRESS },
      types: { EIP712Domain: DOMAIN_TYPE, SafeMessage: [{ name: 'message', type: 'bytes' }] },
      primaryType: 'SafeMessage',
      message: { message: digest },
    });
    // The executor's transaction: execTransaction to the Safe, value 0, the
    // SafeTx field for field, with the owners' signatures.
    const execSend = (signatures, call = SAFE_CALL) => ({
      to: SAFE_ADDRESS,
      value: '0',
      data: EXEC.encodeFunctionData('execTransaction', [call.to, call.value, call.data, 0, 0, 0, 0, ZERO, ZERO, concat(signatures)]),
      chainId: 100,
      gasLimit: '150000',
      maxFeePerGas: TX.maxFeePerGas,
      maxPriorityFeePerGas: TX.maxPriorityFeePerGas,
    });
    let getSigner;

    beforeAll(() => {
      ({ getSigner } = require('./signers'));
    });

    const owner = (approval) => getSigner(0, { safe: approval });
    const notConfirmed = async (promise) => {
      const err = await refusal(promise);
      expect(err.code).toBe('SIGNING_NOT_CONFIRMED');
      return err.reason;
    };
    const walletApproval = async (call = SAFE_CALL) =>
      (await sc.spendSafeConfirmation(await walletToken('safe-send', SAFE_INDEX, { tx: call, chainId: 100 }))).approval;
    const pageApproval = async (kind, payload, page = PAGE) =>
      (await sc.spendSafeConfirmation(await pageToken(kind, SAFE_INDEX, payload, page))).approval;

    test("a wallet's: its owners sign the SafeTx it approved as main itself, the first fixing it; nothing else", async () => {
      const approval = await walletApproval();
      // Another call, or the same call on another chain, is refused.
      await expect(notConfirmed(owner(approval).signTypedData(safeTx({ ...SAFE_CALL, value: '6' })))).resolves.toBe('mismatch');
      await expect(
        notConfirmed(owner(approval).signTypedData({ ...safeTx(), domain: { chainId: 1, verifyingContract: SAFE_ADDRESS } }))
      ).resolves.toBe('mismatch');
      // Under a page: not the wallet's caller.
      await expect(notConfirmed(owner({ ...approval, page: PAGE }).signTypedData(safeTx()))).resolves.toBe('mismatch');
      // The SafeTx itself, at its nonce, as main: signed, under `shell`.
      const signature = await owner(approval).signTypedData(safeTx());
      const { domain, types, message } = safeTx();
      const { EIP712Domain: _domain, ...signed } = types;
      expect(require('ethers').verifyTypedData(domain, signed, message, signature)).toBe(OWNER);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.typed_data',
        context: { caller: 'shell' },
        params: { authorization: { safe: approval.id } },
      });
      // Fixed: the same SafeTx again, but not one at another nonce.
      await expect(owner(approval).signTypedData(safeTx())).resolves.toBe(signature);
      await expect(notConfirmed(owner(approval).signTypedData(safeTx(SAFE_CALL, 4)))).resolves.toBe('mismatch');
      // A message is never a Safe owner's.
      await expect(notConfirmed(owner(approval).signMessage('hello'))).resolves.toBe('mismatch');
      // Ended (main's discard): every later use refused, and ending again is {}.
      await expect(vaultBackend.approval.end(approval.id)).resolves.toEqual({});
      await expect(notConfirmed(owner(approval).signTypedData(safeTx()))).resolves.toBe('unknown_token');
      await expect(vaultBackend.approval.end(approval.id)).resolves.toEqual({});
    });

    test("a page's: signed only under its own PageContext, the document gone or not; never as main's", async () => {
      const approval = await pageApproval('safe-send', { tx: SAFE_CALL, chainId: 100, origin: SITE });
      expect(approval.page).toEqual(PAGE);
      for (const other of [null, { ...PAGE, navigation: PAGE.navigation + 1 }, { ...PAGE, frame: PAGE.frame + 1 }, { ...PAGE, origin: OTHER_SITE, top_origin: OTHER_SITE }]) {
        await expect(notConfirmed(owner({ ...approval, page: other }).signTypedData(safeTx()))).resolves.toBe('mismatch');
      }
      await expect(owner(approval).signTypedData(safeTx())).resolves.toMatch(/^0x[0-9a-f]{130}$/);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.typed_data',
        context: { caller: 'page', page: PAGE },
        params: { authorization: { safe: approval.id } },
      });
      await vaultBackend.approval.end(approval.id, PAGE);
      expect(calls.at(-1)).toMatchObject({ method: 'approval.end', context: { caller: 'page', page: PAGE } });
    });

    test("the executor: the approval while the core's fee check allows it, else an executor-send token; main ends it once executed", async () => {
      const approval = await walletApproval();
      const ownerSignature = await owner(approval).signTypedData(safeTx());
      const send = execSend([ownerSignature]);
      const executor = (authorized) => getSigner(0, authorized);
      const signedTx = (built) => buildTransaction({ ...built, nonce: 7 });
      // Another call than the SafeTx approved: refused whatever the fee.
      await expect(
        notConfirmed(executor({ safe: approval }).signTransaction(signedTx(execSend([ownerSignature], { ...SAFE_CALL, value: '6' }))))
      ).resolves.toBe('mismatch');
      // No fee evidence served to this core: its fee check stops the
      // approval, with nothing signed (main asks the fee: safe-executor.js).
      await expect(notConfirmed(executor({ safe: approval }).signTransaction(signedTx(send)))).resolves.toBe('fee_check');
      // The user confirms the fee: an executor-send token, named as its kind.
      const { token } = await sc.issueConfirmation('executor-send', 0, send);
      const confirmation = sc.confirmationFor(token, 'executor-send', 0, send);
      const raw = await executor({ confirmation }).signTransaction(signedTx(send));
      expect(Transaction.from(raw).from).toBe(OWNER);
      expect(calls.at(-1)).toMatchObject({
        method: 'sign.transaction',
        context: { caller: 'shell' },
        params: { authorization: { kind: 'executor-send' } },
      });
      // Executed: main ends the approval, and no owner signs with it again.
      await vaultBackend.approval.end(approval.id);
      await expect(notConfirmed(owner(approval).signTypedData(safeTx()))).resolves.toBe('unknown_token');
    });

    test("a Safe's new send approval ends its older one", async () => {
      const older = await walletApproval();
      const newer = await walletApproval();
      await expect(notConfirmed(owner(older).signTypedData(safeTx()))).resolves.toBe('unknown_token');
      await expect(owner(newer).signTypedData(safeTx())).resolves.toMatch(/^0x/);
      await vaultBackend.approval.end(newer.id);
    });

    test("a page's Safe message: its owners sign the SafeMessage over the request's digest, under its page, until ended", async () => {
      const request = { method: 'personal_sign', params: ['0x68656c6c6f', SAFE_ADDRESS] };
      const approval = await pageApproval('safe-message', request);
      const digest = hashMessage(require('ethers').getBytes('0x68656c6c6f'));
      await expect(notConfirmed(owner(approval).signTypedData(safeMessage(hashMessage('other'))))).resolves.toBe('mismatch');
      await expect(notConfirmed(owner({ ...approval, page: null }).signTypedData(safeMessage(digest)))).resolves.toBe('mismatch');
      await expect(owner(approval).signTypedData(safeMessage(digest))).resolves.toMatch(/^0x[0-9a-f]{130}$/);
      // The threshold's last signature: main ends it before the join.
      await vaultBackend.approval.end(approval.id, PAGE);
      await expect(notConfirmed(owner(approval).signTypedData(safeMessage(digest)))).resolves.toBe('unknown_token');
    });

    test("a Safe message a site's rule answers: approval.spend { standing } under the page, judged by the core", async () => {
      const permissions = require('./dapp-permissions');
      const request = { method: 'personal_sign', params: ['0x68656c6c6f', SAFE_ADDRESS] };
      try {
        // No rule for the Safe: refused, no approval.
        await permissions.grantPermission(SITE, SAFE_INDEX, 100, PAGE);
        await expect(notConfirmed(sc.spendStandingSafeMessage(PAGE, SAFE_INDEX, request))).resolves.toBe('no_rule');
        await permissions.setSigningAutoApprove(SITE, true, PAGE);
        // In custody: the rule never answers.
        await expect(notConfirmed(sc.spendStandingSafeMessage({ ...PAGE, agent: true }, SAFE_INDEX, request))).resolves.toBe('custody');
        const approval = await sc.spendStandingSafeMessage(PAGE, SAFE_INDEX, request);
        expect(approval).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), page: PAGE });
        expect(calls.find((call) => call.method === 'approval.spend' && call.params.standing)).toMatchObject({
          context: { caller: 'page', page: PAGE },
          params: { standing: {}, kind: 'safe-message', account: SAFE_INDEX, payload: { safe: SAFE_ADDRESS, chain_id: '100' } },
        });
        const digest = hashMessage(require('ethers').getBytes('0x68656c6c6f'));
        await expect(owner(approval).signTypedData(safeMessage(digest))).resolves.toMatch(/^0x[0-9a-f]{130}$/);
        await vaultBackend.approval.end(approval.id, PAGE);
      } finally {
        await permissions.revokePermission(SITE);
      }
    });

    // Review of #1245, round 1: main ends a held approval through the core
    // and counts a failed end only once the core process that gave it has
    // ended, since a new process knows none of its approvals. Last: it
    // restarts the core.
    test('held by main, ended through the core ({} again once ended); a restarted core knows none', async () => {
      const safeApprovals = require('./safe/safe-approvals');
      safeApprovals._reset();
      const hash = '0x' + '11'.repeat(32);
      const ended = await walletApproval();
      await safeApprovals.hold('send', SAFE_INDEX, ended, hash);
      await safeApprovals.end('send', SAFE_INDEX, hash);
      expect(calls.at(-1)).toMatchObject({ method: 'approval.end', params: { safe: ended.id }, context: { caller: 'shell' } });
      await expect(safeApprovals.release(ended)).resolves.toBeUndefined();
      await expect(notConfirmed(owner(ended).signTypedData(safeTx()))).resolves.toBe('unknown_token');

      const live = await walletApproval();
      await safeApprovals.hold('send', SAFE_INDEX, live, hash);
      const mark = vaultBackend.coreProcess();
      expect(vaultBackend.coreProcessEnded(mark)).toBe(false);
      // The core process exits (a crash), and main's client starts another.
      const exited = new Promise((resolve) => core.once('exit', resolve));
      const restarted = new Promise((resolve) => core.once('ready', resolve));
      core.current.child.kill('SIGKILL');
      await exited;
      expect(vaultBackend.coreProcessEnded(mark)).toBe(true);
      await restarted;
      expect(vaultBackend.coreProcessEnded(mark)).toBe(true);
      expect(vaultBackend.coreProcessEnded(vaultBackend.coreProcess())).toBe(false);
      await expect(safeApprovals.end('send', SAFE_INDEX, hash)).resolves.toBeUndefined();
      await vaultBackend.unlock('testpass1');
      await expect(notConfirmed(owner(live).signTypedData(safeTx()))).resolves.toBe('unknown_token');
    }, 30_000);
  });
});

// APB-2 (design 0012, "The files (Q10)", Q9): `dapp-permissions.json` is the
// core's. Main names it in the hello's `grant_moved`, every write goes to the
// core's write methods (main writes the file nowhere: a spy on `fs`), and
// today's unlimited rules answer nothing. A profile from before the move,
// with today's signing flag and a contract rule, prompts for both; "Always
// allow" on each prompt has the core write the limited replacement and clear
// today's rule in the same write, so the reference (the build before APB-2,
// test/helpers/reference-dapp-permissions.js) then finds no rule for either.
// Rolled back, the reference reads the core's file and sees the same grants.
describeIfBinary('the dApp file, the core\'s from APB-2 (real freedom-cored)', () => {
  const SELECTOR = TX.data.slice(0, 10);
  const THIRD_SITE = 'https://third.example';
  const TODAY_RULE = Object.freeze({ to: TX.to.toLowerCase(), selector: SELECTOR, chainId: 100, maxValue: TX.value });
  // A profile written by a build before APB-2.
  const TODAY = Object.freeze({
    [SITE]: {
      origin: SITE,
      connectedAt: 1700000000000,
      lastUsed: 1700000000001,
      walletIndex: 0,
      chainId: 100,
      autoApprove: { signing: true, transactions: [TODAY_RULE] },
    },
    [OTHER_SITE]: {
      origin: OTHER_SITE,
      connectedAt: 1700000000000,
      lastUsed: 1700000000000,
      walletIndex: 0,
      chainId: 1,
      autoApprove: { signing: false, transactions: [] },
    },
  });
  const SEND = Object.freeze({
    to: TX.to,
    value: TX.value,
    data: TX.data,
    chainId: 100,
    gasLimit: TX.gasLimit,
    maxFeePerGas: TX.maxFeePerGas,
    maxPriorityFeePerGas: TX.maxPriorityFeePerGas,
  });
  const FS_WRITES = ['writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'truncateSync', 'unlinkSync', 'rmSync', 'openSync'];
  const FS_PROMISE_WRITES = ['writeFile', 'appendFile', 'rename', 'copyFile', 'truncate', 'unlink', 'rm', 'open'];

  let root;
  let core;
  let calls;
  let sc;
  let permissions;
  let reference;
  let getSigner;
  let buildTransaction;
  let vaultBackend;
  let spies;

  const file = () => path.join(root, 'dapp-permissions.json');
  const readReference = () => {
    reference._resetCache();
    return reference;
  };
  const coreRecords = async () => (await vaultBackend.approval.grants({ store: 'dapp' })).records;
  const check = (request, page = PAGE) => sc.checkStanding(page, { account: 0, accountType: 'remote', ...request });
  const message = { kind: 'message', payload: 'hello' };
  const send = { kind: 'transaction', payload: SEND, paused: false };
  async function flaggedSend(page = PAGE) {
    const confirmation = await sc.issuePageConfirmation(
      'dapp-send',
      0,
      { ...SEND, origin: page.origin },
      { handle: HANDLE, context: page },
      { remember: true }
    );
    const heard = [];
    await getSigner(0, { confirmation, onRule: (rule) => heard.push(rule) }).signTransaction(buildTransaction({ ...SEND, nonce: 7 }));
    return heard;
  }
  async function refusal(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error('expected a refusal');
  }
  async function until(condition) {
    for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(condition()).toBe(true);
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dapp-file-moved-'));
    fs.writeFileSync(path.join(root, 'dapp-permissions.json'), JSON.stringify(TODAY, null, 2), { mode: 0o600 });
    const { CoreClient } = require('../core/core-client');
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    calls = [];
    const request = core.request.bind(core);
    core.request = (method, params, context, options) => {
      calls.push({ method, context, params });
      return request(method, params, context, options);
    };
    jest.resetModules();
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../identity-manager', () => ({
      getWalletRecord: () => null,
      isHardwareWalletIndex: () => false,
      recordLedgerAddressCheck: () => {},
      recordRemoteAddressCheck: () => {},
      WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
    }));
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    jest.doMock('./ledger/signer', () => ({ createLedgerBackend: () => ({}) }));
    jest.doMock('./remote/signer', () => ({ createRemoteBackend: () => ({}) }));
    // The reference reads the file where the core writes it.
    jest.doMock('../freedom-root', () => ({ getFreedomDataPath: (name) => path.join(root, name) }));
    sc = require('./signing-confirmation');
    ({ vaultBackend } = require('../core/vault-backend'));
    ({ buildTransaction } = require('./transaction-service'));
    ({ getSigner } = require('./signers'));
    permissions = require('./dapp-permissions');
    reference = require('../../../test/helpers/reference-dapp-permissions');
    // Main's copy follows the core: read whole at the handshake, a key again
    // for each approval.changed (core-process.js attaches it).
    permissions.attachCore(core);
    await core.start();
    await permissions.whenLoaded();
    await vaultBackend.importVault('testpass1', ABANDON);
  });

  afterAll(async () => {
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
    spies = [...FS_WRITES.map((name) => jest.spyOn(fs, name)), ...FS_PROMISE_WRITES.map((name) => jest.spyOn(fs.promises, name))];
  });

  afterEach(() => {
    // Main writes the dApp file nowhere: the core is its only writer. (A
    // read opens it 'r'.)
    for (const spy of spies) {
      spy.mock.calls.forEach(([target, second]) => {
        if (spy === fs.openSync || spy === fs.promises.open) {
          if (second === undefined || second === 'r') return;
        }
        expect(String(target)).not.toMatch(/dapp-permissions\.json/);
        if (typeof second === 'string') expect(second).not.toMatch(/dapp-permissions\.json/);
      });
      spy.mockRestore();
    }
    expect(unmovedWrites(calls)).toEqual([]);
  });

  test("the hello names the moved files in grant_moved, and main's copy is the store the core read", async () => {
    expect([...core.service.helloParams(core).grant_moved].sort()).toEqual(['dapp', 'radicle', 'swarm']);
    expect(permissions.getPermission(SITE)).toEqual(TODAY[SITE]);
    expect(permissions.getPermission(OTHER_SITE)).toEqual(TODAY[OTHER_SITE]);
    expect(await coreRecords()).toEqual([TODAY[SITE], TODAY[OTHER_SITE]]);
    expect(calls.at(-1)).toMatchObject({ method: 'approval.grants', context: { caller: 'shell' } });
  });

  test("today's unlimited rules answer nothing (Q9): the site's signature and its send each prompt", async () => {
    expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
    expect(await check(send)).toEqual({ covered: false, reason: 'no_rule' });
    const signer = getSigner(0, { page: PAGE, standing: {}, chainId: 100 });
    const err = await refusal(signer.signMessage('hello'));
    expect(err).toMatchObject({ code: 'SIGNING_NOT_CONFIRMED', reason: 'no_rule' });
    // The older build still answers them in the file as it stands.
    expect(readReference().getSigningAutoApprove(SITE)).toBe(true);
    expect(readReference().isTransactionAutoApproved(SITE, TX.to, SELECTOR, 100, TX.value)).toBe(true);
  });

  test("Q9's transition: the limited replacements through the browser's own prompt; the reference then finds no rule for either", async () => {
    // "Always allow" on the signing prompt (page/page-signing.js): Q9's
    // limited rule, under the page, which clears today's flag.
    expect(await permissions.setSigningAutoApprove(SITE, true, PAGE)).toBe(true);
    expect(calls.find((call) => call.method === 'approval.grant')).toMatchObject({
      context: { caller: 'page', page: PAGE },
      params: { store: 'dapp', change: { op: 'signing' } },
    });
    // "Always allow" on the send's prompt (page/page-sends.js): the core
    // writes the limited contract rule as it signs, clearing today's.
    expect(await flaggedSend()).toEqual([{ added: true }]);
    // The new build answers both.
    expect(await check(message)).toEqual({ covered: true, reason: null });
    expect(await check(send)).toEqual({ covered: true, reason: null });
    // The file: the limited rules where an older build doesn't look, today's
    // cleared, the rest as it was.
    const written = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(written[SITE]).toEqual({
      ...TODAY[SITE],
      autoApprove: {
        signing: false,
        transactions: [],
        limited: {
          signing: { grantedAt: expect.any(Number) },
          transactions: [{ ...TODAY_RULE, grantedAt: expect.any(Number) }],
        },
      },
    });
    expect(written[OTHER_SITE]).toEqual(TODAY[OTHER_SITE]);
    // An older build, reading the core's file, finds no rule for either, and
    // prompts for both.
    const older = readReference();
    expect(older.getSigningAutoApprove(SITE)).toBe(false);
    expect(older.isTransactionAutoApproved(SITE, TX.to, SELECTOR, 100, TX.value)).toBe(false);
    expect(older.isTransactionAutoApproved(SITE, TX.to, SELECTOR, 100, '0')).toBe(false);
    expect(older.getPermission(SITE).walletIndex).toBe(0);
    // Main's copy followed the core's change (approval.changed).
    await until(() => permissions.getPermission(SITE)?.autoApprove?.limited?.transactions?.length === 1);
  });

  test('rollback: the reference reads the file the core wrote and sees the same grants', async () => {
    const third = { ...PAGE, origin: THIRD_SITE, top_origin: THIRD_SITE };
    await permissions.grantPermission(THIRD_SITE, 1, 10, third);
    await permissions.updateWalletIndex(THIRD_SITE, 2, third);
    await permissions.updateLastUsed(THIRD_SITE, 100, third);
    expect(await permissions.revokePermission(OTHER_SITE)).toBe(true);
    // The chrome's revoke goes as the chrome (design 0012, API).
    expect(calls.filter((call) => call.method === 'approval.revoke').at(-1)).toMatchObject({
      params: { store: 'dapp', key: OTHER_SITE, what: 'grant' },
      context: { caller: 'chrome' },
    });
    const records = await coreRecords();
    const older = readReference();
    expect(older.getAllPermissions()).toEqual(records);
    for (const record of records) expect(older.getPermission(record.origin)).toEqual(record);
    expect(older.getPermission(THIRD_SITE)).toMatchObject({ origin: THIRD_SITE, walletIndex: 2, chainId: 100 });
    // A grant revoked in the new build stays revoked.
    expect(older.getPermission(OTHER_SITE)).toBeNull();
    // The text is today's: JSON.stringify(…, null, 2).
    const text = fs.readFileSync(file(), 'utf8');
    expect(JSON.stringify(JSON.parse(text), null, 2)).toBe(text);
    // Main's copy is the core's.
    await until(() => permissions.getPermission(OTHER_SITE) === null);
    expect(permissions.getAllPermissions().map((record) => record.origin).sort()).toEqual(records.map((r) => r.origin).sort());
  });

  test("an account change for a key the core holds no grant for: the core writes nothing, and main's change rejects", async () => {
    const fourth = 'https://fourth.example';
    const page = { ...PAGE, origin: fourth, top_origin: fourth };
    const before = fs.readFileSync(file(), 'utf8');
    await expect(permissions.updateWalletIndex(fourth, 1, page)).rejects.toThrow('The account change was not recorded');
    expect(calls.filter((call) => call.method === 'approval.grant').at(-1)).toMatchObject({
      params: { store: 'dapp', change: { op: 'account', account: 1 } },
      context: { caller: 'page', page },
    });
    expect((await coreRecords()).map((record) => record.origin)).not.toContain(fourth);
    expect(permissions.getPermission(fourth)).toBeNull();
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  });

  test("an account deleted: the core revokes its grants (main's own), and the reference sees none", async () => {
    const revoked = await permissions.revokePermissionsForWalletIndex(0);
    expect(revoked).toEqual([SITE]);
    expect(calls.find((call) => call.method === 'approval.forget_account')).toMatchObject({
      context: { caller: 'shell' },
      params: { wallet_index: 0 },
    });
    expect(permissions.getPermission(SITE)).toBeNull();
    expect(readReference().getPermission(SITE)).toBeNull();
    expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
  });
});
