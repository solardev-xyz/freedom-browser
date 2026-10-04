# Railgun received-note local POI proofs — October 4, 2026

Received Transact inputs now use the existing main-only POI proving controller,
viewing worker and fresh keyless verifier. The supported shape remains one
current-format pinned-WETH input with one self-transfer output or a full EOA
unshield. The creating transfer may be from the same or another account. This
extends the local proof path; it does not yet enable a prepared Transact intent,
output recovery, disclosure or submission.

The prerequisite [proof-host cleanup](railgun-poi-proof-host-hardening-2026-10-04.md)
was committed separately. A failed broker job cannot recover by sending another
message, and publication follows observed child exit, borrowed-work drain and
final account/deadline checks. The existing private-account job allowance, worker
protocol, artifacts and 175/120/110-second controller/recovery/job budgets remain.

## Admission and historical evidence

The shared normalizer derives the input type from the creator. Shield retains its
existing checks. Transact reuses the strict receiver-selector normalizer and
requires canonical capsule equivalence, exactly one own nullifier/commitment,
matching own witness and an exactly typed list proof. The same normalizer runs in
the utility before credential admission. This structural validation is not a
second source or list-signature authority.

The host first asserts the genuine membership receipt with its existing 1-second
margin. Before recovery or credentials, it binds receipt type symmetrically to
creator type; exact capture/capsule; recomputed selector binding and serialized
input digest; creator note tree/position/hash; current registered public identity;
and creating-note witness against the same historical checkpoint as the own
witness. Creating output index is zero, creating unshield is absent, cardinality
is one nullifier/commitment, and the creator leaf precedes the own leaf. The
producer must have verified the creating path/event, exited its utility and
reported one matching row with no known omission. Signed Transact event type,
leaf and index must match the verified selector/list path.

These facts come from the existing genuine membership registry. No detached
observation or diagnostic result can be adopted. The proof history gains no
unused provenance field; the existing 64 KiB input and 128 KiB history bounds
remain. Unknown creator types refuse, with no legacy or sent-only fallback.

Membership becomes immutable preparation history after initial live admission.
Proving does not extend list freshness or current-root acceptance. Account,
identity, public generation, caller, recovery capture and controller deadline
continue to be checked, including inside credential admission. One valid key
request consumes the receipt before awaiting; failures before that preserve the
existing reuse rule. Cleanup overrun after admission requires fresh membership.
No additional service requests are made by proving.

## Temporary preparation guard

The encrypted intent store rejects genuine Transact proof history immediately
after registry authentication, before payload binding, recovery, prepared writes
or retention-floor updates. This matters because persisted records contain no
creator discriminator and downstream output validation still supports Shield.
Allowing preparation now could cause disclosure before an inevitable refusal.
The guard returns the existing context refusal and releases in-memory exclusion;
it does not change record versions, CAS rules, transition reserves or attempts.
Shield preparation remains supported.

The next connected change must authenticate either creator type during fresh
retained-source recovery, verify the creating TXID at the same checkpoint for
Transact, widen output/proof-history consumers, and update the reviewed disclosure
inventory. Only after that whole path is qualified can this guard be removed.
A successful local proof alone is insufficient.

## Independent tests

All 565 focused tests pass across seven suites in 21.983 seconds; lint is clean.
Full regression passes 13,058 tests / 33 skipped across 496 passing suites / five
skipped in 500.409 seconds. It uses the existing OpenLV exclusion and explicit
force-exit with native-process permissions; natural application-handle drain is
not claimed. All three production and five independent-test hashes remain exact.
Six targeted baseline controls pass. Removing the symmetric type check, exact
selector-input digest check or provenance/public-identity check produces one
incorrectly admitted proof each. Removing the preparation guard produces three
incorrectly persisted records in the mocked proof-registry model. These controls are temporary in-memory transforms;
production source is unchanged during the experiments.

The strict data suite uses the real capsule normalizer, own transaction/receipt
matcher, structural witness validator, typed list bounds and expected-payload
helper. It covers transfer/unshield, canonical serialization, detached freezing,
malformed fields and the 4,096-byte accepted / 4,128-byte rejected creator-event
boundary. Its Merkle data are structurally coherent, not cryptographic evidence.

Host tests use actual Transact normalization and binding but mocked membership,
identity/recovery, child and keyless verifier. Mismatches refuse before recovery
or credentials; correcting the same mock receipt then succeeds. Worker tests use
actual normalization but mock expensive proving and artifacts. Store tests use a
mocked proof registry with real encryption, files, privacy contexts and floor
bookkeeping: empty/prepared/attempted stores remain unchanged after refusal and
subsequent Shield preparation works. The older genuine-membership composition
fixture has incomplete TXID preparation; its continued refusal is now explicitly
attributed to that incomplete fixture, not a Transact type prohibition.

## Native qualification

