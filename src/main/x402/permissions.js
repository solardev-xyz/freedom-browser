/**
 * x402 per-origin payment allowance store.
 *
 * Persists the "allow up to $X for Y seconds" caps the user grants
 * inside the interstitial. Each cap is keyed by `(origin, chainId, asset)`
 * — generic "$10 for example.com" would be too coarse to defend against
 * a compromised site spending the user's holdings across chains.
 *
 *   - grant(origin, chainId, asset, capAmount, windowSeconds)
 *       Create or replace a cap. Resets `spentAmount` to 0 and starts a
 *       fresh window. Lifetime cap is single-window: when `expiresAt`
 *       passes the user is asked again. No rolling renewals — caps
 *       silently extending themselves is a footgun.
 *
 *   - charge(origin, chainId, asset, amount)
 *       Atomic "is this within cap + bump spent" check. Returns the
 *       charge and persists the new spent total if covered, `null`
 *       otherwise. An auto-pay charges before it signs.
 *
 *   - refund(charge) / chargeStands(charge)
 *       Give a charge back for a payment that was never sent; whether
 *       the cap it was taken from still stands.
 *
 *   - revoke(origin, chainId, asset)
 *       Drop a cap. Idempotent.
 *
 * Atomic amounts are strings (BigInt-safe) — USDC's 6 decimals means
 * "$10" is "10000000", well within Number range, but other assets we
 * may support later (high-precision tokens, rebasing supplies) push
 * past Number.MAX_SAFE_INTEGER. Better to bite the bigint bullet now.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { normalizeOrigin } = require('../../shared/origin-utils');

const PERMISSIONS_FILE = 'x402-permissions.json';

// In-memory cache; lazy-loaded on first access. Always wins over disk
// (writes go through `save()`).
let cache = null;

function permissionsPath() {
  return path.join(app.getPath('userData'), PERMISSIONS_FILE);
}

// Drop already-expired records on load so the file doesn't accumulate
// dead grants across sessions. Compaction is in-memory only — the
// disk file gets cleaned on the next `save()` (next grant/consume/revoke).
function compactExpired(all) {
  const now = nowSeconds();
  const out = {};
  for (const [origin, byAsset] of Object.entries(all)) {
    const active = {};
    for (const [key, record] of Object.entries(byAsset)) {
      if (record?.expiresAt > now) active[key] = record;
    }
    if (Object.keys(active).length > 0) out[origin] = active;
  }
  return out;
}

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(permissionsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === 'object' ? compactExpired(parsed) : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[x402:permissions] failed to load:', err.message);
    }
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(permissionsPath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[x402:permissions] failed to save:', err.message);
  }
}

function assetKey(chainId, asset) {
  return `${chainId}:${asset}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Create or replace a cap. Starts fresh: spent=0, window from `now`.
 *
 * @param {string} origin - Will be normalised.
 * @param {number} chainId
 * @param {string} asset - ERC-20 address (case-preserving).
 * @param {string} capAmount - Atomic units, as a digit string.
 * @param {number} windowSeconds - How long the cap is valid for.
 * @returns {object} The persisted record.
 */
function grant(origin, chainId, asset, capAmount, windowSeconds) {
  if (typeof capAmount !== 'string' || !/^\d+$/.test(capAmount)) {
    throw new Error('x402-permissions: capAmount must be a digit string');
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error('x402-permissions: windowSeconds must be a positive number');
  }

  const all = load();
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    throw new Error(`x402-permissions: origin '${origin}' could not be normalised`);
  }
  const created = nowSeconds();
  const record = {
    capAmount,
    spentAmount: '0',
    createdAt: created,
    expiresAt: created + windowSeconds,
  };

  const byAsset = all[normalized] ?? {};
  byAsset[assetKey(chainId, asset)] = record;
  all[normalized] = byAsset;
  cache = all;
  save();
  return { origin: normalized, chainId, asset, ...record };
}

/**
 * Look up the cap for an origin/asset pair. Returns null if absent or
 * expired (expired entries are treated as if they don't exist; they
 * get cleaned up lazily on next `grant` or `getAll`).
 */
function getPermission(origin, chainId, asset) {
  const all = load();
  const normalized = normalizeOrigin(origin);
  const record = all[normalized]?.[assetKey(chainId, asset)];
  if (!record) return null;
  if (record.expiresAt <= nowSeconds()) return null;
  return { origin: normalized, chainId, asset, ...record };
}

/**
 * Charge `amount` to the cap if it fits inside what is left; if it does,
 * bump `spentAmount` and persist. Returns the charge — which cap it was
 * taken from (its `createdAt`) and how much — so that it can be given
 * back (`refund`), or `null` if there is no cap, it has expired, or the
 * amount doesn't fit.
 *
 * An auto-pay charges its cap before it signs (sign-flow.js), so two
 * payments can never both be signed against headroom for one.
 *
 * Strings + BigInt arithmetic so atomic units bigger than 2^53 don't
 * round.
 *
 * @returns {{ origin: string, chainId: number, asset: string, amount: string, createdAt: number } | null}
 */
function charge(origin, chainId, asset, amount) {
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return null;
  const all = load();
  const normalized = normalizeOrigin(origin);
  const byAsset = all[normalized];
  if (!byAsset) return null;
  const key = assetKey(chainId, asset);
  const record = byAsset[key];
  if (!record) return null;
  if (record.expiresAt <= nowSeconds()) return null;

  const cap = BigInt(record.capAmount);
  const spent = BigInt(record.spentAmount);
  const next = spent + BigInt(amount);
  if (next > cap) return null;

  byAsset[key] = { ...record, spentAmount: next.toString() };
  cache = all;
  save();
  return { origin: normalized, chainId, asset, amount, createdAt: record.createdAt };
}

