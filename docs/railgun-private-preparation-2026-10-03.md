# Viewing-only Railgun private preparation — October 3, 2026

An enrolled account can now construct diagnostic 1×1 self-transfer and full-value
WETH-unshield intents from its recovered notes. The unshield value is gross;
the recipient would receive it less the protocol fee. Preparation runs in a dedicated
utility with one viewing-key transfer, an exact supervisor filename/purpose
allowlist and read-only wallet/public storage. It receives no spending key,
POI service or reservation capability.

The utility repeats full wallet restoration, selects the exact recovered TXO,
checks that it is unspent WETH within the qualification cap and verifies its
16-level Merkle path against the captured root. A minimal wallet interface gives
the SDK only the spending public key. It builds zero-proof calldata, checks the
derived nullifier against the recovered projection, recomputes unshield output
commitment, and decrypts self-transfer ciphertext to check its value, token and
commitment. No proving artifacts are loaded.

Main repeats the strict calldata policy and binds tree, root, nullifier, amount
and recipient to the selection. The account compares the newly restored owned
projection, trees and received notes to its capture, re-attests the journal, then
atomically replaces the current view. Unsupported requests refuse before the
window; restoration or integrity failures require cold account/public recovery.
Returned read-only diagnostics must show zero attempted writes.

These results contain sensitive future nullifiers and ciphertexts. They remain
internal and must not appear in logs or reports. They are data, not signing
receipts. `witnessRetained`, `recipientVerified`, `reservationsChecked`,
`poiVerified` and `spendingEnabled` are all false. The unsigned witness dies with
the utility; a future signing operation must prepare again and keep preparation,
reservation, separate signing and proving inside one operation window. The local
transfer decryption runs in the preparer itself; an independent receive check is
still required before main grants recipient verification.

The wallet policy now covers the new entry, witness/preparation modules, intent
policy and deployment pins. Its closure test walks 22 modules. This deliberately
changes the derived wallet policy and requires a retained cache rebuild; public
and TXID policies remain unchanged. Main retains account orchestration and
authority, with no renderer, IPC or product UX changes.

## Qualification

The [synthetic enrolled WETH qualification](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-private-preparation-2026-10-03.json)
exercises six preparation windows: both operation kinds over the fixture's
receive, spent and self-transfer history. Every window uses one viewing-key transfer, attempts zero
writes, preserves the owned projection and replaces the view while rejecting its
predecessor. Existing account-window, interrupted recovery, generation replacement
and reservation persistence cases run alongside these preparations. Source-bound
reports contain only aggregate assertions, timings and operation kinds.

Targeted tests cover wrong input/root/nullifier/value/recipient, nonzero proof
placeholders, excessive signing-message fields, leaked witness fields, supervisor
key-purpose cross-pairing, captured-state changes and pre-window request refusal.
The prepare entry explicitly returns only public preparation and refuses writable
restoration. Claude's review found a policy-closure gap, which was fixed before
rebuilding the live wallet. The full native regression passes 8,593 tests (33
skipped); three subsequently added entry-boundary tests pass separately. All 131
focused checks and lint pass.

The [live Sepolia qualification](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-private-preparation-live-2026-10-03.json)
passes at block 11,834,513 after rebuilding the retained wallet cache. It recovers
one asset over 10,246 public commitments and retains coverage of all 4,230 mirrored
TXID rows. Two restoration windows take 3,844 and 3,356 ms. Local self-transfer and
unshield preparation from the funded note take 3,539 and 3,431 ms, respectively,
including RPC header refreshes and journal re-attestation. Both show unchanged
owned projections, replacement views, rejected old views and zero write attempts.
All 86 source hashes match. Calldata and future nullifiers remain in memory and
out of the report. No owned-note POI request, reservation, signature, proof or
submission is performed. Transport remains managed Tor through one unverified
RPC provider, with circuit isolation unqualified.

## Next

No private transaction has been proved, signed or submitted through this account
method. Fresh owned-note POI, creating-TXID evidence for Transact inputs, independent
recipient verification, operation-bound spending-key release, conservative
reservation recovery, proving and transaction-journal linkage remain necessary
for funded private transfer/unshield. These diagnostics do not bypass those gates.
