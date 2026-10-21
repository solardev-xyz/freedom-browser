# Configuration

## AI

AI is an explicit, profile-specific opt-in under **Settings → AI**
(`freedom://settings/ai`). It is off until you enable it, including in existing
profiles without a saved choice. Connect providers, manage favourite models and
choose the model for new chats on that page; existing chats keep their model.
Connected MCP services remain in the Agent composer's **+ → Connections** menu.

**Voice dictation** in Settings → AI selects a separate transcription service
and language. The microphone starts with a remembered choice or suitable connected
API service; its options arrow opens a compact service selector. Choose **Voice
dictation settings…** for language, audio privacy information and the optional local
Whisper download in Settings → AI → Voice dictation. Dictation inserts editable text and never
sends a prompt automatically. See [dictation setup](agent-dictation.md) for audio
privacy, provider support and current experimental limitations.
OpenRouter asks once before first recording to acknowledge standard audio routing;
chat zero-retention settings remain separate and unchanged.

Turning AI off cancels current Agent work and sign-in, closes pending approvals,
hides Agent entry points and blocks new model requests. Chats, provider
credentials, attachments and projects remain on this device; preview servers
already running keep running. It cannot undo an external action already sent.
Re-enable AI in the same place to continue. Ordinary browsing and wallet/node
features do not depend on this toggle.

The built-in start page offers a dismissible AI invitation while AI is off.
Dismissal is saved for that profile and survives restart; Settings remains
available. Private windows and custom homepages do not show this invitation.

## Node Endpoints

Freedom automatically manages node connections per profile. In a **packaged build**, the default profile's managed endpoints start at:

- **Swarm Ant**: `http://127.0.0.1:11633`
- **IPFS**: embedded native `freedom-ipfs` handler; no desktop loopback gateway/API port is started
- **Myotis**: embedded native Ethereum and Gnosis clients; no desktop loopback API port is started
- **Radicle**: embedded native `libradicle` addon; no desktop loopback API or P2P port is started
- **Tor**: profile-scoped Arti SOCKS5 proxy starting at `127.0.0.1:19150`

Named profiles use the next profile slot for Ant and Tor (`11634`, `19151`, and so on). The ecosystem default Swarm and Tor ports (`1633`, `9150`) are treated as external/system-node endpoints, not Freedom-managed defaults. IPFS, Myotis, and Radicle are native-only and do not expose or reuse external daemon ports. When a Swarm node already answers on `1633`, Freedom asks once whether the profile should use it or keep its own node. That includes launches outside the profile catalog (`--profile-dir`, `FREEDOM_TEST_USER_DATA`), which keep the answer in `external-node-decisions.json` in their profile directory; delete that file to be asked again. If such a profile keeps its own node, it starts on the next free port beside the existing one each time (there is no catalog entry to save a port in). A node the profile itself started that outlived a crashed Freedom is recognised (`ant-process.json` in the profile directory records its pid, API port and overlay address; it must still answer on that port with that overlay) and reused, on whichever port it runs, rather than offered.

**Source builds (`npm start`) never use these ports.** Development runs off a separate base (`21633`, `22633`, `29150`) plus a per-checkout offset derived from the checkout path, so several clones can run side by side without colliding — see `getManagedPorts()` in `src/main/profile-catalog.js`. Read the effective endpoint for the running profile from **Settings → Nodes** (or the Nodes panel) rather than assuming a port number.

If Freedom detects a compatible Swarm or Tor daemon on an ecosystem default port while that protocol is starting, it asks whether that profile should use the existing external node or keep an independent managed node. This check runs both during profile startup and when a managed node is started manually from the Nodes menu.

For advanced users who need to connect a profile to a remote or system Bee node or Tor SOCKS5 proxy, open **Settings → Nodes** and switch the relevant protocol to external mode. Each change is saved as you make it — the mode when you pick it, an endpoint when you leave its field — and an external switch waits until its endpoint is filled in; restart the node to apply it. Radicle has no external mode — it always runs as the profile's embedded node, and **Settings → Nodes** only enables or disables it. Development-only renderer gateway overrides are still available via environment variables:

```bash
# Connect to a remote Swarm node
export ANT_API="http://remote-host:1633"

npm start
```

## Command-Line Flags

Freedom reads a few launch options that choose the profile, plus links to open. They are resolved in `src/main/profile-resolver.js` (`resolveProfile`) and `src/main/launch-urls.js`. Both `--flag value` and `--flag=value` work.

| Input                  | Effect                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| `--profile <id>`       | Opens catalog profile `<id>`, creating it if it does not exist yet.       |
| `FREEDOM_PROFILE=<id>` | Environment variable, same as `--profile`. The flag wins if both are set. |
| `--profile-dir <path>` | Uses the folder `<path>` as the whole profile, outside the catalog.       |
| `<url> ...`            | Positional arguments: links to open as tabs (up to 16, see below).        |

A profile id is trimmed and lower-cased, every run of characters other than `a-z`, `0-9`, `_` and `-` becomes `-`, and leading and trailing dashes are dropped, so `--profile "Work Stuff"` opens `work-stuff` and `--profile -work-` opens `work`. An id containing `/` or `\`, an id of `.` or `..`, or one left empty after this (`--profile ---`) is refused: Freedom shows "Freedom profile could not open" and exits instead of opening a profile.

`--profile-dir` keeps everything (browser data, vault and managed node data) in `<path>`; a relative path resolves against the current directory. That profile is not registered in the profile catalog: it does not appear in `freedom://profiles` or the profile switcher, other profiles cannot be opened or managed from its window, and **Settings → Nodes** cannot change its node modes or endpoints. Its id and name come from the folder name. The "use the Swarm node already on `1633`?" answer is kept in `external-node-decisions.json` in that directory (see [Node Endpoints](#node-endpoints)).

