# `@freedom/railgun-kohaku-adapter` tarball

`freedom-railgun-kohaku-adapter-0.5.0.tgz` is the `npm pack` output of the restricted Kohaku adapter package that Freedom extracted from `src/main/wallet/`. Freedom depends on it through a `file:` dependency in `package.json`, so `npm ci` installs it from this file and no registry is involved. `src/main/wallet/railgun-kohaku-{private-adapter,public-adapter,snapshot-plugin,read-data,read-dispatch}.js` re-export it; the implementation lives in the package.

| Field                      | Value                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Source repository          | https://github.com/solardev-xyz/railgun-kohaku-adapter                                            |
| Source commit              | `3d52223b6c4fdd4d7ed9c78933d2ffe1a4d6ca4a`                                                        |
| Package                    | `@freedom/railgun-kohaku-adapter` 0.5.0 (MPL-2.0, not published to a registry)                    |
| SHA-256                    | `190ec1f2225afca9663fbd67ac1b3b8601071c58db9119961797e7ebdd03ab52`                                |
| Integrity (`package-lock`) | `sha512-vja1AN1LS0z4VD5hEeQAM/qTlUEQWy/ZEKJPc9z7Y/V4V9mSstS7HzXt/g/B8guEUy8snevetJTsyBBBB+jSgw==` |
| Files                      | 99 (`package/` prefix): see below                                                                 |

Do not edit, re-pack or replace the tarball by hand. A new version is a new `npm pack` at a new reviewed package commit, committed under a new file name together with the `package.json` and `package-lock.json` change and an updated table above.

## Reproduce

From a clean checkout of the source repository at the commit above (the package has no `prepack` or `prepare` script, so no install is needed first):

```sh
git clone https://github.com/solardev-xyz/railgun-kohaku-adapter.git
cd railgun-kohaku-adapter
git checkout 3d52223b6c4fdd4d7ed9c78933d2ffe1a4d6ca4a
npm pack --pack-destination <directory>
shasum -a 256 <directory>/freedom-railgun-kohaku-adapter-0.5.0.tgz
```

The tarball was packed with Node.js 24.18.1 and npm 11.16.0. `npm pack` writes fixed timestamps and modes, so a pack of that commit with the same npm version is byte-identical to this file (all 99 packed files checked against the published commit). The original E1 artifact remains retained under its old filename. Its JSON output (`npm pack --json`) reports the same `integrity` as `package-lock.json`.

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

Version 0.3.0 added destination, signature, preparation, result and recovery-input
helpers under `src/data/`, plus the data-only engine and prover manifests. Their
algorithms retain the exact Freedom checks, including the fixed engine/prover
builds, `freedomfixture` source label and trusted absolute recovery paths. Host
selection, keys, genuine capabilities, stores, jobs and execution remain in
Freedom. Manifest-byte parity and transitive source-inventory tests prevent the
package's result checks from drifting from Freedom's authenticated runtime.

Version 0.4.0 added trusted `/host/poi` entries and declarations, twelve POI/TXID
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

Version 0.5.0 adds the fixed private execution kernel under `src/execution/`,
`host-bootstrap.cjs`, `host-execution.{cjs,mjs}`, their declarations, and
`docs/execution/{INTEGRATION.md,PROVENANCE.json}`. Freedom's supervisor admits nine
closed job enums, derives their key eligibility, and sends the enum to a minimal
entry that installs package guards before loading the host context/artifact ports.
The package maps each enum to a fixed module; the old filename route refuses those
local and installed job paths. Existing main owners retain genuine identity,
loan, account, receipt and original task/drain authority. Only `private-verify` is
keyless; preparation and operation still restore through one viewing-key request.

This is a staged extraction. All forty original helper/job source files remain; legacy utility routes and main
consumers still use local shared helpers. The wallet policy binds both
local and installed implementations. Issuer objects never cross those realms.
The six existing data wrappers share the installed data functions; the execution
copy preserves the documented import relocations and adds the reviewed owned
artifact-buffer size/hash check. Parent-side caller algorithms, key leases,
provider/storage routing, and source/prover archives remain in Freedom.

The integration has source and controlled owner tests. Native, packaged and
transformed-copy qualification must use the new bootstrap and installed source
inventory before execution is claimed qualified. Historical 0.2 qualification
and old 0.4 package evidence do not qualify this new kernel route. No engine or
prover archive, production key, live-service result or signing permission is
included in this tarball.

## Owner extraction candidate 0.6.0

The candidate dependency now uses `freedom-railgun-kohaku-adapter-0.6.0.tgz`
from source commit `133e88cce2e1a37288e4f0bb61bb6d8c726ed6ef`.
`OWNER-0.6.0.json` records its 278-file pack, SHA-256 and lockfile integrity.
The source commit is currently local; publication and integration acceptance
remain pending. The 0.5.0 record above is retained as historical provenance.

This candidate moves the main-process protocol owners, stores, recovery lanes
and worker dispatch into the package behind fixed host ports. Freedom supplies
its vault credential primitive, genuine privacy contexts, transport, runtime
locations and Electron process handles. The package owns the credential schedule
and its public conformance vectors. The installed dependency has one physical
copy and uses Freedom's existing SQLite version.

The package's 169 suites (7,132 tests), strict declarations, and Freedom's
13 affected host suites (476 tests) pass. Native execution through the installed
public facade and packaged application acceptance are still pending. Earlier
0.5.0 evidence does not qualify this owner extraction. Legacy Freedom owner files
remain during this acceptance stage; the native cache check must refuse loading
any of them.
