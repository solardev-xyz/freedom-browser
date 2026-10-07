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
a shadow entry, a transformed source with an unknown or non-single link count,
or an unchanged authentic list. Other installed dependencies,
engine/prover archives and artifacts remain separately pinned inputs. No shared
installation may be patched. Previous external launchers and native archives
remain historical evidence for their original bytes, not authorization to run
this adoption with their old copy rules.

The builder must copy every package file to a fresh regular file and require
`nlink === 1` across the copied package tree. Do not use `cp -al`,
`rsync --link-dest`, or a hardlinked package store. Filesystem clones are suitable
only when they have distinct inodes and a single link. Transform by writing a new
temporary file with exclusive creation and atomically renaming it over the
copy's target; never write in place. On a filesystem that provides reliable
device/inode identities, compare the copied target's `(dev, ino)` pair with the
authenticated original target and refuse equality. Capture the original identity
before copying and recheck it afterward. A builder that cannot establish this
identity separation must refuse qualification rather than assume isolation.

After the build, rehash the original package inventory and require exact equality
with its pre-build inventory; the original records file must still hash to
`ORIGINAL_SHA`. Recheck the single-link property and original inventory after
execution too. The qualifier's zero-argument `assertIsolation()` knows only its
isolated checkout, not an authenticated original checkout path or inode. Its
single-link check cannot prove that an original was never modified earlier;
original/copy identity and original-byte preservation are therefore mandatory
builder checks, not claims made by this local guard.

The positive/cold fixture's publication-time main cache collector now requires a
physical `node_modules` directory and classifies its files as dependencies before
checking the surrounding application tree. Every observed application/dependency
file must be a canonical, single-link regular file. Original-root fallbacks,
application rows under nested `node_modules`, and the copied fixture engine
distribution refuse before their source is read. Cold uses the same collector.

The collector derives the one bootstrap archive location from the actual external
Electron executable passed by its fixed inspector. For the pinned macOS Electron
44.6.0 runtime, read-only input inspection found the same exact `default_app.asar`
and `package.json` member bytes as 44.5.1; the executable and framework have new
pins. Only that member and the three exact Electron virtual aliases are admitted.
These source checks do not establish a new native loader observation, full import
coverage, or a positive/cold campaign outcome. The physical builder and final
original-process driver still require their own reviewed input bindings.
