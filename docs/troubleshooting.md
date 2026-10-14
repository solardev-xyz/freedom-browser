# Troubleshooting

## Swarm node (Ant) fails to start

- Check the Nodes panel for the reported state and error.
- Freedom automatically detects managed-port conflicts and persists a free profile port.
- For source builds, confirm that `npm run ant:download` installed the binary for the current platform.
- Check the application log for Ant startup, configuration, or identity errors.

## IPFS fails to start

- IPFS uses the embedded `freedom-ipfs` native addon and does not open a loopback API or gateway port.
- For source builds, rerun `npm run ipfs:download` and confirm the addon target matches the current OS and architecture.
- Check the Nodes panel and application log for native startup diagnostics.

## Radicle fails to start

- Ensure Radicle is enabled for the profile under **Settings → Nodes**
- Radicle runs in-process through the `libradicle` addon, so there are no managed ports and no daemons to conflict with
- Ensure `libradicle.node` exists in `radicle-bin/<platform>-<arch>/` for source builds (packaged builds use `radicle-bin/` under the app's resources directory); rerun `npm run radicle:download` if it is missing
- Ensure Git is installed and available on `PATH` — it is needed for GitHub repository imports
- If starting for the first time, Freedom creates a Radicle identity automatically
- Check terminal output for specific error messages
- For a fresh Radicle identity and repository store, create a new browser profile

## Myotis fails to start or synchronize

- Confirm `npm run myotis:download` installed the native addon for the current OS and architecture.
- Check the separate Ethereum and Gnosis controls under **Settings → Nodes → Startup** and the Nodes panel.
- Review the application log for native-addon load, peer, or synchronization errors.

## Tor or `.onion` access fails

- Ensure **Settings → Advanced → Enable Tor (.onion access)** is enabled.
- For source builds, run `npm run tor:download`; it requires a Rust toolchain and builds Arti for the host — macOS, Linux, and Windows x64 (on Windows it also needs the x64 MSVC tools). Releases cut after Windows Arti bundling landed (September 2026) carry Arti on macOS arm64, Linux x64/arm64 and Windows x64; a Windows release older than that bundles none, so update to the latest build. The Tor rows stay hidden whenever no Arti is bundled — an older Windows release, or a source build that skipped the download.
- Check the Nodes panel for Arti bootstrap status and the active profile's SOCKS5 endpoint.
- Freedom fails closed for `.onion` traffic if Arti exits, so restart Tor rather than expecting a direct-network fallback.

## Switching profiles on Linux shows "Freedom is ready"

GNOME on Wayland only brings a window to the front when the request carries an
activation token from your own click or key press; without one it posts
"Freedom is ready" instead. Freedom passes the token along when you switch to a
profile that is already open from the profile menu or from a dock launcher for
that profile, on the installed `.deb` or pacman package. The switch from the
profile menu goes through `xdg-open`, so it needs the package's
`freedom.desktop` to handle the profile-switch scheme:
`xdg-mime query default x-scheme-handler/x-freedom-profile` should print
`freedom.desktop`. X11 sessions never needed this.

Two ways in still end with the notification on Wayland (observed on GNOME 46,
October 2026), because the launch that reaches the open profile has no token
to pass on:

- Running `freedom --profile=<id>` from a terminal while that profile is open.
- Picking a profile launcher from the Activities overview search while that
  profile is open.

Click the notification, or switch from the profile menu or the dock instead.
The profile menu uses `xdg-open` only when the installed `freedom.desktop`
starts the very Freedom you are running. An AppImage without desktop
integration, a source build, or an AppImage running beside an installed
`.deb` (whose `freedom.desktop` starts the `.deb`'s binary) falls back to the
older focus request and shows the notification.

The profile-switch scheme only ever brings an already-open profile to the
front. Any program can run `xdg-open x-freedom-profile:<id>`, including a page
in another browser once you confirm its prompt, so it opens no links, never
starts a profile that is closed, and leaves the profile a plain `freedom`
launch opens unchanged.

## Using an external node

- If you have a system-wide Swarm node or Tor SOCKS5 proxy running, configure external mode in **Settings → Nodes**. Radicle has no external mode; it always runs as the profile's embedded node
- External mode is per profile and per protocol
- The Nodes panel shows external/shared status when connected to an external node
- Freedom does not stop external nodes on quit

## ENS resolution not working

- Verify internet connectivity
- Open the address-bar verification details to inspect the Colibri or RPC result.
- Review **Settings → Networks**: Chains, RPC Providers, and Name Resolution.
- For development, prepend a custom mainnet endpoint with `ETH_RPC`.

## Content not loading

- Ensure the relevant Ant, IPFS, Radicle, Myotis, or Tor component is running in the Nodes panel; enable optional integrations in Settings first.
- Verify the Swarm reference (64 or 128 hex), CID, or Radicle ID is correct
- Open **Menu (☰) → Developer Tools** and check the page's console for error messages
