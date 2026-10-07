# `@freedom/railgun-kohaku-adapter` tarball

`freedom-railgun-kohaku-adapter-0.4.0.tgz` is the `npm pack` output of the restricted Kohaku adapter package that Freedom extracted from `src/main/wallet/`. Freedom depends on it through a `file:` dependency in `package.json`, so `npm ci` installs it from this file and no registry is involved. `src/main/wallet/railgun-kohaku-{private-adapter,public-adapter,snapshot-plugin,read-data,read-dispatch}.js` re-export it; the implementation lives in the package.

| Field                      | Value                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Source repository          | https://github.com/solardev-xyz/railgun-kohaku-adapter                                            |
| Source commit              | `b77c7c1edf0e3e7ffe00ed9627f97d86814ae78a`                                                        |
| Package                    | `@freedom/railgun-kohaku-adapter` 0.4.0 (MPL-2.0, not published to a registry)                    |
| SHA-256                    | `35ea07c1f9c64926c94a0b24f39333db75412a7771eae78675743bcae2a6a0a1`                                |
| Integrity (`package-lock`) | `sha512-jo48Wo3koQR+TDwTyWzJjG9nAPaRkHeraQOtT8z0w1GIhSUh82di4XqtkNVmpMhL4XClbnqeia19Gvr7nDHuvQ==` |
| Files                      | 59 (`package/` prefix): see below                                                                 |

Do not edit, re-pack or replace the tarball by hand. A new version is a new `npm pack` at a new reviewed package commit, committed under a new file name together with the `package.json` and `package-lock.json` change and an updated table above.

## Reproduce

From a clean checkout of the source repository at the commit above (the package has no `prepack` or `prepare` script, so no install is needed first):

```sh
git clone https://github.com/solardev-xyz/railgun-kohaku-adapter.git
cd railgun-kohaku-adapter
git checkout b77c7c1edf0e3e7ffe00ed9627f97d86814ae78a
npm pack --pack-destination <directory>
shasum -a 256 <directory>/freedom-railgun-kohaku-adapter-0.4.0.tgz
```

The tarball was packed with Node.js 24.18.1 and npm 11.16.0. `npm pack` writes fixed timestamps and modes, so a pack of that commit with the same npm version is byte-identical to this file (all 59 packed files checked against the published commit). The original E1 artifact remains retained under its old filename. Its JSON output (`npm pack --json`) reports the same `integrity` as `package-lock.json`.

## Contents

`LICENSE`, `NOTICE.md`, `README.md`, `package.json`, `index.cjs`, `index.mjs`, `read.cjs`, `read.mjs`, `src/railgun-kohaku-{private-adapter,public-adapter,read-data,read-dispatch,snapshot-plugin}.js`, `src/railgun-shield-pins.json` and `types/{index,read}.d.{ts,mts}` plus `types/railgun-kohaku-{private,public,read,snapshot}-contract.d.ts`. Each file is byte-identical to the same path at the source commit. The package's `NOTICE.md` records which Freedom files it was copied from.

Version 0.2.0 added `data.{cjs,mjs}`, `host-data.{cjs,mjs}`, five `src/data/`
files and four `types/{data,host-data}.d.{ts,mts}` files. The public `/data` reader
accepts bounded plain historical records with fixed refusal errors. Freedom uses
`/host/data` for one shared implementation of the original structural policy,
intent, offer and capsule checks. New-capsule engine binding stays in Freedom; owned-note preparation checks now
share the package implementation without changing their input requirements. The host subpath preserves internal assertion contracts and must
not expose raw errors to users or reports. No engine, prover, key, network or store
is included. No new third-party dependency or supported chain is added.

Version 0.3.0 adds destination, signature, preparation, result and recovery-input
helpers under `src/data/`, plus the data-only engine and prover manifests. Their
algorithms retain the exact Freedom checks, including the fixed engine/prover
builds, `freedomfixture` source label and trusted absolute recovery paths. Host
selection, keys, genuine capabilities, stores, jobs and execution remain in
Freedom. Manifest-byte parity and transitive source-inventory tests prevent the
package's result checks from drifting from Freedom's authenticated runtime.

Version 0.4.0 adds trusted `/host/poi` entries and declarations, twelve POI/TXID
data modules and the pure own-POI payload binder. Freedom retains selectors,
engine jobs, stores, controllers and genuine authority owners. The TXID and
wallet policies pin the entire eager host-POI closure, including capsule helpers.
The original Freedom selector integration tests remain here. No proof, membership,
disclosure, signing or storage permission follows from these data helpers.

Synthetic-list relay qualification now requires a physical isolated package copy.
Only that copy may receive the reviewed REQUIRED_LIST replacement; the regular
installed package and all old archived source freezes remain unchanged. External
positive/cold launchers need fresh copy rules and installed-package inventories
before a new native run. Ordinary private proof and original-signature recovery
use the authentic list and do not need that transformation.
