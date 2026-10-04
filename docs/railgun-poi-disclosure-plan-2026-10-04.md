# Railgun genuine POI disclosure plans — October 4, 2026

This slice derives the
main-owned data a future confirmation flow can display and bind. It creates no
consent issuer, sender, renderer/IPC route or live disclosure permission.

## Genuine review input

Preparation internally loads an existing prepared POI record through genuine
account enrollment. It snapshots the full entry and genuine identity, registered
public policy/generation, and local own-operation recovery capture. The entry and
capture must agree on the capsule, selector and binding; exact record rereads and
account reattestation surround completion. The summary and opaque plan originate
from that checked state, not caller-supplied payloads or display objects.

The plan records the policy of the genuinely registered coordinator. It does not
compare that policy with the currently pinned engine archive, run a selector
utility, reverify the proof, check root acceptance or establish current eligibility.
The strict comparison of archived EOA journal anchors remains; those journal
facts are unrelated to the omitted engine archive argument.

The bounded immutable summary contains protocol/account index/chain, destination,
list, operation category, output count, the intended request inventory and explicit
timing/linkability/uncertainty categories. It excludes proof bytes, roots,
selectors, private binding hashes, wallet/profile identifiers, addresses, amounts
and transaction identifiers. All consent, transport, request-limit, proof/root and
spending flags remain false. The intended two root queries and one submission are
an inventory for future review, not enforced quotas or permission to perform them.

Only the existing single-output private-transfer shape (one blinded output, no unshield marker)
and full-unshield shape (no blinded output, unshield marker) are supported.
Payload normalization already rejects mixed combinations; plan binding also checks
the genuine operation category. This is not support for unshield with change.

## Freshness and lifecycle

An opaque handle registered privately binds the summary to its exact main-owned
source. Copying the handle or summary cannot reproduce that provenance. It is a
review identity only; nothing can confirm, consume or submit through it.

There is at most one idle plan and one admitted operation per account directory.
A successful new preparation replaces the old idle plan, even for another record
in that directory. Preparation that fails before replacement, or refuses as busy, leaves the old
plan under its original lifetime. Once replacement revokes the old plan, a
synchronous abort listener may also cancel the candidate; neither plan is then
restored. In particular, using the old wrapper signal for a new preparation
causes that cancellation. Identity-checked cleanup prevents stale close/timer/finally
callbacks from deleting a successor. Synchronous abort-listener reentry during
replacement remains subject to the operation owner.

Display freshness is provisionally 120 seconds from preparation start, measured
monotonically. A 45-second preparation leaves at most 75 seconds. Preparation
allows 15 seconds by default (including explicit `timeoutMs: undefined`), at most 45; each explicit revalidation allows at
most 15 seconds and the original remaining lifetime. Revalidation never renews
the deadline and returns the identical summary object only after repeating exact
entry/capture checks. It runs only when called, never by polling, and no account
recovery phase remains held while someone reads the summary.

Caller/identity/enrollment/coordinator/store cancellation and explicit close
revoke the plan. The original preparation signal governs the entire plan lifetime,
not only the preparation call. Cancelling even a recognized revalidation request revokes it;
a forged or superseded handle cannot revoke an unrelated current plan. A closed
cached store also invalidates the plan, including closure caused by another
consumer's integrity failure. Bounded unref'd timers enforce expiry, with
monotonic checks covering delayed timer dispatch. Close aborts immediately while
closed waits for admitted work to settle. Private snapshots and listeners are
released after drain; a healthy enrollment-owned store is not closed to end a
plan. No plan survives process restart.

Storage/account drift is detected on revalidation, not continuously by a watcher.
Routine journal confirmation/revision refresh is allowed by the existing stable
capture comparison. Active/archive transitions and changed archived finality
anchors refuse when seen by the explicit strict checks. The general recovery
helper's final automatic post-attestation uses a weaker stable projection
comparison and returns no capture. A later representation-only change there can
therefore pass this call; subsequent revalidation compares it against the saved
strict baseline and refuses. There is no final strict-anchor guarantee or writer
exclusion. Future user interaction and confirmation timing
remain design work; this provisional freshness window is not consent validity.

## Existing-store access and housekeeping

