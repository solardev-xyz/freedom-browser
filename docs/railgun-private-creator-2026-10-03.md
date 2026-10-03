# Railgun operation-window creator capture — October 3, 2026

A main-owned operation window can now capture the creating transaction for its
selected Transact note from the coordinator's retained source snapshot. The API
accepts only the genuine window, account and owners. It derives the selector
internally, requiring exactly one owned record and one received, unspent note
with matching position, hash and transaction identity. Caller-provided selectors
or logs cannot obtain a window receipt.

The capture consumes its attempt before asynchronous work and uses the existing
snapshot's one-use source visitor. It neither opens a nested coordinator snapshot
nor exposes the visitor. The bounded helper retains every proxy log for the
selected transaction and awaits the entire ledger visit, including range digests
and final prefix authentication, before returning. Semantic mismatches are
latched while the stream drains. Cancellation or capacity failure refuses.

Selected logs must agree on block number/hash and transaction hash/index, be
ordered, and fit a strict single-row creator shape: Nullified, optional Unshield,
then Transact. The parser uses the production ABI, including full ciphertext
arrays, and requires canonical decode/re-encode equality, matching hash/ciphertext
counts and exactly one matching selected output. Extra rows, unknown selected
events, inconsistent metadata, malformed encoding or a missing output refuse.

The resulting private WeakMap receipt binds the exact operation window, account,
owners, transaction digest and captured checkpoint. Copied objects, another
window, reuse of the capture attempt, and expired windows refuse. The account
revokes the window and drains any outstanding capture before releasing its phase,
even when the handler starts a capture and returns without awaiting it.

## Review and verification

The Codex reviewer found an unhandled-rejection edge in the initial implementation:
an async method returned a second promise adopting the internally observed one.
The method now returns the same tracked promise directly. A regression test uses
`void capture(...)` with no caller rejection handler, returns from the operation,
and verifies phase retention until drain. Restoring the old async wrapper makes
that test fail; the fixed implementation passes. The combined creator,
account-window and coordinator tests pass 101 cases; lint is clean. The Codex
reviewer approved the corrected slice with no remaining blocking findings. Full
regression passes 9,115 tests / 33 skipped across 432 passing suites (292.14
seconds), retaining the prior OpenLV exclusion.

These tests exercise the real ABI parser and lifecycle gates with controlled
source/runner fixtures. They are not a funded Transact-input qualification.
No live RPC/POI requests, wallet key releases or submissions were made by this
slice. Existing submission qualifications remain evidence for their recorded
source revisions.

## Authority limits and next step

`eventSourceAuthenticated:true` means the full cached prefix was authenticated
against the snapshot's existing source observation. Its trust remains
`unverified-rpc`. The coordinator refreshes canonical headers only after its
callback returns; this capture does not claim a fresh in-window header check or
cryptographic chain verification. The source visitor's own freshness requirement
continues to apply independently of the longer operation window.

The receipt establishes no TXID membership, accepted root, POI or spending
permission. Those flags remain false, and the private controller still refuses
Transact inputs. Next, acquire the detached witness between fully drained wallet
and TXID phases, rederive the selected note after reopening the wallet, compare
this authenticated creator evidence with the detached verifier, then bind fresh
root/POI evidence and remaining-time margins before signing.

The collector and receipt remain in the existing main-owned wallet boundary; no
renderer channel, dependency or top-level package responsibility changes. Parsing
and lifetime enforcement stay with the existing source and account services.

## Existing-checkpoint TXID staging prerequisite

`openRailgunAccountTxid` now supports explicit `checkpointOnly:true` with
`create:false`. It requires a nonempty existing checkpoint under the current
policy, rejects pending work before root acquisition or replay, pins the whole
checkpoint across later reads, and refuses `advance()` before fetching a page.
Ordinary public root revalidation remains required. This is not storage-write-free:
journal opening still renews lease/generation/sequence metadata. Default recovery
and replay behavior remain unchanged for ordinary callers.

Fifty-five root/account-TXID/journal tests pass, including same-root store-identity
replacement refusal; lint is clean. Codex independently approved the mode and
flagged the lifecycle-write distinction above. No live request was made. The
wallet replacement controller remains next.

## Account-wide handoff exclusion

A genuine current wallet can reserve its account directory for a phase handoff
before the first await. The reservation survives closing the wallet and blocks
ordinary wallet, TXID and recovery claims during the gaps between phases. Only
the exact opaque token and enrollment may enter an active-wallet or
checkpoint-only TXID phase; the token never bypasses an existing phase owner.
Recovery claims, stale tokens, copied tokens and a different enrollment for the
same directory refuse.

Phase and reservation releases are separate, identity-checked and idempotent.
Cancellation does not unlock the directory automatically. Failed opening retains
its phase until work/worker drain and leaves reservation ownership with staging.
After successful replacement, releasing the reservation leaves the new wallet's
ordinary phase exclusion intact. Staging must explicitly release only after its
own cleanup; the complete wallet/TXID/wallet staging controller is still next.

All 167 phase/account/enrollment/reservation tests pass across five suites; lint
is clean. The Codex reviewer approved the implementation and delayed-worker
failure cases. No renderer capability, service endpoint or dependency was added.

The [enrolled Electron regression](qualification/railgun-handoff-exclusion-enrolled-2026-10-03.json)
also passes all nineteen existing scan/restore/recovery cases with 110 matching
source hashes, synthetic public history and zero live acquisition/submissions.
It confirms existing enrolled flows still work after the phase changes; the new
reservation's failure/race behavior is covered by the focused tests above. It
does not exercise a complete Transact witness-staging or spending controller.