The links accepted on the command line are `http`, `https`, `freedom`, `bzz`, `ipfs`, `ipns`, `web3`, `ens` and `rad` URLs; anything else (`file:`, `javascript:`, a bare word) is ignored.

Which profile opens, first match wins: `--profile-dir`, then `--profile`, then `FREEDOM_PROFILE`, then the most recently opened profile, then `default` (or, if `default` was deleted, the first remaining profile). `FREEDOM_TEST_USER_DATA` overrides all of these, but it is for the automated test suites only: it points the launch at a throwaway scratch profile. Electron's own `--user-data-dir` does not choose the profile; Freedom sets its data directory itself.

Each profile runs in its own process and can only be open once. Launching a profile that is already open focuses its window instead, and any links on that command line open as new tabs there. A launch for a different profile starts a second process with its own window.

Examples, opening the `work` profile with a link:

```bash
# Linux: the .deb and pacman packages put `freedom` on PATH
freedom --profile work https://example.com
# Linux AppImage
./Freedom-*.AppImage --profile work bzz://<reference>

# macOS: keep -n. Without it, `open` only brings an already-running Freedom
# (any profile) to the front and drops everything after --args. With -n the
# new instance opens `work`, or hands the link to it if `work` is already open.
open -n -a Freedom --args --profile=work https://example.com

# Windows (per-user install), Command Prompt
"%LOCALAPPDATA%\Programs\freedom-browser\Freedom.exe" --profile work https://example.com
# Windows, PowerShell
& "$env:LOCALAPPDATA\Programs\freedom-browser\Freedom.exe" --profile work https://example.com

# A profile kept in a folder of its own, outside the catalog
freedom --profile-dir ~/freedom-scratch

# Source checkout: arguments after `--` reach Freedom
npm start -- --profile work
```

In a packaged build, catalog profiles live in the app data directory (`~/.config/freedom` on Linux, `~/Library/Application Support/Freedom` on macOS, `%APPDATA%\Freedom` on Windows): `default` uses that directory itself, every other profile `Profiles/<id>` inside it. A source checkout keeps its own catalog under `Freedom Dev/<checkout>/` in the same parent directory, or under `FREEDOM_DEV_HOME` when that is set, so `--profile` in development never opens an installed copy's profiles.

## External Protocol Links And Profiles

Inside Freedom, `bzz://`, `ipfs://`, `ipns://`, `web3://`, `rad://`, and `.onion` URLs always resolve through the active profile's node and network settings and storage.

A link handed over by another app (the Linux `.deb` and pacman packages register Freedom as the handler for `ipfs:`, `ipns:` and `bzz:` links; the AppImage, macOS and Windows builds register no handler, so there such links reach Freedom only if you pass them on the command line) carries no profile choice of its own, so it follows the order in [Command-Line Flags](#command-line-flags): it opens in the most recently opened profile. If that profile is already running, the link becomes a new tab in its most recently focused normal (non-private) window; otherwise Freedom starts that profile with the link. To open a link in a specific profile, launch Freedom with `--profile <id>` and the URL, or navigate to it inside that profile's window.

## Ethereum Name Resolution

ENS, WNS, and GNS domains are resolved against Ethereum mainnet. ENS uses the ENS Universal Resolver; WNS reads the Wei Name Service contract directly; GNS reads the Gwei Name Service contract directly.

Under **Settings → Networks → Name Resolution**, enable and order the available methods. Each is listed by a plain-language name; its technical name, how it works, and — for the two that have them — its settings sit under that row's collapsed **Advanced** disclosure. A chain's own page under **Settings → Networks** lists the same sources under the same names.

- **Local node** (Myotis): Reads finalized Ethereum or Gnosis state through the embedded peer-to-peer light client.
- **Proof check** (Colibri): Cryptographically verifies answers against the chain's sync committee through a proof server (the Colibri prover). **Advanced → Proof server** overrides the server; leave it empty for the default.
- **Several servers must agree** (RPC quorum): Queries several independently configured servers and accepts matching answers. **Advanced → Agreement threshold** sets how many must agree out of how many are asked.
- **One server, unchecked** (Direct RPC): Trusts the first configured server; disabled by default for name resolution.

Freedom continues through the ordered methods when an earlier source is unavailable or cannot verify a request. An unverified answer can be held provisionally while later methods try to produce a verified result.

**Settings → Networks → Name Resolution → Gateway links → Always open without gateway** (off by default) opens pages on `eth.limo`, `eth.link` and `bzz.link` at their native `ipfs://` / `ipns://` / `bzz://` address when the name has that content, instead of offering it in the address bar.

Manage per-chain public and custom endpoints under **Settings → Networks → Chains**. API keys for supported commercial providers live under **Settings → Networks → RPC Providers** and remain profile-local. For development, `ETH_RPC` prepends an endpoint to the effective Ethereum mainnet pool:

```bash
export ETH_RPC="http://127.0.0.1:8545"
npm start
```

Never commit provider keys or put them directly in documentation, issue reports, or command history.

## Home Page

Edit `src/renderer/pages/home.html` to customize the welcome view shown on startup or when clicking Home.
