# Retained Railgun POI preparation — October 4, 2026

The main-owned POI intent store retains a locally proved payload across store and
account reopen. It is opened lazily by enrollment, in a separate encrypted file
with its own purpose-derived key, profile inventory entry and manifest sequence
floor. It adds no renderer surface, IPC channel, dependency or network request.

Only `prepare({ proof, coordinator, signal })` can write. It authenticates the
process-local proof registry entry against the owning enrollment and coordinator,
rebuilds the host-bound payload and checks its digest, then opens the existing
account recovery window. Strict capture comparison and reattestation precede the
write. The store persists, advances the manifest floor and reads back both before
reattesting the account again. Recovery stays held until this work settles. The
underlying writer is private; caller-supplied binding digests cannot invoke it.

The stored record contains the capsule and operation binding digests, private
recovery selector, normalized payload and its digest, original proving-input
digest, revision and `prepared` state. Reads return frozen data. A copied proof
object or restored record has no authority. Reopen currently restores data only:
reconstructing current account/source evidence and independently verifying the
retained proof before a future send remain separate work.

Version 1 accepts only prepared records. An identical preparation does not write;
a newer genuine proof can replace an unsent preparation for the same capsule and
selector, up to four revisions. Previous unsent payload versions are not retained.
Capsule digests and nullifiers are unique. There is no attempt, submission,
acknowledgment, inclusion or retry API. A future schema must preserve attempted
uncertainty and admit transport only through its authorization controller; older
readers must refuse that newer schema.

## Bounds and failure behavior

The lifetime limits are 32 records and sequence 128, without pruning. Sequence is
the sum of preparation revisions. Every write preserves
`sequence + 3 * recordCount <= 128`, reserving one future attempt and two bounded
observations per entry. Revision churn therefore reduces room for new entries,
while preserving the reserves of existing entries.

Each current record plus a complete canonical submission envelope using the
largest safe numeric request ID must fit within 16 KiB. Another 8 KiB per entry
is reserved for future observations; 32 such allocations fit below the 800 KiB
document cap and the encrypted storage primitive's 1 MiB per-value limit. Future
schemas must enforce these observation bounds or deliberately migrate them.
The placeholder envelope used to check capacity is never retained or sent.
The per-entry 16 KiB boundary is a defensive limit that the current strict
payload schema cannot approach; its boundary is not directly unit-tested.

Closing revokes access immediately and wipes the storage key. Filename ownership
and the `closed` promise remain held until initialization, reads, writes, floor
callbacks and any preparation recovery window settle. Enrollment also tracks the
temporary derived key so closing during a hung initialization wipes that copy.
An uncooperative callback can consequently keep reopening blocked indefinitely.

Cancellation or expired proof/window checks refuse without closing otherwise
healthy storage. Storage, decoding, compare-and-swap, floor and readback failures
close it and require reopening. A refusal after persistence can still leave a
prepared record; it must not be interpreted as proof that nothing was written.
The retained record grants no permission, even when preparation returned success.

The manifest floor detects a document restored below its recorded sequence. It
cannot detect a coordinated restoration of the entire profile and manifest.
The inventory detects a missing initialized file; it is not rollback protection.

Capture comparison is deliberately strict in this version. A proof made before
the operation was archived cannot be prepared after archival without renewed
proof history; this path has no fresh archive-anchor check with which to rebase
the comparison. No journal-writer exclusion after recovery closes is claimed.

## Qualification scope

Focused tests exercise real encrypted files with controlled proof/recovery
boundaries; enrollment tests also cover lazy migration, inventory, temporary key
wiping, interrupted initialization and cold imports. The native qualifier's
`intents` mode extends the existing proof/checks scenarios with genuine local
proof preparation, duplicate no-op, encrypted store reopen and account reopen.
It checks that copied/restored data and old-owner proofs refuse, and compares
service and utility counters around the storage work, including refused attempts.
Selected private values, including a proof coordinate, must be absent from the
encrypted file's plain text. These native scenarios cover clean storage paths.

Cancellation without closure, capacity/conflict/revision/reserve refusals,
malformed or oversized documents, unsupported states/versions, rollback, storage
faults, pending-write drain and cold import isolation are unit-level scenarios.
The native fixture does not inject those storage faults.

All 394 focused tests across seven suites pass, including 128 new store tests and
eight new enrollment cases. Lint is clean. The final native
[transfer](qualification/railgun-poi-intents-transfer-2026-10-04.json) and
[unshield](qualification/railgun-poi-intents-unshield-2026-10-04.json) reports each
pass six storage, eight checks, 13 proof, seven recovery and 17 membership cases
with 191 source hashes verified against this tree. Elapsed times are 115,611 and
113,491 ms; proving peaks are 477,691,904 and 431,833,088 bytes. These include the
preceding proving/checks scenarios; the new storage stage adds no service or
utility-process activity. Both reports retain the original synthetic-chain,
fixture-signature-trust and structural spend-proof/signature limitations. They
use input tree/position zero. Neither qualifies live Tor or OS-wide host egress.

The frozen code/test/fixture regression passes 10,424 tests / 33 skipped across
466 passing suites in 315.212 seconds, using native-process access and the existing
OpenLV exclusion. Both reports' 191 source hashes still match after that run.
Claude and Codex reviewed production, tests, fixtures, evidence and claims; this
is engineering review, not an independent security audit.

This document does not claim a live submission,
service acceptance, current note eligibility, second spend or full process restart.
Proof-specific live root checks, owned/output selector queries and transmission
remain subject to the outstanding disclosure authorization.
