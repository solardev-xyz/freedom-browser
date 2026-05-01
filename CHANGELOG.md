# Changelog

All notable changes to Freedom will be documented in this file.

## [Unreleased]

### Changed

- Navigating to a Swarm address (`bzz://` or ENS-resolved) now keeps the tab's loading spinner running while the Bee node looks up the content, instead of showing Bee's raw `{"code":404,"message":"address not found or incorrect"}` JSON while peers are still syncing. If the lookup times out we land on a friendlier "Content not ready yet" page; if the Bee HTTP API itself is unreachable we route to the existing "Swarm node is not running" error page. When the destination was an ENS name (e.g. `swarm.eth`), the error page and address bar show the original `ens://…` name rather than the resolved hash.
- Swarm pages are now loaded under the `bzz://` URL scheme directly. `window.location.protocol === 'bzz:'`, the hash is the host, and same-origin relative paths Just Work. Sub-resource fetches (including `<video>` Range requests, CSS `@import`, service workers, and `fetch()` calls before any preload-installed wrapper) flow through a main-process protocol handler that proxies to the local Bee gateway with `Swarm-Chunk-Retrieval-Timeout` + redundancy headers, retries transient `5xx` failures with bounded exponential backoff (~50 s total) and a 30 s per-attempt deadline, and streams the response back. **Note for Swarm site authors:** if your site builds absolute URLs from `window.location` (sniffing `protocol === 'http:'`, scraping the `/bzz/<hash>/` prefix from `pathname`, or appending `/bzz/<ref>/` onto `origin`) it will need updating. See "Migrating Swarm sites to the `bzz://` scheme" in the README.
- ENS-name URLs now display under their resolved transport scheme: `vitalik.eth` shows as `ipfs://vitalik.eth`, `meinhard.eth` as `bzz://meinhard.eth`, and so on. The legacy `ens://` form keeps working for existing bookmarks and in-HTML links. Typed transport schemes (`bzz://name.eth`, `ipfs://name.eth`, `ipns://name.eth`) act as assertions: if the ENS contenthash points at a different transport, the navigation surfaces an error rather than silently switching.
- Swarm pages backed by an ENS name (`bzz://swarm.eth`) now load under `bzz://<name>/` rather than `bzz://<hash>/`. DevTools, `window.location`, storage origin, and same-origin subresource fetches all see the human-readable name; the `bzz` protocol handler resolves ENS hosts on every request via the in-process resolver cache. Cross-transport mismatches (e.g. `bzz://name.eth` whose contenthash is IPFS) return `404` with an explanatory body. Pinning storage to the ENS name keeps state stable across contenthash updates — see the README "Origin model" note.
- ENS links inside web pages must now carry a scheme: `ens://name.eth`, `bzz://name.eth`, `ipfs://name.eth`, or `ipns://name.eth`. Bare `<a href="vitalik.eth">` is a relative URL by HTML/URL spec rules and is not resolved as ENS. Bare names continue to work in the address bar, where input is always absolute.

### Fixed

- The address bar reflects the in-flight target immediately when an ENS link is clicked or typed, instead of staying on the previous page's URL (or empty for new tabs) for the whole resolution roundtrip.
- The protocol icon updates to the right transport (Swarm/IPFS/IPNS) as soon as the scheme is known, rather than waiting until the page finishes loading. This also fixes the IPFS icon never showing for ENS names.
- The tab loading spinner now stays on while ENS resolves a page-link click, instead of being torn down by the phantom abort that follows the custom-protocol intercept.
- Cross-tab UI contamination during ENS resolution: spinner state, modal alert popups, and the resolved URL all stay scoped to the originating tab. Switching to another tab while a background lookup is in flight no longer drops that tab's spinner, surfaces an unrelated alert, or clobbers the foreground tab's address bar.

## [0.7.0] - 2026-04-19

### Added

- Experimental Identity & Wallet system (Settings > Experimental):
  - Password-protected vault with auto-lock
  - Touch ID quick-unlock on macOS
  - Multiple wallets and accounts, with Ethereum and Gnosis Chain support
  - Publisher Identities screen
  - Configurable ENS RPC
- dApp connections via injected EIP-1193 `window.ethereum` provider, announced via EIP-6963:
  - Per-origin permission grants with a connection banner and management screen
  - Dedicated approval screens for message signing and transactions, with optional auto-approve
