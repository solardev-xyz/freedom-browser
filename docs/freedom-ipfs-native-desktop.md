# Desktop freedom-ipfs Native Integration

This branch replaces the bundled Kubo process with the `freedom-ipfs` native
request/event API. Electron now serves `ipfs://` and `ipns://` resources through
an in-process Node native addon instead of forwarding every request to a
loopback HTTP gateway.

## Shape

```text
Electron protocol handler
  -> IpfsManager.serveNativeGatewayRequest()
  -> FreedomIpfsNativeNode
  -> freedom-ipfs C ABI
  -> GatewayCore
```

The Rust HTTP gateway still exists in the `freedom-ipfs` repo for CLI/debug and
third-party users. The desktop browser branch does not start it.

## Native Addon

Install the pinned `freedom-ipfs` native addon:

```sh
npm run ipfs:download
```

By default this downloads and verifies the pinned addon for the current desktop
target from the `freedom-ipfs` `v0.4.1` GitHub release:

```text
https://github.com/solardev-xyz/freedom-ipfs/releases/tag/v0.4.1
```

Pinned release assets currently cover macOS arm64, Linux x64, and Windows x64.

The asset filenames read `freedom-ipfs-node-electron41-<target>.tar.gz`. The
`electron41` part is the **build label** of the Electron the upstream release
was produced against — it is not an ABI gate, and it does not mean the addon
only loads on Electron 41. The addon is Node-API (`napi_register_module_v1`,
`napi` level 10), so it is ABI-stable across Node and Electron majors: the same
file loads on plain Node and on the Electron the app ships (verified on
Electron 44.3.0 / `NODE_MODULE_VERSION` 149 during the Electron 43 → 44 bump).
Do not read the version in the filename as a compatibility claim.

The output is staged in both places the app needs:

- `native/freedom-ipfs-node/build/Release/freedom_ipfs_native.node`
- `native/freedom-ipfs-node/prebuilds/<target>/freedom_ipfs_native.node`

`build/Release` is the local development load path. `prebuilds/<target>` is the
Electron Builder packaging input, so cross-target builds cannot accidentally
reuse a `.node` file built for the host machine.

To build from a local Rust checkout instead, use:

```sh
npm run ipfs:build
```

Or point at a specific checkout:

```sh
FREEDOM_IPFS_RUST_REPO=/path/to/freedom-ipfs npm run ipfs:build
```

The checkout override is passed to both Cargo and node-gyp, so the addon links
against the same Rust static library that was just built.

The packaged app includes the `.node` addon via Electron Builder
`extraResources` from `native/freedom-ipfs-node/prebuilds/${os}-${arch}/`.

## Runtime Notes

- Kubo is not downloaded, launched, configured, or packaged on this branch.
- Existing local `ipfs-bin/` directories can remain on disk for other branches;
  they are not part of this branch's runtime path.
- Native node data is stored under `ipfs-data/freedom-ipfs/` in development (or
  the `freedom-ipfs/` child of `FREEDOM_IPFS_DATA` when that override is set).
- **Upgrade behavior (Kubo → freedom-ipfs).** A pre-v0.8.0 install carries a
  Kubo-shaped `ipfs-data/` repo (`config`, `blocks/`, pins). On upgrade this
  repo is **not** migrated: the native node uses its own `ipfs-data/freedom-ipfs/`
  subdirectory, so no Kubo identity (PeerID), blocks, or pins carry over —
  native IPFS identity is ephemeral and content reloads from the network on
  demand. The old Kubo repo is left orphaned on disk (its dedicated cleanup is
  tracked in issue #101). The app starts cleanly with the old repo present;
  this isolation is verified by `src/main/__tests__/integration/v08-upgrade.test.js`.
- IPFS identity status is reported as ephemeral. Native `freedom-ipfs` does not
  consume or expose a durable vault-derived PeerID for read-only retrieval in
  this release.
- `window.ipfs.getStatus()` now reports `freedom-ipfs` diagnostics, including
  native version/build metadata and native gateway stats, instead of polling
  Kubo's HTTP API.
- The protocol handler keeps the existing URL canonicalization rules but routes
  the final gateway path directly into the native node.

## Verification

Useful checks:

```sh
npm run ipfs:download
npm run ipfs:native:smoke
npm test
```

`npm run ipfs:native:smoke` loads the real native addon, starts it, and retrieves
`/ipns/ipfs.tech/` through the native request API. Set
`FREEDOM_IPFS_NATIVE_SMOKE_LIVE=0` for startup/diagnostics-only checks.
