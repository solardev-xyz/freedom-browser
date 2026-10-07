# Combined withdrawal and change POI

This checkpoint extends **standalone local cryptography** for a bounded partial
WETH withdrawal. It does not yet enable partial spending, genuine partial POI
preparation, persistence, submission or recovery through the wallet controller.

For one input V, the transaction commits to private change C and a final gross
withdrawal U, with V = C + U and both outputs positive. One existing POI_3x3 proof
covers both commitments. There is one ordinary output NPK, value and blinded
commitment; the unshield has no ordinary output entry. The eight public signals
are blinded change, two zero padding values, TXID root, own TXID, input list root
and two engine Merkle-zero padding values. No new circuit, dependency or pin is
needed.

## Binding and compatibility

The canonical payload keeps its seven fields. Transfer is one blinded output
with marker zero; full withdrawal is no blinded output with marker T; partial
withdrawal is one blinded output with marker T. T is the exact 32-byte own TXID,
including leading zeros. Legacy payload bytes, hashes and submission envelopes
remain unchanged. Structural shape and successful cryptographic verification
do not establish which operation was authorized.

The own-proof input normalizer binds a version-2 partial capsule to its matched
receipt and exact two-commitment TXID row. The application binder derives output
count and marker from those inputs. Reconstruction decrypts the original change
ciphertext, checks the same-account NPK, WETH, C, commitment, Change annotation,
the engine's null sender random and absent memo, and checks the final unshield preimage hash.
It creates no new output randomness. Both Shield and supported received-Transact
inputs use V rather than U when checking the spent note.

Existing POI documents remain versions 1/2 and refuse combined records, including
attempted records with a matching submission envelope. Preparation, membership,
the genuine own-proof host and cold validation retain explicit legacy-operation
bounds. Disclosure and output recovery retain their existing operation-bound
checks. Accepting the new payload in a pure parser cannot authorize a key loan,
write or POST. All production logic remains in the existing main-process wallet
modules; the native tooling stays under scripts. No IPC or renderer surface changes. None of the changed production modules is a
wallet/public/TXID derived-cache policy input; no cache rebuild is required.

## Qualification

The [complete native report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-combined-poi-native-2026-10-05.json)
records four passing cases with 465 unchanged JavaScript/JSON hashes:

| Operation | Input creator | Total milliseconds | Reconstruction refusals |
| --- | --- | ---: | ---: |
| Partial withdrawal | Shield | 10,927 | 17 |
| Partial withdrawal | received Transact | 10,880 | 20 |
| Transfer | Shield | 10,536 | 10 |
| Full withdrawal | Shield | 6,734 | 10 |

Each case passes 12 assembly refusal controls and eight public-signal mutations.
The partial and transfer wrong-marker proofs also pass separate keyless verification
and fail application binding. Every utility exit is observed. Total times include
spend proving, POI proving, controls and verification, not just POI proof generation.

The mandatory `npm test` run passes 1,697 tests across 14 suites in 129.025 seconds.
The Transact membership fixture was then strengthened to demonstrate a structurally
coherent partial input; its full 37-test suite passed again, without changing the
count or production code. The native report above was refreshed after that change.
Lint is clean. The [qualification index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-combined-poi-2026-10-05.json)
records exact evidence hashes and limits. Full repository regression was not rerun;
the preceding 14,483-test result belongs to the earlier merged checkpoint.

Detached controls remove checks only in an in-memory Jest transformer. Seven
reconstruction checks each produce their intended direct failure. Store reading,
early preparation, exact marker binding and verifier input count produce 3/3/3/5
expected failures respectively. Proof-host, cold-validation and membership guards
produce 6/8/4 expected failures. Other malformed cases can still be refused by
independent checks. These tests mock cryptography and selected authority seams;
they are not evidence of genuine partial controller admission.

The native fixture uses disposable public test keys, actual signed spend proofs,
original encrypted outputs and actual POI proofs. Chain receipts, inclusion and
list membership are synthetic. The received-Transact creator uses a different
account derived from the same public mnemonic; its creating spend is not proved
or mined. This is not authenticated wallet scanning or a genuine operation hold.
Proof payloads stay in memory; the report records only outcomes and source hashes.

The deliberately incorrect marker controls construct proofs directly through the
SDK inside the fixture. A partial transaction with marker zero is transfer-shaped;
a transfer with marker T is partial-shaped. They must pass cryptographic and
fresh-process keyless verification and then fail the correct application binder.
Production witness preparation has no marker override. Empty outputs plus a zero
marker are structurally invalid.

Negative reconstruction cases include validly encrypted wrong change value,
foreign NPK with the same viewing key, Transfer annotation, memo, hidden sender,
wrong final unshield hash and reversed commitments. Reversal refuses at the final
unshield-hash check, before change decryption. Detached guard-removal unit controls
distinguish the individual checks; native sanitized refusals alone do not identify
which assertion rejected a case.

## Next connected stage

The missing prerequisite is a genuine partial operation hold and signing path.
The internal controller, account operation window, received-note staging,
identity admission, reservations and signed-capsule recovery must support the
same bounded operation coherently. The chosen next-stage route is to enable those normal protected internal
controllers together, then exercise them in process through the native fixture.
The existing facade constructs only transfer and full-note withdrawal requests;
no IPC handler constructs a private operation directly. Preserve and test that
call boundary while internal partial admission is qualified. This is a
planned change to internal admission, not a claim that admission is enabled now.
Once implemented, status reports must distinguish internal controller admission
from facade/IPC/renderer availability. No fabricated registry receipt or test admission
flag can substitute for this lifecycle.

Then persist one combined proof through the normal POI store. A proposed document
version 3 is a downgrade barrier, not a new payload or submission format. Older
readers will refuse the entire document, including legacy entries beside a partial
entry. Preserve legacy bytes and attempts, input uniqueness, floor checks and
uncertain-write recovery; qualify refusal without ciphertext/floor/inventory changes.

Cold validation must derive the appropriate own-selector digest domain from the
normalized capsule. Disclosure review must cover both blinded change and the
unshield TXID while preserving one durable attempt and no automatic retry.

Complete change ingestion through the normal scan, full process restart, combined
proof recovery, exact attempted-body recovery without re-submission, and a second
full unshield of the recovered change. The list fixture must validate the exact
combined proof and outputs before granting simulated membership. Deployed 01x02
preflight, live list eligibility and authorized live disclosure remain separate
requirements. No funded profile or live privacy service is used in this checkpoint.

A separate recovery gap remains: stored-signature replay has native utility
evidence, but a production host for resuming a signed, unfinished proof has not
yet been found. Reopening a completed signature/proof record does not cover that
case. The connected recovery stage must add the real exclusive recovery host,
with the exact persisted signature and no new spending-key request, before
claiming restart completion for signed, unfinished operations.
