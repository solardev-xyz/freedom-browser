# Changelog

All notable changes to Freedom will be documented in this file.

## [0.8.7] - 2026-10-08

### Added

- Browsing credit for the Swarm node: pay peers for faster downloads and for uploads ([#488](https://github.com/solardev-xyz/freedom-browser/issues/488)):
  - In the wallet's Nodes tab, with credit left and recent spend
  - Top up in xDAI, or switch paying peers off
- Swarm cache size and Clear cache under Settings > Nodes ([#579](https://github.com/solardev-xyz/freedom-browser/issues/579))
- Pop-up blocker ([#442](https://github.com/solardev-xyz/freedom-browser/issues/442)):
  - One new tab per click or key press
  - Address-bar icon to open a blocked pop-up or allow the site
- Update progress in the browser menu and under Settings > About Freedom ([#87](https://github.com/solardev-xyz/freedom-browser/issues/87))
- Myotis warns when a network upgrade needs a newer Freedom ([#586](https://github.com/solardev-xyz/freedom-browser/issues/586))

### Changed

- Publishing on Swarm takes one xDAI payment to your node ([#459](https://github.com/solardev-xyz/freedom-browser/pull/459)):
  - Plans and upgrades priced in xDAI, paid from any wallet
  - New storage is immutable: once full, it takes no more uploads
- Settings regrouped into ten sections, in Chrome's order ([#551](https://github.com/solardev-xyz/freedom-browser/pull/551)):
  - Ad Blocking and Site Permissions under Privacy and security
  - Chains, RPC Providers and Name Resolution under Networks
  - Experimental renamed Advanced
- Network sources named in plain words, with the technical name under Advanced ([#549](https://github.com/solardev-xyz/freedom-browser/pull/549))
- The first profile can be deleted once another profile exists ([#124](https://github.com/solardev-xyz/freedom-browser/issues/124))
- The Swarm node reads chain data through Freedom's chain sources instead of a single RPC ([#419](https://github.com/solardev-xyz/freedom-browser/pull/419)):
  - A custom Gnosis Chain setup needs at least two RPC endpoints
  - Blockscout sees the node's wallet address
- Video and other large files on Swarm start playing sooner ([#501](https://github.com/solardev-xyz/freedom-browser/pull/501))

### Removed

- Ankr from the default Ethereum and Gnosis Chain RPCs, as it now requires an API key ([#484](https://github.com/solardev-xyz/freedom-browser/issues/484))

### Fixed

- Fewer stalls that freeze every window ([#503](https://github.com/solardev-xyz/freedom-browser/issues/503)):
  - Proof checks, `web3://` apps, Radicle files and browsing history
  - Ad blocking, the IPFS node, Swarm messaging, profiles and Bee-era upgrades
- Sending a transaction no longer closes the browser while it confirms ([#453](https://github.com/solardev-xyz/freedom-browser/issues/453))
- Links such as `magnet:` and `mailto:` offer to open their app ([#406](https://github.com/solardev-xyz/freedom-browser/issues/406))
- YouTube video ads are blocked with ad blocking on ([#410](https://github.com/solardev-xyz/freedom-browser/issues/410))
- A page that closes itself closes its tab ([#580](https://github.com/solardev-xyz/freedom-browser/issues/580))
- A local `file://` page can be bookmarked ([#555](https://github.com/solardev-xyz/freedom-browser/issues/555))
- Remapped shortcuts no longer fire twice on German and other non-US keyboards ([#205](https://github.com/solardev-xyz/freedom-browser/issues/205)):
  - A conflicting saved shortcut resets with a notice
- The Windows tab strip no longer starts behind an empty gap ([#408](https://github.com/solardev-xyz/freedom-browser/issues/408))
- A private window's address bar, find bar and bookmark fields stay readable in the light theme ([#605](https://github.com/solardev-xyz/freedom-browser/issues/605))
- Tor, Radicle, Ant and Myotis start on Windows 11 without the Visual C++ Redistributable ([#563](https://github.com/solardev-xyz/freedom-browser/issues/563))
- The Linux AppImage starts on Ubuntu 24.04 without `libfuse2`, and is 18 MB smaller ([#564](https://github.com/solardev-xyz/freedom-browser/issues/564))
- On Wayland, Freedom's windows group under its launcher icon ([#470](https://github.com/solardev-xyz/freedom-browser/pull/470))
- Tor starts on Macs without Homebrew's xz ([#460](https://github.com/solardev-xyz/freedom-browser/pull/460))
- Offchain ENS names with a `.onion` gateway resolve over Tor ([#359](https://github.com/solardev-xyz/freedom-browser/issues/359))
- Names with an offchain answer near the 4 MB limit keep resolving ([#478](https://github.com/solardev-xyz/freedom-browser/issues/478))
- A log query matching too many logs fails with an error instead of a shortened answer ([#496](https://github.com/solardev-xyz/freedom-browser/issues/496))
- The Nodes menu shows peers and bandwidth again for an external IPFS node ([#417](https://github.com/solardev-xyz/freedom-browser/issues/417))
- Myotis answers verified reads within seconds of a cold start or recovery ([#389](https://github.com/solardev-xyz/freedom-browser/issues/389))
- Myotis sync recovery keeps retrying through brief checkpoint outages, with Retry sync ([#413](https://github.com/solardev-xyz/freedom-browser/issues/413))
- Myotis no longer stays stuck after Freedom quits unexpectedly ([#418](https://github.com/solardev-xyz/freedom-browser/issues/418))
- Myotis gas estimates use every transaction field, and a refused transaction shows as not sent ([#557](https://github.com/solardev-xyz/freedom-browser/pull/557))
- A `bzz://` address of raw data, such as a video segment, loads ([#477](https://github.com/solardev-xyz/freedom-browser/pull/477))
- A `bzz://` address whose data isn't on Swarm fails sooner ([#482](https://github.com/solardev-xyz/freedom-browser/pull/482))
- Swarm video no longer cuts off when loaded right after the node starts ([#487](https://github.com/solardev-xyz/freedom-browser/pull/487))
- Swarm content loads within about half a minute of waking from sleep, not 15 minutes ([#501](https://github.com/solardev-xyz/freedom-browser/pull/501))
- Large Swarm uploads no longer drop thousands of peer connections ([#501](https://github.com/solardev-xyz/freedom-browser/pull/501))
- The Swarm node no longer dials peers' private network addresses ([#456](https://github.com/solardev-xyz/freedom-browser/pull/456))

### Security

- Web pages can no longer use your Swarm node's local API, which could spend its funds ([#428](https://github.com/solardev-xyz/freedom-browser/issues/428)):
  - dApps using `localhost:1633` must switch to `window.swarm`
- `bzz://` pages can't upload or control the node ([#429](https://github.com/solardev-xyz/freedom-browser/issues/429))
- The wallet signs only the exact transaction or message you approved ([#434](https://github.com/solardev-xyz/freedom-browser/issues/434)):
  - Touch ID keeps the vault password out of the browser window
- A hijacked page can't reach wallet, identity, permission or publishing functions ([#420](https://github.com/solardev-xyz/freedom-browser/pull/420))
- Site-supplied titles, filenames and payment details show only as text on internal pages ([#432](https://github.com/solardev-xyz/freedom-browser/issues/432))
- Packaged builds ignore debugging flags and load only their own app code ([#425](https://github.com/solardev-xyz/freedom-browser/issues/425))
- Sites can't open network shares, directory servers or system settings panes ([#436](https://github.com/solardev-xyz/freedom-browser/issues/436))
- A site gets a TLS client certificate only if you pick one, never in a private window ([#437](https://github.com/solardev-xyz/freedom-browser/issues/437))
- macOS builds drop two code-signing exceptions ([#438](https://github.com/solardev-xyz/freedom-browser/issues/438))
- A permission prompt can be answered only from its own window ([#439](https://github.com/solardev-xyz/freedom-browser/issues/439))
- External Swarm and IPFS nodes can't set cookies on the pages they serve ([#439](https://github.com/solardev-xyz/freedom-browser/issues/439))
- Updated bundled nodes:
  - [Ant](https://github.com/freedom-hq/ant) 0.5.45 to 0.5.61
  - [Arti](https://gitlab.torproject.org/tpo/core/arti) 2.6.0 to 2.7.0
  - [freedom-ipfs](https://github.com/solardev-xyz/freedom-ipfs) 0.4.3 to 0.4.5
  - [libradicle](https://github.com/solardev-xyz/libradicle) 0.7.1 to 0.8.0
  - [Myotis](https://github.com/biafra23/myotis) 0.1.11 to 0.1.14
- Updated runtime dependencies:
  - Electron 44.4.5 to 44.7.0 (Chromium 152.0.7977.130 and Node 24.21.0, unchanged)
  - `@corpus-core/colibri-stateless` 3.0.0 to 3.0.2
  - `@ledgerhq/hw-app-eth` 7.8.19 to 7.10.0
  - `@x402/core` 2.27.0 to 2.28.0
  - `@x402/evm` 2.27.0 to 2.28.0

## [0.8.6] - 2026-09-23

### Added

- External IPFS node support ([#351](https://github.com/solardev-xyz/freedom-browser/pull/351), thanks @ivanmmurciaua!):
  - Under Settings > Nodes
  - Your own gateway, or one detected on the standard local port
- Myotis keeps syncing after its built-in checkpoint expires ([#353](https://github.com/solardev-xyz/freedom-browser/pull/353)):
  - A replacement needs agreeing independent sources and a local proof check
  - Progress, errors and Retry sync in the Nodes menu
- ENSv2 readiness ([#352](https://github.com/solardev-xyz/freedom-browser/pull/352)):
  - DNS names such as `gregskril.com` as wallet recipients
  - Offchain names with every Name Resolution method
  - Per-chain addresses on chains other than Ethereum
- Settings search ([#281](https://github.com/solardev-xyz/freedom-browser/issues/281)):
  - Field in the Settings sidebar that finds a setting by its label or description
  - Enter or a click opens the matching row
- Limit on repeated permission prompts ([#364](https://github.com/solardev-xyz/freedom-browser/issues/364)):
  - Three dismissals in a row block the site for the session, as in Chrome
  - Shown in the address-bar indicator, where Remove lifts it
- Arch Linux `.pacman` packages ([#367](https://github.com/solardev-xyz/freedom-browser/pull/367), thanks @jwahdatehagh!):
  - For x64 and arm64, next to the AppImage and deb
  - In-app updates, as with the deb

### Changed

- Myotis re-syncs from scratch once after updating to this release

### Fixed

- Opening a Chrome Web Store page no longer crashes Freedom ([#346](https://github.com/solardev-xyz/freedom-browser/issues/346))
- Quitting with the IPFS node running no longer crashes Freedom ([#345](https://github.com/solardev-xyz/freedom-browser/issues/345))
- Camera and microphone now work on macOS, and on sites like Google Meet that check before asking ([#363](https://github.com/solardev-xyz/freedom-browser/pull/363))
- Visiting a site no longer fetches its page a second time, without your cookies, to find its icon ([#75](https://github.com/solardev-xyz/freedom-browser/issues/75))
- `Ctrl+W` on Windows and Linux closes the active tab instead of the whole window ([#97](https://github.com/solardev-xyz/freedom-browser/issues/97))
- Removing a permission from the address-bar indicator no longer clears another window's session decisions ([#366](https://github.com/solardev-xyz/freedom-browser/issues/366))
- The trust, permission and Radicle popovers close along with the address-bar suggestions instead of staying over the page ([#67](https://github.com/solardev-xyz/freedom-browser/issues/67))
- The Nodes menu no longer shows a Tor version while Tor is off ([#349](https://github.com/solardev-xyz/freedom-browser/issues/349))
- A Swarm folder address without its trailing slash, or with a colon in its name, opens the folder ([#95](https://github.com/solardev-xyz/freedom-browser/issues/95))
- A Settings address naming a section that does not exist changes to the section shown ([#280](https://github.com/solardev-xyz/freedom-browser/issues/280))
- A Settings link to a single chain opens that chain, or says it is no longer configured ([#280](https://github.com/solardev-xyz/freedom-browser/issues/280))
- Small plain-text files on IPFS open in the tab instead of downloading ([#352](https://github.com/solardev-xyz/freedom-browser/pull/352))
- Myotis catches up on a fresh install instead of stalling, most often on Gnosis ([#200](https://github.com/solardev-xyz/freedom-browser/issues/200))
- A transient Gnosis RPC error no longer makes the Swarm node lose a paid postage batch or deploy a second chequebook ([#387](https://github.com/solardev-xyz/freedom-browser/pull/387))

### Security

- Back and Forward re-check an ENS name's verification instead of restoring the verdict from the first visit ([#86](https://github.com/solardev-xyz/freedom-browser/issues/86))
- Offchain ENS lookups reach only public HTTPS gateways, within time and size limits ([#352](https://github.com/solardev-xyz/freedom-browser/pull/352))
- Updated bundled nodes:
  - [Ant](https://github.com/freedom-hq/ant) 0.5.44 to 0.5.45
  - [Myotis](https://github.com/biafra23/myotis) 0.1.7 to 0.1.11
- Updated runtime dependencies:
  - Electron 44.3.0 to 44.4.5 (Chromium 152.0.7977.78 to 152.0.7977.130, Node 24.20.0 to 24.21.0)
  - `@corpus-core/colibri-stateless` 2.0.6 to 3.0.0
  - `@ethersphere/bee-js` 13.0.0 to 13.1.0
  - `@ledgerhq/hw-app-eth` 7.8.17 to 7.8.19
  - `@safe-global/protocol-kit` 8.0.6 to 8.0.7
  - `@x402/core` 2.25.0 to 2.27.0
  - `@x402/evm` 2.25.0 to 2.27.0

## [0.8.5] - 2026-09-10

### Added

- Ad and tracker blocking:
  - On by default
  - Settings > Ad Blocking with a per-site allowlist and live rule counts
  - Cookie-banner and annoyance filtering, off by default
  - Filter lists refresh over Swarm without an app update
- Find in page:
  - `Cmd/Ctrl+F`, or Edit > Find in Page
  - Per-tab overlay bar with a live match counter
  - `Enter` / `Shift+Enter` to cycle matches, `Esc` to close
- Download manager:
  - Covers every download source, including `bzz://` and `ipfs://` content
  - Shelf card with live progress and cancel; Open / Show in Folder on completion
  - `freedom://downloads` page with search, pause/resume, and Clear All
  - Reached from the browser menu, the application menu, the shelf's Full Download History row, or `Cmd/Ctrl+Shift+J`
  - "Ask where to save each file" toggle under Settings > Downloads
- Per-site permission prompts:
  - For camera, microphone, notifications, clipboard reading, location, and MIDI, replacing the previous silent denial
  - Prompt under the address bar with Allow / Block and "Remember for this site"
  - Remembered decisions per profile under Settings > Site Permissions, with per-site and remove-all revocation
  - Indicator icon in the address bar with quick revoke on sites holding granted permissions
- Private windows:
  - `Cmd/Ctrl+Shift+N`, or File > New Private Window
  - Ephemeral browsing on a per-window in-memory session with dark, badged chrome
  - No history, favicon-cache or autocomplete writes; cookies and site data end on close
  - Downloads leave the list on close and permission decisions are session-only; files stay on disk
  - Wallet and `window.ethereum` / `window.swarm` / `window.radicle` providers are unavailable; x402 payment interception is off
  - Start page listing what private windows do and do not protect
- Remappable keyboard shortcuts:
  - Under Settings > Shortcuts
  - Searchable list grouped by category; click a binding and press the new combination
  - Conflict warning with a one-click swap when a combination is already taken
  - Per-shortcut reset and a Restore defaults button; changes apply without a restart
- Page zoom (thanks @alexwbend!):
  - `Cmd/Ctrl` with `=`, `-` and `0`
  - Remappable like every other binding
- Web search:
  - Typed input that isn't a URL becomes a search
  - Search a text selection from the page context menu
  - DuckDuckGo, Google, Bing, Brave Search, Ecosia, Startpage or a custom engine under Settings > Search
- Audio indicator on tabs:
  - Shown on any tab playing sound
  - Click it, or use "Mute Tab" in the tab context menu, to mute and unmute
  - A muted tab stays muted across navigation
- Contract-hosted onchain apps:
  - On `web3://<address>[:<chainId>]/` — the app itself lives in the contract, not on a web server
  - Address-bar shield popover reporting the chain, block, contract and content hash behind the page
  - Unverified reads stop at a warning page you can pass once; disagreeing sources block the load
  - The wallet provider is pinned to the app's chain; a page cannot switch it
  - Reasoning: the page is a contract read, not a hosted file; the shield reports whether that read was verified
- Radicle repositories in the browser:
  - Browsable and writable — open a `rad:` URL the way you would a web page
  - `rad:` as a fetchable scheme, plus a consented `window.radicle` provider for issues, comments and patches
  - Seed-to-browse reports per-peer clone phases, with retry and cancellation
  - Repository view pinned to any commit id, with commit, branch and contributor counts
  - Nodes menu in the toolbar shows Radicle's connected peers, seeded repositories and addon version
- [Myotis](https://github.com/biafra23/myotis) 0.1.7, a peer-to-peer Ethereum and Gnosis light client:
  - An experimental verified source, off by default
  - Draggable read and verification order per chain under Settings > Chains, alongside Colibri and RPC
  - Reasoning: reads are proven against a chain head Myotis syncs from peers itself, rather than trusted from an endpoint
- `.tez` name resolution:
  - Read from the Tezos Domains contracts
  - Covers bare names and `ipfs://` / `ipns://` targets
- Encrypted messaging for Swarm apps:
  - Point-to-point messages and topic broadcast through `window.swarm`
  - Behind its own consent tier
- App manifests for Swarm apps:
  - A `freedom-manifest.json` an app ships alongside its content
  - Its permissions become one decision instead of a stream of prompts
- Three new wallet account types:
  - All three usable with the vault locked and across dApp signing and sends
  - Ledger hardware accounts, confirmed on the device, including x402 payments
  - Phone accounts over Open Lavatory: QR pairing, signing on the phone, including x402 payments
  - Safe multi-owner accounts on Gnosis, with a signing board owners sign in any order
- Tor for `.onion` addresses, through a bundled [Arti](https://gitlab.torproject.org/tpo/core/arti) 2.6.0 client:
  - Off by default under Settings > Experimental
  - Bundled in every macOS, Linux and Windows build
  - Clearnet traffic keeps connecting directly
  - Prompt to use a system Tor client, such as Tor Browser, instead of Arti
- Licence texts and third-party notices in every installed copy of Freedom

### Changed

- Radicle runs as an embedded [libradicle](https://github.com/solardev-xyz/libradicle) 0.7.1 addon instead of separate daemon, HTTP and CLI processes, and takes no local port
- Swarm peers count up from launch instead of sitting at 0 during startup
- Settings copy and controls:
  - Automatic Startup and Ethereum Name Resolution are now Startup and Name Resolution
  - Button labels drop the plus and arrow glyphs: Add chain, Add RPC, Manage profiles
  - Helper lines that restated their own row label are gone
- Installers are about 15 MB smaller: each build now ships only the `better-sqlite3` native addon for its own platform and architecture instead of all eight upstream prebuilds
- The Windows installer is named `Freedom-Setup-<version>.exe`, previously `Freedom Setup <version>.exe`
- Internal pages such as `freedom://history` and `freedom://settings` open in their own tab instead of taking over the page you are reading:
  - An empty new tab is still navigated in place

### Removed

- Adopting a system Radicle node found on its default port as an external node — the embedded Radicle node takes no local port, so there is nothing to adopt

### Fixed

- Save image as and Copy image work on images loaded from `bzz://`, `ipfs://` and `ipns://` pages
- A `bzz://` deep link resolves when the manifest has no root index document instead of stranding on the not-found page
- Pages that call `preventDefault()` on a context menu no longer also get Freedom's native menu
- Custom RPC endpoints accept `http://` for loopback addresses such as `http://localhost:8545`, and save errors appear at the field (thanks @biafra23!)
- Uploads around 250 MiB no longer stall
- Expired or invalid postage batches fail fast with a clear error instead of stalling uploads
- macOS disk images pass Gatekeeper without an online check
- Internal pages follow the theme picked under Settings > Appearance instead of the operating system's
- Name-resolution warning pages show the typed name in the address bar instead of an on-disk file path, and stay out of history
- A failed page load titles itself instead of leaving the previous page's title on the tab and in history
- A half-typed address survives the page updating around it, and a switch away from the tab and back
- Escape in the address bar goes back to the page's own URL instead of leaving a half-typed fragment
- Arrow keys through the address-bar suggestions stop at the typed text instead of wrapping past it
- Ctrl/Cmd-click and middle-click open a link in a background tab instead of switching to it
- Shift+click opens a link in a new window
- Switching tabs puts the keyboard in the page instead of leaving it on the tab strip
- The tab strip scrolls once the tabs stop fitting instead of clipping the ones past the edge
- Settings opens its existing tab instead of a second copy when reached from the browser menu or the address bar
- The tab context menu closes when the foreground tab changes instead of staying open over another tab
- The Profiles flyout closes when another row of the browser menu is hovered instead of covering it
- Escape closes the browser menu and the Nodes menu, like every other menu in the chrome
- A menu taller than the window scrolls inside itself instead of pushing the toolbar off screen
- A context menu near the window's edge opens back into view instead of covering the pointer
- Bookmarks-bar items open in a background tab on Ctrl/Cmd-click or middle-click, and can be reordered by dragging
- The page context menu closes on navigation instead of acting on the previous page's link
- The Publish and Payments pages and the sidebar's permission screens are readable on the light theme

### Security

- Escape repository-supplied names and identifiers in the Radicle repository viewer's HTML attributes, blocking script execution from a crafted file name
- `window.ethereum` responses reach only the document that made the request, so a reply arriving after a navigation cannot land in the next page
- A remote page that mimics Freedom's error page can no longer choose what the address bar shows when you switch back to its tab
- Updated bundled nodes:
  - [Ant](https://github.com/freedom-hq/ant) 0.5.33 to 0.5.44
- Updated runtime dependencies:
  - Electron 43.0.0 to 44.3.0 (Chromium 150.0.7871.46 to 152.0.7977.78, Node 24.17.0 to 24.20.0)
  - `@corpus-core/colibri-stateless` 1.1.30 to 2.0.6 (thanks @simon-jentzsch!)
  - `@ethersphere/bee-js` 12.2.2 to 13.0.0
  - `better-sqlite3` 12.11.1 to 13.0.3
  - `micro-key-producer` 0.9.0 to 0.10.2
  - `@x402/core` 2.17.0 to 2.25.0
  - `@x402/evm` 2.17.0 to 2.25.0
  - `@scure/bip39` 2.2.0 to 2.4.0

## [0.8.0] - 2026-07-02

### Added

- In-house Rust implementations of the bundled Swarm and IPFS nodes, built for the upcoming mobile apps:
  - Reasoning: mobile needs small binaries and bounded memory; every platform gains speed and room for specialised node features
- [Ant](https://github.com/freedom-hq/ant) 0.5.33, a lean Swarm light node, replaces bundled Bee:
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
