jest.mock('./ppv2-deposit-prover', () => ({ createPPv2DepositProver: () => ({ service: {} }) }));
jest.mock('./ppv2-ragequit-prover', () => ({ createPPv2RagequitProver: () => ({ service: {}, prepare: (...args) => mockExitPrepare(...args) }) }));
const mockExitPrepare = jest.fn();
jest.mock('./ppv2-transact-prover', () => ({ createPPv2TransactProver: () => ({ service: {}, prepare: (...args) => mockTransactPrepare(...args) }) }));
const mockTransactPrepare = jest.fn();
jest.mock('./ppv2-public-operations', () => { const actual = jest.requireActual('./ppv2-public-operations');
  return { ...actual, createPPv2PublicOperations: (...args) => { const ops = actual.createPPv2PublicOperations(...args);
    return { ...ops, submit: (...args) => mockPublicSubmit ? mockPublicSubmit(...args) : ops.submit(...args) }; } }; });
let mockPublicSubmit;
jest.mock('./privacy-session', () => { const actual = jest.requireActual('./privacy-session');
  return { ...actual, openPrivacySession: jest.fn(actual.openPrivacySession) }; });
jest.mock('./ppv2-runtime', () => ({ assertPPv2Candidate: jest.fn(), assertPPv2RuntimeEntries: jest.fn() }));
jest.mock('../identity/vault', () => ({ getMnemonic: () => 'test test test test test test test test test test test junk',
  getSessionSignal: () => mockVault.signal }));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => mockAvailable }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../networks/kohaku-provider', () => ({ createKohakuProvider: () => ({ call: (...args) => mockCall(...args) }) }));
