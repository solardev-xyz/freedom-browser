/**
 * The version main checks hello against is the release the fetch script
 * pins: a bump that changes one and not the other fails here.
 */

const { PINNED_IPFSD_VERSION } = require('./ipfsd-pin');
const fetcher = require('../../../scripts/fetch-freedom-ipfsd');

test("main's pinned freedom-ipfsd version is the fetch script's pinned release", () => {
  expect(fetcher.PINNED_RELEASE_TAG).toBe(`ipfsd-v${PINNED_IPFSD_VERSION}`);
});
