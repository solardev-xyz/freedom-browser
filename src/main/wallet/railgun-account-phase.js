/** Main-owned wallet/TXID phase exclusion. Revocation does not release a claim:
 * its owner must first observe every job and storage worker finishing. This
 * keeps the source/public/third-worker budget intact across cancellation.
 */
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const owners = new Map();
const handoffs = new Map();
const fail = () =>
  Object.assign(new Error('Railgun account phase unavailable'), {
    code: 'RAILGUN_ACCOUNT_PHASE_BUSY',
  });
function claimRailgunAccountPhase(enrollment, phase, handoff) {
  if (!isRailgunAccountEnrollment(enrollment) || !['wallet', 'txid', 'recovery'].includes(phase))
    throw fail();
  enrollment.getContext('engine');
  if (enrollment.signal.aborted || owners.has(enrollment.directory)) throw fail();
  const reserved = handoffs.get(enrollment.directory);
  if (
    reserved
      ? reserved.token !== handoff || reserved.enrollment !== enrollment || phase === 'recovery'
      : handoff !== undefined
  )
    throw fail();
  const owner = {},
    directory = enrollment.directory;
  owners.set(directory, owner);
  const assertCurrent = () => {
    if (owners.get(directory) !== owner || enrollment.signal.aborted) throw fail();
    enrollment.getContext('engine');
  };
  return Object.freeze({
    phase,
    assertCurrent,
    reserveHandoff() {
      assertCurrent();
      if (phase !== 'wallet' || handoffs.has(directory)) throw fail();
      const entry = { token: Object.freeze({}), enrollment };
      handoffs.set(directory, entry);
      return Object.freeze({
        token: entry.token,
        assertCurrent() {
          if (handoffs.get(directory) !== entry || enrollment.signal.aborted) throw fail();
          enrollment.getContext('engine');
        },
        // The handoff owner must drain its temporary phases before release.
        // Any active phase still retains its independent ordinary exclusion.
        release() {
          if (handoffs.get(directory) === entry) handoffs.delete(directory);
        },
      });
    },
    release() {
      if (owners.get(directory) === owner) owners.delete(directory);
    },
  });
}
module.exports = { claimRailgunAccountPhase };
