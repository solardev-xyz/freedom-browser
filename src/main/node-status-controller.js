'use strict';

const SAFE_MANAGER_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);
const SAFE_MYOTIS_STATES = new Set([
  'disabled',
  'unavailable',
  'off',
  'syncing',
  'ready',
  'error',
]);
const SAFE_MODES = new Set(['bundled', 'reused', 'external', 'disabled', 'none']);

const NODE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'ant',
    name: 'Swarm',
    implementation: 'Ant',
    protocols: Object.freeze(['bzz']),
  }),
  Object.freeze({
    id: 'ipfs',
    name: 'IPFS',
    implementation: 'Freedom IPFS',
    protocols: Object.freeze(['ipfs', 'ipns']),
  }),
  Object.freeze({
    id: 'radicle',
    name: 'Radicle',
    implementation: 'Radicle Node',
    protocols: Object.freeze(['rad']),
  }),
  Object.freeze({
    id: 'tor',
    name: 'Tor',
    implementation: 'Arti',
    protocols: Object.freeze(['onion']),
  }),
]);

const MYOTIS_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'myotis-ethereum',
    name: 'Ethereum light client',
    implementation: 'Myotis',
    protocols: Object.freeze(['ethereum']),
    chainId: 1,
  }),
  Object.freeze({
    id: 'myotis-gnosis',
    name: 'Gnosis light client',
    implementation: 'Myotis',
    protocols: Object.freeze(['gnosis']),
    chainId: 100,
  }),
]);

function defaultDependencies() {
  return {
    getAntStatus: () => require('./ant-manager').getStatus(),
    getIpfsStatus: () => require('./ipfs-manager').getStatus(),
    getRadicleStatus: () => require('./radicle-manager').getCurrentStatus(),
    getTorStatus: () => require('./tor-manager').getStatus(),
    getMyotisStatus: (chainId) => require('./myotis/myotis-manager').publicStatus(chainId),
    getRegistry: () => require('./service-registry').getRegistry(),
    getSettings: () => require('./settings-store').loadSettings(),
  };
}

async function safeRead(read, fallback = null) {
  try {
    return (await read()) ?? fallback;
  } catch {
    return fallback;
  }
}

function safeMode(value) {
  return SAFE_MODES.has(value) ? value : 'none';
}

function safePeerCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : null;
}

function recoveryForState(state) {
  if (state === 'disabled') return 'Enable this service in Freedom settings if the task needs it.';
  if (state === 'unavailable') return 'Install a supported Freedom runtime for this service.';
  if (state === 'error') return 'Open Freedom’s Nodes panel for recovery details.';
  return '';
}

function normalizeManagerNode(definition, rawStatus, mode, enabled = true) {
  const rawState = SAFE_MANAGER_STATES.has(rawStatus?.status) ? rawStatus.status : 'error';
  const state = !enabled || mode === 'disabled' ? 'disabled' : rawState;
  const ready = state === 'running';
  const recovery = recoveryForState(state);
  return Object.freeze({
    ...definition,
    protocols: [...definition.protocols],
    state,
    mode: state === 'disabled' ? 'disabled' : mode,
    running: ready,
    ready,
    ...(recovery && { recovery }),
  });
}

function normalizeMyotisNode(definition, rawStatus, mode) {
  const sourceState = SAFE_MYOTIS_STATES.has(rawStatus?.state) ? rawStatus.state : 'error';
  const state = sourceState === 'off' ? 'stopped' : sourceState;
  const ready = state === 'ready';
  const running = ready || state === 'syncing';
  const peerCount = safePeerCount(rawStatus?.peerCount);
  const recovery = recoveryForState(state);
  return Object.freeze({
    ...definition,
    protocols: [...definition.protocols],
    state,
    mode: state === 'disabled' ? 'disabled' : mode,
    running,
    ready,
    ...(peerCount !== null && { peerCount }),
    ...(recovery && { recovery }),
  });
}

function summarize(nodes) {
  const activeStates = new Set(['starting', 'running', 'syncing', 'ready', 'stopping']);
  const attentionStates = new Set(['error', 'unavailable']);
  return Object.freeze({
    total: nodes.length,
    ready: nodes.filter((node) => node.ready).length,
    active: nodes.filter((node) => activeStates.has(node.state)).length,
    disabled: nodes.filter((node) => node.state === 'disabled').length,
    attention: nodes.filter((node) => attentionStates.has(node.state)).length,
  });
}

class NodeStatusController {
  constructor(options = {}) {
    this.dependencies = { ...defaultDependencies(), ...options };
  }

  async status() {
    const [registry, settings, ant, ipfs, radicle, tor, myotisEthereum, myotisGnosis] =
      await Promise.all([
        safeRead(this.dependencies.getRegistry, {}),
        safeRead(this.dependencies.getSettings, {}),
        safeRead(this.dependencies.getAntStatus),
        safeRead(this.dependencies.getIpfsStatus),
        safeRead(this.dependencies.getRadicleStatus),
        safeRead(this.dependencies.getTorStatus),
        safeRead(() => this.dependencies.getMyotisStatus(1)),
        safeRead(() => this.dependencies.getMyotisStatus(100)),
      ]);

    const modeFor = (id) => safeMode(registry?.[id]?.mode);
    const nodes = [
      normalizeManagerNode(NODE_DEFINITIONS[0], ant, modeFor('ant')),
      normalizeManagerNode(NODE_DEFINITIONS[1], ipfs, modeFor('ipfs')),
      normalizeManagerNode(
        NODE_DEFINITIONS[2],
        radicle,
        modeFor('radicle'),
        settings?.enableRadicleIntegration === true
      ),
      normalizeManagerNode(
        NODE_DEFINITIONS[3],
        tor,
        modeFor('tor'),
        settings?.enableTorIntegration === true
      ),
      normalizeMyotisNode(MYOTIS_DEFINITIONS[0], myotisEthereum, modeFor('myotis')),
      normalizeMyotisNode(MYOTIS_DEFINITIONS[1], myotisGnosis, modeFor('myotis')),
    ];

    return Object.freeze({ nodes: Object.freeze(nodes), summary: summarize(nodes) });
  }
}

module.exports = { NODE_DEFINITIONS, MYOTIS_DEFINITIONS, NodeStatusController };
