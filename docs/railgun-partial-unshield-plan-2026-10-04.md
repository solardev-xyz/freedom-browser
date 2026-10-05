# Bounded partial WETH unshield and change spending

**Status: structural records, native cryptography, receipt/TXID primitives, creator authentication and standalone combined POI implemented;
protected internal signing/proving qualified for Shield input; facade/submission remain unavailable.**
The bounded model now has a distinct `railgun-partial-unshield` kind and version-2
capsule. Preparation and selection bind recovered input value, gross withdrawal
and change separately. Public policy accepts only the exact one-input/two-output
shape. These checks do not prove encrypted-output ownership or conservation.
The [native cryptographic checkpoint](railgun-partial-crypto-2026-10-04.md)
qualifies production change construction, 01x02 proving, independent verification
and original-ciphertext recovery using a stored signature and synthetic scan.
The [receipt/TXID checkpoint](railgun-partial-receipt-2026-10-04.md) adds versioned
public journal records, strict five-log receipts and keyless partial TXID checks.
The [creator-authentication checkpoint](railgun-partial-creator-authentication-2026-10-05.md)
adds final-preimage verification before roots and qualifies retained change
provenance through real local POI and encrypted recovery. Generic received-note
compatibility remains intact; this is not the complete second-spend lifecycle.
The [protected internal controller](railgun-partial-controller-2026-10-05.md) now
admits the kind through real account, reservation, signing and proof gates.
Shield input passes connected native qualification; received-Transact admission
has unit coverage. Partial submission and durable own-POI remain closed.
The [combined local POI checkpoint](railgun-combined-poi-2026-10-05.md) qualifies
one proof for withdrawal and original private change. Combined POI persistence/recovery, partial submission/capture, authenticated change ingestion and
the second spend remain to be implemented and qualified. This is not evidence of deployed
contract acceptance, a funded partial transaction or live service eligibility.

## Complete target

Spend one owned WETH note, unshield part to the existing permitted EOA, return
one change note to the same private account, recover that change through the
normal wallet scan, then spend it in a second full unshield. Support both Shield
and currently supported received-Transact inputs for the first operation.
Keep the pinned chain/token, one input, direct transaction, self-owned change,
existing submitter restrictions, zero adapt parameters and no override policy.
Arbitrary recipients for change, multi-input selection, multiasset operations,
batching, relayer fees and ETH unwrapping are outside this proposal.

## Amount and circuit semantics

For input value **V**, gross unshield **U**, and change **C**, require
`0 < U < V` and derive `C = V - U`; neither change nor input value is caller authority.
Local contract source computes an inclusive fee: recipient WETH is
`U - floor(U * feeBps / 10000)`. The fee comes from U, not C.
Current `railgun-private-preflight.js` requires 25 bps; retain that explicit check
and record actual receipt fee/net amounts without treating them as finality.
Native ETH pays gas separately. Fee rounding and positive net/change need tests.

Local engine `transaction/transaction.ts` appends the unshield preimage after
ordinary outputs: circuit commitments are **[change, unshield]**, with exactly
one change ciphertext. Only change enters the UTXO tree. Decrypt it as the same
account and verify pinned WETH, C, its NPK and commitment before signing.
Qualify the engine's Change annotation, including an absent memo, through both
receiver reconstruction and the wallet's owned-note classification.
Current `preparation.amount` represents input value; `expected.amount` represents
gross withdrawal. Their present equality must not become an ambiguous partial
amount convention. Use explicit input/gross/change fields in the new schema.

## Existing artifacts, checked locally

The files under `tmp/privacy-research-oct2/railgun-artifacts/` were read and hashed;
these values match the 01x02 entries in `railgun-artifacts.js`:

| File         |   Bytes | SHA-256                                                            |
| ------------ | ------: | ------------------------------------------------------------------ |
| `01x02.wasm` | 3007613 | `6ce87ddb4e33cff9564338a8b1f58047b22809e5d198f243c777d1aa4eaaa1e3` |
| `01x02.zkey` | 6121318 | `8ef8e7abcfb5e60fb593d4d961657465f498435a0835adef05acc09534d7557b` |
| `01x02.vkey` |    3256 | `9369fa6ad3d7a1becf4b10cf4bd6a7eb83725cfb5cf75a08b191c5bc2cd479f4` |

The VKey declares five public inputs. Engine source gives their expected order:
root, bound-parameters hash, nullifier, change commitment, unshield commitment.
This verifies local availability,
not proving success or the deployed verifier. POI_3x3 is already pinned and its combined shape now passes native proving;
genuine controller-bound durable POI remains outstanding.
No new dependency or artifact is expected from this source inspection.

## Implementation stages

All module names below refer to `src/main/wallet/`; keep the new capability
unavailable until the connected qualification passes, including the second spend.

