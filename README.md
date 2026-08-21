# Freedom Browser

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Platform](https://img.shields.io/badge/platform-macOS%20|%20Linux%20|%20Windows-lightgrey)](https://github.com/solardev-xyz/freedom-browser/releases)

Freedom is a browser for the decentralized web, with Swarm, IPFS, Radicle, ENS, and Tezos Domains as first-class protocols.
It ships with integrated Swarm, IPFS, Radicle, and experimental Myotis nodes, enabling direct peer-to-peer network access without relying on centralized HTTP gateways. Radicle is available on macOS and Linux; the Windows build ships without Radicle until official Windows binaries are published upstream.

---

## Quick Start

1. **Install Node.js 18+**

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Download the node binaries (first time only):**

   ```bash
   npm run ant:download
   npm run ipfs:download
   npm run radicle:download
   npm run myotis:download
   ```

4. **Launch the app:**

   ```bash
   npm start
   ```

5. Swarm and IPFS nodes start automatically by default. Myotis is an opt-in embedded Ethereum light client under **Settings → Automatic Startup**. To use `rad://`, first enable **Settings → Experimental → Enable Radicle integration (Beta)**. Enter a Swarm hash, IPFS CID, Radicle ID, `bzz://` URL, `ipfs://` URL, `rad://` URL, or `.eth`/`.box`/`.wei`/`.gwei`/`.tez` domain in the address bar.

---

## Architecture

Freedom Browser is an Electron application. Protocol logic lives in the main process; the renderer is a modular UI layer that talks to it over IPC (channels defined in `src/shared/ipc-channels.js`). The main process manages node lifecycles (`ant-manager.js`, `ipfs-manager.js`, `myotis/myotis-manager.js`, `radicle-manager.js`, `tor-manager.js`), URL rewriting (`request-rewriter.js`), and persistent data (settings, bookmarks, history). A central `service-registry.js` tracks node endpoints, modes, and status, and broadcasts state to all windows — both node managers and the request rewriter read from it.

When a user enters a `bzz://`, `ipfs://`, `ipns://`, `rad://`, `.onion`, or ENS URL, the main process either dispatches to a custom protocol handler (`bzz`, `ipfs`, `ipns`) that proxies to the local node, rewrites the URL to the active gateway URL via the registry (`rad`), or routes `.onion` hosts through the active profile's Tor SOCKS5 endpoint. `rad://` handling is gated by the Radicle integration setting, and `.onion` routing is gated by the Tor integration setting. `bzz://` navigation is additionally gated by a cold-start probe (see next section). `ipfs://` / `ipns://` navigation goes straight to the native IPFS protocol handler, so no renderer warm-up probe is needed.

---

## Swarm Content Retrieval

A fresh Swarm node pulls chunks on-demand through the DHT, and any individual chunk lookup can transiently fail with `HTTP 404` even when the content is healthy and peers are connected. Across a page with 10–30 sub-resources (JS, CSS, fonts, images, video), a modest per-request failure rate compounds into visibly broken CSS, missing images, and videos that don't load. Retries almost always succeed — the problem is strictly first contact with cold content.

Freedom mitigates this in two layers:

1. **Navigation probe** (`src/main/swarm/swarm-probe.js`) — before loading a `bzz://` URL, the main process HEAD-polls `/bzz/<hash>` on the local node's gateway with exponential backoff (30 s per attempt, 5 min overall). The tab spinner runs during the probe, so the user never sees the node's raw 404 JSON; on timeout or node-unreachable we route to `error.html` with the original URL preserved and a **Try Again** button. Probes are cancellable.

2. **Custom `bzz:` scheme** (`src/main/swarm/bzz-protocol.js`) — `bzz` is registered as a privileged standard scheme, so `bzz://<hash>/` becomes the page origin in Chromium. Every `bzz://` request (top-level, sub-resources, `fetch`, media `Range`, CSS descendants, service workers) routes through a main-process handler that proxies to the local node's gateway, always sets `Swarm-Chunk-Retrieval-Timeout` + `Swarm-Redundancy-Strategy: 3` + `Swarm-Redundancy-Fallback-Mode: true`, retries transient `5xx` on idempotent methods with bounded exponential backoff (~50 s total) with a 30 s per-attempt deadline, and streams the response back. `404` responses are surfaced immediately so SPAs that feature-detect missing endpoints don't stall — the cold-start case that 404 retries used to absorb is now handled upstream by the navigation probe. Because `bzz://<hash>/` is the origin, same-origin relative paths (`/foo.js`, `url(/bg.png)`) resolve naturally with no URL rewriting.

The handler also accepts Ethereum-named hosts: `bzz://swarm.eth/...`, `bzz://site.wei/...`, and `bzz://apoorv.gwei/...` resolve the contenthash via the in-process name resolver (cache hit after address-bar resolution) and proxy the same way. The page's URL/origin stays `bzz://<name>/` rather than the resolved hash, so DevTools, `window.location`, storage, and subresource fetches like `fetch('bzz://swarm.eth/data')` see the name. Cross-transport mismatches (e.g. `bzz://name.eth`, `bzz://name.wei`, or `bzz://name.gwei` whose contenthash is IPFS) return `404` with an explanatory body — the typed scheme is treated as an assertion. The renderer's address-bar pipeline applies the same assertion before navigating, so both layers agree.

> **Origin model.** `bzz://swarm.eth` and `bzz://<resolved-hash>` are different origins from Chromium's perspective — cookies, localStorage, IndexedDB, and service workers are not shared between them. This mirrors HTTPS, where `https://example.com` and `https://192.0.2.1` are also different origins even when they resolve to the same server. Pinning storage to the ENS name keeps state stable across contenthash updates.

### Migrating Swarm sites to the `bzz://` scheme

Versions of Freedom before this change loaded `bzz://<hash>/path` by rewriting it to the gateway URL `http://127.0.0.1:1633/bzz/<hash>/path` and navigating there. Pages saw `window.location.protocol === 'http:'` and `window.location.pathname === '/bzz/<hash>/path'`.

With the custom scheme, pages now see:

- `window.location.protocol === 'bzz:'`
- `window.location.host === '<hash>'`
- `window.location.pathname === '/path'` (the `/bzz/<hash>/` prefix is gone — it's encoded in the host)

Most sites work without changes — relative URLs (`./assets/...`, `/foo.js`, `url(bar.png)`) resolve naturally because `bzz://<hash>/` is the origin. Sites break only when they sniff `window.location` to construct absolute gateway URLs.

**Anti-pattern 1: protocol/pathname sniffing** (e.g. tile servers, Leaflet maps):

```js
// ✗ Old pattern — assumes the page is served from a gateway URL
const urlServer = window.location.protocol === 'http:' ? '' : 'http://localhost:1633';
const bzzMatch = window.location.pathname.match(/^\/bzz\/([\dA-Fa-f]{64})\//);
const bzzRoot = bzzMatch ? `/bzz/${bzzMatch[1]}/` : '';
const tileUrl = `${urlServer}${bzzRoot}{z}/{x}/{y}.png`;

// ✓ New pattern — relative URLs work from any origin (gateway or bzz://)
const tileUrl = './{z}/{x}/{y}.png';
```

**Anti-pattern 2: appending `/bzz/<ref>/` to `window.location.origin`** (e.g. SPAs fetching feeds, manifests, or other Swarm refs from JS):

```js
// ✗ Old pattern — works under http://127.0.0.1:1633, builds garbage under bzz://
//   becomes: bzz://<app-hash>/bzz/<feedRef>/  → 404
const feedUrl = `${window.location.origin}/bzz/${feedRef}/`;

// ✓ New pattern — point at the content ref directly with the bzz:// scheme
const feedUrl = `bzz://${feedRef}/`;

// ✓ Or, to support both gateway and native scheme modes:
const feedUrl =
  window.location.protocol === 'bzz:'
    ? `bzz://${feedRef}/`
    : `${window.location.origin}/bzz/${feedRef}/`;
```

**When you really need an absolute URL to your own bzz root:**

```js
const bzzRoot =
  window.location.protocol === 'bzz:'
    ? `bzz://${window.location.host}/`
    : `/bzz/${window.location.pathname.match(/^\/bzz\/([\dA-Fa-f]{64})\//)?.[1]}/`;
```

Don't hardcode `http://localhost:1633` — Freedom users may have their Swarm node on a different port, and external visitors via a public Swarm gateway certainly do.

---

## IPFS / IPNS Content Retrieval

`ipfs` and `ipns` are registered as privileged standard schemes (`src/main/ipfs/ipfs-protocol.js`), mirroring how `bzz` is wired up. Every `ipfs://<cid|name>/...` and `ipns://<key|name>/...` request — top-level navigation, sub-resources, `fetch`, media `Range`, CSS `url(...)`, service workers — flows through a main-process handler that calls the embedded `freedom-ipfs` native request API and streams the response back. Because `ipfs://<cid>/` (or `ipfs://<name>/`) is the page origin, `window.location.protocol === 'ipfs:'`, same-origin relative paths Just Work, and storage (cookies, localStorage, IndexedDB, service workers) is keyed to the content reference.

The native request API accepts the same `/ipfs/...` and `/ipns/...` gateway-path shape, but Freedom no longer starts a loopback Kubo gateway or HTTP API for desktop IPFS. Status and progress shown in the UI come from native `freedom-ipfs` diagnostics.

ENS-named hosts work the same way as for `bzz`: `ipfs://vitalik.eth/...` resolves the contenthash via the in-process ENS resolver (cache hit after the address-bar resolution) and proxies the same way. The page's URL/origin stays `ipfs://<name>/` rather than the resolved CID. Cross-transport mismatches (e.g. `ipfs://name.eth` whose contenthash is Swarm or IPNS) return `404` with an explanatory body — the typed scheme is treated as an assertion, matching the `bzz` handler's behaviour. Unlike `bzz`, the IPFS handler doesn't wrap its requests in a retry loop, and `4xx` / `5xx` responses pass through to the page so SPAs that feature-detect missing endpoints can render their own fallback.

> **Origin model.** Same as `bzz`: `ipfs://vitalik.eth` and `ipfs://<resolved-cid>` are different origins from Chromium's perspective. Pinning storage to the ENS name keeps state stable across contenthash updates.

### CID & IPNS-key canonicalisation

Because `ipfs:` and `ipns:` are standard schemes, Chromium's URL parser treats the host segment as a hostname and lowercases it. The base58btc encodings used by CIDv0 (`Qm...`), CIDv1 base58btc (`z...`), and IPNS peer-ID multihashes (`12D3Koo...`, `16Uiu2H...`, `Qm...`) are case-sensitive, so a naïve `ipfs://Qm.../path` would arrive at the protocol handler as `ipfs://qm.../path` — different bytes, and the IPFS backend rejects it.

The address-bar / load pipeline in `src/renderer/lib/url-utils.js` (`formatIpfsUrl` → `parseIpfsInput`) canonicalises on the way in, before `new URL` sees the input:

- CIDv0 `Qm...` → CIDv1 base32 `bafy...`
- CIDv1 base58btc `z...` → CIDv1 base32 `b...`
- base58btc IPNS peer ID → libp2p-key base36 (`k51...` for Ed25519, `k2k4...` for sha2-256)

All target encodings are lowercase, so subsequent host normalisation by Chromium is a no-op. DNSLink names (`docs.ipfs.tech`) and ENS names (`vitalik.eth`) fall through unchanged — they're not base58btc and don't suffer the case issue. The encoders live in `src/renderer/lib/cid-utils.js` (kept inline because the renderer has no bundler).

If you click a `<a href="ipfs://Qm.../">` link inside a page (rather than typing into the address bar), the webview preload intercepts the click in capture phase and reads the raw DOM attribute (`getAttribute('href')`) before Chromium resolves and lowercases the URL. It then sends that original mixed-case href to the host renderer, which routes it through `formatIpfsUrl`, so embedded link clicks canonicalise the same way address-bar input does. The interceptor covers same-tab clicks (`click` event) **and** modified-click / middle-click / `target="_blank"` / named-target dispositions (`auxclick` for real middle-click, since modern Chromium dispatches `click` only for the primary button) — without that, the new-window code path (Chromium → `setWindowOpenHandler` → `tab:new-with-url`) would receive the URL after Chromium had already lowercased the host, and case-sensitive bytes would be lost. The renderer's `link:navigate` IPC handler dispatches by disposition: same-tab calls go through `loadTarget`, new-tab calls go through `openInNewTabWithTarget` (the same helper the IPC `tab:new-with-url` path uses), so a `target="docs"` named target reuses an existing `docs` tab the way it does for plain HTTPS links.

Direct sub-resource fetches (`<img src>`, `<script src>`, `<video src>`, `fetch()`, CSS `url(...)`) cannot be intercepted in JS — by the time the request reaches the protocol handler, Chromium has already lowercased the host and the original CIDv0/base58btc bytes are gone. The handler detects this case and returns a clear `400` with an actionable message ("Publish the resource with its CIDv1 base32 (`bafy...`) form for sub-resource use.") rather than forwarding a guaranteed-bad reference to the native gateway. The same `400`-with-explanation path covers lowercased CIDv1 base58btc (`z...`) hosts and lowercased base58btc IPNS keys. **Site-author guidance:** when emitting `<img src>` / `<script src>` / `fetch()` URLs in your own HTML, use CIDv1 base32 (`ipfs://bafy.../...`) and libp2p-key base36 (`ipns://k51.../...`) forms; both are case-insensitive and round-trip cleanly through Chromium's URL parser.

### Path-gateway URL form (`ipfs://<gateway>/ipfs/<cid>/...`)

Gateway directory listings and gateway-authored pages can emit protocol-relative anchors like `<a href="//localhost:8080/ipfs/<cid>">CID</a>`. When the page origin is `ipfs://<cid>/`, Chromium resolves these against the page scheme and ends up with `ipfs://localhost/ipfs/<cid>` — which is no longer a valid IPFS reference (`localhost` isn't a CID). The same shape appears for absolute public-gateway links (`ipfs://dweb.link/ipfs/<cid>/...`, `ipfs://ipfs.io/ipfs/<cid>/...`, `ipfs://cf-ipfs.com/ipfs/<cid>/...`, etc.).

`parseIpfsInput` (renderer) and `buildGatewayUrl` (main) both recognise this gateway-form path and rewrite it to the canonical `ipfs://<cid>/...` (or `ipns://<key>/...` for cross-namespace cases like `ipfs://localhost/ipns/...`, `ipfs://dweb.link/ipns/<dnslink-name>/...`). The disambiguation rule has two parts:

1. The **outer host** must be a recognised gateway. We use an explicit allowlist (`localhost`, `127.0.0.1`, `::1`, `*.localhost`, plus the most common public gateways: `dweb.link`, `ipfs.io`, `gateway.ipfs.io`, `cf-ipfs.com`, `cloudflare-ipfs.com`, `gateway.pinata.cloud`, `nftstorage.link`, `w3s.link`, `4everland.io`, `ipfs.fleek.co`, `dweb.eu.org`). Earlier versions used a negative "host doesn't look like a content reference" heuristic, which over-fired for DNSLink hosts (e.g. `ipns://docs.ipfs.tech/ipfs/coverage` would try to rewrite even though `docs.ipfs.tech` is the actual content host). Self-hosted gateways aren't matched — content authors with private gateways should publish canonical `ipfs://<cid>/...` URLs directly. The renderer-side check strips a trailing `:<port>` before the allowlist comparison so `ipfs://localhost:8080/ipfs/<cid>` (Chromium's resolution of a gateway-authored protocol-relative anchor against the page's `ipfs://` origin — the port is preserved because `ipfs:` has no default port) rewrites the same way `ipfs://localhost/ipfs/<cid>` does.
2. The **embedded ref** must be a CID or IPNS key (`/ipfs/<ref>` and `/ipns/<ref>`), with the additional concession that `/ipns/` also accepts DNSLink-shaped names so `ipfs://dweb.link/ipns/docs.ipfs.tech/install` rewrites to `ipns://docs.ipfs.tech/install`. The legitimate `ipfs://<cid>/ipfs/<subfile>` shape (a real subdirectory named `ipfs`) keeps loading from the host CID — the host CID isn't in the gateway list, so the path stays as-is.

For top-level navigation, the renderer rewrite means the address bar and page origin both end up canonical. For sub-resource fetches that go through the protocol handler directly, the bytes load but the URL Chromium associates with the resource stays in the gateway-host form — acceptable for sub-resources since they don't establish their own origin.

### Migrating IPFS sites to the `ipfs://` / `ipns://` scheme

Versions of Freedom before this change loaded `ipfs://<cid>/path` by rewriting it to the path-gateway URL `http://127.0.0.1:8080/ipfs/<cid>/path` and navigating there — Chromium then followed Kubo's subdomain redirect to `http://<cidv1>.ipfs.localhost:8080/path`. Pages saw `window.location.protocol === 'http:'` and a host like `<cidv1>.ipfs.localhost`.

With the custom scheme, pages now see:

- `window.location.protocol === 'ipfs:'` (or `'ipns:'`)
- `window.location.host === '<cid>'` (or `<name>`, `<key>`)
- `window.location.pathname === '/path'` (the `/ipfs/<cid>/` prefix is gone — it's encoded in the host)

The Swarm migration guidance in the previous section applies verbatim — same anti-patterns (protocol/pathname sniffing, appending `/ipfs/<cid>/` to `window.location.origin`), same fixes (relative URLs, or use the native scheme directly):

```js
// ✗ Old pattern — assumes the page is served from the gateway
const apiBase = window.location.origin + '/ipfs/' + dataCid + '/';

// ✓ New pattern — use the ipfs:// scheme directly
const apiBase = `ipfs://${dataCid}/`;
```

Don't hardcode `http://localhost:8080` — Freedom no longer exposes a desktop IPFS loopback gateway, and external visitors via a public IPFS gateway may arrive through any gateway host.

---

## Features

### Integrated Node Architecture

Freedom runs Swarm, IPFS, Radicle, and Tor nodes, plus an experimental Myotis Ethereum light client, giving you access to decentralized and onion networks from a single interface.

|                      | Swarm          | IPFS                                  | Myotis                         | Radicle                        | Tor (.onion)                  |
| -------------------- | -------------- | ------------------------------------- | ------------------------------ | ------------------------------ | ----------------------------- |
| **Protocol**         | `bzz://`       | `ipfs://`, `ipns://`                  | Verified Ethereum/Gnosis reads and transaction broadcast | `rad://`                       | `http(s)://*.onion`           |
| **Node Software**    | Ant (antd, bee-compatible) | freedom-ipfs native      | Myotis native addon            | radicle-node + radicle-httpd   | Arti SOCKS5 proxy             |
| **Hash Format**      | 64 or 128-char hex (encrypted refs supported) | CIDv0 (`Qm...`) or CIDv1 (`bafy...`) | n/a                            | Repository ID (`z...`)         | Onion service hostname        |
| **Managed Gateway Port** | 11633+     | internal native handler               | none; embedded native client   | 18780+                         | n/a                           |
| **Managed API Port** | 11633+         | internal native handler               | none; embedded native client   | 18780+                         | n/a                           |
| **Managed P2P Port** | 12633+         | internal native handler               | none; embedded native client   | 18776+                         | n/a                           |
| **Managed SOCKS Port** | n/a         | n/a                                   | n/a                            | n/a                            | 19150+                        |
| **Route Prefix**     | `/bzz/{hash}/` | `/ipfs/{cid}/`, `/ipns/{name}/`       | n/a                            | `/api/v1/repos/{rid}/`         | SOCKS5 for `.onion` hosts     |
| **Data Directory**   | `<profile>/ant-data/` | `<profile>/ipfs-data/freedom-ipfs/` | `<profile>/myotis/` (Ethereum) and `<profile>/myotis/gnosis/` | profile-scoped short Radicle home | `<profile>/tor-data/`         |
| **Binary Directory** | `ant-bin/`     | `native/freedom-ipfs-node/`           | `myotis-bin/`                  | `radicle-bin/`                 | `arti-bin/`                   |

### Smart Node Connection

Freedom manages nodes per browser profile:

1. **Independent Managed Nodes**: By default, each profile starts its own Ant, native IPFS, Myotis, Radicle, and Arti data directories. Ant, Radicle, and Tor use profile-specific non-default ports; IPFS and Myotis are embedded native clients without loopback API or gateway ports.
2. **Explicit External Nodes**: Profiles can opt into external Swarm/Radicle endpoints or an external Tor SOCKS5 endpoint in profile settings. External node identity, storage, and circuit state are shared outside that profile. IPFS and Myotis always use their embedded native clients.
3. **Port Conflict Handling**: If a managed Ant, Radicle, or Tor profile port is busy, Freedom picks a free profile port and persists the reassignment.
4. **Visual Feedback**: The Nodes panel and profile settings show whether a node is managed, external/shared, or disabled.

This means Freedom works seamlessly whether you:

- Run it standalone (bundled Swarm and native IPFS nodes start automatically; Radicle is optional and behind an Experimental setting)
- Create multiple independent browser profiles with their own browser data, vault, and managed node state
- Already have system-wide Swarm/Radicle daemons running and explicitly configure a profile to use them
- Have port conflicts with other software (Freedom finds and records available profile ports)

On macOS, the packaged app explicitly allows multiple bundle instances so profile
launching can use `open -n -a Freedom --args --profile=<id>`.

### Integrated Swarm Node (Ant)

- **Toolbar Toggle**: Click the network icon to access the Nodes panel with independent on/off switches.
- **Live Statistics**: View connected peers, visible network peers, and the Ant node version in real-time.
- **DHT Client Mode**: Runs in ultra-light mode for minimal bandwidth and resource usage.
- **Automatic Configuration**: First-run setup generates keys and config automatically.

### Integrated IPFS Native Node

- **Independent Toggle**: Start and stop IPFS separately from Swarm.
- **Native Transport**: Uses the embedded `freedom-ipfs` native addon instead of a loopback Kubo process.
- **Live Diagnostics**: View native gateway stats and request progress while IPFS/IPNS pages load.

### Integrated Myotis Ethereum Light Client (Experimental)

- **Per-profile clients**: Each profile has independent Ethereum and Gnosis runtimes and state, and never reuses a separately installed Myotis application.
- **Native transport**: Runs in-process through the Myotis native addon, with no HTTP API or managed port.
- **Independent controls**: Ethereum and Gnosis have separate autostart, runtime toggle, sync status, peer count, and finalized-block controls.
- **Chain data routing**: Wallet balances, transaction preparation, signed-transaction broadcast, and compatible dapp reads prefer Myotis, then Colibri verification, RPC quorum, and direct RPC according to each chain's settings. Unsupported methods transparently continue to the next source.
- **Gnosis verification**: Both Myotis and Colibri are available as verified Gnosis sources; Colibri keeps separate verifier state per chain.
- **Verified ENS reads**: Once synced, ENS content, address, and forward-verified reverse records are resolved against finalized Ethereum state before Freedom falls back to its configured verification method. ERC-3668/CCIP-Read records use their declared gateway only to retrieve the callback payload; Myotis verifies the callback against the same chain state.
- **WNS/GNS adapters**: Freedom executes the existing WNS and GNS NameNFT calls through Myotis's local EVM path. Myotis v0.1.7 serves generic contract calls from the beacon optimistic head without a finalized verdict, so the UI labels those answers unverified rather than overstating their trust.

### Integrated Radicle Node (macOS & Linux)

- **Two-Process Architecture**: Manages both `radicle-node` (P2P network) and `radicle-httpd` (HTTP API) as a coordinated pair.
- **Automatic Identity**: Creates a Radicle identity on first run (no manual setup required).
- **Experimental Gate**: Radicle is controlled via **Settings → Experimental → Enable Radicle integration (Beta)**.
- **Node Toggle**: Once enabled, start and stop Radicle from the Nodes panel.
- **Live Statistics**: View connected peers, seeded repos, version, and Node ID.
- **Repository Seeding**: Seed Radicle repositories directly from the browser to help replicate them across the network.
- **Stale Socket Cleanup**: Automatically cleans up control sockets from unclean shutdowns.
- **Port Conflict Resolution**: Uses profile-specific managed ports and persists reassignment if one is unavailable.
- **Windows**: Radicle is not available on Windows yet (no upstream binaries). The Experimental settings section is hidden on Windows builds.

### Universal Address Bar

Enter any of the following in the address bar:

| Input Type  | Example                                         |
| ----------- | ----------------------------------------------- |
| Swarm Hash  | `a1b2c3...` (64 or 128 hex characters)          |
| Swarm URL   | `bzz://a1b2c3.../path/to/file.html`             |
| IPFS CID    | `QmHash...` or `bafybeic...`                    |
| IPFS URL    | `ipfs://QmHash.../path`                         |
| IPNS URL    | `ipns://k51...` or `ipns://domain.eth`          |
| Radicle ID  | `rad://z3gqc...`                                |
| Ethereum Name | `vitalik.eth`, `mysite.box`, `alice.wei`, `apoorv.gwei`, `mysite.eth/about` |
| Tezos Domain | `mysite.tez`, `ipfs://mysite.tez/docs` |
| HTTP(S) URL | `https://example.com`                           |
| Domain      | `example.com` (auto-prefixes `https://`)        |

The address bar also provides **autocomplete suggestions** from browsing history as you type.

### Ethereum Name Resolution

- **Automatic Resolution**: `.eth`, `.box`, `.wei`, and `.gwei` domains resolve to their Swarm, IPFS, or IPNS content. `.eth` and `.box` use ENS; `.wei` uses Wei Name Service (WNS); `.gwei` uses Gwei Name Service (GNS).
- **CCIP-Read Support**: `.box` domains resolve via offchain CCIP-Read (EIP-3668) through 3dns.xyz.
- **Ordered Resolution Policy**: Settings → Name Resolution presents Myotis, Colibri, RPC quorum, and direct RPC as one ordered list. Methods can be enabled, disabled, and reprioritized per profile. By default Freedom tries Myotis, then Colibri, then RPC quorum; direct RPC is disabled.
- **Verified-Answer Preference**: An unverified result can be held provisionally while later enabled methods try to produce a verified answer. If none succeeds, Freedom uses the provisional result and applies the configured warning behavior.
- **Protocol Detection**: Automatically detects and routes to Swarm (`bzz://`), IPFS (`ipfs://`), or IPNS (`ipns://`) content.
- **Transport-Aware Address Bar**: After resolution, the address bar shows the resolved transport with the name as the host — e.g. `vitalik.eth` resolves and displays as `ipfs://vitalik.eth`, a Swarm-backed `mysite.eth` displays as `bzz://mysite.eth`, a WNS-backed `alice.wei` displays as `ipfs://alice.wei`, and a GNS-backed `apoorv.gwei` displays as `ipfs://apoorv.gwei`. The legacy `ens://` form is still accepted as input (and stored bookmarks keep working) but is no longer the canonical display.
- **Typed Scheme Is an Assertion**: Typing `bzz://name.eth`, `ipfs://name.eth`, `ipns://name.eth`, or the equivalent `.wei`/`.gwei` forms only resolves if the contenthash matches the typed transport. Mismatches surface as a "resolves to X, not Y" message rather than silently switching transports — same rule the `bzz://` protocol handler enforces for subresource fetches. Bare names and the legacy `ens://` form make no assertion and accept any supported transport.
- **Path Forwarding**: Paths appended to names (e.g., `mysite.eth/docs`, `alice.wei/docs`, `apoorv.gwei/docs`) are preserved after resolution.
- **In-HTML Links**: Ethereum name links inside web pages must carry a scheme — `ens://name.eth`, `bzz://name.eth`, `ipfs://name.eth`, `ipns://name.eth`, `bzz://name.wei`, `ipfs://name.wei`, `ipns://name.wei`, `bzz://name.gwei`, `ipfs://name.gwei`, or `ipns://name.gwei`. Bare hrefs like `<a href="vitalik.eth">` are relative URLs by HTML/URL-spec rules and resolve against the page's base before any of our handlers see them; bare names are only resolved in the address bar, where input is always absolute.

### Tezos Domains Website Resolution

- **Native on-chain resolution**: Bare `.tez` names are resolved directly from the Tezos Domains mainnet registry through three public Tezos RPC endpoints. Freedom follows the upgradeable proxy, discovers the annotated records and expiry big maps, pins all providers to one block, and requires a 2-of-3 matching result before marking it verified. Set `TEZOS_RPC` to prepend an additional endpoint; it must serve Tezos **mainnet**, since the chain ID is verified on every lookup.
- **Published website records**: `web:redirect_url` takes precedence over `web:content_url`, matching Tezos Domains publishing semantics. HTTP(S) records navigate directly; IPFS and IPNS records stay on Freedom's native transports and keep the `.tez` name as the page origin.
- **Paths and assertions**: A base path embedded in the published URI is preserved when an address-bar path is appended. Typed `ipfs://name.tez` and `ipns://name.tez` forms assert that transport; `ens://name.tez` is intentionally rejected because `.tez` is not ENS.
- **Expiry and caching**: Expired domains do not resolve. Positive cache entries honor `td:ttl` within a bounded lifetime and never outlive the on-chain expiry; negative results use a short cache.

### Tabbed Browsing

- **Multiple Tabs**: Open multiple pages simultaneously with `Cmd+T`.
- **Tab Management**: Close tabs with `Cmd+W` or middle-click.
- **Audio Indicators & Mute**: Tabs playing sound show a speaker icon; click it (or use "Mute Tab" in the tab context menu) to mute or unmute the tab. Mute survives navigation within the tab.
- **Drag & Drop Reordering**: Rearrange tabs by dragging.
- **Per-Tab State**: Each tab maintains its own navigation history, address bar state, and bzz/ipfs base.
- **Link Handling**: Links that open new windows are captured and opened in new tabs instead.

### Navigation Controls

- **Back/Forward**: Standard browser history navigation per tab.
- **Reload**: Refresh the current page (ignores cache). On error pages, retries the original URL.
- **Stop**: Cancel page loading mid-request.
- **Home**: Return to the welcome page.
- **Keyboard Shortcuts** (defaults; remap them under Settings > Shortcuts — click a binding, press the new combination, changes apply immediately; `Cmd+Q`, the standard Cut/Copy/Paste/Select-All/Undo set, and `F12` stay reserved):
  - `Cmd+N` / `Ctrl+N`: New window
  - `Cmd+Shift+N` / `Ctrl+Shift+N`: New private window
  - `Cmd+T` / `Ctrl+T`: New tab
  - `Cmd+W` / `Ctrl+W` / `Ctrl+F4`: Close tab
  - `Cmd+Shift+T` / `Ctrl+Shift+T`: Reopen last closed tab
  - `Ctrl+PgDn` / `Ctrl+Tab`: Next tab
  - `Ctrl+PgUp` / `Ctrl+Shift+Tab`: Previous tab
  - `Ctrl+Shift+PgDn`: Move tab right
  - `Ctrl+Shift+PgUp`: Move tab left
  - `Cmd+R` / `Ctrl+R`: Reload (from cache)
  - `Cmd+Shift+R` / `Ctrl+Shift+R`: Hard reload (bypass cache)
  - `Cmd+F` / `Ctrl+F`: Find in page (`Enter` next match, `Shift+Enter` previous, `Esc` close)
  - `Cmd+Shift+B` / `Ctrl+Shift+B`: Toggle bookmark bar
  - `Cmd+Shift+J` / `Ctrl+Shift+J`: Downloads
  - `F11`: Toggle fullscreen
  - `F12` / `Cmd+Alt+I` / `Ctrl+Shift+I`: Developer Tools
  - `Cmd+=` / `Ctrl+=`: Zoom in
  - `Cmd+-` / `Ctrl+-`: Zoom out
  - `Cmd+0` / `Ctrl+0`: Reset zoom
  - `Cmd+P` / `Ctrl+P`: Print
  - `Escape`: Stop loading or restore address bar

### Bookmarks

- **Address Bar Star**: Click the star icon to bookmark or unbookmark the current page.
- **Supported Protocols**: Bookmark any `bzz://`, `ipfs://`, `ipns://`, `rad://`, `http://`, or `https://` URL.
- **Named Bookmarks**: Name and edit bookmarks via modal or right-click.
- **Bookmarks Bar**: Quick access below the toolbar, with an overflow menu when bookmarks don't fit. Always visible on the new tab page; toggle visibility on other pages with `Cmd+Shift+B` / `Ctrl+Shift+B` (persisted across sessions).

### Browsing History

- **Automatic Recording**: Pages are recorded as you browse.
- **History Page**: View and search your browsing history at `freedom://history`.

### Private Windows

- **Open**: `Cmd+Shift+N` / `Ctrl+Shift+N` (the default — remappable under Settings > Shortcuts, applies immediately) or File > New Private Window. Private windows have a dark, badged chrome so they're recognisable at a glance.
- **Ephemeral by construction**: Every private window runs its webviews on a unique in-memory session (`private-<uuid>` partition, never written to disk). Cookies, logins, caches, and site data evaporate when the window closes.
- **No local traces**: Nothing browsed in a private window is written to history, the favicon cache, or address-bar autocomplete. Downloads still work, but their entries are kept in memory only — never written to the profile's download database, visible only inside the private window, and gone when it closes (saved files stay on disk). Site-permission decisions made in a private window last only as long as the window — never remembered, even if you tick "remember".
- **Wallet disabled**: Your identity and wallet are persistent by design, so they are unavailable in private windows — pages see no `window.ethereum` / `window.swarm` / `window.radicle` (nothing announces via EIP-6963), and x402 pay-per-request interception is off. Use a normal window for anything wallet-related.
- **Decentralized protocols still work**: `bzz://`, `ipfs://`, `ipns://`, and ENS names resolve and load through the shared local nodes. Publishing (which records publish history) is unavailable from private windows.
- **What private windows do NOT protect**: This is local privacy, not anonymity. Websites you sign in to still know it's you; your network operator can still see your traffic; Swarm/IPFS/Radicle peers still see your nodes' requests; and your IP address remains visible to every site and peer. The private new-tab page spells this out.

### Downloads

- **Download Manager**: Every download — http(s), `bzz://`, `ipfs://`/`ipns://`, and data URIs — is tracked with progress, pause/resume, and cancel.
- **Shelf**: A compact card in the bottom corner shows progress and offers Cancel; on completion it offers Open and Show in Folder, then dismisses itself. Files are never opened automatically.
- **Downloads Page**: View and search download history at `freedom://downloads` (`Cmd+Shift+J` / `Ctrl+Shift+J`), with per-item open / show-in-folder / remove and Clear All.
- **Save Location**: Files land in the OS Downloads folder by default; enable "Ask where to save each file" under Settings > Downloads for a save dialog per download.

### Context Menus

Right-click on pages for context-sensitive actions:

- **Page Context**: Back, Forward, Reload, View Page Source, Inspect
- **Link Context**: Open Link in New Tab, Open Link in New Window, Copy Link Address
- **Selection Context**: Copy selected text
- **Image Context**: Open Image in New Tab, Save Image As, Copy Image, Copy Image Address
- **View Page Source**: Opens `view-source:` URL in a new tab

### Request Rewriting

- **Automatic Path Rewriting**: Absolute paths in decentralized content (e.g., `/images/logo.png`) are automatically rewritten to stay within the current hash/CID for IPFS (`/ipfs/`, `/ipns/`) and Radicle (`/api/v1/repos/`) content.
- **Per-Tab Tracking**: Each tab tracks its own content base for correct path resolution.
- **Swarm (`bzz://`)**: Handled by a custom protocol handler rather than gateway rewriting — see [Swarm Content Retrieval](#swarm-content-retrieval).

### Debug Console

- **Toggle via Menu**: Open the hamburger menu (☰) and click "Debug Console".
- **Console Logs**: Captures JavaScript console output from loaded pages.
- **Navigation Events**: Shows page load, navigation, and error events.
- **Timestamps**: All messages include timestamps for debugging.
- **Clear/Close**: Clear the log or close the panel with dedicated buttons.
- **CLI Logging**: Debug messages also appear in the terminal.

### Internal Pages

Access built-in browser pages using the `freedom://` protocol:

| Page                      | Description                  |
| ------------------------- | ---------------------------- |
| `freedom://home`          | Welcome/home page            |
| `freedom://downloads`     | Download manager             |
| `freedom://history`       | Browsing history             |
| `freedom://links`         | Link behavior test page      |
| `freedom://protocol-test` | Protocol and media test page |
| `rad://{rid}`             | Radicle repository browser   |

### Settings & UI

- **Theme**: Light, Dark, or System (follows OS preference).
- **Node Auto-start**: Toggle whether Swarm, IPFS, and experimental Myotis start automatically at launch. Myotis remains off by default.
- **Site Permissions**: When a site asks to use your camera, microphone, notifications, clipboard, location, or MIDI devices, a prompt appears under the address bar (Allow / Block, with "Remember for this site"). Remembered decisions are listed under Settings → Site Permissions with per-permission, per-site, and remove-all revocation; sites with granted permissions show an indicator icon in the address bar with quick revoke.
- **Experimental**: Enable Radicle integration (Beta) and set `Start Radicle node when Freedom opens`.
- **Auto-Updates**: Toggle automatic update checks (enabled by default).
- **Protocol Icons**: Address bar shows Swarm (hexagon), IPFS (cube), Radicle (seedling), or HTTP (globe) icon based on current protocol.
- **Hamburger Menu**: Access browser features (New Tab, New Window, History, Zoom, Print, Developer Tools, Settings, About).

### Error Handling

- **Friendly Error Pages**: Clear error messages with the original URL preserved.
- **Feature-Gated Radicle Errors**: Opening `rad://` while integration is disabled shows: `Radicle integration is disabled. Enable it in Settings > Experimental`.
- **Retry on Reload**: Pressing reload on an error page retries the original request.
- **Graceful Degradation**: Navigation errors don't crash the browser.

---

## Configuration

### Node Endpoints

Freedom automatically manages node connections per profile. The default profile's managed endpoints start at:

- **Swarm Ant**: `http://127.0.0.1:11633`
- **IPFS**: embedded native `freedom-ipfs` handler; no desktop loopback gateway/API port is started
- **Myotis**: embedded native Ethereum light client; no desktop loopback API or managed port is started
- **Radicle httpd**: `http://127.0.0.1:18780`
- **Tor Arti SOCKS5**: `127.0.0.1:19150`

Named profiles use the next profile slot for Ant, Radicle, and Tor (`11634`, `18781`, `19151`, and so on). The ecosystem default Swarm/Radicle/Tor ports (`1633`, `8780`, `9150`) are treated as external/system-node endpoints, not Freedom-managed defaults. IPFS and Myotis are native-only and do not expose or reuse external daemon ports.

If Freedom detects a compatible Swarm, Radicle, or Tor daemon on an ecosystem default port while that protocol is starting, it asks whether that profile should use the existing external node or keep an independent managed node. This check runs both during profile startup and when a managed node is started manually from the Nodes menu.

For advanced users who need to connect a profile to a remote or system Bee/Radicle node, or to an external Tor SOCKS5 endpoint, use **Settings → Profiles → Node endpoints** and switch the relevant protocol to external mode. Development-only renderer gateway overrides are still available via environment variables:

```bash
# Connect to a remote Swarm node
export ANT_API="http://remote-host:1633"

npm start
```

### External Protocol Links And Profiles

Inside Freedom, `bzz://`, `ipfs://`, `ipns://`, `rad://`, and `.onion` URLs always resolve through the active profile's node settings and storage. OS-level protocol launches from other apps are a v1 limitation: they are not profile-aware and should not be used when a link must open in a specific profile. Open the target profile first and paste or navigate to the URL inside that window.

### Ethereum Name Resolution

ENS, WNS, and GNS domains share an ordered, per-profile resolution policy. Myotis resolves through the embedded P2P light client, Colibri verifies remote proofs locally, RPC quorum requires byte-identical responses from independent providers, and direct RPC trusts one configured endpoint. ENS uses the ENS Universal Resolver; WNS reads the Wei Name Service contract directly; GNS reads the Gwei Name Service contract directly. Configure method order under **Settings → Name Resolution** and RPC endpoints under **Settings → Chains**.

**Recommended: Helios Light Client**

For trustless Ethereum data verification without running a full node, use [Helios](https://github.com/a16z/helios):

```bash
# Install Helios
curl https://raw.githubusercontent.com/a16z/helios/master/heliosup/install | bash
heliosup

# Run with an RPC provider
helios ethereum --execution-rpc https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY

# Configure Freedom to use local Helios
export ETH_RPC="http://127.0.0.1:8545"
npm start
```

### Home Page

Edit `src/renderer/pages/home.html` to customize the welcome view shown on startup or when clicking Home.

---

## NPM Scripts

| Script                                                        | Description                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `npm start`                                                   | Launch the Electron app                                     |
| `npm test`                                                    | Run unit tests (Jest)                                       |
| `npm run test:e2e`                                            | Run the harness E2E suite (stubbed nodes; fast, no network) |
| `npm run test:e2e:live`                                       | Run the live E2E suite (real Ant + IPFS + ENS; manual only) |
| `npm run test:e2e:tor`                                        | Run the live Tor `.onion` E2E suite (real Arti; manual only) |
| `npm run ant:download`                                        | Download the Ant (antd) binary for your platform            |
| `npm run ant:status`                                          | Check the default profile's Freedom-managed Ant (`11633`)   |
| `npm run system-ant:start` / `system-ant:status` / `system-ant:stop` | Run or inspect a repo-root system Ant on the ecosystem default port (`1633`) |
| `npm run ant:smoke-upload`                                    | Exercise the buy → upload → download round-trip on a node   |
| `npm run ipfs:download`                                       | Download the pinned freedom-ipfs native addon               |
| `npm run ipfs:native:smoke`                                   | Smoke test the real native addon and live IPFS retrieval    |
| `npm run ipfs:build`                                          | Build the freedom-ipfs native addon from source             |
| `npm run ipfs:reset`                                          | Remove legacy repo-root IPFS data                           |
| `npm run build -- --mac --unsigned`                           | Build unsigned macOS app (for local testing)                |
| `npm run dist -- --mac`                                       | Build signed macOS distributable (DMG + ZIP)                |
| `npm run dist:mac:prepare-notary`                             | Build signed macOS artifacts without notarization wait      |
| `npm run dist:mac:submit-notary`                              | Submit macOS artifacts to Apple asynchronously              |
| `npm run dist:mac:notary-status`                              | Check notarization status from saved receipts               |
| `npm run dist:mac:notary-log -- <submission-id>`              | Fetch notarization log JSON for a submission ID             |
| `npm run dist:mac:staple-notary`                              | Staple and validate accepted notarized artifacts            |
| `npm run dist:linux:arm64:docker`                             | Build Linux ARM64 via Docker (recommended)                  |
| `npm run dist:linux:x64:docker`                               | Build Linux x64 via Docker                                  |
| `npm run dist -- --win`                                       | Build Windows x64 distributable (NSIS + ZIP)                |

The `build` and `dist` scripts accept `--mac`, `--linux`, or `--win` with optional `--arm64`, `--x64`, `--unsigned`, `--no-notarize`, and `--verbose` flags. See `scripts/build.js` for details.

`ant:start` is kept as a legacy alias for the explicit `system-ant:start`
script. It uses repo-root `ant-data/`, which Freedom no longer uses for
profile-managed dev data.

### Radicle Scripts

| Script | Description |
|--------|-------------|
| `npm run radicle:download` | Download the Radicle binaries for your platform |
| `npm run radicle:init` | Initialize Radicle identity and configuration |
| `npm run radicle:status` | Check the default profile's Radicle httpd root endpoint |
| `npm run radicle:reset` | Delete all Radicle data and start fresh |

### Tor Scripts

| Script | Description |
|--------|-------------|
| `npm run tor:download` | Build the Arti (Rust Tor client) binary for your platform |
| `npm run test:e2e:tor` | Start real Arti and load a live `.onion` service |
| `npm run tor:reset` | Delete legacy repo-root Tor data from earlier dev builds |

---

## Tor (.onion) Access

Freedom can reach Tor `.onion` services using [Arti](https://arti.torproject.org/),
the Tor Project's pure-Rust Tor client. It is **off by default** and gated behind
**Settings → Experimental → Enable Tor (.onion access) (Beta)**.

- **Scope is `.onion`-only.** When enabled, only `*.onion` hostnames are routed
  through Tor; clearnet and the decentralized protocols (bzz/ipfs/ipns/rad) keep
  connecting directly. Routing is done with a PAC script on the Electron session
  (`src/main/tor-proxy.js`) that returns the active profile's SOCKS5 endpoint for `.onion` and
  `DIRECT` for everything else. SOCKS5 does remote DNS, so the onion name resolves
  at Tor — no custom scheme is needed; `.onion` is just an ordinary http(s) host
  (defaulted to `http://` since most onion services are http-only).
- **Every session, including private windows.** A PAC applies to exactly one
  Electron session, so `src/main/tor-manager.js` tracks the default session plus
  each live private-window partition and applies the same routing to all of them
  — a private window opened before *or* during a Tor session routes `.onion`
  through the proxy instead of resolving it DIRECT (which would leak the onion
  hostname to the system resolver).
- **Fails closed.** If Arti exits unexpectedly, or a start times out, the PAC is
  left in place: `.onion` requests fail with a proxy error rather than silently
  falling back to a DIRECT (DNS-leaking) lookup. Only a deliberate stop — the
  node-status toggle, disabling the integration, or app shutdown — restores
  DIRECT.
- **Lifecycle.** `src/main/tor-manager.js` spawns the bundled `arti` binary as a
  profile-scoped local SOCKS5 proxy (`arti proxy -c <arti.toml>`), waits for Arti
  to report that it is sufficiently bootstrapped, health-checks the SOCKS5
  endpoint, applies/clears the proxy, and reports status through the service
  registry — the same pattern as the Bee / Radicle managers.
- **Profiles.** Managed Tor uses `127.0.0.1:19150` for the default profile, then
  the next slot for named profiles (`19151`, `19152`, and so on). The conventional
  Tor Browser SOCKS port `9150` is treated as an external/system endpoint; a
  profile can opt into it with **Settings → Profiles → Node endpoints**.
- **Status readout.** The node-status menu's Tor section shows the SOCKS endpoint
  and the Arti software version (`arti --version`, via `getArtiVersion`). Exit-node
  details are intentionally not shown: `.onion` connections have no exit node, so
  an exit indicator only becomes meaningful once clearnet-over-Tor lands.
- **Binary.** Arti has no clean prebuilt-binary distribution, so `npm run
  tor:download` builds it from crates.io via `cargo install` (requires a Rust
  toolchain). The binary lands in `arti-bin/<platform>-<arch>/arti` and is bundled
  via electron-builder `extraResources`. Bundling is **optional**: if `arti-bin`
  hasn't been built, `npm run build/dist` still succeeds (a non-fatal warning from
  `check-binaries.js`) and simply ships without Tor — the in-app toggle stays
  disabled until the binary is present. Like Radicle, Tor is macOS/Linux-only for
  now; the toggle is hidden on Windows.
- **Data.** Arti state/cache live under `<profile>/tor-data` (override with
  `FREEDOM_TOR_DATA`).

---

## Project Structure

| Directory             | Contents                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/main/`           | Electron main process — node managers (Ant, IPFS, Myotis, Radicle), ENS resolver, IPC, settings, history, bookmarks, auto-updater |
| `src/renderer/`       | UI — tabs, navigation, address bar, menus, context menus, bookmarks bar, debug console, settings modal                    |
| `src/renderer/pages/` | Internal pages (home, history, error, links, protocol-test, rad-browser)                                                  |
| `src/shared/`         | Constants shared between main and renderer                                                                                |
| `config/`             | Ant config template, default bookmarks, macOS entitlements                                                                |
| `scripts/`            | Build and setup helpers (binary/addon downloads, Ant/IPFS/Myotis/Radicle init)                                          |
| `assets/`             | App icons                                                                                                                 |

---

## Development

### Testing

#### Unit tests (Jest)

Run all unit tests:

```bash
npm test
```

The suite covers most of `src/main/` and `src/renderer/lib/` — see `src/**/*.test.js` for the full list. Notable areas include:

- **Networking & protocols**: `bzz-protocol`, `swarm-probe`, `swarm-service`, `swarm-provider-ipc`, `request-rewriter`, `ens-resolver`, `ipfs-manager`, `myotis-manager`, `radicle-manager`, `ant-manager`, `service-registry`
- **Renderer navigation & UI**: `navigation`, `navigation-utils`, `tabs`, `tabs-ui`, `bookmarks-ui`, `autocomplete`, `menus`, `page-context-menu`, `settings-ui`, `wallet/*`
- **Identity, vault & wallet**: `identity/derivation`, `identity/vault`, `identity/formats`, `wallet/dapp-permissions`, `wallet/transaction-service`
- **Parsing & utilities**: `url-utils`, `cid-utils`, `origin-utils`, `ethereum-uri`, `page-urls`, `brand`
- **Storage & history**: `bookmarks-store`, `settings-store`, `history`, `feed-store`, `publish-history`

#### End-to-end tests (Playwright + Electron)

Two Playwright projects live under `test-e2e/`. The harness suite is run manually via `npm run test:e2e`; **issue #69 regression** (`test-e2e/address-bar-clipboard.spec.js`) runs on GitHub Actions for `ubuntu-latest`, `windows-latest`, and `macos-latest` (macOS runs the chrome context-menu specs only; Win/Linux menu wiring is skipped on Darwin). Configuration is in `playwright.config.js`.

| Suite | Command | Files | What it does |
| --- | --- | --- | --- |
| `harness` | `npm run test:e2e` | `test-e2e/*.spec.js` | Launches Electron with `FREEDOM_TEST_MODE=1`. The in-process harness in `src/main/test-harness.js` stubs Ant/IPFS startup, ENS resolution, the Swarm probe, and the `bzz:` / `ipfs:` / `ipns:` protocol handlers, so specs are fast (~15 s end-to-end), deterministic, and require no network or downloaded binaries. Covers address-bar normalisation, tabs, bookmarks, settings persistence, and the error-page flow. |
| `live` | `npm run test:e2e:live` | `test-e2e/live/*.spec.js` | Launches Electron without the harness — actual Ant + native IPFS startup, live ENS resolution, real `bzz://` / `ipfs://` protocol handlers. The live smoke waits for Swarm peers and for native IPFS to report running, then navigates to `meinhard.eth` (Swarm) and `vitalik.eth` (IPFS). `npm run test:e2e:tor` runs the Tor-only live smoke against real Arti and a live `.onion` service. Requires the matching binary download/build first; missing binaries/addons skip before Electron launches. |

`npm run test:e2e:tor` sets `FREEDOM_LIVE_E2E_DISABLE_DEFAULT_NODES=1`, which makes the live fixtures seed settings that keep Ant / IPFS / Radicle / Tor from autostarting, so the Tor smoke doesn't pay for (or inherit the flakiness of) the other nodes booting. Both suites use a per-run temp `userData` directory (`FREEDOM_TEST_USER_DATA`) so they never touch your real settings, bookmarks, or history. Sequential runs only (`workers: 1`) — Electron + protocol-scheme registration and Ant port detection don't tolerate parallel app instances.

### Logging

The main process uses [electron-log](https://github.com/megahertz/electron-log) with level-based transports:

| Environment                 | Console output      | File output      |
| --------------------------- | ------------------- | ---------------- |
| Development (`npm start`)   | `info` and above    | `info` and above |
| Production (packaged app)   | `warn` and above    | `info` and above |
| `DEBUG=1` (any environment) | `verbose` and above | `info` and above |

Log files are written to the standard electron-log location (`~/Library/Logs/Freedom/` on macOS).

To enable verbose logging in a packaged app:

```bash
DEBUG=1 /Applications/Freedom.app/Contents/MacOS/Freedom
```

### Debugging

- Toggle the debug panel via **Menu (☰) > Debug Console**.
- Check the terminal for main process logs (visible at `info` level and above in development):
  - Ant/IPFS/Radicle stdout and stderr
  - IPC events
  - Request rewrites
  - ENS resolution
- Use Chrome DevTools in the webview (right-click > Inspect Element when available).

### Building

#### macOS

Create a distributable macOS app:

```bash
npm run dist -- --mac
```

For local testing without code signing:

```bash
npm run build -- --mac --unsigned
```

Output goes to the `dist/` folder as DMG and ZIP archives.

The build includes:

- Bundled Ant, freedom-ipfs native addon, and Radicle binaries
- Ant configuration template
- All renderer assets

#### Linux

Freedom uses `better-sqlite3` for history and favicon caching, which is a native Node.js module. When cross-compiling for Linux from macOS, the native module must be compiled for the target platform.

**Docker is required for Linux builds with working SQLite support:**

```bash
# Build for Linux ARM64 (e.g., Raspberry Pi, ARM servers)
npm run dist:linux:arm64:docker

# Build for Linux x64
npm run dist:linux:x64:docker
```

These commands run the build inside a Linux Docker container, ensuring native modules are compiled correctly. Docker Desktop must be running.

**Note:** The non-Docker Linux build commands (`npm run dist -- --linux --arm64`, `npm run dist -- --linux --x64`) only work when building on a native Linux machine of the matching architecture.

#### Windows

```bash
# Build Windows x64 distributable
npm run dist -- --win --x64

# Build Windows ARM64 distributable
npm run dist -- --win --arm64
```

Output goes to the `dist/` folder as NSIS installer and ZIP archive.

**Note:** Windows builds do not include Radicle binaries (no official upstream release yet). The Experimental settings section is hidden automatically on Windows.

#### Apple Code Signing & Notarization

For signed macOS builds with notarization, copy `.env.example` to `.env` and
fill in your Apple credentials:

```bash
APPLE_ID="your-apple-id@example.com"
APPLE_TEAM_ID="YOUR_TEAM_ID"
APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

The `.env` file is automatically loaded by the build scripts (via `dotenv-cli`),
so you don't need to manually export these variables. The signed build commands
(`npm run dist -- --mac`, `npm run dist -- --mac --x64`) will automatically use
these credentials for code signing and notarization.

**Note:** The `.env` file is git-ignored. Keep credentials out of the repo.

#### Non-blocking notarization (submit now, resume later)

If Apple notarization might take a long time, you can split distribution into
two phases so your terminal does not block:

1. Build signed artifacts without waiting for notarization:

   ```bash
   npm run dist:mac:prepare-notary
   ```

2. Submit artifacts to Apple asynchronously (no `--wait`):

   ```bash
   npm run dist:mac:submit-notary
   ```

3. Check notarization status later (safe after reboot/shutdown):

   ```bash
   npm run dist:mac:notary-status
   ```

   Inspect Apple processing details for a specific submission:

   ```bash
   npm run dist:mac:notary-log -- <submission-id>
   ```

4. Once all submissions are `Accepted`, staple and validate artifacts:

   ```bash
   npm run dist:mac:staple-notary
   ```

Submission receipts are stored in `dist/notary-submissions/` so the process can
be resumed later. These scripts load the same `.env` Apple credentials used by
`electron-builder` (`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`),
so only one credential source needs to be maintained. If preferred, you can use
a keychain profile instead with `NOTARY_PROFILE=your-profile`.

### Deploying Updates

Freedom includes **non-intrusive auto-update functionality** that silently checks for and downloads updates in the background.

**Update Experience:**

- Silent background downloads - no interruptions
- Updates install manually via notification/menu when ready
- Default-profile installs restart Freedom automatically; named/profile-dir installs close after install so users do not silently relaunch into the wrong profile
- Users stay in control - can disable in Settings

**Server Setup:**

After building distributable packages with `npm run dist -- --mac`, upload the following files to `https://freedom.baby/downloads/`:

```
latest-mac.yml       # Auto-generated update metadata
Freedom-{version}-arm64-mac.zip
Freedom-{version}-arm64.dmg
Freedom-{version}-arm64-mac.zip.blockmap
Freedom-{version}-arm64.dmg.blockmap
```

**Update Flow:**

1. App checks for updates 10 seconds after launch
2. Checks again every 6 hours
3. If new version available → downloads silently in background
4. Small notification: "Update downloading..."
5. When ready → notification: "Update ready. Click to install."
6. Update installs via the notification or app menu; named/profile-dir profiles close after installation and should be reopened from the profile manager

**Manual Update Check:**

Users can manually check for updates via **Menu (☰) → Check for Updates**.

**Disable Auto-Updates:**

Users can disable automatic update checks in **Settings → Updates**.

**Testing Updates Locally:**

```bash
# Terminal 1: Start local update server
npm run serve:updates

# Terminal 2: Start app with updates enabled
npm run start:test-updater
```

---

## Security Notes

- **Context Isolation**: Uses `contextIsolation: true` and `nodeIntegration: false`.
- **Remote Module Disabled**: The remote module is not available.
- **Minimal API Surface**: Only necessary IPC methods are exposed to the renderer. The `freedomAPI` (history, bookmarks, etc.) is restricted to internal `freedom://` pages — external websites cannot call it.
- **Local Nodes**: Ant, IPFS, Myotis, Radicle, and Tor run locally when their integrations are enabled; no external services are required for basic operation.
- **Permission Handling**: Web permissions are deny-by-default with per-site prompts for camera, microphone, notifications, clipboard reading, location, and MIDI. Decisions marked "Remember for this site" persist per profile (`permissions.json`, reviewable under Settings → Site Permissions); unremembered decisions last for the session. Pointer lock and fullscreen remain auto-allowed for better UX in Swarm/IPFS apps; everything else (HID, screen capture, …) is denied. Location grants expose the API but may not resolve reliably — Electron lacks Chromium's network location service.
- **Public RPC Fallback**: ENS resolution uses public RPCs by default. For trustless verification, use a local Helios client.

---

## Troubleshooting

### Swarm node (Ant) fails to start

- Freedom automatically detects managed-port conflicts and persists a free profile port
- If the node still fails, check terminal output for specific error messages
- Reset Ant data: `npm run ant:reset`

### IPFS fails to start

- Freedom automatically detects managed-port conflicts and persists a free profile port
- Check for stale lock file: the app should auto-clean profile-local IPFS locks
- Reset IPFS data: `npm run ipfs:reset`

### Radicle fails to start
- Ensure **Settings → Experimental → Enable Radicle integration (Beta)** is enabled
- Freedom automatically detects managed-port conflicts and persists a free profile port
- Ensure both `radicle-node` and `radicle-httpd` binaries exist in `radicle-bin/`
- If starting for the first time, Freedom creates a Radicle identity automatically
- Check terminal output for specific error messages
- Reset Radicle data: `npm run radicle:reset`

### Using an external node

- If you have a system-wide Swarm/Radicle daemon or Tor SOCKS5 endpoint running, configure external mode in **Settings → Profiles → Node endpoints**
- External mode is per profile and per protocol
- The Nodes panel shows external/shared status when connected to an external node
- Freedom does not stop external nodes on quit

### ENS resolution not working

- Verify internet connectivity
- Check if public RPC providers are accessible
- For reliability, set a custom `ETH_RPC` endpoint

### Content not loading

- Ensure the respective node (Ant, IPFS, or Radicle) is running (check Nodes panel, for Radicle, first enable it in **Settings → Experimental**)
- Verify the Swarm reference (64 or 128 hex), CID, or Radicle ID is correct
- Check the debug console for error messages
