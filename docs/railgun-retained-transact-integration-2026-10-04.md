# Retained Railgun operations with received inputs — October 4, 2026

This checkpoint connects received Transact input provenance to the same
prepared-output, proof-history, cold-validation and attempted-output paths used
for Shield inputs. Four Transact and six Shield native runs qualify the bounded
controlled composition below; they do not establish live service acceptance.

The intended supported shape remains one current-format pinned-WETH input and
one self-transfer output or full EOA unshield. Source and creator classification
are reconstructed during each invocation, including after account restart.
Persisted intent records remain type-agnostic. The encrypted intent store now
admits genuine proof history whose creator is exactly Shield or Transact; missing creator
history and unsupported types refuse before recovery or writes. This admission
change must ship together with the downstream consumers and their qualification.

## One authenticated source and checkpoint

Fixed internal retained preflights reuse the existing source collectors and own
witness core. They accept an exact genuine source destination, not a caller input
type. One completed snapshot supplies the selected creator and own transaction.
A selected Transact creator requires the complete bounded Nullified/Transact
transaction group, one nullifier/commitment, no creating unshield and the existing
4 KiB event bound. Shield keeps its existing preimage path; otherwise valid Shield
groups may exceed the Transact bookkeeping size without becoming unsupported.

After full source authentication, one checkpoint-only TXID session supplies the
own witness and, for Transact only, the creating-note witness. Both must match the
same detached checkpoint, and the creator must precede the own transaction. Own
and creating path verification use separate keyless worker phases with observed
exit. A late root check and strict recapture precede cleanup and final owner,
public-generation, destination and deadline checks. There is no new authority
registry, second creator receipt query, page replay or viewing credential here.

Existing legacy and membership preflight exports keep their prior routing. New
completed and submission exports share this fixed retained path; the submission
export consumes only the existing private handoff downstream of the genuine
prepared reader. Missing or malformed handoff cannot fall back to another receipt
query. Output's existing owner and the attempted route's shared sender exclusion
remain in place through drain.

## Deliberate completed-source behavior

Ordinary output recovery, proof-history checks and indirectly cold Stage A now
use completed-only, source-first reads. They refuse a missing or pending checkpoint
instead of implicitly replaying or advancing history. A later invocation can
succeed after separate maintenance completes. One keyless own-selector job and receipt/transaction RPC may already have run
when a pending checkpoint is discovered. No mirror, path verifier, creator,
viewing or proving work is reached by that refusal.

Every completed read validates the source again, including a warm ordinary
invocation. Earlier qualification showing 34 headers on first reopen and 22 on a
subsequent Stage A call is historical evidence for the preceding implementation.
Current counts and timings are in the native reports below. Earlier
selector-mode and proof-only reports also remain historical: the current proof-only
fixture requires genuine Transact preparation to succeed after the store guard
widening. It no longer expects the preceding guard refusal.

The existing 180-second preflight ceiling now includes a 55-second source tail
reserve for Shield as well as Transact. Earlier capture and receipt work reduces
actual source acquisition time further. Shield retains conservative reserve for
an omitted creator verifier. The actual coordinator canonical age, not time since
source return, remains authoritative. These admission bounds can refuse slow Tor
paths; local fixture speed does not establish live practicality. Output retains
its 240-second total and at most 60 seconds after preflight; that later window
checks local account/output binding, not continuing source or root acceptance.

## Consumer binding and recovery

Output and proof-history checks bind classification, exact capsule and selector,
public identity, source origin/checkpoint and Transact creator witness to their
fresh internally called preflight. Creating output index is zero, the creating
row is one-by-one without unshield, the creator precedes own, and verified coverage
is exactly one row with no known omission. Shield must have no creating
provenance member. No external diagnostic or saved provenance can replace this
fresh computation. The checks scope predicate returns false on parent-context or
destination failure, allowing normal scope revocation.

Transfer output recovery uses the existing viewing worker once to reconstruct
and compare the output; the saved blinded output is not sent into that worker.
The shared strict input normalizer supports Transact before key admission.
Unshield remains keyless, binding the own transaction marker and empty outputs.
Cold Stage A separately verifies the saved SNARK; retained-history validation
separately checks its saved TXID root against the authenticated local prefix.
Original list/root acceptance remains a distinct check where already required.

An attempted record retains its original request, time, canonical bytes, digests,
revision and remaining transition reserves. Fresh output agreement after restart
neither resolves that attempt nor permits another POST. Existing acceptance,
eligibility, outcome-known and retry flags remain false. A new Transact record
cannot overwrite or reset an already attempted capsule, including when input
classification changes in a mocked history. The existing nullifier uniqueness
rule also spans Shield and Transact.

## Reviewed disclosure inventory

