# License Audit Report for Freedom Browser

**Intended License:** MPL-2.0 (Mozilla Public License 2.0)
**Audit Date:** 2026-09-10
**Baseline:** `0.8.5-rc.6`
**Auditor:** Automated analysis, re-derived from the installed tree

> **DISCLAIMER:** This is a practical engineering audit, not legal advice. For final licensing decisions, consult a qualified attorney.

> **What changed in this revision.** The previous revision (2026-08-19) described a pre-0.8.5 tree — electron 39.2.7, ant v0.5.21, libradicle 0.3.0, "downloaded binaries: 2", no Myotis, no Arti — and reported `Copyleft (GPL/AGPL/LGPL): 0`, which was already untrue of the tree it was written against. Because `release-process.md` §4's pre-tag license check reads these files, it was passing on stale data. This revision is re-derived from the installed dependency tree and from what `package.json`'s `build` config actually packages, and `licenses-audit.test.js` now fails the build when either drifts from what is written here.

---

## Executive Summary

**VERDICT: OK TO SHIP UNDER MPL-2.0**, with the notice obligations in `NOTICES` met as written.

### Key Findings

| Category                                                  | Count       | Status                                      |
| --------------------------------------------------------- | ----------- | ------------------------------------------- |
| Production npm packages (unique name@version)             | 265         | See distribution below                      |
| Dev npm dependencies                                      | not bundled | Do not affect the distributed product       |
| External binaries / native addons shipped in `resources/` | 5           | Ant, freedom-ipfs, libradicle, Myotis, Arti |
| Vendored renderer bundles in `src/renderer/vendor/`       | 4           | OpenLV, highlight.js, marked, DOMPurify     |
| Strong copyleft (GPL/AGPL)                                | 0           | One found and removed — see below           |
| Weak copyleft (MPL-2.0)                                   | 13 packages | Compatible; MPL-2.0 is our own license      |
| Weak copyleft (LGPL-3.0)                                  | 5 packages  | Compatible via the isolated OpenLV bundle   |

### Resolved during this audit: a GPL-3.0 library was shipping

`src/renderer/vendor/qrious.min.js` (QRious 4.0.2, **GPL-3.0**) was committed under `src/renderer/vendor/` and therefore shipped inside `app.asar` via the `src/**/*` files pattern, while being referenced by no source file at all. GPL-3.0 is strong copyleft and is **not** compatible with distributing Freedom under MPL-2.0. The prior audit's blanket no-copyleft-found line missed it because the audit only ever looked at npm metadata, never at committed vendor files.

It has been deleted, along with two other unreferenced vendor files that came in with the same commit: `qrcode.esm.js`, and `qrcode.min.js` — the latter a 64-byte jsDelivr _"Couldn't find the requested file"_ error body saved as JavaScript. The app's QR rendering has always used the npm `qrcode` package (MIT) from the main process (`src/main/wallet/wallet-ipc.js`).

---

## Distribution Model

Freedom Browser is distributed as:

- **Electron desktop application** (DMG for macOS, DEB and AppImage for Linux, NSIS installer and portable zip for Windows)
- **Bundled node_modules** in `app.asar`
- **Committed vendor bundles** under `src/renderer/vendor/`, shipped inside `app.asar` by the `src/**/*` files pattern
- **Native addons** unpacked from asar, shipped under `resources/`:
  - `better-sqlite3`
  - `freedom_ipfs_native.node` (`resources/freedom-ipfs-node/`)
  - `libradicle.node` (`resources/radicle-bin/`)
  - `myotis-node.node` (`resources/myotis-node/`)
- **External binaries** shipped in `resources/`:
  - Ant (`antd`, Swarm node)
  - Arti (Tor client) — **macOS and Linux only**; Windows packages ship no Arti
  - `myotis-supervisor` — compiled from Freedom's own C sources (`src/main/myotis/native/`), not third-party

---

## License Classification

### Risk Levels

- **Green:** Permissive license, no special action beyond including license text
- **Yellow:** Permissive but requires explicit notice/attribution
- **Orange:** Copyleft that requires careful handling (LGPL relinking, etc.)
- **Red:** Incompatible with MPL-2.0 distribution model

---

## Downloaded Runtime Artifacts

Versions here are the pinned values in the repo, not observed downloads; each row names its pin so a drift is checkable. `licenses-audit.test.js` asserts these match.

### Ant (antd, Swarm Node)

- **Source:** https://github.com/freedom-hq/ant
- **Version:** `v0.5.44` (pin: `scripts/fetch-ant.js` `PINNED_RELEASE_TAG`)
- **License:** MIT OR Apache-2.0 (upstream ships `LICENSE-MIT` and `LICENSE-APACHE`)
- **Risk:** Green
- **Integration:** Separate process via IPC
- **Action Required:** MIT/Apache notice in `NOTICES` ✔

