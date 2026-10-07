# Railgun attempted-output revalidation — October 4, 2026

Implementation and offline qualification are complete. This slice is an unwired,
attempted-only diagnostic, qualified only with disposable intercepted fixtures.
It must not run on the funded profile: receipt, source-range and current-TXID
queries still disclose activity and require separate live authorization.

## Why another read is needed

The sender retains the exact request and its uncertainty, but does not persist its
validation result. Later recovery needs to bind the saved output to the creating
transaction again. A transfer reconstructs its output with a viewing credential;
an unshield binds the creating Railgun TXID to the saved marker and releases no
viewing key. Neither result establishes output eligibility, acceptance of the
specific POST, non-delivery or safe retry. Eligibility lookup itself is excluded.

`recoverRailgunAttemptedPoiOutput` loads the existing account-owned attempted
record, normalizes its complete saved submission, and retains an exact detached
baseline. It accepts owners, pinned engine, capsule digest and caller lifetime;
no supplied entry, proof, endpoint, observation, reader, state override or approval
flag. Completed-source preflight obtains its own receipt observation and binds the
creating transaction, source, TXID and output. Strict comparisons apply within the
new invocation; a fresh baseline can legitimately describe a record archived since
the original attempt. Recovery's existing final outer check can permit later
representation-only drift; this is not an atomically current snapshot receipt.

Every current-entry read must equal the complete original attempted record. The
original revision, timestamp, request ID, canonical bytes and body/payload digests
remain unchanged. No intent transition, response, eligibility result or resolution
is persisted, and both remaining reserves stay intact. Cold-open storage leases,
manifest-floor repair and mirror housekeeping are not ciphertext immutability.

Success remains a frozen diagnostic with all authority flags false, including
`submissionAccepted`, `eligibilityEstablished`, `attemptOutcomeKnown` and
`retryEnabled`. It does not rerun the saved POI proof or accept its original roots.
All existing prepared-only consumers keep rejecting attempted entries.

## Exclusion and lifetime

A synchronous `claimRailgunAttemptedPoiOutput` helper uses the plan module's same
private directory map. Genuine owners and their current policy/generation bind the
claim; its exact private token is installed after validation without an await.
A failed shared claim returns the bounded stage `busy` (claim unavailable),
including owner/lifetime invalidation discovered during that claim; it supplies
no `sourceOutcome`. It never changes another owner or idle plan. A subsequent
local output-owner conflict retains its existing `context` refusal and releases
the newly acquired shared token. The diagnostic
holds this shared claim before opening its store and until all admitted work and
cleanup drain. Cancellation invalidates currentness but does not release ownership.
Release is idempotent, nonthrowing and cannot remove a successor's token.

This prevents the new attempted diagnostic from overlapping the sender's durable
handoff, POST or held transport close. The sender's existing inner output path
does not acquire a duplicate claim. Other legacy diagnostics retain their current
exclusion behavior; this does not establish a global lock across all diagnostics
or journal writers. Output recovery still has its separate per-directory owner.

The whole diagnostic keeps its nonrenewing 240-second maximum, with at most 180
seconds of preflight and 60 seconds afterward. Existing key-admission, utility-exit
and borrowed-callback drain rules remain. An uncooperative admitted task can exceed
deadlines while draining. No hard cleanup limit or physical closure of every shared
service socket is established.

The shared viewing-job cleanup is also hardened for every output route: a throwing
`task.close()` cannot skip awaiting child closure and borrowed work, or wiping the
key copy. A rejected closure promise likewise cannot skip the later drain/wipe.
This is a real exceptional-cleanup change to existing prepared/submission paths,
so the new qualification includes sender and durable-attempt compatibility.

## Disclosure and traffic limits

The source destination is observed internally without querying. The receipt client
is prepared and consumed within preflight, not before entry into this API. There
is no review callback; a future live recovery controller must separately bind and
review the actual destinations and query scope. Possessing an attempted record or
receiving `matched` grants no consent.

The reused cold path has a conservative upper bound of 551 RPC requests and six
current-TXID service requests (three latest/root pairs), or 557 logical requests.
Active journal records require one fewer header than archived records. Source
reads remain always cold and do no stage/retain/before-acquire/apply maintenance.
Pending source state can refuse after earlier receipt/TXID disclosure. These are
not packet, connection or Tor-circuit bounds, and 557 is not a minimum future
resolution cost. No owned-note status/membership/event lookup, original saved-root
query, proof generation, spending key, raw transaction or POI POST is included.

## Qualification

Focused qualification passes 508 cases across three suites in 48.474 seconds;
full lint passes. Two temporary mutations produce four expected assertion failures
against four passing baseline cases: omitting the shared claim admits later stored
or preflight work during three sender overlap cases, and omitting the exact attempt
ID join incorrectly returns a matched output. Helper tests exercise the real plan
map with mocked owner authorities; crypto/preflight/process boundaries are mocked.
Worker close/closure exceptions, borrowed work and key wiping are covered for both
prepared and attempted paths. There are no unit-level live acceptance claims.

Four frozen native runs pass with 209 matching source hashes each:

| Mode | Transfer | Unshield |
| --- | --- | --- |
| Attempted output and eleven durable-attempt compatibility cases | [129,268 ms](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-attempted-output-transfer-2026-10-04.json) | [123,696 ms](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-attempted-output-unshield-2026-10-04.json) |
| Sender overlap and attempted recovery after cold reopen | [147,230 ms](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-attempted-output-sender-transfer-2026-10-04.json) | [143,700 ms](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-attempted-output-sender-unshield-2026-10-04.json) |

Each preserves 17 base scenarios, seven recovery and thirteen proof exercises.
Attempted-output mode adds prepared refusal and a successful cold match for both
kinds; transfer also refuses a substituted output and then matches a healthy rerun.
Sender mode preserves four sender/reopen cases, refuses attempted recovery while
the dedicated POST close is held, and matches after release and cold reopen.

Each attempted validation performs 34 headers, one transaction, one receipt, two
head reads, one logs request and three current-TXID latest/root pairs. Chain-ID
handshakes are two on the initial source/receipt clients and one with the retained
source client. One cold planner runs every time; no source maintenance or POI
verifier starts. Transfer uses one viewing handoff, unshield none. Fixture broker
assertions reconcile 11 mirror calls (12 after the sender fixture advances its
mirror), three public-plan calls and seven/six utility guard reports. Those broker
counts are internal messages, not additional service requests.

Every scenario retains the exact entry, sequence, reserves and journal. A subsequent
query-free shared claim proves release even after the final unshield match. During
held POST cleanup, the attempted diagnostic returns exactly `busy` with no new
queries, jobs, utility work, source maintenance, RPC clients, wire activity or logical
store/journal change; the sender remains pending and completes after release.
Zero store-open calls are established by unit tests, not measured natively. All four
native runs passed against their first frozen source inventory; no native failures
are counted or excluded for this slice. The full combined regression passes
12,487 tests with 33 skipped across 488 passing suites in 452.208 seconds
(native-process permissions and the existing OpenLV exclusion). Claude reviewed
implementation and evidence; Codex supplied production and independent tests.
All 24 policy inputs remain unchanged; fresh main
is still `6b5c2ea7`. Native wrong-output
substitution is exercised for transfer only; unshield wrong-marker refusal is checked
at unit level. Each completed native diagnostic also acquires/releases a fresh
shared claim to prove the previous invocation released its token. The previous
sender milestone is `a49e892d`; these sender reports supersede its reports as
current evidence because included source hashes changed. This slice adds no UI, IPC, dependencies or package responsibilities.
