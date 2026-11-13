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

// The core's write methods for the four permission files: main calls none
// before each file's move (APB-2, APB-3, X402-2).
const WRITE_METHODS = ['approval.grant', 'approval.revoke', 'approval.touch', 'approval.forget_account'];

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
      calls.push({ method, context, params });
      return request(method, params, context, options);
    };
    jest.resetModules();
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../identity-manager', () => ({
      getWalletRecord: (index) =>
        index === SAFE_INDEX ? { index, type: 'safe', address: SAFE_ADDRESS, owners: [0], threshold: 1 } : null,
    }));
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
    // Main calls none of the files' write methods on the core.
    expect(calls.filter((call) => WRITE_METHODS.includes(call.method))).toEqual([]);
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
      await expect(sc.spendSafeConfirmation(confirmation)).resolves.toEqual({ bound: true });
      // The approval it gave is ended at once, until APB-1c carries it on.
      const spend = calls.find((call) => call.method === 'approval.spend');
      expect(spend.context).toEqual({ caller: 'shell' });
      expect(calls.some((call) => call.method === 'approval.end')).toBe(true);
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
      await expect(sc.spendSafeConfirmation(fresh)).resolves.toEqual({ bound: true });
      expect(calls.filter((call) => call.method === 'approval.spend').at(-1).context).toEqual({ caller: 'page', page: PAGE });
    });

    test('safe-message binds the Safe, the method and the params', async () => {
      const request = { method: 'personal_sign', params: ['0x68', SAFE_ADDRESS] };
      const confirmation = await pageToken('safe-message', SAFE_INDEX, request);
      expect(confirmation.payload).toEqual({ safe: SAFE_ADDRESS, chain_id: '100', ...request });
      await expect(sc.spendSafeConfirmation(confirmation)).resolves.toEqual({ bound: true });
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
      expect(await reasonOf(present(0, 8))).toBe('mismatch');
      expect(await reasonOf(present(1, 7))).toBe('mismatch');
      expect(await reasonOf(present(0, 7, 'intent-0002'))).toBe('mismatch');
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
        params: { authorization: { token: confirmation.token, handle: HANDLE } },
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
});
