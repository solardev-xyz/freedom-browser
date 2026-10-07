# Submission after restart — October 5, 2026

The internal Railgun host can submit an authenticated saved proof after a clean
restart. It supports private transfer, full withdrawal and partial withdrawal,
while retaining the original private signature, proved calldata and input root.
Fresh eligibility and Ethereum signing authority are acquired for each attempted
submission. The Kohaku facade remains unchanged.

## Admission and lifetime

`submitRailgunRecoveredPrivateTransaction` first reads the original signed and
proved capsule under the existing recovery owner. It checks the original
submitter against public vault metadata and rejects unresolved or same-nullifier
journal attempts before disclosure. This initial check borrows no EOA key.
The journal's atomic same-nullifier guard remains the final backstop.

A disclosure callback must approve the exact source, protocol, transaction and
POI destinations and their exposures. Only then does the host open a completed
wallet, read the original owned input at its current completed checkpoint and
observe wallet closure. Received-Transact inputs additionally open the existing
checkpoint-only TXID mirror, read the selected note’s TXID witness at its checkpoint, then drain it.
That opener legitimately advances its constructor lease/generation/sequence;
it is not a zero-write read.

One final recovery phase re-reads the durable private records and acquires a
genuine completed-source snapshot at the wallet checkpoint. It verifies the
received creator where applicable, independently verifies the original proof,
checks fresh typed POI membership and fresh acceptance of that mirror
checkpoint’s TXID root, then runs the fixed
01x01 or 01x02 preflight with the original proof root and current minimum block.
The source token is checked again after snapshot publication. No diagnostic
object or caller-provided authority callback substitutes for those receipts.

The shared warm/cold submission core performs simulation and the existing
Ethereum transaction review, checks nonce and fees, signs through the original
vault signer, and re-reads durable private records after signing. It records the
attempt before raw sending. An authenticated lost reply returns the journal's
known hash with unknown status; it does not permit automatic resubmission.
Borrowed review/signing work and genuine child/worker closure barriers are
observed before exclusion is released.

Cold admission requires at least 50 seconds remaining on the original proof,
preflight, POI/list/membership, TXID-root and final-phase lifetimes immediately
before invoking transaction review. The 60-second receipts therefore leave
roughly ten seconds for intervening setup. This can refuse on slow real
transports; offline latency does not qualify live Tor reliability. The existing
30-second transaction-service deadline starts before EOA setup and is not
renewed. Neither a full 30 seconds from display nor a further 20 seconds after
approval is guaranteed.

## Qualification

All **fourteen cold-submission cases pass**: twelve advanced-root cases across
Shield/received-Transact inputs, all three operation kinds and acknowledged/lost
replies, plus two unchanged-root controls. Two default warm proof-recovery cases
also pass, with no submission handoff created. The launcher verifies 44 actual
Electron process exits and the setup/recovery/submission PID joins. The separate
six-case warm partial-submission/capture matrix passes against the shared core.

The [qualification index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-cold-submission-2026-10-05.json)
records exact raw operation reports, launcher records, handoff/log hashes and runtime pins.
The published cold launcher replaces 132 machine-local repository path prefixes
with `<repository-root>`; its original and published hashes are both recorded.
All other launcher bytes are unchanged, and the original remains local.
All fourteen cold cases share **538 source hashes**; the two default recovery
cases each cover 536 and the six warm partial cases each cover 532. Every inventory
was checked against the same final tree. Cold submission takes 4,676–16,800 ms
except the received-partial acknowledged case, which includes all negatives and
the real held-review test and takes 93,776 ms. Warm partial cases take
19,801–27,775 ms. Healthy C-exit-to-review observations are 613–770 ms under
synthetic transport; these do not measure production receipt timestamps.

The focused submission/proof and journal/account suites pass **465 tests across five suites** in
14.216 seconds, including warm and recovered consumers. Guard-removal controls (scoped and hashed in the index)
distinguish late durable-record comparison, checkpoint-token rejoin, creator
index binding, source drainage, minimum remaining lifetime and root/list receipt
reassertion. The post-sign/creator/drain controls belong to their preserved pre-margin source;
the margin/token-rejoin/root/list controls use the final frozen source.
Independent receipt revocation controls avoid falsely claiming that
POI expiry can be isolated when the earlier proof has the same lifetime.
Full repository lint and scoped formatting pass. The [repository regression](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-cold-submission-regression-2026-10-05.json)
passes **15,457 tests across 512 suites**, with 33 tests and five suites skipped,
in 606.564 seconds. Its exact 1,378-file JavaScript/JSON inventory is unchanged
before/after. The command retains the established OpenLV suite exclusion and
forced Jest exit; it does not prove natural test-runner handle drainage.