### freedom-ipfs (Native IPFS Addon)

- **Source:** https://github.com/solardev-xyz/freedom-ipfs
- **Version:** `v0.4.3` (pin: `scripts/fetch-freedom-ipfs-native.js` `releaseTag`)
- **License:** MIT OR Apache-2.0 (upstream ships `LICENSE-MIT` and `LICENSE-APACHE`)
- **Risk:** Green
- **Integration:** Native addon loaded by the Electron main process
- **Action Required:** MIT/Apache notice in `NOTICES` ✔

### libradicle (Native Radicle Addon)

- **Source:** https://github.com/solardev-xyz/libradicle
- **Version:** `0.7.1` (pin: `src/shared/radicle-addon-version.js` `RADICLE_ADDON_VERSION`)
- **License:** MIT OR Apache-2.0
- **Risk:** Green
- **Integration:** Native addon loaded by the Electron main process
- **Notes:** Upstream commits **no** `LICENSE` file; the dual-license claim rests on `license = "MIT OR Apache-2.0"` in its `Cargo.toml`, verified at tag `v0.7.1`. It statically links Radicle Heartwood (`solardev-xyz/heartwood`), whose workspace `Cargo.toml` is also `MIT OR Apache-2.0` — no copyleft enters this way.
- **Action Required:** MIT/Apache notice in `NOTICES` ✔; ask upstream to commit the license texts.

### Myotis (Native Wallet-Engine Addon) — _new in 0.8.5_

- **Source:** https://github.com/biafra23/myotis
- **Version:** `v0.1.7` (pin: `scripts/fetch-myotis.js` `PINNED_RELEASE_TAG`)
- **License:** **Apache-2.0** (single-licensed, not dual)
- **Risk:** **Yellow**
- **Integration:** Native addon (`myotis-node.node`), run out-of-process under Freedom's own supervisor
- **Action Required:** Apache-2.0 **section 4(d)** — upstream ships a `NOTICE` file, so its attribution text must be reproduced verbatim in any redistribution. Copyright 2026 Dirk Jäckel. Reproduced in `NOTICES` ✔. **Re-read the upstream `NOTICE` on every version bump.**

### Arti (Tor Client) — _new in 0.8.5_

- **Source:** https://gitlab.torproject.org/tpo/core/arti (crates.io crate `arti`)
- **Version:** `2.6.0` (pin: `scripts/fetch-arti.js` `PINNED_ARTI_VERSION`)
- **License:** MIT OR Apache-2.0 (crate `license` field; `LICENSE-MIT` reads _Copyright 2019-2025, The Tor Project, Inc._)
- **Risk:** Green
- **Platforms:** macOS and Linux only
- **Integration:** Separate process, reached over SOCKS
- **Notes:** Built with `cargo install arti --locked`, so the shipped binary **statically links the crate's entire dependency tree**. Upstream distributes that tree under permissive licenses; re-check the `Cargo.lock` license set on any `ARTI_VERSION` bump.
- **Action Required:** MIT/Apache notice in `NOTICES` ✔

---

## Vendored Renderer Bundles (`src/renderer/vendor/`)

These are pre-built third-party files committed into the repo. They are **not** covered by the "npm dependencies" line in `NOTICES` and need their own attribution — the gap that let a GPL-3.0 library ship unnoticed.

| File                                               | Component                                                                | Version       | License                  | Risk       |
| -------------------------------------------------- | ------------------------------------------------------------------------ | ------------- | ------------------------ | ---------- |
| `openlv.esm.js`                                    | OpenLV (`@openlv/{core,session,signaling,transport}`) + `websocket-mqtt` | 0.2.0 / 0.0.7 | LGPL-3.0-only / LGPL-3.0 | **Orange** |
| `highlight.min.js`, `hljs-github-{dark,light}.css` | highlight.js                                                             | 11.11.1       | BSD-3-Clause             | Green      |
| `marked.min.js`                                    | marked                                                                   | 15.0.7        | MIT                      | Green      |
| `purify.min.js`                                    | DOMPurify                                                                | 3.2.5         | MPL-2.0 OR Apache-2.0    | Green      |

### The LGPL question: OpenLV

`@openlv/*` and the `websocket-mqtt` signaling backend they pull in are **LGPL-3.0**. Freedom ships them, so LGPL-3.0 §4 applies: a user must be able to relink the application against a modified version of the library.

