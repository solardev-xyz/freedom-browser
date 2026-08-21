// One-shot migration of legacy ENS / wallet config into the network-registry
// user layer (the network-config.json shape: { networks, endpointSources,
// removedSources }). Pure — all I/O is the caller's job (network-registry
// runs this once when network-config.json is absent).
//
// The production input is quorum-era settings.json. kolibri-branch dev
// settings (ensResolutionMethod / ensColibri*) are tolerated and mapped
// the same way. See research/wallet-colibri-integration.md "Migration".

// Legacy quorum-param defaults (the pre-rework settings-store DEFAULT_SETTINGS).
// A user who never tuned quorum has exactly these — no override is emitted.
const LEGACY_QUORUM_DEFAULTS = {
  k: 3,
  m: 2,
  timeoutMs: 5000,
  anchor: 'latest',
  anchorTtlMs: 30000,
};

function dropUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// Resolved verification strategy for mainnet. kolibri-era ensResolutionMethod
// wins when present (developers who ran that branch); otherwise the quorum-era
// flags decide: a configured custom RPC means the user deliberately pointed at
// their own node ('direct'), everyone else upgrades to 'colibri' (quorum was
// the shipped default, never an explicit choice — see the doc's threat model).
function resolveMethod(settings) {
  if (settings.ensResolutionMethod) {
    return settings.ensResolutionMethod === 'custom-rpc'
      ? 'direct'
      : settings.ensResolutionMethod;
  }
  return settings.enableEnsCustomRpc === true ? 'direct' : 'colibri';
}

// A quorum override, but only when the user tuned at least one param off the
// legacy default — otherwise null (builtin chains.json already carries the
// defaults). The emitted block is complete (unset params filled from default).
function resolveQuorum(settings) {
  const tuned = {
    k: settings.ensQuorumK,
    m: settings.ensQuorumM,
    timeoutMs: settings.ensQuorumTimeoutMs,
    anchor: settings.ensBlockAnchor,
    anchorTtlMs: settings.ensBlockAnchorTtlMs,
  };
  const deviates = Object.entries(tuned).some(
    ([key, value]) => value !== undefined && value !== LEGACY_QUORUM_DEFAULTS[key]
  );
  if (!deviates) return null;
  return { ...LEGACY_QUORUM_DEFAULTS, ...dropUndefined(tuned) };
}

// Diff an edited public-RPC list against the builtin mainnet keyless rpc
// sources. Returns { removed: [builtinId], added: {id: source} }, or null
// when the list is absent or unchanged from the builtin set.
function diffPublicRpcList(userList, builtinSources) {
  if (!Array.isArray(userList)) return null;

  const builtinUrlById = {};
  for (const [id, src] of Object.entries(builtinSources)) {
    if (src.role === 'rpc' && !src.keyed && src.coverage && src.coverage['1']) {
      builtinUrlById[id] = src.coverage['1'];
    }
  }
  const builtinUrls = new Set(Object.values(builtinUrlById));
  const userUrls = new Set(userList.map((u) => (u || '').trim()).filter(Boolean));

  // An empty list is not "the user removed every RPC" — the legacy resolver
  // fell back to the default set when ensPublicRpcProviders was empty, so an
  // empty list means no customization. Keep the builtin sources.
  if (userUrls.size === 0) return null;

  const unchanged =
    userUrls.size === builtinUrls.size && [...userUrls].every((u) => builtinUrls.has(u));
  if (unchanged) return null;

  const removed = Object.entries(builtinUrlById)
    .filter(([, url]) => !userUrls.has(url))
    .map(([id]) => id);

  const added = {};
  let i = 0;
  for (const url of userUrls) {
    if (!builtinUrls.has(url)) {
      added[`migrated-eth-rpc-${i++}`] = {
        role: 'rpc',
        keyed: false,
        coverage: { '1': url },
      };
    }
  }
  return { removed, added };
}

// settings    — raw legacy settings.json
// builtinSources — endpoint-sources.json (to diff the edited RPC list against)
function migrateLegacyConfig({ settings = {}, builtinSources = {} } = {}) {
  const networks = {};
  const endpointSources = {};
  const removedSources = [];

  // ── Network 1 (Ethereum) — every legacy ENS key targets mainnet ──
  const net1 = {};
  const method = resolveMethod(settings);
  // builtin chains.json defaults mainnet to 'colibri' — only record a
  // deviation so an unmigrated user's network-config stays minimal.
  if (method !== 'colibri') {
    net1.verification = {
      primary: method,
      order:
        method === 'direct'
          ? ['myotis', 'direct', 'quorum']
          : ['myotis', 'quorum'],
      // The legacy UI selected one winning method; do not let a newly-added
      // verified fallback overtake it before the user saves the new policy.
      preferVerified: false,
    };
  }
  const quorum = resolveQuorum(settings);
  if (quorum) {
    net1.quorum = quorum;
  }
  // Only a kolibri-era user who turned ZK off needs recording (builtin
  // default is on); enableEnsQuorum=false is intentionally ignored — that
  // user upgrades to colibri like everyone else.
  if (settings.ensColibriZkProof === false) {
    net1.zkProof = false;
  }
  if (Object.keys(net1).length > 0) {
    networks['1'] = net1;
  }

  // Custom ENS RPC URL → a user endpoint source covering mainnet.
  if (settings.enableEnsCustomRpc === true) {
    const url = (settings.ensRpcUrl || '').trim();
    if (url) {
      endpointSources['migrated-eth-custom'] = {
        role: 'rpc',
        keyed: false,
        coverage: { '1': url },
      };
    }
  }

  // Edited public-RPC list → removed builtin sources + added user sources.
  const listDiff = diffPublicRpcList(settings.ensPublicRpcProviders, builtinSources);
  if (listDiff) {
    removedSources.push(...listDiff.removed);
    Object.assign(endpointSources, listDiff.added);
  }

  // Custom chains are not migrated: their rpcUrls live on the chain
  // definition in custom-chains.json, which network-registry's load()
  // already surfaces as endpoint sources — copying them here would
  // double every custom-chain RPC.
  return { networks, endpointSources, removedSources };
}

module.exports = { migrateLegacyConfig };
