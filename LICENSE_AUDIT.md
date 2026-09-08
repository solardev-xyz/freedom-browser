# License Audit Report for Freedom Browser

**Intended License:** MPL-2.0 (Mozilla Public License 2.0)
**Audit Date:** 2026-06-14
**Auditor:** Automated analysis (Codex)

> **DISCLAIMER:** This is a practical engineering audit, not legal advice. For final licensing decisions, consult a qualified attorney.

---

## Executive Summary

**VERDICT: OK TO SHIP UNDER MPL-2.0**

All dependencies (npm packages, downloaded binaries, and bundled assets) use licenses compatible with MPL-2.0 distribution. No GPL, AGPL, or LGPL copyleft licenses were found in the runtime dependency tree.

### Key Findings

| Category | Count | Status |
|----------|-------|--------|
| Production npm dependencies | 67 | All permissive |
| Dev npm dependencies | ~650 | All permissive (not bundled) |
| Downloaded binaries | 2 | All permissive |
| Native addons | 2 | All permissive |
| Copyleft (GPL/AGPL/LGPL) | 0 | None found |

---

## Distribution Model

Freedom Browser is distributed as:

- **Electron desktop application** (DMG for macOS, DEB for Linux, NSIS installer for Windows)
- **Bundled node_modules** in `app.asar` archive
- **Native addon** (`better-sqlite3`) unpacked from asar
- **Native IPFS addon** (`freedom_ipfs_native.node`) shipped under `resources/freedom-ipfs-node/`
- **Native Radicle addon** (`libradicle.node`) shipped under `resources/radicle-bin/`
- **External binaries** shipped in `resources/`:
  - Ant (antd, Swarm node)

---

## License Classification

### Risk Levels

- **Green:** Permissive license, no special action beyond including license text
- **Yellow:** Permissive but requires explicit notice/attribution
- **Orange:** Copyleft that requires careful handling (LGPL dynamic linking, etc.)
- **Red:** Incompatible with MPL-2.0 distribution model

---

## Production Dependencies (Bundled)

### Direct Dependencies

| Package | Version | License | Risk |
|---------|---------|---------|------|
| ethers | 6.16.0 | MIT | Green |
| better-sqlite3 | 13.0.3 | MIT | Green |
| electron-log | 5.4.4 | MIT | Green |
| electron-updater | 6.8.3 | MIT | Green |
| @ensdomains/content-hash | 3.0.0 | MIT | Green |

> `better-sqlite3` re-checked 2026-09-02 for the 12.11.1 to 13.0.3 bump: still MIT, still Green. `micro-key-producer` (0.9.0 to 0.10.2, MIT) was checked at the same time; it is not listed above because the table covers only the packages reviewed in the 2026-06-14 audit. Other rows still carry their original audit-date versions and have not been re-verified.

### Notable Transitive Dependencies

| Package | License | Notes |
|---------|---------|-------|
| argparse | Python-2.0 | PSF License - permissive, compatible |
| sax | BlueOak-1.0.0 | Modern permissive license |
| tslib | 0BSD | Zero-clause BSD - maximally permissive |
| multiformats | Apache-2.0 OR MIT | Dual-licensed, choose either |
| @multiformats/sha3 | Apache-2.0 AND MIT | Both apply |

### License Distribution (Production)

| License | Count |
|---------|-------|
| MIT | 52 |
| ISC | 8 |
| Apache-2.0 | 3 |
| BSD-3-Clause | 2 |
| BlueOak-1.0.0 | 1 |
| Python-2.0 | 1 |
| 0BSD | 1 |

---

## Downloaded Runtime Artifacts

### Ant (antd, Swarm Node)

- **Source:** https://github.com/freedom-hq/ant
- **License:** MIT OR Apache-2.0 (upstream ships `LICENSE-MIT` and `LICENSE-APACHE`)
- **Risk:** Green
- **Integration:** Separate process via IPC
- **Action Required:** Include the MIT/Apache notice in THIRD_PARTY_NOTICES

### freedom-ipfs (Native IPFS Addon)

- **Source:** https://github.com/solardev-xyz/freedom-ipfs
- **Version:** 0.4.1
- **License:** MIT OR Apache-2.0
- **Risk:** Green
- **Integration:** Native addon loaded by the Electron main process
- **Action Required:** Include MIT/Apache notice in third-party notices

### libradicle (Native Radicle Addon)

- **Source:** https://github.com/solardev-xyz/libradicle
- **Version:** 0.3.0
- **License:** MIT OR Apache-2.0
- **Risk:** Green
- **Integration:** Native addon loaded by the Electron main process
- **Action Required:** Include the MIT/Apache notice in third-party notices

---

## Electron Framework

