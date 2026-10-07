/** Fixed browser implementation identity for derived Railgun cache generations.
 * This is source compatibility, not authority or dynamic execution coverage.
 * No caller chooses a filename; no profile or credential file is read.
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { isMainThread } = require('worker_threads');
const SOURCES = Object.freeze([
  '../identity-manager.js',
  '../identity/privacy-keys.js',
  '../identity/railgun-credential-host.js',
  '../identity/railgun-key-derivation.js',
  '../identity/railgun-submitter-host.js',
  '../identity/vault.js',
  '../networks/privacy-context.js',
  '../networks/private-rpc.js',
  '../networks/wallet-tor-transport.js',
  '../networks/network-registry.js',
  '../profile-resolver.js',
  '../settings-store.js',
  '../tor-manager.js',
  'privacy-artifacts.js',
  'privacy-journal-retention.js',
  'privacy-profile-guard.js',
  'privacy-session.js',
  'privacy-storage.js',
  'private-submission-journal.js',
  'private-submission-reconciler.js',
  'private-transaction-intent.js',
  'private-transaction-network.js',
  'railgun-kernel-entry.js',
  'railgun-owner-host.js',
  'railgun-owner-storage-entry.js',
  'railgun-platform-host.js',
  'railgun-source-identity-host.js',
  'signers.js',
  'transaction-service.js',
]);
const fail = () =>
  Object.assign(new Error('Railgun source identity unavailable'), {
    code: 'RAILGUN_SOURCE_IDENTITY_UNAVAILABLE',
  });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function main(args) {
  if (args.length || !isMainThread || (process.type !== undefined && process.type !== 'browser'))
    throw fail();
}
function createRailgunSourceIdentityHost(...args) {
  main(args);
  return Object.freeze({
    readDigest(...args) {
      main(args);
      try {
        return sha(
          JSON.stringify([
            'freedom:railgun:host-source-v1',
            SOURCES.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, name)))]),
          ])
        );
      } catch {
        throw fail();
      }
    },
  });
}
module.exports = { createRailgunSourceIdentityHost };
