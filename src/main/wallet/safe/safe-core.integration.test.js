/**
 * SAFE-3's gates against the real freedom-cored (freedom-core design 0016;
 * the SAFE-3 plan's point 12 and PR 10): every Safe flow main drives on the
 * core's Safe and Ledger backends (FREEDOM_SAFE_BACKEND=core,
 * FREEDOM_LEDGER_BACKEND=core), end to end through the binary the build
 * pins, over a JSON-RPC stub with two distinct endpoints
 * (test/helpers/safe-chain-stub.js: one Gnosis behind both, so the core's
 * quorum of two agrees and its eight Safe reads are verified, and which
 * runs a deployment and an `execTransaction` as the factory and the Safe
 * check them).
 *
 * What runs is main's own (test/helpers/safe-core-world.js): safe-service.js
 * and core-accounts.js, safe-transactions.js and core-sends.js,
 * safe-messages.js and core-messages.js, ledger-owners.js, approval-records.js,
 * the signers, the journal, payment history and the pending store's copy,
 * the page's requests, the core's relay and main's device and send steps,
 * main's chain data (the core's chain config, shell and drivers), and main's
 * Ledger relay and HID layer over a fake node-hid, the reference's Ledger
 * behind it (ledger.json's `typed-safe-tx` device, signing the live SafeTx).
 * Only Electron, the backend switches, identity-manager.js's reads of the
 * wallet list (from the core's vault-meta.json) and phones are stand-ins;
 * the approvals document is off (the chrome's own screens).
 *
 * - **Create:** `safe.create` writes the record (the core computes the
 *   address), reading no chain.
 * - **Status:** not deployed, read from both endpoints; the executor's
 *   balance and the activation's cost.
 * - **Deploy:** `safe.deploy`'s `{ send }` signed with its `executor-send`
 *   token at main's nonce and journaled; the factory deploys at the
 *   record's address with its owners and threshold; `safe.deployed` marks
 *   it on the receipt both endpoints give; the setup then reads unchanged.
 * - **Propose:** the wallet's own send prepared by the core ("Safe
 *   transaction #0"), approved and minted, proposed: the vault owner's
 *   signature, the core's proposal mark in `safe-pending.json`.
 * - **Sign, a Ledger owner:** through main's binding and relay, the
 *   reference's device signs the SafeTx's digest; no APDU outside its
 *   recording but the live fields.
 * - **Rollback:** on js, main's pending-store.js reads the core's file and
 *   shows the same entry, the mark and both signatures with it; back on
 *   the core, the mark survived the restart.
 * - **Execute:** the executor's send with the core's token, run by the
 *   stub's Safe with both owners' signatures at the Safe's nonce;
 *   `safe.executed` clears the entry.
 * - **Discard:** a proposed SafeTx discarded: nothing pending, no record.
 * - **A page's message:** `personal_sign` for a 1-of-2 Safe through the
 *   core's prompt: `safe.message_start` under the page, the vault owner's
 *   signature over the SafeMessage, the page's EIP-1271 signature.
 * - **A site's send:** the core reads the Safe before its prompt, which
 *   shows the SafeTx by its nonce; the `{ device }` recorded and proposed
 *   under the page; executed past the site's guard, the hash to the page.
 *
 * Skipped unless FREEDOM_CORED_PATH points at a build, or
 * FREEDOM_CORED_SAFE_TEST=1 asks for the binary `npm run core:download`
 * fetched (which must then be there), and the Ledger vectors are found
 * (test/helpers/ledger-vectors.js; FREEDOM_CORE_LEDGER_VECTORS names
 * freedom-core's `vectors` at the pinned commit, and a missing file then
 * fails the suite), e.g.
 *   FREEDOM_CORED_SAFE_TEST=1 FREEDOM_CORE_LEDGER_VECTORS=…/freedom-core/vectors \
 *     npx jest src/main/wallet/safe/safe-core.integration
 */

const mockWorld = {};
require('../../../../test/helpers/safe-core-world').mockSafeCoreModules(mockWorld);

