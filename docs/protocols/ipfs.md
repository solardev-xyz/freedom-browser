# IPFS / IPNS Content Retrieval

`ipfs` and `ipns` are registered as privileged standard schemes by `protocol.registerSchemesAsPrivileged` in `src/main/index.js` — it has to run before the app is ready, so it lives at module top level rather than in the handler file. The request handlers themselves are in `src/main/ipfs/ipfs-protocol.js`. This mirrors how `bzz` is wired up. Every `ipfs://<cid|name>/...` and `ipns://<key|name>/...` request — top-level navigation, sub-resources, `fetch`, media `Range`, CSS `url(...)`, service workers — flows through a main-process handler that calls the embedded `freedom-ipfs` native request API and streams the response back. Because `ipfs://<cid>/` (or `ipfs://<name>/`) is the page origin, `window.location.protocol === 'ipfs:'`, same-origin relative paths Just Work, and storage (cookies, localStorage, IndexedDB, service workers) is keyed to the content reference.

The native request API accepts the same `/ipfs/...` and `/ipns/...` gateway-path shape, but Freedom no longer starts a loopback Kubo gateway or HTTP API for desktop IPFS. Status and progress shown in the UI come from native `freedom-ipfs` diagnostics.

ENS-named hosts work the same way as for `bzz`: `ipfs://vitalik.eth/...` resolves the contenthash via the in-process ENS resolver (cache hit after the address-bar resolution) and proxies the same way. The page's URL/origin stays `ipfs://<name>/` rather than the resolved CID. Cross-transport mismatches (e.g. `ipfs://name.eth` whose contenthash is Swarm or IPNS) return `404` with an explanatory body — the typed scheme is treated as an assertion, matching the `bzz` handler's behaviour. Unlike `bzz`, the IPFS handler doesn't wrap its requests in a retry loop, and `4xx` / `5xx` responses pass through to the page so SPAs that feature-detect missing endpoints can render their own fallback.

> **Origin model.** Same as `bzz`: `ipfs://vitalik.eth` and `ipfs://<resolved-cid>` are different origins from Chromium's perspective. Pinning storage to the ENS name keeps state stable across contenthash updates.

## CID & IPNS-key canonicalisation

Because `ipfs:` and `ipns:` are standard schemes, Chromium's URL parser treats the host segment as a hostname and lowercases it. The base58btc encodings used by CIDv0 (`Qm...`), CIDv1 base58btc (`z...`), and IPNS peer-ID multihashes (`12D3Koo...`, `16Uiu2H...`, `Qm...`) are case-sensitive, so a naïve `ipfs://Qm.../path` would arrive at the protocol handler as `ipfs://qm.../path` — different bytes, and the IPFS backend rejects it.

The address-bar / load pipeline in `src/renderer/lib/url-utils.js` (`formatIpfsUrl` → `parseIpfsInput`) canonicalises on the way in, before `new URL` sees the input:

- CIDv0 `Qm...` → CIDv1 base32 `bafy...`
- CIDv1 base58btc `z...` → CIDv1 base32 `b...`
- base58btc IPNS peer ID → libp2p-key base36 (`k51...` for Ed25519, `k2k4...` for sha2-256)

All target encodings are lowercase, so subsequent host normalisation by Chromium is a no-op. DNSLink names (`docs.ipfs.tech`) and ENS names (`vitalik.eth`) fall through unchanged — they're not base58btc and don't suffer the case issue. The encoders live in `src/renderer/lib/cid-utils.js` (kept inline because the renderer has no bundler).

If you click a `<a href="ipfs://Qm.../">` link inside a page (rather than typing into the address bar), the webview preload intercepts the click in capture phase and reads the raw DOM attribute (`getAttribute('href')`) before Chromium resolves and lowercases the URL. It then sends that original mixed-case href to the host renderer, which routes it through `formatIpfsUrl`, so embedded link clicks canonicalise the same way address-bar input does. The interceptor covers same-tab clicks (`click` event) **and** modified-click / middle-click / `target="_blank"` / named-target dispositions (`auxclick` for real middle-click, since modern Chromium dispatches `click` only for the primary button) — without that, the new-window code path (Chromium → `setWindowOpenHandler` → `tab:new-with-url`) would receive the URL after Chromium had already lowercased the host, and case-sensitive bytes would be lost. The renderer's `link:navigate` IPC handler dispatches by disposition: same-tab calls go through `loadTarget`, new-tab calls go through `openInNewTabWithTarget` (the same helper the IPC `tab:new-with-url` path uses), so a `target="docs"` named target reuses an existing `docs` tab the way it does for plain HTTPS links.

