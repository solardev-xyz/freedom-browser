# Cooperative account enrollment: native qualification

The create, cold-reopen and legacy-control cases passed on source commit [`8288b5c29f00e285c2b3015cd0d071c55781df97`](https://github.com/solardev-xyz/freedom-browser/commit/8288b5c29f00e285c2b3015cd0d071c55781df97). This exercised genuine enrollment and identity utilities using a fresh public vault fixture. It performed no wallet scans, transaction signing, proofs, relay authorization or submissions.

| Case           | Result                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create         | Created a cooperatively fenced enrollment; both same-process reopen routes refused after logical close, while the original main process remained alive.                                                               |
| Cold           | A new original main process reopened the same generation through the generic route after the previous main had closed. Both same-process competing routes again refused after logical close. |
| Legacy control | A separate legacy enrollment retained its ordinary same-process reopen behavior. It did not become cooperatively fenced or gain relay authority.                         |

All three cases refused closed-enrollment provenance. Create and cold reports retain the same generation ID; the legacy control uses a distinct generation. This sequential campaign demonstrates enrollment/restart behavior, not overlapping cross-process contention or unknown-work drainage. The earlier [standalone fence qualification](../../railgun-account-fence-qualification-2026-10-06.md) covers its separate contention and intentional-termination experiment. Its **same-process descriptor-close hazard remains relevant**: code in a holding process must not open/read/hash the live fence database inode through another descriptor.

The three original Electron main processes—14974, 14992 and 15027—exited naturally with code 0. Each ran exactly two original identity utilities (`spending-public` and `viewing-identity`): one key request, one result, two messages, and a confirmed close. All six utilities were intentionally terminated with exit code 15 after their results, without escalation or peer disconnect. Their exact 91-hook guard vectors matched the prepared configuration and recorded zero attempts. These utility exits are not natural zero exits.

The root agent observed the original driver session 91925 complete naturally with code 0 (`c8a299`). This archive's independent audit compared saved reports, process records, hashes and preparation/postcheck metadata; it did not repeat native or cryptographic execution, rehash runtime payloads, inspect implementation source, or read profiles/databases. Empty logs are retained but do not establish process identity by themselves.

## Evidence and deduplication

[RESULT.json](RESULT.json), [checks.json](checks.json), the six original process records and four logs retain their original bytes. [Create](create-report.json), [cold](cold-report.json) and [legacy](legacy-report.json) reports are explicitly **derived copies**: their repeated `sourceSha256` maps are replaced by references to [source-hashes.json](source-hashes.json). All other report fields remain unchanged, including utility closure details and peak RSS measurements.

The shared map contains all 11,671 full-inventory entries. Each report selects the same 11,665 entries by excluding six explicitly named configuration/history files. The filtered map retains the original ordering, so all three original reports reconstruct byte-for-byte. This inventory is not execution coverage. [Provenance](provenance.json) preserves original report hashes/sizes and published hashes, exact transformations, execution attribution and scope; the [index](index.json) hashes every other archive file.

The derived [config](config.json) and [POST](POST.json) also reference the shared map. Local paths are replaced with `$REPOSITORY`, `$RUN_OUTPUT`, `$RUN_EVIDENCE` and `$RUN_PREPARATION`. Their original hashes remain in provenance; these normalized files are historical evidence, not executable configuration. The saved POST record matches the prepared full source inventory, 15 source symlinks and 20 runtime/dependency inputs (17 selected SQLite files, Electron executable/framework and the engine archive). It does not assert unchanged profile contents or a complete OS dependency inventory. No fence/database/profile bytes were read by this archive audit or copied here.

The selected runtime was Electron 44.5.1, ABI 149, Darwin arm64, with the pinned engine archive and SQLite dependency. Source checks recorded 19 fixture tests, six driver tests, strict lint and formatting success. An earlier wrong-working-directory formatter attempt exited 130 and remains explicitly excluded in `checks.json`; it is not counted as a passing check.

## Rechecking the archive

Run this metadata-only verifier from any location:

```sh
python3 /absolute/archive/verify-archive.py
```

It checks the indexed files and reconstructs the exact original hashes of all three reports in memory. It never opens the paths listed in the source/runtime inventory and does not launch a native process.

A native repeat is a separate experiment requiring the committed [qualifier](https://github.com/solardev-xyz/freedom-browser/blob/8288b5c29f00e285c2b3015cd0d071c55781df97/scripts/qualify-railgun-cooperative-enrollment.js), matching binaries, a newly approved canonical absolute-path config, fresh disposable outputs, and the reviewed external original-process driver whose two source hashes are recorded in config. That driver is not distributed in this compact archive. Do not execute the normalized historical config or treat these results as account-level relay authority, rollback protection, general platform qualification, or proof of physical utility drainage under arbitrary failure.
