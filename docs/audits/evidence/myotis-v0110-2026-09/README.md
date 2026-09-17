# Official Myotis v0.1.10 qualification — 2026-09-16

This campaign uses **unmodified official v0.1.10 / ABI 26 addons**, with the
five platform hashes and release checksum-manifest hash pinned in
`scripts/myotis-release.json`. The downstream checkpoint patch, Rust builder,
source pin, build sidecar requirement, and patch-only line-ending rule have
been removed. Checkpoint quorum and required Colibri proof verification are
unchanged. Upstream PR #442 is merged; the released addon also fixes both
reported symlink guard cases.

## Live results

Actual Electron 44.3.0 / Node 24.20.0 on macOS ARM64, production Freedom manager,
process supervisor, native addon and disposable Colibri WASM workers. No module
or network-response replacement. The initial fixture uses an authentic historic
v0.1.7 root/slot with **synthetic persisted verification metadata**, no snapshot,
and the ABI 26 generation format, solely to force the stale-anchor path. It is
not a claim that that historical checkpoint was authenticated in this run.

| Chain | Result | Full recovery/read/stop/restart/read/stop |
| --- | --- | --- |
| Ethereum | Pass | 84.9 seconds; read deadlines retried before success |
| Gnosis | Pass | 17.6 seconds |

Both chains acquired fresh schema-v2 quorum checkpoints, passed Colibri proof
verification, created a new native generation, and returned account results with
`beaconChainVerified`, `blsVerified`, and `peerProofValid` all true. The native
`sync-anchor[-gnosis].json` exactly matched the host-authenticated root/slot.
Both restarted the same new generation, returned another verified read, and
ended with confirmed native exit receipts. Four active/unknown ownership
controls refused startup without rewriting their records. Detailed events and
official addon SHA-256 are in `mainnet-result.json` and `gnosis-result.json`.

No committee snapshot was produced during these short runs: restart qualified
checkpoint rebootstrap, not restoration of a real persisted committee snapshot.
No transactions or signing were performed. This does not qualify Linux/Windows
live networking, signed full packages, application-menu Quit, or long-duration
sync. Earlier patched-addon campaigns remain historical evidence only.

## Additional checks

- All five downloaded addon files match the committed release hashes.
- Actual official ARM64 addon: ABI, constructor, same-anchor restart, foreign
  snapshot and changed-anchor refusal, malformed input, live handle ownership,
  symlink alias and dangling-marker cases pass (`native-guards.json`).
- Actual ASAR-loaded Colibri workers: Ethereum passed on the first attempt;
  Gnosis returned `CHECKPOINT_QUORUM_UNAVAILABLE`. A second attempt passed both.
  Both logs are retained; the first failure's specific source/cause was not
  captured. The quorum threshold was never reduced.
- 339 focused tests including migration, checkpoint verifier/store, lifecycle,
  downloader, packaging and licenses pass. Lint and diff checks pass.
- Full unit suite: 4,523 passed, 13 skipped, the same three previously identified
  failures in macOS shortcut remaps (two) and the Safe fork expectation (one).
- Upstream v0.1.10 NOTICE was re-read and matches the existing attribution.

## Migration and failure behavior

Old patched ABI 25 verified generations lack the official native marker
contract. After validating their record and retired ownership, Freedom retains
those directories unchanged and starts a fresh bundled generation. If that
anchor is stale, normal quorum plus Colibri recovery runs. No snapshot is copied
and no marker is fabricated to authorize an old snapshot. ABI 26 generations
resume normally. Invalid/mismatched markers and native `-3 ANCHOR_MISMATCH` are
storage failures that pause recovery with the existing user guidance and Retry;
there is no fallback to another trust anchor or automatic risk acceptance.

## Reproduction

From the repository root, install the pinned addons with `npm run myotis:download`
and build the local supervisor with `npm run myotis:build-supervisor -- arm64`.
Run the actual Electron executable with:

```
docs/audits/evidence/myotis-v0110-2026-09/electron-main.js <absolute-repo> <new-empty-run-dir> <1-or-100> 600
```

The harness requires a new disposable directory for each run and records
`result.json`. The final harness explicitly requires all three proof flags;
the retained result files were also checked for all three on both reads.

Constructor-only guard reproduction (macOS/Linux symlink support required):

```
node docs/audits/evidence/myotis-v0110-2026-09/constructor-check.cjs <absolute-official-addon> [output.json]
```

ASAR preparation uses the existing
`docs/audits/evidence/myotis-recovery-integration-2026-09/asar/prepare.js`; execute
its generated `main.cjs` with Electron. Relevant product and harness hashes are
recorded in `source-hashes.json`.