All four explicit Transact proof-mode runs pass on the frozen source tree, with
222 matching source hashes each and twelve viewing replies: eleven selectors
plus one proof key. Each retains eleven preflight and eleven membership groups,
seven membership verifiers, one proof job and one fresh keyless proof verifier.
The real proof/store segment takes 4,972–5,049 ms.

| Creator / own output | Total elapsed | Report |
| --- | ---: | --- |
| Self / transfer | 82,208 ms | [Report](qualification/railgun-transact-proof-transfer-self-2026-10-04.json) |
| Self / unshield | 81,100 ms | [Report](qualification/railgun-transact-proof-unshield-self-2026-10-04.json) |
| Foreign / transfer | 83,787 ms | [Report](qualification/railgun-transact-proof-transfer-foreign-2026-10-04.json) |
| Foreign / unshield | 82,732 ms | [Report](qualification/railgun-transact-proof-unshield-foreign-2026-10-04.json) |

The matrix exercises self/foreign creator × own transfer/unshield with actual encrypted
accounts, membership, viewing proof worker, independent keyless verifier and
proof registry. Only the first healthy membership in each matrix run proves;
all eleven preflight and eleven membership scenarios remain. Foreign means a
different account of the same public fixture mnemonic. Membership-only mode
now deliberately omits the obsolete assertion that Transact proving must fail.

Each proof checks exact zero service deltas across every RPC role and POI/TXID
method, privately compares payload metadata and digests, checks consumed-receipt
refusal, and waits for all child exits and key wiping. A genuine proof then meets
the actual preparation guard against an empty encrypted store. The store opens
before the baseline; intent-file existence/bytes and account-manifest bytes,
records, sequence and reserves must remain equal after refusal. Reopen rotates
the encrypted lease and writes the manifest floor again, so its check compares
logical records, sequence and reserves rather than ciphertext bytes.
Recovery calls are counted at the lazily loaded real entry point. The empty store is initialized before comparison.

The initial self transfer/unshield runs reached real proof verification and
passed the immediate refusal snapshot, then failed an incorrect ciphertext
equality assertion after reopening. Reopen intentionally rotates the lease and
rewrites the encrypted floor. Those runs produced no reports and are excluded;
production was unchanged for the corrected reruns.

Final-tree Shield intents-mode [transfer](qualification/railgun-transact-proof-shield-transfer-2026-10-04.json)
and [unshield](qualification/railgun-transact-proof-shield-unshield-2026-10-04.json)
runs pass in 131,319 / 129,842 ms with 212 matching source hashes each. They retain
19 membership, seven recovery, thirteen proof, eight root-check and six intent
scenarios, including a genuinely changed proof rejected by independent verification
and positive encrypted preparation. Both include observed early-timeout closure
within the original scheduling bounds. Transact does not duplicate the native corrupted
proof experiment. Native chain/root/list transport is intercepted, required-list
signatures use the disposable-key trust seam, and saved spend proof/signature is
structural. The genuine required-list key rejects fixture signatures. These runs
cannot establish live eligibility, mined spend validity or service acceptance.

## Remaining boundaries

No live owned-note query, funded profile, spending credential or submission is
used. Public/TXID/wallet policy inputs, runtime/artifact pins, dependencies, UI and
IPC remain unchanged. All 24 public/TXID and 30 wallet policy inputs match
the prior checkpoint (public `d454092c`, TXID `03a45fd1`); freshly fetched main
`cdd014f2` remains merged with the recorded explicit node refresh. Funded private transfer/unshield and exact-POST acceptance
remain unfinished; uncertain attempted submissions remain non-retryable. This is
engineering qualification and review, not an external security audit.


## Frozen implementation and independent tests

- Proof host: `b121f0274b92bc417d9e99bc2a8a0ab7b087171644c19e468623717aa4615f36`
- Shared proof data: `08864c969eba55c820ebb9bc38db4fa2f0b48ccc48def7c7a26d14e1a8927709`
- Intent store: `8ff8755e33cbd5c9adea5e6c8bc08d0dfbd9617a82f94468ca4e339d227c12c9`
- Proof tests: `6b8f0a15adaf3c7a9858fc259d96184a6dc9a02699b511271497543601068f77`
- Worker tests: `66de6972750b9bb7e579672c47cf1ceb659515f1b68addf2a45423db65aca052`
- Store tests: `87e1e022bc6baa39653e400e5de2be4d3ab36490d30be32dd6821dec6c0fdc10`
- Membership composition: `3941a2b400c8f61d9f318b96060666b0bc3e4336fe23745dc6c34b5a76d4eeac`
- Strict Transact proof-data tests: `ac4f6fd7c59134152d60eab4c45bb08c0a54cff86bd3c70523392b34756ab09b`

- Transact qualifier: `7ad309fb7faea2efad2ff471ef2a8296f0206ba26e51d4c895959e5f10660603`
