# `@freedom/railgun-kohaku-adapter` tarball

`freedom-railgun-kohaku-adapter-0.2.0.tgz` is the `npm pack` output of the restricted Kohaku adapter package that Freedom extracted from `src/main/wallet/`. Freedom depends on it through a `file:` dependency in `package.json`, so `npm ci` installs it from this file and no registry is involved. `src/main/wallet/railgun-kohaku-{private-adapter,public-adapter,snapshot-plugin,read-data,read-dispatch}.js` re-export it; the implementation lives in the package.

| Field                      | Value                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Source repository          | https://github.com/solardev-xyz/railgun-kohaku-adapter                                            |
| Source commit              | `22d9265e8d7acf6b9234eb544c6df341b6501fc9`                                                        |
| Package                    | `@freedom/railgun-kohaku-adapter` 0.2.0 (MPL-2.0, not published to a registry)                    |
| SHA-256                    | `752ace2fbd3fa08a5ec036aa688021e322785ff7903da7555082f88d92b4c610`                                |
| Integrity (`package-lock`) | `sha512-9iU//Gj7/XW4nyK9BHGR3UWF3rhj4cUMYDkQVDk6gM83BPnJA4Mji+M5iQSAIO7SDJCK41mBZI87nPDk2AuV2w==` |
| Files                      | 35 (`package/` prefix): see below                                                                 |

Do not edit, re-pack or replace the tarball by hand. A new version is a new `npm pack` at a new reviewed package commit, committed under a new file name together with the `package.json` and `package-lock.json` change and an updated table above.

## Reproduce

From a clean checkout of the source repository at the commit above (the package has no `prepack` or `prepare` script, so no install is needed first):

```sh
git clone https://github.com/solardev-xyz/railgun-kohaku-adapter.git
cd railgun-kohaku-adapter
git checkout 22d9265e8d7acf6b9234eb544c6df341b6501fc9
npm pack --pack-destination <directory>
shasum -a 256 <directory>/freedom-railgun-kohaku-adapter-0.2.0.tgz
```

The tarball was packed with Node.js 24.18.1 and npm 11.16.0. `npm pack` writes fixed timestamps and modes, so a pack of that commit with the same npm version is byte-identical to this file (checked from a fresh clone). The original E1 artifact remains retained under its old filename. Its JSON output (`npm pack --json`) reports the same `integrity` as `package-lock.json`.

## Contents

`LICENSE`, `NOTICE.md`, `README.md`, `package.json`, `index.cjs`, `index.mjs`, `read.cjs`, `read.mjs`, `src/railgun-kohaku-{private-adapter,public-adapter,read-data,read-dispatch,snapshot-plugin}.js`, `src/railgun-shield-pins.json` and `types/{index,read}.d.{ts,mts}` plus `types/railgun-kohaku-{private,public,read,snapshot}-contract.d.ts`. Each file is byte-identical to the same path at the source commit. The package's `NOTICE.md` records which Freedom files it was copied from.

Version 0.2.0 adds `data.{cjs,mjs}`, `host-data.{cjs,mjs}`, five `src/data/`
files and four `types/{data,host-data}.d.{ts,mts}` files. The public `/data` reader
accepts bounded plain historical records with fixed refusal errors. Freedom uses
`/host/data` for one shared implementation of the original structural policy,
intent, offer and capsule checks. Current engine binding and owned-note selection
stay in Freedom. The host subpath preserves internal assertion contracts and must
not expose raw errors to users or reports. No engine, prover, key, network or store
is included. No new third-party dependency or supported chain is added.
