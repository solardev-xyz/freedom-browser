# Checkpoint quorum qualification — 2026-09-15

Actual Electron 44.3.0 / Node 24.20.0 on macOS arm64, real Myotis addon and Colibri WASM, public checkpoint/proof services and native peers. No mocks in the live manager or ASAR campaign. Isolated temporary profiles only.

The unchanged [manager harness](../myotis-recovery-integration-2026-09/review-fixed/electron-main.js) uses authentic old v0.1.7 roots with synthetic persisted verification metadata (no snapshot) to trigger native STALE_ANCHOR. Each chain must replace the generation, pass a verified public zero-address account read, confirm native exit, restart the same new generation and pass a second verified read. Active/unknown owner controls must refuse startup. Result JSON includes all events, successful qualification, native verification flags and confirmed final stops.

- Ethereum: successful recovery/read, stop/restart/read in 54.8 seconds.
- Gnosis: two temporary quorum-unavailable attempts, then automatic recovery; successful stop/restart/read in 98.7 seconds. The initial unavailable responses were not captured, so their specific cause is not established.
- Neither run produced a committee snapshot; restart reboots from the stored authenticated checkpoint, not a demonstrated snapshot resume.
- `asar-results.jsonl`: actual workers loaded from an archive created with the existing [ASAR preparation harness](../myotis-recovery-integration-2026-09/asar/prepare.js); both chains return schema-v2 records containing sufficient distinct voter origins.
- The four PNGs show quorum-unavailable and quorum-conflict messages for both chains in dark/light test-harness UI, with Retry visible. Existing before-change images are in [the recovery UI audit](../../images/myotis-recovery/). UI is mocked for reproducible failure states; the native campaign is not.
- `source-hashes.json` identifies the production sources and manager harness used. Later test-only edits do not change those hashes.

This demonstrates successful public-network recovery on this Mac, plus deterministic negative-policy tests. It does not qualify Windows/Linux native runs, signed distributions, long-duration operation, independent operator ownership, or resistance to every coordinated authority/prover compromise.

Unit checks: 211/211 focused tests pass; full suite 4,517 passed, 13 skipped, three known unrelated settings/Safe failures. Lint and diff checks pass. Broader theme parity: 6 passed, two chrome walks fail on the existing Radicle contrast baseline and macOS Control+f recipe; 12 Linux screenshot baseline cases skipped on macOS.
