/**
 * Approval tokens through the real freedom-cored (freedom-core design 0012,
 * APB-1): signing-confirmation.test.js's cases for the core's kinds, against
 * the pinned binary. Main mints every kind but x402's with `approval.issue`
 * (a wallet kind as `shell`, a page kind under `page` with its PageContext
 * and handle), a signature the core makes presents its token to `sign.*`,
 * and the kinds that sign nothing here spend theirs with `approval.spend`.
 * A spy on the core's requests checks the caller of each, and that main
 * calls none of the permission files' write methods. A page request the
 * Agent answers in a tab it holds (APB-1d) goes through main's own page
 * dispatcher, the agent route and main's issuer to the core, under `page`
 * with `agent: true`, and never as `shell`. Skipped unless
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
// A Ledger's and a phone's accounts. A phone's backend is a test's fake
// (`devices.phone`); a Ledger's is main's real backend and transport, over
// a fake HID device (`devices.ledger`: its open, its address and its
// signing APDUs), so its device queue, open and address check run as they
// do in the app.
const LEDGER_INDEX = 1000000;
const PHONE_INDEX = 1000001;
const DEVICE_ADDRESS = new Wallet(ABANDON_KEY).address;
const DEVICE_RECORDS = Object.freeze({
  [LEDGER_INDEX]: { index: LEDGER_INDEX, type: 'ledger', address: DEVICE_ADDRESS, path: "44'/60'/0'/0/0" },
  [PHONE_INDEX]: { index: PHONE_INDEX, type: 'remote', address: DEVICE_ADDRESS },
});
const devices = { ledger: {}, phone: {} };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
      const reply = request(method, params, context, options);
      calls.push({ method, context, params, reply });
      return reply;
    };
    jest.resetModules();
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../identity-manager', () => ({
      getWalletRecord: (index) =>
        index === SAFE_INDEX
          ? { index, type: 'safe', address: SAFE_ADDRESS, owners: [0], threshold: 1 }
          : DEVICE_RECORDS[index] ?? null,
      isHardwareWalletIndex: () => false,
      recordLedgerAddressCheck: () => {},
      recordRemoteAddressCheck: () => {},
      WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
    }));
    // Main's own signers (`signers.js`): the vault's through the core, a
    // device's through a test's fake device, asked after the core's spend.
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    jest.doMock('@ledgerhq/hw-transport-node-hid', () => ({ default: { open: (...args) => devices.ledger.open(...args) } }));
    jest.doMock('@ledgerhq/hw-app-eth', () => ({
      default: class FakeEth {
        getAddress(...args) {
          return devices.ledger.getAddress(...args);
        }
        signPersonalMessage(...args) {
          return devices.ledger.signPersonalMessage(...args);
        }
        signEIP712Message(...args) {
          return devices.ledger.signEIP712Message(...args);
        }
        signTransaction(...args) {
          return devices.ledger.signTransaction(...args);
        }
      },
    }));
    jest.doMock('./remote/signer', () => ({ createRemoteBackend: () => devices.phone }));
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

  describe("a site's standing rule: today's rule main writes, read and judged by the core (APB-1b)", () => {
    const SELECTOR = TX.data.slice(0, 10);
    const MESSAGE_SIGNER = new Wallet(ABANDON_KEY).address;
    let permissions;
    let getSigner;

    beforeAll(() => {
      permissions = require('./dapp-permissions');
      ({ getSigner } = require('./signers'));
    });

    afterEach(() => {
      for (const site of [SITE, OTHER_SITE]) permissions.revokePermission(site);
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

    test('a signature the signing rule answers: chosen by the core, and signed under `page` with `{ standing }`', async () => {
      permissions.grantPermission(SITE, 0, 100);
      permissions.setSigningAutoApprove(SITE, true);
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

    test('no rule answers another site, another account, a tab in custody, a flag turned off, or no grant', async () => {
      permissions.grantPermission(SITE, 0, 100);
      permissions.setSigningAutoApprove(SITE, true);
      const message = { kind: 'message', payload: 'hello' };
      expect(await check(message, { ...PAGE, origin: OTHER_SITE, top_origin: OTHER_SITE })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await check({ ...message, account: 1 })).toEqual({ covered: false, reason: 'no_rule' });
      expect(await check(message, { ...PAGE, agent: true })).toEqual({ covered: false, reason: 'custody' });
      expect(await notConfirmed(ruled({ ...PAGE, agent: true }).signMessage('hello'))).toBe('custody');
      expect(await notConfirmed(ruled({ ...PAGE, origin: OTHER_SITE }).signMessage('hello'))).toBe('no_rule');
      // Turned off, or revoked, in main's file: the core's next check reads it.
      permissions.setSigningAutoApprove(SITE, false);
      expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
      expect(await notConfirmed(ruled(PAGE).signMessage('hello'))).toBe('no_rule');
      permissions.setSigningAutoApprove(SITE, true);
      permissions.revokePermission(SITE);
      expect(await check(message)).toEqual({ covered: false, reason: 'no_rule' });
      // A request the core can't judge reads as not covered, unasked.
      calls.length = 0;
      expect(await sc.checkStanding(PAGE, { kind: 'message', account: 0, accountType: 'hardware', payload: 'hello' })).toEqual({
        covered: false,
        reason: 'invalid',
      });
      expect(calls).toEqual([]);
    });

    test("a send the contract rule answers: the core reads the rule main wrote, with main's pause, its value cap and its own fee check", async () => {
      permissions.grantPermission(SITE, 0, 100);
      permissions.addTransactionAutoApprove(SITE, TX.to, SELECTOR, 100, TX.value);
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
      permissions.revokePermission(SITE);
      expect(await notConfirmed(signer.signTransaction(built))).toBe('no_rule');
    });

    test('"Always allow": the flagged send signs, the core writes no rule and says `not_moved`, and the file stays main\'s', async () => {
      permissions.grantPermission(SITE, 0, 100);
      const file = path.join(root, 'dapp-permissions.json');
      const before = fs.readFileSync(file);
      const built = buildTransaction({ ...SEND, nonce: 7 });
      const confirmation = await pageToken('dapp-send', 0, DAPP_TX, PAGE, HANDLE, { remember: true });
      expect(calls.find((call) => call.method === 'approval.issue').params.payload).toEqual({ tx: expect.any(Object), remember: true });
      const heard = [];
      const raw = await getSigner(0, { confirmation, onRule: (rule) => heard.push(rule) }).signTransaction(built);
      expect(Transaction.from(raw).from).toBe(MESSAGE_SIGNER);
      expect(heard).toEqual([{ added: false, reason: 'not_moved' }]);
      expect(sc.mainWritesRule(true, heard[0])).toBe(true);
      // The core changed nothing in main's file.
      expect(fs.readFileSync(file)).toEqual(before);
      // Not ticked: no flag, and no rule in the reply.
      const plain = await pageToken('dapp-send', 0, DAPP_TX);
      expect(calls.filter((call) => call.method === 'approval.issue').at(-1).params.payload).toEqual({ tx: expect.any(Object) });
      await getSigner(0, { confirmation: plain, onRule: (rule) => heard.push(rule) }).signTransaction(built);
      expect(heard).toEqual([{ added: false, reason: 'not_moved' }, null]);
      expect(sc.mainWritesRule(true, null)).toBe(false);
      expect(fs.readFileSync(file)).toEqual(before);
    });
  });

  // Design 0012 (as amended by freedom-core #368), "A page request the Agent
  // answers": in a tab the Agent holds, its decision mints the request's
  // page-kind token through main's issuer, under `page` with the request's
  // PageContext (`agent: true`) and a handle main drew, and the signature
  // presents it under `page` with the live PageContext. No standing rule
  // answers it, and none goes as `shell`. Driven end to end: the page's
  // request through main's page dispatcher (`page-requests.js`,
  // `page-ethereum.js`), the real AgentWalletController with main's signers,
  // and the core.
  describe('a page request the Agent answers, in a tab it holds (APB-1d)', () => {
    const { EventEmitter } = require('events');
    const CHROME_URL = 'file:///app/src/renderer/index.html';
    const SIGNER = new Wallet(ABANDON_KEY).address;
    let permissions;
    let requests;
    let guests;
    let custody;
    let approvals;
    let answerWith;
    let nextId = 1;
    let nextNonce = 1;
    // The agent route's runs, which outlive a request main answered (its
    // document gone): a test waits for them before it checks what was signed.
    let running;
    // The transaction service's own waits before it asks the signer (the
    // fee, the nonce), held when a test sets one; and what each device was
    // asked.
    let serviceWait;
    let deviceAsked;
    // DNS names over IPNS the page documents resolve: name -> IPNS key.
    const names = new Map();

    class Guest extends EventEmitter {
      constructor() {
        super();
        this.id = nextId++;
        this.hostWebContents = { id: 501, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
        this.mainFrame = this.frame('about:blank');
      }

      frame(url) {
        return { url, frameTreeNodeId: 1000 + this.id, processId: 1, routingId: this.id, detached: false, send: () => {} };
      }

      isDestroyed() {
        return false;
      }

      getType() {
        return 'webview';
      }

      getURL() {
        return this.mainFrame.url;
      }

      commit(url) {
        this.mainFrame.detached = true;
        this.mainFrame = this.frame(url);
        this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
      }
    }

    beforeAll(() => {
      permissions = require('./dapp-permissions');
      const { getSigner } = require('./signers');
      const { createPageDocuments } = require('../page/page-documents');
      const { createPageRequests } = require('../page/page-requests');
      const { createEthereumDispatchers } = require('../page/page-ethereum');
      const { AgentWalletController } = require('../agent/agent-wallet-controller');
      guests = new Map();
      custody = new Set();
      const wallets = async () => [
        { index: 0, name: 'Main Wallet', address: SIGNER, type: 'mnemonic' },
        { index: LEDGER_INDEX, name: 'My Ledger', address: DEVICE_ADDRESS, type: 'ledger' },
        { index: PHONE_INDEX, name: 'My Phone', address: DEVICE_ADDRESS, type: 'remote' },
      ];
      // The Agent's own approval, as the agent service asks it: the test
      // answers each, and sees what it was asked.
      const controller = new AgentWalletController({
        identityManager: { getDerivedWallets: wallets, getActiveWalletIndex: () => 0 },
        getPermission: (key) => permissions.getPermission(key),
        grantPermission: () => {},
        updateLastUsed: () => {},
        updateWalletIndex: () => {},
        getChain: (chainId) => ({ chainId, name: 'Gnosis', nativeCurrency: { symbol: 'xDAI', decimals: 18 } }),
        estimateGas: async () => ({ gasLimit: TX.gasLimit }),
        getGasPrices: async () => ({ type: 'eip1559', maxFeePerGas: TX.maxFeePerGas, maxPriorityFeePerGas: TX.maxPriorityFeePerGas }),
        // Main's own signers: a vault account's signature by the core.
        getSigner,
        // As the transaction service runs it: the account's address, its
        // own waits (held when a test sets `serviceWait`), then signed at
        // the nonce main chose and committed past the caller's guard; a
        // phone signs and broadcasts in one step.
        signAndRecord: async (tx, signer, _record, options) => {
          await signer.getAddress();
          if (serviceWait) {
            serviceWait.reached.resolve();
            await serviceWait.promise;
          }
          if (typeof signer.sendTransaction === 'function') {
            return { hash: await signer.sendTransaction(buildTransaction({ ...tx, nonce: 7 })) };
          }
          const raw = await signer.signTransaction(buildTransaction({ ...tx, nonce: 7 }));
          let committed = null;
          await options.guardCommit(async () => {
            committed = raw;
          });
          return { hash: Transaction.from(committed).hash };
        },
      });
      const documents = createPageDocuments({
        isPrivateWebContents: () => false,
        isChromeIndexUrl: (url) => url === CHROME_URL,
        isAgentPage: () => false,
        windowIdOf: () => 1,
        resolveEnsContent: async (name) =>
          names.has(name) ? { type: 'ok', protocol: 'ipns', decoded: names.get(name) } : { type: 'not_found' },
      });
      const inCustody = (guestId) => custody.has(guestId);
      requests = createPageRequests({
        documents,
        webContentsFromId: (id) => guests.get(id),
        dispatchers: createEthereumDispatchers({
          identityWalletEnabled: () => true,
          selectedChainOf: () => 100,
          getPermission: (key) => permissions.getPermission(key),
          getDerivedWallets: wallets,
          chainName: () => 'Gnosis',
          networks: () => ({ 100: { name: 'Gnosis' } }),
          getActiveWalletIndex: () => 0,
          updateLastUsed: () => {},
          agentWalletRequest: (guestId, request, options) =>
            track(controller.handleRequest(
              {
                tabId: `tab_${guestId}`,
                pageUrl: guests.get(guestId).getURL(),
                conversationId: 'conversation_1',
                requestApproval: async (asked) => {
                  approvals.push(asked);
                  return answerWith;
                },
                attested: options.attested,
                beforeEffect: options.beforeEffect,
                effectAllowed: options.effectAllowed,
                pageToken: options.pageToken,
              },
              request
            )),
          // Main's own signing path for a tab the Agent doesn't hold (a
          // site's standing rule, APB-1b): the real signers and the core's
          // `approval.check`; the message's view made here, without the IPC
          // module.
          signing: {
            inCustody,
            isVaultUnlocked: async () => true,
            messageView: (message) => {
              const { messageToBytes, normalizeMessage, signsRawHash } = require('./signing-utils');
              return { hex: '0x' + messageToBytes(normalizeMessage(message)).toString('hex'), rawHash: signsRawHash(message) };
            },
          },
          sends: { inCustody },
        }),
        chromeWindowOf: (contents) => (contents?.id === 501 ? 1 : null),
        sendToWindow: () => {},
        watchWindow: () => {},
        // A PageContext's `agent`: the custody the dispatchers read.
        isAgentGuest: inCustody,
      });
    });

    // A run of the agent route, kept until it settles.
    function track(run) {
      running.push(run);
      return run;
    }

    // A fake device, as main's signers ask one (`signers.js`): after the
    // core's hash and spend, and the caller's last check. What it is asked
    // is recorded; it signs with the test key.
    function device(name) {
      const key = new Wallet(ABANDON_KEY);
      const asked = (method) => deviceAsked.push([name, method]);
      if (name === 'ledger') {
        // The HID device under main's Ledger backend: what hw-app-eth asks.
        const answer = async (signature) => {
          const sig = require('ethers').Signature.from(await signature);
          return { r: sig.r.slice(2), s: sig.s.slice(2), v: sig.v };
        };
        return {
          open: async () => ({ close: async () => {} }),
          getAddress: async () => ({ address: DEVICE_ADDRESS }),
          signPersonalMessage: async (_path, hex) => {
            asked('signMessage');
            return answer(key.signMessage(Buffer.from(hex, 'hex')));
          },
          signEIP712Message: async (_path, payload) => {
            asked('signTypedData');
            const { EIP712Domain: _domain, ...types } = payload.types;
            return answer(key.signTypedData(payload.domain, types, payload.message));
          },
          signTransaction: async (_path, rawHex) => {
            asked('signTransaction');
            const signed = Transaction.from(await key.signTransaction(Transaction.from('0x' + rawHex)));
            return answer(signed.signature.serialized);
          },
        };
      }
      return {
        getAddress: async () => DEVICE_ADDRESS,
        signMessage: async (message) => {
          asked('signMessage');
          return key.signMessage(message);
        },
        signTypedData: async (_data, { digest }) => {
          asked('signTypedData');
          return key.signingKey.sign(digest).serialized;
        },
        signTransaction: async (tx) => {
          asked('signTransaction');
          return key.signTransaction(tx);
        },
        ...(name === 'phone'
          ? {
              sendTransaction: async () => {
                asked('sendTransaction');
                return '0x' + 'ab'.repeat(32);
              },
            }
          : {}),
      };
    }

    beforeEach(() => {
      approvals = [];
      answerWith = 'approved';
      running = [];
      serviceWait = null;
      deviceAsked = [];
      devices.ledger = device('ledger');
      devices.phone = device('phone');
      permissions.grantPermission(SITE, 0, 100);
    });

    afterEach(() => {
      permissions.revokePermission(SITE);
      // No signature for an attested page request goes as main's own: each
      // is under `page`, in the Agent's tab, with a token.
      const signs = calls.filter((call) => call.method.startsWith('sign.'));
      for (const call of signs) {
        expect(call.context).toEqual({ caller: 'page', page: expect.objectContaining({ origin: expect.stringMatching(/^(https:\/\/app\.example|example\.com)$/), agent: true }) });
        expect(call.params.authorization).toEqual(expect.objectContaining({ token: expect.stringMatching(/^[0-9a-f]{64}$/) }));
        expect(call.params.authorization).not.toHaveProperty('standing');
      }
    });

    // A page in a tab the Agent holds (or, `held: false`, one it doesn't),
    // and its requests; `name`: a DNS name over IPNS bound to the tab, at
    // its IPNS key.
    function agentTab({ held = true, name = null } = {}) {
      const guest = new Guest();
      guests.set(guest.id, guest);
      requests.track(guest);
      if (name) {
        expect(requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name, key: names.get(name) })).toBe(true);
        guest.commit(`ipns://${names.get(name)}/`);
      } else {
        guest.commit(`${SITE}/app`);
      }
      const nonce = (nextNonce++).toString(16).padStart(32, '0');
      const event = { sender: guest, senderFrame: guest.mainFrame };
      expect(requests.hello(event, { nonce }).ok).toBe(true);
      if (held) custody.add(guest.id);
      const origin = name || SITE;
      const page = {
        origin,
        top_origin: origin,
        frame: guest.mainFrame.frameTreeNodeId,
        navigation: expect.any(Number),
        agent: held,
      };
      return {
        guest,
        page,
        ask: (method, params) => requests.request(event, { nonce, provider: 'ethereum', method, params }),
      };
    }

    // The core's calls for one request: the Agent's token minted under
    // `page` with `agent: true` and main's handle, then presented under
    // `page` with `agent: true` by the one signature.
    function minted(kind, page, index = 0) {
      const issued = calls.filter((call) => call.method === 'approval.issue');
      expect(issued).toEqual([
        expect.objectContaining({
          context: { caller: 'page', page },
          params: expect.objectContaining({ kind, account: index, handle: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        }),
      ]);
      return issued[0].params.handle;
    }

    test('personal_sign: minted as a sign-message token under `page` with agent: true, and signed under it', async () => {
      const tab = agentTab();
      const answer = await tab.ask('personal_sign', ['0x68656c6c6f', SIGNER]);
      expect(require('ethers').verifyMessage('hello', answer.result)).toBe(SIGNER);
      expect(approvals).toEqual([expect.objectContaining({ action: 'wallet_signature' })]);
      const handle = minted('sign-message', tab.page);
      const signs = calls.filter((call) => call.method.startsWith('sign.'));
      expect(signs).toEqual([
        expect.objectContaining({
          method: 'sign.message',
          context: { caller: 'page', page: tab.page },
          params: expect.objectContaining({ authorization: { token: expect.any(String), handle } }),
        }),
      ]);
      // Spent there: presented again, the core no longer knows it.
      const token = signs[0].params.authorization.token;
      expect(
        await reasonOf(vaultBackend.sign.message(account(0), Buffer.from('hello'), { authorization: { token, handle }, page: signs[0].context.page }))
      ).toBe('unknown_token');
    });

    test('eth_signTypedData_v4: a sign-typed-data token viewed on the page\'s chain, its hash the one signed', async () => {
      const tab = agentTab();
      const answer = await tab.ask('eth_signTypedData_v4', [SIGNER, JSON.stringify(TYPED_DATA)]);
      const { domain, types, message } = TYPED_DATA;
      expect(require('ethers').verifyTypedData(domain, types, message, answer.result)).toBe(SIGNER);
      const handle = minted('sign-typed-data', tab.page);
      expect(calls.find((call) => call.method === 'approval.issue').params.payload).toMatchObject({
        primary_type: 'Permit',
        chain_id: '100',
      });
      expect(calls.filter((call) => call.method.startsWith('sign.'))).toEqual([
        expect.objectContaining({
          method: 'sign.typed_data',
          context: { caller: 'page', page: tab.page },
          params: expect.objectContaining({
            expected_hash: TypedDataEncoder.hash(domain, types, message),
            authorization: { token: expect.any(String), handle },
          }),
        }),
      ]);
    });

    test('eth_sendTransaction: a dapp-send token under `page` with agent: true, presented naming its kind', async () => {
      const tab = agentTab();
      const answer = await tab.ask('eth_sendTransaction', [{ to: TX.to, value: '0x' + BigInt(TX.value).toString(16), data: TX.data }]);
      expect(answer.result).toMatch(/^0x[0-9a-f]{64}$/);
      expect(approvals).toEqual([expect.objectContaining({ action: 'wallet_transaction' })]);
      const handle = minted('dapp-send', tab.page);
      // The Agent ticks no "Always allow" and confirms no fee again.
      const issue = calls.find((call) => call.method === 'approval.issue');
      expect(issue.params.payload).not.toHaveProperty('remember');
      expect(issue.params).not.toHaveProperty('fee_ack');
      const signs = calls.filter((call) => call.method.startsWith('sign.'));
      expect(signs).toEqual([
        expect.objectContaining({
          method: 'sign.transaction',
          context: { caller: 'page', page: tab.page },
          params: expect.objectContaining({ authorization: { token: expect.any(String), kind: 'dapp-send', handle } }),
        }),
      ]);
      expect(Transaction.from(await signs[0].reply.then((reply) => reply.raw)).from).toBe(SIGNER);
      // No rule was asked for, so none is reported.
      expect((await signs[0].reply).rule ?? null).toBeNull();
    });

    test("a standing rule never answers it: the Agent decides, and the core refuses `{ standing }` in its tab (custody)", async () => {
      permissions.setSigningAutoApprove(SITE, true);
      permissions.addTransactionAutoApprove(SITE, TX.to, TX.data.slice(0, 10), 100, TX.value);
      const tab = agentTab();
      const answer = await tab.ask('personal_sign', ['0x68656c6c6f', SIGNER]);
      expect(require('ethers').verifyMessage('hello', answer.result)).toBe(SIGNER);
      // The Agent was asked; main asked the core for no rule's verdict.
      expect(approvals).toHaveLength(1);
      expect(calls.filter((call) => call.method === 'approval.check')).toEqual([]);
      minted('sign-message', tab.page);
      // Under the PageContext main sent for the Agent's request, the core
      // answers no rule: custody.
      const page = calls.find((call) => call.method === 'sign.message').context.page;
      expect(await sc.checkStanding(page, { kind: 'message', account: 0, accountType: 'mnemonic', payload: 'hello' })).toEqual({
        covered: false,
        reason: 'custody',
      });
      const ruled = require('./signers').getSigner(0, { page, standing: {}, chainId: 100 });
      const refused = await refusal(ruled.signMessage('hello'));
      expect(refused.reason).toBe('custody');
      calls.length = 0;
    });

    test('the Agent declining mints nothing and signs nothing', async () => {
      const tab = agentTab();
      answerWith = 'declined';
      expect(await tab.ask('personal_sign', ['0x68656c6c6f', SIGNER])).toEqual({
        error: { code: 4001, message: 'User rejected the request' },
      });
      expect(approvals).toHaveLength(1);
      expect(calls.filter((call) => call.method === 'approval.issue' || call.method.startsWith('sign.'))).toEqual([]);
    });

    // Codex on #1246: custody ends at the signer's own wait (the vault's
    // address), after main presented the token as the signer was built.
    test('a tab the Agent leaves at the signer\'s wait, after the token was presented: refused, the token burnt, nothing signed', async () => {
      const tab = agentTab();
      const request = core.request;
      let presented = null;
      core.request = (method, params, context, options) => {
        const reply = request(method, params, context, options);
        if (method === 'keys.addresses') {
          // The signer waits on its address: built, the token presented.
          presented = calls.some((call) => call.method === 'approval.issue');
          reply.then(() => custody.delete(tab.guest.id), () => {});
        }
        return reply;
      };
      let answer;
      try {
        answer = await tab.ask('personal_sign', ['0x68656c6c6f', SIGNER]);
      } finally {
        core.request = request;
      }
      expect(presented).toBe(true);
      expect(answer).toEqual({
        error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' },
      });
      const handle = minted('sign-message', tab.page);
      expect(calls.filter((call) => call.method.startsWith('sign.'))).toEqual([]);
      const issued = await calls.find((call) => call.method === 'approval.issue').reply;
      expect(calls.filter((call) => call.method === 'approval.discard').map((call) => call.params.token)).toContain(issued.token);
      // Burnt: the core no longer knows it.
      expect(
        await reasonOf(
          vaultBackend.sign.message(account(0), Buffer.from('hello'), {
            authorization: { token: issued.token, handle },
            page: { ...PAGE, origin: SITE, top_origin: SITE },
          })
        )
      ).toBe('unknown_token');
      calls.length = 0;
    });

    // Codex on #1246: main presents the Agent's token as the signer is
    // built, and the core spends it under the PageContext read then; the
    // signer waits after that (a vault's address, a device's hash and the
    // core's spend, the transaction service's fee and nonce). Its last step
    // reads the tab and the document again, right before the core or the
    // device is asked: a tab the Agent left, or a document gone, at any of
    // those waits signs nothing, sends nothing, and leaves no live token.
    const ASKS = {
      personal_sign: (account) => ['personal_sign', ['0x68656c6c6f', account]],
      eth_signTypedData_v4: (account) => ['eth_signTypedData_v4', [account, JSON.stringify(TYPED_DATA)]],
      eth_sendTransaction: () => ['eth_sendTransaction', [{ to: TX.to, value: '0x' + BigInt(TX.value).toString(16), data: TX.data }]],
    };
    const KINDS = { personal_sign: 'sign-message', eth_signTypedData_v4: 'sign-typed-data', eth_sendTransaction: 'dapp-send' };
    const ACCOUNTS = { vault: [0, SIGNER], ledger: [LEDGER_INDEX, DEVICE_ADDRESS], phone: [PHONE_INDEX, DEVICE_ADDRESS] };

    // Holds the core's next reply to `method` until released.
    function holdCore(method) {
      const request = core.request;
      const reached = deferred();
      const released = deferred();
      core.request = (name, params, context, options) => {
        const reply = request(name, params, context, options);
        if (name !== method) return reply;
        core.request = request;
        const held = async (settle) => {
          reached.resolve();
          await released.promise;
          return settle();
        };
        return reply.then(
          (value) => held(() => value),
          (err) => held(() => Promise.reject(err))
        );
      };
      return { reached: reached.promise, release: released.resolve, restore: () => (core.request = request) };
    }

    // Holds the transaction service's own wait before it asks the signer.
    function holdService() {
      const wait = { ...deferred(), reached: deferred() };
      serviceWait = wait;
      return { reached: wait.reached.promise, release: wait.resolve, restore: () => (serviceWait = null) };
    }

    describe.each([
      ['a vault message, at its address', 'vault', 'personal_sign', 'keys.addresses'],
      ['vault typed data, at its address', 'vault', 'eth_signTypedData_v4', 'keys.addresses'],
      ["a vault send, at the transaction service's wait", 'vault', 'eth_sendTransaction', 'service'],
      ["a Ledger message, at the core's spend", 'ledger', 'personal_sign', 'approval.spend'],
      ["Ledger typed data, at the core's hash", 'ledger', 'eth_signTypedData_v4', 'typed_data.hash'],
      ["Ledger typed data, at the core's spend", 'ledger', 'eth_signTypedData_v4', 'approval.spend'],
      ["a Ledger send, at the transaction service's wait", 'ledger', 'eth_sendTransaction', 'service'],
      ["a Ledger send, at the core's spend", 'ledger', 'eth_sendTransaction', 'approval.spend'],
      ["a phone message, at the core's spend", 'phone', 'personal_sign', 'approval.spend'],
      ["phone typed data, at the core's spend", 'phone', 'eth_signTypedData_v4', 'approval.spend'],
      ["a phone send, at the transaction service's wait", 'phone', 'eth_sendTransaction', 'service'],
      ["a phone send, at the core's spend", 'phone', 'eth_sendTransaction', 'approval.spend'],
    ])('%s', (_label, held, method, holdAt) => {
      const [index, address] = ACCOUNTS[held];

      test.each([
        ['the Agent leaves the tab', (tab) => custody.delete(tab.guest.id), { error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } }],
        ['the document navigates', (tab) => tab.guest.commit(`${SITE}/next`), { gone: true }],
        ['nothing changes', () => {}, null],
      ])('%s there: the signer\'s last step decides', async (_change, change, refused) => {
        permissions.grantPermission(SITE, index, 100);
        const tab = agentTab();
        const hold = holdAt === 'service' ? holdService() : holdCore(holdAt);
        let answer;
        try {
          const asking = tab.ask(...ASKS[method](address));
          await hold.reached;
          // Minted and presented: the signer was built, and waits.
          const handle = minted(KINDS[method], tab.page, index);
          change(tab);
          hold.release();
          answer = await asking;
          await Promise.allSettled(running);
          const issued = await calls.find((call) => call.method === 'approval.issue').reply;
          const signs = calls.filter((call) => call.method.startsWith('sign.'));
          if (refused) {
            expect(answer).toEqual(refused);
            // Neither the core nor the device was asked.
            expect(signs).toEqual([]);
            expect(deviceAsked).toEqual([]);
            // No live token: spent by a device's signer before its last
            // step, or burnt unspent.
            const page = calls.find((call) => call.method === 'approval.issue').context.page;
            expect(
              await reasonOf(
                vaultBackend.sign.message(account(0), Buffer.from('hello'), {
                  authorization: { token: issued.token, handle },
                  page,
                })
              )
            ).toBe('unknown_token');
            calls.length = 0;
          } else {
            expect(answer).toEqual({ result: expect.stringMatching(/^0x[0-9a-f]+$/) });
            if (held === 'vault') {
              expect(signs).toHaveLength(1);
              expect(deviceAsked).toEqual([]);
            } else {
              expect(signs).toEqual([]);
              expect(deviceAsked).toHaveLength(1);
              expect(calls.filter((call) => call.method === 'approval.spend')).toHaveLength(1);
            }
          }
        } finally {
          hold.restore();
        }
      });
    });

    // Codex round 2 on #1246: a Ledger's backend waits again after the
    // signer's own steps (its device queue, the transport's open, the
    // device's address check), so the caller's last check runs inside that
    // session, right before the signing APDU. Main's real Ledger backend
    // and transport here, over a fake HID device.
    describe("a Ledger's device session: the last check after its queue, its open and its address", () => {
      const NAME = 'example.com';
      const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
      const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
      const tick = async () => {
        for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
      };
      // The step held, and how to tell the request has reached it: the
      // device queue held by another device task (the request queued once
      // its token's spend, or the core's verdict, has settled), the
      // transport's open, or the device's address check.
      const HOLDS = {
        'the device queue': (settled) => {
          const gate = deferred();
          const blocker = require('./ledger/transport').withEthApp(() => gate.promise);
          return { reached: settled().then(tick), release: gate.resolve, done: blocker };
        },
        "the transport's open": () => {
          const gate = deferred();
          const reached = deferred();
          const open = devices.ledger.open;
          devices.ledger.open = async (...args) => {
            reached.resolve();
            await gate.promise;
            return open(...args);
          };
          return { reached: reached.promise, release: gate.resolve, done: Promise.resolve() };
        },
        "the device's address check": () => {
          const gate = deferred();
          const reached = deferred();
          const getAddress = devices.ledger.getAddress;
          devices.ledger.getAddress = async (...args) => {
            reached.resolve();
            await gate.promise;
            return getAddress(...args);
          };
          return { reached: reached.promise, release: gate.resolve, done: Promise.resolve() };
        },
      };
      // Polled by the clock, not by turns: the core's replies take their
      // own time, more under load.
      const until = async (found, ms = 10000) => {
        const deadline = Date.now() + ms;
        while (!found() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        if (!found()) throw new Error('the request never reached the held step');
        return found();
      };
      // The `nth` call of `method` settled: the last wait before the signer.
      const settledCall = (method, nth = 1) => async () => {
        const call = await until(() => calls.filter((entry) => entry.method === method)[nth - 1]);
        await call.reply.catch(() => {});
      };

      let ledgerHolds = [];
      beforeEach(() => {
        names.set(NAME, IPNS_KEY);
        ledgerHolds = [];
      });

      afterEach(async () => {
        for (const hold of ledgerHolds) hold.release();
        await Promise.allSettled([...ledgerHolds.map((hold) => hold.done), ...running]);
        names.clear();
        permissions.revokePermission(NAME);
      });

      describe.each(Object.keys(HOLDS))('%s held', (held) => {
        test.each([
          ['personal_sign', 'signMessage'],
          ['eth_signTypedData_v4', 'signTypedData'],
          ['eth_sendTransaction', 'signTransaction'],
        ])("the Agent's %s: the tab left, the document gone or the name moved there sends no signing APDU; unchanged, one", async (method, apdu) => {
          for (const [change, act, refused] of [
            ['the Agent leaves the tab', (tab) => custody.delete(tab.guest.id), { error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } }],
            ['the document navigates', (tab) => tab.guest.commit(`ipns://${IPNS_KEY}/next`), { gone: true }],
            ['the name moves', () => names.set(NAME, OTHER_IPNS_KEY), { error: { code: 4100, message: 'This page has no address to connect from yet' } }],
            ['nothing changes', () => {}, null],
          ]) {
            calls.length = 0;
            deviceAsked = [];
            running = [];
            names.set(NAME, IPNS_KEY);
            permissions.grantPermission(NAME, LEDGER_INDEX, 100);
            const tab = agentTab({ name: NAME });
            const hold = HOLDS[held](settledCall('approval.spend'));
            const asking = tab.ask(...ASKS[method](DEVICE_ADDRESS));
            // A failure never leaves the device queue held for the next.
            ledgerHolds.push(hold);
            await hold.reached;
            // Past the token's spend, in the device session: no APDU yet.
            expect({ change, spent: calls.filter((call) => call.method === 'approval.spend').length, asked: deviceAsked }).toEqual({ change, spent: 1, asked: [] });
            act(tab);
            hold.release();
            await hold.done;
            const answer = await asking;
            await Promise.allSettled(running);
            if (refused) {
              expect({ change, answer }).toEqual({ change, answer: refused });
              expect({ change, asked: deviceAsked }).toEqual({ change, asked: [] });
            } else {
              expect({ change, answer }).toEqual({ change, answer: { result: expect.stringMatching(/^0x[0-9a-f]+$/) } });
              expect({ change, asked: deviceAsked }).toEqual({ change, asked: [['ledger', apdu]] });
            }
            expect(calls.filter((call) => call.method.startsWith('sign.'))).toEqual([]);
            // The device is free for the next.
            await expect(require('./ledger/transport').withEthApp(async () => 'free')).resolves.toBe('free');
          }
        });

        test("a site's signing rule on a Ledger (APB-1b): revoked there sends no signing APDU; unchanged, one", async () => {
          for (const revoke of [true, false]) {
            calls.length = 0;
            deviceAsked = [];
            permissions.grantPermission(SITE, LEDGER_INDEX, 100);
            permissions.setSigningAutoApprove(SITE, true);
            const tab = agentTab({ held: false });
            // The core's verdict for the choice, then again just before the
            // signer (APB-1b): the device session comes after the second.
            const hold = HOLDS[held](settledCall('approval.check', 2));
            const asking = tab.ask('personal_sign', ['0x68656c6c6f', DEVICE_ADDRESS]);
            ledgerHolds.push(hold);
            await hold.reached;
            // The rule answered (no prompt, no Agent), and the device session waits.
            expect({ revoke, approvals, asked: deviceAsked }).toEqual({ revoke, approvals: [], asked: [] });
            if (revoke) permissions.setSigningAutoApprove(SITE, false);
            hold.release();
            await hold.done;
            const answer = await asking;
            if (revoke) {
              expect(answer).toEqual({
                error: { code: -32603, message: "Signing was not confirmed: this request is not covered by the site's auto-approve rules" },
              });
              expect(deviceAsked).toEqual([]);
            } else {
              expect(require('ethers').verifyMessage('hello', answer.result)).toBe(DEVICE_ADDRESS);
              expect(deviceAsked).toEqual([['ledger', 'signMessage']]);
            }
            // The core's verdict: for the choice, just before the signer, and
            // inside the device session, last.
            expect(calls.filter((call) => call.method === 'approval.check')).toHaveLength(3);
            permissions.setSigningAutoApprove(SITE, false);
          }
        });
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
        permissions.grantPermission(SITE, SAFE_INDEX, 100);
        await expect(notConfirmed(sc.spendStandingSafeMessage(PAGE, SAFE_INDEX, request))).resolves.toBe('no_rule');
        permissions.setSigningAutoApprove(SITE, true);
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
        permissions.revokePermission(SITE);
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
