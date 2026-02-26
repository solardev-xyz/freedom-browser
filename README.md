# Freedom Browser

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Platform](https://img.shields.io/badge/platform-macOS%20|%20Linux%20|%20Windows-lightgrey)](https://github.com/solardev-xyz/freedom-browser/releases)

Freedom is a browser for the decentralized web, with Swarm, IPFS, Radicle, and ENS as first-class protocols.
It ships with integrated Swarm, IPFS, and Radicle nodes, enabling direct peer-to-peer network access without relying on centralized HTTP gateways.

---

## Quick Start

1. **Install Node.js 18+**

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Download the node binaries (first time only):**

   ```bash
   npm run bee:download
   npm run ipfs:download
   npm run radicle:download
   ```

4. **Launch the app:**

   ```bash
   npm start
   ```

5. All nodes start automatically by default. Enter a Swarm hash, IPFS CID, Radicle ID, `bzz://` URL, `ipfs://` URL, `rad://` URL, or `.eth`/`.box` domain in the address bar.

---

## Architecture

Freedom Browser is an Electron application. Protocol logic lives in the main process; the renderer is a modular UI layer that talks to it over IPC (channels defined in `src/shared/ipc-channels.js`). The main process manages node lifecycles (`bee-manager.js`, `ipfs-manager.js`, `radicle-manager.js`), URL rewriting (`request-rewriter.js`), and persistent data (settings, bookmarks, history). A central `service-registry.js` tracks node endpoints, modes, and status, and broadcasts state to all windows — both node managers and the request rewriter read from it.

When a user enters a `bzz://`, `ipfs://`, `ipns://`, `rad://`, or ENS URL, the main process rewrites it to the active gateway URL via the registry, and subsequent webview requests are normalized to stay within the active hash/CID/RID base.

---

## Features

### Triple Node Architecture

Freedom runs Swarm, IPFS, and Radicle nodes, giving you access to three major decentralized networks from a single interface.

|                      | Swarm          | IPFS                                  | Radicle                        |
| -------------------- | -------------- | ------------------------------------- | ------------------------------ |
| **Protocol**         | `bzz://`       | `ipfs://`, `ipns://`                  | `rad://`                       |
| **Node Software**    | Bee            | Kubo                                  | radicle-node + radicle-httpd   |
| **Hash Format**      | 64 or 128-char hex (encrypted refs supported) | CIDv0 (`Qm...`) or CIDv1 (`bafy...`) | Repository ID (`z...`)         |
| **Gateway Port**     | 1633           | 8080                                  | 8780                           |
| **API Port**         | 1633           | 5001                                  | 8780                           |
| **Route Prefix**     | `/bzz/{hash}/` | `/ipfs/{cid}/`, `/ipns/{name}/`       | `/api/v1/repos/{rid}/`         |
| **Data Directory**   | `bee-data/`    | `ipfs-data/`                          | `radicle-data/`                |
| **Binary Directory** | `bee-bin/`     | `ipfs-bin/`                           | `radicle-bin/`                 |

### Smart Node Connection

Freedom intelligently manages node connections:

1. **Detect Existing Nodes**: On launch, checks if Swarm, IPFS, or Radicle nodes are already running on default ports
2. **Reuse When Available**: If a healthy node is detected, Freedom connects to it instead of starting a new one
3. **Automatic Fallback**: If default ports are busy (but not by a compatible node), Freedom starts bundled nodes on alternative ports
4. **Visual Feedback**: The Nodes panel shows connection status, including when using an external node or fallback port

This means Freedom works seamlessly whether you:

- Run it standalone (bundled nodes start automatically)
- Already have system-wide Bee/IPFS/Radicle daemons running (Freedom reuses them)
- Have port conflicts with other software (Freedom finds available ports)

### Integrated Swarm Bee Node

- **Toolbar Toggle**: Click the network icon to access the Nodes panel with independent on/off switches.
- **Live Statistics**: View connected peers, visible network peers, and Bee version in real-time.
- **DHT Client Mode**: Runs in ultra-light mode for minimal bandwidth and resource usage.
- **Automatic Configuration**: First-run setup generates keys and config automatically.

### Integrated IPFS Kubo Node

- **Independent Toggle**: Start and stop IPFS separately from Swarm.
- **Live Statistics**: View peer count, bandwidth usage, and Kubo version.
- **Low-bandwidth Mode**: Configured as DHT client with reduced connection limits.

### Integrated Radicle Node

- **Two-Process Architecture**: Manages both `radicle-node` (P2P network) and `radicle-httpd` (HTTP API) as a coordinated pair.
- **Automatic Identity**: Creates a Radicle identity on first run (no manual setup required).
- **Independent Toggle**: Start and stop Radicle separately from Swarm and IPFS (configurable in Settings).
- **Live Statistics**: View connected peers, seeded repos, version, and Node ID.
- **Repository Seeding**: Seed Radicle repositories directly from the browser to help replicate them across the network.
- **Stale Socket Cleanup**: Automatically cleans up control sockets from unclean shutdowns.
- **Port Conflict Resolution**: Falls back to ports 8781+ if default port 8780 is unavailable.

### Universal Address Bar

Enter any of the following in the address bar:

| Input Type  | Example                                         |
| ----------- | ----------------------------------------------- |
| Swarm Hash  | `a1b2c3...` (64 or 128 hex characters)          |
| Swarm URL   | `bzz://a1b2c3.../path/to/file.html` (`a1b2c3...` can be 64 or 128 hex) |
| IPFS CID    | `QmHash...` or `bafybeic...`                    |
| IPFS URL    | `ipfs://QmHash.../path`                         |
| IPNS URL    | `ipns://k51...` or `ipns://domain.eth`          |
| Radicle ID  | `rad://z3gqc...`                                |
| ENS Domain  | `vitalik.eth`, `mysite.box`, `mysite.eth/about` |
| HTTP(S) URL | `https://example.com`                           |
| Domain      | `example.com` (auto-prefixes `https://`)        |

The address bar also provides **autocomplete suggestions** from browsing history as you type.

### ENS Resolution

- **Automatic Resolution**: `.eth` and `.box` domains resolve to their Swarm, IPFS, or IPNS content.
- **CCIP-Read Support**: `.box` domains resolve via offchain CCIP-Read (EIP-3668) through 3dns.xyz.
- **Protocol Detection**: Automatically detects and routes to Swarm (`bzz://`), IPFS (`ipfs://`), or IPNS (`ipns://`) content.
- **Address Bar Preservation**: ENS names stay visible in the address bar during navigation.
- **Path Forwarding**: Paths appended to ENS names (e.g., `mysite.eth/docs`) are preserved after resolution.

### Tabbed Browsing

- **Multiple Tabs**: Open multiple pages simultaneously with `Cmd+T`.
- **Tab Management**: Close tabs with `Cmd+W` or middle-click.
- **Drag & Drop Reordering**: Rearrange tabs by dragging.
- **Per-Tab State**: Each tab maintains its own navigation history, address bar state, and bzz/ipfs base.
- **Link Handling**: Links that open new windows are captured and opened in new tabs instead.

### Navigation Controls

- **Back/Forward**: Standard browser history navigation per tab.
- **Reload**: Refresh the current page (ignores cache). On error pages, retries the original URL.
- **Stop**: Cancel page loading mid-request.
- **Home**: Return to the welcome page.
- **Keyboard Shortcuts**:
  - `Cmd+N` / `Ctrl+N`: New window
  - `Cmd+T` / `Ctrl+T`: New tab
  - `Cmd+W` / `Ctrl+W` / `Ctrl+F4`: Close tab
  - `Cmd+Shift+T` / `Ctrl+Shift+T`: Reopen last closed tab
  - `Ctrl+PgDn` / `Ctrl+Tab`: Next tab
  - `Ctrl+PgUp` / `Ctrl+Shift+Tab`: Previous tab
  - `Ctrl+Shift+PgDn`: Move tab right
  - `Ctrl+Shift+PgUp`: Move tab left
  - `Cmd+R` / `Ctrl+R`: Reload (from cache)
  - `Cmd+Shift+R` / `Ctrl+Shift+R`: Hard reload (bypass cache)
  - `Cmd+Shift+B` / `Ctrl+Shift+B`: Toggle bookmark bar
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

### Context Menus

Right-click on pages for context-sensitive actions:

- **Page Context**: Back, Forward, Reload, View Page Source, Inspect
- **Link Context**: Open Link in New Tab, Open Link in New Window, Copy Link Address
- **Selection Context**: Copy selected text
- **Image Context**: Open Image in New Tab, Save Image As, Copy Image, Copy Image Address
- **View Page Source**: Opens `view-source:` URL in a new tab

### Request Rewriting

- **Automatic Path Rewriting**: Absolute paths in decentralized content (e.g., `/images/logo.png`) are automatically rewritten to stay within the current hash/CID.
- **Cross-Protocol Support**: Works for both Swarm (`/bzz/`) and IPFS (`/ipfs/`, `/ipns/`) content.
- **Per-Tab Tracking**: Each tab tracks its own content base for correct path resolution.

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
| `freedom://history`       | Browsing history             |
| `freedom://links`         | Link behavior test page      |
| `freedom://protocol-test` | Protocol and media test page |
| `rad://{rid}`             | Radicle repository browser   |

### Settings & UI

- **Theme**: Light, Dark, or System (follows OS preference).
- **Node Auto-start**: Toggle whether Swarm, IPFS, and Radicle nodes start automatically at launch (Swarm and IPFS enabled by default).
- **Auto-Updates**: Toggle automatic update checks (enabled by default).
- **Protocol Icons**: Address bar shows Swarm (hexagon), IPFS (cube), Radicle (seedling), or HTTP (globe) icon based on current protocol.
- **Hamburger Menu**: Access browser features (New Tab, New Window, History, Zoom, Print, Developer Tools, Settings, About).

### Error Handling

- **Friendly Error Pages**: Clear error messages with the original URL preserved.
- **Retry on Reload**: Pressing reload on an error page retries the original request.
- **Graceful Degradation**: Navigation errors don't crash the browser.

---

## Configuration

### Node Endpoints

Freedom automatically manages node connections. By default:

- **Swarm Bee**: `http://127.0.0.1:1633`
- **IPFS Gateway**: `http://127.0.0.1:8080`
- **IPFS API**: `http://127.0.0.1:5001`
- **Radicle httpd**: `http://127.0.0.1:8780`

The browser automatically detects existing nodes and handles port conflicts. For advanced users who need to override the defaults (e.g., connecting to a remote node), use environment variables:

```bash
# Connect to a remote Swarm node
export BEE_API="http://remote-host:1633"

# Connect to a remote IPFS gateway
export IPFS_GATEWAY="http://remote-host:8080"

npm start
```

### ENS Resolution (Ethereum)

ENS domains are resolved using Ethereum JSON-RPC. The browser tries multiple public RPC providers in sequence (see `src/main/ens-resolver.js` for the current list). You can prepend your own endpoint by setting the `ETH_RPC` environment variable.

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

| Script                                                            | Description                                  |
| ----------------------------------------------------------------- | -------------------------------------------- |
| `npm start`                                                       | Launch the Electron app                      |
| `npm test`                                                        | Run unit tests (Jest)                        |
| `npm run bee:download`                                            | Download the Bee binary for your platform    |
| `npm run ipfs:download`                                           | Download the Kubo binary for your platform   |
| `npm run bee:start` / `bee:stop` / `bee:status` / `bee:reset`     | Manage Bee outside the app                   |
| `npm run ipfs:start` / `ipfs:stop` / `ipfs:status` / `ipfs:reset` | Manage IPFS outside the app                  |
| `npm run build -- --mac --unsigned`                               | Build unsigned macOS app (for local testing) |
| `npm run dist -- --mac`                                           | Build signed macOS distributable (DMG + ZIP) |
| `npm run dist:linux:arm64:docker`                                 | Build Linux ARM64 via Docker (recommended)   |
| `npm run dist:linux:x64:docker`                                   | Build Linux x64 via Docker                   |
| `npm run dist -- --win`                                           | Build Windows x64 distributable (NSIS + ZIP) |

The `build` and `dist` scripts accept `--mac`, `--linux`, or `--win` with optional `--arm64`, `--x64`, `--unsigned`, and `--verbose` flags. See `scripts/build.js` for details.

### Radicle Scripts

| Script | Description |
|--------|-------------|
| `npm run radicle:download` | Download the Radicle binaries for your platform |
| `npm run radicle:init` | Initialize Radicle identity and configuration |
| `npm run radicle:status` | Check Radicle httpd API status |
| `npm run radicle:reset` | Delete all Radicle data and start fresh |

---

## Project Structure

| Directory             | Contents                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/main/`           | Electron main process — node managers (Bee, IPFS, Radicle), ENS resolver, IPC, settings, history, bookmarks, auto-updater |
| `src/renderer/`       | UI — tabs, navigation, address bar, menus, context menus, bookmarks bar, debug console, settings modal                    |
| `src/renderer/pages/` | Internal pages (home, history, error, links, protocol-test, rad-browser)                                                  |
| `src/shared/`         | Constants shared between main and renderer                                                                                |
| `config/`             | Bee config template, default bookmarks, macOS entitlements                                                                |
| `scripts/`            | Build and setup helpers (binary downloads, Bee/IPFS/Radicle init)                                                         |
| `assets/`             | App icons                                                                                                                 |

---

## Development

### Testing

Run all tests:

```bash
npm test
```

The test suite covers:

- **url-utils**: Swarm hash parsing, IPFS CID validation (CIDv0/CIDv1), IPFS/IPNS URL parsing, Radicle ID validation, ENS name preservation, display value derivation, edge cases
- **tabs**: Tab creation, management, and state handling
- **request-rewriter**: Swarm, IPFS, and Radicle path rewriting for absolute and relative paths

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
  - Bee/IPFS/Radicle stdout and stderr
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

- Bundled Bee, Kubo, and Radicle binaries
- Bee configuration template
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

### Deploying Updates

Freedom includes **non-intrusive auto-update functionality** that silently checks for and downloads updates in the background.

**Update Experience:**

- Silent background downloads - no interruptions
- Updates install automatically on quit, or manually via menu
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
5. When ready → notification: "Update ready. Click to restart."
6. Update installs automatically on quit, or via "Restart to Install Update" menu

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
- **Local Nodes**: Bee, IPFS, and Radicle run locally; no external services required for basic operation.
- **Permission Handling**: Pointer lock and fullscreen permissions are granted for better UX in Swarm/IPFS apps.
- **Public RPC Fallback**: ENS resolution uses public RPCs by default. For trustless verification, use a local Helios client.

---

## Troubleshooting

### Bee fails to start

- Freedom automatically detects port conflicts and uses fallback ports
- If the node still fails, check terminal output for specific error messages
- Reset Bee data: `npm run bee:reset`

### IPFS fails to start

- Freedom automatically detects port conflicts and uses fallback ports
- Check for stale lock file: the app should auto-clean, but you can manually delete `ipfs-data/repo.lock`
- Reset IPFS data: `npm run ipfs:reset`

### Radicle fails to start
- Freedom automatically detects port conflicts and uses fallback ports
- Ensure both `radicle-node` and `radicle-httpd` binaries exist in `radicle-bin/`
- If starting for the first time, Freedom creates a Radicle identity automatically
- Check terminal output for specific error messages
- Reset Radicle data: `npm run radicle:reset`

### Using an external node

- If you have a system-wide Bee, IPFS, or Radicle daemon running, Freedom will detect and reuse it
- The Nodes panel will show "Node: localhost:PORT" when connected to an external node
- The toggle switch is disabled for external nodes (can't stop a node Freedom didn't start)

### ENS resolution not working

- Verify internet connectivity
- Check if public RPC providers are accessible
- For reliability, set a custom `ETH_RPC` endpoint

### Content not loading

- Ensure the respective node (Bee, IPFS, or Radicle) is running (check Nodes panel)
- Verify the Swarm reference (64 or 128 hex), CID, or Radicle ID is correct
- Check the debug console for error messages
