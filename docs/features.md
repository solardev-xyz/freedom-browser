# Features

## Decentralized Network Architecture

Freedom runs Swarm, IPFS, and Radicle nodes, an experimental Myotis Ethereum light client, and optional Tor routing, giving you access to decentralized and onion networks from a single interface.

|                          | Swarm                                         | IPFS                                 | Radicle                                         |
| ------------------------ | --------------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| **Protocol**             | `bzz://`                                      | `ipfs://`, `ipns://`                 | `rad://`                                        |
| **Node Software**        | Ant (antd, bee-compatible)                    | freedom-ipfs native                  | libradicle native addon                         |
| **Hash Format**          | 64 or 128-char hex (encrypted refs supported) | CIDv0 (`Qm...`) or CIDv1 (`bafy...`) | Repository ID (`z...`)                          |
| **Managed Gateway Port** | 11633+ (packaged)                             | internal native handler              | internal native handler                         |
| **Managed API Port**     | 11633+ (packaged)                             | internal native handler              | internal native handler                         |
| **Managed P2P Port**     | 12633+ (packaged)                             | internal native handler              | in-process                                      |
| **Route Prefix**         | `/bzz/{hash}/`                                | `/ipfs/{cid}/`, `/ipns/{name}/`      | `/api/v1/repos/{rid}/`                          |
| **Data Directory**       | `<profile>/ant-data/`                         | `<profile>/ipfs-data/freedom-ipfs/`  | profile-scoped short Radicle home               |
| **Binary Directory**     | `ant-bin/<platform>-<arch>/`                  | `native/freedom-ipfs-node/`          | `radicle-bin/<platform>-<arch>/libradicle.node` |

The Ant and Radicle binary paths above are the source-build layout that `npm run ant:download` and `npm run radicle:download` write; packaged builds flatten both to `<resources>/ant-bin/` and `<resources>/radicle-bin/`.

