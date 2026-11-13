# Development

This guide covers local setup, the repository layout, tests, debugging, and development builds. Read [CONTRIBUTING.md](../CONTRIBUTING.md) before proposing a change.

## Prerequisites

- Node.js 24 LTS. The pinned version is in [`.nvmrc`](../.nvmrc).
- npm, included with Node.js.
- Git.
- Platform build tools required by Electron native modules.
- On Linux, the udev and libusb development headers for the Ledger USB modules (`usb`, pulled in by `@ledgerhq/hw-transport-node-hid`, is rebuilt from source during `npm ci`). On Debian/Ubuntu:

  ```bash
  sudo apt install libudev-dev libusb-1.0-0-dev
  ```

  This is the same pair CI installs in [`install-linux-native-deps`](../.github/actions/install-linux-native-deps/action.yml). Without `libudev-dev`, `npm ci` fails in `electron-builder install-app-deps` with `fatal error: libudev.h: No such file or directory` while building `node_modules/usb`; install the packages and run `npm ci` again.

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
npm run ipfsd:download
npm run myotis:download
npm run myotis:build-supervisor
npm start
```

**Linux: `chrome-sandbox` must be setuid root.** On distributions that restrict unprivileged user namespaces through AppArmor (Ubuntu 24.04 and later ship `kernel.apparmor_restrict_unprivileged_userns=1`), Chromium falls back to its SUID sandbox helper, and `npm start` aborts with `The SUID sandbox helper binary was found, but is not configured correctly` and `exited with signal SIGTRAP`. Electron downloads its binary on first launch rather than during `npm ci`, so fetch it first, then hand the helper to root:

```bash
npx --no install-electron
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Repeat all three commands after every `npm ci` and every Electron version bump: both discard the binary, and the fresh download is owned by you again. `--no-sandbox` is for throwaway headless runs only — the headless skill in `.claude/skills/run-freedom/`, the packaged CI smoke tests, and the source-tree Playwright e2e runs on Linux use it. The `harness` and `live` projects get it from Playwright's own Electron launcher, which adds it on Linux unless a test opts in with `chromiumSandbox: true`, so `npm run test:e2e` does not exercise the sandbox there. The `packaged` projects bypass that launcher and start the binary themselves, so they only add it when you set `FREEDOM_E2E_NO_SANDBOX=1` (see below) — without it, a packaged run on such a distribution hits the same SUID abort unless that build's own `chrome-sandbox` is setuid root. Don't develop with `--no-sandbox`, because a browser running with the renderer sandbox disabled hides real behaviour.

