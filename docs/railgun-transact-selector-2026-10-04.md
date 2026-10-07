# Railgun received Transact selector — October 4, 2026

A main-only diagnostic now recovers the input selector for an owned operation
whose input was a received Transact note. It obtains creator provenance through
the genuine fixed preflight, then uses one viewing-only utility and strict local
recovery checks. The exported result contains only status/stage and booleans:
the linkable selector, input/binding hashes and historical capture remain internal.
It does not query an owned list, prove POI, prepare an intent, submit anything or
authorize spending. Both own transfer and full-unshield inputs require a viewing
key; the zero-key unshield rule applies to output recovery instead.

## Historical producer and key boundary

The new fixed internal producer calls the existing Transact preflight core and
returns only after its normal cleanup and final outer owner/generation/deadline
checks. No supplied observation, completion registry, claim operation or generic
callback can adopt a diagnostic. The old preflight API stays unchanged. This
retains the completed invocation's source and cryptographic provenance facts;
it does not extend canonical freshness or root acceptance after source closure.
Strict local recapture cannot detect an unobserved remote reorg, and current
public generation is not current remote finality.

The selector host requires the exact genuine identity/enrollment and full
descriptor. Its input creator matches the verified creator note explicitly on
type, tree, position and hash. One local directory owner remains held through
preflight, recovery, child exit, borrowed derivation/reattest work and final strict
recapture. It is not a global journal/writer lock; other operations use existing
coordinator and phase exclusions.

The worker's only binary-key allowance is the exact private-account/Railgun/
Sepolia/engine/poi-transact-selector/filename tuple. The original Shield selector
remains keyless. A valid key request consumes the attempt before its first await.
Recovery reattestation occurs before derivation and inside the credential callback;
identity/lifetime checks immediately precede copying. Malformed, duplicate, early
and late messages refuse permanently. Cleanup always observes child exit and
borrowed asynchronous work before releasing the phase/owner. Mutable key copies
are wiped; immutable witness integers stay inside the utility until process exit,
without a claim of provable JavaScript integer zeroization.

The shared normalizer binds descriptor, capsule and creator with a domain-separated
digest, enforces the exact ciphertext schema, and preserves the 4,096-byte encoded
creator-event limit inside the 64 KiB input cap. The worker reuses the existing
receiver-only reconstruction: viewing/address/master identity, note hash/NPK,
WETH/value, position/nullifier and own-output consistency are checked. It computes
only the typed blinded input selector. No sent-note or legacy fallback is added.

The entry-relative total ceiling is 300 seconds. Preflight gets remaining time
minus a 100-second reserve; its own 55-second tail and actual source freshness
remain unchanged. Recovery is capped at 20 seconds, the worker at 15 seconds with
5 seconds reserved for cleanup admission, and final recapture at 10 seconds.
Key admission requires 5 seconds of job time plus the recovery reserve. These
limits can refuse slow work; they neither promise real Tor latency nor permit
releasing an owner while cleanup remains pending. The remaining reserve also
leaves room for the later membership step; no fifth root pair is made yet.

## Qualification

All **366 focused tests across five suites pass in 17.550 seconds**; lint passes.
Tests use genuine privacy contexts and a phase lease around explicitly mocked
identity/enrollment, historical producer, recovery data, derivation and process
boundaries. Normalizers are real; unit engine math and reconstruction are mocked.
Thirteen targeted baseline controls pass. Removing permanent broker refusal
exposes ten immediate-revocation failures; omitting borrowed work drain exposes
two premature returns; omitting final strict capture exposes one false success.
These are host-boundary controls, not a demonstrated real supervisor bypass.

Four native runs use genuine disposable encrypted enrollments/capsules/journals,
source and TXID checks, credential derivation, worker isolation and receiver crypto
with intercepted chain/root services. Each passes **11 existing preflight groups
and six selector groups**, with **166 matching source hashes**:

| Own operation | Creator          | Entire fixture duration | Report                                                                             |
| ------------- | ---------------- | ----------------------: | ---------------------------------------------------------------------------------- |
| Transfer      | Self             |               55,250 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-transact-selector-transfer-self-2026-10-04.json)    |
| Transfer      | Foreign received |               55,316 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-transact-selector-transfer-foreign-2026-10-04.json) |
| Unshield      | Self             |               54,813 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-transact-selector-unshield-self-2026-10-04.json)    |
| Unshield      | Foreign received |               54,506 ms | [Report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-transact-selector-unshield-foreign-2026-10-04.json) |

