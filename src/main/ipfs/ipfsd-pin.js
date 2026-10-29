/**
 * The freedom-ipfsd release this app version ships and is tested against,
 * as main checks it at run time: `ipfs.hello`'s `service_version` must be
 * this version (`ipfsd-client.js`), so a binary replaced under a running
 * app, or re-executed from a replaced file, is refused rather than served.
 *
 * `scripts/fetch-freedom-ipfsd.js` pins the release itself, with its
 * SHA256SUMS digest (scripts aren't packaged). A bump changes both; a drift
 * guard (`ipfsd-pin.test.js`) fails when they differ.
 */

const PINNED_IPFSD_VERSION = '0.2.1';

module.exports = { PINNED_IPFSD_VERSION };