Swarm and IPFS start automatically by default, while Radicle and Myotis are opt-in under **Settings → Nodes → Startup**. IPFS runs on freedom-ipfsd, a service process (freedom-core design 0007), fetched by `npm run ipfsd:download`; without it, IPFS reports `freedom-ipfsd binary not found`. `FREEDOM_IPFSD_PATH` points a development build at another build of the binary. Private windows get a second, memory-only freedom-ipfsd process, started on their first IPFS request, with an instance of its own for each window (the add-on serves them from the profile's node). The add-on is the rollback: fetch it with `npm run ipfs:download` and start with `FREEDOM_IPFS_BACKEND=addon` (development builds only). The binary's `hold-lock` is the IPFS data directory's gate: the add-on runs under it, and profile delete holds it while it removes a profile's IPFS data. A development build without the binary goes on ungated, with a warning; a packaged build ships it, and refuses such a delete without it. Radicle runs on freedom-radicled, a service process (freedom-core design 0008), fetched by `npm run radicled:download`; without it, Radicle reports `freedom-radicled binary not found`. `FREEDOM_RADICLED_PATH` points a development build at another build of the binary. Enable Radicle for the profile under **Settings → Nodes**. The node's key comes sealed from the identity core at each start, so on a profile with a vault it waits for the vault's unlock, and a profile without one runs with a throwaway key. Its first start on a home removes `keys/radicle` (the switch): an identity libradicle generated there ends, though what it published stays. The service binds no control socket, so the `rad` CLI can't attach to Freedom's node; a developer setting may reopen it later. The reads main collects (the node and repository listings, a repository's info and seeders, the identity) go to the service, and so do the `rad:` and `radapi:` pages (the repository viewer and dweb pages' repository reads): each request takes the dweb fetch admission and streams the service's answer, and a page that goes away cancels its read. Seeding fetches run on the service too: the seeds and the default repository's clone after each start, a seed's or a sync's fetch with its progress (peer failures past eight come as one summary with their count), and its cancel. The Radicle DID shown is the running node's, from its start (a throwaway key's is marked so); while the vault is unlocked, the DID its next start will use is shown apart, and nothing reads `keys/`. While the node runs with a throwaway key, COB writes and the GitHub bridge's import are refused (`needs_vault`); creating, locking or deleting the vault changes that only at the node's next start. The COB writes (issues, their comments and states, patch comments) and unseeding run on the service, each on the node generation that was running when it was admitted. A write the node took but didn't confirm (it failed partway, or the process stopped or crashed with it in flight) is reported as possibly recorded (`outcome_unknown`), and never sent again. Onboarding writes no Radicle identity, since the derived one arrives sealed at each start; only a forced re-injection changes the identity: the node stops, the identity core wipes its state and removes the key files under the home's gate, writing no key, and the node starts again once that write is installed. While another process holds the home, or the core couldn't finish the write, the node stays stopped and the write is retried. A start that runs out of time reconciling the Radicle data shows "Radicle is still repairing its data" in the Nodes menu, with Retry, which continues where it left off. Each repository the service quarantined because it couldn't repair it shows there as "Radicle couldn't repair <name>", with the kind and step, and Remove: after a confirmation, the service deletes its local copy (`rad.remove_repo`, bound to the record main showed). The GitHub bridge's import runs on the service too, in a one-shot freedom-radicled `import` process: the node stops, the process reconciles the Radicle data and imports the bridge's clone (made in the OS's temporary directory, outside Freedom's own directories, and only read), and the node starts again. On a profile with a vault the import waits for its unlock, as a start does; it's refused in private windows and while the node runs with a throwaway key. An import cut off once it has started (a crash, a kill, or its 300 s deadline) is reported as possibly imported, and the node's next start reconciles the data. The add-on is the rollback: fetch it with `npm run radicle:download` (macOS, Linux, and Windows x64/ARM64) and start with `FREEDOM_RADICLE_BACKEND=addon` (development builds only; packaged builds ignore it, and still ship the add-on without loading it). It runs only under freedom-radicled's `hold-lock`, the Radicle home's gate, so it needs the binary too, and only on a home that still has `keys/radicle`: not on one the service has switched, nor on a new profile without a vault, where the add-on would generate a new identity. The alias rewrite and profile delete take the gate too; a development build without the binary runs them ungated, with a warning, and a packaged build ships it. Install optional Tor support with `npm run tor:download` (macOS, Linux, and Windows x64 — it compiles Arti for the host), then enable it under **Settings → Advanced**; the Tor rows stay hidden until that binary exists.