The first diagnostic attempts found three fixture assumptions: sorted expected
handoff keys, the already-existing empty submission journal, and the intended
invalid-membership utility failure. Their profiles/logs are preserved. A passing
single case was superseded when the expected utility exception was tightened;
only the final frozen matrix supplies this checkpoint’s native evidence.

The new harness uses separate prepare, proof-recovery and submission Electron
processes, with exact spawned PID joins and profile locking. Each case starts
from the pinned public vector in a new disposable directory. Actual account,
wallet, storage, reservation, proof, signer and journal implementations run with
synthetic chain/list/service responses and broadcast transport. The fixture
writes public submitter metadata; production onboarding is not qualified.

Advanced-root cases preserve the original proof root while the completed wallet
has moved forward. Same-root controls retain the original checkpoint. Acknowledged
and lost-reply cases require one EOA signature/send, durable journal begin before
transport, and duplicate refusal without new disclosure or key/network work.
Selected cases exercise non-Valid POI status, invalid membership, wrong verifier,
spent nullifier, synthetic false/unknown root history and checkpoint TXID root
refusal. The pinned contract only ever sets historical roots true; the false/unknown
case is a fixture refusal, not realistic root deletion. A held review exercises
expiry and retained account exclusion; it does not isolate which of the review
and service lifetimes expired. Deliberately invalid membership proofs must make
the genuine POI verifier exit FAILED/1 exactly once in its named negative phase, without escalation or
peer disconnection; all other utilities must close normally.

Disk assertions authenticate the already-existing empty EOA journal created by
preparation. Refusals preserve its bytes; only genuine begin/acknowledgement
writes change it. The authenticated reservation and capsule records (entry, capsule, signature
and proof) remain unchanged; their encrypted files change only through the
bootstrap lease update.
The cold bootstrap changes six account files; subsequent account writes are
limited to genuine Transact mirror constructor bookkeeping. Inventory bytes and
post-bootstrap profile top-level names/types are checked, not whole-profile
byte identity or power-loss durability.

Reports use `freshLiveServiceAuthorities` to mean fresh final-phase receipts
issued by production hosts over synthetic services. It is not live-network
evidence. `after.eoa` is taken before final fixture closure; the later `eoa.close()`
asserts zero pending calls and equal create/close counts before report emission.
Utility/storage-worker exits and wiped key loans are separately asserted. Logical
RPC release is not a claim of physical real-socket drainage.

The harness keeps unsupported native cases explicit: different submitter,
checkpoint drift during admission, signed-but-unproved capsule, endpoint
revocation, missing/pending TXID mirror and a creator containing an unshield.
Some have unit coverage; the matrix does not establish native coverage for them.
The creator-with-unshield path belongs to connected change/second-spend work.

## Remaining work

Durable combined POI, normal change ingestion, restart and a second spend of that
actual change remain next. Partial facade exposure, meaningful live private
submission, real transport latency and broadcaster qualification remain open.
No funded profile or external endpoint is accessed by these offline qualifiers.

Two separate findings remain tracked: the existing missing-explorer case can
produce an `undefined/tx/...` result URL, and cancellation/deadline expiry after
journal begin but before transport can retain an uncertain attempt even when no
bytes were sent. The same-nullifier reservation then continues to block retry.
That window is treated like a crash and requires a separately reviewed recovery policy;
this milestone does not silently release or renew it.

Subsequent isolated fix: transaction explorer links now return `null` when the
configured chain has no usable HTTP(S) explorer base. Actual registry-layering
tests and Claude review cover the correction. The unused exported address-link
helper still has the earlier behavior; the pre-transport journal window remains
open. This follow-up does not change the frozen qualification reports above.

The implementation stays within existing main-process wallet ownership and
qualification scripts. There are no UI, IPC, dependency, runtime, deployment-pin
or derived-cache-policy changes. Claude and independent Codex review are
engineering review, not an external security audit.
