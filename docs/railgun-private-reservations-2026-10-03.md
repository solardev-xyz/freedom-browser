# Durable Railgun input reservations — October 3, 2026

Railgun enrollment now owns a separate encrypted reservation store in the
account directory. It survives wallet and public cache replacement. The key
uses the account-level `private-reservations` purpose, stays inside enrollment
composition and is wiped after storage copies it. The existing authenticated
profile inventory covers the new file.

Each entry permanently holds a `(tree, nullifier)` pair and records the input's
position/hash, operation kind, zero-proof intent digest, checkpoint hash and POI
observation digest. The store validates these facts structurally; it does not
authenticate ownership, POI eligibility or signing authority. Those checks belong
to the private-operation composition before it reserves an input. No note
preimage, proof, signature, calldata or raw POI response is stored.
Unspent nullifiers can link these notes to their later spends. Keep reservation
contents out of logs, qualification reports and plaintext exports.

Reservation uses a synchronous encrypted read/check/append, then advances a
sequence floor in a separate record of the enrollment manifest and reads the
reservation back before returning an opaque receipt. Duplicate inputs and the
512-entry lifetime capacity refuse without dropping entries. Other integrity or
persistence failures close the store. Receipts belong to one live instance and
require another authenticated read before use; they do not authorize signing.
The public inspection result contains only the number of held entries.

The file is written before the manifest floor. A crash between writes leaves the
file ahead; reopen authenticates it and repairs the floor. A missing initialized
file or a reservation file behind the manifest refuses. Opening rotates the
instance lease and writes the floor, including when opening just to inspect.
Legacy accounts migrate lazily when this store is first opened. Coordinated
rollback of the manifest, inventory and reservation file remains undetectable;
this is not whole-profile rollback protection.

## Evidence and limits

[Eighteen enrolled Electron cases](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-private-reservations-2026-10-03.json)
include an explicitly synthetic reservation that survives enrollment reopen and
wallet/public generation replacement. The duplicate stays refused, old receipts
stay invalid and the stored hold count stays one. The existing six account
restoration windows and interrupted-window cold recovery also pass. All 62
source hashes match the qualified tree. Reports contain no private projection
or reservation input facts.

The 41 reservation/enrollment tests cover atomic contention, tree scoping,
capacity, malformed facts, encryption, receipt forgery, cancellation, file
corruption, missing state, reservation-only rollback and failure between the two
durable writes. Claude reviewed the store and enrollment composition.
The full native regression passes 8,565 tests (33 skipped), and lint is clean.

There is deliberately no release or pruning API. A failed attempt after reserving
leaves the input held, including across restart; the cap is a lifetime limit for
this qualification implementation. Before a funded private attempt, add reviewed
recovery or explicitly account for this restriction. No live note is reserved by
this qualification. Signing, transaction-journal linkage and proof/submission
composition remain next. Expected duplicate/capacity refusals must become result
values inside the account's exclusive window so they do not close its coordinator.
