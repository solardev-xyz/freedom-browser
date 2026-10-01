# PPv2 testnet route: continue without waiting for PP

**Latest October 1 result:** [Funding readiness](ppv2-funding-readiness-2026-10-01.md) supersedes the earlier pending checks: complete history reconstruction, real unfunded SDK session/registration simulations and a fresh-process restart passed. The explicit direct-relayer development route is implemented. The next live step requires Sepolia ETH; no live transaction has been submitted.

The PP questions were reasonable operational questions, but treating their reply or Tor relayer support as a prerequisite for every Sepolia test was too restrictive. We can independently select a history-capable RPC and explicitly test the disposable Sepolia lifecycle using a direct relayer connection. This does not qualify network privacy.

## Live checks on October 1

Using the [Chainlist Sepolia list](https://chainlist.org/chain/11155111) and its [published endpoint data](https://chainlist.org/rpcs.json), screened 12 public HTTPS endpoints directly. No credentials, wallet, private identifiers or transactions were used. Each connected candidate had to report chain 11155111 before historical reads. Requests were bounded to 12 seconds and 4 MiB; redirects refused.

The historical checks queried the known first keystore block 10994877 and pool blocks 10994884–10995383, filtering LeafInserted, LeavesInserted and LeafUpdated. These are discovery checks, not a scan of all history.

| Endpoint | Direct results | Tor results |
| --- | --- | --- |
| `https://gateway.tenderly.co/public/sepolia` | 1 keystore event; 18 pool events; both begin at leaf 0 | Same events and first block/transaction hashes |
| `https://sepolia.rpc.sentio.xyz` | Same as Tenderly | Same as direct |
| `https://0xrpc.io/sep` | Same as Tenderly | HTTP 404 on chain-ID request in this run |
| `https://ethereum-sepolia-rpc.publicnode.com` | Empty for both known historical ranges | Not repeated in this run; September 29 full scan was incomplete |

1RPC and Nodies also returned the first keystore event, but refused the 500-block pool request. Other screened candidates had HTTP, RPC or connection failures. These failures do not establish that their history is unavailable: provider-specific range limits, API behavior or availability may explain them. The shortlist is sufficient to proceed with deeper qualification.

The Tor checks used the existing wallet TLS/SOCKS implementation and a fresh bundled Arti process, with public service contexts, a 20-second request deadline and no direct fallback. Endpoint selections were independent probes, not a wallet retry sequence. Matching public observations do not cryptographically verify the chain or establish provider independence.

The staging relayer again returned HTTP 403 for details over Tor. Direct HTTPS details and a synthetic receive quote worked; the quote signature matched the existing pinned candidate signer, fee recipient and processor, with 59,876 ms remaining. This demonstrates quote access and signature consistency, not successful relay submission or operator confirmation of those roles.

[Machine-readable observations](qualification/ppv2-rpc-screen-2026-10-01.json) preserve the endpoint results and public event identifiers. No complete tree reconstruction, actual SDK sync, funding wallet or live transaction was performed in this follow-up.

## Revised next steps

1. Select Tenderly explicitly and reconstruct the complete pool and keystore trees from the deployment floor to a fixed finalized block. Compare the reconstructed roots with contract roots and cross-check the anchor/representative history with Sentio. Adapt bounded page sizes to documented or observed limits if necessary; never interpret a refused or truncated query as an empty range.
2. Finish the unfunded Kohaku session and registration simulation against that selected route. Repeat deployment and quote checks using current observations.
3. Add an explicitly selected, development-only Sepolia test route for direct relayer HTTPS, with a disposable test identity/profile. Preserve signature, routing, fee, proof, expiry, journal and uncertain-delivery checks. Keep RPC/ASP traffic over Tor where available. Direct relayer traffic exposes the test connection IP and the submitted operation to the relayer; using Tor for other roles does not restore unlinkability for the whole test.
4. Once the unfunded checks pass, request Sepolia ETH and exercise deposit, withdrawal, restart recovery and emergency exit. Report protocol-lifecycle qualification separately from transport-privacy qualification.
5. Retain Tor relayer compatibility as its own work item. PP can help with the 403 behavior, but its resolution need not block the explicit direct test route. Production privacy qualification and source/audit/distribution gates remain separate.

The direct product test route is a plan, not an implemented switch. The wallet currently requires Tor; no product transport, privacy label, runtime gate, dependency or automatic fallback was changed here. A direct experiment must not silently change that behavior or report itself as Tor protected.
