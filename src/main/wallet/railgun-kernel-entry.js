/** Fixed private-kernel entry. Install guards before importing host services.
 * Initialization is synchronous so the first parent init cannot miss its listener.
 * The installed owner uses this same fixed entry for its closed private job enum.
 */
const {
  installRailgunExecutionBootstrap,
} = require('@freedom/railgun-kohaku-adapter/host/bootstrap');
const bootstrap = installRailgunExecutionBootstrap();
const { getPrivacyContext, createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyArtifactLoader } = require('./privacy-artifacts');
bootstrap.initialize({
  context: { getPrivacyContext, createPrivacyScope },
  artifacts: { createPrivacyArtifactLoader },
});