/**
 * `charge` as a yes/no: `true` if `amount` was charged to the cap.
 */
function tryConsume(origin, chainId, asset, amount) {
  return charge(origin, chainId, asset, amount) !== null;
}

/** The live cap a charge was taken from, or null if it has gone. */
function capOf(taken) {
  if (!taken || typeof taken !== 'object') return null;
  const record = load()[taken.origin]?.[assetKey(taken.chainId, taken.asset)];
  // A cap granted again since is another cap: the charge isn't its.
  return record && record.createdAt === taken.createdAt ? record : null;
}

/**
 * Give a charge back: the payment it was for was never sent (nothing was
 * signed, or the signed header was withheld). Only to the cap it was
 * taken from, never below zero; a cap revoked or granted again since
 * gets nothing. Returns whether anything was given back.
 */
function refund(taken) {
  const record = capOf(taken);
  if (!record || typeof taken.amount !== 'string' || !/^\d+$/.test(taken.amount)) return false;
  const spent = BigInt(record.spentAmount) - BigInt(taken.amount);
  const all = load();
  all[taken.origin][assetKey(taken.chainId, taken.asset)] = {
    ...record,
    spentAmount: (spent > 0n ? spent : 0n).toString(),
  };
  cache = all;
  save();
  return true;
}

/**
 * Whether the cap a charge was taken from still stands: not revoked, not
 * granted again, not expired. A payment signed against a cap that has
 * since gone is withheld (intercept.js).
 */
function chargeStands(taken) {
  const record = capOf(taken);
  return Boolean(record) && record.expiresAt > nowSeconds();
}

/**
 * Drop a cap. Idempotent.
 */
function revoke(origin, chainId, asset) {
  const all = load();
  const normalized = normalizeOrigin(origin);
  const byAsset = all[normalized];
  if (!byAsset) return;
  delete byAsset[assetKey(chainId, asset)];
  if (Object.keys(byAsset).length === 0) {
    delete all[normalized];
  }
  cache = all;
  save();
}

/**
 * Drop every cap for an origin (all chain/asset combos). Idempotent.
 */
function revokeAllForOrigin(origin) {
  const all = load();
  const normalized = normalizeOrigin(origin);
  if (!all[normalized]) return;
  delete all[normalized];
  cache = all;
  save();
}

/**
 * Patch an existing cap's amount and/or window. Preserves `spentAmount`
 * (a user bumping their cap shouldn't reset what they've already spent)
 * and recomputes `expiresAt` from `createdAt + windowSeconds` when the
 * window changes. Throws if the record doesn't exist — call grant first
 * for new entries.
 *
 * @param {string} origin
 * @param {number} chainId
 * @param {string} asset
 * @param {{ capAmount?: string, windowSeconds?: number }} patch
 * @returns {object} The updated record.
 */
function updatePermission(origin, chainId, asset, patch = {}) {
  const all = load();
  const normalized = normalizeOrigin(origin);
  const byAsset = all[normalized];
  const key = assetKey(chainId, asset);
  const record = byAsset?.[key];
  if (!record) {
    throw new Error('x402-permissions: no permission to update');
  }

  const next = { ...record };
  if (patch.capAmount !== undefined) {
    if (typeof patch.capAmount !== 'string' || !/^\d+$/.test(patch.capAmount)) {
      throw new Error('x402-permissions: capAmount must be a digit string');
    }
    next.capAmount = patch.capAmount;
  }
  if (patch.windowSeconds !== undefined) {
    if (!Number.isFinite(patch.windowSeconds) || patch.windowSeconds <= 0) {
      throw new Error('x402-permissions: windowSeconds must be a positive number');
    }
    next.expiresAt = record.createdAt + patch.windowSeconds;
  }

  byAsset[key] = next;
  cache = all;
  save();
  return { origin: normalized, chainId, asset, ...next };
}

/**
 * An edit of a cap as main confirms it and checks it (#1023): the chrome
 * window it comes from, the cap's key, the cap as main holds it now and
 * the change. `wallet:confirm-signing` mints an `x402-cap-update` token
 * for this, and `x402:update-permission` spends it against this, each
 * from its own sender and main's own record, never from the caller's.
 *
 * @param {number} windowId - the sending chrome webContents' id
 */
function capUpdateRequest(windowId, { origin, chainId, asset, capAmount, windowSeconds } = {}) {
  const current = getPermission(origin, chainId, asset);
  return {
    window: windowId,
    origin,
    chainId,
    asset,
    capAmount,
    windowSeconds,
    current: current
      ? { capAmount: current.capAmount, createdAt: current.createdAt, expiresAt: current.expiresAt }
      : null,
  };
}

/**
 * Flat list of every active (non-expired) cap. Used by the activity
 * pane in WP6 to render the revoke UI.
 */
function getAllPermissions() {
  const all = load();
  const now = nowSeconds();
  const out = [];
  for (const [origin, byAsset] of Object.entries(all)) {
    for (const [key, record] of Object.entries(byAsset)) {
      if (record.expiresAt <= now) continue;
      const [chainIdStr, asset] = key.split(':');
      out.push({ origin, chainId: Number(chainIdStr), asset, ...record });
    }
  }
  return out;
}

function _resetCache() {
  cache = null;
}

module.exports = {
  grant,
  getPermission,
  charge,
  tryConsume,
  refund,
  chargeStands,
  revoke,
  revokeAllForOrigin,
  updatePermission,
  capUpdateRequest,
  getAllPermissions,
  _resetCache,
};
