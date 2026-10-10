/** Fixed browser composition for the future installed Railgun owner domain.
 * Inactive until the owner move is qualified. Call once during main startup,
 * before before-quit can fire; never initialize from an operation or renderer.
 */
const { isMainThread } = require('worker_threads');
const { types } = require('util');
const path = require('path');
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
function initializeRailgunOwner(runtime, ...extra) {
  if (extra.length || !isMainThread || (process.type !== undefined && process.type !== 'browser'))
    throw fail();
  if (attempted) throw fail();
  if (!runtime || types.isProxy(runtime) || Object.getPrototypeOf(runtime) !== Object.prototype)
    throw fail();
  const fields = Object.getOwnPropertyDescriptors(runtime);
  const names = ['archive', 'proverArchive', 'artifactDirectory'];
  if (Reflect.ownKeys(fields).length !== names.length) throw fail();
  const capturedRuntime = {};
  for (const name of names) {
    const field = fields[name];
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable ||
        typeof field.value !== 'string' || field.value.length > 4096 ||
        field.value.includes('\0') || !path.isAbsolute(field.value)) throw fail();
    capturedRuntime[name] = field.value;
  }
  Object.freeze(capturedRuntime);
  attempted = true;
  // Capture actual application shutdown first, before loading other host services.
  const platform = require('./railgun-platform-host').createRailgunPlatformHost();
  const credentials = require('../identity/railgun-credential-host').createRailgunCredentialHost();
  const submitter = require('../identity/railgun-submitter-host').createRailgunSubmitterHost();
  const sourceIdentity =
    require('./railgun-source-identity-host').createRailgunSourceIdentityHost();
  const bindings = Object.freeze({
    context: fixed(require('../networks/privacy-context'), [
      'getPrivacyContext',
      'createPrivacyScope',
    ]),
    artifacts: fixed(require('./privacy-artifacts'), ['createPrivacyArtifactLoader']),
    credentials,
    platform,
    submitter,
    sourceIdentity,
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
  return require('@freedom/railgun-kohaku-adapter/host/owner').initializeRailgunMain({
    host: bindings,
    runtime: capturedRuntime,
  });
}
module.exports = { initializeRailgunOwner };
