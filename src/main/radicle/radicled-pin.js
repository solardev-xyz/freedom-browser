/**
 * The freedom-radicled release this app version ships and is tested
 * against. Nothing in main runs the service yet (freedom-core design 0008,
 * step 6 on): when its client lands, `rad.hello`'s `service_version` must be
 * this version, as `ipfs.hello`'s must be `PINNED_IPFSD_VERSION`, so a binary
 * replaced under a running app is refused rather than served.
 *
 * `scripts/fetch-freedom-radicled.js` pins the release itself, with its
 * SHA256SUMS digest (scripts aren't packaged). A bump changes both; a drift
 * guard (`radicled-pin.test.js`) fails when they differ.
 */

const PINNED_RADICLED_VERSION = '0.1.1';

module.exports = { PINNED_RADICLED_VERSION };
