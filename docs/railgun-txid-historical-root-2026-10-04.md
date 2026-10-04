# Local historical Railgun TXID roots — October 4, 2026

The existing guarded TXID projection can now reconstruct the local tree root at
an earlier index. The account-owned TXID reader exposes `historicalRoot(index)`
as immutable diagnostic facts. The expected retained POI root is deliberately
absent from the utility input. This slice does not connect the result to retained
POI validation, query a historical root service, restore a proof-registry entry or
authorize disclosure/spending.

## Boundary-leaf reconstruction

The primitive accepts one inspected current checkpoint and a zero-based index
between zero and `count - 1`, with at most 8,000 rows (tree zero). It snapshots the
checkpoint before any asynchronous read. It reads and cryptographically inspects
the boundary row, obtains its current TXID witness and requires that witness to
identify exactly the requested position. The complete current path must reach
the captured root, including right subtrees that will subsequently be discarded.

Starting from the authenticated boundary leaf, each odd cursor combines the
completed left sibling with the working node. Each even cursor combines the
working node with the pinned empty subtree. Sixteen levels produce the root for
exactly `index + 1` rows. Completed left siblings precede the boundary and remain
unchanged under coherent appends. Current right subtrees can contain later rows
and cannot be reused in the historical calculation. Stored ancestor nodes are
also overwritten by appends, so reading an old ancestor key is insufficient.

The algorithm requires at most 19 projection reads: a boundary row, TXID lookup,
second row read and up to 16 siblings. The job additionally reads current state.
There is no prefix scan, storage write, key handoff or supplied expected-root
oracle. At the latest index, the reconstructed root must equal the current root.

The result contains the computed root/index and the current checkpoint's
index/root/transcript. That transcript describes the current checkpoint, not a
reconstructed historical transcript. `localPrefixComputed` is true;
`globalTxidCompleteness`, `ownershipVerified`, `eventCoverageVerified`,
`rootAccepted` and `spendingEnabled` remain false. Equality with a saved POI root
would establish local prefix consistency, not historical service publication,
canonical chain completeness or current service acceptance.

## Account and process ownership

The new exact `historical-root` mode uses the existing engine utility and
`txid-historical-root` context. Startup input remains `{archive, mode}`; broker
payload is exactly `{state, index}`. State must equal the inspected encrypted
store checkpoint. Only input/get/result broker methods are available; source
visitation, transaction writes and binary credentials are unavailable.

The account method validates the primitive index before scheduling, then uses the
existing exclusive TXID phase, restore and journal-checkpoint checks. Pending or
missing checkpoints refuse. Main validates exact result keys, field encodings,
requested index, current checkpoint root/index/transcript and false authority
flags; the runner receipt remains inside the account lifetime. Main does not load
Poseidon. Returned JSON is detached diagnostic data, not a reusable receipt.

Broker refusal in every TXID mode now immediately closes the runner, task and
session; a later valid message cannot rescue it. Borrowed storage and source-feed
replies must pass fresh lifetime checks before returning. The runner observes
child exit and drains admitted broker callbacks even if work ignores cancellation.
The existing failure outcome is unchanged: a refused/cancelled run closes the TXID
session and requires reopen. This shared lifecycle fix is included in the same
policy change as historical-prefix computation.

Closing does not undo an already completed atomic write. A staged transaction
before commit should leave the old store intact; a commit whose reply is lost may
already have replaced the store. Durable pending journal data must distinguish
these cases through authenticated reopen and safe replay. Neither a rejected
reply nor process failure means that a write did not happen.

Opening/restoring the account still performs the existing current-root service
checks. The prefix computation itself performs no service request. It would be
incorrect to describe an entire live account open as offline, or to interpret
those current-root checks as acceptance of the historical root. The native
qualification instead uses public captured data and rejecting transport stubs.

## Compatibility and future composition

Projection, job and runner source changes alter the TXID policy hash. Each new
policy gets a separate encrypted mirror/journal/key domain under the public
generation. Old files remain retained, subject to the existing eight-policy
inventory bound. Read-only checkpoint recovery refuses until a current-policy
mirror exists; it does not silently create, migrate or rebuild one. No funded
profile was rebuilt or queried in this slice. Its TXID-dependent operations will
refuse until a separately authorized current-policy mirror rebuild. That rebuild
is public-data synchronization, not permission for owned-note or proof-specific
queries. The funded profile's usage of the eight policy slots was not inspected.
Public generation and binary pins are unchanged.

A future retained-proof controller must read the saved record internally, acquire
fresh authenticated mirror evidence, compare the exact saved root/index, recheck
the stored revision and reattest the operation. The existing cold-validation
result is a completed diagnostic, not a mirror snapshot receipt. Its own-row and
creator source checks do not establish coverage of the whole mirror; that has a
separate coverage path. Original list-root acceptance, explicit disclosure,
durable one-use handoff and uncertain-response recovery remain separate work.

## Validation status