const fs = require('fs');
const path = require('path');
const { Wallet, TypedDataEncoder, getAddress, hashMessage, recoverAddress, parseEther } = require('ethers');
const {
  LEDGER_INDEX,
  createPageRelay,
  pageHarness,
  restartCore,
  startSafeCoreWorld,
  until,
} = require('../../../../test/helpers/safe-core-world');
const { SAFE_TX_TYPES, startSafeChainStub } = require('../../../../test/helpers/safe-chain-stub');
const { ledgerVectors, ledgerVectorsRequired } = require('../../../../test/helpers/ledger-vectors');
const { deviceKey } = require('../../../../test/helpers/ledger-reference-device');

const required = process.env.FREEDOM_CORED_SAFE_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH || (required ? require('../../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_SAFE_TEST=1 needs freedom-cored: run npm run core:download');
}
const vectors = ledgerVectors('ledger.json');
if (ledgerVectorsRequired && !vectors) throw new Error('FREEDOM_CORE_LEDGER_VECTORS names no ledger.json');
const skipped = !binary
  ? 'no freedom-cored: set FREEDOM_CORED_PATH or FREEDOM_CORED_SAFE_TEST=1'
  : !vectors
    ? 'no Ledger vectors: set FREEDOM_CORE_LEDGER_VECTORS'
    : null;
const describeIfReady = skipped ? (name, fn) => describe.skip(`${name} (skipped: ${skipped})`, fn) : describe;

// A real core reads its chain on real timers; main waits for receipts.
jest.setTimeout(120_000);

// The vault's phrase: not the reference Ledger's (abandon), so no vault
// account is the Ledger's.
const MNEMONIC = 'test test test test test test test test test test test junk';
const PASSWORD = 'Freedom-Safe-Gates-2026!';
const LEDGER_CASE = 'typed-safe-tx';
const SITE = `bzz://${'5a'.repeat(32)}`;
const ZERO = '0x0000000000000000000000000000000000000000';

// The eight setup reads of a Safe (fc-safe reads.rs), as one endpoint gets them.
const EIGHT = [
  'eth_getCode',
  'eth_getStorageAt:0x0000000000000000000000000000000000000000000000000000000000000000',
  'eth_call:0xa0e67e2b',
  'eth_call:0xe75235b8',
  'eth_getStorageAt:0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8',
  'eth_getStorageAt:0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5',
  'eth_call:0xcc2f8452',
  'eth_call:0xaffed0e0',
].sort();

/** Each endpoint's reads of the Safe at `address` among `calls`, sorted. */
function safeReads(calls, address) {
  const byEndpoint = new Map();
  for (const call of calls) {
    const first = call.params?.[0];
    const to = typeof first === 'string' ? first : first?.to;
    if (typeof to !== 'string' || to.toLowerCase() !== address.toLowerCase()) continue;
    const detail =
      call.method === 'eth_call'
        ? `:${first.data.slice(0, 10)}`
        : call.method === 'eth_getStorageAt'
          ? `:${call.params[1]}`
          : '';
    if (!byEndpoint.has(call.endpoint)) byEndpoint.set(call.endpoint, []);
    byEndpoint.get(call.endpoint).push(call.method + detail);
  }
  for (const reads of byEndpoint.values()) reads.sort();
  return byEndpoint;
}

const hashOf = (safeAddress, safeTx) =>
  TypedDataEncoder.hash({ chainId: 100, verifyingContract: getAddress(safeAddress) }, SAFE_TX_TYPES, safeTx);