Source builds (`npm start`) use a different, per-checkout port range; see [Configuration](configuration.md#node-endpoints).

## Smart Node Connection

Freedom manages nodes per browser profile:

1. **Independent Managed Nodes**: By default, each profile has separate Ant, native IPFS, Myotis, Radicle, and Tor data. Ant and Tor use profile-specific non-default ports; IPFS, Myotis, and Radicle run as embedded native clients without loopback API or gateway ports.
2. **Explicit External Nodes**: Profiles can opt into an external Swarm endpoint or an external Tor SOCKS5 endpoint under **Settings → Nodes**. External node identity, storage, or circuit state is shared outside that profile. IPFS, Myotis, and Radicle always use their embedded native clients.
3. **Port Conflict Handling**: If a managed Ant or Tor profile port is busy, Freedom picks a free profile port and persists the reassignment.
4. **Visual Feedback**: The Nodes panel and profile settings show whether a node is managed, external/shared, or disabled.

This means Freedom works seamlessly whether you:

- Run it standalone (bundled Swarm and native IPFS nodes start automatically; Radicle and Myotis startup are opt-in under **Settings → Automatic Startup**)
- Create multiple independent browser profiles with their own browser data, vault, and managed node state
- Already have a system-wide Swarm daemon running and explicitly configure a profile to use it
- Have port conflicts with other software (Freedom finds and records available profile ports)

On macOS, the packaged app explicitly allows multiple bundle instances so profile
launching can use `open -n -a Freedom --args --profile=<id>`.

## Profiles and Sidebar

- **Independent Profiles**: Each profile has separate tabs, history, settings, wallets, identities, and managed node data.
- **Side-by-Side Windows**: Open multiple profiles in separate windows; macOS launches distinct application instances when needed.
- **Profile Manager**: Create, rename, open, and remove profiles from `freedom://profiles`.
- **Browser Sidebar**: Switch between wallet, node, and settings panels without leaving the active page.

## Integrated Swarm Node (Ant)

- **Toolbar Toggle**: Click the network icon to access the Nodes panel with independent on/off switches.
- **Live Statistics**: View connected peers, visible network peers, and the Ant node version in real-time.
- **DHT Client Mode**: Defaults to ultra-light (read-only) mode for minimal bandwidth and resource usage. It is a default, not a fixed mode — **Settings → Experimental → Swarm node mode** switches to light mode once publishing is set up, and back again.
- **Automatic Configuration**: First-run setup generates keys and config automatically.

## Integrated IPFS Native Node

- **Independent Toggle**: Start and stop IPFS separately from Swarm.
- **Native Transport**: Uses the embedded `freedom-ipfs` native addon instead of a loopback Kubo process.
- **Live Diagnostics**: View native gateway stats and request progress while IPFS/IPNS pages load.

## Integrated Myotis Light Client (Experimental)

- **Per-profile clients**: Ethereum and Gnosis have independent native runtimes and state for each browser profile.
- **Independent controls**: Each chain has separate startup, runtime, synchronization, peer, and finalized-block controls.
- **Verified chain data**: Wallet and compatible dApp reads can prefer Myotis before falling back through the configured Colibri and RPC methods.
- **No loopback API**: Myotis runs in-process through its native addon and does not expose a managed port.

## Tor `.onion` Access (Experimental)

- **Onion-only routing**: When enabled, Freedom routes only `.onion` hosts through the profile's Arti SOCKS5 proxy; clearnet and decentralized protocols remain direct.
- **Fail-closed behavior**: If Arti stops unexpectedly, `.onion` requests fail instead of falling back to direct DNS.
- **Profile isolation**: Managed Tor state, cache, endpoint, and private-window routing are profile-scoped.
- **Optional binary**: Source builds require `npm run tor:download`; bundled Tor is currently available on macOS and Linux.
- **Windows**: Arti is not bundled on Windows (it is built host-only from crates.io), so the Tor rows are hidden from the Experimental settings section on Windows builds and `.onion` access is unavailable.

## Integrated Radicle Node

- **Embedded Native Node**: Runs Radicle in the Electron main process through the `libradicle` addon — no `radicle-node`/`radicle-httpd` daemons, no CLI, and no loopback HTTP API.
- **Native Provider Actions**: `window.radicle` seeding, identity, repository listing, COB writes, and GitHub imports all call the addon directly.
- **Automatic Identity**: Creates a Radicle identity on first run (no manual setup required).
- **Profile Control**: Enable or disable Radicle per profile under **Settings → Nodes**.
- **Node Toggle**: Start and stop Radicle from the Nodes panel; automatic startup is opt-in under **Settings → Automatic Startup → Start Radicle node**.
- **Live Statistics**: View connected peers, seeded repos, addon version, and Node ID.
- **Repository Seeding**: Seed Radicle repositories directly from the browser to help replicate them across the network.
- **Windows**: The embedded node ships in the Windows x64 and ARM64 builds.

## Universal Address Bar

Enter any of the following in the address bar:

| Input Type    | Example                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| Swarm Hash    | `a1b2c3...` (64 or 128 hex characters)                                      |
| Swarm URL     | `bzz://a1b2c3.../path/to/file.html`                                         |
| IPFS CID      | `QmHash...` or `bafybeic...`                                                |
| IPFS URL      | `ipfs://QmHash.../path`                                                     |
| IPNS URL      | `ipns://k51...` or `ipns://domain.eth`                                      |
| Onchain App   | `web3://0x0000...56c6` or `web3://0x0000...56c6:100/` (chain ID optional)   |
| Radicle ID    | `rad://z3gqc...`                                                            |
| Onion URL     | `http://example.onion`                                                      |
| Ethereum Name | `vitalik.eth`, `mysite.box`, `alice.wei`, `apoorv.gwei`, `mysite.eth/about` |
| Tezos Domain  | `mysite.tez`, `ipfs://mysite.tez/docs`                                      |
| HTTP(S) URL   | `https://example.com`                                                       |
| Domain        | `example.com` (auto-prefixes `https://`)                                    |
| Search Query  | `how to publish to swarm` (anything that is not a URL, hash, or name)       |

The address bar also provides **autocomplete suggestions** from browsing history as you type.

Input that is not a URL, hash, or name is sent to your search engine — DuckDuckGo by default. Pick another under **Settings → Search** (Google, DuckDuckGo, Bing, Brave Search, Ecosia, Startpage), or add your own with an HTTPS URL template containing `{searchTerms}`.

## Ethereum Name Resolution

- **Automatic Resolution**: `.eth`, `.box`, `.wei`, and `.gwei` domains resolve to their Swarm, IPFS, or IPNS content. `.eth` and `.box` use ENS; `.wei` uses Wei Name Service (WNS); `.gwei` uses Gwei Name Service (GNS).
- **CCIP-Read Support**: `.box` domains resolve via offchain CCIP-Read (EIP-3668). Freedom pins no gateway host of its own: the gateway URLs come from the resolver's on-chain `OffchainLookup` revert (currently operated by 3DNS).
- **Protocol Detection**: Automatically detects and routes to Swarm (`bzz://`), IPFS (`ipfs://`), or IPNS (`ipns://`) content.
- **Transport-Aware Address Bar**: After resolution, the address bar shows the resolved transport with the name as the host — e.g. `vitalik.eth` resolves and displays as `ipfs://vitalik.eth`, a Swarm-backed `mysite.eth` displays as `bzz://mysite.eth`, a WNS-backed `alice.wei` displays as `ipfs://alice.wei`, and a GNS-backed `apoorv.gwei` displays as `ipfs://apoorv.gwei`. The legacy `ens://` form is still accepted as input (and stored bookmarks keep working) but is no longer the canonical display.
- **Typed Scheme Is an Assertion**: Typing `bzz://name.eth`, `ipfs://name.eth`, `ipns://name.eth`, or the equivalent `.wei`/`.gwei` forms only resolves if the contenthash matches the typed transport. Mismatches surface as a "resolves to X, not Y" message rather than silently switching transports — same rule the `bzz://` protocol handler enforces for subresource fetches. Bare names and the legacy `ens://` form make no assertion and accept any supported transport.
- **Path Forwarding**: Paths appended to names (e.g., `mysite.eth/docs`, `alice.wei/docs`, `apoorv.gwei/docs`) are preserved after resolution.
- **In-HTML Links**: Ethereum name links inside web pages must carry a scheme — `ens://name.eth`, `bzz://name.eth`, `ipfs://name.eth`, `ipns://name.eth`, `bzz://name.wei`, `ipfs://name.wei`, `ipns://name.wei`, `bzz://name.gwei`, `ipfs://name.gwei`, or `ipns://name.gwei`. Bare hrefs like `<a href="vitalik.eth">` are relative URLs by HTML/URL-spec rules and resolve against the page's base before any of our handlers see them; bare names are only resolved in the address bar, where input is always absolute.

## Tezos Domains Website Resolution

- **Native on-chain resolution**: Bare `.tez` names are resolved directly from the Tezos Domains mainnet registry through three public Tezos RPC endpoints. Freedom follows the upgradeable proxy, discovers the annotated records and expiry big maps, pins all providers to one block, and requires a 2-of-3 matching result before marking it verified. Set `TEZOS_RPC` to prepend an endpoint; the quorum still reads only the first three of the list, so a prepended endpoint displaces the last default rather than adding a fourth. It must serve Tezos **mainnet**, since the chain ID is verified on every lookup.
- **Published website records**: `web:redirect_url` takes precedence over `web:content_url`, matching Tezos Domains publishing semantics. HTTP(S) records navigate directly; IPFS and IPNS records stay on Freedom's native transports and keep the `.tez` name as the page origin.
- **Paths and assertions**: A base path embedded in the published URI is preserved when an address-bar path is appended. Typed `ipfs://name.tez` and `ipns://name.tez` forms assert that transport; `ens://name.tez` is intentionally rejected because `.tez` is not ENS.
- **Expiry and caching**: Expired domains do not resolve. Positive cache entries honor `td:ttl` within a bounded lifetime and never outlive the on-chain expiry; negative results use a short cache.

## Contract-hosted Applications (`web3://`)

- **Draft ERC-8244 support**: `web3://<contract>:<chainId>/` loads an application whose HTML lives in contract storage. The chain ID is optional and defaults to Ethereum mainnet.
- **No gateway**: The document is read through the same chain-data router the wallet uses, not an HTTP gateway or a page-selected RPC endpoint.
- **Chain-scoped origin**: Each contract-and-chain pair gets its own web-storage origin and wallet permission key; the wallet provider is pinned to the app's chain and `wallet_switchEthereumChain` cannot move it.

See [contract-hosted applications](protocols/onchain-apps.md) for the origin model, sandbox, and limits.

## Tabbed Browsing

- **Multiple Tabs**: Open multiple pages simultaneously with `Cmd+T`.
- **Tab Management**: Close tabs with `Cmd+W` or middle-click.
- **Audio Indicators & Mute**: Tabs playing sound show a speaker icon; click it (or use "Mute Tab" in the tab context menu) to mute or unmute the tab. Mute survives navigation within the tab.
- **Drag & Drop Reordering**: Rearrange tabs by dragging.
- **Per-Tab State**: Each tab maintains its own navigation history, address bar state, and bzz/ipfs base.
- **Link Handling**: Links that open new windows are captured and opened in new tabs instead.

## Navigation Controls

- **Back/Forward**: Standard browser history navigation per tab.
- **Reload**: Refresh the current page (uses cache; hard reload bypasses it). On error pages, retries the original URL.
- **Stop**: Cancel page loading mid-request.
- **Home**: Return to the welcome page.
- **Keyboard Shortcuts** (the complete set of remappable defaults, mirroring `src/shared/shortcuts.js` — remap them under Settings > Shortcuts by clicking a binding and pressing the new combination; changes apply immediately. `Cmd+Q` and the standard Cut/Copy/Paste/Select-All/Undo set stay reserved, and the Developer Tools bindings are shown but locked):
  - `Cmd+N` / `Ctrl+N`: New window
  - `Cmd+Shift+N` / `Ctrl+Shift+N`: New private window
  - `Cmd+T` / `Ctrl+T`: New tab
  - `Cmd+W` / `Ctrl+W` / `Ctrl+F4`: Close tab
  - `Cmd+Shift+T` / `Ctrl+Shift+T`: Reopen last closed tab
  - `Ctrl+PageDown` / `Ctrl+Tab` / `Cmd+Shift+]`: Next tab
  - `Ctrl+PageUp` / `Ctrl+Shift+Tab` / `Cmd+Shift+[`: Previous tab
  - `Ctrl+Shift+PageDown`: Move tab right
  - `Ctrl+Shift+PageUp`: Move tab left
  - `Cmd+R` / `Ctrl+R`: Reload (from cache)
  - `Cmd+Shift+R` / `Ctrl+Shift+R`: Hard reload (bypass cache)
  - `Cmd+F` / `Ctrl+F`: Find in page
  - `Cmd+=` / `Ctrl+=` / `Cmd+Shift+=` / `Ctrl+Shift+=` / `Cmd+Plus` / `Ctrl+Plus`: Zoom in (steps the active page 10% up to 500%)
  - `Cmd+-` / `Ctrl+-`: Zoom out (steps the active page 10% down to 25%)
  - `Cmd+0` / `Ctrl+0`: Actual size (resets the active page to 100%)
  - `Cmd+L` / `Ctrl+L`: Focus address bar
  - `Cmd+Y` / `Ctrl+H`: Show all history
  - `Cmd+Shift+J` / `Ctrl+Shift+J`: Downloads
  - `Cmd+Shift+B` / `Ctrl+Shift+B`: Toggle bookmark bar
  - `Cmd+Shift+W` / `Ctrl+Shift+W`: Toggle wallet sidebar
  - `F11`: Toggle fullscreen
  - `Cmd+Alt+I` / `Ctrl+Shift+I` / `F12`: Developer Tools (listed for reference; all three are locked, not remappable)
- **Fixed Keys**: Not part of the registry above and not remappable — `Escape` stops loading or restores the address bar, and in the find bar `Enter` jumps to the next match, `Shift+Enter` to the previous, and `Esc` closes it.
- **Zoom**: The zoom bindings above act on the active page (the same target and 10% step as the hamburger menu's − / + controls, which stay in sync with them), not on the browser chrome. Only the first binding on each row is remappable; the rest are fixed aliases that always stay active, listed as "Also …" in Settings > Shortcuts. Zoom In carries them because `=` sits behind Shift on many layouts (German, Spanish, Italian, Swiss and the Nordic ones all put it on `Shift+0`), where `Cmd`/`Ctrl` + `=` alone can never fire. All three actions additionally answer to the numeric keypad — `Num +`, `Num -` and `Num 0` — which the accelerator parser treats as keys distinct from the main row. Each action appears once under View > Zoom In / Zoom Out / Actual Size; the alias rows are hidden.
- **No Keyboard Binding**: Print has no shortcut; use the hamburger menu's Print entry.

## Bookmarks

- **Address Bar Star**: Click the star icon to bookmark or unbookmark the current page.
- **Supported Protocols**: Bookmark any `bzz://`, `ipfs://`, `ipns://`, `web3://`, `rad://`, `freedom://`, `http://`, or `https://` URL. The legacy `ens://` form is bookmarkable too, so older bookmarks and the seeded `ens://` defaults keep working.
- **Named Bookmarks**: Name and edit bookmarks via modal or right-click.
- **Bookmarks Bar**: Quick access below the toolbar, with an overflow menu when bookmarks don't fit. Always visible on the new tab page; toggle visibility on other pages with `Cmd+Shift+B` / `Ctrl+Shift+B` (persisted across sessions).

## Browsing History

- **Automatic Recording**: Pages are recorded as you browse.
- **History Page**: View and search your browsing history at `freedom://history`.

## Private Windows

- **Open**: `Cmd+Shift+N` / `Ctrl+Shift+N` (the default — remappable under Settings > Shortcuts, applies immediately) or File > New Private Window. Private windows have a dark, badged chrome so they're recognisable at a glance.
- **Ephemeral by construction**: Every private window runs its webviews on a unique in-memory session (`private-<uuid>` partition, never written to disk). Cookies, logins, caches, and site data evaporate when the window closes.
- **No local traces**: Nothing browsed in a private window is written to history, the favicon cache, or address-bar autocomplete. Downloads still work, but their entries are kept in memory only — never written to the profile's download database, visible only inside the private window, and gone when it closes (saved files stay on disk). Site-permission decisions made in a private window last only as long as the window — never remembered, even if you tick "remember".
- **Wallet disabled**: Your identity and wallet are persistent by design, so they are unavailable in private windows — pages see no `window.ethereum` / `window.swarm` / `window.radicle` (nothing announces via EIP-6963), and x402 pay-per-request interception is off. Use a normal window for anything wallet-related.
- **Decentralized protocols still work**: `bzz://`, `ipfs://`, `ipns://`, and ENS names resolve and load through the shared local nodes, `web3://` onchain apps render through the chain-data router (without a wallet provider — see above), and `.onion` sites route through Tor in private windows too when Tor is enabled. Publishing (which records publish history) is unavailable from private windows.
- **What private windows do NOT protect**: This is local privacy, not anonymity. Websites you sign in to still know it's you; your network operator can still see your traffic; Swarm/IPFS/Radicle peers still see your nodes' requests; and your IP address remains visible to every site and peer. The private new-tab page spells this out.

## Downloads

- **Download Manager**: Every download — http(s), `bzz://`, `ipfs://`/`ipns://`, and data URIs — is tracked with progress, pause/resume, and cancel.
- **Shelf**: A compact card in the bottom corner shows progress and offers Cancel; on completion it offers Open and Show in Folder, then dismisses itself. Files are never opened automatically.
- **Downloads Page**: View and search download history at `freedom://downloads` (`Cmd+Shift+J` / `Ctrl+Shift+J`), with per-item open / show-in-folder / remove and Clear All.
- **Save Location**: Files land in the OS Downloads folder by default; enable "Ask where to save each file" under Settings > Downloads for a save dialog per download.

## Ad Blocking

- **Request Blocking**: Blocks ads and trackers with Ghostery's blocking engine.
- **List Categories**: Configure EasyList, EasyPrivacy, cookie-notice, and annoyance lists independently.
- **Authenticated Updates**: Optional Swarm-delivered updates require a pinned signer, valid manifest shape, increasing version, and matching content hashes before activation.
- **Per-Site Allowlist**: Exempt individual hosts from filtering in Settings.

## Wallet and dApp Integration

- **Multiple Accounts**: Create and manage software wallets per profile.
- **Ledger Support**: Connect Ledger Ethereum accounts over USB and confirm signatures and transactions on the device.
- **Phone Signing**: Pair your phone by QR code and approve signatures and transactions there — wallet requests are relayed to the phone over an end-to-end encrypted OpenLV channel via the hosted bridge, and every returned signature is verified before use.
- **Ethereum Provider**: Sites can request wallet access, signatures, and transactions through the permissioned `window.ethereum` provider.
- **Swarm Provider**: Permissioned `window.swarm` APIs cover publishing, chunks, feeds, signing identities, and messaging.
- **Radicle Provider**: Permissioned `window.radicle` APIs cover repository data, node operations, signing, and seeding; see the [provider reference](radicle-provider-api.md).
- **x402 Payments**: Approve pay-as-you-browse requests, configure per-origin auto-pay allowances, and inspect payment history.

## Context Menus

Right-click on pages for context-sensitive actions:

- **Page Context**: Back, Forward, Reload (a hard reload — it bypasses the cache, unlike the toolbar Reload button), View Page Source, Inspect
- **Link Context**: Open Link in New Tab, Open Link in New Window, Copy Link Address
- **Selection Context**: Copy selected text
- **Image Context**: Open Image in New Tab, Save Image As, Copy Image, Copy Image Address
- **View Page Source**: Opens `view-source:` URL in a new tab

## Request Rewriting

- **Automatic Path Rewriting**: When a page is loaded through a loopback gateway URL, absolute paths in its markup (e.g., `/images/logo.png`) are rewritten to stay within the current content base — Swarm (`/bzz/{hash}/`) first, then Radicle (`/api/v1/repos/{rid}/`, served by the internal `radapi://local` handler).
- **Per-Tab Tracking**: Each tab tracks its own content base for correct path resolution.
- **IPFS / IPNS (`ipfs://`, `ipns://`)**: No rewriting arm at all. These are standard schemes served by a custom protocol handler, so the page origin is already `ipfs://<cid>/` and same-origin subresources never reach the rewriter as gateway URLs.
- **Swarm (`bzz://`)**: `bzz://` navigations are likewise served by a custom protocol handler — see [Swarm content retrieval](protocols/swarm.md). The Swarm rewriter arm only applies to the loopback gateway URLs that back a `bzz` content base.
- **Onchain apps (`web3://`)**: No rewriting arm either — the document is read from the contract and served under its own chain-scoped origin, so there is no gateway URL to rewrite.
- **Invalid-Reference Guard**: Requests to `/bzz/` with a missing or malformed reference are cancelled rather than sent to the node.

## Developer Tools

- **Toggle via Menu**: Open the hamburger menu (☰) and click "Developer Tools" (or use `Cmd+Alt+I` / `Ctrl+Shift+I` / `F12`) to open Chromium DevTools for the current page.
- **Per-Tab**: DevTools attach to the active tab's webview; the page's own console output and errors appear there.
- **Browser-Chrome Logs**: Freedom's own renderer diagnostics (navigation, resolution, and node events, each timestamped) go to the browser chrome's console — open **View → App Developer Tools** in a development build to see them.
- **Main-Process Logs**: Main-process output goes to the terminal and the `electron-log` file; see the [development guide](development.md) for levels and locations.

## Internal Pages

Access built-in browser pages using the `freedom://` protocol:

| Page                      | Description                  |
| ------------------------- | ---------------------------- |
| `freedom://home`          | Welcome/home page            |
| `freedom://downloads`     | Download manager             |
| `freedom://history`       | Browsing history             |
| `freedom://links`         | Link behavior test page      |
| `freedom://payments`      | x402 payment history         |
| `freedom://private`       | Private window start page    |
| `freedom://profiles`      | Browser profile manager      |
| `freedom://protocol-test` | Protocol and media test page |
| `freedom://publish`       | Publish files to Swarm       |
| `freedom://settings`      | Browser and network settings |
| `rad://{rid}`             | Radicle repository browser   |

## Settings & UI

- **Theme**: Light, Dark, or System (follows OS preference).
- **Tabs in Title Bar** (Linux only): Use the tab strip as the window title bar. Takes effect after restart.
- **Search**: Choose the address-bar search engine, or add a custom one from an HTTPS URL template containing `{searchTerms}`.
- **Node Auto-start**: Toggle whether Swarm, IPFS, Radicle, and (experimental) Myotis Ethereum/Gnosis nodes start automatically at launch (Swarm and IPFS enabled by default; Radicle and Myotis are opt-in).
- **Site Permissions**: When a site asks to use your camera, microphone, notifications, clipboard, location, or MIDI devices, a prompt appears under the address bar (Allow / Block, with "Remember for this site"). Remembered decisions are listed under Settings → Site Permissions with per-permission, per-site, and remove-all revocation; sites with granted permissions show an indicator icon in the address bar with quick revoke.
- **Ad Blocking**: Choose filter categories, automatic list updates, and per-host exemptions.
- **Shortcuts**: Search and remap browser commands with conflict detection and per-command reset.
- **Chains and RPC Providers**: Configure chain endpoints, keyed providers, and ENS verification behavior.
- **Experimental**: Enable Identity & Wallet (Beta), Show IPFS load progress in the status bar, Swarm node mode, Enable Tor (.onion access) (Beta), and Start Tor when Freedom opens. The Tor rows are hidden on Windows builds. Radicle is no longer experimental — it is configured under **Settings → Nodes** and **Settings → Automatic Startup**.
- **Auto-Updates**: Toggle automatic update checks (enabled by default).
- **Protocol Icons**: Address bar shows Swarm (hexagon), IPFS (cube), onchain app (Ethereum diamond), Radicle (seedling), or HTTP (globe) icon based on current protocol. When a page also has a resolution/provenance trust status (a resolved Ethereum name, or a `web3://` app whose retrieval was verified), the trust shield takes that slot instead — so onchain apps normally show the shield and fall back to the diamond only when no provenance is available.
- **Hamburger Menu**: Access browser features (Profile submenu, New Tab, New Window, New Private Window, History, Zoom, Print, Developer Tools, Settings, About Freedom, Check for Updates…).

## Error Handling

- **Friendly Error Pages**: Clear error messages with the original URL preserved.
- **Profile-Aware Radicle Errors**: Opening `rad://` while Radicle is disabled for the profile shows "Radicle Disabled for This Profile" and points to **Settings → Nodes**; opening it while the node is stopped shows "Cannot Connect to Radicle Node" and points to the Nodes menu.
- **Retry on Reload**: Pressing reload on an error page retries the original request.
- **Graceful Degradation**: Navigation errors don't crash the browser.