This is met by construction, and deliberately so. `scripts/bundle-openlv.js` emits **one standalone ES module** (`src/renderer/vendor/openlv.esm.js`) containing only upstream code and no Freedom code; the renderer loads it by dynamic import (`src/renderer/lib/wallet/remote-session.js`). A user can replace that single file inside `app.asar`, or re-run `npm run vendor:openlv` against their own build of the upstream packages. `NOTICES` states this.

**The constraint this places on future work:** never inline `openlv.esm.js` into an app bundle, and never mix Freedom code into it. Either would convert a satisfied obligation into one Freedom cannot meet.

### MPL-2.0 packages

13 production packages are MPL-2.0: `@ghostery/adblocker` and its `@remusao/*` / `@ghostery/url-parser` helpers, `@ethereumjs/{rlp,tx,util}`, and DOMPurify under its MPL arm. MPL-2.0 is file-level weak copyleft and is Freedom's own license, so combination is unproblematic; Freedom consumes all of them unmodified, so no source-disclosure obligation is triggered.

---

## Electron Framework

- **Version:** 44.3.0 (lockfile-resolved)
- **License:** MIT
- **Risk:** Yellow (requires notice)
- **Notes:** Electron bundles Chromium, which contains hundreds of third-party components under various permissive licenses.

### Action Required

Electron generates a `LICENSES.chromium.html` file containing all Chromium third-party notices. This should be:

1. Shipped with the application, OR
2. Referenced in the third-party notices file with a link to Electron's upstream notices

---

## Native Addons

### better-sqlite3

- **Version:** 13.0.3
- **License:** MIT
- **Bundled Component:** SQLite (public domain)
- **Risk:** Green
- **Notes:** SQLite is in the public domain and creates no licensing obligations. The better-sqlite3 wrapper is MIT licensed. Since #197 it ships N-API prebuilds rather than being rebuilt per-Electron.

### node-hid

- **Version:** 2.1.2, via `@ledgerhq/hw-transport-node-hid`
- **License:** MIT OR X11
- **Risk:** Green

---

## Production Dependency License Distribution

Walk of `package.json` `dependencies` plus their transitive `dependencies` in the installed tree, deduplicated by `name@version`.

| License                           | Count   |
| --------------------------------- | ------- |
| MIT                               | 191     |
| Apache-2.0                        | 21      |
| ISC                               | 20      |
| MPL-2.0                           | 13      |
| LGPL-3.0-only                     | 4       |
| Apache-2.0 OR MIT                 | 3       |
| BSD-3-Clause                      | 3       |
| 0BSD                              | 3       |
| LGPL-3.0                          | 1       |
| MIT OR X11                        | 1       |
| MIT OR WTFPL                      | 1       |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1       |
| Zlib OR MIT OR Apache-2.0         | 1       |
| Python-2.0                        | 1       |
| BlueOak-1.0.0                     | 1       |
| **Total**                         | **265** |

---

## Assets

| Asset                                   | Type             | License                                                        |
| --------------------------------------- | ---------------- | -------------------------------------------------------------- |
| `assets/icon.png`, `assets/icons/*.png` | Icons            | Proprietary (Freedom Team)                                     |
| `assets/adblock/*`                      | Filter-list data | GPLv3+ or CC BY-SA 3.0+ — redistributed under the CC BY-SA arm |

The filter lists (EasyList, EasyPrivacy, Fanboy Cookiemonster, Fanboy Annoyances) are dual-licensed **data, not code**. Freedom takes the CC BY-SA arm, which needs attribution only; the GPL arm is not exercised. Attributed in `NOTICES`.

---

## Dev Dependencies (Not Bundled)

Dev dependencies are not shipped with the application and do not affect the license of the distributed product.

Notable: **caniuse-lite** is CC-BY-4.0 (attribution required if distributed — it is not). All others: MIT, ISC, BSD, Apache-2.0.

---

## Notice Requirements

`NOTICES` must carry attribution for:

1. **Electron** — MIT, and a reference to Chromium's `LICENSES.chromium.html`
2. **Ant (Swarm)** — MIT OR Apache-2.0
3. **freedom-ipfs** — MIT OR Apache-2.0
4. **libradicle** — MIT OR Apache-2.0
5. **Myotis** — Apache-2.0, _with the upstream `NOTICE` text reproduced_ (§4(d))
6. **Arti** — MIT OR Apache-2.0, Copyright 2019-2025 The Tor Project, Inc.
7. **OpenLV + websocket-mqtt** — LGPL-3.0, _with relinking instructions_
8. **highlight.js** — BSD-3-Clause
9. **marked** — MIT
10. **DOMPurify** — MPL-2.0 OR Apache-2.0
11. **@ghostery/adblocker** — MPL-2.0
12. **Ad-blocking filter lists** — CC BY-SA
13. **All npm production dependencies** with MIT/ISC/BSD/Apache licenses