Because the record has no creator discriminator before review, validation now
reviews the maximum across both supported types: seven current-TXID latest/root
validation pairs. Shield actually uses six; Transact uses seven. Direct retained
preflight uses three for Shield and four for Transact, then historical-prefix
validation adds three. Original-root checks and the final single POST keep their
separate inventories. No owned-note membership query is added to output recovery.

Under the existing conservative cold-source bounds, validation permits up to 551
chain RPC plus 14 current-TXID requests for Transact (565 logical calls), versus
12 for Shield (563). These are upper envelopes, not minimum costs or packet/Tor
circuit counts. The displayed inventory is not itself transport enforcement;
actual role, destination and method checks require independent qualification.

## Independent tests

The four source/preflight suites and compatibility coverage pass 601 tests across
seven suites in 31.978 seconds. Seven targeted baseline controls pass; omitting
retained grouping, conditional creator selection, checkpoint detachment or final
destination binding causes the intended failures. Forcing the wrong creator path
can make a valid invocation refuse rather than demonstrate an authority bypass.
Tests retain real collector/receipt/context boundaries with mocked expensive
coordinator/crypto stages as documented in their fixture setup.

Encrypted intent-store coverage passes 243 tests in 8.422 seconds. Real encrypted
stores exercise mixed Shield/Transact preparation, exact sequence/reserve/floor
accounting, unchanged earlier entries, idempotent no-write repetition, cold
reopen, nullifier conflicts and permanent attempted-state protection. Their proof
registry is explicitly mocked; the native runs below supply a genuine proof
through the actual store to the connected consumers.

Consumer compatibility passes 1,061 tests across seven suites in 92.856 seconds;
lint is clean. Ten baseline controls pass in 1.429 seconds. Removing checkpoint,
coverage, pinned destination, stale-scope refusal or the seven-pair inventory
produces respectively two, four, two, one and one expected failures. The exact
root-admission assertions avoid an early Jest Map-difference formatting error;
final controls reach and detect the intended boundary. Data/worker tests use real
structural normalization with mocked expensive crypto. Host tests use genuine
privacy contexts but mocked preflight, account and worker boundaries. The
native runs observe seven pairs for Transact and six for Shield in full validation.

Full regression passes 13,312 tests across 496 suites in 501.085 seconds, with
33 tests and five suites skipped. The existing OpenLV exclusion and explicit
force-exit remain. The regression ran with native permissions and exited 0, and all nine
production and eleven test file hashes matched their pre-run inventory. These
implementation and test files remain unchanged; the two standalone Electron
qualification scripts were finalized afterward and have their own native source
inventories. The full regression is not evidence that those scripts ran.

The ten native source inventories match the final implementation and both
qualifiers. All 24 public/TXID and 30 wallet policy input entries
remain unchanged; no dependency, runtime/artifact pin, renderer or IPC change is
involved. No production readiness or live acceptance is claimed by the current
checkpoint.

## Native composition

All four corrected Transact combinations pass: transfer/self and transfer/foreign
each exercise 19 connected cases; unshield/self and unshield/foreign each exercise
17. Every run retains eleven historical-preflight cases, eleven membership cases
and one actual local POI proof. Each 222-file inventory matches the current tree.
The four runs take 123,735 / 123,288 / 113,240 / 112,770 ms respectively.

The connected sequence prepares a real encrypted record from the genuine proof,
checks original roots, reopens enrollment, reconstructs output, rejects a changed
SNARK in a fresh verifier, rejects a changed historical root, validates retained
history, handles denied review callbacks and makes one simulated POI POST. The
sender's genuine prepared reader supplies the private downstream handoff; one
transaction and one receipt query cover that composition. While the POST's close
barrier is withheld, attempted-output recovery refuses busy without work. After
release and another reopen, prepared-only routes refuse the attempted record;
the attempted route can compare output without resolving or retrying the request.

The fixture explicitly initializes genuine reservation/capsule stores during
reopen, before the operation's byte baseline. Reopening rotates storage leases
and refreshes manifest floors at unchanged logical sequence. It compares logical
private-store state across that boundary and performs no account recovery,
source snapshot, mirror read, Railgun utility or chain/service warmup. The public
source and mirror remain cold. Measured reads and refusals preserve exact intent,
manifest and private-store bytes. Successful sending has separate intent-transition
checks; it is not included in a blanket byte-unchanged claim.

Transact direct retained preflight uses four latest/root pairs; history and sender
validation use seven. Each connected preflight has exactly one source planner,
one own selector, one own verifier, one creator verifier, three mirror inspections,
one own witness and one creating-note witness. Transfer output adds one viewing
job; unshield adds none. History adds its separate keyless proof verifier and
historical-prefix work. No additional POI prover, owned-note query or spending
credential is admitted. Timed wrappers observe the original calls without
replacing source results or renewing their canonical time.

