import { ZERO_ADDRESS } from './wallet-utils.js';

export function normalizeSwarmMode(mode) {
  if (typeof mode !== 'string') {
    return null;
  }

  const normalized = mode.trim().toLowerCase();

  if (normalized === 'ultralight' || normalized === 'ultra-light' || normalized === 'ultra_light') {
    return 'ultraLight';
  }

  if (normalized === 'light') {
    return 'light';
  }

  if (normalized === 'full' || normalized === 'fullnode' || normalized === 'full-node') {
    return 'full';
  }

  return mode;
}

function appendInspectOnlyNote(detail, registryMode) {
  if (registryMode !== 'reused') {
    return detail;
  }

  return `${detail} Managed outside Freedom.`;
}

export function getUsableStampCount(stamps = []) {
  if (!Array.isArray(stamps)) {
    return 0;
  }

  return stamps.filter((stamp) => stamp?.usable === true).length;
}

export function summarizeSwarmStamps(stamps = [], stampsKnown = true) {
  if (!stampsKnown) {
    return {
      count: '--',
      summary: 'Checking stamp availability\u2026',
    };
  }

  const totalCount = Array.isArray(stamps) ? stamps.length : 0;
  const usableCount = getUsableStampCount(stamps);

  if (totalCount === 0) {
    return {
      count: '0',
      summary: 'No usable batches',
    };
  }

  if (usableCount === 0) {
    return {
      count: '0',
      summary: `${totalCount} batch${totalCount === 1 ? '' : 'es'} found, none usable`,
    };
  }

  if (usableCount === totalCount) {
    return {
      count: String(usableCount),
      summary: `${usableCount} usable batch${usableCount === 1 ? '' : 'es'} available`,
    };
  }

  return {
    count: String(usableCount),
    summary: `${usableCount} usable of ${totalCount} total batches`,
  };
}

/**
 * Classify the Swarm node's publish-readiness state for the node card UI.
 *
 * This classifier is used at runtime, after the node is already running.
 * It does NOT handle the "funding required" state — that is handled as a
 * pre-upgrade gate in handleUpgradeNode() before switching to light mode.
 */
export function classifySwarmPublishState({
  beeStatus,
  desiredMode,
  actualMode,
  registryMode,
  readiness,
  stamps,
  stampsKnown = false,
}) {
  const mode = normalizeSwarmMode(actualMode) || normalizeSwarmMode(desiredMode) || 'ultraLight';
  const usableStampCount = getUsableStampCount(stamps);
  const inspectOnly = registryMode === 'reused';

  if (beeStatus === 'error') {
    return {
      key: 'error',
      label: 'Error',
      detail: appendInspectOnlyNote(
        'Swarm reported a startup or health-check error.',
        registryMode
      ),
      action: null,
    };
  }

  if (beeStatus === 'starting' || beeStatus === 'stopping') {
    return {
      key: 'initializing',
      label: 'Initializing',
      detail: appendInspectOnlyNote('Swarm is changing node state.', registryMode),
      action: null,
    };
  }

  if (mode === 'ultraLight') {
    return {
      key: 'browsing-only',
      label: 'Browsing only',
      detail: appendInspectOnlyNote(
        inspectOnly
          ? 'This node can browse, but publishing requires light mode.'
          : 'Uploads require light mode, node funding, and usable stamps.',
        registryMode
      ),
      action: inspectOnly
        ? null
        : {
            key: 'upgrade',
            label: 'Upgrade to Light Node',
            hint: 'Enable uploads and publishing',
          },
    };
  }

  if (beeStatus !== 'running') {
    return {
      key: 'initializing',
      label: 'Setup pending',
      detail: appendInspectOnlyNote(
        'Start Swarm to continue light-node setup.',
        registryMode
      ),
      action: null,
    };
  }

  if (readiness?.ok !== true) {
    return {
      key: 'initializing',
      label: 'Initializing',
      detail: appendInspectOnlyNote(
        'Bee is finishing light-node setup.',
        registryMode
      ),
      action: null,
    };
  }

  if (!stampsKnown) {
    return {
      key: 'initializing',
      label: 'Initializing',
      detail: appendInspectOnlyNote(
        'Checking postage-batch availability.',
        registryMode
      ),
      action: null,
    };
  }

  if (usableStampCount === 0) {
    return {
      key: 'no-usable-stamps',
      label: 'No usable stamps',
      detail: appendInspectOnlyNote(
        'Publishing needs at least one usable postage batch.',
        registryMode
      ),
      action: null,
    };
  }

  return {
    key: 'ready',
    label: 'Ready to publish',
    detail: appendInspectOnlyNote(
      `${usableStampCount} usable batch${usableStampCount === 1 ? '' : 'es'} available.`,
      registryMode
    ),
    action: null,
  };
}

/**
 * Check whether the Bee node's funding prerequisites are met before
 * switching to light mode. Pure function — takes pre-fetched data, no I/O.
 *
 * @param {object} opts
 * @param {string|null} opts.chequebookAddress - from Bee /chequebook/address
 * @param {string|null} opts.xdaiBalance - formatted xDAI balance string (e.g. "0.0", "1.5")
 * @returns {{ funded: boolean }}
 */
export function checkLightModePrerequisites({ chequebookAddress, xdaiBalance }) {
  if (
    typeof chequebookAddress === 'string' &&
    chequebookAddress !== ZERO_ADDRESS &&
    chequebookAddress.length > 2
  ) {
    return { funded: true };
  }

  const balance = parseFloat(xdaiBalance || '0');
  if (balance > 0) {
    return { funded: true };
  }

  return { funded: false };
}
