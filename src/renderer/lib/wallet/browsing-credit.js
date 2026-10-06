/**
 * Swarm browsing credit: view helpers (#488).
 *
 * The main process reads the node's chequebook, its spend and the
 * `swap-enable` switch (src/main/swarm/browsing-credit-service.js). This pure
 * function turns that, plus the publish setup state the node card already
 * has, into what the card's Browsing Credit group shows. The switch pays
 * peers for downloads and uploads alike.
 *
 * Figures behind the copy, from Ant's mainnet measurements in
 * https://github.com/freedom-hq/ant/pull/126 (bee's oracle rate, the ledger's
 * issued PLUR over bytes moved):
 *   - downloads, fully paid: ≈ 0.59 xBZZ per GB (pooled over four paid
 *     bursts; 0.54–0.63 per run);
 *   - 6.4 Mbit/s video with the free tier carrying most of it: ≈ 0.16 xBZZ
 *     per hour, an estimate from the free tier's measured median rate (the
 *     unpaid runs' spread puts it at 0–0.37), not an hour-long measurement;
 *   - uploads: ≈ 0.22 xBZZ per GB (0.21–0.22 over a drive upload and a live
 *     publish), postage on top;
 *   - the node's default 0.001 xBZZ deposit buys ≈ 1.7 MB of paid burst.
 */

// Bee's minimum payment, 90 000 accounting units at the oracle's 100 000
// PLUR each: below it the node cannot write a cheque at all.
export const EMPTY_BELOW_PLUR = 9_000_000_000n;
// Half the node's default 0.001 xBZZ deposit.
export const LOW_BELOW_PLUR = 5_000_000_000_000n;

export const COST_NOTE =
  'The credit pays peers for faster downloads and for uploads. Downloads cost about ' +
  '0.59 xBZZ per GB when every piece is paid for, or roughly 0.16 xBZZ per hour of HD ' +
  'video, since the free tier carries most of it (an estimate). Uploads cost about ' +
  '0.22 xBZZ per GB. Spending never goes past what is deposited; when it runs out, ' +
  'transfers carry on at the free tier.';

// "Top Up Credit" amounts (freedom-hq/ant#126's deposit amount). Each says
// what it buys at #126's fully paid download rate, ≈ 0.59 xBZZ per GB.
const PLUR_PER_XBZZ = 10n ** 16n;
export const DEPOSIT_PRESETS = Object.freeze([
  Object.freeze({ xbzz: '0.05', detail: '≈ 85 MB fully paid' }),
  Object.freeze({ xbzz: '0.1', detail: '≈ 170 MB fully paid' }),
  Object.freeze({ xbzz: '0.5', detail: '≈ 850 MB fully paid' }),
]);
export const DEFAULT_DEPOSIT_XBZZ = '0.1';
// The same range main accepts (publish-setup-service.js): the node's own
// default deposit up to 10 xBZZ, so a typo can't swap the node's whole xDAI.
export const MIN_DEPOSIT_PLUR = PLUR_PER_XBZZ / 1000n;
export const MAX_DEPOSIT_PLUR = 10n * PLUR_PER_XBZZ;

/**
 * An xBZZ amount the user typed, as PLUR: `{ plur }` (a decimal integer
 * string) or `{ error }`. xBZZ has 16 decimals.
 */
export function parseXbzzAmount(text) {
  const value = String(text ?? '')
    .trim()
    .replace(',', '.');
  if (!value) return { error: 'Enter an amount.' };
  const match = /^(\d{1,6})?(?:\.(\d{1,16}))?$/.exec(value);
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    return { error: 'Enter an amount in xBZZ, like 0.2.' };
  }
  const plur =
    BigInt(match[1] || '0') * PLUR_PER_XBZZ + BigInt((match[2] || '').padEnd(16, '0') || '0');
  if (plur < MIN_DEPOSIT_PLUR || plur > MAX_DEPOSIT_PLUR) {
    return { error: 'Choose an amount between 0.001 and 10 xBZZ.' };
  }
  return { plur: plur.toString() };
}