jest.mock('../networks/kohaku-network-router', () => ({ createKohakuNetworkRouter: () => ({ fetch: (...args) => mockFetch(...args) }) }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPPv2Keystore } = require('../identity/ppv2-keys');
const { createPPv2Storage } = require('./ppv2-storage');
const { getPPv2RelayJournal } = require('./ppv2-relay-journal');
const { PPV2_CANDIDATE, openPPv2Session } = require('./ppv2-session');
const { resetPrivacySession } = require('./privacy-session');
const { configuration } = require('../../../test/helpers/ppv2-session-fixture');
let mockVault, mockProfile, mockAvailable, config, host, params, candidate, scope, mockCall, mockEndpoint, tor, mockFetch;
const registrationKeys = { authDigest: `0x${'1'.padStart(64, '0')}`, nullifyingKeyHash: `0x${'2'.padStart(64, '0')}`, viewingKey: `0x${'ab'.repeat(32)}` };
const snapshot = () => Object.freeze({ instanceId: async () => config.ownerAddress, isRegistered: async () => false,
  balance: async () => [], notes: async () => [], prepareRegisterKeystore: async () => ({ __type: 'publicOperation', txs: [] }) });
const handle = (role, index = 0) => scope.getContext({ kind: 'private-account', principal: `ppv2:${index}`,
  protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role });
beforeEach(() => {
  mockPublicSubmit = null;
  mockVault = new AbortController(); mockAvailable = true;
  tor = new AbortController(); mockEndpoint = { signal: tor.signal };
  mockProfile = { id: 'fixture', userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ppv2-state-test-')) };
  scope = createPrivacyScope({ signal: mockVault.signal, profileId: createHash('sha256')
    .update(JSON.stringify([mockProfile.id, mockProfile.userDataDir])).digest('hex') });
  config = configuration();
  mockCall = jest.fn(async () => `0x${'0'.repeat(64)}`);
  mockFetch = jest.fn(async () => new Response('{}'));
  candidate = { ...PPV2_CANDIDATE, inspectRegistration: async () => registrationKeys,
    createPlugin: jest.fn(async (h, p) => { host = h; params = p; return snapshot(); }) };
});
afterEach(() => { mockVault.abort(); scope.close(); resetPrivacySession(); });

test.each(['/V1/relay/evm/11155111/withdrawal', '/v1/%72elay/evm/11155111/withdrawal', '/v1//relay/evm/11155111/withdrawal'])(
  'the SDK cannot bypass capture-only relay handling through %s', async (pathname) => {
    const session = await openPPv2Session({ candidate, configuration: config });
    await expect(host.network.fetch(`https://service.example.test${pathname}`, { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled(); session.close();
  });

test('Tor replacement revokes the old session and releases its account lease', async () => {
  const old = await openPPv2Session({ candidate, configuration: config });
  tor.abort(); tor = new AbortController(); mockEndpoint = { signal: tor.signal };
  await expect(old.notes()).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  const next = await openPPv2Session({ candidate, configuration: config });
  expect(await next.notes()).toEqual([]); next.close();
});

test('refuses an existing immutable registration from another account and releases the session lease', async () => {
  mockCall.mockResolvedValue(`0x${'3'.padStart(64, '0')}`);
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_REGISTRATION_MISMATCH' });
  mockCall.mockResolvedValue(`0x${'0'.repeat(64)}`);
  const reopened = await openPPv2Session({ candidate, configuration: config });
  reopened.close();
});

test('restores uncertain relays across sessions and refuses public sends while keeping recovery reads available', async () => {
  const { relayFixture } = require('../../../test/helpers/ppv2-relay-fixture');
  const { validateRelay } = require('./ppv2-relay-policy');
  const journal = getPPv2RelayJournal(handle('storage'), 0);
  await journal.begin(validateRelay(relayFixture()).attempt);
  const session = await openPPv2Session({ candidate, configuration: config });
  expect(await session.listRelayAttempts()).toHaveLength(1);
  await expect(session.submitPublicOperation({}, {})).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_UNRESOLVED' });
  expect(await session.notes()).toEqual([]);
  session.close();
  const reopened = await openPPv2Session({ candidate, configuration: config });
  await expect(reopened.submitPublicOperation({}, {})).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_UNRESOLVED' });
  expect(await reopened.listRelayAttempts()).toHaveLength(1);
});

test('dedicated signer refuses wallet, Ant, other account and stale-vault derivation', async () => {
  const keys = createPPv2Keystore(handle('keystore'), 0);
  const first = await keys.deriveAt("m/28784'/2'/0'");
  expect(first).toMatch(/^0x[0-9a-f]{64}$/);
  expect(await createPPv2Keystore(handle('keystore'), 0).deriveAt("m/28784'/2'/0'")).toBe(first);
  expect(await createPPv2Keystore(handle('keystore', 1), 1).deriveAt("m/28784'/2'/1'")).not.toBe(first);
  for (const requested of ["m/44'/60'/0'/0/0", "m/44'/60'/0'/0/1", "m/28784'/2'/1'", "m/28784'/1'/0'"]) {
    await expect(keys.deriveAt(requested)).rejects.toMatchObject({ code: 'PRIVATE_DERIVATION_REFUSED' });
  }
  expect(() => createPPv2Keystore(handle('keystore'), 1)).toThrow();
  mockVault = new AbortController();
  await expect(keys.deriveAt("m/28784'/2'/0'")).rejects.toMatchObject({ code: 'PRIVACY_VAULT_LOCKED' });
});

test('encrypts state, restores deterministically and refuses changed identity/deployment bindings', async () => {
  const session = await openPPv2Session({ candidate, configuration: config });
  const key = await host.keystore.deriveAt("m/28784'/2'/0'");
  await host.storage.set('ppv2:controlled:notes', 'private synthetic note');
  await expect(host.storage.set('freedom-ppv2-binding-v1', 'bad')).rejects.toMatchObject({ code: 'PRIVATE_PPV2_STORAGE_REFUSED' });
  const directory = path.join(mockProfile.userDataDir, 'wallet-ppv2-experiment');
  const files = fs.readdirSync(directory);
  expect(files).toHaveLength(1);
  const bytes = fs.readFileSync(path.join(directory, files[0]), 'utf8');
  for (const clear of ['private synthetic note', key, 'TODO-privacy-pools-v2', config.ownerAddress]) expect(bytes).not.toContain(clear);
  session.close();
  const reopened = await openPPv2Session({ candidate, configuration: config });
  expect(await host.storage.get('ppv2:controlled:notes')).toBe('private synthetic note');
  expect(await host.keystore.deriveAt("m/28784'/2'/0'")).toBe(key);
  reopened.close();
  config.deploymentBlock += 1;
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_STATE_MISMATCH' });
  config.deploymentBlock -= 1;
  const restored = await openPPv2Session({ candidate, configuration: config });
  restored.close();
  const file = path.join(directory, files[0]);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')); record.tag = Buffer.alloc(16).toString('base64');
  fs.writeFileSync(file, JSON.stringify(record));
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
});

test('binds account/profile storage and rejects a changed SDK binding in the same namespace', async () => {
  const h = handle('storage');
  const first = await createPPv2Storage({ handle: h, accountIndex: 0, binding: { sdk: 'reviewed' } });
  await first.set('ppv2:controlled:x', 'value');
  await expect(createPPv2Storage({ handle: h, accountIndex: 0, binding: { sdk: 'changed' } }))
    .rejects.toMatchObject({ code: 'PRIVATE_PPV2_STATE_MISMATCH' });
  const other = await createPPv2Storage({ handle: handle('storage', 1), accountIndex: 1, binding: { sdk: 'reviewed' } });
  expect(await other.get('ppv2:controlled:x')).toBeNull();
  mockProfile = { ...mockProfile, id: 'other' };
  await expect(first.get('ppv2:controlled:x')).rejects.toMatchObject({ code: 'PRIVATE_PPV2_SCOPE' });
});

test('owns one session per account, isolates close, and limits broadcasting to reviewed public handoff', async () => {
  const a = await openPPv2Session({ candidate, configuration: config });
  const old = host;
  const b = await openPPv2Session({ candidate, configuration: config, accountIndex: 1 });
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_BUSY' });
  expect(params.deploymentBlock).toBe('0x64');
  expect(() => params.factories.proofService.proveDeposit({})).toThrow();
  expect(a.descriptor).toMatchObject({ verified: false, broadcasting: 'reviewed-public-only', proving: false });
  for (const name of ['prepareShield', 'prepareUnshield', 'prepareTransfer', 'exportAccount', 'importAccount', 'sync', 'broadcast']) expect(a[name]).toBeUndefined();
  a.close();
  await expect(old.keystore.deriveAt("m/28784'/2'/0'")).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  await expect(old.storage.set('ppv2:controlled:x', 'late')).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  expect(await b.isRegistered()).toBe(false);
  mockVault.abort();
  await expect(b.isRegistered()).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});

test('serializes SDK operations and rejects late results when the vault locks', async () => {
  let finish;
  candidate.createPlugin = async () => ({ ...snapshot(), notes: () => new Promise((resolve) => { finish = resolve; }) });
  const session = await openPPv2Session({ candidate, configuration: config });
  const pending = session.notes();
  const failed = expect(pending).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  await expect(session.balance()).rejects.toMatchObject({ code: 'PRIVATE_PPV2_BUSY' });
  mockVault.abort(); await failed; finish(['late']);
});

test('cancelled factory cannot publish a late session or write state', async () => {
  let finish;
  candidate.createPlugin = async (h) => { host = h; return new Promise((resolve) => { finish = resolve; }); };
  const pending = openPPv2Session({ candidate, configuration: config });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const failed = expect(pending).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  mockVault.abort(); await failed; finish(snapshot());
  await expect(host.storage.set('ppv2:controlled:late', 'x')).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});

test('refuses production, unreviewed candidates and SDK diagnostics', async () => {
  mockAvailable = false;
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_UNAVAILABLE' });
  mockAvailable = true;
  await expect(openPPv2Session({ candidate: { ...candidate, sdk: 'other' }, configuration: config })).rejects.toThrow();
  await expect(openPPv2Session({ candidate, configuration: { ...config, chainId: 1 } })).rejects.toThrow();
  candidate.createPlugin = async () => ({ ...snapshot(), notes: async () => { throw new Error('sensitive URL and note'); } });
  const session = await openPPv2Session({ candidate, configuration: config });
  await expect(session.balance()).rejects.toMatchObject({ code: 'PRIVATE_PPV2_OPERATION_FAILED', message: 'Controlled PPv2 operation failed' });
  session.close();
  candidate.createPlugin = async () => { throw null; };
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_UNAVAILABLE' });
});

test('SDK configuration mutation cannot change main-owned transaction targets', async () => {
  const { Interface } = require('ethers');
  const { REGISTRATION_ABI } = require('./ppv2-public-operations');
  const abi=new Interface(REGISTRATION_ABI);
  candidate.createPlugin=async(_host,p)=>{
    p.deployment.keystoreAddress=`0x${'55'.repeat(20)}`;
    return {...snapshot(),prepareRegisterKeystore:async()=>({__type:'publicOperation',txs:[{
      to:p.deployment.keystoreAddress,value:0n,data:abi.encodeFunctionData('setAuthPolicy',[1n,2n]),
    }]})};
  };
  const session=await openPPv2Session({candidate,configuration:config});
  await expect(session.prepareRegisterKeystore()).rejects.toThrow();
});

test('a viewing-key-only mismatch keeps the session available for recovery and reports the repair state', async () => {
  mockCall.mockResolvedValueOnce(registrationKeys.nullifyingKeyHash).mockResolvedValueOnce(`0x${'33'.repeat(32)}`);
  const session = await openPPv2Session({ candidate, configuration: config });
  expect(await session.notes()).toEqual([]);
  mockCall.mockResolvedValueOnce(registrationKeys.nullifyingKeyHash).mockResolvedValueOnce(`0x${'33'.repeat(32)}`);
  expect(await session.registrationStatus()).toMatchObject({ nullifyingKeyHash: true, viewingKey: false });
  session.close();
});

test('missing initialized storage reports the recovery-specific error and releases the session lease', async () => {
  const session = await openPPv2Session({ candidate, configuration: config }); session.close();
  const directory = path.join(mockProfile.userDataDir, 'wallet-ppv2-experiment');
  fs.renameSync(directory, `${directory}.preserved`);
  await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PROFILE_STORE_MISSING' });
  fs.renameSync(`${directory}.preserved`, directory);
  const restored = await openPPv2Session({ candidate, configuration: config }); restored.close();
});

test('runtime rejection precedes privacy lifetime creation and all external side effects', async () => {
  const runtime = require('./ppv2-runtime');
  runtime.assertPPv2Candidate.mockImplementationOnce(() => { throw Object.assign(new Error('Unreviewed runtime'), { code: 'PRIVATE_PPV2_RUNTIME_INVALID' }); });
  const privacy = require('./privacy-session').openPrivacySession; privacy.mockClear();
  const endpoint = jest.spyOn(require('../tor-manager'), 'getWalletSocksEndpoint');
  const storage = jest.spyOn(require('./ppv2-storage'), 'createPPv2Storage');
  try {
    await expect(openPPv2Session({ candidate, configuration: config })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RUNTIME_INVALID' });
    expect(privacy).not.toHaveBeenCalled(); expect(endpoint).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
    expect(candidate.createPlugin).not.toHaveBeenCalled(); expect(mockCall).not.toHaveBeenCalled();
  } finally { endpoint.mockRestore(); storage.mockRestore(); }
});

test('archived relay commitment cannot reach emergency-exit proving or public simulation even if the SDK reports it active', async () => {
  const { relayFixture, word } = require('../../../test/helpers/ppv2-relay-fixture');
  const { validateRelay } = require('./ppv2-relay-policy');
  const { attempt, settlement } = validateRelay(relayFixture());
  const journal = getPPv2RelayJournal(handle('storage'), 0);
  await journal.begin(attempt, settlement);
  await journal.observe(attempt.id, { status: 'included', transactionHash: word(71), blockHash: word(72),
    blockNumber: 16, trust: 'unverified-rpc' }, 0);
  const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(old);
  try { await journal.resolve(attempt.id, 1); } finally { clock.mockRestore(); }
  await journal.archiveResolved([{ id: attempt.id, revision: 2 }], [{ blockNumber: 20, blockHash: word(73) }]);
  const notes = jest.fn(async () => [{ commitment: attempt.commitment, value: 10000n, asset: { __type: 'native' }, status: 'active' }]);
  candidate.createPlugin.mockImplementation(async () => ({ ...snapshot(), notes }));
  const session = await openPPv2Session({ candidate, configuration: config,
    proving: { sdkEntry: '/reviewed/sdk.cjs', ragequitProverEntry: '/reviewed/serial-prover.cjs' } });
  mockCall.mockClear(); mockExitPrepare.mockClear();
  await expect(session.prepareNativeRagequit(attempt.commitment)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_REUSE_REFUSED' });
  await expect(session.submitPublicOperation({ kind: 'ppv2-native-ragequit', commitment: attempt.commitment }, {}))
    .rejects.toMatchObject({ code: 'PRIVATE_PPV2_RELAY_REUSE_REFUSED' });
  expect(notes).not.toHaveBeenCalled(); expect(mockExitPrepare).not.toHaveBeenCalled(); expect(mockCall).not.toHaveBeenCalled();
  session.close();
});

test('successful reviewed public archival closes its session and frees the account lease; a refused archival does not', async () => {
  const network = jest.spyOn(require('./private-transaction-network'), 'getPrivateTransactionNetwork');
  const archive = jest.fn().mockRejectedValueOnce(Object.assign(new Error('Not eligible'), { code: 'PRIVATE_HISTORY_ARCHIVE_REFUSED' }))
    .mockResolvedValueOnce({ archived: 1, retained: 1, capacity: 1024, stopsRevalidation: true, evidence: 'unverified-rpc' });
  network.mockReturnValue({ archiveResolvedSubmissions: archive });
  try {
    const session = await openPPv2Session({ candidate, configuration: config });
    await expect(session.archivePublicHistory({})).rejects.toMatchObject({ code: 'PRIVATE_HISTORY_ARCHIVE_REFUSED' });
    expect(await session.notes()).toEqual([]);
    expect(await session.archivePublicHistory({})).toMatchObject({ archived: 1, sessionClosed: true });
    await expect(session.notes()).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
    const reopened = await openPPv2Session({ candidate, configuration: config }); reopened.close();
  } finally { network.mockRestore(); }
});


test('direct route requires its top-level choice and marker, and exposure remains visible after Tor reopening', async () => {
  const { MARKER } = require('../networks/direct-testnet-transport');
  await expect(openPPv2Session({ candidate, configuration: config, relayerRoute: 'direct-sepolia-test' })).rejects.toThrow();
  fs.writeFileSync(path.join(mockProfile.userDataDir, MARKER), JSON.stringify({ version: 1, chainId: 11155111,
    profileId: mockProfile.id, disposable: true, relayerExposure: 'direct-ip' }));
  const direct = await openPPv2Session({ candidate, configuration: config, relayerRoute: 'direct-sepolia-test' });
  expect(direct.descriptor).toMatchObject({ relayerTransport: 'direct', relayerTorProtected: false, identityMayBeIpLinked: true });
  direct.close();
  fs.renameSync(path.join(mockProfile.userDataDir, MARKER), path.join(mockProfile.userDataDir, MARKER + '.saved'));
  const torSession = await openPPv2Session({ candidate, configuration: config });
  expect(torSession.descriptor).toMatchObject({ relayerTransport: 'tor', identityMayBeIpLinked: true }); torSession.close();
  await expect(openPPv2Session({ candidate, configuration: { ...config, relayerRoute: 'direct-sepolia-test' } })).rejects.toThrow();
  fs.renameSync(path.join(mockProfile.userDataDir, MARKER + '.saved'), path.join(mockProfile.userDataDir, MARKER));
  mockEndpoint = null;
  await expect(openPPv2Session({ candidate, configuration: config, relayerRoute: 'direct-sepolia-test' })).rejects.toThrow();
});


test('durable public exit blocks stale SDK notes, balances and spending before proving or relay work across reopening', async () => {
  const { Interface } = require('ethers');
  const { transactionIntent } = require('./private-transaction-intent');
  const { getPrivateSubmissionJournal } = require('./private-submission-journal');
  const { word } = require('../../../test/helpers/ppv2-relay-fixture');
  const commitment = word(7);
  const note = { commitment, value: 10000n, asset: { __type: 'native' }, status: 'active', labelState: 'approved' };
  const notes = jest.fn(async () => [note]);
  candidate.createPlugin.mockImplementation(async () => ({ ...snapshot(), notes }));
  candidate.createBroadcaster = jest.fn(); candidate.inspectChange = jest.fn();
  config.relayers[0].quoteSigner = config.ownerAddress;
  const data = new Interface([require('./ppv2-ragequit-policy').RAGEQUIT_ABI]).encodeFunctionData('ragequit',
    [[[1n, 2n], [[3n, 4n], [5n, 6n]], [7n, 8n], [1n, 7n, 3n, BigInt(config.ownerAddress), 10000n, BigInt(require('./ppv2-deposit-policy').NATIVE), 4n]]]);
  const intent = transactionIntent('ppv2-native-ragequit', { chainId: 11155111, from: config.ownerAddress,
    to: config.deployment.poolAddress, value: 0n, data });
  const journal = getPrivateSubmissionJournal(scope.getContext({ kind: 'public-address', principal: config.ownerAddress,
    role: 'transaction-rpc', chainId: 11155111 }));
  await journal.begin(word(90), 1, intent);
  await journal.observe(word(90), { status: 'included', trust: 'unverified', observedAt: Date.now(), confirmations: 12,
    blockNumber: 20, blockHash: word(21) }, 0);
  await journal.resolve(word(90), 1, 12);
  for (let i = 0; i < 2; i++) {
    const session = await openPPv2Session({ candidate, configuration: config,
      proving: { sdkEntry: '/reviewed/sdk.cjs', ragequitProverEntry: '/reviewed/serial-prover.cjs', transactProverEntry: '/reviewed/serial-prover.cjs' } });
    expect(await session.notes()).toMatchObject([{ status: 'exit_pending', labelState: 'unknown' }]);
    expect(await session.balance()).toMatchObject([{ tag: 'spendable', amount: 0n }, { tag: 'unspendable', amount: 10000n }]);
    mockCall.mockClear(); notes.mockClear(); mockExitPrepare.mockClear(); mockTransactPrepare.mockClear();
    await expect(session.prepareNativeRagequit(commitment)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
    await expect(session.submitPublicOperation({ kind: 'ppv2-native-ragequit', commitment }, {})).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
    await expect(session.prepareNativeWithdrawal({ commitment, amount: 100n, maxFee: 10n, recipient: config.ownerAddress }))
      .rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
    expect(await session.listRelayAttempts()).toEqual([]);
    expect(notes).not.toHaveBeenCalled(); expect(mockExitPrepare).not.toHaveBeenCalled(); expect(mockTransactPrepare).not.toHaveBeenCalled();
    expect(mockCall).not.toHaveBeenCalled(); expect(mockFetch).not.toHaveBeenCalled();
    session.close();
  }
});


test('an exit reservation appearing during review prevents signing after approval', async () => {
  const { getPrivateSubmissionJournal } = require('./private-submission-journal');
  const { word } = require('../../../test/helpers/ppv2-relay-fixture');
  const commitment = word(7);
  candidate.createPlugin.mockImplementation(async () => ({ ...snapshot(), notes: async () => [
    { commitment, value: 10000n, asset: { __type: 'native' }, status: 'active', labelState: 'approved' }] }));
  const sign = jest.fn();
  mockPublicSubmit = async (prepared, options) => { await options.review(prepared); return sign(); };
  const session = await openPPv2Session({ candidate, configuration: config });
  const journal = getPrivateSubmissionJournal(scope.getContext({ kind: 'public-address', principal: config.ownerAddress,
    role: 'transaction-rpc', chainId: 11155111 }));
  await expect(session.submitPublicOperation({ kind: 'ppv2-native-ragequit', commitment }, { review: async () => {
    await journal.begin(word(90), 1, { kind: 'ppv2-native-ragequit', digest: word(4), pool: config.deployment.poolAddress, commitment });
    return true;
  } })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
  expect(sign).not.toHaveBeenCalled(); expect(mockFetch).not.toHaveBeenCalled(); session.close();
});

test('startup timeout releases the lease and refuses late plugin publication and storage writes', async () => {
  let finish, oldHost;
  candidate.createPlugin = async h => { oldHost = h; return new Promise(resolve => { finish = resolve; }); };
  const progress = [];
  const opening = openPPv2Session({ candidate, configuration: config, startupTimeoutMs: 30, onProgress: event => progress.push(event) });
  await expect(opening).rejects.toMatchObject({ code: 'PRIVATE_PPV2_TASK_TIMEOUT' });
  expect(progress.at(-1)).toMatchObject({ task: 'session-open', stage: 'timed-out' });
  expect(progress.every(e => Object.keys(e).every(k => ['task', 'stage', 'elapsedMs', 'completedWindows', 'scannedBlocks'].includes(k)))).toBe(true);
  candidate.createPlugin = async () => snapshot();
  const reopened = await openPPv2Session({ candidate, configuration: config });
  finish(snapshot()); await new Promise(resolve => setImmediate(resolve));
  await expect(oldHost.storage.set('ppv2:controlled:late', 'secret')).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  expect(await reopened.notes()).toEqual([]); reopened.close();
});

test.each([0, -1, 300001, 1.5, '100'])('refuses invalid startup budget %s before creating a plugin', async startupTimeoutMs => {
  await expect(openPPv2Session({ candidate, configuration: config, startupTimeoutMs })).rejects.toMatchObject({ code: 'PRIVATE_PPV2_UNAVAILABLE' });
  expect(candidate.createPlugin).not.toHaveBeenCalled();
});
