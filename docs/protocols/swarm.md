# Swarm Content Retrieval

A fresh Swarm node pulls chunks on-demand through the DHT, and any individual chunk lookup can transiently fail with `HTTP 404` even when the content is healthy and peers are connected. Across a page with 10–30 sub-resources (JS, CSS, fonts, images, video), a modest per-request failure rate compounds into visibly broken CSS, missing images, and videos that don't load. Retries almost always succeed — the problem is strictly first contact with cold content.

Freedom mitigates this in two layers:

1. **Navigation probe** (`src/main/swarm/swarm-probe.js`) — before loading a `bzz://` URL, the main process HEAD-polls `/bzz/<hash>` on the local node's gateway with exponential backoff (30 s per attempt, 5 min overall). The tab spinner runs during the probe, so the user never sees the node's raw 404 JSON; on timeout or node-unreachable we route to `error.html` with the original URL preserved and a **Try Again** button. Probes are cancellable.

2. **Custom `bzz:` scheme** (`src/main/swarm/bzz-protocol.js`) — `bzz` is registered as a privileged standard scheme by `protocol.registerSchemesAsPrivileged` in `src/main/index.js` (it must run before the app is ready, so it sits at module top level rather than in the handler file), so `bzz://<hash>/` becomes the page origin in Chromium. Every `bzz://` request (top-level, sub-resources, `fetch`, media `Range`, CSS descendants, service workers) routes through a main-process handler that proxies to the local node's gateway, always sets `Swarm-Chunk-Retrieval-Timeout` + `Swarm-Redundancy-Strategy: 3` + `Swarm-Redundancy-Fallback-Mode: true`, retries transient `5xx` on idempotent methods with bounded exponential backoff (~50 s total) with a 30 s per-attempt deadline, and streams the response back. `404` responses are surfaced immediately so SPAs that feature-detect missing endpoints don't stall — the cold-start case that 404 retries used to absorb is now handled upstream by the navigation probe. Because `bzz://<hash>/` is the origin, same-origin relative paths (`/foo.js`, `url(/bg.png)`) resolve naturally with no URL rewriting.

The handler also accepts Ethereum-named hosts: `bzz://swarm.eth/...`, `bzz://site.wei/...`, and `bzz://apoorv.gwei/...` resolve the contenthash via the in-process name resolver (cache hit after address-bar resolution) and proxy the same way. The page's URL/origin stays `bzz://<name>/` rather than the resolved hash, so DevTools, `window.location`, storage, and subresource fetches like `fetch('bzz://swarm.eth/data')` see the name. Cross-transport mismatches (e.g. `bzz://name.eth`, `bzz://name.wei`, or `bzz://name.gwei` whose contenthash is IPFS) return `404` with an explanatory body — the typed scheme is treated as an assertion. The renderer's address-bar pipeline applies the same assertion before navigating, so both layers agree.

> **Origin model.** `bzz://swarm.eth` and `bzz://<resolved-hash>` are different origins from Chromium's perspective — cookies, localStorage, IndexedDB, and service workers are not shared between them. This mirrors HTTPS, where `https://example.com` and `https://192.0.2.1` are also different origins even when they resolve to the same server. Pinning storage to the ENS name keeps state stable across contenthash updates.

## Migrating Swarm sites to the `bzz://` scheme

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
