# Railgun retained POI output recovery — October 4, 2026

The main-owned output recovery controller compares an encrypted prepared POI
record with independently reconstructed output evidence after enrollment reopen.
It accepts a genuine enrollment, identity and public coordinator, pinned engine
archive and capsule digest. It opens the account's own store internally. There
is no caller-supplied payload, record, broker or key, renderer surface or IPC.

A retained self-transfer proof contains a blinded output that the capsule alone
cannot recompute: the calculation also needs the decrypted output note's public
key. A fresh viewing-only utility validates the current transaction witness,
reconstructs the note with the existing receiver checks, and computes the blinded
commitment from the matched commitment, decrypted note public key and output
position. The saved blinded output is never supplied to that utility. Main
compares the independently returned value with the exact retained payload.

Full unshield instead binds the payload's marker to the independently checked own
Railgun transaction ID and requires zero blinded outputs. It starts no output
recovery utility and releases no viewing credential.

## Account and credential boundaries

The controller holds one owner per account directory through all asynchronous
work. It authenticates the prepared record, performs fresh own-operation/source/
TXID preflight, and compares the capsule digest, operation binding and selector
with the stored record. Creator, receipt and matched row are checked for
consistency with the fresh capsule and own evidence. Only the existing nonlegacy Shield-input,
one-input self-transfer or full-unshield shapes are supported. The retained TXID
checkpoint index must be between the own leaf index and the fresh checkpoint.
The fixed list key, single list root and original payload remain unchanged.

Inside the exclusive account recovery window, the controller reattests before
starting the utility and before and inside credential derivation. Exact store
reads occur before preflight, after preflight, inside recovery before the job,
after the child exits and after recovery. No store read occurs inside the
credential callback. Preparation needs the same recovery phase, so a competing
writer cannot replace the record there.

Transfer admits one exact key request bound to the canonical input digest. The
request slot is reserved before any await; immediately before the 32-byte copy,
synchronous checks reassert identity, coordinator, account window and deadlines.
This slice adds exactly one binary-key allowlist pair: engine/poi-output-recover
and the reviewed job filename, with no wildcard. Each diagnostic invocation has its own one-key limit;
this is not a persistent single-use restriction on the prepared record.

The configured admission ceilings are 240 seconds overall, 180 for preflight, 60 after
preflight, 45 for recovery and 30 for the utility. All remain bounded by the
original deadline. Key admission needs more than five seconds before the job's
early deadline; another five seconds are reserved within recovery for cleanup.
Earlier preflight observations have the broader total-run age, not a 60-second
freshness guarantee. Cleanup may outlast an admission deadline while ignored
callbacks and child exit drain.

The controller validates exact result shape, digests, pinned engine hash, guard
report and false authority flags, then closes the utility and observes exit.
Every borrowed broker callback drains before recovery and directory ownership
are released. Owned key buffers are wiped; private SDK objects end with utility
process exit. A hung callback can keep cleanup pending indefinitely. Cancellation
refuses without deliberately closing healthy account stores.
Any refused utility message permanently aborts that job's signal immediately;
later messages and pending derivation/copy/result admission refuse, and the
supervisor stops the child.

## What a match means

The result is a bounded diagnostic: the exact stored payload's output agrees with
fresh own-operation evidence. It creates no live proof-registry entry or reusable
authorization receipt. Final account/store comparisons describe that completed
attempt, not a continuing lock on journal writers.

It does not independently verify the saved POI SNARK, accept the original proof
roots, reconstruct the original proving input, establish current list membership,
submit a proof or authorize spending/disclosure. The original list witness is
not retained, so its historical proving-input digest cannot be recomputed here.
List key and checkpoint index are not SNARK public signals. Fresh mirror evidence
must not silently replace original roots or index.

The utility performs no proof generation, artifact acquisition, storage or
network operation. Reconstruction loads SDK wallet modules transitively and
supplies rejecting storage/prover adapters. The host's
preflight still performs the existing public/source/TXID operations; absence of a
utility network path does not mean the entire controller has no network activity.
Cold public-checkpoint recovery can write local catalog/source-ledger data.
Read-only broker restrictions do not imply the entire host path is read-only;
the prepared record and submission journal are compared separately.
No production caller or funded-account operation is added. Live proof-root and
owned/output-note queries remain behind the pending disclosure authorization.

## Qualification

All 495 focused tests pass across six suites in 16.24 seconds; lint is clean.
Seven protocol-race controls fail with only the immediate abort removed through
an isolated in-memory override, and pass on the current code. Production sources
were not modified by that control. A frozen-witness mutation in an initial test
setup was corrected before the passing focused run.

The native [transfer report](qualification/railgun-poi-output-transfer-2026-10-04.json)
passes in 119,052 ms with 197 matching source hashes. After genuine enrollment and
store reopen, the fixture first verifies the real utility's correct output, then
substitutes a different valid field element before host dispatch. The host refuses
at `recovery:callback` after one key release, with zero admitted results, observed
revoked child exit, unchanged prepared record/journal and healthy recapture. A
following fresh attempt matches and demonstrates that ownership was released.

The refused and healthy viewing utilities take 327 and 291 ms, with sampled RSS
peaks of 140,263,424 and 160,006,144 bytes. Key-request-to-result times are 88 and
87 ms. These observations are local timings, not performance guarantees.
Both attempts independently validate the key/result digests, wiped reply buffers
and runtime guards. Together their 13 utility reports record 1,183 canary checks
with zero prohibited attempts.

Each preflight starts a selector, own-TXID verifier, two mirror inspections and
one mirror witness job. The cold first attempt also reconstructs the public
checkpoint with one plan job. Its broker receives only the expected history batch,
EOF and result; the mirror broker admits exactly 11 input/get/result messages per
attempt and no mutation operations. The first attempt makes 34 block-header and
one log query; the warm attempt makes 22 header queries and no log query. Both
make the same three public latest/validate pairs and existing own-transaction
queries. These are explicitly simulated services.

The integrated run preserves six storage, eight checks, 13 proof, seven recovery
and 17 membership scenarios. Enrollment reopen precedes the final journal-drift
membership scenario in this mode; the older `intents` mode keeps its prior order.
No additional POI prover/verifier, owned-note lookup or spending-key derivation
occurs during output recovery. There is no instrumented artifact-import counter.
The native [unshield report](qualification/railgun-poi-output-unshield-2026-10-04.json)
passes in 115,219 ms with the same 197 source hashes and previous scenario counts.
Its single cold recovery matches with zero viewing jobs, keys or output-job
results. Six keyless utilities exit; their reports contain 546 canary checks and
zero prohibited attempts. Mirror/public-plan and service counts match the cold
transfer preflight. The frozen full regression passes 10,662 tests / 33 skipped across 469 passing
suites in 338.357 seconds, with native process access and the existing OpenLV
exclusion. Both reports still match all 197 source hashes after the run. Claude
and Codex reviewed implementation, tests, instrumentation, evidence and claims;
this is engineering review, not an independent security audit.
The native fixture uses a disposable public test mnemonic and synthetic services;
it cannot establish live service acceptance, Tor operation or OS-wide egress
isolation. Enrollment close/reopen in one harness process is not a full browser
restart.

Earlier checks reports counted only the detached selector/TXID verifier jobs in
their 14-job/1,274-canary totals. They also used TXID mirror utilities. The new
output-recovery fixture explicitly counts mirror inspect/witness jobs and the
first cold public-plan reconstruction; earlier reports remain historical evidence.
