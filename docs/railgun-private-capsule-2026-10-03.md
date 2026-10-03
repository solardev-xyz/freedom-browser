# Railgun exact-intent reconstruction — October 3, 2026

A private operation must remain recoverable if its preparing utility exits after
the spending signature is produced but before the proof or submission journal is
saved. Preparing again creates new output randomness and ciphertext, so it does
not reproduce the signed intent. Releasing that input for a different transaction
would also be unsafe: absence from our journal does not prove that an earlier
proof cannot still be submitted.

The new version-one recovery capsule records the original zero-proof calldata,
expected public inputs, account identity, selected note hash and original Merkle
path. It contains no spending/viewing key or witness secrets. These fields still
link the account to an operation and belong in authenticated account storage,
never public reports. The original engine hash records provenance; upgrading the
authenticated runtime does not alone invalidate a capsule.

The utility reconstructs the input secrets from the viewing wallet and, for the
supported self-transfer, the output from the original ciphertext. It checks the
account master public key, note public key/hash, unspent note/value, nullifier,
original Merkle path, recipient, output commitment, bound parameters and signing
message. It never creates or encrypts another output. The existing prover verifies
the supplied signature before proving; a separate process verifies the resulting
proof. This code stays in the main wallet subsystem's guarded utilities, with no
renderer API, new dependency or package boundary.

## Qualification

[The retained report](qualification/railgun-private-capsule-2026-10-03.json)
records 26 source hashes, six actual proofs and no network requests. The ordinary
transfer and unshield runs compare reconstructed private inputs to the original
SDK request. Four cold runs use note position 10,245 to exercise nonzero Merkle-path indices.
They persist the capsule with or without its signature, terminate the original
preparer before it proves, then reopen the encrypted store in the host using a
fixed synthetic storage key. A fresh utility receives the recovered values and
constructs a synthetic wallet/scan stub (including a fixed nullifying key). Both
stored-signature cases need no additional spending key; both missing-signature
cases ask the separate signer to re-sign the original message and verify exact
deterministic signature equality. All four preserve the public intent and Railgun
transaction ID and pass independent proof verification.

Twelve transfer and eleven unshield negative controls reject changed account/note,
path, spent status, amount, public hashes, message, output or facade inputs. Transfer
controls include corrupted ciphertext and actual ciphertext for a foreign recipient.
A consistently retargeted unshield reconstructs but its original signature is
refused before proving. Eight spies remain installed throughout reconstruction
and proving to forbid new note/sender randomness, output encryption or request
generation. Bound-hash and mismatched unshield-recipient controls are structural
refusals; the stored signature and eventual hold/capsule binding protect against
consistent changes. All test keys and notes are synthetic public fixtures.

The full regression suite passed 8,767 tests (33 skipped); lint is clean. That
regression ran before the final fixture-only controls were strengthened; the
production reconstruction modules are unchanged and the final Electron run covers
the updated fixtures.

## Scope and remaining composition

This qualifies cryptographic reconstruction and utility-process interruption. It
does **not** qualify a production account recovery controller, reservation lifecycle,
funded private operation or application-wide crash. The fixture saves its checkpoint
after its synthetic signer runs; production must save and authenticate the capsule
**before** the durable signing transition and key handoff.

Next, the account store must bind the capsule digest and exact intent to the held
input, save a returned signature, and retain signed holds without automatic release.
Recovery must refresh on-chain nullifier status: an old viewing scan is insufficient.
An already-spent input requires exact transaction reconciliation; an unspent input
can resume only the original intent under fresh operation gates. The same transaction
ID is necessary evidence, not permission to bypass those checks. Durable EOA
submission/recovery and post-transaction POI composition remain required before the
funded transfer and unshield runs.
