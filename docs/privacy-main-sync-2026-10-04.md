# Privacy branch main synchronization — October 4, 2026

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
