# Privacy branch synchronization with main b0fa12ac - October 5, 2026

Main `b0fa12ac554695bdfac2978dc5b5c6e24a88808b` is merged as
`ae62f4fc1b81a1975037b9e93bc5584ac74d00c4`, after the public-facade cold-credit
milestone `7baac5e567d8a518a59c28ee4fb95e659deb400d`. The merge brings Ant 0.5.59
and upstream wallet-scan progress/stall handling. It required no manual conflict
resolution. The branch-specific bundled-node synchronization instructions remain.
The [validation record](qualification/privacy-main-sync-b0fa12ac-2026-10-05.json)
records hashes, checks and evidence limits.

## Installed nodes

Merging the source did not install binaries. The Ant, IPFS, Radicle and Myotis
download commands were run explicitly after the merge, followed by the Myotis
supervisor build and binary-presence check.

| Component | Installed pin and check                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Ant       | 0.5.59; all downloader targets, including the Windows ARM64 emulation copy; host version checked                             |
| IPFS      | 0.4.5; host packaged and development addons; actual async start/health/stats/stop under denial of all networking             |
| Radicle   | 0.7.1; host addon; all 30 required exports and stopped-node status checked                                                   |
| Myotis    | 0.1.12; all five release targets; supervisor rebuilt and host ABI 32 checkpoint constructor checks passed without networking |
| Arti      | 2.6.0; unchanged pin and matching installed version, so no recompilation                                                     |

Only the Ant fetch pin changed. Package and lockfile bytes did not change, so
`npm ci` was not needed. Adblock requirements were unchanged. The refresh follows
main's reviewed pins rather than selecting unrelated newer upstream versions.

The IPFS check uses the shipped production wrapper and the previously reviewed
scratch smoke runner, whose only changes are its absolute import and retention of
disposable data. The run disables live retrieval and issue-102 fanout and executes
under `sandbox-exec` with `(version 1)(allow default)(deny network*)`. Both live
results are null. No addon inode replacement or re-signing was needed for this
refresh. This is a local lifecycle check, not connectivity or packaged-app evidence.

## Validation

All 381 affected unit tests pass across 11 suites in 3.034 seconds, including the
Ant downloader, manager/bridge/wallet-scan/publish setup, renderer readiness and
style checks, license/architecture checks and real-Ant identity migration tests.
Full lint passes. Seven fake-node Electron publish-setup cases pass in 16.5 seconds:
progress, found/empty storage, retries/stalls, card navigation, the older-node
fallback and a new wallet. These exercise the merged main service and renderer
against harness services, not a live Swarm node.

The UI test captured 14 screenshots across both themes. Root visually checked four
representative captures: the stalled-scan plan warning and scanning node card,
each in dark and light. Text and controls are readable and contained. No privacy
UI was added. This is not a full visual tour, a Linux screenshot-baseline refresh
or a packaged release test. Screenshots and disposable test data remain local.
All original command sessions completed with exit zero and were observed/drained.

## Relationship to Railgun evidence

The six cold-credit reports remain pinned to `7baac5e5`; they were not rerun or
relabeled after the merge. Fourteen entries of their broader 5,795-path freeze
changed (including two removed Ant rediscovery files). Eleven also appear in the
5,545-path native report inventory. The two new wallet-scan source/test files are
new main paths, not members of the historical inventory. All 454 recorded
`src/main/wallet/` paths and the 15 cold fixture/test/qualifier paths are unchanged.
The ten pinned external inputs are unchanged. File counts describe byte
inventories, not executed coverage or proof that shared-module changes are inert.

The prior full production regression keeps its original source scope. This merge
adds affected unit, native-addon and fake-node UI checks, not a new full Railgun
native campaign or live funded-profile qualification. The next read-data extraction
will rotate the source-derived wallet policy and needs separately qualified fresh
wallet generations. Existing funded profiles were not opened or rebuilt.
