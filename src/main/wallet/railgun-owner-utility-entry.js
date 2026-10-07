/** One fixed owner utility entry. The installed package owns the closed enum
 * table and protocol; guard installation precedes every host-service import.
 * Inactive until all owner routes and this entry are qualified together.
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
