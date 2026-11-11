/**
 * Fork-chain verification of the Safe reproducible-address story
 * (research doc Part B, decision 5): the record's init params predict,
 * from the pinned proxy code, the address the real factory deploys, and
 * a deployment after the fact claims funds that were sent to the address
 * before it existed. Safes are created on Gnosis only (#1066: no other
 * chain has a pinned deployment).
 *
 * Runs the real SafeExecutor against an anvil fork of live Gnosis —
 * canonical safe-deployments factories only, real protocol-kit
 * encoding, the real transaction-service broadcast path. Only the signer
 * seam is faked (well-known anvil test keys stand in for vault/Ledger/
 * phone owners; they all sign the same EIP-712 payload).
 *
 * Needs `anvil` (foundry) on PATH and network access to the public fork
 * RPCs; skips cleanly otherwise (CI has neither).
 */

const { spawn, spawnSync } = require('child_process');
const {
  AbiCoder,
  Wallet,
  JsonRpcProvider,
  keccak256,
  parseEther,
  hashMessage,
  Interface,
  TypedDataEncoder,
} = require('ethers');

const { ownerWallet } = require('../helpers/test-owners');

const FORKS = {
  gnosis: { chainId: 100, forkUrl: 'https://rpc.gnosischain.com', port: 18845 },
};

const anvilUrl = (fork) => `http://127.0.0.1:${fork.port}`;

// Owner signers over the shared test keys, one per fake wallet index.
jest.mock('../../../signers', () => ({
  getSigner: (walletIndex) => require('../helpers/test-owners').createTestSigner(walletIndex),
}));

// Wallet records for the orchestrator path (owners stored as INDEXES,
// like real vault-meta records). The safe record is added by the test
// once the predicted address is known.
const mockWalletRecords = {
  0: { index: 0, name: 'Main Wallet', type: 'mnemonic', address: ownerWallet(0).address },
  2: { index: 2, name: 'My Stax', type: 'ledger', address: ownerWallet(2).address },
  4: { index: 4, name: 'My Phone', type: 'remote', address: ownerWallet(4).address },
};
jest.mock('../../../../identity-manager', () => ({
  getWalletRecord: (index) => mockWalletRecords[index] || null,
  isVaultUnlocked: async () => true,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));

// Recording is unit-tested elsewhere; here the broadcast must be real.
jest.mock('../../../tx-recorder', () => ({
  KINDS: { SAFE_SEND: 'safe-send', SAFE_DEPLOY: 'safe-deploy' },
  signAndRecord: (params, signer) =>
    jest.requireActual('../../../transaction-service').signAndSendTransaction(params, signer),
}));

// Point protocol-kit and Safe's raw reads at the anvil fork.
jest.mock('../../../provider-manager', () => {
  const { JsonRpcProvider: Provider } = require('ethers');
  const urls = { 100: 'http://127.0.0.1:18845' };
  const cache = new Map();
  return {
    getProvider: (chainId) => {
      if (!cache.has(chainId)) {
        cache.set(chainId, new Provider(urls[chainId], chainId, { staticNetwork: true }));
      }
      return cache.get(chainId);
    },
    getEip1193Provider: (chainId) => ({
      request: ({ method, params }) => {
        if (!cache.has(chainId)) {
          cache.set(chainId, new Provider(urls[chainId], chainId, { staticNetwork: true }));
        }
        return cache.get(chainId).send(method, params ?? []);
      },
    }),
    withRetry: (fn) => fn(),
  };
});

// Transaction-service now routes reads, fees, and broadcasts through the
// capability-aware chain router. Give that router a direct-only policy whose
// RPC inventory is the same local fork; otherwise it would correctly
// follow the app's normal registry and accidentally exercise public chains.
jest.mock('../../../../networks/network-registry', () => {
  const urls = { 100: 'http://127.0.0.1:18845' };
  return {
    getNetwork: (chainId) => ({
      chainId: Number(chainId),
      access: { readOrder: ['direct'], broadcastOrder: ['direct'] },
      quorum: { k: 1, m: 1, timeoutMs: 15000 },
    }),
    getEndpoints: (chainId, role) => (role === 'rpc' && urls[chainId] ? [urls[chainId]] : []),
  };
});

const {
  pinnedSafeDeployment,
  predictSafeAddress,
  buildSafeTransaction,
  collectOwnerSignature,
  execTransaction,
  deploySafe,
} = require('../../safe-executor');

// ---------------------------------------------------------------------------
// Availability gate (sync, decides skip at collection time)
// ---------------------------------------------------------------------------

function availability() {
  if (spawnSync('anvil', ['--version']).status !== 0) {
    return { ok: false, reason: 'anvil (foundry) not on PATH' };
  }
  for (const fork of Object.values(FORKS)) {
    const probe = spawnSync('curl', [
      '-sf',
      '-m',
      '10',
      '-X',
      'POST',
      fork.forkUrl,
      '-H',
      'Content-Type: application/json',
      '-d',
      '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
    ]);
    if (probe.status !== 0) {
      return { ok: false, reason: `fork RPC ${fork.forkUrl} unreachable` };
    }
  }
  return { ok: true };
}

const gate = availability();
if (!gate.ok) {
  console.warn(`[safe-fork.test] skipping fork verification: ${gate.reason}`);
}
const describeFork = gate.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------

jest.setTimeout(300000);

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(`${method}: ${error.message}`);
  return result;
}

