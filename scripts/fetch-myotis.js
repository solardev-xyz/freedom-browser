// The released addon lacks checkpoint import. Build the pinned, additive Freedom
// extension for this host; never silently replace it with the vanilla release.
const { buildAddon, source } = require('./build-myotis-addon');
const PINNED_RELEASE_TAG = 'v0.1.9';
if (source.releaseTag !== PINNED_RELEASE_TAG) throw new Error('Myotis source pin mismatch');
if (require.main === module) buildAddon().catch((error) => { console.error(`fetch-myotis failed: ${error.message}`); process.exitCode = 1; });
module.exports = { PINNED_RELEASE_TAG };
