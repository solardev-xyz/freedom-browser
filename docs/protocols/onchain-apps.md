# Contract-hosted Applications (ERC-8244)

Freedom has native support for the draft [ERC-8244](https://ethereum-magicians.org/t/erc-8244-contract-hosted-application-html/28407) `html()` interface: an application whose whole document lives in contract storage on an Ethereum-compatible chain, with no HTTP gateway and no page-selected RPC endpoint in the path.

Enter the ERC-4804-style form `web3://<contract>:<chainId>/` in the address bar; omitting `:<chainId>` defaults to Ethereum mainnet.

## Origin model

Freedom keeps the standard form in browser chrome, history, bookmarks, copying, and permission prompts, while the webview navigates to a Chromium-safe, chain-scoped origin internally:

```text
web3://0x00000095643CFfA7D9fae407a84dfCB6406456c6
→ web3://0x00000095643cffa7d9fae407a84dfcb6406456c6.eip155-1/
```

The `.eip155-<chainId>` suffix is invisible browser plumbing, not an extra DNS or gateway dependency. A bare all-hex `0x…` standard-scheme host is rejected by Chromium as an oversized IPv4 literal, while using the chain as a URL port triggers unsafe-port rules and excludes large chain IDs. The internal hostname gives each contract-and-chain pair a distinct web-storage origin; page scripts and DevTools therefore see that real internal origin, while Freedom's user-facing surfaces reverse-map it to the standard URL.

## Resolution

`web3` is registered as a privileged standard scheme in `src/main/index.js`, alongside `bzz`, `ipfs`, and `ipns`; the handler itself lives in `src/main/onchain/onchain-app-protocol.js`.

The read is the core's `chain.html` (freedom-core design 0006), on the same capability-aware chain data the wallet uses (`src/main/networks/chain-data.js`, routed in the core, design 0005): the core calls selector `0x33c34ac3` (`html()`) at `latest` through Myotis when available, then Colibri, RPC quorum, and direct RPC fallback according to network policy, interactive for the page's origin. The core ABI-decodes the returned UTF-8 string, caps it at 8 MiB, hashes it (Keccak-256) and classifies the read's trust as `trusted`, `conflict` or `untrusted`; the handler serves those bytes unchanged as `text/html`, and keeps the approvals and the trust interstitial. Paths, queries, and fragments remain available to the app as client-side routes. Each document load has a 30-second deadline, which the core's read shares, and a navigation that is aborted or runs out of its 30 seconds cancels the read. A document over the limit is a 413; a timeout or a cancel is a 504, a busy core a 503, and any other failure a 502. Nothing is decoded on Electron's main thread, which only turns the core's base64 into the response.

## Security model

Contract HTML runs in a context-isolated webview with a response-enforced sandbox and default-deny content policy. Inline scripts/styles and embedded `data:`/`blob:` media work, but ambient network connections, external frames, workers, objects, scripted top-level redirects, and popups are blocked. Genuine user link clicks are handed back to Freedom's navigation chrome.

The app receives the existing EIP-1193/EIP-6963 wallet provider; reads and approvals are pinned to the chain encoded in its origin, and `wallet_switchEthereumChain` cannot silently move it to another chain. A global wallet-chain change does not emit a contradictory `chainChanged` event into a pinned app. Every contract-and-chain pair gets its own wallet permission key.

Private windows can render the document but continue to omit wallet providers, matching every other protocol.

## Scope

This first slice resolves contracts directly. Registry fallback and upgrade-policy discovery, described as optional extensions in the ERC, are not inferred by the browser; an upgrade-aware resolver contract can expose its own `html()` result.