`licenses-audit.test.js` checks 2–10 against what `package.json` and `src/renderer/vendor/` actually ship, and fails on anything new that has not been classified.

## Ship License Files (Recommended)

Consider bundling license files in the distributed app:

- `resources/licenses/LICENSE` (MPL-2.0 for Freedom Browser)
- `resources/licenses/NOTICES`
- Reference to Electron's `LICENSES.chromium.html`

---

## Copyleft Analysis

### Strong copyleft (GPL/AGPL): NONE — one found and removed

`src/renderer/vendor/qrious.min.js` (GPL-3.0) was shipping unreferenced; see _Resolved during this audit_ above. Nothing else in the production tree or the vendor directory is GPL or AGPL.

The ad-blocking filter lists are offered under "GPLv3+ **or** CC BY-SA 3.0+"; Freedom redistributes them under CC BY-SA, so no GPL obligation attaches.

### Weak copyleft: present and handled

- **MPL-2.0** (13 packages) — file-level copyleft, same license as Freedom itself, all consumed unmodified. No obligation beyond notice.
- **LGPL-3.0** (5 packages: `@openlv/{core,session,signaling,transport}`, `websocket-mqtt`) — shipped as one isolated, regenerable bundle so §4 relinking is possible. See _The LGPL question_ above.

### Why This Matters

MPL-2.0 is a "weak copyleft" license that:

- Requires source disclosure only for MPL-licensed files that are modified
- Is compatible with most permissive licenses (MIT, BSD, Apache, ISC)
- Does NOT require the entire combined work to be open-sourced (unlike GPL)
- Allows combination with proprietary code

Combining with **GPL-3.0** would not work: it would require the combined work to be GPL-3.0, which Freedom is not. That is why the qrious removal was necessary rather than a notice fix. **LGPL-3.0** is fine _provided the library stays relinkable_, which is what the OpenLV bundling arrangement buys.

---

## Compatibility Matrix

| Dependency License     | MPL-2.0 Compatible | Notes                                                                          |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------ |
| MIT                    | Yes                | Permissive, no conflict                                                        |
| ISC                    | Yes                | Permissive, no conflict                                                        |
| BSD-2-Clause           | Yes                | Permissive, no conflict                                                        |
| BSD-3-Clause           | Yes                | Permissive, attribution required                                               |
| Apache-2.0             | Yes                | Permissive, patent grant; NOTICE file must be reproduced if upstream ships one |
| 0BSD                   | Yes                | Public domain equivalent                                                       |
| BlueOak-1.0.0          | Yes                | Modern permissive                                                              |
| Python-2.0 (PSF)       | Yes                | Permissive                                                                     |
| CC0-1.0                | Yes                | Public domain dedication                                                       |
| CC-BY-SA-3.0           | Yes                | Attribution + share-alike on the _data_, not on our code                       |
| MPL-2.0                | Yes                | Same license; file-level copyleft only                                         |
| LGPL-3.0               | Yes, conditionally | Only while the library ships as a separately replaceable unit (§4)             |
| **GPL-3.0 / AGPL-3.0** | **No**             | Would force the combined work to GPL. Must not ship.                           |
| CC-BY-4.0              | Yes*               | Attribution required, but only in dev deps                                     |

---

## Summary

Freedom Browser can be released under MPL-2.0, with these conditions:

- **Zero GPL/AGPL code ships** — true only after removing `qrious.min.js`
- **Weak copyleft (MPL-2.0, LGPL-3.0) is present and handled**, not absent
- **All runtime binaries and native addons are permissively licensed**
- **Myotis requires its upstream `NOTICE` reproduced**, per Apache-2.0 §4(d)
- **Assets are original works**, except the CC BY-SA filter-list data

### Checklist Before Release

- [x] `LICENSE` file with MPL-2.0 text
- [x] `package.json` `license` field is `MPL-2.0`
- [x] `NOTICES` names every shipped binary, addon and vendor bundle
- [x] Myotis's upstream `NOTICE` reproduced verbatim
- [x] LGPL relinking instructions present in `NOTICES`
- [x] No GPL/AGPL code in the packaged artifact
- [ ] Add MPL-2.0 header comments to source files (optional but recommended)
- [ ] Include or reference Electron's Chromium license notices

---

_Re-derived from the installed tree on 2026-09-10 against `0.8.5-rc.6`. Kept honest by `licenses-audit.test.js`._
