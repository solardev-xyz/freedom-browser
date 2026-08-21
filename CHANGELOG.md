# Changelog

All notable changes to Freedom will be documented in this file.

## [Unreleased]

### Added

- Remappable keyboard shortcuts under Settings > Shortcuts:
  - Searchable list grouped by category; click a binding and press the new combination
  - Conflict warning with a one-click swap when a combination is already taken
  - Per-shortcut reset and a Restore defaults button; changes apply without a restart
- Private windows (`Cmd+Shift+N` / `Ctrl+Shift+N`, File > New Private Window): ephemeral browsing on a per-window in-memory session with dark, badged chrome
  - No history, favicon-cache, or autocomplete writes; cookies and site data evaporate on close
  - Downloads are allowed but flagged and drop out of the downloads list when the window closes (files stay on disk); permission prompts work but decisions are session-only
  - Wallet and `window.ethereum` / `window.swarm` / `window.radicle` providers are unavailable in private windows (EIP-6963 silent); x402 payment interception is off
  - Honest private start page: what's protected (local traces) and what isn't (network observers, sites you log into, your IP)
- Find in page (`Cmd+F` / `Ctrl+F`, also under Edit in the menu): overlay bar over the page with a live match counter, `Enter` / `Shift+Enter` to cycle matches, `Esc` to close
- Download manager covering every download source, including `bzz://` and `ipfs://` content:
  - Shelf card with live progress and cancel; Open / Show in Folder on completion
  - `freedom://downloads` page (Cmd/Ctrl+Shift+J) with search, pause/resume, and Clear All
  - "Ask where to save each file" toggle under Settings > Downloads
- Per-site permission prompts for camera, microphone, notifications, clipboard reading, location, and MIDI, replacing the previous silent denial:
  - Prompt under the address bar with Allow / Block and "Remember for this site"
  - Remembered decisions per profile under Settings > Site Permissions, with per-site and remove-all revocation
  - Indicator icon in the address bar with quick revoke on sites holding granted permissions
  - Location prompts note that positioning may be unreliable
- Download manager covering every download source, including `bzz://` and `ipfs://` content:
  - Shelf card with live progress and cancel; Open / Show in Folder on completion
  - `freedom://downloads` page (Cmd/Ctrl+Shift+J) with search, pause/resume, and Clear All
  - "Ask where to save each file" toggle under Settings > Downloads
- Find in page (`Cmd+F` / `Ctrl+F`, also under Edit in the menu): overlay bar over the page with a live match counter, `Enter` / `Shift+Enter` to cycle matches, `Esc` to close
- Audio indicator on tabs playing sound; click it or use "Mute Tab" in the tab context menu to mute/unmute (mute survives navigation)

### Changed

