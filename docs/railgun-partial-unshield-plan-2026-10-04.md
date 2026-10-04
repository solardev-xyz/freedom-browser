# Bounded partial WETH unshield and change spending

**Status: proposal; unimplemented and unqualified.** This plan comes from reading
the current production modules and local upstream source/artifacts on 2026-10-04.
It is not evidence of a deployed contract accepting this flow, a successful
proof, a funded transaction, or live POI-service eligibility.

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

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `01x02.wasm` | 3007613 | `6ce87ddb4e33cff9564338a8b1f58047b22809e5d198f243c777d1aa4eaaa1e3` |
| `01x02.zkey` | 6121318 | `8ef8e7abcfb5e60fb593d4d961657465f498435a0835adef05acc09534d7557b` |
| `01x02.vkey` | 3256 | `9369fa6ad3d7a1becf4b10cf4bd6a7eb83725cfb5cf75a08b191c5bc2cd479f4` |

The VKey declares five public inputs. Engine source gives their expected order:
root, bound-parameters hash, nullifier, change commitment, unshield commitment.
This verifies local availability,
not proving success or the deployed verifier. POI_3x3 is already pinned and has
sufficient output capacity; the combined POI shape still needs native proving.
No new dependency or artifact is expected from this source inspection.

## Implementation stages

All module names below refer to `src/main/wallet/`; keep the new capability
unavailable until the connected qualification passes, including the second spend.

1. **Define and bind the bounded model.** Evolve `railgun-private-preparation.js`,
   `railgun-private-selection.js`, `railgun-private-policy.js`, and
   `railgun-private-capsule.js` together with `railgun-transact-intent.js` and
   `railgun-transact-resolution.js`. Derive the exact output shape and artifact
   variant from validated intent. Selection currently equates unshield amount
   with input value and declares `inputValueVerified`; preserve separate evidence
   for recovered V and private output conservation. Reject all other shapes.
2. **Prepare, sign, prove and reconstruct the exact intent.** Update
   `railgun-private-witness.js`, `railgun-private-reconstruct.js`,
   `railgun-private-prover.js`, `railgun-private-verify-job.js`, and
   `railgun-spend-sign-job.js`. The signer must check the final unshield commitment
   and sign all five ordered public inputs. `railgun-private-preflight.js` must
   select 01x02 and match anchored `getVerificationKey(1, 2)` before nullifier
   disclosure/signing. Preserve the one-use key/signature and utility boundaries.
   Recovery decrypts persisted change and reconstructs the original calldata,
   conservation and signature message; it never creates fresh output randomness.
3. **Recover both outcomes and their TXID.** Extend `railgun-transact-receipt.js`,
   `railgun-transact-resolution.js`, `railgun-own-selector.js`,
   `railgun-own-selector-job.js`, `railgun-own-txid.js`, and
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
5. **Admit change as a supported creator, then spend it.** Current retained
   received-Transact joins require a creator with one commitment and no unshield.
   Extend `railgun-poi-creator.js`, `railgun-own-witness.js`,
   `railgun-own-poi-proof.js`, `railgun-own-poi-checks.js`, and output-recovery
   joins to the exact additional creator shape: one nullifier, two commitments,
   one ordinary output at index zero, and the final unshield commitment. Keep
   complete creator-event coverage, zero known omissions, source/checkpoint
   equality and path verification before keys or current-root requests. The
   creating Transact log still contains one ordinary output; the group adds an
   Unshield log. Recompute the group-size bound without widening the individual
   Transact-log policy unnecessarily.
   The second spend requires independently obtained typed Transact membership;
   generating or submitting the first POI is not evidence of list eligibility.

The lower-level `railgun-private-creator.js`, `railgun-txid-events.js`, and
`railgun-txid-note-witness.js` already represent optional unshield plus ordinary
outputs. Retained collectors currently impose narrower joins; simply relaxing
the transaction commitment count would strand change at those joins.

The bounded expected protocol-event order is Nullified, Unshield, Transact.
The newer local contract checkout also emits Action; it is not an exact deployed
logic reference. [Existing deployment evidence](railgun-private-completion-2026-10-03.md#deployment-event-evidence)
records no Action topics in its captured pinned history. Retain explicit event
policy, reject unexpected events, and qualify actual deployment behavior before
claiming live support. Do not silently ignore Action based on the newer source.

## Durable compatibility and recovery

Use explicit capsule version/domain dispatch for the new partial shape; preserve
v1 canonical bytes and digest behavior. Public journal intents and resolutions
also need explicit bounded schema handling. Capsule-store envelopes may remain
unchanged if their delegated normalization supports both versions; verify this.
Keep legacy reads/recovery and mixed legacy/new stores covered by regressions.
Derive allowed payload shape from the authenticated capsule version and kind,
never from caller payload shape or a globally relaxed exclusivity check:

| Capsule | Blinded outputs | Unshield marker |
| --- | ---: | --- |
| v1 transfer | 1 | zero |
| v1 full unshield | 0 | own TXID |
| New partial shape | 1 | own TXID |

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