The corrected Shield output/transfer and output/unshield runs pass in 128,260 and
123,645 ms, each with 212 matching hashes. All six Shield runs include eight checks cases
and five pending-checkpoint phases. Transfer exercises two output cases;
unshield has one keyless case.
Cold validation also passes for transfer/unshield in 127,410 / 122,765 ms: each
rejects a corrupted SNARK, then validates the healthy payload. Submission also
passes for transfer/unshield in 145,413 / 140,811 ms. Its historical validation
uses six current-TXID pairs against the seven-pair review maximum; one prepared
reader supplies the original transaction and receipt once. Both preserve the
single simulated POST, held-close exclusion and cold attempted-output checks.
The short-budget case observes one selector and the archived receipt RPC, then refuses
`preflight:source` before source or root admission. Actual caller cancellation
still holds both original-root transports and account ownership through their
separate drains. Held-root deadline expiry is now unit-test coverage, not a
claim of this native fixture.

The pending scenario interrupts actual scan application after the encrypted
journal has prepared one empty block. The coordinator revokes; the account is
closed and reopened with the same generation. Completed-source preflight then
refuses with benign `checkpoint-unavailable`, leaving the authenticated pending
journal unchanged. Only the own selector and archived receipt RPC run; no source
maintenance, public root, mirror, viewing or proving work occurs. Explicit
`coordinator.recover()` replays the real pending plan, and the next retained read
succeeds with no maintenance, three public root pairs and six keyless utilities.
All counted utility exits are observed. This is an injected prepare/apply
interruption with genuine storage, not an operating-system process kill.
Explicit-recovery method/job counts are recorded; its exact apply count and
positive maintenance are asserted, not every recorded recovery-phase RPC total.

Shield timing reports include ordinary successes, a short-budget entry with zero
source calls, and two pending-scenario entries. The latter entries must be kept
separate from normal source/tail summaries. `sourceSnapshotBudgetMs` is a fixture
calculation from the observed scope budget minus 55 seconds, rather than a value
read from production. None of these timings substitutes for production's actual
canonical source age.

Both fixtures intercept chain/service transports and use disposable service
signature trust. POI proving, receiver reconstruction and keyless verification
use actual pinned cryptography; saved spending proofs/signatures are structural.
The trusted-main review callback is synthetic. No human consent, current live
eligibility, real POI acceptance, mined spend, safe retry or production readiness
is established. Host interception is not operating-system egress tracing.

## Frozen evidence

All reports below are byte-identical copies of the passing native reports. All
ten processes exited successfully and were drained. Both qualifiers are included
in every native source inventory:

- `scripts/qualify-railgun-own-transact-creator.js`: `a2f2d3e729dbff4184f81ba915e8d773e4279f579554ebd604c54317da0e813e`
- `scripts/qualify-railgun-own-poi-membership.js`: `356c558ed7adb9ce33a8cadbd61bb1c1c130f6ff809858f49a53734bacf1934a`

The separate [full-regression manifest](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-transact-regression-2026-10-04.json)
records the exact nine production and eleven test hashes, command, exclusions and
results. Those files remain unchanged after regression; subsequent standalone
qualifier edits were covered by lint and the native runs. Force-exit does not
establish natural application-handle shutdown.

| Native run | Elapsed ms | Source hashes |
| --- | ---: | ---: |
| [transact-transfer-self](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-transact-transfer-self-2026-10-04.json) | 123735 | 222 |
| [transact-transfer-foreign](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-transact-transfer-foreign-2026-10-04.json) | 123288 | 222 |
| [transact-unshield-self](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-transact-unshield-self-2026-10-04.json) | 113240 | 222 |
| [transact-unshield-foreign](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-transact-unshield-foreign-2026-10-04.json) | 112770 | 222 |
| [shield-output-transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-shield-output-transfer-2026-10-04.json) | 128260 | 212 |
| [shield-output-unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-shield-output-unshield-2026-10-04.json) | 123645 | 212 |
| [shield-cold-transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-shield-cold-transfer-2026-10-04.json) | 127410 | 212 |
| [shield-cold-unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-shield-cold-unshield-2026-10-04.json) | 122765 | 212 |
| [shield-submission-transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-shield-submission-transfer-2026-10-04.json) | 145413 | 212 |
| [shield-submission-unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-retained-shield-submission-unshield-2026-10-04.json) | 140811 | 212 |

## Initial native runs excluded

The first connected transfer/self run stopped after the deliberately substituted
output was refused and its work counters passed, at the fixture's durable-state
comparison after account reopen. Source inspection attributes the mismatch to lazy reservation/capsule store
lease/floor initialization after reopen; that run did not identify the changed
field. The corrected baseline passes with exact bytes in measured reads and
refusals. No successful report is claimed for the initial run.

The first Shield output/transfer run stopped in its old eight-second held-root
timeout case. The new source path reserves 55 seconds before source acquisition,
so this budget refuses before reaching the root transports. That former scenario
cannot qualify root-drain behavior under the new routing. Both processes exited
with failure and were drained; neither run is included as passing evidence.