Enrollment now accepts `openPoiIntents({ existingOnly: true })`. Options are
validated before cached reuse. Missing or unsafe files refuse before key
derivation, factory, inventory or floor work, including on cached paths. Presence
is rechecked after draining an old store, and the constructor always receives
`create: false`, so later disappearance cannot create empty history. Ordinary
no-argument creation retains its existing behavior.

Output recovery and both retained-proof validators use this path too. Missing
storage now refuses while opening instead of creating an empty store and then
failing to find an entry; their sanitized stage remains `stored` because that
stage already surrounds both opening and reading. A disclosure plan never creates
missing intent history or changes a preparation revision, attempt or reserve.

An existing cold open is not byte-preserving: the first store open in an
enrollment renews its lease and may repair the manifest floor/inventory. Cached
reuse does not repeat initialization. Encrypted reads still derive storage keys;
there is no viewing/spending-key handoff or utility job for plan preparation.
Other enrollment-owned recovery stores keep their existing housekeeping behavior.
Qualification uses disposable fixture profiles only; the funded profile is not
opened or modified.

## Qualification

The focused runs pass 626 tests across four suites: 496 enrollment/consumer
checks, then 130 disclosure-plan checks. Lint passes. Real structural fixtures
exercise context/phase/capture comparisons with mocked authority boundaries.
Coverage includes exact arguments, policy/owner/record/capture drift, replacement,
late borrowed work, expiry, listener cleanup, malformed/forged handles and the
explicit final automatic-check limitation. Missing-file refusal, unsafe files,
races and cold-open housekeeping distinctions are unit-tested.

Seven selected baseline tests pass. Temporary in-memory source controls produce
one expected failure when entry snapshots are retained mutably, one when the
structured policy snapshot is omitted, four when cancellation releases an owner
before pending work drains, and one when an old plan is revoked before its
replacement succeeds. These controls ran against the earlier 124-test file;
the six final listener/replacement/default-timeout tests were then added and
passed in the final 130-test run. No repository source was changed for controls.

Offline transfer and unshield pass in 121.378 and 119.377 seconds, respectively,
with 204 matching source hashes each. The first full regression process exited
139 before producing a summary; the macOS report records SIGSEGV with a Node
process-kill frame. That report does not identify the underlying failing test
or establish causation. It is not counted as a passing run. The frozen-source rerun
with an explicit default reporter passes 11,612 tests / 33 skipped across 472
passing suites (five skipped) in 393.610 seconds, with native process access and
the existing OpenLV exclusion. Both native inventories still match all 204 hashes.
The increase is 148 tests: 15 enrollment, two cold-validation, one output-recovery
and 130 disclosure-plan cases. The passing rerun does not explain the earlier
process crash. Claude reviewed implementation, tests, controls, native evidence
and claims; this is engineering review, not an audit. The seven native cases cover
genuine preparation/revalidation, forged handles, failed/successful replacement,
cancellation, enrollment reopen and attempted-state invalidation. The last case
deliberately uses the existing attempt API on a disposable fixture record; plan
preparation itself does not authorize or perform that mutation. Assertions compare
exact refusal stages, logical records/sequence/reserves and EOA journal snapshots.
Counters show zero additional service calls, utilities or utility-key handoffs
during the plan stage. Earlier fixture setup performs synthetic service and
proving work. The earlier 17 membership, seven recovery, 13 proof, eight checks
and six storage cases remain. Enrollment reopen is within the same process;
the source/root services are simulated. There is no live-service evidence.

Reports: [transfer](qualification/railgun-poi-plan-transfer-2026-10-04.json) and
[unshield](qualification/railgun-poi-plan-unshield-2026-10-04.json). The earlier
checks stage records 14 utility guard reports / 1,274 canary checks with zero
prohibited attempts in each run; the plan stage starts no utilities and therefore
adds no guard reports. Earlier whole-source-closure reports remain historical.
Main remains `f2274ee6` with no unmerged commits; no dependency, node pin, runtime
policy, IPC or renderer change occurs. The new module belongs to main-owned
wallet review and persistence, preserving existing process responsibilities.

## Remaining boundary

A future trusted confirmation route must display this actual plan, revalidate it,
and issue a separately reviewed authorization for its exact disclosure scope.
Main-process access alone is not evidence of a human action. The future sender
must recheck the runtime policy, proof/account/root evidence, enforce request
limits, confirm durable attempt/floor/readback, bind exact bytes and drain the
one-use transport. Service resolution and retry safety remain unqualified.
