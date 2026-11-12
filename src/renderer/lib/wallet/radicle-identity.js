/**
 * The Radicle DID the Nodes tab's Radicle card shows, from
 * `window.identity.getStatus()`.
 *
 * - **On the add-on** (a status without `radicle`): `addresses.radicleDid`,
 *   as before.
 * - **On the freedom-radicled service** (`status.radicle`; freedom-core
 *   design 0008, Main's side, deviation `locked-did`):
 *   - the DID is the running node's, its generation's, and a throwaway
 *     key's is marked as one. With no node running there is none.
 *   - the DID Radicle will use at its next start (`radicle.nextDid`, which
 *     main gives only while the vault is unlocked) is shown apart, on its
 *     own row and labelled so, never as the running node's. It is left out
 *     when it is the running node's.
 */

import { truncateAddress } from './wallet-utils.js';

export const RADICLE_THROWAWAY_LABEL = 'throwaway key';
export const RADICLE_THROWAWAY_TITLE =
  "This Radicle node runs with a throwaway key until it restarts with your identity, so it can't publish.";
export const RADICLE_NOT_RUNNING_TITLE = 'No Radicle node is running';
export const RADICLE_NEXT_TITLE = 'The identity Radicle will use from its next start.';

const shortDid = (did) => truncateAddress(did.replace('did:key:', ''), 8, 6);

/**
 * What the card shows: `{ did, text, title, next }`. `did` is what its copy
 * button copies (null: nothing), `text` and `title` the DID row's, and
 * `next` the next start's row, `{ did, text, title }`, or null to hide it.
 */
export function describeRadicleIdentity(status) {
  const service = status?.radicle;
  if (!service) {
    const did = status?.addresses?.radicleDid || null;
    return { did, text: did ? shortDid(did) : '--', title: did || '', next: null };
  }
  const active = typeof service.active?.did === 'string' ? service.active : null;
  const nextDid =
    typeof service.nextDid === 'string' && service.nextDid && service.nextDid !== active?.did
      ? service.nextDid
      : null;
  const next = nextDid
    ? { did: nextDid, text: shortDid(nextDid), title: `${nextDid}\n${RADICLE_NEXT_TITLE}` }
    : null;
  if (!active) return { did: null, text: '--', title: RADICLE_NOT_RUNNING_TITLE, next };
  if (active.ephemeral === true) {
    return {
      did: active.did,
      text: `${shortDid(active.did)} (${RADICLE_THROWAWAY_LABEL})`,
      title: `${active.did}\n${RADICLE_THROWAWAY_TITLE}`,
      next,
    };
  }
  return { did: active.did, text: shortDid(active.did), title: active.did, next };
}
