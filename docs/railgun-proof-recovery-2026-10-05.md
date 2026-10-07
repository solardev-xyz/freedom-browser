# Original-signature proof recovery — October 5, 2026

The trusted main process can now finish an interrupted Railgun proof using the
operation's saved capsule and original signature. It independently verifies the
result and fills only that operation's empty proof slot. This covers private
transfer, full withdrawal and partial withdrawal, for both Shield-created and
received Transact inputs. It does not authorize submission or sign another
operation.

The implementation extends the existing main-process account, store and utility
boundaries. It adds no renderer surface, IPC channel, dependency or runtime pin.
Kohaku facade activation and partial submission remain separate work.

## Recovery sequence

`resumeRailgunAccountPrivateProof` requires genuine current identity, enrollment,
public coordinator and destination owners, plus one exact hold ID. Its existing-only
store opener checks both registered reservation and capsule files before opening
either. Missing files refuse without creating replacements or adopting unregistered
state. Cold store opening can refresh leases and recorded floors; it is not a
read-only operation.

A genuine reservation recovery phase selects and reads the signed, unfinished
record. The host carries immutable saved data into a separate completed-wallet
phase; it does not carry the phase's opaque receipt across that boundary. The
fixed read-only account restores authenticated completed state. A dedicated
viewing-only utility reconstructs the original witness and proves it with the
stored signature. It cannot exchange a new signing intent. Admission checks
the selected input against current owned, unspent note data while retaining the
original signed root and path.

The host waits for wallet work and closure before taking a fresh recovery phase.
It compares the entire original reservation and stored record, runs the genuine
independent verifier, repeats the comparisons after verification, and writes the
proof. Exact authenticated readback must equal the original record plus that proof.
Cancellation, owner changes, competing writes, changed signatures or mismatched
results refuse; uncertain completion retains recovery state. All stages share a
nonrenewing deadline and preserve the existing account drainage/quarantine rules.

A retry after a committed proof returns `proof-present` with submission disabled,
using the stored transaction's structural match and digest. It does not claim a
fresh verification, open a wallet, prove again or replace the proof. This also
handles a lost acknowledgement after the proof write. Neither success result
manufactures a completion token or submission authority.

## Native evidence

The [qualification manifest](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-proof-recovery-2026-10-05.json)
binds sources, tests, policies and six reports. Each case uses its own new disposable
public-vector profile and real enrollment, account scanning, private signer,
prover, verifier and encrypted stores. External chain, POI/list and transport
responses are simulated. The received input's synthetic creator transaction is
not proved by this fixture.

| Input creator | Operation          |  Duration | Report                                                                           |
| ------------- | ------------------ | --------: | -------------------------------------------------------------------------------- |
| Shield        | Transfer           | 22,674 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-proof-recovery-shield-transfer-2026-10-05.json)   |
| Shield        | Full withdrawal    | 21,867 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-proof-recovery-shield-unshield-2026-10-05.json)   |
| Shield        | Partial withdrawal | 21,406 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-proof-recovery-shield-partial-2026-10-05.json)    |
| Transact      | Transfer           | 25,218 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-proof-recovery-transact-transfer-2026-10-05.json) |
| Transact      | Full withdrawal    | 24,017 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-proof-recovery-transact-unshield-2026-10-05.json) |
| Transact      | Partial withdrawal | 25,516 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-proof-recovery-transact-partial-2026-10-05.json)  |

All six reports have the same **532 unchanged source hashes**. After the genuine
signer saves the signature, a fixture wrapper substitutes a refusal for the
broker reply. The genuine runner detects the result mismatch. Each case observes
the revoked utility's exit (`RAILGUN_SESSION_REVOKED`, integer exit code 15),
then independently checks that the identity remains current and a recovery phase
can be claimed and released. This is an injected broker fault with an observed
revocation exit, not a natural crash or power-loss test.

The public owner is reopened during setup without advancing its generation or
checkpoint. Measured recovery makes exactly two viewing-only utility/key calls
and one independent verification, with no new signing intent or spending-sign key.
Each case uses one read-only storage worker and exactly **41 protocol RPC calls**:
one genuine `eth_chainId` readiness check, 38 `eth_getBlockByNumber` calls and two
`eth_getLogs` calls. The production host binds the reviewed destination; no POI,
TXID-service, selected-nullifier, deployment, EOA or private-preflight query occurs
during recovery.

The original capsule, signature, ciphertext and reservation remain unchanged.
The capsule proof slot is written once, increasing its sequence by one; only the
capsule file and corresponding enrollment floor manifest change. Wallet database,
journal, coverage, inventory-marker bytes and account directory names remain
unchanged. The duplicate returns `proof-present` with no additional child, key,
RPC call or write. All children and storage workers drain, and borrowed keys are
wiped. Setup counts are reported separately from recovery; the original signer
necessarily runs during setup.

These cases use warm cached private stores and recover in the same application
process. Cold existing-only opening has unit coverage here; a new process, a
changed current tree root, physical Tor/socket drainage and live acceptance are
not established by these reports. The two-root behavior has account unit coverage;
native advanced-root recovery remains a required follow-up.

Reproduce with `scripts/qualify-railgun-proof-recovery.js` under Electron, passing
the pinned public source, a fresh output directory, pinned engine/prover archives,
artifact directory, bytecode fixture, input creator (`Shield` or `Transact`) and
kind (`transfer`, `unshield` or `partial`). The script authenticates the public
source hash and rejects an existing output directory. All six invocations must
use separate profiles.

## Tests and review

The direct suites pass **547 tests across nine suites** in 13.759 seconds; the
dependent prepare/operate, controller, submission, own-operation, staging and
Kohaku suites pass **374 tests across seven suites** in 8.56 seconds. Together
these cover 921 distinct tests across 16 suites. Full lint is clean. The [repository coverage run](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-proof-recovery-regression-2026-10-05.json)
passes **15,178 tests**, with 33 skipped, across 511 passing and five skipped
suites in **611.319 seconds**. The exact 1,371-file JavaScript/JSON inventory
is unchanged before/after (SHA-256 `3552c205e29e5193cabe333c315e5609c725ce9c841f79c4e454e45345edb233`).
The command is `npm run test:coverage -- --runInBand --forceExit --testPathIgnorePatterns=openlv-protocol.test.js --reporters=default`.
It retains the established OpenLV exclusion and forced Jest exit; this is not
evidence of natural test-runner handle drainage. Native child/worker drainage
is asserted separately by the six qualifiers.

An independent reviewer authored the 79 host tests using genuine transaction
normalizers and controlled authority fixtures. Detached guard-removal checks
confirm that removing the post-verification record comparison, candidate digest
binding or awaited wallet close produces failures. These are orchestration
controls, not native-store or cryptographic evidence. Claude reviewed production
changes, dependent-suite coverage, fixture authority boundaries and native reports.

## Remaining work

The wallet policy is now
`e7671ac4aacec46a4d8b099664aebd317b61f2196805301470014e93ccbf8ffa`.
Its changed job, run and runner inputs and new recovery modules mean existing derived wallet generations require
explicit maintenance. Recovery never silently rebuilds an old generation.
Public and TXID policies and pinned runtimes are unchanged. No funded profile was
opened. Freshly fetched main remains `dbfd0e7d`, already an ancestor of this branch;
no additional node installation is required for this checkpoint.

Next is genuine fresh-process recovery, including cold store leases and an
explicitly advanced tree before recovery. Partial submission/capture, durable
combined POI, normal change ingestion, restart/second spend and the funded private
transfer/withdrawal journey remain open. The integration has not yet reached
PPv2's live lifecycle coverage.
