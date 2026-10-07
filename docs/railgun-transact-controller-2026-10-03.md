# Railgun Transact-input signing controller — October 3, 2026

The main-owned private controller can now sign and prove from a recovered
Transact note when it receives a genuine, unused staging receipt for the same
account, owners and request. Missing, forged, consumed or mismatched staging
refuses before opening stores or network contexts. Shield inputs preserve their
existing authorization serialization and reject unrelated staging.

The staging lifetime governs the controller from before its first asynchronous
acquisition. In A, the composer consumes staging once and verifies authenticated
creator evidence and the detached TXID path. Provenance cancellation also closes
the operation scope and its POI/preflight sources. After independent receiver,
POI and preflight checks, the controller acquires the exact staged root within a
reserved, caller-shortenable 20-second budget. Synchronous context checks enforce
that deadline between requests even if timer dispatch is delayed.

The explicit creator/offer digest comparison happens after root acquisition and
before B or any reservation. The genuine creator receipt was already tied to the
same operation window; this explicit comparison is not claimed to precede private
queries. POI input type must match the selected note. Root/provenance, POI,
preflight and window margins all reassert together, and subsequent assertions
must return the identical accepted provenance observation.

The Transact authorization digest adds a distinct discriminator and provenance
observation. Capsule/reservation schemas remain unchanged. Before key release, durable awaits
reassert gates; the existing one-use key permit repeats those checks before and
after vault derivation. Expiry after attempting `markSigning` retains uncertain
signing state even when no key was delivered. Cleanup revokes sources and drains
provenance before leaving A; it never closes the account from its own callback.

## Actual synthetic qualification

| Run | Controller | Staging plus controller | Spending-key replies |
| --- | ---: | ---: | ---: |
| [Transact transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-transact-controller-transfer-2026-10-03.json) | 3,563 ms | 7,275 ms | 1 |
| [Transact unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-transact-controller-unshield-2026-10-03.json) | 3,214 ms | 6,913 ms | 1 |
| [Shield transfer regression](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-transact-controller-shield-2026-10-03.json) | 4,124 ms | not applicable | 1 |

These are single local measurements from concurrently running qualifications,
not production latency estimates. Each report contains 19 recovery runs and
130 matching before/after source hashes. Real enrolled vault/key handoffs,
encrypted stores, creator capture, detached verification, B signing, A proving,
C verification and completion recovery run with the pinned engine/prover.

Each Transact slice admits exactly one B launch and one spending-key request via
pre-dispatch counters. External transports and forbidden private RPC remain zero.
Five independently revocable simulated public services receive six latest-root,
one page and five root queries. POI and preflight each run once, and the simulated
EOA service records one context, one journal check and two requests. Duplicate
and unstaged retries leave all those counters and durable state unchanged.

An exact controller hold/capsule/signature/proof digest is captured immediately
after qualification and compared after subsequent cache rebuilds and again after
enrollment reopen. The retained signing record is separate from the fixture's
older synthetic reservation-lifecycle record. This qualifies preservation and
exclusive inspection, not a new interrupted-signing recovery controller.

The old Shield fixture still exercises negative POI before its successful proof.
That negative case is explicitly null for the one-use Transact runs; corresponding
failure gates are covered by unit tests. All three runs check wiped key buffers,
signature/proof persistence, completion identity/single use and unchanged durable
state on rejected reuse.

## Review and remaining scope

Ninety-five focused tests pass across controller, staging and provenance suites;
lint passes. Tests cover missing/forged/consumed staging, digest/checkpoint
mismatch, root expiry after reserve/put/mark and during derivation, POI expiry
during root acquisition, cancellation during POI, callback drain and a root
deadline expiring before its timer dispatches. Codex reviewed the production
ordering and found two qualification evidence gaps: missing simulated EOA
counters and a recovery baseline captured after rebuilds. Both are fixed and all
three final reports were independently checked against their source hashes.

The creator history is deliberately constructed from a public test mnemonic;
root, POI, preflight and EOA services are simulated. This establishes local
admission/signing composition, not valid funded spending or network anonymity.
Bound-parameter authentication and global TXID completeness remain false.
No live POI, live nullifier query, transaction submission or new product UI is
part of these runs. Owned-note disclosure approval remains pending.

Next: combined Transact completion/submission qualification, interrupted signing
recovery, post-transaction POI and second spend, broadcaster support, and funded
private operations. Existing main-process wallet boundaries are preserved;
no dependency, runtime downgrade or renderer/IPC surface was introduced.

## Full regression

The frozen production, fixture and test tree passes 9,253 tests / 33 skipped
across 436 passing suites in 303.371 seconds. The prior OpenLV exclusion remains.
Lint passes. Main `b18d571b` remains merged with the node refresh recorded in the
[preceding integration report](railgun-transact-provenance-2026-10-03.md#main-integration-and-regression).
