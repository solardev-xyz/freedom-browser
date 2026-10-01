/** Main-only, development/Sepolia PPv2 session assembly. The caller supplies
 * the reviewed scratch adapter, never a renderer-selected module. No SDK is
 * installed in the application. Only main-owned reviewed public handoff may sign;
 * the plugin has no signing/broadcast capability.
 */
const { createPrivacyScope, getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { openPrivacySession } = require('./privacy-session');
const { createPPv2Keystore } = require('../identity/ppv2-keys');
const { createPPv2Storage } = require('./ppv2-storage');
const { createKohakuProvider } = require('../networks/kohaku-provider');
const { createKohakuNetworkRouter } = require('../networks/kohaku-network-router');
const { createPPv2DepositProver } = require('./ppv2-deposit-prover');
const { createPPv2PublicOperations } = require('./ppv2-public-operations');
const { inspectPPv2NoteRecovery } = require('./ppv2-note-recovery');
const { createPPv2RagequitProver } = require('./ppv2-ragequit-prover');
const { createPPv2TransactProver } = require('./ppv2-transact-prover');
const { createPPv2RelayHandoff } = require('./ppv2-relay-handoff');
const { assertCurrentPPv2Roots } = require('./ppv2-relay-roots');
const { createPPv2RelayReconciliation } = require('./ppv2-relay-reconciliation');
const { createPPv2TokenPolicy } = require('./ppv2-token-policy');
const { NATIVE } = require('./ppv2-deposit-policy');
const { getPPv2RelayJournal } = require('./ppv2-relay-journal');
const PPV2_CANDIDATE = Object.freeze({
  kohaku: '6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e',
  sdk: 'fe0244e3f14110efd83db02c60c96517dea9cd5a',
  compatibility: 'freedom-controlled-session-v1',
});
const active = new Map();
const address = (value) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/.test(value);
const unavailable = () => privacyError('PRIVATE_PPV2_UNAVAILABLE', 'Controlled PPv2 session is unavailable');
const proofUnavailable = () => { throw privacyError('PRIVATE_PPV2_PROOF_UNAVAILABLE', 'Session proving is not qualified'); };
const noProof = Object.freeze(Object.fromEntries(['proveDeposit', 'proveTransact', 'proveRagequit', 'verifyDeposit',
  'verifyTransact', 'verifyRagequit', 'loadCircuit', 'formatForEVM'].map((name) => [name, proofUnavailable])));

async function openPPv2Session({ candidate, accountIndex = 0, configuration, proving, relayerRoute = 'tor' }) {
  if (!['tor', 'direct-sepolia-test'].includes(relayerRoute) || !require('../settings-store').isWalletTorExperimentAvailable() ||
      !Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > 65535 ||
      !candidate || typeof candidate.createPlugin !== 'function' || typeof candidate.inspectRegistration !== 'function' ||
      Object.keys(PPV2_CANDIDATE).some((name) => candidate[name] !== PPV2_CANDIDATE[name])) throw unavailable();
  require('./ppv2-runtime').assertPPv2Candidate(candidate, proving);
  // Snapshot before any await; neither the caller nor SDK may change grants.
  let config;
  try { config = structuredClone(configuration); } catch { throw unavailable(); }
  const deploymentKeys = ['poolAddress', 'entrypointAddress', 'keystoreAddress', 'aspRegistryAddress', 'relaySwapsAddress'];
  if (!config || Object.hasOwn(config, 'relayerRoute') || config.networks?.some((g) => Object.hasOwn(g, 'route')) || config.chainId !== 11155111 || !address(config.ownerAddress) ||
      !config.deployment || Object.keys(config.deployment).length !== deploymentKeys.length ||
      !deploymentKeys.slice(0, 4).every((name) => address(config.deployment[name])) ||
      !/^0x[0-9a-f]{40}$/i.test(config.deployment.relaySwapsAddress) ||
      !Number.isSafeInteger(config.deploymentBlock) || config.deploymentBlock < 0 ||
      !Array.isArray(config.contracts) || !deploymentKeys.slice(0, 4).every((name) =>
        config.contracts.some((grant) => grant.address?.toLowerCase() === config.deployment[name].toLowerCase())) ||
      !config.asp?.baseUrl || !config.asp.publicKey || !Array.isArray(config.relayers) || !config.relayers.length ||
      !config.artifacts?.manifest || !Array.isArray(config.artifacts.gatewayUrls) ||
      !Array.isArray(config.networks) || !config.networks.some((group) => group.role === 'asp') ||
      !config.networks.some((group) => group.role === 'relayer')) throw unavailable();
  // The pinned SDK default manifest omits 0x while its builder schema requires
  // it. Its artifact verifier strips the prefix; digest bytes stay identical.
  for (const entry of Object.values(config.artifacts.manifest)) {
    for (const field of ['wasmSha256', 'provingKeySha256', 'verificationKeySha256']) {
      if (typeof entry?.[field] === 'string' && /^[0-9a-f]{64}$/i.test(entry[field])) entry[field] = `0x${entry[field]}`;
    }
  }
  const createPlugin = candidate.createPlugin;
  const parent = openPrivacySession();
  const subject = { kind: 'private-account', principal: `ppv2:${accountIndex}`, protocol: 'privacy-pools-v2',
    deployment: 'sepolia', chainId: 11155111 };
  const parentHandle = parent.getContext({ ...subject, role: 'session' });
  const parentContext = getPrivacyContext(parentHandle);
  const tor = require('../tor-manager');
  const endpoint = tor.getWalletSocksEndpoint();
  if (!endpoint || endpoint.signal.aborted) throw unavailable();
  const lease = JSON.stringify([parentContext.profileId, subject.principal]);
  if (active.has(lease)) throw privacyError('PRIVATE_PPV2_BUSY', 'This PPv2 account already has an open session');
  const scope = createPrivacyScope({ profileId: parentContext.profileId, signal: AbortSignal.any([parent.signal, endpoint.signal]),
    isCurrent: () => { try { getPrivacyContext(parentHandle); return tor.getWalletSocksEndpoint() === endpoint; } catch { return false; } } });
  const handle = (role) => scope.getContext({ ...subject, role });
  const sessionHandle = handle('session');
  const directTest = require('../networks/direct-testnet-transport');
  let relayerPrivacy;
  try {
    if (relayerRoute !== 'tor') directTest.assertDirectTest(handle('relayer'));
    relayerPrivacy = Object.freeze({ relayerTransport: relayerRoute === 'tor' ? 'tor' : 'direct',
      relayerTorProtected: relayerRoute === 'tor', identityMayBeIpLinked: directTest.directTestExposure() });
  } catch (error) { scope.close(); throw error; }
  let plugin = null, busy = false;
  const release = () => { plugin = null; if (active.get(lease) === scope) active.delete(lease); };
  scope.signal.addEventListener('abort', release, { once: true });
  active.set(lease, scope);
  const close = () => scope.close();
  try {
    const relayJournal = getPPv2RelayJournal(handle('storage'), accountIndex);
    await relayJournal.list(); // Corrupt/foreign state must not look like no attempts.
    if (relayerPrivacy.identityMayBeIpLinked) await relayJournal.recordDirectExposure();
    relayerPrivacy = Object.freeze({ ...relayerPrivacy, identityMayBeIpLinked: await relayJournal.hasDirectExposure() });
    const ownerHandle = scope.getContext({ kind: 'public-address', principal: config.ownerAddress.toLowerCase(), chainId: 11155111, role: 'transaction-rpc' });
    const provider = createKohakuProvider({ handle: handle('protocol-rpc'), contracts: config.contracts, publicReadHandle: ownerHandle,
      publicContracts: [config.deployment.keystoreAddress, ...(config.erc20Tokens || [])],
      logFloors: deploymentKeys.slice(0, 4).map((name) => ({ address: config.deployment[name], fromBlock: config.deploymentBlock })) });
    const transport = createKohakuNetworkRouter(config.networks.map(({ role, endpoints }) => ({ handle: handle(role), endpoints, route: role === 'relayer' ? relayerRoute : 'tor' })));
    let capture = null;
    const network = Object.freeze({ fetch: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const pathname = decodeURIComponent(url.pathname).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
      if (/\/v1\/relay(?:\/|$)/i.test(pathname)) {
        if (!capture || capture.request || typeof input !== 'string' || init.method !== 'POST' || typeof init.body !== 'string') throw unavailable();
        capture.request = { endpoint: input, body: init.body };
        throw privacyError('PRIVATE_PPV2_CAPTURE_ONLY', 'Prepared relay captured without transmission');
      }
      return transport.fetch(input, init);
    } });
    const keystore = createPPv2Keystore(handle('keystore'), accountIndex);
    const registrationKeys = structuredClone(await scope.run(sessionHandle, () => candidate.inspectRegistration(keystore, accountIndex)));
    getPrivacyContext(sessionHandle);
    const binding = { candidate: PPV2_CANDIDATE, ownerAddress: config.ownerAddress.toLowerCase(),
      deployment: Object.fromEntries(deploymentKeys.map((name) => [name, config.deployment[name].toLowerCase()])),
      deploymentBlock: config.deploymentBlock, asp: config.asp, artifacts: config.artifacts };
    const storage = await createPPv2Storage({ handle: handle('storage'), accountIndex, binding });
    const depositProver = proving ? createPPv2DepositProver({ handle: handle('prover'), artifactHandle: handle('artifacts'),
      sdkEntry: proving.sdkEntry, directory: proving.directory, onProgress: proving.onProgress, manifest: config.artifacts.manifest,
      inspectNote: typeof candidate.inspectChange === 'function' ? (owner, notes) => candidate.inspectChange(keystore, accountIndex, owner, notes) : undefined }) : null;
    const ragequitProver = proving?.ragequitProverEntry ? createPPv2RagequitProver({ handle: handle('prover'), artifactHandle: handle('artifacts'),
      sdkEntry: proving.sdkEntry, proverEntry: proving.ragequitProverEntry, directory: proving.directory,
      onProgress: proving.onProgress, manifest: config.artifacts.manifest }) : null;
    const transactProver = proving?.transactProverEntry ? createPPv2TransactProver({ handle: handle('prover'), artifactHandle: handle('artifacts'),
      sdkEntry: proving.sdkEntry, proverEntry: proving.transactProverEntry, directory: proving.directory,
      manifest: config.artifacts.manifest, onProgress: proving.onProgress }) : null;
    if (transactProver && (typeof candidate.createBroadcaster !== 'function' || typeof candidate.inspectChange !== 'function')) throw unavailable();
    let proofKind = null;
    const proofService = Object.freeze({ ...noProof, ...depositProver?.service, ...ragequitProver?.service, ...transactProver?.service,
      formatForEVM: (proof) => {
        if (proofKind === 'deposit') return depositProver.service.formatForEVM(proof);
        if (proofKind === 'transact') return transactProver.service.formatForEVM(proof);
        if (proofKind === 'ragequit') return ragequitProver.service.formatForEVM(proof);
        return proofUnavailable();
      } });
    const host = Object.freeze({ provider, network, keystore, storage });
    const params = { chainId: 11155111n, ownerAddress: config.ownerAddress, accountIndex,
      deployment: structuredClone(config.deployment), deploymentBlock: `0x${config.deploymentBlock.toString(16)}`,
      asp: structuredClone(config.asp), relayers: structuredClone(config.relayers), artifacts: structuredClone(config.artifacts),
      storeKey: 'controlled', revocableKeyGapLimit: 20, factories: { proofService } };
    const created = await scope.run(sessionHandle, () => createPlugin(host, params));
    getPrivacyContext(sessionHandle);
    plugin = created;
    const tokenPolicy = createPPv2TokenPolicy({ configuration: config, provider });
    const publicOperations = createPPv2PublicOperations({ scope, configuration: config, provider, tokenPolicy, registrationKeys, accountIndex });
    await publicOperations.checkRegistration();
    const relayReconciliation = () => createPPv2RelayReconciliation({ handle: handle('protocol-rpc'), journal: relayJournal,
      getOperationHandle: (id) => scope.getContext({ ...subject, role: 'protocol-rpc', operation: id }) });
    const publicNetwork = () => require('./private-transaction-network').getPrivateTransactionNetwork(
      ownerHandle);
    const withdrawals = new WeakMap();
    async function availableToSpend(signal) {
      const check = () => { if (signal?.aborted) throw unavailable(); getPrivacyContext(sessionHandle); };
      check();
      if ((await relayJournal.list()).some((r) => r.resolution)) await relayReconciliation().refreshResolved(signal);
      await relayJournal.assertCanSubmit();
      const client = publicNetwork();
      await client.assertCanSubmit(signal); check();
    }
    async function prepareWithdrawal(args) {
      if (!transactProver || !address(args.recipient) || !config.relayers.every((r) => address(r.quoteSigner))) throw unavailable();
      const request = { ...args, recipient: args.recipient.toLowerCase() };
      const token = request.token ?? NATIVE;
      if (token !== NATIVE) tokenPolicy.assertToken(token);
      const asset = token === NATIVE ? { __type: 'native' } : { __type: 'erc20', contract: token.toLowerCase() };
      await availableToSpend();
      const note = (await plugin.notes(undefined, true)).find((n) => n.commitment === request.commitment);
      if (!note || note.status !== 'active' || (token === NATIVE ? note.asset?.__type !== 'native' :
          note.asset?.__type !== 'erc20' || note.asset.contract.toLowerCase() !== token.toLowerCase())) {
        throw privacyError('PRIVATE_PPV2_NOTE_UNAVAILABLE', 'Selected note is not currently spendable');
      }
      // Start before both observed heads with a reorg margin. Scanning from
      // deployment for every new attempt would make old pools impractical.
      // Both observations remain unverified, like the settlement logs themselves.
      const latest = await provider.getBlockNumber();
      const finalized = await provider.request({ method: 'eth_getBlockByNumber', params: ['finalized', false] });
      if (!finalized) throw unavailable();
      const earliest = latest < BigInt(finalized.number) ? latest : BigInt(finalized.number);
      const fromBlock = Math.max(config.deploymentBlock, Number(earliest > 1000n ? earliest - 1000n : 0n));
      proofKind = 'transact';
      const captured = {};
      const prepared = await transactProver.prepare({ commitment: note.commitment, value: note.value, owner: config.ownerAddress,
        amount: request.amount, maxFee: request.maxFee, token }, async () => {
        const op = await plugin.prepareUnshield({ asset, amount: request.amount }, request.recipient);
        const selected = op?.relayParams?.selectedQuote?.relayerInfo;
        const trusted = selected && config.relayers.find((r) => r.url === selected.url &&
          r.address.toLowerCase() === selected.address.toLowerCase() && r.processorAddress.toLowerCase() === selected.processorAddress.toLowerCase());
        if (op?.kind !== 'withdrawal' || !trusted || !address(trusted.quoteSigner) ||
            op.relayParams.inputCommitments.length !== 1 || BigInt(op.relayParams.inputCommitments[0]) !== BigInt(note.commitment)) throw unavailable();
        captured.relayer = structuredClone(trusted);
        capture = captured;
        try { await candidate.createBroadcaster(plugin).broadcast(op); } catch { /* Expected capture-only refusal; require the exact request below. */ }
        finally { capture = null; }
        if (!captured.request || captured.request.endpoint !== `${captured.relayer.url.replace(/\/$/, '')}/v1/relay/evm/11155111/withdrawal`) throw unavailable();
        return captured.request;
      });
      getPrivacyContext(sessionHandle);
      const body = JSON.parse(prepared.value.body), proof = prepared.proof;
      if (JSON.stringify(body.proof) !== JSON.stringify({ ...proof.proof, publicSignals: proof.publicSignals })) throw unavailable();
      const change = await candidate.inspectChange(keystore, accountIndex, config.ownerAddress, body.noteData);
      getPrivacyContext(sessionHandle);
      if (BigInt(change.commitment) !== BigInt(proof.publicSignals[1]) || BigInt(change.value) !== note.value - BigInt(proof.publicSignals[5]) ||
          BigInt(change.tokenId) !== BigInt(token)) throw unavailable();
      const word = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;
      const gate = createPPv2RelayHandoff({ handle: handle('relayer'), journal: relayJournal, network: transport, beforeBegin: async (signal, id) => {
        await availableToSpend(signal);
        await assertCurrentPPv2Roots({ handle: scope.getContext({ ...subject, role: 'protocol-rpc', operation: id }),
          deployment: config.deployment, publicSignals: proof.publicSignals, signal });
      },
        verifyProof: async (p) => JSON.stringify(p) === JSON.stringify(proof), privacy: relayerPrivacy }); // Exact proof already verified by the owned process.
      const summary = await gate.prepare({ ...prepared.value, fromBlock, intent: { ...(token === NATIVE ? {} : { token: token.toLowerCase() }),
        kind: token === NATIVE ? 'ppv2-native-withdrawal' : 'ppv2-token-withdrawal', chainId: 11155111,
        owner: config.ownerAddress.toLowerCase(), inputValue: note.value.toString(),
        pool: config.deployment.poolAddress.toLowerCase(), processor: captured.relayer.processorAddress.toLowerCase(),
        relayer: captured.relayer.address.toLowerCase(), quoteSigner: captured.relayer.quoteSigner.toLowerCase(),
        recipient: request.recipient, amount: request.amount.toString(), maxFee: request.maxFee.toString(),
        commitment: note.commitment, publicSignals: proof.publicSignals.map(word) } });
      withdrawals.set(summary, { gate, request: prepared.value }); return summary;
    }
    async function exclusive(task) {
      getPrivacyContext(sessionHandle); if (busy) throw privacyError('PRIVATE_PPV2_BUSY', 'A PPv2 operation is already in progress');
      busy = true;
      try { return await scope.run(sessionHandle, task); } finally { busy = false; }
    }
    const submitWithdrawal = (prepared, review) => exclusive(async () => {
      const plan = withdrawals.get(prepared); if (!plan) throw unavailable(); withdrawals.delete(prepared);
      return plan.gate.submit(prepared, { review, invoke: async (net) => {
        const response = await net.fetch(plan.request.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: plan.request.body });
        return response.json();
      } });
    });
    async function call(method, ...args) {
      getPrivacyContext(sessionHandle);
      if (busy) throw privacyError('PRIVATE_PPV2_BUSY', 'A PPv2 operation is already in progress');
      busy = true;
      try {
        return await scope.run(sessionHandle, async () => {
          if (method === 'prepareTokenWithdrawal') tokenPolicy.assertToken(args[0].token);
          if (['prepareNativeWithdrawal', 'prepareTokenWithdrawal'].includes(method)) return prepareWithdrawal(args[0]);
          if (method === 'prepareTokenApproval') {
            await availableToSpend(); return publicOperations.tokenApproval(args[0]);
          }
          if (method === 'prepareTokenDeposit') {
            await availableToSpend();
            await publicOperations.checkRegistration(true);
            const state = await tokenPolicy.read(args[0]);
            if (state.allowance !== state.total) throw privacyError('PRIVATE_PPV2_ALLOWANCE_REQUIRED', 'Exact token allowance is required before deposit');
            proofKind = 'deposit';
            return depositProver.prepare({ ...state, ownerAddress: config.ownerAddress, entrypointAddress: config.deployment.entrypointAddress },
              () => plugin.prepareShield({ asset: { __type: 'erc20', contract: state.token }, amount: state.amount }));
          }
          if (method === 'prepareNativeDeposit') {
            await availableToSpend();
            await publicOperations.checkRegistration(true);
            proofKind = 'deposit';
            return depositProver.prepare({ ...args[0], ownerAddress: config.ownerAddress, entrypointAddress: config.deployment.entrypointAddress },
              () => plugin.prepareShield({ asset: { __type: 'native' }, amount: args[0].amount }));
          }
          if (['prepareNativeRagequit', 'prepareTokenRagequit'].includes(method)) {
            const token = method === 'prepareTokenRagequit' ? args[0].token : NATIVE;
            if (method === 'prepareTokenRagequit') tokenPolicy.assertToken(token);
            const commitment = method === 'prepareTokenRagequit' ? args[0].commitment : args[0];
            await relayJournal.assertCanExit(commitment);
            const note = (await plugin.notes(undefined, true)).find((note) => note.commitment === commitment);
            if (!note || ['spent', 'exited', 'exit_pending'].includes(note.status) ||
                (token === NATIVE ? note.asset?.__type !== 'native' : note.asset?.contract?.toLowerCase() !== token.toLowerCase())) throw unavailable();
            proofKind = 'ragequit';
            return ragequitProver.prepare({ token, commitment: note.commitment, amount: note.value, ownerAddress: config.ownerAddress,
              poolAddress: config.deployment.poolAddress }, () => plugin.prepareRageQuit(note.commitment));
          }
          if (method === 'inspectNoteRecovery') return inspectPPv2NoteRecovery({ handle: sessionHandle, createPlugin, host, params, plugin });
          return plugin[method](...args);
        });
      } catch (error) {
        // Never forward SDK exceptions (URLs, notes, payloads or nested causes).
        getPrivacyContext(sessionHandle);
        const safe = ['PRIVATE_PPV2_RELAY_REUSE_REFUSED', 'PRIVATE_PPV2_NOTE_UNAVAILABLE', 'PRIVATE_PPV2_ALLOWANCE_REQUIRED', 'PRIVATE_PPV2_REGISTRATION_MISMATCH', 'PRIVATE_SUBMISSION_UNRESOLVED', 'PRIVATE_PPV2_RELAY_UNRESOLVED',
          'PRIVATE_PPV2_RELAY_REFUSED', 'PRIVATE_PPV2_RECONCILIATION_REFUSED', 'PRIVATE_RECONCILIATION_UNAVAILABLE',
          'PRIVATE_PROFILE_MOVED', 'PRIVATE_PROFILE_STORE_MISSING', 'PRIVATE_PROFILE_INVENTORY_INVALID', 'PRIVATE_PROFILE_INVENTORY_MISSING'];
        if (safe.includes(error?.code)) throw privacyError(error.code, 'Controlled PPv2 operation refused');
        throw privacyError('PRIVATE_PPV2_OPERATION_FAILED', 'Controlled PPv2 operation failed');
      } finally { busy = false; proofKind = null; }
    }
    return Object.freeze({
      close,
      descriptor: Object.freeze({ chainId: 11155111, accountIndex, experimental: true, verified: false, ...relayerPrivacy,
        candidate: PPV2_CANDIDATE, proving: !!depositProver, exitProving: !!ragequitProver, withdrawalProving: !!transactProver,
        broadcasting: transactProver ? 'reviewed-public-and-single-asset-withdrawal' : 'reviewed-public-only' }),
      instanceId: () => call('instanceId'),
      isRegistered: () => call('isRegistered'),
      balance: () => call('balance', undefined),
      notes: () => call('notes', undefined, true),
      inspectNoteRecovery: () => call('inspectNoteRecovery'),
      registrationStatus: () => exclusive(() => publicOperations.checkRegistration()),
      prepareRepairViewingKey: () => exclusive(() => publicOperations.repairViewingKey()),
      prepareRegisterKeystore: async () => publicOperations.registration(await call('prepareRegisterKeystore')),
      ...(depositProver ? { prepareNativeDeposit: async ({ amount, maxFee }) => publicOperations.deposit(await call('prepareNativeDeposit', { amount, maxFee })) } : {}),
      ...(depositProver ? {
        prepareTokenApproval: (args) => call('prepareTokenApproval', { ...args }),
        prepareTokenDeposit: async (args) => publicOperations.deposit(await call('prepareTokenDeposit', { ...args })),
      } : {}),
      ...(ragequitProver ? { prepareNativeRagequit: async (commitment) => publicOperations.ragequit(await call('prepareNativeRagequit', commitment)) } : {}),
      ...(ragequitProver ? { prepareTokenRagequit: async (args) => publicOperations.ragequit(await call('prepareTokenRagequit', { ...args })) } : {}),
      ...(transactProver ? {
        prepareNativeWithdrawal: (args) => call('prepareNativeWithdrawal', { ...args, token: NATIVE }),
        submitNativeWithdrawal: submitWithdrawal,
        submitTokenWithdrawal: submitWithdrawal,
        prepareTokenWithdrawal: (args) => call('prepareTokenWithdrawal', { ...args }),
      } : {}),
      archiveRelayHistory: async (policy) => {
        const result = await exclusive(() => relayReconciliation().archiveResolved(policy));
        close(); return Object.freeze({ ...result, sessionClosed: true });
      },
      archivePublicHistory: async (policy) => {
        const result = await exclusive(() => publicNetwork().archiveResolvedSubmissions(policy));
        close(); return Object.freeze({ ...result, sessionClosed: true });
      },
      observeRelayAttempt: (id, options) => exclusive(() => relayReconciliation().observe(id, options)),
      resolveRelayAttempt: (id, review) => exclusive(() => relayReconciliation().resolve(id, review)),
      submitPublicOperation: async (prepared, options) => {
        getPrivacyContext(sessionHandle);
        if (busy) throw privacyError('PRIVATE_PPV2_BUSY', 'A PPv2 operation is already in progress');
        busy = true;
        try {
          const exiting = ['ppv2-native-ragequit', 'ppv2-token-ragequit'].includes(prepared?.kind);
          const checkRelay = async () => {
            if (exiting) {
              await relayJournal.assertCanExit(prepared.commitment);
            } else {
              if ((await relayJournal.list()).some((r) => r.resolution)) await relayReconciliation().refreshResolved();
              await relayJournal.assertCanSubmit();
            }
            getPrivacyContext(sessionHandle);
          };
          await checkRelay();
          if (exiting) {
            const note = (await plugin.notes(undefined, true)).find((n) => n.commitment === prepared.commitment);
            if (!note || ['spent', 'exited', 'exit_pending'].includes(note.status)) throw unavailable();
          }
          const cancelling = exiting && (await relayJournal.list()).some((r) => r.commitment === prepared.commitment && !r.resolution);
          const review = options?.review;
          return await publicOperations.submit(prepared, { ...options, review: typeof review === 'function' ? async (request) => {
            const approved = await review(Object.freeze({ ...request, pendingRelayCancellation: cancelling,
              competingRelayMayWin: cancelling }));
            if (approved === true) await checkRelay();
            return approved;
          } : review });
        }
        finally { busy = false; }
      },
      listRelayAttempts: () => relayJournal.list(),
      listPublicSubmissions: () => publicOperations.list(),
      observePublicSubmission: (hash) => publicOperations.observe(hash),
      resolvePublicSubmission: (hash, policy) => publicOperations.resolve(hash, policy),
    });
  } catch (error) {
    close();
    const safe = ['PRIVATE_PPV2_STATE_MISMATCH', 'PRIVATE_PPV2_REGISTRATION_MISMATCH', 'PRIVATE_STORAGE_UNREADABLE', 'PRIVACY_CONTEXT_REVOKED',
      'PRIVATE_PROFILE_MOVED', 'PRIVATE_PROFILE_STORE_MISSING', 'PRIVATE_PROFILE_INVENTORY_INVALID', 'PRIVATE_PROFILE_INVENTORY_MISSING'];
    if (safe.includes(error?.code)) throw privacyError(error.code, 'Controlled PPv2 session could not be opened');
    throw unavailable();
  }
}

module.exports = { PPV2_CANDIDATE, openPPv2Session };
