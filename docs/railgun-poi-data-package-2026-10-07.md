# POI and TXID data package adoption

Freedom consumes `@freedom/railgun-kohaku-adapter` 0.4.0 from
[published source b77c7c1](https://github.com/solardev-xyz/railgun-kohaku-adapter/commit/b77c7c1edf0e3e7ffe00ed9627f97d86814ae78a).
The [vendor manifest](../vendor/railgun-kohaku-adapter/README.md) binds the exact
59-file tarball. Every packed file was compared against that commit; installed
byte tests compare the actual physical package with the committed tarball.

Twelve existing POI/TXID modules now re-export exactly their former names from
trusted `/host/poi`. The pure `bindRailgunOwnPoiPayload` function also comes from
that entry; the remaining own-POI proof helper stays in Freedom. The TXID
projection/omission cycle remains inside the package. Root, read, historical
capsule and host-data entry contracts are unchanged.

Freedom retains identity, selectors, processes, controllers, stores, network
adapters and genuine owner registries. Data helpers grant no membership,
disclosure, signing or persistence permission. The three original selector
integration cases remain Freedom tests; the package's pure test replacements do
not claim to reproduce those host boundaries.

Wallet and TXID policy hashes include the complete eager host-POI closure,
including capsule, destination and policy helpers. This changes compatibility
hashes and selects new derived namespaces under existing policy rules; it does
not migrate or reinterpret older encrypted state. Shared and direct qualifier
inventories include installed implementations, package exports and the lockfile.
Cold submission refuses historical handoffs that omit those installed pins.
These source inventories are not execution-coverage claims.

## Native qualification still required

Source checks alone do not qualify Electron jobs or packaged loading. After
landing, use the final merged Electron/runtime and exact package installation
for disposable POI selector, TXID projection/witness and packaged-load checks,
plus ordinary private proof and original-signature recovery compatibility.
Those ordinary paths retain the authentic list and need no trust-pin change.

Synthetic-list relay-positive and its cold-ready continuation need a new
external copy builder. It must copy this package physically into the isolated
source tree, bind the original tar/source/npm inputs, replace only the reviewed
`REQUIRED_LIST` literal in that copy's `src/data/railgun-poi-records.js`, and pin
both original and transformed package inventories. Every main/job import must
resolve that same copy. The qualifier refuses a shared/symlinked package root,
a shadow entry, or an unchanged authentic list. Other installed dependencies,
engine/prover archives and artifacts remain separately pinned inputs. No shared
installation may be patched. Previous external launchers and native archives
remain historical evidence for their original bytes, not authorization to run
this adoption with their old copy rules.
