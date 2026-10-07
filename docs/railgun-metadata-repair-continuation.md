# Railgun test-profile metadata repair

The first live recovered submission stopped at `history` without a journaled
send. An offline reproduction traced that refusal to the public wallet-0 record:
the disposable-profile creator wrote the encrypted vault but omitted
`identity/vault-meta.json`. Production recovery requires that public record to
bind the submitter before disclosure. The funded profile's missing file must
still be confirmed by the repair's checks; the earlier warm-path preflight
failure has a separate, unknown cause.

The profile creator now supplies the metadata for new disposable profiles.
Production's metadata requirement remains intact. The history diagnostic names
the failed sub-step, and the qualifier checks metadata before reserving recovery.

## Repair

`scripts/write-railgun-submitter-metadata.js` runs under Electron. It validates
the operator arguments and disposable marker before reserving its evidence
directory, then acquires the profile lock and unlocks through OS safeStorage.
The existing vault derives the public addresses locally. The index-0 address
must match both the signer and the explicit expected address.

The tool never recreates a vault or overwrites metadata. Only ENOENT admits an
exclusive create; links, malformed metadata and conflicting records refuse.
The file keeps the vault's recorded creation date and sets
`userKnowsPassword: false` for the generated, OS-protected password. File and
directory entries are synced, and production reads the new wallet-0 binding.

A durable pending record precedes profile work. The final aggregate report
records whether creation occurred, including on a later refusal. An interrupted
or unsuccessful repair is not retried automatically. A partial new-profile
creation is likewise retained for diagnosis, not replaced.

Preservation covers the recursive identity directory except the new metadata.
Electron userData and profile-lock side effects outside that directory are not
measured. Mode 0600 is deliberately stricter than the application's default.
An existing matching file gets only a wallet-0 binding check, not full-record
certification, and does not qualify as a successful repair for the continuation.

## One fixed continuation

`recover-submit` may append the literal `metadata-repair-1`. This opens no
general campaign facility. The original consumed ledger remains byte-identical;
the continuation has one exclusive, fixed ledger filename independent of probe,
output path or source commit.

Admission binds the original failed recovery report, consumed ledger, held
operation, verified repair report, current metadata bytes, corrected source
baseline, and fresh probe/scan. The original hold digest must match again before
EOA checks. A pending, finished or torn continuation consumes the allowance.
Changing commits cannot create another allowance. The original invocation still
refuses its already-consumed ledger.

The operator plan retains at most three probes spaced by 30 minutes, one
recovery attempt, then the original POI/restart/status/unshield sequence. Across
the journey: at most two sends, 0.002 Sepolia ETH per send and 0.004 ETH total;
no resend, replacement, new deposit or live foreign-recipient transfer. An
uncertain send permits observation only.

## Validation and limits

The affected eight suites pass 576 tests, including the genuine proved-unsent
hold reproducer, repaired metadata, refusal after a write, durable evidence,
continuation bindings and the real qualifier's exclusive reservation.
Lint and formatting pass.

A separate unfunded Electron rehearsal verified safeStorage unlock, profile
locking, address derivation, metadata creation and production readback. Its first
harness attempt accidentally invoked the entrypoint twice and stopped at
`ELOCKED`; its pending evidence was preserved separately. A fresh-profile
rehearsal with corrected invocation passed. Neither rehearsal selected the
funded profile or contacted Railgun services. This evidence does not establish
successful live recovery, POI acceptance or unshielding.
