/**
 * The freedom-colibrid release this app version ships and is tested
 * against, and what its `colibri.hello` reports (freedom-core design 0014,
 * "The protocol"). The service's client checks `hello` against these values
 * (colibrid-client.js), behind a development switch (COL-5,
 * colibri-backend.js); Colibri stays on the WASM workers by default.
 *
 * - `PINNED_COLIBRID_VERSION`: the release, as `hello`'s `service_version`
 *   reports it, so a binary replaced under a running app can be refused, as
 *   `ipfs.hello`'s must be `PINNED_IPFSD_VERSION`.
 * - `COLIBRI_VERSION`: the Colibri release its C core is built from
 *   (`hello`'s `colibri_version`), the `@corpus-core/colibri-stateless`
 *   version the WASM workers run.
 * - `CLIENT_VERSION`: that release's version number, `major << 16 |
 *   minor << 8 | patch` (`hello`'s `client_version`), which the C core
 *   sends to provers.
 *
 * `scripts/fetch-freedom-colibrid.js` pins the release itself, with its
 * SHA256SUMS digest (scripts aren't packaged). A bump changes both; a drift
 * guard (`colibrid-pin.test.js`) fails when they differ.
 */

const PINNED_COLIBRID_VERSION = '0.1.1';
const COLIBRI_VERSION = '3.0.3';
const CLIENT_VERSION = 196611;

module.exports = { PINNED_COLIBRID_VERSION, COLIBRI_VERSION, CLIENT_VERSION };
