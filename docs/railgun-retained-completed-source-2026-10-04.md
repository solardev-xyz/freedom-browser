# Railgun retained history with completed-only source reads — October 4, 2026

This slice connects the completed-only reader to the existing retained-history
validator. Independent tests, native transfer/unshield, legacy compatibility and
full regression pass. It introduces no sender, review adapter or disclosure
permission.

## Fixed composition

`validateRailgunRetainedPoiHistory` captures the genuine enrollment-bound source
destination alongside its public identity and policy, then reasserts that exact
observation through stage currency checks and before final success. Reopening a
coordinator or replacing its client does not select a new destination under the
same invocation.

The path is retained history → completed output recovery → completed POI
preflight → completed combined creator/own-source capture. Three fixed internal
exports share their modules' existing private implementations:

- `recoverRailgunPoiOutputCompleted`
- `preflightRailgunOwnPoiCompleted`
- `captureRailgunPoiSourceCompleted`

There is no caller-supplied callback, transport, source-mode switch or previously
computed validation result. The existing exports retain ordinary snapshot
behavior. Stage A, standalone output recovery, membership and checks continue to
use those defaults. Main-process ownership and package boundaries are unchanged.

The completed capture uses the same collector and opaque source-receipt
assertion mechanism. Semantic mismatches return data inside the snapshot
callback, so they do not falsely mark the coordinator as corrupt. A receipt is
issued only after the coordinator finishes, authenticates its final snapshot and
passes the capture's currentness and binding checks.

## Failure provenance and lifetime

Completed capture returns either a captured receipt or a frozen refusal with a
bounded stage. When the coordinator actually rejects, capture first reads
`getRailgunCompletedSnapshotOutcome` with that exact rejection and coordinator.
Only a genuine outcome is included as optional `sourceOutcome`; local failures
never fabricate one. The fixed preflight, output and history paths preserve it
before a post-await currency check can erase a late fatal failure behind local
cancellation. This is diagnostic data; no later API accepts it as an authority
receipt or permission.
After propagation through those result objects it cannot be re-authenticated;
the authoritative lookup is the coordinator's exact-error registry at capture
time. The result only explains this invocation's refusal.

The enclosing 540-second history deadline and output/verifier/selector/mirror/
final reserves remain nonrenewing. Source timeout is the remaining enclosing
stage allowance, capped at 180 seconds. The completed reader retains admitted
planner, ledger, callback and RPC work until drain. No recovery/TXID phase spans
the completed-source callback. Benign source refusal preserves a healthy shared
coordinator; fatal source failure retains the existing owner closure behavior.
Always-cold planning adds work where a warm refresh previously sufficed. A large
retained prefix can exhaust the existing preflight allowance and refuse as
expired. The small synthetic fixture is not a throughput or latency guarantee;
larger captured-history measurement remains useful before sender integration.

The receipt wrapper is unchanged. It already prepares and consumes one genuine
client under a single maximum 60-second deadline and drains it. This validator
does not retain the receipt destination across a review callback. That handoff
belongs to the later fixed sender, which must prepare before review and observe
the same reader afterward without renewing its lifetime.

## Traffic and disclosure limits

Every completed source validation takes the cold path: `4C + E` headers, one
fixed-proxy logs request and at most one source chain-ID check, with `C <= 5` and
`E <= 512`. There is no warm-source reduction and no implicit pending replay,
source staging, retention or apply.

The existing full history composition additionally observes one transaction,
one receipt, two heads, 11 receipt headers (12 if archived), at most one receipt
chain-ID check, and six latest/current-TXID-root pairs. Its conservative maximum
is therefore 551 RPC requests plus 12 current-TXID service requests. These are
logical request bounds, not timing, Tor-circuit or packet-count guarantees.
Original proof-root queries, owned-note queries, indexer pages and submissions
are outside this validation path.

A missing/pending source checkpoint or provider/prefix refusal may occur after
earlier receipt and current-TXID traffic. There is no claim that an entire refused
validation sends zero requests. An advisory local eligibility check before first
review remains a possible sender improvement; the authoritative source operation
must still perform its own checks under exclusion.

## Qualification

Independent tests pass: 568 tests across four suites in 54.1 seconds, including
fixed/legacy route separation, exact destination and generation revocation,
remaining stage budgets, benign semantic refusal, copied-error rejection,
late authenticated fatal outcomes after cancellation, and borrowed-work drain.
Full lint passes. The initial independent run's stale fixture resolver caused
one timeout; resetting it between cases fixed the fixture without a production
change. Only the complete passing rerun is counted.