- `ethereum:` URI scheme (EIP-681): links like `<a href="ethereum:vitalik.eth@1?value=1e16">` pre-fill the wallet Send screen (native-asset sends only)
- Swarm publishing from a connected Bee node:
  - `freedom://publish` setup page with readiness checklist and funding actions (chequebook deposit, CowSwap swap-to-xBZZ)
  - Stamp manager with batch list, purchase flow, and extension
  - Publish history
  - Experimental `window.swarm` dApp provider with publish and feed journal APIs, gated by per-origin approval
- Wallet Send accepts ENS names (`.eth`, `.box`, subdomains), and shows the recipient's verified primary ENS name on the review screen
- Bee node can now run in light mode (previously ultra-light only)
- Linux AppImage distribution target

### Changed

- ENS resolution uses the Universal Resolver: 3–4× fewer RPC round-trips on cold-cache `.eth` / `.box` navigation; names normalized per ENSIP-15
- Settings moved from a modal to a full `freedom://settings` page
- Toolbar icons, nodes menu, and experimental settings polished for consistency
- Updated bundled nodes: Bee 2.7.0 → 2.7.1, Kubo 0.39.0 → 0.40.1, Radicle 1.6.1 → 1.8.0 (rad-httpd 0.23.0 → 0.24.0)
- Upgraded Electron to 41; all other dependencies refreshed to latest

### Fixed

- IPFS sites using `_redirects` now resolve correctly

## [0.6.2] - 2026-03-01

### Added

- Experimental support for Radicle (decentralized Git hosting) on macOS and Linux:
  - Enable or disable Radicle from Settings > Experimental
  - `rad://` URL handling across navigation and rewriting
  - Bundled Radicle node lifecycle management and packaging support
  - Integrated repo browser page and GitHub-to-Radicle import bridge
  - Automatic seeding of Freedom's canonical Radicle repository when running the bundled node
- Swarm encrypted reference support in navigation and URL rewriting (including 64- and 128-character hex references)

### Fixed

- `Cmd/Ctrl+L` now reliably focuses the address bar even when web content has focus
- Pressing `Cmd/Ctrl+L` and `Escape` now consistently closes open menus and clears stale focus highlights
- Pinned tabs can no longer be closed through keyboard-accelerator close-tab actions

### Security

- Validate protocol-specific identifiers in IPC handlers and URL rewriting to block malformed or malicious input

## [0.6.1] - 2026-02-08

First public open-source release.

### Added

- Keyboard shortcuts: Ctrl+PgUp/PgDn to switch tabs, Ctrl+Shift+PgUp/PgDn to reorder tabs, Ctrl+F4 to close tab, Ctrl+Shift+T to reopen closed tabs, Ctrl+Shift+B to toggle bookmark bar, F11 for fullscreen, F12 for devtools
- Bookmark bar toggle that persists to settings and always shows on new tab page
- About panel with version, copyright, credits, website, and app icon
- DNS-over-HTTPS resolvers (Cloudflare DoH, eth.limo) for reliable dnsaddr and DNSLink resolution
- ESLint, Prettier, and EditorConfig for consistent code formatting

### Changed

- Split reload into soft (Ctrl+R, uses cache) and hard (Ctrl+Shift+R, bypasses cache); toolbar reload button defaults to soft, Shift+click for hard
- Switch IPFS content discovery from DHT to delegated routing via cid.contact

### Fixed

- Address bar staying focused after selecting autocomplete suggestion
- Unreadable pages in dark mode — inject light background/text defaults for external pages that don't support dark mode
- ENS resolution reliability: replace broken RPC providers (llamarpc, ankr, cloudflare-eth → drpc, blastapi, merkle) and fix failed handle cleanup
- View-source address bar and title not updating correctly
- IPFS routing and DNSLink resolution on networks with broken or slow local DNS

### Security

- Add Content Security Policy headers to all internal HTML pages
- Validate IPFS CID format, IPNS names, and block malformed `bzz://` requests
- Harden webview preferences, restrict `freedomAPI` to internal pages only, tighten local API CORS and IPC base URLs, redact logged URLs
- Resolve all npm audit vulnerabilities (11 total: 10 high, 1 moderate)
- Updated dependencies: Electron 39→40, electron-builder 26.0→26.7, better-sqlite3 12.5→12.6, electron-updater 6.6→6.7

## [0.6.0] - 2026-01-01

First public preview (binary-only).
