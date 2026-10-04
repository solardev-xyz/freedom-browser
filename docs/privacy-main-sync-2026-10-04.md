# Privacy branch main synchronization — October 4, 2026

## Ant 0.5.57 continuation

Main `6b5c2ea7` merged cleanly in `b9858be0` after the completed-snapshot
milestone `3de72f2d`. It updates Ant's pin/checksum and corresponding tests,
comments, licensing and changelog material. No wallet/network implementation,
public/TXID policy input, dependency lockfile or qualification inventory changes.
All five completed-snapshot report inventories still match after the merge.

Ant 0.5.57 was downloaded for all configured targets with pinned checksum
verification; the host reports `antd 0.5.57`. freedom-ipfs 0.4.3, Myotis 0.1.12
(official targets, ABI 32 validation) and libradicle 0.7.1 were explicitly
reinstalled, and the Myotis supervisor rebuilt. The unchanged installed Arti
2.6.0/static-sqlite build was verified and retained. `npm run check-binaries`
passes for mac-arm64. The lockfile is unchanged, so no npm reinstall was needed.

All 282 focused tests across seven suites pass in 5.288 seconds, including the
real-binary Bee-to-Ant identity migration, Ant fetch/checksum tests, license audit,
browsing credit, chain bridge/router and publishing setup. Lint is clean. The
12,097-test full result belongs to pre-merge `3de72f2d`; the next implementation
slice will qualify the combined tree. No live node startup smoke or funded
profile operation was performed for this merge.

## Event-loop watchdog continuation

Main `05d91b18` was merged without conflicts in `76bb135f`, after the enrolled
source milestone `14615558`. It adds event-loop stall detection, chain activity
attribution, suspend/resume handling and an opt-in startup smoke command. The
activity wrapper forwards router arguments unchanged, including privacy contexts,
and records chain/method/source/timing without request parameters or endpoints.
Claude reviewed the merge integration and preservation of early private routing.

The wrapper nevertheless exposed private balance read method/timing in local
stall diagnostics. A narrow follow-up now bypasses activity recording whenever
request options carry a `privacyContext` property, including inherited or invalid
markers. It checks presence without evaluating an accessor ahead of the router.
The original call still receives the same arguments and `this`; results and
errors propagate unchanged. This conservatively omits diagnostics even when the
marker is explicitly null. Ordinary calls without the marker retain diagnostics.
Railgun private RPC does not pass through this wrapper. Broadcast diagnostics
remain enabled deliberately: even permit-bearing submissions record only
`eth_sendRawTransaction`, source and elapsed time, never the transaction or permit.
This follow-up limits private read diagnostics; it does not suppress broadcast timing.

The merged watchdog/activity/router/private-balance suites passed 114 tests
before the follow-up. The follow-up adds four privacy cases; all 118 tests pass
in 0.755 seconds, and lint is clean.
Ant 0.5.56, freedom-ipfs 0.4.3, Myotis 0.1.12 and libradicle 0.7.1 were explicitly
reinstalled again after this merge, the Myotis supervisor rebuilt, and matching
Arti 2.6.0/static-sqlite retained. Binary checks pass. The package change only
adds a script; lockfile and dependency/binary pins are unchanged. No npm dependency
reinstall or upstream pin bump was needed.

The source milestone's 11,858-test full regression is tied to `14615558` and
predates this watchdog merge. No merged file intersects its five native source
inventories or the public/TXID policy inputs. The subsequent [RPC prerequisite](private-rpc-read-budget-2026-10-04.md)
qualifies the combined tree: 11,994 tests pass / 33 skipped across 483 passing
suites in 406.285 seconds (native access; existing OpenLV exclusion). No live
startup smoke or funded-profile operation was run for this synchronization.

## Colibri worker continuation

Main `f9a13854` brings Colibri verification into per-chain workers, deadline
propagation, atomic temporary-file storage and orphan cleanup. Two localized
formatting-context conflicts in the router and its tests were resolved by keeping
main's new comment, deadline argument and deadline checks, alongside the feature
branch's early private-context delegation. Claude compared the resolution against
both parents. Private reads still return through the narrow private balance route
before ordinary source selection; they cannot fall through to Colibri.

The eight router/private-balance/Colibri/Ant suites pass 274 tests in 1.544 seconds;
lint is clean. The dependency lockfile and binary pins are unchanged. Ant 0.5.56
(all configured targets), freedom-ipfs 0.4.3 (host addon), Myotis 0.1.12 (official
artifacts, ABI 32 validation) and libradicle 0.7.1 (host, checksum verified) were
explicitly reinstalled. The Myotis supervisor was rebuilt. Existing Arti 2.6.0
reports the matching version and static-sqlite support, so its unchanged build was
retained under the bundled-binaries playbook. `npm run check-binaries` passes for
mac-arm64. No npm dependency reinstall or upstream pin upgrade was needed.

The receipt milestone was committed as `9571b0b8` before this merge. None of the
merged files intersects its eight source inventories; all hashes still match.
Its full regression of 11,812 tests remains explicitly pre-merge evidence. Separate
merged-tree [transfer](qualification/railgun-receipt-destination-merged-transfer-2026-10-04.json)
and [unshield](qualification/railgun-receipt-destination-merged-unshield-2026-10-04.json)
receipt reruns each pass nine existing and seven prepared-reader groups with 146
matching hashes in 2,138/2,004 ms. Their chain, registry and transport are simulated.
Public/TXID policy inputs are unchanged by the merge. The merged full regression
passes 11,837 tests / 33 skipped across 478 passing suites in 398.493 seconds
(native access; existing OpenLV exclusion). Source and tests remained frozen
during this run; fixture timings overlap verification and are not latency guarantees.

## Earlier log-routing synchronization

Main `f2274ee6` was merged into the feature branch in `fb11336f`. Its log-routing
fix excludes Colibri for every ordinary `eth_getLogs` request and lets the Ant
bridge exclude it explicitly. Two formatting-context conflicts in the shared
router were resolved while preserving this branch's private-context delegation.
The private balance route accepts only its narrow balance calls and never reaches
Colibri. Claude reviewed the resolution. The lockfile and dependency pins did not
change, so no npm dependency installation was needed.

The three router/private-balance/log-routing suites passed 151 tests. The Ant
bridge's initial sandboxed run could not listen on loopback; its native-permission
rerun passed all 61 tests. All 212 focused tests therefore pass, and lint is clean.

The merged branch's pinned installations were refreshed explicitly:

- Ant 0.5.56: all configured download targets, with the host version checked.
- freedom-ipfs 0.4.3: host prebuilt and development addon installed.
- Myotis 0.1.12: official target artifacts and ABI 32 validation; host supervisor rebuilt.
- libradicle 0.7.1: host addon installed with its pinned checksum verified.
- Arti 2.6.0: unchanged pin and matching installed version verified, including static-sqlite.

`npm run check-binaries` passes for mac-arm64, including configured Myotis
provenance checks. Downloads authenticate the pinned bytes; the presence check
alone is not a version or cross-platform runtime test. No unrelated upstream pin
was upgraded. The bundled-binaries playbook permits retaining a matching Arti
build when its pin is unchanged.

The merged regression passes 9,669 tests / 33 skipped across 455 suites in 302.136 s (native access; existing OpenLV exclusion).

The four combined-source native reports still match their 142 recorded source
hashes: main's routing changes are outside those inventories. Those reports use
synthetic RPC/history and do not demonstrate funded private operations. Owned-note
POI disclosure remains pending; no live private query or spend occurred.
