# Railgun received Transact membership — October 4, 2026

Received Transact input selection now composes with the existing required-list
membership verifier and genuine receipt registry. The fixed named entry point
`openRailgunOwnTransactPoiMembership` obtains the historical creator preflight,
recovers the selector with a viewing-only worker, validates the same recorded
root again, acquires typed list evidence and verifies its path locally.

One directory owner spans all of that work and the returned receipt's lifetime.
Shield membership, the Transact selector diagnostic and Transact membership now
share that owner map. The existing receipt assertion accepts either genuine
membership variant. There is no second registration path, adopted diagnostic,
caller-supplied creator evidence or externally selectable mode. The selector
module is a thin compatibility wrapper; private orchestration lives beside the
existing main-process wallet membership host, with no renderer or IPC route.

## Freshness and disclosure boundary

The completed preflight retains its four source/root checks as historical facts.
The selector's final strict local recapture serves as the before-query capture.
A fifth root acquisition, capped at 15 seconds, sits between that capture and list
admission. This is not a global journal lock or an independent finality claim.

The fifth latest/validate pair must accept exactly the recorded common checkpoint
`{ index: state.count - 1, root: state.root }`. It adds no mirror page, replay,
source visit or extra creator transaction lookup. A service accepting the same
checkpoint does not prove that a newer tree extends it.

The root must remain current at every list request admission and at successful
acquisition completion. The private list scope rechecks that root through the
[parent-context transport fix](railgun-poi-parent-context-2026-10-04.md).
Already-admitted requests can still be connecting or receiving when expiry
occurs; this is an admission guarantee, not a byte-delivery guarantee.

Immediately after successful acquisition, genuine source/root checks and owner
checks, the host records historical root evidence, disables only the root gate,
clears its timer and closes the root resources. Local verification and final
recapture then require current owners, total deadline and list evidence. Root
expiry after that transition is allowed; list expiry is not. Returned receipt
assertions do not claim publication-time or continuing root acceptance.

Transact's total budget is entry-relative and capped at 300 seconds; preflight
leaves 100 seconds. Selector recovery is capped at 20 seconds, its worker at 15,
and its strict recapture at 10. Fifth-root acquisition is capped at 15; list
acquisition is capped at 30, further reduced by root/total remaining time and
reserved margins. Verification and final capture each have 10-second caps.
These are admission/refusal budgets, not promised success durations or permission
to release resources before cleanup. Shield keeps its 480-second ceiling and
existing stage budgets and keyless selector.

## Typed evidence, keys and cleanup

The one note is explicitly `Transact` in list queries and the signed event.
Signature, type, commitment, event index, proof leaf and local Poseidon path must
all agree. The service signature binds index/type/commitment, not all historical
chain/root metadata; the host preserves those other bindings separately.

The selector worker's one-shot credential broker, strict recovery reattest,
mutable-key wiping and child/borrowed-work drain remain intact. All three entry
points exclude one another until actual work and the genuine list-source closure
barrier settle. Root acquisition is awaited and root closure requested; the
current root reader has no physical closure barrier, so root-socket drain is
not claimed. List transport drain remains distinct and mandatory.

The genuine Transact membership receipt still fails the existing Shield-only
proof-data boundary before additional credentials, proving or registration.
No intent preparation, transition reserve, output recovery or sender is enabled
by this milestone. Account authentication, source/current-finality, disclosure
and spending flags remain false. Typed membership is not consent or evidence of
acceptance of an earlier submission.

## Qualification

All 176 focused tests across four suites pass in 5.706 seconds; lint and diff
checks pass. Composition tests use genuine scopes, phase leases and the shared
owner/receipt registry with mocked identity/producer/credential/worker boundaries.
They obtain a genuine registry receipt and invoke the actual proof controller
and normalizer, which refuse before additional key work. The admission suite
uses the actual root reader, public-service client, POI source and event validation
with simulated transport and a narrowly substituted disposable signature key.
Original required-list verification rejects that disposable signature. Its local
membership verifier is mocked; native runs supply actual path verification.

Seven targeted baseline controls pass. Omitting the private root predicate causes
four extra-method admission failures. Keeping the root gate after acquisition
causes two false refusals; this detects dependency on the intentionally closed
root, not age alone. Omitting the list drain condition causes one premature owner
release. These temporary mutations do not alter repository files.

A controlled positive publishes at root age 62,998 ms and list age 47,999 ms:
root acquisition 14,999, list acquisition 29,999, verification 9,000 and final
recapture 9,000 ms. Real fake-timer dispatch confirms the cleared root timer does
not revoke the list-only lifetime; later list expiry does. Late already-admitted
responses settle without admitting a following method. Cancellation, both drain
orders, borrowed work, throwing cleanup, invalid barriers, all-mode exclusion,
type/index/leaf/signature substitution and strict archival drift are covered.

Four native combinations each preserve 11 creator-preflight groups and pass
11 membership groups, with 178 matching source hashes:

| Own operation | Creator | Duration | Report |
| --- | --- | ---: | --- |
| Transfer | Self | 69,872 ms | [Report](qualification/railgun-transact-membership-transfer-self-2026-10-04.json) |
| Transfer | Foreign received | 76,257 ms | [Report](qualification/railgun-transact-membership-transfer-foreign-2026-10-04.json) |
| Unshield | Self | 74,826 ms | [Report](qualification/railgun-transact-membership-unshield-self-2026-10-04.json) |
| Unshield | Foreign received | 75,343 ms | [Report](qualification/railgun-transact-membership-unshield-foreign-2026-10-04.json) |

Every run has six healthy membership results and five refusals: fifth-root
rejection, wrong signed event type, invalid signature, changed path and rejected
list root. Each refusal is followed by healthy reuse. All 11 attempts recover
one input selector with one viewing-key reply; seven invoke the actual membership
worker (six healthy, one path refusal). The fixture asserts five same-point root
acquisitions in exact counter order per attempt. Healthy attempts make four list
reads; fifth-root refusal makes zero, type/signature refusal stops after three.
The remaining failures make four. These POST-based reads are not proof submissions.

Healthy receipts pass the genuine shared registry; copied/wrong-owner/closed
receipts refuse. All three entry points are excluded while the receipt is held.
The actual proof controller and actual proof-data normalizer refuse each healthy
Transact receipt at the existing context boundary without additional credentials,
worker jobs or traffic; the membership receipt remains usable until closed.
Strict capsule/signing-record/journal snapshots match, non-detached 32-byte key
buffers are wiped, child exits match starts, and close barriers settle. Exact
failure stages are asserted in the fixture; reports retain bounded booleans and
counts. No selectors, root values, proof input hashes or binding digests are
reported outside the source-file inventory.

Native admission ages are 1–3 ms, with verifier-entry ages 2–3 ms. Each run has
38 admission measurements and seven verifier-entry measurements. The first
setup attempt was excluded after finding a fixture-only nonexistent worker
filename in the inventory; the corrected `railgun-poi-job.js` inventory and
counter produced the four completed reports above.

Legacy Shield [transfer](qualification/railgun-transact-membership-shield-transfer-2026-10-04.json)
and [unshield](qualification/railgun-transact-membership-shield-unshield-2026-10-04.json)
pass in 51,337 / 50,566 ms, each with 211 matching hashes, 19 membership and seven
recovery groups. The healthy [foreign-input selector diagnostic](qualification/railgun-transact-membership-selector-transfer-foreign-2026-10-04.json)
passes in 55,208 ms with 178 matching hashes, 11 preflight and six selector groups.
It retains the four-root-pair diagnostic contract and sanitized output.

Native qualification uses disposable genuine encrypted stores, actual credential
recovery/decryption and local membership crypto. Chain/root observations and list
transport are intercepted; list signatures use the explicit disposable-key trust
seam, while the real required-list key rejects them. Saved spend proof/signature
is structural. No funded profile, live owned-note query or actual submission is
involved. Independent agent review is engineering review, not a security audit.

The fixture measures root age at list transport entry and at verifier entry after
acquisition/root cleanup. The latter is an upper bound on acquisition-completion
age, not its exact instant. Both start at the fixture wrapper slightly after the
host timestamp, before actual root acquisition; they can read slightly low
relative to the host and are bounded observations, not Tor/deadline evidence.

Full regression passes 12,953 tests / 33 skipped across 495 passing suites /
five skipped (500 total), in 470.331 seconds. Exit 0; runner session drained.
All six production/test hashes and the qualifier hash match the frozen evidence.
The existing OpenLV exclusion and explicit Jest force-exit remain; this is not
a claim of natural closure of every test handle.

All 24 public/TXID and 30 wallet policy inputs remain unchanged (public
`d454092c`, TXID `03a45fd1`), as do dependencies, runtime pins and proof artifacts. Earlier live-generation rebuild and disclosure authorization
requirements remain open. Next: independently harden the existing proof host's
failure cleanup, then qualify genuine Transact proving through existing infrastructure. A narrow
prepare-time guard will keep Transact persistence disabled until output/intent
validation can succeed without needless disclosure. Output and attempt recovery require
separate work; uncertain attempts remain non-retryable.


## Frozen implementation and independent test hashes

- `railgun-own-poi-membership.js`: `93c510684d1bd0685dd0495355659505365f6575eb9eaa637ae80d94702fa3a3`
- `railgun-poi-transact-selector.js`: `ab542107984f07caa3f963f8147c3df2065cbfc6898eb288d6792b36cb1ace7e`
- `railgun-own-poi-membership.test.js`: `759bec5d98a87b1cf9f30ff0d705a232081088a536ced951063972557f294b23`
- `railgun-poi-transact-selector.test.js`: `7dd0e3914cc40dc442636cd37d572482d7a20830548dbbf1c08159daff15f287`
- `railgun-own-transact-poi-membership.test.js`: `6014f95c5f24e8c7d6c7ce159dd8806eb1bb46616c50e3aa5c4cdf8f7d2eadf6`
- `railgun-own-transact-poi-admission.test.js`: `60b072031cbb448c4bf428ca40d2136063a22597f2bb6dd6576917a035776ccb`
- Native qualifier: `5c9e4d2578d5fb61536670abc4e9d99c3245bc9baa7da134600d818c00802570`