Three temporary Jest transforms leave repository files unchanged and produce
ten direct failures against ten baseline passes: ordinary output routing (two),
checking cancellation before preserving the fatal outcome (one), and omitting
repeated exact destination checks (seven). The latter tests replacement at
output, verification, selector, mirror opening, historical read, mirror drain and
final reattestation. These unit controls mock downstream authority and do not
prove native identity or socket drain.

Native Electron reports:

| Kind | Elapsed | Base scenarios | Source hashes | Report |
| --- | ---: | ---: | ---: | --- |
| Transfer | 136,464 ms | 17 | 207 | [Report](qualification/railgun-retained-completed-transfer-2026-10-04.json) |
| Unshield | 134,446 ms | 17 | 207 | [Report](qualification/railgun-retained-completed-unshield-2026-10-04.json) |

Each also preserves seven recovery and thirteen proof exercises and runs two
retained-history cases: a different valid historical root refuses, then healthy
validation succeeds. The qualifier now uses genuine private-RPC clients,
destination observations and budgets, with registry, Tor endpoint and transport
simulated. All responses are local fixtures. Both complete fixtures construct
35 RPC clients and observe 35 actual lazy chain-ID requests. This is not live
endpoint, Tor routing or operating-system egress qualification. Fixture service
signature substitution and structural spend-proof/signature limits remain
explicit in the reports.

Each history invocation, including the healthy second invocation, executes one
cold public planner and 34 header requests (22 cold-source headers, `4*5+2`,
plus 12 archived-receipt headers), one logs request, one transaction, one receipt,
two heads and six
current-TXID latest/root pairs. The first invocation needs two chain-ID requests;
the second needs one because the retained source client already checked its
chain. Ledger stage/retain calls are counted through a delegating fixture facade;
source/coordinator wrappers retain the genuine instances. Ordinary setup exercises
all four counters before per-history zero deltas are checked: 60 staging calls,
one retention call, 60 before-acquire hooks and 60 apply calls. Both show zero
source staging, retention, before-acquire hooks and apply calls; journal snapshots and the prepared intent remain unchanged. No additional
POI prover, owned-note query, original proof-root query, spending key or submission
is admitted during these validation exercises.

The initial native smoke reached its final inventory check while included tests
were changing and correctly refused. A preliminary retained run exposed the
qualifier's old first-cold-reopen-only planner guard; the guard now permits exactly
one planner per retained-history invocation, preserving the legacy restriction.
Those runs are excluded. The frozen reports above include the complete passing
executions and exact source inventories.

[Legacy Stage A transfer](qualification/railgun-retained-legacy-stage-a-2026-10-04.json)
passes in 130,792 ms with 207 hashes. Invalid SNARK input refuses before history,
then healthy validation succeeds. Its source remains cold only on the first
reopen: 34 then 22 total headers, one then zero logs requests. This distinguishes
legacy behavior from the always-cold retained-history path.
[Legacy unshield checks](qualification/railgun-retained-legacy-checks-2026-10-04.json)
passes in 122,273 ms with 207 hashes and eight checks exercises. Both retain the
17 base scenarios and positive setup counters. These final reports supersede
passing `-b` runs before the positive-counter assertions were added.

The combined tree, including main `6b5c2ea7`, passes full regression: 12,154 tests,
33 skipped, 486 passing suites plus five skipped, in 438.696 seconds. Command:
`npm run test:coverage -- --runInBand --forceExit --testPathIgnorePatterns=openlv-protocol.test.js --reporters=default`.
Native access and the existing OpenLV exclusion were retained. The final qualifier
counter assertion changed during this test run; production and unit tests stayed
frozen, and the four final native runs plus clean lint cover that fixture change.
Claude reviewed implementation, native interception/counters and evidence; Codex
provided production work and independent tests/controls. Independent engineering
review is not a security audit. No live service or funded-profile operation occurred.

## Policy and integration limits

All 24 unique public/TXID policy inputs were rehashed. The public policy remains
`d454092c2a951aca09b6f8b6d84196a947c3ae77a003f86e6aed9dd7d0f1b477`;
TXID remains
`03a45fd173ed2c639b314abde9547f469ac25ef255a12e4e974a935bef1c73c7`.
The four production modules are outside those inventories. Prior whole-source
qualification reports are historical when included code, tests or fixture files
change. Existing funded state has not been rebuilt for earlier policy changes.

Main `6b5c2ea7` and the explicit Ant 0.5.57/IPFS/Myotis/Radicle refresh are already
incorporated; matching Arti was retained. No dependency, IPC, UI or package
boundary changes are part of this slice. The next composition must bind the
prepared receipt reader before initial review, retain the same source destination,
execute validation under its private claimed plan, then separately review original
roots and a single durable POI submission. Current results and diagnostic outcomes
grant no consent or submission authority.
