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
- Check the separate Ethereum and Gnosis controls under **Settings → Automatic Startup** and the Nodes panel.
- Review the application log for native-addon load, peer, or synchronization errors.

## Tor or `.onion` access fails

- Ensure **Settings → Experimental → Enable Tor (.onion access) (Beta)** is enabled.
- For source builds, run `npm run tor:download`; it requires a Rust toolchain and is currently supported on macOS and Linux.
- Check the Nodes panel for Arti bootstrap status and the active profile's SOCKS5 endpoint.
- Freedom fails closed for `.onion` traffic if Arti exits, so restart Tor rather than expecting a direct-network fallback.

## Using an external node

- If you have a system-wide Swarm node or Tor SOCKS5 proxy running, configure external mode in **Settings → Nodes**. Radicle has no external mode; it always runs as the profile's embedded node
- External mode is per profile and per protocol
- The Nodes panel shows external/shared status when connected to an external node
- Freedom does not stop external nodes on quit

## ENS resolution not working

- Verify internet connectivity
- Open the address-bar verification details to inspect the Colibri or RPC result.
- Review **Settings → Name Resolution**, **Chains**, and **RPC Providers**.
- For development, prepend a custom mainnet endpoint with `ETH_RPC`.

## Content not loading

- Ensure the relevant Ant, IPFS, Radicle, Myotis, or Tor component is running in the Nodes panel; enable optional integrations in Settings first.
- Verify the Swarm reference (64 or 128 hex), CID, or Radicle ID is correct
- Open **Menu (☰) → Developer Tools** and check the page's console for error messages
