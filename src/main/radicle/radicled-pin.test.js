/**
 * The version main will check hello against is the release the fetch script
 * pins: a bump that changes one and not the other fails here.
 */

const { PINNED_RADICLED_VERSION } = require('./radicled-pin');
const fetcher = require('../../../scripts/fetch-freedom-radicled');

test("main's pinned freedom-radicled version is the fetch script's pinned release", () => {
  expect(fetcher.PINNED_RELEASE_TAG).toBe(`radicled-v${PINNED_RADICLED_VERSION}`);
});
