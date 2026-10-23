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
Electron 44.3.0 / `NODE_MODULE_VERSION` 149 during the Electron 43 → 44 bump,
and again on 44.4.1 — same `NODE_MODULE_VERSION` — during the #346 bump).
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
  demand. The app starts cleanly with the old repo present; this isolation is
  verified by `src/main/__tests__/integration/v08-upgrade.test.js`.
- **Legacy Kubo repo cleanup (#101).** Policy: the orphaned Kubo repo is
  **deleted**, once, on the first launch that finds it; everything in
  `ipfs-data/` goes except `ipfs-data/freedom-ipfs/`, which is never touched.
  Nothing in it is worth keeping: the blockstore is a content-addressed cache
  freedom-ipfs re-fetches from the network and cannot import; the Kubo identity
  in `config` was either vault-derived (re-derivable from the seed) or Kubo's
  own `ipfs init` key with nothing published under it; and Freedom never
  created IPNS keys in `keystore/` or added/pinned content. The one accepted
  loss is content a user pinned into Freedom's node by hand through Kubo's
  local API port 5001, which that node has not served since 0.8.0. Leaving it
  would hold up to several GB of the user's disk forever. `setAsideLegacyKuboRepo()` in
  `src/main/migrate-user-data.js` renames the entries into
  `<profile>/.legacy-kubo-data-pending-delete/` before IPFS starts (instant,
  so startup is not slowed), and `purgeSetAsideLegacyKuboData()` deletes that
  off the main thread once the first window is up. It is retry-safe without a
  marker file: it acts while any Kubo marker entry (`blocks/`, `datastore/`,
  `keystore/`, `datastore_spec`, `version`, `config`) is still in `ipfs-data/`,
  moves those markers last (`config` last of all) and stops at the first
  failed rename, so an interrupted run leaves a marker for the next launch; an
  unfinished purge is picked up the same way. A `FREEDOM_IPFS_DATA` override
  skips the cleanup, since that directory is not Freedom's to judge.
- **Content discovery.** The native node finds providers for a CID (and IPNS
  records) through two delegated routers, queried in parallel with the answers
  merged: `https://delegated-ipfs.dev/routing/v1` and
  `https://cid.contact/routing/v1` (`DELEGATED_ROUTERS` in
  `src/main/ipfs/freedom-ipfs-native-node.js`), with a light DHT lookup as the
  fallback. Both services see the CIDs and IPNS names the user loads. Before
  #700 only the addon's built-in default (delegated-ipfs.dev) was asked; when
  that one lookup failed, the DHT fallback found no usable provider and pages
  failed with `502 … no HTTP-capable providers found`. There is no setting or
  environment variable for the list. The addon uses the same list for IPNS
  record lookups, and in freedom-ipfs v0.4.6 any endpoint's 404 makes the
  lookup report "not found". cid.contact always answers 404 for IPNS, so when
  delegated-ipfs.dev is unreachable an `/ipns/<key>` load fails as "name not
  found" rather than as a network error. Only the error message is wrong:
  nothing is cached, and a retry works once the network recovers. Tracked in
  https://github.com/solardev-xyz/freedom-ipfs/issues/30.
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
FREEDOM_IPFS_BACKEND=addon npm run ipfs:native:smoke
npm test
```

`FREEDOM_IPFS_BACKEND=addon npm run ipfs:native:smoke` loads the real native
addon, starts it, serves an identity CID through the local gateway, and
retrieves an immutable, widely provided `/ipfs/<cid>` from the live network
through the native request API; without the variable, the smoke runs the same
checks against freedom-ipfsd, the app's default (freedom-core design 0007).
Network-only live failures (HTTP 502/504 with no addon error code, and
timeouts) are retried within a bounded budget and then reported as a GitHub
Actions warning rather than a failure; addon faults (a 500, a 503
`gateway_busy`, any 4xx or wrong body) still fail. The issue #102 high-fanout
check (`FREEDOM_IPFS_NATIVE_SMOKE_ISSUE_102=1`) treats its root page fetch the
same way. Set `FREEDOM_IPFS_NATIVE_SMOKE_LIVE=strict` (or
`FREEDOM_IPFS_NATIVE_SMOKE_ISSUE_102=strict`) to make network failures fail, or
`FREEDOM_IPFS_NATIVE_SMOKE_LIVE=0` for startup/diagnostics-only checks. The
script header lists every environment variable.

The backend contract suite (`src/main/ipfs/ipfs-backend.contract.test.js`,
freedom-core design 0007) drives `ipfsBackend()` and the `ipfs:` handler against
the real addon, serving content built by the test from loopback servers only
(`test/helpers/ipfs-fixture.js`). It is skipped unless a backend is named:

```sh
npm run ipfs:download
FREEDOM_IPFS_CONTRACT_BACKEND=addon npx jest src/main/ipfs/ipfs-backend.contract.test.js
```

Its `[pending: …]` tests cover what the design adds and the addon lacks. They
run against a backend that honours them, or with
`FREEDOM_IPFS_CONTRACT_PENDING=all` (or a comma-separated list of features).
