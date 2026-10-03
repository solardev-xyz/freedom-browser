# Private transaction intent and input binding — October 3, 2026

Main now validates a deliberately narrow Railgun transaction shape and binds it
to a genuine recovered input. These are preparation checks, not a signing or
spending interface. No new signer, reservation store, broadcast path or product
IPC is enabled by this change.

## Public transaction policy

The initial shape is one input and one output: a private transfer or a full-value
WETH unshield on Sepolia. Calls target the pinned proxy with zero native value,
one transaction, zero minimum gas price, no adapter and no redirect/override.
Main round-trips canonical calldata and matches the tree, UTXO root, nullifier,
output commitment and bound-parameter hash. Transfer ciphertext count must be
one; an unshield has no private output ciphertext. The unshield preimage must
name the requested nonzero recipient, WETH, sub-ID zero and exact bounded gross
amount. The recipient receives that amount minus the contract's 25 bps unshield
fee; later reconciliation must check both the net amount and the fee.
This withdraws WETH; native unwrapping is not implemented here.

The deployed contract and the SDK's ABI declare `uint72`, so the selector uses
`uint72`. The SDK's own bound-parameter hash encodes `uint48`; ABI padding makes
both hashes identical for values below 2^48, and our zero-only rule is stricter
still. The host computes the contract-form hash independently with the
application's ethers. This compatibility check does not justify accepting higher
or arbitrary gas-price values.

The policy returns `proofVerified`, `recipientVerified`, `reservationsChecked`
and `spendingEnabled` as false. Dummy proof bytes can pass structural checks;
proof verification is a separate required gate. A private transfer's destination
and value cannot be inferred from its public commitment alone.

## Genuine input selection

The wallet's validated-record loop already derives each note's nullifier and
compares it with both the SDK cache and public spent mapping. It now passes that
derived value explicitly into the internal owned-note projection, which checks
the cached value again. Main validates the projection's field encoding. This
nullifier never enters Kohaku reads, operational reports or POI requests: exposing
an unspent note's nullifier would reveal its later spend.

The scan receipt also retains immutable copies of the captured public tree
roots. `readOwned` exposes those only through the genuine account registration.
A selection requires the same wallet, identity, enrollment and coordinator, an
unspent positive WETH note within the qualification cap, and matching note and
projection identities. Preparation then binds the calldata's nullifier, tree
and root to that selection. Full-value unshield amount must equal the recovered
note amount. Transfer value conservation and receiver recovery remain private
witness checks.

The selection issues opaque diagnostic receipts. Changed checkpoints, replaced
note/projection/tree objects, closure and owner revocation invalidate them. They
have no independent time limit while the captured snapshot remains current; a
future operation must add its own fresh POI, deployment, root and unspent checks.
Receipts contain prepared calldata and a not-yet-public nullifier internally and
must not be logged. `creatingTxidRequired` explicitly distinguishes Transact
inputs from Shield inputs; `creatingTxidVerified` remains false.

## Qualification and limits

[The engine differential](qualification/railgun-private-policy-2026-10-03.json)
uses integrity-checked SDK code, synthetic notes and viewing material in Node.
It constructs a real engine self-transfer and full-value WETH unshield, serializes
dummy proofs through the official ABI and validates both with the host policy.
The synthetic spending key is wiped after public-key derivation, before
preparation; preparation receives only that public key. No signature or actual
proof is generated.

The differential also decrypts the self-transfer output with the fixture viewing
key, checks token, amount and recomputed commitment, rejects corrupted ciphertext,
and recomputes the unshield commitment independently. Wrong-chain calldata is
refused in both cases. Its expected public fields come from the same SDK request,
so this qualifies encoding compatibility, not independent owned intent. It is not
guarded Electron evidence. An intermediate receive check failed because the
fixture implemented `getTokenData` instead of `getTokenDataFromHash`; the corrected
stub checks the requested token hash exactly.

The input-selection wrapper has unit coverage for foreign owners, incorrect
nullifiers/roots/amounts, unavailable or spent notes, lifetime changes and the
separate creating-TXID gate. [Sixteen synthetic enrolled Electron recovery cases](qualification/railgun-private-input-wallet-2026-10-03.json)
requalify the changed projection and captured roots; it does not call the new private
selection wrapper or prove a funded operation. The wallet policy changes and
requires a retained wallet-generation rebuild. Public-history and TXID policies
remain unchanged by this slice. The [live retained wallet rebuild](qualification/railgun-private-input-live-refresh-2026-10-03.json)
completed at block 11,834,513 and recovered one asset, with all 4,230 mirrored
rows still covered. It sends no owned-note POI request and does not exercise the
private-selection wrapper. The [public projection vector](qualification/railgun-owned-nullifier-projection-vector-2026-10-03.json)
still matches the signed event; its placeholder nullifier is explicitly not
qualification of the real public note’s nullifier.

The final native regression passes 8,441 tests (33 skipped), and lint passes.
Claude reviewed the implementation, source-bound reports and scope distinctions.

## Next composition

Keep private witness material in a guarded prepare/prove process with viewing
credentials. Use the SDK's external-signer seam for a separate one-use spending
signature process that recomputes the public-input message and unshield commitment.
Main must bind genuine selection, receiver checks, required-list POI and applicable
creating-TXID evidence, reserve the input durably, verify returned proofs in a
separate witness-free process, and revalidate current deployment/verifier/root/
unspent evidence before EOA signing and journaled submission. Fresh observations
must be acquired around long proving work rather than assuming an earlier
60-second receipt survives it.

Reservations must remain recoverable across crashes and uncertain handoff; an
absent response is not evidence that an operation cannot execute. Post-inclusion
TXID membership, event reconciliation, post-transaction POI and cold output
recovery remain required for transfer/unshield completion. None of those gates
is replaced by the preparation receipts introduced here.
