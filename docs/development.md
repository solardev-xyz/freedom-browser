# Development

This guide covers local setup, the repository layout, tests, debugging, and development builds. Read [CONTRIBUTING.md](../CONTRIBUTING.md) before proposing a change.

## Prerequisites

- Node.js 24 LTS. The pinned version is in [`.nvmrc`](../.nvmrc).
- npm, included with Node.js.
- Git.
- Platform build tools required by Electron native modules.
- Optional, for the bundled Tor client only (`npm run tor:download`): a Rust toolchain at or above the pinned Arti release's MSRV (`MIN_RUST_VERSION` in [`scripts/fetch-arti.js`](../scripts/fetch-arti.js); the script checks before building). Arti is compiled from crates.io rather than downloaded, for the host platform only. On Linux that build also needs OpenSSL development headers, and `libsqlite3-dev` when `pkg-config` is installed; on Windows it needs the x64 MSVC tools (the same developer shell the Myotis supervisor build uses), and the script asks Arti for its `static-sqlite` feature there because Windows ships no system SQLite for `libsqlite3-sys` to link.

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
npm run myotis:build-supervisor
npm start
```

Swarm and IPFS start automatically by default, while Radicle and Myotis are opt-in under **Settings → Startup**. Install the embedded Radicle addon with `npm run radicle:download` (macOS, Linux, and Windows x64/ARM64), then enable Radicle for the profile under **Settings → Nodes**. Install optional Tor support with `npm run tor:download` (macOS, Linux, and Windows x64 — it compiles Arti for the host), then enable it under **Settings → Experimental**; the Tor rows stay hidden until that binary exists.

Myotis also requires its small supervisor built from checked-in source with an
already installed C compiler: Apple clang/CLT on macOS, a native C compiler on
Linux, or an **x64 MSVC developer shell** on Windows. No compiler is downloaded
by the helper build. `npm run build` and `npm run dist` build it before binary
checks, including each requested macOS architecture. Foreign targets require
helpers built on the target host and placed in `myotis-bin/<os>-<arch>/`.
Windows helper compilation/runtime remains unqualified for this candidate;
missing tooling is a build blocker, not authorization to omit the helper.
See [Myotis isolation and qualification](myotis-process-isolation.md).

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

Playwright has four projects:

| Suite           | Command                     | Behavior                                                                                                       |
| --------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `harness`       | `npm run test:e2e`          | Launches Electron with deterministic Ant/IPFS/naming stubs; fast and network-independent                       |
| `live`          | `npm run test:e2e:live`     | Uses real nodes, protocols, and network resolution; requires downloaded binaries                               |
| `packaged`      | `npm run test:e2e:packaged` | Runs the release smoke checks (launch, version, persistence) against a built binary instead of the source tree |
| `packaged-live` | `npm run test:e2e:packaged` | Same built binary without the harness stubs: its bundled nodes really start and navigation really goes out     |

`npm run test:e2e:packaged` runs both packaged projects. They need `FREEDOM_E2E_EXECUTABLE` pointing at that binary and refuse to run without it; add `FREEDOM_E2E_NO_SANDBOX=1` on a headless machine. After `npm run build -- --linux --x64`, that is `FREEDOM_E2E_EXECUTABLE="$PWD/dist/linux-unpacked/freedom" FREEDOM_E2E_NO_SANDBOX=1 xvfb-run -a npm run test:e2e:packaged`; to run only the slow half, call Playwright directly with `npx playwright test --project packaged-live` (adding `--project` to the npm script would union with the two projects it already names). `packaged-live` uses the same per-test scratch data directories as `live`, and skips its Tor check (with the reason) on builds that bundle no Arti binary. The release workflow runs both suites against every artifact it just built — the macOS `.dmg` and `-mac.zip`, the Linux x64/arm64 `.deb` and AppImage, the Windows installer and portable zip (see `agent-playbooks/release-process.md` §6).

All four suites use a temporary Electron `userData` directory and run sequentially. The full CI matrix covers the operating-system-specific and native-node checks that most contributors cannot reproduce locally.

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

Windows builds ship the embedded Radicle addon for x64 and ARM64 and, since the `win` target gained an `arti-bin` `extraResources` entry alongside its `radicle-bin` one, the bundled Tor (Arti) client as well. Arti is compiled for the host only, so a Windows package carries Tor only when `npm run tor:download` ran on a Windows machine (the release workflow builds it on the `windows-x64` runner); a cross-build from macOS or Linux produces a Windows package without it, and the app hides the Tor rows there. Windows ARM64 is not part of the release workflow, so no ARM64 build bundles Tor unless the same build step is run on an ARM64 Windows host. When cross-building for Windows, stage the target-native addon first with `npm run radicle:download -- --win --x64` or `-- --win --arm64`; the architecture must match the one passed to `npm run dist`. Signed releases, notarization, artifact verification, and deployment are maintainer workflows documented in the [release playbook](agent-playbooks/release-process.md).

## Testing updates locally

To exercise the auto-updater against a local update server:

```bash
# Terminal 1: Start local update server
npm run serve:updates

# Terminal 2: Start app with updates enabled
npm run start:test-updater
```