All 72 projection tests pass. Every prefix of a 257-row checkpoint matches an
independent dense-tree oracle. Tests cover coherent append stability, discarded
right-sibling corruption, completed-left corruption, wrong row/lookup/root,
valid-path redirection to another index, caller mutation, read bounds, no writes
and pending borrowed reads. The real continuity policy accepts the 4,188-row
pre-omission boundary and refuses a later uninterrupted synthetic checkpoint.

The 8,000-row capacity test substitutes only continuity classification inside an
isolated module instance. It retains projection, append, witness and dense-oracle
calculations, using deterministic test hashes rather than Poseidon. Bounds at
8,000/8,001 and the unmodified real continuity refusal are separately checked.
This does not qualify an uninterrupted real service history beyond the known
omission. The first test run exposed that fixture mismatch; production continuity
policy was never relaxed.

All 273 focused tests pass across six suites in 1.281 seconds; lint is clean.
Job tests use the real projection/remote bridge with deterministic engine shims;
account/runner tests exercise strict result binding, phase lifetime, forbidden
methods, failed exit, ignored cancellation and permanent refusal.

Temporary in-memory controls leave repository files unchanged. The unmodified
runner passes all 78 runner tests. Removing only the immediate refusal latch
fails 21 rescue-race cases; removing dispatch drain exposes early settlement of
an abandoned commit; removing the post-storage source-signal check admits a late
reply. A separate temporary test resolves feed EOF, aborts the source before the
continuation, and passes only with the post-feed checks present. That temporary
case is outside the committed suite count. The ordinary pending-feed test alone
does not distinguish those checks because the feed already rejects on abort.

### Actual utility and encrypted-storage evidence

The [historical-prefix report](qualification/railgun-txid-historical-prefix-2026-10-04.json)
passes in 55,024 ms with 46 matching source hashes. It builds a fresh encrypted
mirror from 4,230 pinned public captured rows, saving 21 append checkpoint roots
before historical computation; the saved pre-omission root also matches the
pinned known-break root. After worker reopen, the new utility reproduces
all 21 roots, including power-of-two boundaries and both sides of the known
service omission at index 4,188. These references use the existing append
frontier; the unit dense-tree oracle is a separate algorithm with test hashes.
Neither is an independent cryptographic implementation or chain-verification
service.

Five in-transit substitutions (current checkpoint, level-zero right/left siblings,
row leaf and another authentic row/path at the wrong index) each produce no
result and a failed utility exit. Each is followed by a healthy reopen/retry;
encrypted file bytes remain unchanged throughout these read-only attempts.
The prefix fixture observes 167 actual exits: 18 inspect, 59 project, 59 apply
and 31 historical jobs. Its 162 successful utility reports contain 14,742 canary
checks and zero prohibited attempts. The five failed jobs produce no guard
report; zero sampled RSS is explicitly recorded as no positive sample before
exit. Healthy historical jobs take 187–217 ms in this run, not a performance
promise. The fixture records zero RPC attempts, live queries, enrolled accounts
and submissions. It qualifies the worker/runner computation, not the enrolled
account wrapper, a host journal or OS-wide egress isolation.

The [journal recovery report](qualification/railgun-txid-historical-journal-2026-10-04.json)
passes with 23 matching hashes and actual encrypted worker/journal reopen. In
addition to the existing after-prepare and after-apply interruptions, it injects
forbidden broker traffic after a real storage operation completes but before its
reply reaches the child:

- After staging and before commit, the runner aborts immediately, returns no
  result, and the child exits revoked. Reopen retains the pending journal and old
  checkpoint; the full store snapshot is unchanged. Recovery applies once.
- After commit and before acknowledgement, the same refusal occurs, but reopen
  finds the complete expected new store. The pending journal and old checkpoint
  still identify the interrupted operation. Replay leaves the full authenticated
  store snapshot unchanged, then completes the checkpoint without duplication.

These cases use fixture keys and controlled root receipts. They do not qualify
live root acceptance or enrollment. The injected forbidden message is a fixture
mechanism for testing immediate refusal at those exact storage boundaries; no
claim is made that a normal engine sends that message.

The [coverage rerun](qualification/railgun-txid-historical-coverage-2026-10-04.json)
passes with 79 matching hashes under the changed shared runner. It compares
4,214 rows / 4,103 Ethereum transactions within the captured boundary, preserving
the known omission and 16 rows beyond that boundary. Cold restore, unchanged
store, stale/forged receipt refusal, changed transcript and late source failure
remain covered. The measured successful coverage operation takes 6,430.44225 ms;
that is not the whole fixture duration. This is consistency with separately
captured unverified RPC events, not global completeness or enrolled coverage.

The frozen full regression passes 10,959 tests / 33 skipped across 471 passing
suites in 380.629 seconds, with native access and the existing OpenLV exclusion.
All 46/23/79 source hashes still match their respective reports after the run.
Earlier milestone reports retain their historical source/policy hashes. Claude
and Codex reviewed implementation, tests, fixture, evidence and claims; this is
engineering review rather than an independent security audit.

The journal/coverage report hashes and chain facts are public captured data;
store identifiers belong to disposable fixture storage, not the funded account.
