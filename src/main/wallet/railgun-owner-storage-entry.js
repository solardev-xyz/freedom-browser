/** Fixed context-only worker composition. The package verifies the worker realm
 * before host import, binds its private context, then loads its fixed protocol.
 * No workerData field selects code or supplies a host capability.
 */
const {
  installRailgunStorageWorkerBootstrap,
} = require('@freedom/railgun-kohaku-adapter/host/owner-worker-bootstrap');
const bootstrap = installRailgunStorageWorkerBootstrap();
const { getPrivacyContext, createPrivacyScope } = require('../networks/privacy-context');
bootstrap.initialize({ context: { getPrivacyContext, createPrivacyScope } });