- **License:** MIT
- **Risk:** Yellow (requires notice)
- **Notes:** Electron bundles Chromium which contains hundreds of third-party components under various permissive licenses.

### Action Required

Electron generates a `LICENSES.chromium.html` file containing all Chromium third-party notices. This should be:
1. Shipped with the application, OR
2. Referenced in the third-party notices file with a link to Electron's upstream notices

---

## Native Addons

### better-sqlite3

- **License:** MIT
- **Bundled Component:** SQLite (public domain)
- **Risk:** Green
- **Notes:** SQLite is in the public domain and creates no licensing obligations. The better-sqlite3 wrapper is MIT licensed.

### freedom-ipfs native addon

- **License:** MIT OR Apache-2.0
- **Bundled Component:** Rust `freedom-ipfs` retrieval node exposed through a Node/Electron addon
- **Risk:** Green
- **Notes:** Desktop artifacts are pinned by release tag and SHA-256 checksums in `scripts/fetch-freedom-ipfs-native.js`.

---

## Assets

| Asset | Type | License |
|-------|------|---------|
| assets/icon.png | Icon | Proprietary (Freedom Team) |
| assets/icons/*.png | Icons | Proprietary (Freedom Team) |

All icons appear to be original works by the Freedom Team.

---

## Dev Dependencies (Not Bundled)

Dev dependencies are not shipped with the application and do not affect the license of the distributed product.

Notable licenses in dev dependencies:
- **caniuse-lite:** CC-BY-4.0 (requires attribution if distributed, but it's not)
- All others: MIT, ISC, BSD, Apache-2.0

---

## Notice Requirements

Include attributions for:

1. **Electron** - MIT License, Copyright (c) Electron contributors
2. **Chromium** - BSD-style license (reference LICENSES.chromium.html)
3. **Ant (Swarm)** - MIT OR Apache-2.0, Copyright (c) solardev-xyz contributors
4. **freedom-ipfs** - MIT OR Apache-2.0, Copyright (c) 2026 Freedom IPFS contributors
5. **libradicle** - MIT OR Apache-2.0, Copyright (c) solardev-xyz contributors
6. **All npm production dependencies** with MIT/ISC/BSD/Apache licenses

## Ship License Files (Recommended)

Consider bundling license files in the distributed app:
- `resources/licenses/LICENSE` (MPL-2.0 for Freedom Browser)
- `resources/licenses/NOTICES`
- Reference to Electron's LICENSES.chromium.html

---

## Copyleft Analysis

### GPL/AGPL/LGPL Status: NONE FOUND

Searched all:
- Production npm dependencies (67 packages)
- Dev npm dependencies (~650 packages)
- Downloaded runtime artifact licenses
- Bundled assets

No copyleft licenses were detected.

### Why This Matters

MPL-2.0 is a "weak copyleft" license that:
- Requires source disclosure only for MPL-licensed files that are modified
- Is compatible with most permissive licenses (MIT, BSD, Apache, ISC)
- Does NOT require the entire combined work to be open-sourced (unlike GPL)
- Allows combination with proprietary code

Since all dependencies are permissively licensed, there are no additional copyleft obligations beyond MPL-2.0's own requirements.

---

## Compatibility Matrix

| Dependency License | MPL-2.0 Compatible | Notes |
|-------------------|-------------------|-------|
| MIT | Yes | Permissive, no conflict |
| ISC | Yes | Permissive, no conflict |
| BSD-2-Clause | Yes | Permissive, no conflict |
| BSD-3-Clause | Yes | Permissive, attribution required |
| Apache-2.0 | Yes | Permissive, patent grant |
| 0BSD | Yes | Public domain equivalent |
| BlueOak-1.0.0 | Yes | Modern permissive |
| Python-2.0 (PSF) | Yes | Permissive |
| CC0-1.0 | Yes | Public domain dedication |
| WTFPL | Yes | Permissive (humorous) |
| CC-BY-4.0 | Yes* | Attribution required, but only in dev deps |

---

## Summary

Freedom Browser can be released under MPL-2.0 with confidence. The dependency stack is clean:

- **Zero GPL/AGPL/LGPL dependencies**
- **All runtime dependencies are permissively licensed**
- **Downloaded runtime artifacts are permissively licensed**
- **Native addons are permissively licensed**
- **Assets appear to be original works**

### Checklist Before Release

- [x] Add `LICENSE` file with MPL-2.0 text
- [x] Update `package.json` license field to "MPL-2.0"
- [x] Remove `"private": true` from `package.json`
- [ ] Keep third-party notices current with Ant, freedom-ipfs, libradicle, Electron/Chromium, and npm dependencies
- [ ] Add MPL-2.0 header comments to source files (optional but recommended)
- [ ] Include or reference Electron's Chromium license notices

---

*Generated by automated license audit. Last updated: 2026-08-19*
