# Myotis checkpoint import extension

Freedom builds Myotis v0.1.9 from the source archive and additive patch pinned in
`source.json`. `npm run myotis:download` now builds for the current host; it cannot
restore the upstream addon that lacks checkpoint import. All Cargo dependencies
remain those in the authenticated release's unchanged `Cargo.lock`.

Prerequisites: Git, tar, a platform C toolchain and `rustup toolchain install 1.94
--profile minimal`. Windows requires the normal x64 MSVC build environment.
Cross-platform packages must receive an addon built on the target host together
with its `myotis-build.json`; the native CI matrix covers the five supported
platforms. The Linux Docker distribution recipes install these prerequisites.
No new upstream release or Freedom-hosted binary release is assumed.

The extension retains `init() === 25` and the existing `create()` API. It adds:

- `checkpointImportVersion() === 1`
- `createWithCheckpoint(network, dataDir, root, slot, resumeVerifiedState = false)`

The host must authenticate the chain-specific root and slot before calling. Only
Ethereum mainnet and Gnosis are accepted. Invalid roots, zero/unsafe/future slots
and non-absolute directories fail before storage mutation. Fresh import refuses
an existing chain snapshot. `resumeVerifiedState=true` is allowed **only** for a
host-owned generation originally created from the same authenticated chain/root/
slot; the host must validate its immutable generation record before enabling it.
Native snapshot validation and weak-subjectivity enforcement remain unchanged.
A stale recovery uses a new directory and `false`; no old snapshot is rewritten,
deleted or silently adopted.

The build downloads and verifies the pinned source archive, applies the verified
patch to fresh extracted source, builds with `--locked --release`, checks the
loaded API, and records source/patch/toolchain/addon hashes. Packaging checks the
manifest and actual addon hash, so stale vanilla artifacts fail closed. The addon digest is checked before packaging/signing; platform signing can
rewrite binary bytes, so the child checks ABI and extension capability at runtime.
Existing
installed files are preserved with `.previous-*` names outside the package filter.
The manifest is provenance for a locally trusted build process, not a remote
publisher signature or a claim of bit-for-bit reproducibility across OS toolchains.

Optional build inputs: `MYOTIS_SOURCE_ARCHIVE` selects an existing archive (its
hash is still checked); `MYOTIS_BUILD_CACHE` and `MYOTIS_CARGO_TARGET_DIR` select
local build/cache locations. `MYOTIS_DOWNLOAD_TARGET` may explicitly name the
current host target. Release/repository overrides and cross-target vanilla
downloads are rejected. To update the patch, regenerate its SHA-256 in source.json,
review the native change, rebuild and run the native capability/validation checks.