The approvals document is on by default (freedom-core design 0011, steps APS-1 to APS-5 and the step after them): each window has a panel of its own, beside the content below the toolbar where the wallet sidebar shows its prompts, that shows the dApp prompt main holds for the tab in front and takes the decision on it, while the page makes room for it; the chrome's own prompt screens no longer decide (`src/main/approvals/`, `src/renderer/approvals/`). The wallet's own approvals (a send, a Safe send, a held payment's resend, replacement or close, an executor's fee) ask there too, and their tokens are minted only on the user's approval in the panel (APS-3). The Safe signing boards show there too, run by main (APS-3b): a page's Safe message and Safe send, and the wallet's own SafeTx, each with the owner to sign picked in the panel, a vault unlock and an executor's fee asked there, and a discard asked twice; only a phone owner's QR stays in the sidebar, in the window that asked. A view over 256 KiB (very large transaction data, typed data or a message) comes to the panel in parts and still shows in full; a fee above the threshold is asked about once, in the panel, not first in the chrome; and a held payment's resend is asked again only when the payment was replaced, saying so (APS-4). An x402 payment (a 402's Pay on the sidebar card) and an edit of a site's auto-pay cap ask there too, with main's record of the payment and of the cap, so the chrome mints no approval of its own; an x402 payment's phone job goes to the window that hosts its tab, and an auto-pay within a cap still asks nothing (APS-5). The agent's own transfer sends a phone account's job to the agent's window, the one whose chrome owns its conversation; a page's request in Agent custody already goes to the window that hosts its tab, and a closed window gets nothing (REMOTE_NO_UI). `FREEDOM_APPROVALS_DOCUMENT=0` turns it off in a development build, the rollback to the chrome's own prompt screens (packaged builds ignore it and always run the panel); any other value is warned of and runs the default.

Myotis also requires its small supervisor built from checked-in source with an
already installed C compiler: Apple clang/CLT on macOS, a native C compiler on
Linux, or an **x64 MSVC developer shell** on Windows. No compiler is downloaded
by the helper build. `npm run build` and `npm run dist` build it before binary
checks, including each requested macOS architecture. Foreign targets require
helpers built on the target host and placed in `myotis-bin/<os>-<arch>/`.
The standalone Windows Node-only supervisor checks passed at `fa14433f`;
that is not Electron or packaged-app qualification for this merged branch.
Missing tooling is a build blocker, not authorization to omit the helper.
On the Agent branch, macOS `npm start` prepares both native supervisors through
`scripts/prepare-native-supervisors.js`; Linux/Windows development retains the
explicit Myotis build command. The same hook prepares both packaging inputs,
and `scripts/sign-native-supervisors.js` composes workspace manifest sealing
with the Myotis helper's restricted entitlements.
See [Myotis isolation and qualification](myotis-process-isolation.md).

### Experimental Windows Agent workspace backend

On the Agent Windows branch, build the native workspace helpers on Windows with
`npm run build:windows-workspace`. This requires an installed MSVC C++ toolchain
and Rust 1.95 (the pinned source's toolchain); `FREEDOM_CARGO` can select an existing
Cargo executable. The build downloads checksum-pinned Codex sandbox source and
uses its locked dependencies. It builds only the sandbox adapter/setup/runner,
not the Codex agent CLI. Packaging runs this build hook automatically; this
experimental hook currently requires a native Windows host.

First use requires one-time administrator provisioning of Freedom's restricted
accounts and network rules. Workloads subsequently run without administrator
rights. Windows confines writes but permits broad reads. Strictly offline shell
commands are unavailable: ordinary commands require the existing direct-network
grant, exact command/directory for allow-once or broader conversation scope when
selected. Fixed built-in file operations use a separate internal helper path and
do not acquire an implicit network grant. The workspace approval explains these
differences from macOS/Linux. Missing helpers
or incomplete setup fail closed. MXC is not currently selected.

After setup, use a standard-user desktop session (or an existing interactive task
for that user) for the synthetic qualification scripts:

```powershell
node scripts/qualify-windows-workspace.js --root C:\freedom-test\qualification
$env:ELECTRON_RUN_AS_NODE = '1'
$env:NODE_ENV = 'test'
& .\node_modules\electron\dist\electron.exe scripts/qualify-windows-controller.js --root C:\freedom-test\qualification
```

To qualify an installed build instead of the development helpers in
`out/windows-workspace`, add `--runtime <install>\resources\windows-workspace`
to `qualify-windows-workspace.js` (for a per-user install, `<install>` is
`%LOCALAPPDATA%\Programs\freedom-browser`). Add `--home <dir>` if setup
provisioned a sandbox home other than the default
`%LOCALAPPDATA%\FreedomBrowser\Sandbox`. Both apply to every check, including
the opened-handle reads. `qualify-windows-controller.js` takes no `--runtime`; run
from a checkout, it uses `out/`.

The scripts retain their fixtures and JSONL results. This does not replace the
packaged-app, first-use UI and installer checks recorded in the Agent roadmap.

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

| Script                           | Description                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `npm start`                      | Launch Electron in development mode                                                |
| `npm run lint`                   | Run ESLint                                                                         |
| `npm test`                       | Run the Jest unit suite                                                            |
| `npm run test:coverage`          | Run Jest with coverage                                                             |
| `npm run test:e2e`               | Run the deterministic Playwright harness suite                                     |
| `npm run test:e2e:live`          | Run live node, protocol, and naming integration tests                              |
| `npm run test:e2e:packaged`      | Smoke-test a packaged build (`FREEDOM_E2E_EXECUTABLE`)                             |
| `npm run test:e2e:tor`           | Run the live Tor `.onion` integration test                                         |
| `npm run test:e2e:startup-smoke` | Launch with real nodes and fail if the main process blocks > 1 s in its first 90 s |
| `npm run check-binaries`         | Validate packaged native binary targets                                            |
| `npm run ant:download`           | Download the pinned Ant binary                                                     |
| `npm run ipfsd:download`         | Download the pinned freedom-ipfsd binary, the IPFS node                            |
| `npm run ipfs:download`          | Download the pinned freedom-ipfs native addon, the rollback (see above)            |
| `npm run radicled:download`      | Download the pinned freedom-radicled binary, the Radicle node                      |
| `npm run myotis:download`        | Download the pinned Myotis native addon                                            |
| `npm run radicle:download`       | Download the libradicle addon for the current platform, the rollback (see above)   |
| `npm run radicle:build-addon`    | Build the libradicle addon from a sibling checkout                                 |
| `npm run tor:download`           | Build the Arti Tor binary for the current platform                                 |
| `npm run adblock:download`       | Download the packaged ad-blocking lists and scriptlet resources                    |
| `npm run ipfs:native:smoke`      | Smoke-test the IPFS node and retrieval path (`FREEDOM_IPFS_BACKEND=addon`: addon)  |
| `npm run ant:smoke-upload`       | Exercise a Swarm buy/upload/download round trip                                    |

The scripts in `package.json` are the authoritative list. Destructive reset scripts remove local development data; inspect their targets before using them.

## Testing

### Unit tests

Run all Jest tests:

```bash
npm test
```

Most source modules have a neighboring `.test.js` file. At minimum, run the corresponding test whenever you modify a tested module. Run `npm run lint` after every code change.

The Radicle backend contract suite (`src/main/radicle-backend.contract.test.js`, freedom-core design 0008) reads a fixture repository through a real backend and checks every read against golden vectors (`test/fixtures/radicle-contract/`). It is skipped unless a backend is named: `radicled`, the default node, or `addon`, the rollback, which runs under freedom-radicled's `hold-lock` and so needs both downloads:

```bash
npm run radicled:download
FREEDOM_RADICLE_CONTRACT_BACKEND=radicled npx jest src/main/radicle-backend.contract.test.js
npm run radicle:download
FREEDOM_RADICLE_CONTRACT_BACKEND=addon npx jest src/main/radicle-backend.contract.test.js
```

Its `[pending: …]` tests cover what the Radicle service adds. They run against a backend that honours them, or with `FREEDOM_RADICLE_CONTRACT_PENDING=all` (or a comma-separated list of features). `FREEDOM_RADICLE_CONTRACT_RECORD=1` remakes the fixture through the add-on and records the vectors again.

### End-to-end tests

Playwright has four projects:

| Suite           | Command                     | Behavior                                                                                                       |
| --------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `harness`       | `npm run test:e2e`          | Launches Electron with deterministic Ant/IPFS/naming stubs; fast and network-independent                       |
| `live`          | `npm run test:e2e:live`     | Uses real nodes, protocols, and network resolution; requires downloaded binaries                               |
| `packaged`      | `npm run test:e2e:packaged` | Runs the release smoke checks (launch, version, persistence) against a built binary instead of the source tree |
| `packaged-live` | `npm run test:e2e:packaged` | Same built binary without the harness stubs: its bundled nodes really start and navigation really goes out     |

`npm run test:e2e:packaged` runs both packaged projects. They need `FREEDOM_E2E_EXECUTABLE` pointing at that binary and refuse to run without it; add `FREEDOM_E2E_NO_SANDBOX=1` on a headless machine. After `npm run build -- --linux --x64`, that is `FREEDOM_E2E_EXECUTABLE="$PWD/dist/linux-unpacked/freedom" FREEDOM_E2E_NO_SANDBOX=1 xvfb-run -a npm run test:e2e:packaged`; to run only the slow half, call Playwright directly with `npx playwright test --project packaged-live` (adding `--project` to the npm script would union with the two projects it already names). `packaged-live` uses the same per-test scratch data directories as `live`, and skips its Tor check (with the reason) on builds that bundle no Arti binary. Packaged builds ship with the `EnableNodeCliInspectArguments` fuse off, so both projects start the binary themselves with `--remote-debugging-port=0` and attach Playwright over CDP (`test-e2e/packaged-launch.js`) instead of through `_electron.launch`, which needs `--inspect`. Two consequences for packaged specs: there is no `electronApp.evaluate()` in the main process — read main-process facts through the harness's fixed `electronApp.appFacts()` / `electronApp.testOp()` operations instead — and the app only honours `--remote-debugging-port` when `FREEDOM_TEST_USER_DATA` names a scratch profile (`src/main/remote-debugging-gate.js`), which both fixture files always set. The harness itself (`FREEDOM_TEST_MODE=1`, `fixtures.js` only) is honoured by a packaged build only when that same launch also kept `--remote-debugging-port` — a valid port on a scratch `FREEDOM_TEST_USER_DATA` profile, exactly what the launcher passes; set on its own, the variable is ignored by a shipped build (`src/main/test-mode.js`, which also argues why this grants nothing the open debugging port does not already give). The release workflow runs both suites against every artifact it just built — the macOS `.dmg` and `-mac.zip`, the Linux x64/arm64 `.deb` and AppImage, the Windows installer and portable zip (see `agent-playbooks/release-process.md` §6).

All four suites use a temporary Electron `userData` directory and run sequentially. Every chrome window has its approvals panel, a page of the app of its own, so a fixture takes the chrome by its URL (`test-e2e/chrome-window.js`), never `firstWindow()` alone, and a spec decides a prompt in the panel through `test-e2e/approvals-fixtures.js` (`decideInPanel`, which waits out main's 500 ms input delay; `seedVault`/`vaultWallets` put a Ledger account in main's wallet list for the panel to show), not on the chrome's screens. No fixture hides the Electron window by default, because a hidden window starves Playwright's click/check actionability waits of animation frames and lets a click on chrome that has just appeared over a page land on the page instead (#479, #536). `FREEDOM_TEST_HIDE_WINDOW=1` still hides it, and every fixture that doesn't pin it passes the caller's environment through — the harness and `live` fixtures (`test-e2e/fixtures.js`, which the packaged specs share, and `test-e2e/live-fixtures.js`) and the profiles and Radicle fixtures (`test-e2e/profiles-fixtures.js`, `test-e2e/radicle-fixtures.js`) — so a run with it set is hidden in all of them: CI's Myotis resolver step (`.github/workflows/ci.yml`) exports it for `test-e2e/live/myotis-ens.spec.js`, which drives no clicks or checks. If a spec run under that variable starts flaking on actionability waits, unset it first. The onboarding, Safe, Safe-phone and remote-signing fixtures pin it to `0`, so an inherited value can't hide their windows. On Linux, run the suites under `xvfb-run -a` so the window lands on a virtual display. The full CI matrix covers the operating-system-specific and native-node checks that most contributors cannot reproduce locally.

**Agent specs on Linux.** Playwright's Electron launcher adds `--password-store=basic` to every launch (and `--use-mock-keychain` on macOS). On Linux that leaves safeStorage on its hard-coded-key `basic_text` backend, which the app refuses for credentials, so the harness installs a mock credential store for exactly that case (`installLinuxMockCredentialStore` in `src/main/test-harness.js`), the Linux counterpart of the macOS mock keychain. The real-sandbox specs in `agent-sidebar.spec.js`, and `automation-runtime.spec.js` / `freedom-cli.spec.js`, which spawn Electron without `--no-sandbox`, additionally need what the `.deb` installs for users: `bwrap` (`sudo apt-get install bubblewrap`), the Linux workspace owner helper (`npm run build:linux-workspace-supervisor`, needs `/usr/bin/gcc`), and on Ubuntu 24.04 and later an AppArmor profile that lets the checkout's Electron binary create user namespaces. `.github/actions/linux-agent-sandbox/action.yml` sets up all three for the `e2e-agent-linux` and nightly `e2e-full` jobs; its profile step is the one to copy for a local run. Without them these specs fail with `The Bubblewrap executable is unavailable`, `Linux x64 workspace owner requires installed matching helper…`, or a Chromium SUID-sandbox abort.

`npm run test:e2e:startup-smoke` (`test-e2e/live/startup-responsiveness.spec.js`) is the check for a main-process freeze like #495: it starts the app with real nodes on a fresh profile (`npm run ant:download` first; `xvfb-run -a` on headless Linux), times back-to-back main-process round trips for 90 s, and fails if any exceeds 1 s or the watchdog logged a stall. `FREEDOM_STARTUP_SMOKE_SECONDS` and `FREEDOM_STARTUP_SMOKE_MAX_RTT_MS` override both numbers; the report and the run's `main.log` land in `test-results/`. It is opt-in: the spec skips unless `FREEDOM_STARTUP_SMOKE=1` (the npm script sets it), so a plain `npm run test:e2e:live` doesn't spend 90 s on it. It needs the network, so it runs nightly (`.github/workflows/startup-smoke.yml`, also dispatchable by hand), not on pull requests.

`node scripts/check-blockscout-pair.js` is the live check of the Blockscout pairing behind Ant's first wallet scan (#529, #596): it starts the pinned `freedom-cored` (`node scripts/fetch-freedom-cored.js` first, or set `FREEDOM_CORED_PATH`), configures Gnosis as a fresh profile has it, and scans through main's own drivers and executors the way the Ant bridge does — the `ant_scan` profile and Ant's window halving — against live Blockscout and the public Gnosis RPCs. It fails unless every scan is answered by Blockscout paired with an RPC in a few requests, with the expected pages and transfers; a failure names each broken scan, the core's last refusal and what Blockscout answered. It needs the network, so it runs nightly (`.github/workflows/blockscout-canary.yml`, also dispatchable by hand), not on pull requests. A schedule runs from the default branch only, so on `integration/rust-core` it runs by hand until the release merges it into `main`.

CI does not run the harness project wholesale: each `e2e-*` job in `.github/workflows/ci.yml` names its own list of specs. When you add a `test-e2e/*.spec.js`, add it to the job that fits its area. If it can't run in CI yet, add a `# e2e-not-in-ci: <spec> — <reason>` line to the list above those jobs, with the issue that tracks it. `scripts/ci/e2e-spec-coverage.test.js` fails the `test` job on a spec that is in neither place.

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
- Launch with `FREEDOM_LOG_SYNC=1` when chasing a main-thread hang or a native crash. The log file is written asynchronously by default (#511). Every `warn` and `error` line is still on disk, after everything logged before it, by the time the call that logged it returns, but the `info` lines logged since the last warning can still be queued when the main thread wedges or the process is force-quit, SIGKILLed or segfaults, and never reach the file. This setting writes every line before the next statement runs, as before #511, at a main-thread cost per line.
- Search the log for `[main] event loop blocked`: the main process's watchdog (`src/main/event-loop-watchdog.js`) writes it when the main thread stalls for 1 s or more, naming any chain-data reads that were running (`chain-data: 100 eth_getLogs via colibri, 22675 ms`). Further stalls within 30 s are folded into one summary line, written once the 30 s pass or when the app quits. Fee quotes (`fee quote`) and transaction broadcasts (`eth_sendRawTransaction`) are named the same way as other chain-data reads; time the machine spends asleep is not reported.

## Development builds

Build an unpacked, unsigned application for the host platform with:

```bash
npm run build -- --mac --unsigned
```

Replace `--mac` with `--linux` or `--win` as appropriate. Native modules no longer need compiling for the target: `better-sqlite3` v13 ships prebuilt addons for every target we package (`darwin`/`linux`/`linuxmusl` x `x64`/`arm64`, plus `win32`), and each installer is built carrying only its own. Linux _distributables_ still use the Docker scripts, because the `.deb` and `.pacman` targets need a system `fpm` (`USE_SYSTEM_FPM=true`) and its Ruby toolchain running in a container of the target architecture, which also fetches the arch-matched Radicle/IPFS/Myotis addons:

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

`dev-app-update.yml` is gitignored, so a fresh checkout has none; create it in the repository root first. From a source checkout the updater reads it as its update config, so it needs at least:

```yaml
provider: generic
url: http://localhost:8765
updaterCacheDirName: freedom-browser-updater
```

`serve:updates` serves files from `dist/`, with one exception: a request for `/latest-mac.yml` is answered with `dev-app-update.yml` itself, not `dist/latest-mac.yml`. On macOS the same file is therefore also the update manifest, so add the `version`, `files`, `path` and `sha512` entries of the build you want to offer (copy them from that build's `dist/latest-mac.yml`); without the file every macOS check 404s. On Linux and Windows the manifest (`latest-linux.yml`, `latest.yml`) comes from `dist/` as built.

macOS (Squirrel.Mac) never installs an update into an unsigned app. To test the full download and install, run a signed, packaged build with `ENABLE_DEV_UPDATER` set. A packaged build keeps its shipped `app-update.yml` and only swaps the feed URL: `ENABLE_DEV_UPDATER=true` uses `http://localhost:8765` (the `serve:updates` server, so the `/latest-mac.yml` rule above applies), and `ENABLE_DEV_UPDATER=<http(s) URL>` uses any other generic feed, for example:

```bash
ENABLE_DEV_UPDATER=https://updates.example.org/test-feed /Applications/Freedom.app/Contents/MacOS/Freedom
```

Surrounding whitespace in the value is ignored. `0`, `false`, `no`, `off` (any case) or an empty value read the same as leaving the variable unset: the dev updater stays off. Any other value (a URL without `http://`/`https://`, one that doesn't parse) logs a warning, shown in the terminal and the log file, and falls back to `http://localhost:8765`.

### Local dictation runtime

Development startup and packaging build the offline whisper.cpp CLI from pinned
source. Install CMake 3.16+ and a C++ toolchain (Xcode command-line tools on macOS,
MSVC Build Tools on Windows, or a C++ compiler and Make on Linux). Run
`npm run build:dictation` to prepare it explicitly; set `CMAKE` to an executable
path if needed. The cached artifact is checked before requiring the compiler.
Users of packaged Freedom download only the optional speech model, and need none
of these tools. See [local dictation](agent-dictation.md#on-this-device) for pins,
privacy boundaries, and qualification.
