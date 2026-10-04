# Railgun durable POI attempt — October 4, 2026

This slice adds persistence of an exact attempted request, without a sender,
disclosure permission, live query,
acknowledgement, retry or proof-registry restoration.

## Persistence contract

The store selects its own prepared record by capsule digest and expected
preparation revision/payload digest. A bounded genuine account recovery window
binds the retained capsule and selector. Under the shared prepare/attempt mutation
guard and exclusive authenticated update, it allocates one timestamp, uses that
same value as the canonical request ID, and persists the complete request envelope.
The endpoint, method, payload, field order and body hashes come from the existing
submission-data normalizer; callers cannot supply them.

The attempted entry keeps its original preparation revision and adds
`attempt: { attemptedAt, submission }`. The document sequence advances once.
Each prepared record reserves three future transitions; an attempted record has
consumed one and reserves two. Maximum document sequence remains 128, with 32
records and at most four preparation revisions. Preparation must refuse attempted
entries before its identical-record shortcut; a repeated attempt also refuses.
Recovery reads the saved entry instead of allocating a new request ID. The ID
is the original local attempt time; sending those bytes later would disclose that
time to the service, not just the time of transmission.

The encrypted logical record, storage subject, filename, key derivation and
manifest-floor namespace remain unchanged. New and prepared-only documents stay
at inner schema version 1. The first attempt atomically writes inner schema version
2 alongside its sequence increment; subsequent mutations preserve that version.
The AES storage envelope and manifest floor keep their existing version. There is
no namespace reset, deletion or migration into a fresh sendable store.

Only bounded persistence facts return. They do not attest proof validity, source
currency, root acceptance, consent or transport admission. The existing output
recovery and both retained-proof validators must reject attempted entries at their
first stored-state gate, before preflight, utilities or credential release.

There is currently no production caller of `beginAttempt` and no state that can
resolve an attempted entry. It is a terminal state in this implementation:
reprepare, repeated attempt and all three prepared-record consumers refuse.
Qualification uses disposable fixture profiles only. It must not be invoked on
the funded Railgun profile; doing so would strand that prepared POI record until
separately implemented recovery exists. The existing PPv2 profile is untouched.

## Failure semantics and rollback limit

An attempted record means conservatively possibly disclosed/submitted, even when
no transport ever ran. In this slice no transport exists. Once writing could have
committed, failed completion requires reading authenticated durable state; a
refusal does not prove the entry is still prepared. Cancellation or an ignored
completion must never trigger a rollback, fresh envelope or automatic retry.

The intent document and manifest floor are separate atomic writes. A committed
attempt with a failed floor update survives ordinary reopen, which repairs the
lagging floor. However, restoring the pre-attempt ciphertext while the floor still
has its previous value can restore prepared state. After the floor advances,
that older document is rejected. Coordinated rollback of both files remains a
separate limitation. This is not atomic protection across the two files.

A future sender must wait for the attempted document, advanced floor and complete
readback to be confirmed before admitting any network request, then recheck its
own fresh authority. This slice issues no such authority. Advancing the floor
first is not a solution: a failed document write would strand the store below its
floor. Cleanup retains store ownership until ignored recovery/storage work drains.

## Qualification

The final focused store run passes 227 tests, using genuine encrypted storage for stale selections,
exact-envelope persistence, v1/v2 compatibility, mixed-state capacity,
attempted-state guards, cancellation, rename/floor/readback failure and restart
recovery. The earlier combined run passes all 443 consumer tests, including early refusal
by output recovery and both retained-proof validators; its sole store failure was
a retry fixture that retained its cancellation callback, fixed in the final store
run. The frozen full regression below covers the final tree together.
Lint passes. Four selected baseline controls
pass; removing the expected revision/hash comparisons makes stale selections
incorrectly become attempted. Removing the preparation state guard causes an
unnecessary store closure at the later sequence check, instead of a healthy
conflict refusal. These are temporary in-memory controls, not source changes.

The actual prior store reader pinned at `86172bfe` accepts a prepared v1 baseline,
refuses an attempted v2 document without changing ciphertext or the modeled floor
value/advance count, and the new reader subsequently recovers the identical
attempt. This temporary compatibility test uses real encryption with mocked
account authority and floor callbacks; it does not establish old-reader native
manifest-file compatibility.

The native fixture adds a separate attempts mode. It tests reprepare while
the original proof is still genuine, before enrollment reopen, so registry
revocation cannot mask the state guard. It discards attempt completion, reopens
and compares the exact envelope/body and timestamp. Store reopen renews its lease
and ciphertext; those bytes are not claimed unchanged. The attempt phase asserts
no additional utility/key handoff, service activity or EOA journal mutation.
This remains one harness process with
synthetic services and a disposable public identity, not a full browser restart
or a live submission.

Both frozen native runs pass with 202 matching source hashes each:
[transfer](qualification/railgun-poi-attempt-transfer-2026-10-04.json) in
116,582 ms and [unshield](qualification/railgun-poi-attempt-unshield-2026-10-04.json)
in 119,881 ms. Each has eleven attempt scenarios, alongside seventeen membership,
seven recovery, thirteen proof, eight checks and six storage scenarios. The
attempt phase adds zero utilities, utility-key handoffs or service queries;
all three consumers refuse before work, both before and after reopen. EOA journal
snapshots remain unchanged. Earlier setup/checks still perform synthetic service
and utility work; their fourteen guard reports cover 1,274 canary checks with zero
prohibited attempts. No additional attempt-phase guard report is claimed because
no utility starts. This mode does not rerun successful output/history diagnostics.

The frozen full regression passes 11,253 tests / 33 skipped across 471 passing
suites (five skipped) in 385.681 seconds with native access and the existing
OpenLV exclusion. Command: `npm run test:coverage -- --runInBand --forceExit
--testPathIgnorePatterns=openlv-protocol.test.js`. Both inventories still match
all 202 hashes after completion. The fresh main fetch remains `f2274ee6` with
`HEAD..origin/main = 0`; no further node refresh is needed. Claude reviewed source,
tests, mutation controls, both native reports, documentation and the completed
regression. This is engineering review, not a security audit. No dependency, binary pin, TXID policy, IPC,
renderer, live network operation or funded profile changes are introduced.
