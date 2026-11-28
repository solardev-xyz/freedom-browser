/**
 * A Safe on forked Gnosis through the real freedom-cored (freedom-core
 * design 0016; the SAFE-3 plan's point 11 and PR 10): the canonical Safe
 * 1.4.1 contracts on an anvil fork of live Gnosis check what the core and
 * main sign, with main's own modules on the core's Safe and Ledger backends
 * (test/helpers/safe-core-world.js, as safe-core.integration.test.js runs
 * them over a stub).
 *
 * The owners are the vault's own accounts (the core's vault, imported from
 * a test phrase) and a Ledger, the reference's device (ledger.json's
 * `typed-safe-tx`) behind main's relay and HID layer over a fake node-hid,
 * signing the live SafeTx. Accounts are funded with `anvil_setBalance`.
 * Chain 100 has two endpoints, anvil and a forwarder in front of it
 * (test-e2e/rpc-forwarder.js), named as two providers through the
 * test-only seam FREEDOM_E2E_PROVIDER_IDENTITIES as the Safe E2E names
 * them, so the core's quorum agrees and its Safe reads are verified.
 *
 * - The record's address, computed by the core, is the one the real
 *   factory deploys at, and the deployment claims funds sent to it before
 *   it existed (research doc Part B, decision 5).
 * - A 2-of-3 SafeTx signed by the Ledger (through the device) and a vault
 *   owner, executed by the real Safe with the core's executor-send token,
 *   moves those funds.
 * - A page's `personal_sign` answered with the vault owners' signatures,
 *   which the real Safe's fallback handler accepts (`isValidSignature`,
 *   EIP-1271).
 *
 * Needs `anvil` (foundry) on PATH, the public fork RPC, freedom-cored
 * (FREEDOM_CORED_PATH, or `npm run core:download`'s) and the Ledger vectors
 * (test/helpers/ledger-vectors.js); skips otherwise, unless
 * FREEDOM_SAFE_FORK_REQUIRED=1 (CI's Safe E2E job), which makes a missing
 * one a failure, e.g.
 *   FREEDOM_SAFE_FORK_REQUIRED=1 FREEDOM_CORE_LEDGER_VECTORS=…/freedom-core/vectors \
 *     npx jest src/main/wallet/safe/__tests__/integration/safe-fork
 */

const ANVIL_PORT = 18845;
const FORWARDER_PORT = 18846;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const FORWARDER_URL = `http://127.0.0.1:${FORWARDER_PORT}`;
// Before main's modules load (networks/e2e-provider-identities.js reads it
// once): anvil and its forwarder, two providers to the core's quorum.
process.env.FREEDOM_E2E_PROVIDER_IDENTITIES = JSON.stringify({
  [ANVIL_URL]: 'fork-anvil',
  [FORWARDER_URL]: 'fork-anvil-forwarder',
});

const mockWorld = {};
require('../../../../../../test/helpers/safe-core-world').mockSafeCoreModules(mockWorld);

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { Interface, Wallet, getAddress, hashMessage, parseEther } = require('ethers');
const {
  LEDGER_INDEX,
  createPageRelay,
  pageHarness,
  startSafeCoreWorld,
  until,
} = require('../../../../../../test/helpers/safe-core-world');
const { FALLBACK_HANDLER, PROXY_FACTORY, SINGLETON } = require('../../../../../../test/helpers/safe-chain-stub');
const { ledgerVectors } = require('../../../../../../test/helpers/ledger-vectors');
const { deviceKey } = require('../../../../../../test/helpers/ledger-reference-device');
const { startRpcForwarder } = require('../../../../../../test-e2e/rpc-forwarder');

const FORK_URL = 'https://rpc.gnosischain.com';
// A phrase of this run's: the fork is live Gnosis, where the well-known
// test phrases' accounts have histories of their own.
const MNEMONIC = Wallet.createRandom().mnemonic.phrase;
const PASSWORD = 'Freedom-Safe-Fork-2026!';
const LEDGER_CASE = 'typed-safe-tx';
const SITE = `bzz://${'f0'.repeat(32)}`;
const MAGIC = '0x1626ba7e';
const SAFE_ABI = new Interface([
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function isValidSignature(bytes32 dataHash, bytes signature) view returns (bytes4)',
]);

