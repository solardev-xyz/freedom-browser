const PINNED_SOURCE_COMMIT = 'bfcf778d4fb30992ac53631a58aef3dcfa31090c';
const RELEASE_TAG = `upstream-${PINNED_SOURCE_COMMIT.slice(0, 12)}`;

module.exports = { RELEASE_TAG, PINNED_SOURCE_COMMIT };
