/**
 * Swarm publishing: view helpers for the setup state.
 *
 * The main process owns readiness and the storage purchase
 * (src/main/swarm/publish-setup-service.js) and pushes its state to the
 * chrome. These pure functions turn that state into what the node card, the
 * setup screen and the storage screen show, so every surface words the same
 * state the same way.
 */

const FUND_ETHSWARM_URL = 'https://fund.ethswarm.org/';
const GNOSIS_CHAIN_ID = 100;

export function formatSwarmMode(mode) {
  switch (mode) {
    case 'full':
      return 'Full';
    case 'light':
      return 'Light';
    case 'ultraLight':
      return 'Ultra-light';
    default:
      return null;
  }
}

/** Plan sizes are decimal, like Swarm's effective-volume table: 1 GB = 1e9 bytes. */
export function formatStorageSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '--';
  if (bytes >= 1e9) return `${Number((bytes / 1e9).toFixed(1))} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export function formatDays(days) {
  if (!Number.isInteger(days) || days <= 0) return '--';
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  if (days >= 60 && days % 30 === 0) return `${days / 30} months`;
  if (days === 30) return '1 month';
  return days === 1 ? '1 day' : `${days} days`;
}

export function describePlan(plan) {
  return `Up to ${formatStorageSize(plan.safeLimitBytes)} for ${formatDays(plan.days)}`;
}

/** What the armed operation buys, in one line for the pay step. */
export function describeOperationTarget(operation, plans = []) {
  const request = operation?.request || {};
  if (request.kind === 'buy') {
    const plan = plans.find((p) => p.id === request.planId);
    return plan
      ? `${plan.title}: up to ${formatStorageSize(plan.safeLimitBytes)} for ${formatDays(plan.days)}`
      : 'Storage plan';
  }
  if (request.kind === 'extend') {
    const size = plans.find((p) => p.depth === request.depth);
    if (size && request.days) {
      return `Grow to ${formatStorageSize(size.safeLimitBytes)} and add ${formatDays(request.days)}`;
    }
    if (size) return `Grow your storage to ${formatStorageSize(size.safeLimitBytes)}`;
    return `Keep your storage ${formatDays(request.days)} longer`;
  }
  if (request.kind === 'deposit') return 'Top up the chequebook deposit';
  return '';
}

export function describeOperationTitle(operation) {
  switch (operation?.request?.kind) {
    case 'extend':
      return 'Extend Storage';
    case 'deposit':
      return 'Chequebook Deposit';
    default:
      return 'Publish Setup';
  }
}

export function describeExecuting(operation) {
  if (operation?.phase === 'confirming') {
    return {
      title: 'Almost Ready',
      text: 'Your storage is bought. The Swarm network is confirming it, which takes a moment. You can close this screen.',
    };
  }
  switch (operation?.request?.kind) {
    case 'extend':
      return {
        title: 'Extending Your Storage',
        text: 'Your Swarm node is paying for the extension on Gnosis Chain. This takes about a minute. You can close this screen.',
      };
    case 'deposit':
      return {
        title: 'Topping Up the Deposit',
        text: 'Your Swarm node is moving xBZZ into its chequebook on Gnosis Chain. This takes about a minute. You can close this screen.',
      };
    default:
      return {
        title: 'Activating Your Storage',
        text: 'Your Swarm node is swapping the xDAI for xBZZ and buying your storage on Gnosis Chain. This takes about a minute. You can close this screen.',
      };
  }
}

export function describeDone(operation) {
  const kind = operation?.request?.kind;
  if (kind === 'deposit') {
    return operation?.result?.alreadyFull
      ? 'The chequebook deposit is already full.'
      : 'The chequebook deposit is topped up. Uploads can pay for bandwidth again.';
  }
  if (kind === 'extend') return 'Your storage is extended.';
  if (operation?.result?.slow) {
    return 'Your storage is bought, but the Swarm network is still catching up. Publishing may fail for a few more minutes.';
  }
  return 'Your storage is ready. You can publish on Swarm now.';
}

/**
 * The payment request as an EIP-681 URI for wallets that scan it: a plain
 * xDAI transfer of `wei` to `address` on Gnosis Chain.
 */
export function buildPaymentUri(address, wei) {
  return `ethereum:${address}@${GNOSIS_CHAIN_ID}?value=${wei}`;
}

/** fund.ethswarm.org, pre-filled to deliver `xdai` xDAI (and no xBZZ) to `address`. */
export function buildFundUrl(address, xdai) {
  const params = new URLSearchParams({ destination: address, dai: String(xdai), bzz: '0' });
  return `${FUND_ETHSWARM_URL}?${params}`;
}

/**
 * The node card's publishing button: `{ visible, disabled, label, hint,
 * target }`, where `target` is the screen it opens ('setup' or 'storage').
 */
export function describePublishCta(state) {
  const hidden = { visible: false, disabled: true, label: '', hint: '', target: null };
  if (!state) return hidden;
  const mode = state.node?.registryMode;
  // A node on port 1633 that Freedom found running is someone else's to fund.
  if (mode === 'reused' || mode === 'disabled') return hidden;
  const status = state.node?.status;
  if (status !== 'running' && status !== 'error') return hidden;

  const cta = (label, hint, target = 'setup', disabled = false) => ({
    visible: true,
    disabled,
    label,
    hint,
    target,
  });
  const op = state.operation;
  if (op?.phase === 'executing') return cta('Buying Storage…', 'This takes about a minute');
  if (op?.phase === 'confirming') {
    return cta('Confirming Storage…', 'The network is confirming your storage');
  }
  if (op?.phase === 'awaiting-funds' && op.quote) {
    return cta('Waiting for Payment', `Send ${op.quote.send.display} xDAI to your node`);
  }
  // Storage that works outranks an earlier attempt that did not finish.
  if (op?.phase === 'failed' && state.readiness?.key !== 'ready') {
    return cta('Publishing Setup', 'The last purchase did not finish');
  }

  switch (state.readiness?.key) {
    case 'ready':
      return cta('Manage Storage', 'View and extend your storage', 'storage');
    case 'storage-pending':
      return cta('Manage Storage', 'New storage is reaching the network', 'storage');
    case 'needs-storage':
      return cta('Set Up Publishing', 'Buy storage to publish on Swarm');
    case 'checking':
      return cta('Checking Node Status…', '', 'setup', true);
    case 'chain-syncing':
      return cta('Publishing Setup', 'Connecting to Gnosis Chain…');
    case 'connecting':
      return cta('Publishing Setup', 'Connecting to peers…');
    case 'error':
      return cta('Publishing Setup', 'The Swarm node reported an error');
    default:
      return cta('Publishing Setup', '');
  }
}
