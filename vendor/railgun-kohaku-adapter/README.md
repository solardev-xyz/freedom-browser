# `@freedom/railgun-kohaku-adapter` tarball

`freedom-railgun-kohaku-adapter-0.3.0.tgz` is the `npm pack` output of the restricted Kohaku adapter package that Freedom extracted from `src/main/wallet/`. Freedom depends on it through a `file:` dependency in `package.json`, so `npm ci` installs it from this file and no registry is involved. `src/main/wallet/railgun-kohaku-{private-adapter,public-adapter,snapshot-plugin,read-data,read-dispatch}.js` re-export it; the implementation lives in the package.

| Field                      | Value                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Source repository          | https://github.com/solardev-xyz/railgun-kohaku-adapter                                            |
| Source commit              | `cbc34b2c5d2d346e4fde722741c3638f4dcd312c`                                                        |
| Package                    | `@freedom/railgun-kohaku-adapter` 0.3.0 (MPL-2.0, not published to a registry)                    |
| SHA-256                    | `f5fedd6e610567690ceb6de4e191bf5e076093cf1e69c8ce33973f2437c4b0a5`                                |
| Integrity (`package-lock`) | `sha512-unpvh3HctaEyi5bYZLIDD2QW0XufpOFU+FStYCAWpBcrwc/zUUdzykagySZbwEKxVD5FZ8XENThLFcFAACy0TA==` |
| Files                      | 42 (`package/` prefix): see below                                                                 |

Do not edit, re-pack or replace the tarball by hand. A new version is a new `npm pack` at a new reviewed package commit, committed under a new file name together with the `package.json` and `package-lock.json` change and an updated table above.

## Reproduce

From a clean checkout of the source repository at the commit above (the package has no `prepack` or `prepare` script, so no install is needed first):

```sh
git clone https://github.com/solardev-xyz/railgun-kohaku-adapter.git
cd railgun-kohaku-adapter
git checkout cbc34b2c5d2d346e4fde722741c3638f4dcd312c
npm pack --pack-destination <directory>
shasum -a 256 <directory>/freedom-railgun-kohaku-adapter-0.3.0.tgz
```

The tarball was packed with Node.js 24.18.1 and npm 11.16.0. `npm pack` writes fixed timestamps and modes, so a pack of that commit with the same npm version is byte-identical to this file (checked from a fresh clone). The original E1 artifact remains retained under its old filename. Its JSON output (`npm pack --json`) reports the same `integrity` as `package-lock.json`.

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