1. **Define and bind the bounded model (structural portion implemented).** Evolve `railgun-private-preparation.js`,
   `railgun-private-selection.js`, `railgun-private-policy.js`, and
   `railgun-private-capsule.js`. Public journal support in
   `railgun-transact-intent.js` and `railgun-transact-resolution.js` moves with
   receipt primitives in stage 3 is implemented; connected submission remains
   unavailable. Derive the exact output shape and artifact variant from validated intent.
   Partial selection now reports recovered V and expected C separately, with
   `inputValueVerified` and `outputConservationVerified` both false. Preserve the
   legacy full-input meaning and reject all other shapes.
2. **Prepare, sign, prove and reconstruct the exact intent (utility path qualified).** Update
   `railgun-private-witness.js`, `railgun-private-reconstruct.js`,
   `railgun-private-prover.js`, `railgun-private-verify-job.js`, and
   `railgun-spend-sign-job.js`. The signer must check the final unshield commitment
   and sign all five ordered public inputs. These utility paths now pass native
   qualification using a synthetic account/scan. The subsequent internal controller
   qualifies genuine enrolled Shield-input admission; `railgun-private-preflight.js`
   selects 01x02 and matches anchored `getVerificationKey(1, 2)` before nullifier
   disclosure/signing. That native getter response is simulated. Preserve the one-use key/signature and utility boundaries.
   Recovery decrypts persisted change and reconstructs the original calldata,
   conservation and signature message; it never creates fresh output randomness.
   If reusing `railgun-private-receive-job.js`, replace its full-input amount and
   single-output assumptions with the exact authenticated change shape; do not
   treat the requested withdrawal amount as the expected change-note value.
3. **Recover both outcomes and their TXID (primitives qualified; connected admission pending).** Extend `railgun-transact-receipt.js`,
   `railgun-transact-resolution.js`, `railgun-own-selector.js`,
   `railgun-own-selector-job.js`, `railgun-own-source.js`, `railgun-own-txid.js`, and
   `railgun-own-txid-job.js`. Bind unshield recipient/token/gross/net/fee plus
   the exact change commitment/ciphertext/location. Replace the new shape's
   exclusive shielded-or-unshield interpretation with both outcomes. Its TXID
   includes both commitments and uses the real change tree/position, not the
   full-unshield sentinel. The Transact event contains only the change hash and
   ciphertext, although the transaction/TXID has two commitments. Bind the WETH
   recipient and treasury transfer amounts to the pinned receipt shape as well;
   qualify missing, extra or substituted relevant token transfers. Check
   operation/submission/staging bindings together.
   Recover balances through an authenticated checkpoint and wallet scan, never
   directly from the receipt matcher.
   `railgun-own-source.js` now selects exactly three proxy logs for a matched
   partial receipt at initial selection, collection and completion, preserving
   byte bounds and exact receipt/source equality. WETH transfers are checked
   from the supplied receipt, not authenticated by the proxy ledger. Re-measure
   connected-operation traffic and deadline reserves;
   an additional event does not automatically justify larger request budgets.
4. **Produce and retain the combined POI.** Update `railgun-poi-reconstruct.js`,
   `railgun-poi-witness.js`, `railgun-own-poi-proof-data.js`, and
   `railgun-poi-payload.js`. A partial proof contains one blinded change output
   **and** a nonzero unshield TXID marker; the current payload policy makes these
   exclusive. All commitments enter POI transaction binding, while output NPKs
   and values describe only shielded change. The marker equals the own TXID;
   no additional hash transformation is implied.
   Extend `railgun-poi-output-recovery.js`, `railgun-poi-output-recovery-data.js`,
   and `railgun-poi-output-recover-job.js`, together with
   disclosure planning, cold validation and submission. Partial output recovery
   needs one viewing credential; full-unshield output recovery remains keyless.
   Disclosure descriptions must include both categories and actual inventories.
   Update durable `railgun-poi-intent-store.js` records and the
   `railgun-poi-submit-data.js`/verifier normalizers coherently: the current
   payload parser is exclusive and the durable record has only a capsule digest,
   not an authenticated operation-kind discriminator. Do not infer new authority
   from a payload containing both fields or reinterpret existing attempted bytes.
5. **Creator authentication implemented; complete second spend still pending.**
   The October 5 checkpoint extends retained joins to one nullifier, two
   commitments, one ordinary output at index zero and a final unshield. It
   preserves complete event coverage, source/checkpoint equality and path checks,
   then requires the pinned-engine final-preimage hash before roots or credentials.
   Existing three-log capacity suffices. Generic pre-spend received-note support
   remains broader and now verifies its final unshield without narrowing token
   types or ordinary-output selection. Native qualification covers real local POI
   for a legacy second-operation fixture and encrypted same-parent reopening;
   it does not establish the complete real first/second-spend lifecycle.
   The second spend requires independently obtained typed Transact membership;
   generating or submitting the first POI is not evidence of list eligibility.
   That second full unshield is still a version-1 operation, but its creating
   transaction is partial. Creator support therefore cannot be gated solely on
   the current operation's capsule version.

The lower-level `railgun-private-creator.js`, `railgun-txid-events.js`, and
`railgun-txid-note-witness.js` already represent optional unshield plus ordinary
outputs. Retained collectors preserve deliberately narrower joins than generic pre-spend
provenance; changing transaction commitment counts alone does not grant authority.