describeIfReady('SAFE-3 gates: Safes on the real freedom-cored over two endpoints', () => {
  const world = mockWorld;
  let stub;
  let ledger;
  // The two Safes: A, 1 of the vault's two accounts; B, 2 of those two and
  // the Ledger.
  let safeA;
  let safeB;
  // Modules, loaded once the world is mocked.
  let service;
  let transactions;
  let records;
  let pendingStore;
  let vaultBackend;

  beforeAll(async () => {
    stub = startSafeChainStub();
    const c = vectors.cases.find((one) => one.id === LEDGER_CASE);
    ledger = { path: c.record.path, address: deviceKey(c.record.path).address };
    expect(ledger.address).toBe(getAddress(c.record.address));
    service = require('./safe-service');
    transactions = require('./safe-transactions');
    records = require('./approval-records');
    pendingStore = require('./pending-store');
    ({ vaultBackend } = require('../../core/vault-backend'));
    createPageRelay(world);
    await startSafeCoreWorld(world, {
      binary,
      urls: stub.urls,
      fetch: stub.fetch,
      mnemonic: MNEMONIC,
      password: PASSWORD,
      ledger,
      vectors,
    });
  });

  afterAll(async () => {
    await world.stop?.();
  });

  afterEach(() => {
    // The core it started, no fault logged, no APDU off the recording.
    expect(world.exits).toEqual([]);
    expect(world.client.current?.child?.pid).toBe(world.pid);
    expect(world.errors).toEqual([]);
    if (world.device) expect(world.device.unrecorded).toEqual([]);
  });

  test("the hello: safe3 declared and taken; vault_meta and safe_pending the core's", () => {
    expect(world.hello.safe3).toBe(true);
    expect(world.hello.store_moved).toEqual(expect.arrayContaining(['vault_meta', 'safe_pending']));
    expect(world.hello.capabilities).toEqual(
      expect.arrayContaining(['safe.create', 'safe.status', 'safe.deploy', 'safe.propose', 'safe.execute'])
    );
  });

  test('create: safe.create writes each record, the core computing its address, and reads no chain', async () => {
    const before = stub.calls.length;
    safeA = await service.createSafeAccount({ name: 'Joint A', ownerIndexes: [0, 1], threshold: 1 });
    safeB = await service.createSafeAccount({ name: 'Joint B', ownerIndexes: [0, 1, LEDGER_INDEX], threshold: 2 });
    expect(stub.calls.length).toBe(before);
    for (const [safe, owners, threshold] of [
      [safeA, [0, 1], 1],
      [safeB, [0, 1, LEDGER_INDEX], 2],
    ]) {
      expect(safe).toMatchObject({ type: 'safe', owners, threshold });
      expect(safe.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(world.record(safe.index)).toMatchObject({ address: safe.address, owners, threshold });
    }
    expect(safeA.address).not.toBe(safeB.address);
  });

  test("status before activation: not deployed, from both endpoints' reads; the executor's balance and the cost", async () => {
    const before = stub.calls.length;
    const status = await service.getSafeStatus(safeB.index);
    expect(status).toMatchObject({
      deployed: false,
      chainId: 100,
      executorIndex: 0,
      executorAddress: world.accounts[0].address,
      needsFunds: false,
    });
    expect(BigInt(status.executorBalance)).toBe(parseEther('1'));
    expect(BigInt(status.estimatedCost)).toBeGreaterThan(0n);
    const codeReads = stub.calls.slice(before).filter((c) => c.method === 'eth_getCode');
    expect(new Set(codeReads.map((c) => c.endpoint))).toEqual(new Set([0, 1]));
    expect(codeReads.every((c) => getAddress(c.params[0]) === getAddress(safeB.address))).toBe(true);
  });

  test("activation: safe.deploy's send signed with its token at main's nonce; the factory deploys the record's Safe; safe.deployed marks it on both endpoints' receipt", async () => {
    for (const safe of [safeA, safeB]) {
      const before = stub.calls.length;
      const result = await service.activateSafe(safe.index, {});
      expect(result).toMatchObject({ safeAddress: safe.address });
      expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
      // The factory's own address for the core's calldata is the record's,
      // with its owners and threshold.
      const deployed = stub.deployments.find((d) => d.address === getAddress(safe.address));
      expect(deployed).toMatchObject({
        owners: safe.owners.map((index) => getAddress(world.record(index).address)),
        threshold: safe.threshold,
      });
      expect(String(deployed.saltNonce)).toBe(String(world.record(safe.index).saltNonce));
      // Sent by the executor, signed by the vault's first account.
      const sent = stub.sent.find((tx) => tx.hash === result.hash);
      expect(sent.from).toBe(world.accounts[0].address);
      // The receipt read from both endpoints, then the mark.
      const receipts = stub.calls.slice(before).filter((c) => c.method === 'eth_getTransactionReceipt' && c.params[0] === result.hash);
      expect(new Set(receipts.map((c) => c.endpoint))).toEqual(new Set([0, 1]));
      expect(world.stored(safe.index).deployed).toEqual({ 100: { verified: true } });
      expect(service.isMarkedDeployed(world.record(safe.index), 100)).toBe(true);
    }
    const status = await service.getSafeStatus(safeB.index);
    expect(status).toMatchObject({ deployed: true });
    expect(status.setup).toMatchObject({ state: 'unchanged' });
  });

  // The wallet's own send from B, and its SafeTx, as the board names it.
  const recipient = Wallet.createRandom().address;
  const sendValue = parseEther('0.25').toString();
  let proposed;

  test("the wallet's own send: the core prepares the SafeTx (Safe transaction #0), the chrome's second confirmation mints it, safe.propose writes the entry with the core's mark", async () => {
    // Locked, so no vault owner signs as it is proposed: the Ledger signs first.
    await vaultBackend.lock();
    const request = { tx: { to: recipient, value: sendValue, data: '0x' }, chainId: 100 };
    const first = await transactions.confirmSafeSend({ sender: null, safeIndex: safeB.index, request, approvals: null });
    expect(first).toMatchObject({ approved: false, code: 'SAFE_TX_PREPARED', prepared: { nonce: 0 } });
    expect(first.error).toBe('Confirm Safe transaction #0');
    const second = await transactions.confirmSafeSend({
      sender: null,
      safeIndex: safeB.index,
      request: { ...request, prepared: first.prepared.id },
      approvals: null,
    });
    expect(second).toMatchObject({ approved: true });
    expect(typeof second.token).toBe('string');
    // The user's decision, recorded for exactly that SafeTx (PR 6).
    const safeTx = {
      to: getAddress(recipient),
      value: sendValue,
      data: '0x',
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: 0,
    };
    const safeTxHash = hashOf(safeB.address, safeTx);
    expect(records.recordFor(safeB.index)).toMatchObject({ hash: safeTxHash });
    const state = await transactions.proposeSafeSend({
      safeIndex: safeB.index,
      tx: request.tx,
      chainId: 100,
      display: { asset: null, toAddress: recipient, amount: sendValue },
      authorization: { confirmation: second.token },
    });
    expect(state).toMatchObject({ safeIndex: safeB.index, safeTxHash, threshold: 2, collected: 0, proposed: true });
    // The core's file: the entry, with its proposal mark; main's copy is it.
    const file = JSON.parse(fs.readFileSync(path.join(world.root, 'safe-pending.json'), 'utf8'));
    const entry = file[String(safeB.index)];
    expect(entry).toMatchObject({ safeTxHash, safeAddress: safeB.address, threshold: 2, signatures: [] });
    expect(entry.coreProposal).toMatchObject({ safeTxHash });
    expect(pendingStore.getPending(safeB.index)).toMatchObject({ safeTxHash, coreProposal: { safeTxHash } });
    proposed = { safeTx, safeTxHash };
  });

  test("a Ledger owner signs it: main's binding of the entry's fields under its record, main's relay, the reference's device signing the SafeTx's digest", async () => {
    const played = world.device.play(LEDGER_CASE, { sign: () => proposed.safeTxHash });
    expect(played.record.path).toBe(ledger.path);
    const state = await transactions.signSafePending(safeB.index, LEDGER_INDEX, { safeTxHash: proposed.safeTxHash });
    expect(state).toMatchObject({ safeTxHash: proposed.safeTxHash, collected: 1, threshold: 2, status: 'awaiting' });
    expect(state.owners.find((owner) => owner.index === LEDGER_INDEX)).toMatchObject({ signed: true });
    // The device saw the live SafeTx field by field, and signed its digest.
    expect(world.device.ruled.length).toBeGreaterThan(0);
    expect(world.device.translated).toEqual([]);
    const signature = pendingStore.getPending(safeB.index).signatures.find((sig) => getAddress(sig.signer) === ledger.address);
    expect(recoverAddress(proposed.safeTxHash, signature.data)).toBe(ledger.address);
    await until(() => world.relay.stats().parents === 0, 'the relay to let go of the Ledger');
  });

  test('a vault owner signs from the board once unlocked: the threshold is met', async () => {
    await vaultBackend.unlock(PASSWORD);
    const state = await transactions.signSafePending(safeB.index, 0, { safeTxHash: proposed.safeTxHash });
    expect(state).toMatchObject({ safeTxHash: proposed.safeTxHash, collected: 2, threshold: 2 });
    expect(state.owners.filter((owner) => owner.signed).map((owner) => owner.index).sort()).toEqual([0, LEDGER_INDEX]);
  });

  test("rollback: on js, main's pending-store.js reads the file the core wrote and shows the same entry; back on the core, the mark held across the restarts", async () => {
    const onCore = JSON.parse(JSON.stringify(pendingStore.getPending(safeB.index)));
    const file = fs.readFileSync(path.join(world.root, 'safe-pending.json'), 'utf8');
    world.safeBackend = 'js';
    try {
      await restartCore(world);
      expect(world.hello.safe3).not.toBe(true);
    // The JS path's copy: the core's entry as written, signatures and mark.
    expect(pendingStore.listPendingIndexes()).toEqual([safeB.index]);
    expect(pendingStore.getPending(safeB.index)).toEqual(onCore);
    // And the JS board shows it: the same SafeTx, both signatures, ready.
    expect(transactions.getSafeSendState(safeB.index)).toMatchObject({
      safeIndex: safeB.index,
      safeTxHash: proposed.safeTxHash,
      threshold: 2,
      collected: 2,
    });
      // Reading it changed nothing.
      expect(fs.readFileSync(path.join(world.root, 'safe-pending.json'), 'utf8')).toBe(file);
    } finally {
      world.safeBackend = 'core';
      await restartCore(world);
    }
    expect(world.hello.safe3).toBe(true);
    expect(await transactions.getSafeSendState(safeB.index)).toMatchObject({
      safeTxHash: proposed.safeTxHash,
      collected: 2,
      proposed: true,
    });
  });

  test("execute: the executor's send signed with the core's token, the Safe runs it with the Ledger's and the vault owner's signatures at its nonce; safe.executed clears the entry", async () => {
    stub.setBalance(recipient, 0n);
    const result = await transactions.executeSafePending(safeB.index, { safeTxHash: proposed.safeTxHash });
    const executed = stub.executions.at(-1);
    expect(executed).toMatchObject({ safe: getAddress(safeB.address), safeTxHash: proposed.safeTxHash, ok: true });
    expect(executed.owners.map((owner) => owner.toLowerCase()).sort()).toEqual(
      [ledger.address, world.accounts[0].address].map((owner) => owner.toLowerCase()).sort()
    );
    expect(executed.executor).toBe(world.accounts[0].address);
    expect(stub.balanceOf(recipient)).toBe(BigInt(sendValue));
    expect(stub.safeAt(safeB.address).nonce).toBe(1);
    expect(result).toBeTruthy();
    expect(await transactions.getSafeSendState(safeB.index)).toBeNull();
    expect(pendingStore.getPending(safeB.index)).toBeNull();
    expect(records.recordFor(safeB.index)).toBeNull();
  });

  test('discard: a proposed SafeTx discarded leaves nothing pending and drops its record', async () => {
    const request = { tx: { to: recipient, value: '1', data: '0x' }, chainId: 100 };
    const first = await transactions.confirmSafeSend({ sender: null, safeIndex: safeB.index, request, approvals: null });
    expect(first.prepared.nonce).toBe(1);
    const { token } = await transactions.confirmSafeSend({
      sender: null,
      safeIndex: safeB.index,
      request: { ...request, prepared: first.prepared.id },
      approvals: null,
    });
    const state = await transactions.proposeSafeSend({
      safeIndex: safeB.index,
      tx: request.tx,
      chainId: 100,
      display: { asset: null, toAddress: recipient, amount: '1' },
      authorization: { confirmation: token },
    });
    // Unlocked: both vault owners signed as it was proposed.
    expect(state).toMatchObject({ collected: 2, threshold: 2, proposed: true });
    expect(state.owners.filter((owner) => owner.signed).map((owner) => owner.index)).toEqual([0, 1]);
    const sentBefore = stub.sent.length;
    await transactions.cancelSafeSend(safeB.index, { safeTxHash: state.safeTxHash });
    expect(await transactions.getSafeSendState(safeB.index)).toBeNull();
    expect(pendingStore.getPending(safeB.index)).toBeNull();
    expect(records.recordFor(safeB.index)).toBeNull();
    expect(stub.sent.length).toBe(sentBefore);
    expect(stub.safeAt(safeB.address).nonce).toBe(1);
  });

  describe("a page's requests, through the core's relay and prompts", () => {
    let env;
    let page;

    beforeAll(async () => {
      env = pageHarness(world);
      page = await env.connected(`${SITE}/app`, safeA.index);
    });

    test("a page's message: personal_sign through the core's prompt; safe.message_start under the page; the vault owner's EIP-1271 signature over the SafeMessage", async () => {
      const text = 'freedom safe-3 gates';
      const hexMessage = '0x' + Buffer.from(text, 'utf8').toString('hex');
      const asked = env.asking(page, 'personal_sign', [hexMessage, safeA.address]);
      const shown = await asked.prompt();
      expect(shown).toMatchObject({ kind: 'eth.sign' });
      expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
      const answer = await asked.answer;
      expect(answer.result).toMatch(/^0x[0-9a-f]{130}$/i);
      const safeMessageHash = TypedDataEncoder.hash(
        { chainId: 100, verifyingContract: getAddress(safeA.address) },
        { SafeMessage: [{ name: 'message', type: 'bytes' }] },
        { message: hashMessage(text) }
      );
      const signer = recoverAddress(safeMessageHash, answer.result);
      expect([world.accounts[0].address, world.accounts[1].address]).toContain(signer);
    });

    test("a site's send: the core reads the Safe before its prompt (Safe transaction #0); the { device } recorded and proposed under the page; executed past the site's guard, the hash to the page", async () => {
      const to = Wallet.createRandom().address;
      stub.setBalance(to, 0n);
      const value = parseEther('0.1');
      const before = stub.calls.length;
      const asked = env.asking(page, 'eth_sendTransaction', [
        { from: safeA.address, to, value: '0x' + value.toString(16) },
      ]);
      const shown = await asked.prompt();
      expect(shown).toMatchObject({ kind: 'eth.send' });
      expect(shown.view.safeTx).toEqual({ nonce: 0 });
      // The eight reads, from both endpoints, before the prompt.
      const reads = safeReads(stub.calls.slice(before), safeA.address);
      expect(reads.get(0)).toEqual(EIGHT);
      expect(reads.get(1)).toEqual(EIGHT);
      // The approve's answer comes once main's steps for it end: here, once
      // the board's SafeTx has executed.
      const decided = env.decide(shown.handle, true, {});
      const board = await asked.prompt(2);
      expect(board).toMatchObject({ kind: 'eth.safe_send' });
      const state = await transactions.getSafeSendState(safeA.index);
      expect(state).toMatchObject({ collected: 1, threshold: 1, proposed: true });
      const safeTxHash = state.safeTxHash;
      // The page's decision, recorded for that SafeTx.
      expect(records.recordFor(safeA.index)).toMatchObject({ hash: safeTxHash });
      // The board's execution, under the site.
      await transactions.executeSafePending(safeA.index, { safeTxHash });
      expect(await decided).toEqual({ ok: true });
      const answer = await asked.answer;
      expect(answer.result).toMatch(/^0x[0-9a-f]{64}$/);
      const executed = stub.executions.at(-1);
      expect(executed).toMatchObject({ safe: getAddress(safeA.address), safeTxHash, ok: true });
      expect(stub.sent.at(-1).hash).toBe(answer.result);
      expect(stub.balanceOf(to)).toBe(value);
      expect(await transactions.getSafeSendState(safeA.index)).toBeNull();
    });
  });
});
