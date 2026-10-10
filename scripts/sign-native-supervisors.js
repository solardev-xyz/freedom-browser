// Keep workspace leaf/manifest sealing outside the normal application signer.
// That signer still applies Myotis-only empty entitlements and builder retries,
// while respecting the workspace wrapper's sealed-leaf ignore rule.
const { createSupervisorSigner } = require('./sign-macos-workspace-supervisor');
const signMyotisHelper = require('./sign-myotis-helper');
module.exports = createSupervisorSigner({ sign: signMyotisHelper });
