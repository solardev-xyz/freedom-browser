/**
 * The version main will check hello against is the release the fetch script
 * pins: a bump that changes one and not the other fails here. So does a
 * Colibri version that leaves the WASM workers' package, or its version
 * number, behind: both backends run one Colibri until the WASM path goes.
 */

const { PINNED_COLIBRID_VERSION, COLIBRI_VERSION, CLIENT_VERSION } = require('./colibrid-pin');
const { COLIBRI_CLIENT_VERSION } = require('./colibri-fetch-contract');
const fetcher = require('../../../scripts/fetch-freedom-colibrid');
const pkg = require('../../../package.json');

test("main's pinned freedom-colibrid version is the fetch script's pinned release", () => {
  expect(fetcher.PINNED_RELEASE_TAG).toBe(`colibrid-v${PINNED_COLIBRID_VERSION}`);
});

test("the service's Colibri is the WASM workers' package, and its version number", () => {
  expect(pkg.dependencies['@corpus-core/colibri-stateless']).toBe(COLIBRI_VERSION);
  const [major, minor, patch] = COLIBRI_VERSION.split('.').map(Number);
  expect(CLIENT_VERSION).toBe((major << 16) | (minor << 8) | patch);
  // The version the fetch contract admits in a prover request's path.
  expect(COLIBRI_CLIENT_VERSION).toBe(CLIENT_VERSION);
});
