/**
 * How much a postage batch holds, by depth (#1257).
 *
 * Swarm's effective volume for unencrypted uploads with no erasure coding:
 * what a batch of that depth can be expected to store with at most a 0.1%
 * (1 in 1,000) chance of filling early. Source: the "Effective Utilisation
 * Table" at https://docs.ethswarm.org/docs/concepts/incentives/postage-stamps,
 * which bee-js ships as `Utils.getStampEffectiveBytes(depth, false, 0)`;
 * batch-sizes.test.js holds this copy to it. Sizes are decimal, like the
 * docs (1 GB = 1e9 bytes).
 *
 * Freedom publishes unencrypted, so this is the column every size in the
 * storage plans, the custom picker and the storage list reads. It is a plain
 * table rather than a bee-js call so modules that mock bee-js in their tests
 * still load.
 */

const USABLE_BYTES_BY_DEPTH = Object.freeze({
  17: 44_700,
  18: 6_660_000,
  19: 112_060_000,
  20: 687_620_000,
  21: 2_600_000_000,
  22: 7_730_000_000,
  23: 19_940_000_000,
  24: 47_060_000_000,
  25: 105_510_000_000,
  26: 227_980_000_000,
  27: 476_680_000_000,
  28: 993_650_000_000,
  29: 2_040_000_000_000,
  30: 4_170_000_000_000,
  31: 8_450_000_000_000,
  32: 17_070_000_000_000,
  33: 34_360_000_000_000,
  34: 69_040_000_000_000,
});

/** Usable bytes for a batch of this depth, or null outside the table. */
function usableBytesForDepth(depth) {
  return Number.isInteger(depth) ? (USABLE_BYTES_BY_DEPTH[depth] ?? null) : null;
}

module.exports = { USABLE_BYTES_BY_DEPTH, usableBytesForDepth };