/** PLUR as xBZZ, trailing zeros trimmed ("1000000000000000" → "0.1"). */
export function formatXbzz(plurValue) {
  let plur;
  try {
    plur = BigInt(plurValue);
  } catch {
    return null;
  }
  if (plur < 0n) return null;
  const fraction = (plur % PLUR_PER_XBZZ).toString().padStart(16, '0').replace(/0+$/, '');
  return fraction ? `${plur / PLUR_PER_XBZZ}.${fraction}` : `${plur / PLUR_PER_XBZZ}`;
}

const SLOW = 'downloads use the free tier and may be slow';
// `swap-enable` is node-wide: with it off, or the credit used up, the node
// writes no cheques for uploads either, and pushsync slows down once each
// peer's free allowance is used up (freedom-hq/ant#126 measured the paid
// upload reaching 99.6 % in 30 min against 98.0 % free). The copy says so.
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
  if (credit.toggle?.inProgress) return { ...base, hint: 'Switching…' };
  switch (credit.support) {
    case 'supported':
      return {
        ...base,
        disabled: false,
        hint:
          credit.toggle?.error ||
          'Pays for faster downloads and for uploads. One switch for the whole node, as in bee.',
      };
    case 'unsupported':
      return { ...base, checked: false, hint: 'Not supported by this node version.' };
    case 'no-settlement':
      // Ant reports the switch on an ultra-light node too (`settlement.supported`
      // false), where flipping it changes nothing.
      return {
        ...base,
        checked: false,
        hint: 'This node cannot pay peers in the mode it runs in (ultra-light).',
      };
    case 'unmanaged':
      return {
        ...base,
        checked: false,
        hint: 'Freedom does not run this node; its own configuration decides.',
      };
    default:
      return { ...base, checked: false, hint: 'Checking this node…' };
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

  // The node says whether its cheques pay peers right now (`/node`'s
  // `settlement.paying`, updated from its funds read every minute); an empty
  // credit can't write a cheque whatever that read says.
  const paying = credit.paying === true && view.level !== 'empty';
  view.tier = paying
    ? { text: 'Paying peers', value: 'paying' }
    : { text: 'Free tier', value: 'free' };

  if (credit.support === 'unsupported') {
    // This node never spends from the chequebook on downloads.
    view.costNote = '';
    view.status = `Paying peers is not supported by this node version, so ${SLOW}.`;
  } else if (credit.support === 'no-settlement') {
    view.costNote = '';
    view.status = `This node cannot pay peers in the mode it runs in (ultra-light), so ${SLOW}.`;
  } else if (credit.support === 'unmanaged') {
    if (credit.paying == null) view.tier = null;
    view.status = 'Whether this node pays peers is set in its own configuration.';
  } else if (credit.support !== 'supported') {
    view.tier = null;
    view.status = '';
  } else if (credit.swapEnable === false) {
    view.status = `Paying peers is off, so ${SWAP_OFF}.`;
  } else if (view.level === 'empty') {
    view.status = `The credit is used up, so ${SWAP_OFF}.`;
  } else if (view.level === 'low') {
    view.status =
      'The credit is low. When it runs out, downloads and uploads go back to the free tier.';
  } else if (credit.paying === false) {
    // Switch on, credit left: the node has not seen the funds yet.
    view.status = `The node is not paying peers yet, so ${SLOW}.`;
  }

  const deposit = setupState?.account?.chequebook;
  const canTopUp = Boolean(deposit) && deposit.managed !== false && Boolean(setupState?.canBuy);
  if (credit.depositAmount) {
    // freedom-hq/ant#126: deposit any amount, whatever the on-chain balance
    // or the node's target, so a top-up is always on offer.
    view.showTopUp = canTopUp;
  } else if (view.level !== 'ok') {
    if (canTopUp && deposit.needsTopUp) {
      view.showTopUp = true;
    } else if (deposit && !deposit.needsTopUp && deposit.managed !== false) {
      // An older node's deposit route tops up only to its target, from the
      // on-chain balance, which only drops once peers cash their cheques.
      view.status = `${view.status ? `${view.status} ` : ''}The deposit still reads full on chain until peers cash the cheques the node wrote, so there is nothing to top up yet.`;
    }
  }

  return view;
}
