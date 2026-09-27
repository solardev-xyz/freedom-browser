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

async function openPPv2Session({ candidate, accountIndex = 0, configuration, proving }) {
  if (!require('../settings-store').isWalletTorExperimentAvailable() ||
      !Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > 65535 ||
      !candidate || typeof candidate.createPlugin !== 'function' ||
      Object.keys(PPV2_CANDIDATE).some((name) => candidate[name] !== PPV2_CANDIDATE[name])) throw unavailable();
  // Snapshot before any await; neither the caller nor SDK may change grants.
  let config;
  try { config = structuredClone(configuration); } catch { throw unavailable(); }
  const deploymentKeys = ['poolAddress', 'entrypointAddress', 'keystoreAddress', 'aspRegistryAddress', 'relaySwapsAddress'];
  if (!config || config.chainId !== 11155111 || !address(config.ownerAddress) ||
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
  const lease = JSON.stringify([parentContext.profileId, subject.principal]);
  if (active.has(lease)) throw privacyError('PRIVATE_PPV2_BUSY', 'This PPv2 account already has an open session');
  const scope = createPrivacyScope({ profileId: parentContext.profileId, signal: parent.signal,
    isCurrent: () => { try { getPrivacyContext(parentHandle); return true; } catch { return false; } } });
  const handle = (role) => scope.getContext({ ...subject, role });
  const sessionHandle = handle('session');
  let plugin = null, busy = false;
  const release = () => { plugin = null; if (active.get(lease) === scope) active.delete(lease); };
  scope.signal.addEventListener('abort', release, { once: true });
  active.set(lease, scope);
  const close = () => scope.close();
  try {
    const relayJournal = getPPv2RelayJournal(handle('storage'), accountIndex);
    await relayJournal.list(); // Corrupt/foreign state must not look like no attempts.
    const provider = createKohakuProvider({ handle: handle('protocol-rpc'), contracts: config.contracts });
    const network = createKohakuNetworkRouter(config.networks.map(({ role, endpoints }) => ({ handle: handle(role), endpoints })));
    const keystore = createPPv2Keystore(handle('keystore'), accountIndex);
    const binding = { candidate: PPV2_CANDIDATE, ownerAddress: config.ownerAddress.toLowerCase(),
      deployment: Object.fromEntries(deploymentKeys.map((name) => [name, config.deployment[name].toLowerCase()])),
      deploymentBlock: config.deploymentBlock, asp: config.asp, artifacts: config.artifacts };
    const storage = await createPPv2Storage({ handle: handle('storage'), accountIndex, binding });
    const depositProver = proving ? createPPv2DepositProver({ handle: handle('prover'), artifactHandle: handle('artifacts'),
      sdkEntry: proving.sdkEntry, directory: proving.directory, onProgress: proving.onProgress, manifest: config.artifacts.manifest }) : null;
    const ragequitProver = proving?.ragequitProverEntry ? createPPv2RagequitProver({ handle: handle('prover'), artifactHandle: handle('artifacts'),
      sdkEntry: proving.sdkEntry, proverEntry: proving.ragequitProverEntry, directory: proving.directory,
      onProgress: proving.onProgress, manifest: config.artifacts.manifest }) : null;
    let proofKind = null;
    const proofService = Object.freeze({ ...noProof, ...depositProver?.service, ...ragequitProver?.service,
      formatForEVM: (proof) => {
        if (proofKind === 'deposit') return depositProver.service.formatForEVM(proof);
        if (proofKind === 'ragequit') return ragequitProver.service.formatForEVM(proof);
        return proofUnavailable();
      } });
    const host = Object.freeze({ provider, network, keystore, storage });
    const params = { chainId: 11155111n, ownerAddress: config.ownerAddress, accountIndex,
      deployment: config.deployment, deploymentBlock: `0x${config.deploymentBlock.toString(16)}`,
      asp: config.asp, relayers: config.relayers, artifacts: config.artifacts,
      storeKey: 'controlled', revocableKeyGapLimit: 20, factories: { proofService } };
    const created = await scope.run(sessionHandle, () => createPlugin(host, params));
    getPrivacyContext(sessionHandle);
    plugin = created;
    const publicOperations = createPPv2PublicOperations({ scope, configuration: config, provider });
    async function call(method, ...args) {
      getPrivacyContext(sessionHandle);
      if (busy) throw privacyError('PRIVATE_PPV2_BUSY', 'A PPv2 operation is already in progress');
      busy = true;
      try {
        return await scope.run(sessionHandle, async () => {
          if (method === 'prepareNativeDeposit') {
            proofKind = 'deposit';
            return depositProver.prepare({ ...args[0], ownerAddress: config.ownerAddress, entrypointAddress: config.deployment.entrypointAddress },
              () => plugin.prepareShield({ asset: { __type: 'native' }, amount: args[0].amount }));
          }
          if (method === 'prepareNativeRagequit') {
            const note = (await plugin.notes(undefined, true)).find((note) => note.commitment === args[0]);
            if (!note || note.asset?.__type !== 'native' || ['spent', 'exited', 'exit_pending'].includes(note.status)) throw unavailable();
            proofKind = 'ragequit';
            return ragequitProver.prepare({ commitment: note.commitment, amount: note.value, ownerAddress: config.ownerAddress,
              poolAddress: config.deployment.poolAddress }, () => plugin.prepareRageQuit(note.commitment));
          }
          if (method === 'inspectNoteRecovery') return inspectPPv2NoteRecovery({ handle: sessionHandle, createPlugin, host, params, plugin });
          return plugin[method](...args);
        });
      } catch {
        // Never forward SDK exceptions (URLs, notes, payloads or nested causes).
        getPrivacyContext(sessionHandle);
        throw privacyError('PRIVATE_PPV2_OPERATION_FAILED', 'Controlled PPv2 operation failed');
      } finally { busy = false; proofKind = null; }
    }
    return Object.freeze({
      close,
      descriptor: Object.freeze({ chainId: 11155111, accountIndex, experimental: true, verified: false,
        candidate: PPV2_CANDIDATE, proving: !!depositProver, exitProving: !!ragequitProver, broadcasting: 'reviewed-public-only' }),
      instanceId: () => call('instanceId'),
      isRegistered: () => call('isRegistered'),
      balance: () => call('balance', undefined),
      notes: () => call('notes', undefined, true),
      inspectNoteRecovery: () => call('inspectNoteRecovery'),
      prepareRegisterKeystore: async () => publicOperations.registration(await call('prepareRegisterKeystore')),
      ...(depositProver ? { prepareNativeDeposit: async ({ amount, maxFee }) => publicOperations.deposit(await call('prepareNativeDeposit', { amount, maxFee })) } : {}),
      ...(ragequitProver ? { prepareNativeRagequit: async (commitment) => publicOperations.ragequit(await call('prepareNativeRagequit', commitment)) } : {}),
      submitPublicOperation: async (prepared, options) => {
        getPrivacyContext(sessionHandle);
        if (busy) throw privacyError('PRIVATE_PPV2_BUSY', 'A PPv2 operation is already in progress');
        busy = true;
        try { await relayJournal.assertCanSubmit(); getPrivacyContext(sessionHandle); return await publicOperations.submit(prepared, options); }
        finally { busy = false; }
      },
      listRelayAttempts: () => relayJournal.list(),
      listPublicSubmissions: () => publicOperations.list(),
      observePublicSubmission: (hash) => publicOperations.observe(hash),
      resolvePublicSubmission: (hash, policy) => publicOperations.resolve(hash, policy),
    });
  } catch (error) {
    close();
    const safe = ['PRIVATE_PPV2_STATE_MISMATCH', 'PRIVATE_STORAGE_UNREADABLE', 'PRIVACY_CONTEXT_REVOKED'];
    if (safe.includes(error?.code)) throw privacyError(error.code, 'Controlled PPv2 session could not be opened');
    throw unavailable();
  }
}

module.exports = { PPV2_CANDIDATE, openPPv2Session };
