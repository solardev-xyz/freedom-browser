# Restored-wallet recovery capsule handoff — October 3, 2026

Every private operation now checks its recovery representation before asking main
to authorize the intent. The guarded preparing utility loads the prover, prepares
the selected input, builds a version-one capsule and reconstructs its witness from
that capsule using the actual restored viewing wallet. Reconstructed private and
public inputs must equal the original inputs. The utility then offers the public
preparation and capsule together and, if signed, proves from the reconstructed
witness. An encoding error therefore refuses before any signing authorization.

Main accepts one bounded, exact-shape offer. It reconstructs the expected capsule
metadata from its own wallet ID, selection, normalized preparation and current
engine hash, then compares the full capsule. The account wrapper additionally
matches the note hash to the captured owned record. The operation handler receives
the immutable capsule as its fourth argument, alongside the existing genuine
window token. No witness secrets cross this handoff and no key permission is added.

New capsules must record the running engine. Historical reconstruction retains
the separate versioned normalizer, where an old engine hash is provenance rather
than a validity condition. Historical-root recovery needs its own constrained
controller; the current operation path still requires the current captured root.

## Evidence

[The actual Electron report](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-capsule-handoff-2026-10-03.json)
records 86 matching source hashes and the existing 19 enrolled recovery runs.
Its restored viewing wallet offers both a self-transfer and unshield after the
self-reconstruction check. Refusal returns normally without a signature; both
approved synthetic cases prove from reconstructed witnesses and pass verification
in a fresh process. The transfer also passes independent receiver verification.
This uses a disposable vault, public test mnemonic and archived synthetic notes.
It makes no live acquisition, POI request or funded transaction.

All 110 focused checks pass. They include private/public witness mismatches before
offering, real broker normalizers rejecting foreign wallet and malformed envelope
data, and a real account normalizer rejecting a note hash that passed the broker's
structural checks but differs from the owned record. Internal errors remain
sanitized at the account boundary. The full regression passes 8,813 tests / 33
skipped across 422 passing suites. Lint is clean; Claude reviewed the code,
boundary tests and qualification evidence.

The wallet policy closure now includes 30 modules, including capsule validation
and reconstruction. Existing live wallet caches must be rebuilt under the final
policy; the funded account has not yet been rebuilt for this change. Public and
TXID policy are unaffected. Keep the remaining closure changes together before
that live rebuild.

## Remaining composition

The handler still needs fresh recipient/POI/TXID/private-preflight gates, the
durable capsule/hold transition, a one-use operation-bound vault key handoff,
signature persistence before proving, independent proof verification, and the EOA
journal/submission/reconciliation path. The primitives and synthetic proofs do not
complete that production controller. Funded transfer/unshield and post-transaction
POI remain unfinished.