The bounded expected protocol-event order is Nullified, Unshield, Transact.
The newer local contract checkout also emits Action; it is not an exact deployed
logic reference. [Existing deployment evidence](railgun-private-completion-2026-10-03.md#deployment-event-evidence)
records no Action topics in its captured pinned history. Retain explicit event
policy, reject unexpected events, and qualify actual deployment behavior before
claiming live support. Do not silently ignore Action based on the newer source.

## Durable compatibility and recovery

The structural implementation preserves version-1 canonical bytes and digest
domains. Version 2 is exclusive to `railgun-partial-unshield`, uses
`freedom:railgun:private-capsule-v2\0`, and requires explicit `inputAmount`,
`unshieldAmount` and `changeAmount` in the private preparation. Its public intent
contains the gross `unshieldAmount`, ordered `changeCommitment` and
`unshieldCommitment`; it does not disclose plaintext input/change values.
The expected signature hash retains the circuit's Poseidon public-input order;
it does not gain an application domain separator. Original encrypted calldata
is retained, without adding plaintext output randomness to the capsule.

The current mixed-store test uses real reserve, put, signing and recovery
receipts for a version-2 record beside a version-1 record, preserving legacy
bytes. Connected native Shield-input qualification also persists an actual signed
partial proof. An exact prior reservation reader refuses the entire mixed store
without changing ciphertext, floor or inventory; the current reader reopens both
entries. An older build cannot use the containing reservation store. Do not
rewrite signed records to make an older build accept them.
The public EOA journal parser and resolution validator now accept bounded
version-2 partial records. Generic encrypted-journal reopen tests cover an
unresolved synthetic partial intent, while the submission controller
still cannot create a genuine partial submission attempt. An older validator may refuse
that address's entire journal, blocking ordinary sends as well as private-operation
recovery. Accept and expose that downgrade limitation before enabling the writer.
The receipt policy ID is retained in new resolutions. Future policy revisions
must continue validating historical IDs or explicitly migrate records; changing
the current baseline alone would make existing partial resolutions unreadable.

Use explicit capsule version/domain dispatch for the new partial shape; preserve
v1 canonical bytes and digest behavior. Public journal intents and resolutions
also need explicit bounded schema handling. Capsule-store envelopes may remain
unchanged if their delegated normalization supports both versions; verify this.
Keep legacy reads/recovery and mixed legacy/new stores covered by regressions.
Derive allowed payload shape from the authenticated capsule version and kind,
never from caller payload shape or a globally relaxed exclusivity check:

| Capsule           | Blinded outputs | Unshield marker |
| ----------------- | --------------: | --------------- |
| v1 transfer       |               1 | zero            |
| v1 full unshield  |               0 | own TXID        |
| New partial shape |               1 | own TXID        |

Continue refusing zero outputs with a zero marker. Re-normalizing existing
attempted records must preserve exactly their previous bytes and digests.
Never migrate signed calldata, signatures, attempted POST bodies, operation IDs,
request/payload digests or reservations into a newly interpreted intent.

Reserve the whole original note/nullifier. Partial withdrawal does not release
the remainder of that original input; change becomes a new input only through
authenticated ingestion. Preserve uncertain-send recovery and no automatic
retry, completed-checkpoint requirements, exact destination selection, one-use
private handoffs, scope revocation, single-owner leases and child-process drain.

## Qualification and enablement gates

Run an actual pinned-engine/native two-spend fixture, with simulated chain/service
responses and disposable list trust clearly identified. Start from recovered
owned state, generate/sign/prove 01x02, independently verify, simulate one send,
ingest its exact events/TXID, restart durable state, then scan its actual encrypted
change. Produce and independently verify the combined POI_3x3 proof; exercise
retained output recovery, cold validation and one simulated POST. Supply separate
authenticated fixture membership for change, then select that exact recovered
note for a second full-unshield proof, reconciliation and retained-POI lifecycle.
The disposable list's accepted membership must bind that actual combined proof
and change output; a generic canned Valid response is not this acceptance test.
Run first-input Shield and received-Transact variants; a separately fabricated
second input does not establish change spending.

Negative controls must detect swapped commitments, foreign/wrong-value change,
conservation/rounding errors, wrong artifact/verifier, omitted unshield metadata,
zeroed marker, substituted blinded output, incomplete creator coverage, stale or
reorged checkpoints, and second-spend attempts before membership. Exercise restart
at durable boundaries, lost acknowledgments, immutable attempted bytes, refusal
without reserve release, cancellation/drain and legacy 1x1 behavior. Re-measure
source inventories and deadline reserves rather than assuming historical counts.
One change reconstruction and one POST are expected, with both disclosure
categories represented. Verify whether existing request envelopes still suffice;
do not increase them merely because the payload has both categories.
Only then expose the bounded operation through the Kohaku facade. Deployed
verifier/event confirmation, real service eligibility and a separately reviewed
funded lifecycle remain distinct gates; offline success does not establish them.
