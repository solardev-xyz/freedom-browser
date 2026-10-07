# Railgun partial-unshield structural checkpoint — October 4, 2026

**Historical checkpoint `12ac9de4`.** The later
[native cryptographic work](railgun-partial-crypto-2026-10-04.md) enables partial
signing and reconstruction inside guarded utilities. Their refusal checks and
guard-removal evidence below describe this earlier checkpoint. Main account,
signing, operation, reservation, submission and POI admission remain closed.

Partial withdrawal now has an explicit bounded data model, without enabling a
partial spend. The remaining implementation is tracked in the
[complete partial-unshield plan](railgun-partial-unshield-plan-2026-10-04.md).
All code remains within the existing main-process wallet and qualification
boundaries. There is no new renderer surface, IPC, dependency or runtime archive.

## What the model binds

The new kind is `railgun-partial-unshield`. A recovered input has value V; the
request supplies gross withdrawal U, where `0 < U < V`; change is C = V − U.
All amounts retain the existing pinned Sepolia WETH and qualification limits.
Private preparation stores `inputAmount`, `unshieldAmount` and `changeAmount`
explicitly. It cannot reuse the legacy ambiguous `amount` field. Main selection
binds V to the recovered note; the structural arithmetic does not establish
encrypted-output ownership or cryptographic conservation.

Public intent has one nullifier, exactly two commitments ordered
`[changeCommitment, unshieldCommitment]`, one ciphertext and ordinary unshield
flag 1. It binds the recipient, token and gross `unshieldAmount`, retaining zero
adapt parameters, zero minimum gas price and existing calldata bounds. It does
not add plaintext input or change values to the public expected object.
The structural fixture uses dummy proof coordinates and commitments; its
acceptance is not evidence of a valid circuit witness or decrypted note.

The new capsule uses version 2 and the digest domain
`freedom:railgun:private-capsule-v2\0`. Only the partial kind can use that version;
legacy transfer and full unshield remain version 1. Pre-edit golden fixtures
check both legacy canonical byte strings and digests. The circuit signature
message keeps its original Poseidon public-input convention; no application
domain is inserted into it. Recovery data retains encrypted calldata, without
adding plaintext output randomness or a private witness.

## Admission remains closed

The operation controller, account-wallet prepare/operate entry, Transact staging
and main spending-key gate explicitly refuse the partial kind. Independent
guards also refuse it in the spending utility, private and POI reconstruction,
private submission, own-operation capture, POI proof-data construction and
output recovery. These checks precede the relevant utility, key, query or
legacy interpretation. Ordinary read-only restoration remains available.

Reservations, public EOA journal intent parsing and journal resolution still
accept only the two supported legacy operations. Resolution has its own kind
check so future parser widening cannot prematurely settle a partial operation.
No genuine new-kind reservation, signed record or public transaction is produced.

An encrypted-store test cold-reopens a genuine legacy capsule beside a version-2
structural record inserted through authenticated test storage. It preserves
legacy record bytes, validates the new data and refuses an unsupported signed
read. This qualifies mixed-format storage normalization only. Before production
writes become possible, downgrade behavior must be decided: an older build may
refuse an entire capsule store, or later an address's shared EOA journal. The
latter could also block ordinary sends. Signed records must not be rewritten
into a different meaning to avoid that refusal.

## Verification

Four focused runs total **890 passing tests across 18 suites**: 205 core-model,
416 legacy-consumer, 163 operation/journal/store and 106 additional-admission
tests. These are separate runs, not one aggregate invocation. Temporary Jest
transforms remove only the new guards without changing repository files:
13 of 14 targeted cases fail across all seven consumer suites; the remaining
Transact case still refuses through its independent selector guard, while its
Shield counterpart exercises the new guard. All four targeted cases fail when
the three additional admission guards are removed. Baseline controls pass.
Lint is clean. Claude reviewed the implementation and identified the additional
admission boundaries, which were fixed and reviewed again. This is engineering
review, not an external security audit.

The [full frozen regression](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-partial-structure-regression-2026-10-04.json)
passes **13,872 tests / 33 skipped**, **503 suites / five skipped**, in **557.035
seconds**, with all **1,496 source/test/configuration hashes unchanged**. The
existing OpenLV exclusion and force-exit remain; this suite does not qualify
natural application-handle drainage.

Six fresh Electron processes exercise the existing operations on the changed
source. Each passes the 19 surrounding enrolled-wallet baseline cases:

| Existing flow                     | Outcome exercised     | Operation time | Source inventory |
| --------------------------------- | --------------------- | -------------: | ---------------: |
| Shield input → private transfer   | Lost acknowledgment   |       4,502 ms |              133 |
| Shield input → full unshield      | Acknowledged          |       4,106 ms |              133 |
| Transact input → private transfer | Acknowledged          |       8,351 ms |              133 |
| Transact input → full unshield    | Lost acknowledgment   |       7,738 ms |              133 |
| Shield input → private transfer   | Held review cancelled |       3,514 ms |              133 |
| Public native-ETH Shield          | Acknowledged          |       1,874 ms |              169 |

The [native evidence index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-partial-structure-native-2026-10-04.json)
retains each complete operation result and points to byte-identical original
reports. All listed source hashes match the frozen working tree. Inventories
identify source versions; inclusion does not prove execution of every module.
The four private sending cases use real proofs, independent verification and
vault private/EOA signing; each sends once to simulated transport. Cancellation
retains the signed private hold while making no EOA signature or send. Public
Shield executes the real engine, receiver, deployment-check code, vault EOA
signer and journal, with one simulated send. RPC replies and private POI/preflight
authority remain synthetic. No funded profile or live service was opened, and
none of these reports qualifies a version-2 partial proof.

Four of the 30 wallet-policy source inputs changed: capsule, private policy,
preparation and reconstruction. Consequently the wallet-derived-cache policy
changes and requires the normal generation/rebuild path. Public and TXID policy
inputs, engine/prover archives, pins and dependencies are unchanged. Fresh
qualification profiles use the new policy; the funded profile was not opened or
refreshed. Historical reports retain their original inventories.

## Next implementation

Generate the pinned engine's self-owned Change output; decrypt and bind its
value, token, NPK, commitment and annotation; reconstruct the original ciphertext
without randomness; then sign and independently verify all five 01x02 public
inputs. After that, connect exact receipt/TXID recovery, combined output-plus-
unshield POI, authenticated change scanning after restart and a second full
unshield of that recovered note. Only the complete connected qualification
permits exposing partial withdrawal through Kohaku. Live eligibility and a
funded private journey remain separate requirements.
