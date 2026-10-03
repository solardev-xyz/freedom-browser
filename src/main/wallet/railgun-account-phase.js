/** Main-owned wallet/TXID phase exclusion. Revocation does not release a claim:
 * its owner must first observe every job and storage worker finishing. This
 * keeps the source/public/third-worker budget intact across cancellation.
 */
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const owners = new Map();
const fail = () =>
  Object.assign(new Error('Railgun account phase unavailable'), {
    code: 'RAILGUN_ACCOUNT_PHASE_BUSY',
  });
function claimRailgunAccountPhase(enrollment, phase) {
  if (!isRailgunAccountEnrollment(enrollment) || !['wallet', 'txid', 'recovery'].includes(phase))
    throw fail();
  enrollment.getContext('engine');
  if (enrollment.signal.aborted || owners.has(enrollment.directory)) throw fail();
  const owner = {},
    directory = enrollment.directory;
  owners.set(directory, owner);
  return Object.freeze({
    phase,
    assertCurrent() {
      if (owners.get(directory) !== owner || enrollment.signal.aborted) throw fail();
      enrollment.getContext('engine');
    },
    release() {
      if (owners.get(directory) === owner) owners.delete(directory);
    },
  });
}
module.exports = { claimRailgunAccountPhase };
