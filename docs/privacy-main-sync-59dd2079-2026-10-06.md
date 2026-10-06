# Main synchronization — October 6, 2026

Merge `f5816374` incorporates main `59dd2079` after the exact Railgun review
qualification archive at `b5f3b5af`. It brings in node settings autosave, network
source descriptions and update progress. Independent source review cleared the
automatic merges and retained privacy/runtime restrictions. Package and lockfile
bytes, node pins and adblock requirements did not change.

The node installations were explicitly refreshed: Ant 0.5.59 across downloader
targets, freedom-ipfs 0.4.5 and Radicle 0.7.1 on the host, and Myotis 0.1.12 across
five targets. Myotis passed its ABI 32 constructor checks and its local supervisor
was rebuilt. Radicle loaded all 30 required exports; IPFS reported 0.4.5 and
exposed the four required asynchronous lifecycle exports. These were load checks,
not network-node lifecycle tests. `check-binaries` passed on macOS ARM64.

The Arti build command refused the installed Rust 1.88.0 because it requires
1.91.0. The existing binary reports the matching pinned Arti 2.6.0 with
`static-sqlite`, so it was retained under the bundled-binaries playbook's
unchanged-pin exception. No toolchain or dependency was upgraded.

Validation passed 354 affected unit tests in 14 suites and strict repository lint.
The initial settings/profiles/updates harness run passed 42 cases and failed one:
a synthetic click on the newly opened update menu did not produce its install
request. The isolated case and complete five-case updater suite passed unchanged.
Source/trace review identified the existing compositor hit-test race as the likely
cause. The updater spec now uses the existing `waitForPopoverFrame` helper before
clicking a menu row; no action or request assertion was weakened. Its five-case
suite and strict lint passed after that reviewed correction.

The macOS theme run passed six cases and failed both chrome tours: three node
toggle labels already clear the contrast threshold despite remaining in the
Linux baseline, and the shared recipe uses `Control+f`, which does not open Find
on this platform. Those failures remain recorded. Linux screenshot baselines
were not regenerated or relabelled as locally validated. No new product UI was
added in this continuation.

All 167 source files in the latest Railgun qualification inventory remain
unchanged after the merge. Its two native reports remain evidence for
`98cbfd77`; this synchronization does not rerun or extend their qualification.
The [validation record](qualification/privacy-main-sync-59dd2079-2026-10-06.json)
contains installed hashes, log hashes, observed outcomes and limitations.
