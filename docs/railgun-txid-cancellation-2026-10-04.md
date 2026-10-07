# Railgun caller cancellation through TXID opening — October 4, 2026

Caller cancellation now reaches pending TXID startup and its storage opening.
The code, focused tests, native compatibility runs and full regression below
were qualified against frozen files.

The account TXID API gains an optional caller AbortSignal. It governs the entire
returned account lifetime, including a pending opening. Omitting it preserves
existing enrollment/coordinator lifetime behavior. Invalid and already aborted
signals refuse before policy work, phase acquisition, key borrowing or worker
creation. Composition callers supply their operation lifetime, rather than a
signal which expires immediately after startup.

Cancellation revokes the local scope, services, runner, journal and storage
session. Separately tracked initialization and admitted method work must settle
before phase release; any late worker or store handle is retained and drained.
A caller deadline bounds admission, not the duration of ignored cancellation or
cleanup; there is no hard drain-time guarantee.
The close promise is installed before synchronous abort listeners can reenter it.
Borrowed key callbacks are awaited, allowing their existing key wiping to finish.
The shared enrollment, public coordinator and catalog are not closed to cancel
an account opening. Existing coverage callback failures retain their separate
coordinator failure behavior.

The storage helper checks cancellation around catalog inspection, key callbacks,
worker creation/readiness, identity inspection, initializer publication and
inventory registration. Filename ownership remains held until the opening and
worker exit have settled. An already admitted filesystem operation or normal
journal housekeeping is not rolled back by cancellation. Interrupted initializer
files remain retained under the existing bounded policy.

The existing root reader already checks its active privacy context between
latest-root and root-validation requests. Binding the caller to that context
prevents a late, ignored-abort latest response from admitting validation. If
validation itself was already admitted, cleanup awaits it and no subsequent job
or result is admitted. This does not retract a request already delivered.

The own-witness/preflight shared core and Transact staging pass their operation
lifetime into opening. Retained-history validation additionally uses a mirror
cancellation signal: its nonrenewing timer must revoke an opening which has not
yet returned, rather than merely recording expiry. Existing overall budgets,
final reserves, checkpoint-only refusal rules and handoff exclusion remain.

These host changes stay outside the TXID and public policy source lists. No new
mirror policy or automatic rebuild follows. The root algorithm, service payloads,
runner and journal policy inputs remain unchanged. Existing whole-source
qualification reports become historical as host files change; new inventories
bind the reruns to this implementation.

Cleanup claims cover observed utility/storage exit and borrowed work. The
service and root wrappers do not yet expose the transport's physical socket
closure barrier, so this continuation does not claim actual socket drain. It
adds no disclosure approval, POI sender, renderer, IPC, live query or funded
profile operation. Main-process account composition remains in its existing
modules, with no package boundary or dependency change.

## Qualification

The optional `cancellation` mode of `qualify-railgun-own-witness.js` adds five
scenario groups to its eight existing witness cases. Both transfer and unshield
pass with 143 matching source hashes in 11,847 and 11,790 ms respectively.
The [transfer report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-txid-cancellation-transfer-2026-10-04.json)
and [unshield report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-txid-cancellation-unshield-2026-10-04.json)
preserve the exact observations. These
are single offline fixture timings, not latency guarantees.

Invalid and pre-aborted signals produce no new workers, utility jobs or service
calls. Two scenarios hold a synthetic latest or validation response after it was
admitted, deliberately ignoring abort. The real root reader and account lifetime
must keep the phase occupied until that response settles. Cancelling latest
permits zero validation requests; cancelling an already admitted validation
permits no additional job or result. Both observe the actual storage worker exit
before the phase can be reclaimed. A witness-caller case verifies forwarding
through its real selector utility; that job also exits. Returned-account
cancellation revokes future methods and tolerates repeated close.

After each relevant refusal, the same healthy coordinator is reused, the exact
authenticated checkpoint is unchanged on reopen, and public snapshot access
succeeds. The fixture asserts factory load order and positive baseline worker/job
counts before interpreting zero-work results. Aggregate counters in the report
are captured before final teardown: two shared source/public workers are still
open at that point. Per-scenario exit counts qualify the cancelled account work,
not global process shutdown or physical sockets.

The 143-file inventories bind the account and witness composition, including the
store, account host and real root reader. They exclude cold-validation code and
its tests, which are covered by the separate retained-history inventories.

These fixtures use genuine disposable vaults, encrypted stores, guarded utility
processes and the actual root-source composition. Service responses and chain
observations are synthetic; the source history is deliberately empty and spend
proof/signature fixtures are structural. No live endpoint is contacted. Reports
contain counts and redacted facts, not account records or private selectors.

Six focused suites pass 506 tests in 37.814 seconds; lint is clean. Three isolated
controls distinguish the cancellation boundaries. Removing the caller from the
TXID scope admits one unwanted late validation; disabling mirror-timer abort
leaves pending startup live at 180,000 ms; removing witness forwarding in memory
makes the actual native witness case admit one validation instead of zero. The
first two controls have a three-test passing baseline. The native control uses
the passing transfer fixture, logs its original and modified source hashes and
emits only sanitized integer assertion values. Repository files remain unchanged
by these controls.

The first retained-history rerun completed its behavior assertions but refused
the final source-inventory comparison: its inventory includes a test file still
being finalized during the run. It is not counted as passed. The reruns start
after the full source/test freeze. Retained-history
[transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-txid-cancel-history-transfer-2026-10-04.json) and
[unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-txid-cancel-history-unshield-2026-10-04.json) pass
in 131,323 and 130,641 ms with 204 matching hashes each. Both exercise a substituted
historical root refusal followed by healthy validation, alongside the existing
membership, recovery, proof and intent scenarios. These runs bind cold-validation
source and tests to the current host code. Their service observations are still
synthetic and establish no live root acceptance.

The frozen full regression passes 11,755 tests / 33 skipped across 474 passing
suites in 400.581 seconds (native access; existing OpenLV exclusion).
The [enrolled staging rerun](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-txid-cancel-staging-2026-10-04.json)
passes all 19 existing surrounding cases with 130 matching hashes. Its staging
step takes 3,968 ms, restores the checkpoint through the actual phase handoff,
recovers the same owned note, observes detached verifier exit and refuses staging
reuse. It records six latest reads, one page and five root validations through
five synthetic service instances. Staging guard counters remain zero for signer
launches, spending-key requests, transports and unrelated RPC. Those counters
apply to the staging step; surrounding existing fixture cases use public test
keys for their own proof/signing tests. Main is still `f2274ee6` after a fresh
fetch; no main merge or binary refresh was needed for this slice. Claude reviewed both production
stages and the native fixture; Codex provided implementation and independent
tests. This is engineering review, not a security audit.
