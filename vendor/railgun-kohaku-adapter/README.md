# `@freedom/railgun-kohaku-adapter` tarball

`freedom-railgun-kohaku-adapter-0.1.0.tgz` is the `npm pack` output of the restricted Kohaku adapter package that Freedom extracted from `src/main/wallet/`. Freedom depends on it through a `file:` dependency in `package.json`, so `npm ci` installs it from this file and no registry is involved. `src/main/wallet/railgun-kohaku-{private-adapter,public-adapter,snapshot-plugin,read-data,read-dispatch}.js` re-export it; the implementation lives in the package.

| Field                      | Value                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Source repository          | https://github.com/solardev-xyz/railgun-kohaku-adapter                                            |
| Source commit              | `52310ab860b89d6c6a00d6bf3b6165a792c6f74d`                                                        |
| Package                    | `@freedom/railgun-kohaku-adapter` 0.1.0 (MPL-2.0, not published to a registry)                    |
| SHA-256                    | `3f352523e95a9af07ae3713e6ba0ad98c547537c7aa32eec1029bfc773f12f92`                                |
| Integrity (`package-lock`) | `sha512-zMVxhqn2umnuIoKuX4zvSWbB6a+m0K2rvD+5XiFsfQnftLVZADMufg0863iqn07dkBxyTCxCqsf/tnP7nB3/GA==` |
| Files                      | 22 (`package/` prefix): see below                                                                 |

Do not edit, re-pack or replace the tarball by hand. A new version is a new `npm pack` at a new reviewed package commit, committed under a new file name together with the `package.json` and `package-lock.json` change and an updated table above.

## Reproduce

From a clean checkout of the source repository at the commit above (the package has no `prepack` or `prepare` script, so no install is needed first):

```sh
git clone https://github.com/solardev-xyz/railgun-kohaku-adapter.git
cd railgun-kohaku-adapter
git checkout 52310ab860b89d6c6a00d6bf3b6165a792c6f74d
npm pack --pack-destination <directory>
shasum -a 256 <directory>/freedom-railgun-kohaku-adapter-0.1.0.tgz
```

The tarball was packed with Node.js 24.18.1 and npm 11.16.0. `npm pack` writes fixed timestamps and modes, so a pack of that commit with the same npm version is byte-identical to this file (checked from a fresh clone). Its JSON output (`npm pack --json`) reports the same `integrity` as `package-lock.json`.

## Contents

`LICENSE`, `NOTICE.md`, `README.md`, `package.json`, `index.cjs`, `index.mjs`, `read.cjs`, `read.mjs`, `src/railgun-kohaku-{private-adapter,public-adapter,read-data,read-dispatch,snapshot-plugin}.js`, `src/railgun-shield-pins.json` and `types/{index,read}.d.{ts,mts}` plus `types/railgun-kohaku-{private,public,read,snapshot}-contract.d.ts`. Each file is byte-identical to the same path at the source commit. The package's `NOTICE.md` records which Freedom files it was copied from.
