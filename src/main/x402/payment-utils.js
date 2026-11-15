/**
 * Pure helpers shared between the detector and the sign-flow / IPC
 * layers. Lives in its own file so `intercept.js` and `sign-flow.js`
 * can both import without the intercept ↔ sign-flow circular that
 * forced an earlier duplication.
 */

// The caps as the identity core holds them (X402-2): the core decides each
// payment again, so these answer only which entry is worth asking it for.
const { getPermission } = require('./caps');

// CAIP-2 prefix for EIP-155 chains — the only `network` shape our cap
// store can key on. V1 string networks ('base', 'ethereum', …) bail
// out before reaching the chainId/asset lookup.
const EIP155_PREFIX = 'eip155:';

/**
 * Pull `(chainId, asset, amount)` out of a single `accepts[]` entry.
 * Returns null if the network isn't CAIP-2 (V1 string networks +
 * malformed) — the permission store doesn't key non-EIP-155 caps and
 * we don't auto-pay them. V2's `amount` is the canonical field; the
 * zod schema strips unknown keys, so by the time a parsed entry
 * reaches us there's no `maxAmountRequired` to fall back to.
 *
 * The asset address is lowercased so downstream lookups (balance
 * cache, token registry, permissions store) all key consistently.
 * Ethereum addresses are case-insensitive on the wire (EIP-55
 * checksum is a hex-only convention); the SDK still sees the
 * original mixed-case asset on the selected `accept` because the
 * EIP-712 domain hashes the parsed address bytes, not the string.
 */
function tupleFromAccept(accept) {
  if (!accept) return null;
  if (typeof accept.network !== 'string' || !accept.network.startsWith(EIP155_PREFIX)) return null;
  const chainId = Number(accept.network.slice(EIP155_PREFIX.length));
  if (!Number.isFinite(chainId)) return null;
  if (typeof accept.amount !== 'string') return null;
  if (typeof accept.asset !== 'string') return null;
  return { chainId, asset: accept.asset.toLowerCase(), amount: accept.amount };
}

/**
 * Coverage state for a single `accepts[]` entry against a single
 * origin's per-asset cap. Returns null when there's nothing to report
 * (non-EIP-155 entry, or no permission registered for this asset). On
 * a registered permission returns `{ accept, tuple, perm, remaining,
 * covers }` regardless of whether `remaining` exceeds the entry's
 * amount — `covers` tells the caller. Single source of truth for the
 * BigInt headroom math; both the auto-pay selector (covers-only) and
 * the sidebar's over-cap UI (needs the perm even when covers===false)
 * consume it.
 */
function coverageForAccept(origin, accept) {
  const tuple = tupleFromAccept(accept);
  if (!tuple) return null;
  const perm = getPermission(origin, tuple.chainId, tuple.asset);
  if (!perm) return null;
  const remaining = BigInt(perm.capAmount) - BigInt(perm.spentAmount);
  return {
    accept,
    tuple,
    perm,
    remaining,
    covers: BigInt(tuple.amount) <= remaining,
  };
}

/**
 * Locked-in selection rule: iterate `accepts[]` in server order; the
 * first entry whose `(chainId, asset)` matches an active per-origin
 * cap with enough headroom for the entry's amount wins. The user's
 * cap was their consent contract for a specific asset, so we honor
 * the order they set it in — no cheapest-of / balance-aware switching.
 *
 * Returns the same shape as `coverageForAccept` on the winning entry,
 * or `null` if no entry is cap-covered. Caller passes the parsed
 * `accepts[]` array directly so the helper doesn't have to know about
 * the V1/V2 requirements wrapper shape.
 */
function findCoveringPermission(origin, accepts) {
  for (const accept of accepts ?? []) {
    const coverage = coverageForAccept(origin, accept);
    if (coverage?.covers) return coverage;
  }
  return null;
}

module.exports = {
  tupleFromAccept,
  coverageForAccept,
  findCoveringPermission,
};
