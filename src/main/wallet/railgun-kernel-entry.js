/** Fixed private-kernel entry. Install guards before importing host services.
 * Initialization is synchronous so the first parent init cannot miss its listener.
 * Legacy relay/POI jobs retain their separate, unchanged process entry.
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