- Updated bundled [Ant](https://github.com/solardev-xyz/ant) to 0.5.36: fixes the ~250 MiB upload stall, adds upload-side Reed-Solomon encoding, end-to-end Swarm content encryption, local pinning, and ACT access control
- The Swarm node's API now comes up instantly on start, so the node menu shows peers counting up live instead of sitting at 0 during startup

## [0.8.0] - 2026-07-02

### Added

- In-house Rust implementations of the bundled Swarm and IPFS nodes, built for the upcoming mobile apps:
  - Reasoning: mobile needs small binaries and bounded memory; every platform gains speed and room for specialised node features
- [Ant](https://github.com/solardev-xyz/ant) 0.5.33, a lean Swarm light node, replaces bundled Bee:
  - Full Bee parity: retrieval, feeds, stamp purchase, publishing, and chequebook payments
  - Instant publishing setup (no more lengthy Gnosis chain-state download)
  - Node data and Swarm identity migrate in place on first launch
- [freedom-ipfs](https://github.com/solardev-xyz/freedom-ipfs) 0.4.3, a retrieval-only IPFS implementation, replaces bundled Kubo:
  - The node runs inside the browser process instead of as a separate daemon
  - No standing peer connections — the node connects instantly when IPFS content loads
  - IPFS load progress in the status bar (Settings > Experimental)
- Support for multiple profiles with separate tabs, history, settings, wallet, identities, and nodes, running side by side in separate windows:
  - Profiles flyout in the browser menu, a native Profiles menu, and a `freedom://profiles` manager page
  - Existing data carries over as the first profile on upgrade
- Prompt to adopt system Swarm or Radicle nodes found on their default ports as external nodes
- `.wei` and `.gwei` name resolution alongside ENS, for navigation and wallet recipients
- `Tabs in title bar` setting on Linux, off by default (thanks @agazso!)

### Changed

- Freedom-managed nodes use dedicated ports (Ant 11633, Radicle 18780), leaving the ecosystem defaults (1633, 8780) to system nodes
- Internal `freedom://` pages (History, Settings, Profiles) open as singleton tabs, focusing the existing tab instead of duplicating it

### Removed

- Local Kubo API and gateway ports (5001, 8080) — the embedded IPFS node exposes no local endpoints

### Fixed

- Opening an `ipfs://` or `ipns://` page with the IPFS node stopped now shows a friendly error page instead of a raw JSON error
- Swarm publishing setup: the Swap xDAI to xBZZ action opens the swap flow again instead of the wallet receive screen
- ENS resolution falls back to the public-RPC quorum during Colibri prover or network outages instead of failing to resolve
- Radicle peer discovery follows the community seeds' move to radicle.network, updating existing configurations
- The Linux taskbar and dock now show the Freedom icon instead of a generic placeholder (also @agazso)

### Security

- Updated runtime dependencies:
  - Electron 41.7.1 to 43.0.0 (Chromium 146.0.7680.216 to 150.0.7871.46, Node 24.15.0 to 24.17.0)
  - `better-sqlite3` 12.10.0 to 12.11.1
  - `ethers` 6.16.0 to 6.17.0
  - `@x402/core` 2.14.0 to 2.17.0
  - `@x402/evm` 2.14.0 to 2.17.0
  - `@ethersphere/bee-js` 12.2.1 to 12.2.2
  - `@ensdomains/content-hash` 3.0.0 to 3.1.1
  - `@corpus-core/colibri-stateless` 1.1.28 to 1.1.30
  - `micro-key-producer` 0.8.6 to 0.9.0
  - `electron-updater` 6.8.3 to 6.8.9
- Override `ws` to ^8.21.0 under `viem` to clear `GHSA-96hv-2xvq-fx4p` (memory-exhaustion DoS); the auto-fix would have downgraded `@x402/evm` across a major
- Updated dev dependencies:
  - `@babel/preset-env` 7.29.7 to 8.0.2 (with `@babel/core` 8)
  - `@playwright/test` 1.60.0 to 1.61.1
  - `electron-builder` 26.8.1 to 26.15.3
  - `eslint` 10.4.1 to 10.6.0
  - `prettier` 3.8.3 to 3.9.4
  - `globals` 17.6.0 to 17.7.0

## [0.7.4] - 2026-06-01

### Added

- Native x402 payment support — pay as you browse, straight from the built-in wallet:
  - Approval card with optional per-origin auto-pay caps
  - Transparent subresource payments, no x402 SDK required
  - Payment history at freedom://payments and in the wallet sidebar
- Swarm publisher identities — pick which identity signs the content you publish:
  - Use a browser EVM wallet as a publisher identity, alongside the existing app and Bee-node identities
  - Manage identities and choose one from a selector when publishing
- `window.swarm` provider gains chunk-level read and write methods for dApps

### Fixed

- Setting up a wallet publisher identity on Windows no longer fails with an EPERM error

### Security

- Updated runtime dependencies:
  - Electron 41.7.0 to 41.7.1 (Chromium 146.0.7680.216, Node 24.15.0 — same as 41.7.0; Electron-side patches only)
  - `@corpus-core/colibri-stateless` 1.1.26 to 1.1.28
- Updated dev dependencies:
  - `eslint` 10.4.0 to 10.4.1

## [0.7.3] - 2026-05-26

### Security

- Updated bundled nodes: Bee 2.7.1 to 2.8.0 (breaking p2p upgrade; older nodes can no longer peer with the network)
- Updated dev dependencies: `@babel/preset-env` 7.29.5 to 7.29.7

## [0.7.2] - 2026-05-24

### Added

- Cryptographic ENS verification via Colibri (`@corpus-core/colibri-stateless`) as the new default resolution path:
  - Forward and reverse lookups verified locally rather than trusted across public RPCs
  - Address-bar shield popover distinguishes Colibri verification from quorum verification
  - Verification mark next to cryptographically verified recipient names on the wallet send review screen
  - Warning when a recipient address claims an ENS name that doesn't forward-verify
  - Reload on an ENS page re-runs verification under the current method (hard reload also bypasses the 15-minute cache)
  - Settings > ENS Resolution: choose between Colibri, the public-RPC quorum, or your own RPC
- Unified network registry as the single source for chains, RPC endpoints, prover endpoints, and keyed RPC providers:
  - Settings > Chains: per-chain endpoint list across three tiers (your RPCs, commercial keyed providers, public RPCs)
  - Add a chain via the chainlist.org catalogue or by hand
  - Settings > RPC Providers: manage Alchemy / Infura / DRPC API keys
- Destination URL preview on link hover, shown in the bottom-left like Chrome and Firefox

### Changed

- Default ENS resolution changed from public-RPC quorum to Colibri (custom-RPC users keep their direct-RPC-first path)
- Wallet, ENS, and the Bee node manager all read chains and RPC endpoints from the unified network registry

### Fixed

- Address-bar copy and paste work as expected on all platforms

### Security

- Swarm dApp provider permission prompts key on the committed page URL, not on the address-bar draft
- Updated runtime dependencies: Electron 41.5.0 to 41.7.0 (Chromium 146.0.7680.216, Node 24.15.0 — same as 41.5.0; Electron-side patches only), `@ethersphere/bee-js` 12.1.0 to 12.2.1, `better-sqlite3` 12.9.0 to 12.10.0, `electron-log` 5.4.3 to 5.4.4
- Updated bundled nodes: Radicle 1.8.0 to 1.9.1
- Updated dev dependencies: `@playwright/test` 1.60.0, `jest` 30.4.2, `babel-jest` 30.4.1, `eslint` 10.4.0, `@babel/preset-env` 7.29.5
- Override `ws` to ^8.21.0 under `ethers` to clear `GHSA-58qx-3vcg-4xpx` (uninitialised memory disclosure); `ethers@6.16.0` pinned `ws@8.17.1`, the auto-fix would have downgraded ethers across a major

## [0.7.1] - 2026-05-07

### Added

- ENS resolution verified across multiple public RPCs:
  - Verification shield in the address bar; clicking it opens a popover with the full resolved URI and per-provider answers
  - Interstitial confirmation page when a resolution can't reach quorum, gated by "Block unverified ENS navigation" (default on)
  - "Cross-RPC verification" section in `freedom://settings` exposing quorum parameters (providers per wave, required matches, per-provider timeout, block anchor, anchor TTL) and toggles
  - Editable list of public Ethereum RPC providers, also in `freedom://settings`

### Changed

- Swarm, IPFS, and IPNS pages load under custom `bzz://`, `ipfs://`, and `ipns://` standard schemes (see README for site-author migration):
  - Origin is the scheme itself: `bzz://<hash>/`, `ipfs://<cid>/`, `ipns://<name>/`
  - Sub-resources proxy via a main-process handler with retries
  - ENS-backed sites use the human-readable name as host (`bzz://swarm.eth/`, `ipfs://vitalik.eth/`), so storage origin stays stable across contenthash updates
- CIDv0 / base58btc inputs canonicalise to CIDv1 base32 / libp2p-key base36:
  - `ipfs://QmXoy.../docs` opens as `ipfs://bafyb.../docs`; `ipns://12D3KooW.../` becomes `ipns://k51.../`
  - Reasoning: Chromium's URL parser lowercases the host, which corrupts mixed-case base58btc encodings; the lowercase-only base32 and base36 forms round-trip cleanly through navigation, the address bar, storage origin, and DevTools
- ENS names display under their resolved transport, with stricter scheme rules:
  - `vitalik.eth` displays as `ipfs://vitalik.eth`, `meinhard.eth` as `bzz://meinhard.eth`
  - Mismatched transport schemes show an error: typing `bzz://name.eth` for an IPFS-hosted name no longer silently switches to IPFS
  - In-page ENS links must carry a scheme (`ens://`, `bzz://`, `ipfs://`, `ipns://`)
- Speculative gateway prefetch during ENS quorum waves (faster first paint on cold-cache lookups)

### Fixed

- Bee's raw 404 JSON suppressed during cold-content Swarm lookups; spinner stays running, and timeouts show the "Content not ready yet" page
- IPFS / IPNS loads on macOS no longer fail with "kubo gateway unreachable"

### Security

- Updated Electron 41.2.1 to 41.5.0, picking up the latest Chromium 146 and Node 24 patches
- Updated bundled nodes: Kubo 0.40.1 to 0.41.0, `@ethersphere/bee-js` 11.1.1 to 12.1.0 (drops local axios override, picks up axios 1.x fixes)
- Updated JS dependencies: ESLint 10.2.1 to 10.3.0, `@scure/bip39` 2.0.1 to 2.2.0, `globals` 17.5.0 to 17.6.0, `micro-key-producer` 0.8.5 to 0.8.6, `@babel/preset-env` 7.29.2 to 7.29.3

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
- Updated bundled nodes: Bee 2.7.0 to 2.7.1, Kubo 0.39.0 to 0.40.1, Radicle 1.6.1 to 1.8.0 (rad-httpd 0.23.0 to 0.24.0)
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
- ENS resolution reliability: replace broken RPC providers (llamarpc, ankr, cloudflare-eth replaced with drpc, blastapi, merkle) and fix failed handle cleanup
- View-source address bar and title not updating correctly
- IPFS routing and DNSLink resolution on networks with broken or slow local DNS

### Security

- Add Content Security Policy headers to all internal HTML pages
- Validate IPFS CID format, IPNS names, and block malformed `bzz://` requests
- Harden webview preferences, restrict `freedomAPI` to internal pages only, tighten local API CORS and IPC base URLs, redact logged URLs
- Resolve all npm audit vulnerabilities (11 total: 10 high, 1 moderate)
- Updated dependencies: Electron 39 to 40, electron-builder 26.0 to 26.7, better-sqlite3 12.5 to 12.6, electron-updater 6.6 to 6.7

## [0.6.0] - 2026-01-01

First public preview (binary-only).
