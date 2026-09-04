# Development

This guide covers local setup, the repository layout, tests, debugging, and development builds. Read [CONTRIBUTING.md](../CONTRIBUTING.md) before proposing a change.

## Prerequisites

- Node.js 24 LTS. The pinned version is in [`.nvmrc`](../.nvmrc).
- npm, included with Node.js.
- Git.
- Platform build tools required by Electron native modules.

With `nvm` installed, select the repository version with:

```bash
nvm install
nvm use
```

## Set up and run

```bash
git clone https://github.com/solardev-xyz/freedom-browser.git
cd freedom-browser
npm ci
npm run ant:download
npm run ipfs:download
npm run myotis:download
npm start
```

Swarm and IPFS start automatically by default, while Radicle and Myotis are opt-in under **Settings → Automatic Startup**. Install the embedded Radicle addon with `npm run radicle:download` (macOS, Linux, and Windows x64/ARM64), then enable Radicle for the profile under **Settings → Nodes**. On macOS and Linux, install optional Tor support with `npm run tor:download`, then enable it under **Settings → Experimental**. Bundled Tor is unavailable on Windows.

## Repository layout

| Directory       | Responsibility                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/main/`     | Electron main process: node lifecycles, protocol handlers, IPC, persistence, permissions, downloads, and updates |
| `src/renderer/` | Browser UI: tabs, navigation, menus, settings, internal pages, and dApp integration                              |
| `src/shared/`   | Constants and utilities shared by the main and renderer processes                                                |
| `test-e2e/`     | Playwright harness and live Electron tests                                                                       |
| `config/`       | Ant configuration, default bookmarks, and platform entitlements                                                  |
| `scripts/`      | Build, binary-download, smoke-test, and maintenance helpers                                                      |
| `assets/`       | Application icons and packaged assets                                                                            |

Protocol and privileged logic belongs in the main process. The renderer talks to it through the IPC channels defined in `src/shared/ipc-channels.js`. Read the [architecture boundaries](agent-playbooks/architecture-boundaries.md) before adding files under `src/main/` or `src/renderer/`, creating an IPC channel, or moving logic between processes.

## Common npm scripts

| Script                        | Description                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `npm start`                   | Launch Electron in development mode                             |
| `npm run lint`                | Run ESLint                                                      |
| `npm test`                    | Run the Jest unit suite                                         |
| `npm run test:coverage`       | Run Jest with coverage                                          |
| `npm run test:e2e`            | Run the deterministic Playwright harness suite                  |
| `npm run test:e2e:live`       | Run live node, protocol, and naming integration tests           |
| `npm run test:e2e:packaged`   | Smoke-test a packaged build (`FREEDOM_E2E_EXECUTABLE`)          |
| `npm run test:e2e:tor`        | Run the live Tor `.onion` integration test                      |
| `npm run check-binaries`      | Validate packaged native binary targets                         |
| `npm run ant:download`        | Download the pinned Ant binary                                  |
| `npm run ipfs:download`       | Download the pinned freedom-ipfs native addon                   |
| `npm run myotis:download`     | Download the pinned Myotis native addon                         |
| `npm run radicle:download`    | Download the embedded libradicle addon for the current platform |
| `npm run radicle:build-addon` | Build the libradicle addon from a sibling checkout              |
| `npm run tor:download`        | Build the Arti Tor binary for the current platform              |
| `npm run adblock:download`    | Download the packaged ad-blocking lists                         |
| `npm run ipfs:native:smoke`   | Smoke-test the native IPFS addon and retrieval path             |
| `npm run ant:smoke-upload`    | Exercise a Swarm buy/upload/download round trip                 |

The scripts in `package.json` are the authoritative list. Destructive reset scripts remove local development data; inspect their targets before using them.

## Testing

### Unit tests

Run all Jest tests:

```bash
npm test
```

Most source modules have a neighboring `.test.js` file. At minimum, run the corresponding test whenever you modify a tested module. Run `npm run lint` after every code change.

### End-to-end tests

Playwright has three projects:

| Suite      | Command                     | Behavior                                                                                                       |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `harness`  | `npm run test:e2e`          | Launches Electron with deterministic Ant/IPFS/naming stubs; fast and network-independent                       |
| `live`     | `npm run test:e2e:live`     | Uses real nodes, protocols, and network resolution; requires downloaded binaries                               |
| `packaged` | `npm run test:e2e:packaged` | Runs the release smoke checks (launch, version, persistence) against a built binary instead of the source tree |

The `packaged` project needs `FREEDOM_E2E_EXECUTABLE` pointing at that binary and refuses to run without it; add `FREEDOM_E2E_NO_SANDBOX=1` on a headless machine. After `npm run build -- --linux --x64`, that is `FREEDOM_E2E_EXECUTABLE="$PWD/dist/linux-unpacked/freedom" FREEDOM_E2E_NO_SANDBOX=1 xvfb-run -a npm run test:e2e:packaged`. The release workflow runs the same suite against the `.deb` and AppImage it just built (see `agent-playbooks/release-process.md` §6).

All three suites use a temporary Electron `userData` directory and run sequentially. The full CI matrix covers the operating-system-specific and native-node checks that most contributors cannot reproduce locally.

## Logging and debugging

The main process uses `electron-log`:

| Environment               | Console             | File             |
| ------------------------- | ------------------- | ---------------- |
| Development (`npm start`) | `info` and above    | `info` and above |
| Packaged application      | `warn` and above    | `info` and above |
| `DEBUG=1`                 | `verbose` and above | `info` and above |

The log directory follows the Electron app name, which differs between a source run and a packaged app. On macOS, `npm start` runs as `Freedom Dev` and writes to `~/Library/Logs/Freedom Dev/`; the packaged app writes to `~/Library/Logs/Freedom/`. Other platforms use the standard `electron-log` location under the same app name.

Useful debugging surfaces:

- Open **Menu (☰) → Developer Tools** (or `F12`) for the current page's console and errors.
- Open **View → App Developer Tools** for Freedom's own renderer diagnostics, including navigation events.
- Inspect main-process output in the terminal.
- Use the webview context menu to open Chromium Developer Tools.
- Launch with `DEBUG=1 npm start` for verbose console logging.

## Development builds

Build an unpacked, unsigned application for the host platform with:

```bash
npm run build -- --mac --unsigned
```

Replace `--mac` with `--linux` or `--win` as appropriate. Native modules no longer need compiling for the target: `better-sqlite3` v13 ships prebuilt addons for every target we package (`darwin`/`linux`/`linuxmusl` x `x64`/`arm64`, plus `win32`), and each installer is built carrying only its own. Linux _distributables_ still use the Docker scripts, because the `.deb` target needs a system `fpm` (`USE_SYSTEM_FPM=true`) and its Ruby toolchain running in a container of the target architecture, which also fetches the arch-matched Radicle/IPFS/Myotis addons:

```bash
npm run dist:linux:x64:docker
npm run dist:linux:arm64:docker
```

Windows builds ship the embedded Radicle addon for x64 and ARM64 (the `win` target in `package.json` declares a `radicle-bin` `extraResources` entry), but not the bundled Tor (Arti) client, which declares no `arti-bin` entry. When cross-building for Windows, stage the target-native addon first with `npm run radicle:download -- --win --x64` or `-- --win --arm64`; the architecture must match the one passed to `npm run dist`. Signed releases, notarization, artifact verification, and deployment are maintainer workflows documented in the [release playbook](agent-playbooks/release-process.md).

## Testing updates locally

To exercise the auto-updater against a local update server:

```bash
# Terminal 1: Start local update server
npm run serve:updates

# Terminal 2: Start app with updates enabled
npm run start:test-updater
```
