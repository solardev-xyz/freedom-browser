# Railgun POI proof-host cleanup — October 4, 2026

The existing main-only proof controller now permanently refuses a broker job
on its first invalid request or result. It immediately stops admission, aborts
the job, requests child closure and wipes any copied credential. Catching that
rejection cannot rescue the same job with another message. The returned broker
error has only code `RAILGUN_OWN_POI_PROOF_REFUSED` and message
`Railgun own POI proof unavailable`; assertion values and original error causes
are not forwarded.

Child close is requested once per returned handle and cannot throw past cleanup.
If refusal happens synchronously during startup, the late returned handle is
still closed. Every path awaits the child barrier and then all borrowed dispatch
work before the final key wipe. A rejected barrier still permits borrowed-work
cleanup but is not evidence of physical exit; genuine process supervision
supplies observed exit. A never-settling barrier cannot be bypassed with a timer.

Success is decided after cleanup. The host rechecks failure state, job deadline,
account lifetime and recovery margin after the last drain. A result prepared
before a late refusal, cancellation or cleanup overrun cannot become a registered
proof. Valid key admission still consumes the membership receipt before awaiting;
cleanup overrun after admission needs fresh membership, even if the worker had
already produced a proof. Pre-admission failures preserve the existing reuse rule.

The exact existing `engine / poi-prove / railgun-own-poi-prove-job` binary-key
allowance additionally requires `private-account`. Genuine enrollment already
provides that kind. Other process allowances, schemas, normalizers, one-use
semantics, registry/history shape and 175/120/110-second controller/recovery/job
budgets remain unchanged. The fresh keyless verifier still follows recovery.
Transact proof admission is not enabled by this prerequisite.

This is defense inside the existing main-process wallet controller. Real process
supervision already rejects failed broker jobs; mock-broker guard-removal controls
do not demonstrate a live supervisor bypass. No renderer/IPC or dependency change
is involved.

## Qualification

All 199 focused proof-host/process tests pass across two suites in 0.395 seconds;
full lint is clean. Seven targeted baseline controls pass. Removing permanent
refusal causes two failures at immediate signal revocation; omitting borrowed
work drain causes three premature settlements; omitting final inner checks causes
two forbidden recovery post-attestations. The outer recovery checks can still
refuse under the last mutation: this detects the required inner boundary, not a
successful globally published proof. Temporary in-memory transforms leave source
files unchanged.

Proof-host tests retain real payload binding, capture comparison and proof-result
registration, with mocked membership, normalizer, recovery, identity, credentials,
phase, process and keyless verification. Process tests use genuine privacy contexts
with mocked Electron children. Tests cover exact bounded errors, startup/abort/
timer/normal-close exceptions, late messages, held derivation and reattestation,
rejected child barriers, post-cleanup currency and otherwise-exact non-private
contexts. They do not establish native proof correctness or physical exit.

Native Shield [transfer](qualification/railgun-proof-host-transfer-2026-10-04.json)
and [unshield](qualification/railgun-proof-host-unshield-2026-10-04.json) pass in
107,902 / 106,525 ms. Each retains 19 membership, seven recovery and 13 proof
scenarios with 211 matching source hashes: 11 viewing jobs, seven credential
replies, and two fresh keyless verifiers. Child exits match starts, mutable keys
are wiped, genuine signed list/path membership and local proving remain functional,
and a changed on-curve proof is rejected by independent verification. Maximum
result wires are 3,843 / 3,837 bytes; sampled RSS peaks are 481,280,000 /
440,434,688 bytes, below the configured 768 MiB bound.

The final deadline case withholds readiness after the real worker finishes. The
hardened host's earlier abort listener closes the child directly before the
supervisor's broker-revocation listener runs, so its exit cause is now
`RAILGUN_PROCESS_CLOSED`. Transfer exits in 24,995 ms against a 24,965 ms budget;
unshield in 24,985 ms against 24,972 ms. The strict scheduling bounds remain.
The initial two runs were excluded solely because the fixture still expected
`RAILGUN_SESSION_REVOKED`; they produced no reports. Production was unchanged
for the corrected reruns.

These fixtures use genuine encrypted disposable stores and actual engine/prover
workers. Chain/root services and transport are simulated, required-list signatures
use the explicit disposable-key trust seam, and saved spend proof/signature is
structural. The actual required-list key rejects fixture signatures. Proof calls
add no service traffic; they do not establish live eligibility or acceptance.
Native compatibility does not independently demonstrate every adversarial mock
close/dispatch ordering above.

The preceding membership commit passed 12,953 regression tests. This prerequisite
uses focused and native verification; the next full regression follows Transact
proof composition. Public/TXID/wallet policy inputs and runtime/artifact pins
remain unchanged. No live owned-note query, funded account, submission or intent
transition is used.

Next, the shared proof normalizer and genuine membership bindings can be widened
for Transact inputs. Local preparation will remain guarded until the immediately
following output/intent slice can validate without disclosing before an inevitable
refusal. That later guard is not part of this cleanup-only change.


## Frozen hashes

- Proof host: `2322494507633c88a824233818e7c66148f8ae1362a58dd041d25dc626c38d37`
- Process host: `35acaaa2b8a2488062b1aca23054c6725a1ff1010aedcb4d9c995f90e78a1412`
- Proof tests: `1a315a66bfcc81fd379f4d5543d7bb94e6f2725aecd6df3d4629370799657a4b`
- Process tests: `cb0dc0deb27695c15bbbf8b855e8293e8994835f04c1214d17c4ea44434c8ec8`