// State reads and receipt waits go over raw JSON-RPC: a long-lived ethers
// provider instance caches account state keyed to a block number that
// never advances without polling/subscriptions, and its waitForTransaction
// only re-checks receipts on new blocks — which an automine chain never
// produces after the tx itself.
async function waitForReceipt(fork, hash, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await rpc(anvilUrl(fork), 'eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    if (Date.now() > deadline) throw new Error(`no receipt for ${hash} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const getCode = (fork, address) => rpc(anvilUrl(fork), 'eth_getCode', [address, 'latest']);
const getBalance = async (fork, address) =>
  BigInt(await rpc(anvilUrl(fork), 'eth_getBalance', [address, 'latest']));

async function startAnvil(fork) {
  const proc = spawn('anvil', [
    '--fork-url',
    fork.forkUrl,
    '--port',
    String(fork.port),
    '--silent',
  ]);
  const deadline = Date.now() + 120000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
    try {
      const chainIdHex = await rpc(anvilUrl(fork), 'eth_chainId');
      if (parseInt(chainIdHex, 16) === fork.chainId) return proc;
      throw new Error(`fork reports unexpected chain id ${chainIdHex}`);
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`anvil fork of ${fork.forkUrl} not ready: ${err.message}`, { cause: err });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

describeFork('Safe on forked Gnosis (pinned addresses, retroactive deploy)', () => {
  const INIT = {
    owners: [ownerWallet(0).address, ownerWallet(2).address, ownerWallet(4).address],
    threshold: 2,
    saltNonce: '20260709',
  };
  const executorAddress = ownerWallet(0).address;

  const procs = [];
  let predicted;

  beforeAll(async () => {
    procs.push(await startAnvil(FORKS.gnosis));

    // The executor EOA pays gas on the fork.
    const balance = '0x' + parseEther('10').toString(16);
    await rpc(anvilUrl(FORKS.gnosis), 'anvil_setBalance', [executorAddress, balance]);
  });

  afterAll(() => {
    for (const proc of procs) proc.kill();
  });

  test('the pinned proxy code is the forked factory\'s own, and Base is refused', async () => {
    const pinned = pinnedSafeDeployment(100);
    const factory = new Interface(['function proxyCreationCode() view returns (bytes)']);
    const answer = await rpc(anvilUrl(FORKS.gnosis), 'eth_call', [
      { to: pinned.factory, data: factory.encodeFunctionData('proxyCreationCode') },
      'latest',
    ]);
    const [code] = AbiCoder.defaultAbiCoder().decode(['bytes'], answer);
    expect(keccak256(code)).toBe(pinned.proxyCreationCodeHash);

    predicted = await predictSafeAddress({ ...INIT, chainId: 100 });
    expect(await getCode(FORKS.gnosis, predicted)).toBe('0x');
    await expect(predictSafeAddress({ ...INIT, chainId: 8453 })).rejects.toMatchObject({
      code: 'SAFE_UNSUPPORTED',
    });
  });

  test('retroactive deployment claims funds sent to the empty address', async () => {
    // Someone pays the Safe before it exists…
    const funderProvider = new JsonRpcProvider(anvilUrl(FORKS.gnosis), 100, { staticNetwork: true });
    const funder = ownerWallet(0).connect(funderProvider);
    const funding = await funder.sendTransaction({ to: predicted, value: parseEther('1') });
    await waitForReceipt(FORKS.gnosis, funding.hash);
    funderProvider.destroy();
    expect(await getBalance(FORKS.gnosis, predicted)).toBe(parseEther('1'));
    expect(await getCode(FORKS.gnosis, predicted)).toBe('0x');

    // …then the ORIGINAL init params deploy the Safe at that address.
    const { safeAddress, tx } = await deploySafe({
      ...INIT,
      chainId: 100,
      executorIndex: 0,
    });
    expect(safeAddress).toBe(predicted);
    const receipt = await waitForReceipt(FORKS.gnosis, tx.hash);
    expect(receipt.status).toBe('0x1');
    expect((await getCode(FORKS.gnosis, predicted)).length).toBeGreaterThan(2);

    // …and a 2/3-signed SafeTx moves the pre-sent funds out.
    const recipient = Wallet.createRandom().address;
    const built = await buildSafeTransaction({
      chainId: 100,
      safe: { ...INIT, address: predicted },
      tx: { to: recipient, value: parseEther('1').toString(), data: '0x' },
      provider: anvilUrl(FORKS.gnosis),
    });
    expect(built.deployed).toBe(true);
    expect(built.safeAddress).toBe(predicted);

    const signatures = [
      await collectOwnerSignature({ typedData: built.typedData, ownerIndex: 0 }),
      await collectOwnerSignature({ typedData: built.typedData, ownerIndex: 2 }),
    ];
    const result = await execTransaction({
      chainId: 100,
      safeAddress: predicted,
      safeTxData: built.safeTxData,
      signatures,
      executorIndex: 0,
    });
    const execReceipt = await waitForReceipt(FORKS.gnosis, result.hash);
    expect(execReceipt.status).toBe('0x1');

    expect(await getBalance(FORKS.gnosis, recipient)).toBe(parseEther('1'));
    expect(await getBalance(FORKS.gnosis, predicted)).toBe(0n);
  });

  test('the send orchestrator moves funds starting from a wallet RECORD (owners as indexes)', async () => {
    // Regression: the record stores owners as wallet indexes; passing
    // them unresolved into protocol-kit blew up with `Address "0" is
    // invalid`. This walks the REAL start → sign → execute path, un-mocked.
    const { startSafeSend, signSafePending, executeSafePending } = require('../../safe-transactions');
    // The mocked electron userData dir is shared across runs — drop any
    // pending entry a previous run left behind.
    require('../../pending-store').clearPending(5);

    // Fund the (deployed, previous test) safe on the Gnosis fork.
    const gnosisProvider = new JsonRpcProvider(anvilUrl(FORKS.gnosis), 100, { staticNetwork: true });
    const funder = ownerWallet(0).connect(gnosisProvider);
    const funding = await funder.sendTransaction({ to: predicted, value: parseEther('1') });
    await waitForReceipt(FORKS.gnosis, funding.hash);
    gnosisProvider.destroy();

    mockWalletRecords[5] = {
      index: 5,
      name: 'Joint',
      type: 'safe',
      address: predicted,
      owners: [0, 2, 4], // wallet indexes, exactly like vault-meta
      threshold: INIT.threshold,
      saltNonce: INIT.saltNonce,
      deployed: { 100: true },
    };

    const recipient = Wallet.createRandom().address;
    const amount = parseEther('1').toString();
    // start silently signs the mnemonic owner (1 of 2)…
    const started = await startSafeSend({
      safeIndex: 5,
      chainId: 100,
      tx: { to: recipient, value: amount, data: '0x' },
      display: { toAddress: recipient, asset: null, amount },
    });
    expect(started).toMatchObject({ collected: 1, threshold: 2, status: 'awaiting' });

    // …the user signs the second owner, then execution runs on its own.
    const signed = await signSafePending(5, 2);
    expect(signed.collected).toBe(2);
    const result = await executeSafePending(5);
    expect(result.status).toBe('executed');

    const receipt = await waitForReceipt(FORKS.gnosis, result.executed.hash);
    expect(receipt.status).toBe('0x1');
    expect(await getBalance(FORKS.gnosis, recipient)).toBe(parseEther('1'));
  });

  test('a collected SafeMessage signature passes isValidSignature on chain (EIP-1271)', async () => {
    // What WP-S4 promises dApps: personal_sign / typed data answered by
    // a Safe account verifies through the REAL contract's fallback
    // handler, exactly the call a dApp makes.
    const { startSafeMessage, signSafeMessage, completeSafeMessage } = require('../../safe-messages');
    const IS_VALID = new Interface([
      'function isValidSignature(bytes32 dataHash, bytes signature) view returns (bytes4)',
    ]);
    const MAGIC = '0x1626ba7e';
    const callIsValid = async (digest, signature) => {
      const data = IS_VALID.encodeFunctionData('isValidSignature', [digest, signature]);
      const result = await rpc(anvilUrl(FORKS.gnosis), 'eth_call', [
        { to: predicted, data },
        'latest',
      ]);
      return result.slice(0, 10);
    };

    // personal_sign, hex-encoded the way dApps send it (2 of 3 owners)
    const text = 'freedom 1271';
    const hexMessage = '0x' + Buffer.from(text, 'utf8').toString('hex');
    const started = await startSafeMessage({
      safeIndex: 5,
      request: { method: 'personal_sign', params: [hexMessage, predicted] },
      display: { site: 'app.example', method: 'personal_sign' },
      requester: { origin: 'app.example', webContentsId: 1 },
    });
    expect(started).toMatchObject({ collected: 1, threshold: 2, complete: false });
    await signSafeMessage(5, 2, started.token);
    const { signature } = completeSafeMessage(5, started.token);

    // the digest a verifying dApp computes: EIP-191 over the BYTES
    expect(await callIsValid(hashMessage(text), signature)).toBe(MAGIC);
    // …and the same signature over a different digest is refused
    await expect(callIsValid(hashMessage('tampered'), signature)).rejects.toThrow();

    // eth_signTypedData_v4 (JSON-string param, EIP712Domain included)
    const typed = {
      domain: { name: 'Fork Dapp', chainId: 100, verifyingContract: ownerWallet(0).address },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        Ping: [{ name: 'note', type: 'string' }],
      },
      primaryType: 'Ping',
      message: { note: 'gm' },
    };
    const startedTyped = await startSafeMessage({
      safeIndex: 5,
      request: { method: 'eth_signTypedData_v4', params: [predicted, JSON.stringify(typed)] },
      display: { site: 'app.example', method: 'eth_signTypedData_v4' },
      requester: { origin: 'app.example', webContentsId: 1 },
    });
    await signSafeMessage(5, 4, startedTyped.token); // a different second owner this time
    const { signature: typedSignature } = completeSafeMessage(5, startedTyped.token);

    const typedDigest = TypedDataEncoder.hash(typed.domain, { Ping: typed.types.Ping }, typed.message);
    expect(await callIsValid(typedDigest, typedSignature)).toBe(MAGIC);
  });
});
