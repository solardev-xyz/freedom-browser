/** Fixed browser composition for the future installed Railgun owner domain.
 * Inactive until the owner move is qualified. Call once during main startup,
 * before before-quit can fire; never initialize from an operation or renderer.
 */
const { isMainThread } = require('worker_threads');
const { types } = require('util');
const apply = Reflect.apply;
let attempted = false;
const fail = () =>
  Object.assign(new Error('Railgun owner composition unavailable'), {
    code: 'RAILGUN_OWNER_COMPOSITION_REFUSED',
  });
function fixed(receiver, names) {
  const methods = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(receiver, name);
    if (!descriptor || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value))
      throw fail();
    const original = descriptor.value;
    methods[name] = (...args) => apply(original, receiver, args);
  }
  return Object.freeze(methods);
}
function initializeRailgunOwner(...args) {
  if (args.length || !isMainThread || (process.type !== undefined && process.type !== 'browser'))
    throw fail();
  if (attempted) throw fail();
  attempted = true;
  // Capture actual application shutdown first, before loading other host services.
  const platform = require('./railgun-platform-host').createRailgunPlatformHost();
  const credentials = require('../identity/railgun-credential-host').createRailgunCredentialHost();
  const submitter = require('../identity/railgun-submitter-host').createRailgunSubmitterHost();
  const bindings = Object.freeze({
    context: fixed(require('../networks/privacy-context'), [
      'getPrivacyContext',
      'createPrivacyScope',
    ]),
    artifacts: fixed(require('./privacy-artifacts'), ['createPrivacyArtifactLoader']),
    credentials,
    platform,
    submitter,
    profiles: fixed(require('../profile-resolver'), ['getActiveProfile']),
    sessions: fixed(require('./privacy-session'), ['openPrivacySession']),
    storage: fixed(require('./privacy-storage'), ['createPrivacyStorage', 'getPrivacyStoragePath']),
    rpc: fixed(require('../networks/private-rpc'), [
      'assertPrivateRpcDestination',
      'createPrivateRpc',
      'createPrivateRpcDestinationConstraint',
      'createPrivateRpcReadBudget',
      'getPrivateRpcDestination',
      'getPrivateRpcDestinationDetails',
      'getPrivateRpcReadBudgetOutcome',
    ]),
    transport: fixed(require('../networks/wallet-tor-transport'), ['createWalletTorTransport']),
    settings: fixed(require('../settings-store'), ['isWalletTorExperimentAvailable']),
    registry: fixed(require('../networks/network-registry'), [
      'getNetwork',
      'getEndpointSources',
      'getEndpoints',
    ]),
    tor: fixed(require('../tor-manager'), ['getWalletSocksEndpoint']),
    signers: fixed(require('./signers'), ['getSigner']),
    transactionIntent: fixed(require('./private-transaction-intent'), [
      'transactionIntent',
      'validIntent',
    ]),
    transactionNetwork: fixed(require('./private-transaction-network'), [
      'assertPrivateTransactionNetworkDestination',
      'getPrivateTransactionNetwork',
      'getPrivateTransactionNetworkDestination',
    ]),
    submissionJournal: fixed(require('./private-submission-journal'), [
      'getPrivateSubmissionJournal',
      'readExistingPrivateSubmissionSnapshot',
    ]),
    journalRetention: fixed(require('./privacy-journal-retention'), ['validArchive']),
    transactions: fixed(require('./transaction-service'), ['signAndSendTransaction']),
  });
  // The package initializer owns its global single-instance marker and captures
  // these same context/artifact capabilities for its existing execution helpers.
  require('@freedom/railgun-kohaku-adapter/host/owner').initializeRailgunOwnerHost(bindings);
}
module.exports = { initializeRailgunOwner };
