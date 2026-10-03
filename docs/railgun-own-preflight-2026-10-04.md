# Railgun own-transaction preflight — October 4, 2026

`preflightRailgunOwnTransaction` composes the retained own-operation capture,
fresh receipt/finality observations, existing TXID checkpoint witness, independent
keyless path verification, authenticated retained-source comparison and a final
public-service root check. A second recovery capture must agree with the first
on the exact durable operation and journal projection. This is read-only evidence
for later post-transaction work; it grants no ongoing authority or writer exclusion.

The ordinary `captureRailgunOwnWitness` API retains its narrower behavior. Both
exports fix their mode internally. Main owns the composition in the existing
wallet module; no renderer, IPC, dependency or top-level boundary changes occur.
An external callback cannot substitute evidence or extend either mode.

## Lifetime and evidence

Each account phase drains before the next. The TXID session closes completely
before a separate recovery-phase lease covers the independent verifier. That
lease remains held through cancellation until the verifier actually exits.
The source capture happens after verification, so its final refreshed snapshot
has its own freshness window. Source acquisition can use up to 180 seconds;
the coordinator's snapshot age is checked independently after acquisition.
A final root receipt and source receipt are reasserted after the final account
capture, then closed rather than returned to the caller.

The preflight defaults to a 300-second overall acceptance deadline, versus
180 seconds for plain witness capture. Each substep has its own smaller limit.
Cancellation revokes scopes and drains outstanding work; draining can outlast
the acceptance deadline. These budgets have not been qualified over live Tor.

The detached result records the exact chain anchors actually checked and the
final active/archive representation. If archival happens between phases, a new
archive anchor is explicitly marked unchecked unless the earlier chain read
covered that exact anchor. All overall authority flags stay false. Per-step
verification observations describe completed checks, not a continuing capability.
RPC finality/root replies remain external observations, not consensus proofs;
matching recaptures do not exclude intervening journal writers.

## Qualification

| Mode | Elapsed | Source hashes | Scenarios |
| --- | ---: | ---: | ---: |
| [Transfer](qualification/railgun-own-preflight-transfer-2026-10-04.json) | 14,209 ms | 146 matched | 10 passed |
| [Unshield](qualification/railgun-own-preflight-unshield-2026-10-04.json) | 15,777 ms | 146 matched | 10 passed |

Both actual Electron runs use disposable vaults, genuine enrollments and encrypted
stores, genuine resolution permits, the pinned engine, a selected synthetic
source history and simulated RPC/root services. Private transaction proof and
signature fields are structural fixtures. The unshield commitment and detached
TXID Merkle path are recomputed with the actual pinned engine. No live transport,
owned-note disclosure, proof submission or spending occurs.

Ten scenarios cover missing/unresolved journals, active and archived success,
enrollment/mirror reopen, a wrong selector, an early root refusal, a final root
refusal after verifier/source completion, archive finality lag, and an unresolved
sibling. Each refusal preserves journal state; recoverable service/selector
refusals are followed by successful preflight. Reopen is in the same process.

A successful preflight makes three public latest/root validation pairs and no
page request. The complete run, including setup and negative controls, records
28 latest requests, 27 root validations and one setup page; RPC counts are
16 receipt, 12 transaction, 220 header, 25 head and two log requests. The late-root
control targets precisely validation number three. Archive lag preserves the
original resolution at 300 and archive at 310 while current finalized height is
300, refusing before TXID/source work with exact early RPC counts. Reports retain
counts, booleans and source hashes; private associations are omitted.

The five focused suites pass 98 tests, including phase exclusion during verifier
drain, mode isolation, timer defaults, slow verification/source acquisition and
source/root expiry. Lint is clean. Claude reviewed the production lifecycle and
source-freshness corrections; Codex approved tests, final refusal controls and
both native reports. The frozen full regression passes 9,514 tests / 33 skipped across 445 passing
suites in 301.058 seconds with native-process access and the existing OpenLV
exclusion.

## Next

Build and qualify offline post-transaction POI witness/proof preparation for the
bounded self-transfer/full-unshield case. Ordered input membership, input-creator
authentication, fresh disclosure gates and actual node acceptance remain separate
work. The funded owned-note query still awaits disclosure authorization; this
preflight does not authorize it or complete a live private transfer/unshield.
