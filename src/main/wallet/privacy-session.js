/** Wallet-owned privacy lifetime; opaque capabilities stay in main. */
const { createPrivacyScope, privacyError } = require('../networks/privacy-context');
const { createHash } = require('crypto');
const { getActiveProfile } = require('../profile-resolver');

let active = null;
let shuttingDown = false;

function currentProfileKey() {
  const profile = getActiveProfile();
  if (!profile?.id || !profile.userDataDir) {
    throw privacyError('PRIVACY_PROFILE_UNAVAILABLE', 'No active privacy profile');
  }
  return createHash('sha256')
    .update(JSON.stringify([profile.id, profile.userDataDir]))
    .digest('hex');
}

function openPrivacySession() {
  if (shuttingDown) throw privacyError('PRIVACY_CONTEXT_REVOKED', 'Privacy runtime stopped');
  // Lazy load: creating the transport API must not load vault/key machinery.
  const vault = require('../identity/vault');
  const signal = vault.getSessionSignal();
  if (signal.aborted) throw privacyError('PRIVACY_VAULT_LOCKED', 'Vault is locked');
  const profileId = currentProfileKey();
  if (
    active &&
    active.profileId === profileId &&
    active.vaultSignal === signal &&
    !active.scope.signal.aborted
  ) {
    return active.scope;
  }
  active?.scope.close();
  const scope = createPrivacyScope({
    profileId,
    signal,
    isCurrent: () => {
      if (shuttingDown) return false;
      try {
        return currentProfileKey() === profileId;
      } catch {
        return false;
      }
    },
  });
  active = { profileId, vaultSignal: signal, scope };
  return scope;
}

function resetPrivacySession() {
  active?.scope.close();
  active = null;
}

function shutdownPrivacySessions() {
  shuttingDown = true;
  resetPrivacySession();
}

module.exports = { openPrivacySession, resetPrivacySession, shutdownPrivacySessions };