Each run has three successful selector recoveries, one wrong-key refusal after
admission, one wrong-identity refusal before preflight, and one root refusal before
key admission. Native refusals are asserted at exact stages `context` (wrong
identity), `preflight:txid` (root refusal) and `recovery:callback` (zeroed key);
the reports record booleans and counts, not stage strings. Four actual
viewing-key replies produce three selector results;
borrowed 32-byte buffers are confirmed wiped without accepting detached/empty
buffers. All children exit, durable signing records/capsules/journal remain equal,
and following healthy attempts succeed. Expected selectors are compared privately
in the broker and omitted from reports/diagnostics. All five preflight timing
labels complete before the key request; successful preflight still makes four
root pairs, with no additional mirror/source visit or list query.

The zeroed-key control reaches reconstruction's derived viewing-public-key check;
it does not establish ciphertext-tag rejection. Ciphertext/schema/field negatives
in this slice are unit-level checks with the stated mocked crypto boundary. Native
self/foreign positives exercise actual receiver crypto. Worker launch-to-request
is 148–211 ms and credential request-to-reply 24–34 ms locally; configured worker
lifetimes are 14,949–14,964 ms. These fixture measurements are not actual phase
remaining-time measurements, deadline guarantees or Tor performance evidence.

The fixture's saved own spend proof/signature and chain observations remain
structural/simulated. This is not evidence of a mined creator/spend or live required
list acceptance. No owned-note disclosure, funded profile, actual submission or
intent reserve mutation occurs. Independent engineering review is not a security
audit. Claude reviewed implementation and qualification scope; Codex provided
implementation and independent tests/controls.

Legacy Shield [transfer](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-transact-selector-shield-transfer-2026-10-04.json)
and [unshield](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-transact-selector-shield-unshield-2026-10-04.json)
compatibility runs also pass in **50,732/50,256 ms**, each with **211 matching source
hashes**, 19 membership scenarios and seven recovery scenarios. They retain the
keyless Shield selector, genuine membership receipts and the existing drain tests.
Their service signatures use the explicit fixture trust seam; the actual required
list key is separately required to reject those fixture signatures. No proof mode
was requested in these compatibility runs.

Full regression: 12,888 passed / 33 skipped; 493 passing suites / five skipped (498 total), 465.350 s. Exit 0 and the runner session drained. The existing OpenLV exclusion and explicit Jest force-exit remain; this is not evidence of natural closure of every test handle. All ten frozen production/test hashes matched after the run.

## Scope and next work

Existing main-process wallet ownership is preserved; new selector host/data/job
files have no renderer or IPC route. Reconstruction and the public/wallet/TXID
policy source inventories are unchanged: all 24 public/TXID inputs and 30 wallet
inputs match, with public policy d454092c and TXID policy 03a45fd1 retained. The
exact new viewing-job allowlist entry is intentional; no general key permission,
dependency, engine/prover/artifact pin or funded-profile change occurs. Main
cdd014f2 remains merged with the explicit node refresh recorded in the preceding
checkpoint. Previous whole-source reports containing changed host/process files
are historical until requalified. Earlier policy changes still require the
reviewed live generation/mirror rebuild.

Next is genuine typed Transact membership through the existing receipt registry,
with a fifth fresh validation of the same recorded root before owned disclosure,
followed separately by actual proof/intent preparation and shared output recovery.
Historical provenance must not imply irreversible finality or exact POST acceptance.
Uncertain attempts remain non-retryable; neither remaining intent reserve is
consumed. Live owned-selector disclosure still awaits its separate authorization.

## Frozen production and test hashes

- `railgun-own-witness.js`: `5a8abd7063761dd83d776cbf1cfc095bad9396c8577c8cf6b41fd95a8e927528`
- `railgun-own-witness.test.js`: `1472e29442906d194461a1ec047b3b1f1e0bd670920fe43bb8f364f7188d1b1f`
- `railgun-process.js`: `a7c21fc5752cd7789734fb491d8e777e50f34595a387c0ab0ec77a525bbfb39e`
- `railgun-process.test.js`: `5ec11ef22925a67f3a4e148e23cbfba575ff44e61f35d0262bef1d19e706487b`
- `railgun-poi-transact-selector.js`: `7b77ee12fe7371ac4d68ba679d9b6b1d3589ab11fe009652e38c0ae091e18ebc`
- `railgun-poi-transact-selector.test.js`: `33c504602071755893c9626b064f5e856f24f18a1ad9b02a9d7f0cde1d98e240`
- `railgun-poi-transact-selector-data.js`: `402dede380b370748a90f71307ca456e9161bac9051e5f09297bab0ef32140c2`
- `railgun-poi-transact-selector-data.test.js`: `a1dc9d64c833da7ffc3199e9e3aa2a6bec09d6f05a95db95a364e833f842d995`
- `railgun-poi-transact-selector-job.js`: `a6eeded6327d8e26661bd9bb64065237a613f268fcd39b751d5e4dbbce2ac0c9`
- `railgun-poi-transact-selector-job.test.js`: `8f9987744ddc61a59334704494d9ed76a4ef6f572c99c4ae851df3d4114d9268`