function availability() {
  if (spawnSync('anvil', ['--version']).status !== 0) return 'anvil (foundry) is not on PATH';
  const probe = spawnSync('curl', [
    '-sf',
    '-m',
    '10',
    '-X',
    'POST',
    FORK_URL,
    '-H',
    'Content-Type: application/json',
    '-d',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
  ]);
  if (probe.status !== 0) return `the fork RPC ${FORK_URL} is unreachable`;
  const binary = process.env.FREEDOM_CORED_PATH || require('../../../../core/cored-binary').getCoredBinaryPath();
  if (!binary || !fs.existsSync(binary)) return 'no freedom-cored: set FREEDOM_CORED_PATH or run npm run core:download';
  if (!ledgerVectors('ledger.json')) return 'no Ledger vectors: set FREEDOM_CORE_LEDGER_VECTORS';
  return null;
}

const missing = availability();
if (missing && process.env.FREEDOM_SAFE_FORK_REQUIRED === '1') {
  throw new Error(`The Safe fork test is required but ${missing}`);
}
if (missing) console.warn(`[safe-fork.test] skipping: ${missing}`);
const describeFork = missing ? describe.skip : describe;

jest.setTimeout(300_000);

async function rpc(method, params = []) {
  const res = await fetch(ANVIL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(`${method}: ${error.message}`);
  return result;
}

const balanceOf = async (address) => BigInt(await rpc('eth_getBalance', [address, 'latest']));
const safeCall = async (address, name, args = []) =>
  SAFE_ABI.decodeFunctionResult(
    name,
    await rpc('eth_call', [{ to: address, data: SAFE_ABI.encodeFunctionData(name, args) }, 'latest'])
  );
const fund = (address, wei) => rpc('anvil_setBalance', [address, '0x' + BigInt(wei).toString(16)]);

async function startAnvil() {
  const proc = spawn('anvil', ['--fork-url', FORK_URL, '--port', String(ANVIL_PORT), '--silent']);
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
    try {
      if (parseInt(await rpc('eth_chainId'), 16) === 100) return proc;
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`the anvil fork is not ready: ${err.message}`, { cause: err });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

describeFork('a Safe on forked Gnosis through the real freedom-cored', () => {
  const world = mockWorld;
  let anvil;
  let forwarder;
  let ledger;
  let safe;
  let service;
  let transactions;
  let vaultBackend;

  beforeAll(async () => {
    anvil = await startAnvil();
    forwarder = await startRpcForwarder(ANVIL_URL, FORWARDER_PORT);
    // A cold fork reads each account and contract from the public RPC the
    // first time: the Safe contracts, loaded before the core's reads.
    await Promise.all([SINGLETON, PROXY_FACTORY, FALLBACK_HANDLER].map((address) => rpc('eth_getCode', [address, 'latest'])));
    const c = ledgerVectors('ledger.json').cases.find((one) => one.id === LEDGER_CASE);
    ledger = { path: c.record.path, address: deviceKey(c.record.path).address };
    service = require('../../safe-service');
    transactions = require('../../safe-transactions');
    ({ vaultBackend } = require('../../../../core/vault-backend'));
    createPageRelay(world);
    await startSafeCoreWorld(world, {
      binary: process.env.FREEDOM_CORED_PATH || require('../../../../core/cored-binary').getCoredBinaryPath(),
      urls: [ANVIL_URL, FORWARDER_URL],
      fetch,
      mnemonic: MNEMONIC,
      password: PASSWORD,
      ledger,
      vectors: ledgerVectors('ledger.json'),
    });
    // The executor (the vault's first account) pays for the activation and
    // the execution.
    await fund(world.accounts[0].address, parseEther('10'));
  });

  afterAll(async () => {
    await world.stop?.();
    await forwarder?.close();
    anvil?.kill();
  });

  afterEach(() => {
    expect(world.exits).toEqual([]);
    expect(world.errors).toEqual([]);
    expect(world.device.unrecorded).toEqual([]);
  });

  test("the core's record of a 2-of-3 Safe names an address with no code yet, which the core's status reads from both endpoints", async () => {
    safe = await service.createSafeAccount({ name: 'Fork Joint', ownerIndexes: [0, 1, LEDGER_INDEX], threshold: 2 });
    expect(safe).toMatchObject({ type: 'safe', owners: [0, 1, LEDGER_INDEX], threshold: 2 });
    expect(await rpc('eth_getCode', [safe.address, 'latest'])).toBe('0x');
    const status = await service.getSafeStatus(safe.index);
    expect(status).toMatchObject({ deployed: false, executorIndex: 0, needsFunds: false });
    expect(BigInt(status.executorBalance)).toBe(parseEther('10'));
  });

  test("the activation: the real factory deploys the record's Safe, with its owners and threshold, and it keeps funds sent to it before it existed", async () => {
    // Someone pays the Safe before it exists.
    await fund(safe.address, parseEther('1'));
    const result = await service.activateSafe(safe.index, {});
    expect(result).toMatchObject({ safeAddress: safe.address });
    expect((await rpc('eth_getCode', [safe.address, 'latest'])).length).toBeGreaterThan(2);
    const [owners] = await safeCall(safe.address, 'getOwners');
    expect([...owners].map((owner) => owner.toLowerCase()).sort()).toEqual(
      [world.accounts[0].address, world.accounts[1].address, ledger.address].map((owner) => owner.toLowerCase()).sort()
    );
    expect((await safeCall(safe.address, 'getThreshold'))[0]).toBe(2n);
    expect(await balanceOf(safe.address)).toBe(parseEther('1'));
    const receipt = await rpc('eth_getTransactionReceipt', [result.hash]);
    expect(receipt.status).toBe('0x1');
    expect(getAddress(receipt.to)).toBe(getAddress(PROXY_FACTORY));
    // Marked on the verified receipt; its setup then reads unchanged.
    expect(world.stored(safe.index).deployed).toEqual({ 100: { verified: true } });
    expect((await service.getSafeStatus(safe.index)).setup).toMatchObject({ state: 'unchanged' });
  });

  test('a 2-of-3 SafeTx signed by the Ledger, through its device, and a vault owner, executed by the real Safe with the core\'s token, moves the funds', async () => {
    const recipient = Wallet.createRandom().address;
    const value = parseEther('1').toString();
    // Locked: no vault owner signs as it is proposed, so the Ledger signs first.
    await vaultBackend.lock();
    const request = { tx: { to: recipient, value, data: '0x' }, chainId: 100 };
    const first = await transactions.confirmSafeSend({ sender: null, safeIndex: safe.index, request, approvals: null });
    expect(first).toMatchObject({ code: 'SAFE_TX_PREPARED', prepared: { nonce: 0 } });
    const { token } = await transactions.confirmSafeSend({
      sender: null,
      safeIndex: safe.index,
      request: { ...request, prepared: first.prepared.id },
      approvals: null,
    });
    const proposed = await transactions.proposeSafeSend({
      safeIndex: safe.index,
      tx: request.tx,
      chainId: 100,
      display: { asset: null, toAddress: recipient, amount: value },
      authorization: { confirmation: token },
    });
    expect(proposed).toMatchObject({ collected: 0, threshold: 2, proposed: true });
    const { safeTxHash } = proposed;

    world.device.play(LEDGER_CASE, { sign: () => safeTxHash });
    const signed = await transactions.signSafePending(safe.index, LEDGER_INDEX, { safeTxHash });
    expect(signed).toMatchObject({ collected: 1 });
    await until(() => world.relay.stats().parents === 0, 'the relay to let go of the Ledger');

    await vaultBackend.unlock(PASSWORD);
    expect(await transactions.signSafePending(safe.index, 0, { safeTxHash })).toMatchObject({ collected: 2 });

    await transactions.executeSafePending(safe.index, { safeTxHash });
    expect(await balanceOf(recipient)).toBe(parseEther('1'));
    expect(await balanceOf(safe.address)).toBe(0n);
    expect((await safeCall(safe.address, 'nonce'))[0]).toBe(1n);
    expect(await transactions.getSafeSendState(safe.index)).toBeNull();
  });

  test("a page's personal_sign: the vault owners' signatures over the SafeMessage pass the real Safe's isValidSignature (EIP-1271)", async () => {
    const env = pageHarness(world);
    const page = await env.connected(`${SITE}/app`, safe.index);
    const text = 'freedom 1271 on the core';
    const asked = env.asking(page, 'personal_sign', ['0x' + Buffer.from(text, 'utf8').toString('hex'), safe.address]);
    const shown = await asked.prompt();
    expect(shown).toMatchObject({ kind: 'eth.sign' });
    // Unlocked: both vault owners sign as the core's session opens, which
    // meets the threshold, so no board is shown.
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    const { result: signature } = await asked.answer;
    expect(signature).toMatch(/^0x[0-9a-f]{260}$/i);
    const [verdict] = await safeCall(safe.address, 'isValidSignature', [hashMessage(text), signature]);
    expect(verdict).toBe(MAGIC);
    // The same signature over another message is refused by the contract.
    await expect(safeCall(safe.address, 'isValidSignature', [hashMessage('tampered'), signature])).rejects.toThrow();
  });
});
