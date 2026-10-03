/**
 * Swarm browsing credit: view helpers (#488).
 *
 * The main process reads the node's chequebook, its spend and the
 * `swap-enable` switch (src/main/swarm/browsing-credit-service.js). This pure
 * function turns that, plus the publish setup state the node card already
 * has, into what the card's Browsing Credit group shows.
 *
 * Figures behind the copy, from Ant's cost measurement on mainnet
 * (https://github.com/freedom-hq/ant/pull/126, bee's oracle rate): about
 * 0.75 xBZZ per GB when every chunk is paid, about 0.35 xBZZ per hour of
 * 6.4 Mbit/s video with the free tier carrying its ~5.4 Mbit/s (an estimate,
 * not an hour-long measurement), and the node's default 0.001 xBZZ deposit
 * buys about 1.3 MB of fully paid download.
 */

// Bee's minimum payment, 90 000 accounting units at the oracle's 100 000
// PLUR each: below it the node cannot write a cheque at all.
export const EMPTY_BELOW_PLUR = 9_000_000_000n;
// Half the node's default 0.001 xBZZ deposit.
export const LOW_BELOW_PLUR = 5_000_000_000_000n;

export const COST_NOTE =
  'Watching video or loading large files from Swarm can spend xBZZ from the chequebook: ' +
  'about 0.75 xBZZ per GB when every piece is paid for, or roughly 0.35 xBZZ per hour of HD ' +
  'video, since the free tier carries most of it. Spending never goes past what is deposited; ' +
  'when it runs out, downloads carry on at the free tier.';

const SLOW = 'downloads use the free tier and may be slow';
// `swap-enable` is node-wide: with it off the node writes no cheques for
// uploads either, and pushsync stalls once each peer's free allowance (a few
// hundred chunks) is used up. The switch's own copy has to say so.
const SWAP_OFF = `${SLOW}, and large uploads can stall`;

function toBigInt(value) {
  if (typeof value !== 'string') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function describeToggle(credit) {
  const base = { checked: credit.swapEnable !== false, disabled: true, hint: '' };
  if (credit.toggle?.inProgress) return { ...base, hint: 'Restarting the node…' };
  switch (credit.support) {
    case 'supported':
      return {
        ...base,
        disabled: false,
        hint:
          credit.toggle?.error ||
          'Pays for downloads and uploads. One switch for the whole node, as in bee.',
      };
    case 'unsupported':
      return { ...base, checked: false, hint: 'Not supported by this node version.' };
    case 'unmanaged':
      return {
        ...base,
        checked: false,
        hint: 'Freedom does not run this node; its own configuration decides.',
      };
    default:
      return { ...base, checked: false, hint: 'Could not check this node version.' };
  }
}

/**
 * @param credit  browsingCredit.getState() result, or null before the first read
 * @param setupState  the publish setup state (for the deposit top-up)
 */
export function describeBrowsingCredit(credit, setupState) {
  if (!credit || credit.node !== 'running') return { visible: false };

  const toggle = describeToggle(credit);
  const cb = credit.chequebook;
  const view = {
    visible: true,
    toggle,
    available: '--',
    detail: '',
    spend: '',
    tier: { text: 'Free tier', value: 'free' },
    level: 'none',
    status: '',
    showTopUp: false,
    costNote: COST_NOTE,
  };

  if (credit.spend) {
    view.spend = `Spent ${credit.spend.day} xBZZ in 24 h · ${credit.spend.week} xBZZ in 7 days`;
  }

  if (cb === undefined) {
    view.status = 'Reading the chequebook…';
    view.tier = null;
    return view;
  }
  if (cb === null) {
    view.status = `This node has no chequebook yet, so ${SLOW}. Your first storage purchase creates and funds it.`;
    return view;
  }

  view.available = cb.available ?? '--';
  if (cb.total && cb.total !== cb.available) view.detail = `Of ${cb.total} xBZZ deposited`;
  if (cb.availableExact === false) {
    view.detail = `${view.detail ? `${view.detail} · ` : ''}an upper bound: the node could not count its cheques`;
  }

  const available = toBigInt(cb.availablePlur) ?? 0n;
  view.level = available < EMPTY_BELOW_PLUR ? 'empty' : available < LOW_BELOW_PLUR ? 'low' : 'ok';

  const paying =
    credit.support === 'supported' && credit.swapEnable !== false && view.level !== 'empty';
  view.tier = paying
    ? { text: 'Paying peers', value: 'paying' }
    : { text: 'Free tier', value: 'free' };

  if (credit.support === 'unsupported') {
    // This node never spends from the chequebook on downloads.
    view.costNote = '';
    view.status = `Paying peers is not supported by this node version, so ${SLOW}.`;
  } else if (credit.support === 'unmanaged') {
    view.tier = null;
    view.status = 'Whether this node pays peers is set in its own configuration.';
  } else if (credit.support !== 'supported') {
    view.tier = null;
    view.status = '';
  } else if (credit.swapEnable === false) {
    view.status = `Paying peers is off, so ${SWAP_OFF}.`;
  } else if (view.level === 'empty') {
    view.status = `The credit is used up, so ${SLOW}.`;
  } else if (view.level === 'low') {
    view.status = 'The credit is low. When it runs out, downloads go back to the free tier.';
  }

  if (view.level !== 'ok') {
    const deposit = setupState?.account?.chequebook;
    const canTopUp =
      Boolean(deposit?.needsTopUp) && deposit.managed !== false && setupState?.canBuy;
    if (canTopUp) {
      view.showTopUp = true;
    } else if (deposit && !deposit.needsTopUp && deposit.managed !== false) {
      // The deposit route tops up to the node's target from the on-chain
      // balance, which only drops once peers cash their cheques.
      view.status = `${view.status ? `${view.status} ` : ''}The deposit still reads full on chain until peers cash the cheques the node wrote, so there is nothing to top up yet.`;
    }
  }

  return view;
}