Direct sub-resource fetches (`<img src>`, `<script src>`, `<video src>`, `fetch()`, CSS `url(...)`) cannot be intercepted in JS — by the time the request reaches the protocol handler, Chromium has already lowercased the host and the original CIDv0/base58btc bytes are gone. The handler detects this case and returns a clear `400` with an actionable message ("Publish the resource with its CIDv1 base32 (`bafy...`) form for sub-resource use.") rather than forwarding a guaranteed-bad reference to the native gateway. The same `400`-with-explanation path covers lowercased CIDv1 base58btc (`z...`) hosts and lowercased base58btc IPNS keys. **Site-author guidance:** when emitting `<img src>` / `<script src>` / `fetch()` URLs in your own HTML, use CIDv1 base32 (`ipfs://bafy.../...`) and libp2p-key base36 (`ipns://k51.../...`) forms; both are case-insensitive and round-trip cleanly through Chromium's URL parser.

## Path-gateway URL form (`ipfs://<gateway>/ipfs/<cid>/...`)

Gateway directory listings and gateway-authored pages can emit protocol-relative anchors like `<a href="//localhost:8080/ipfs/<cid>">CID</a>`. When the page origin is `ipfs://<cid>/`, Chromium resolves these against the page scheme and ends up with `ipfs://localhost/ipfs/<cid>` — which is no longer a valid IPFS reference (`localhost` isn't a CID). The same shape appears for absolute public-gateway links (`ipfs://dweb.link/ipfs/<cid>/...`, `ipfs://ipfs.io/ipfs/<cid>/...`, `ipfs://cf-ipfs.com/ipfs/<cid>/...`, etc.).

`parseIpfsInput` (renderer) and `buildGatewayUrl` (main) both recognise this gateway-form path and rewrite it to the canonical `ipfs://<cid>/...` (or `ipns://<key>/...` for cross-namespace cases like `ipfs://localhost/ipns/...`, `ipfs://dweb.link/ipns/<dnslink-name>/...`). The disambiguation rule has two parts:

1. The **outer host** must be a recognised gateway. We use an explicit allowlist (`localhost`, `127.0.0.1`, `::1`, `*.localhost`, plus the most common public gateways: `dweb.link`, `ipfs.io`, `gateway.ipfs.io`, `cf-ipfs.com`, `cloudflare-ipfs.com`, `gateway.pinata.cloud`, `nftstorage.link`, `w3s.link`, `4everland.io`, `ipfs.fleek.co`, `dweb.eu.org`). Earlier versions used a negative "host doesn't look like a content reference" heuristic, which over-fired for DNSLink hosts (e.g. `ipns://docs.ipfs.tech/ipfs/coverage` would try to rewrite even though `docs.ipfs.tech` is the actual content host). Self-hosted gateways aren't matched — content authors with private gateways should publish canonical `ipfs://<cid>/...` URLs directly. The renderer-side check strips a trailing `:<port>` before the allowlist comparison so `ipfs://localhost:8080/ipfs/<cid>` (Chromium's resolution of a gateway-authored protocol-relative anchor against the page's `ipfs://` origin — the port is preserved because `ipfs:` has no default port) rewrites the same way `ipfs://localhost/ipfs/<cid>` does.
2. The **embedded ref** must be a CID or IPNS key (`/ipfs/<ref>` and `/ipns/<ref>`), with the additional concession that `/ipns/` also accepts DNSLink-shaped names so `ipfs://dweb.link/ipns/docs.ipfs.tech/install` rewrites to `ipns://docs.ipfs.tech/install`. The legitimate `ipfs://<cid>/ipfs/<subfile>` shape (a real subdirectory named `ipfs`) keeps loading from the host CID — the host CID isn't in the gateway list, so the path stays as-is.

For top-level navigation, the renderer rewrite means the address bar and page origin both end up canonical. For sub-resource fetches that go through the protocol handler directly, the bytes load but the URL Chromium associates with the resource stays in the gateway-host form — acceptable for sub-resources since they don't establish their own origin.

## Migrating IPFS sites to the `ipfs://` / `ipns://` scheme

Versions of Freedom before this change loaded `ipfs://<cid>/path` by rewriting it to the path-gateway URL `http://127.0.0.1:8080/ipfs/<cid>/path` and navigating there — Chromium then followed Kubo's subdomain redirect to `http://<cidv1>.ipfs.localhost:8080/path`. Pages saw `window.location.protocol === 'http:'` and a host like `<cidv1>.ipfs.localhost`.

With the custom scheme, pages now see:

- `window.location.protocol === 'ipfs:'` (or `'ipns:'`)
- `window.location.host === '<cid>'` (or `<name>`, `<key>`)
- `window.location.pathname === '/path'` (the `/ipfs/<cid>/` prefix is gone — it's encoded in the host)

The [Swarm migration guidance](swarm.md#migrating-swarm-sites-to-the-bzz-scheme) applies here too — the same anti-patterns (protocol/pathname sniffing, appending `/ipfs/<cid>/` to `window.location.origin`) have the same fixes (relative URLs, or use the native scheme directly):

```js
// ✗ Old pattern — assumes the page is served from the gateway
const apiBase = window.location.origin + '/ipfs/' + dataCid + '/';

// ✓ New pattern — use the ipfs:// scheme directly
const apiBase = `ipfs://${dataCid}/`;
```

Don't hardcode `http://localhost:8080` — Freedom no longer exposes a desktop IPFS loopback gateway, and external visitors via a public IPFS gateway may arrive through any gateway host.
