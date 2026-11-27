/**
 * The freedom-radicled release this app version ships and is tested
 * against. The service runs the profile's Radicle node in packaged builds,
 * and by default in development (radicle-backend-kind.js; freedom-core
 * design 0008, step 7). In a packaged build, radicled-client.js accepts only a
 * `rad.hello` whose `service_version` is this version, as `ipfs.hello`'s must be
 * `PINNED_IPFSD_VERSION`, so a binary replaced under a running app is
 * refused rather than served.
 *
 * `scripts/fetch-freedom-radicled.js` pins the release itself, with its
 * SHA256SUMS digest (scripts aren't packaged). A bump changes both; a drift
 * guard (`radicled-pin.test.js`) fails when they differ.
 */

const PINNED_RADICLED_VERSION = '0.2.0';

module.exports = { PINNED_RADICLED_VERSION };
