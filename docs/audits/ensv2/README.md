# ENSv2 readiness verification

Verification date: 2026-09-12. Environment: macOS arm64, Node 24.18.1,
Electron 44.3.0. Reference: [ENSv2 readiness guide](https://docs.ens.domains/web/ensv2-readiness/).

## Changes

- All ENS read paths enter the canonical Universal Resolver proxy,
  `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`, on Ethereum mainnet.
  Myotis uses its proof-verified generic EVM API; its pinned v0.1.7
  [native ENS API walks the legacy registry](https://github.com/biafra23/myotis/blob/v0.1.7/rust/myotis-evm/src/ens/mod.rs).
- Wallet and payment URI input accepts DNS and Unicode candidates. The main
  process retains ENSIP-15 normalization. Bare browser DNS names still navigate
  over HTTPS; `ens://example.com` explicitly requests ENS content resolution.
- Wallet forward/reverse lookups carry the selected chain. Address queries use
  the ENSIP-11 coin type, caches and concurrent work are scoped by chain, and
  absent L2 records do not silently fall back to the Ethereum address.
- CCIP callbacks work with block-pinned quorum reads. Callbacks retain the block
  and validate the sender; recursion is bounded. Myotis gateways also retain
  per-request time and response-size limits.
- Resolver execution errors no longer masquerade as an absent Colibri record;
  the next configured method can try. Conflicts and trust policy remain enforced.
- The ethers declaration now requires the already locked/installed 6.17.0.
  No resolved dependency or native node version was upgraded.

Freedom's integration reads addresses, primary names and contenthashes. No ENS
registration, renewal, name-management or ENS indexing implementation was found
in this audit; the guide's write/index migration work does not apply to these paths.

## Live results

Each row passed through direct RPC, block-pinned quorum, and the default
Myotis → Colibri → quorum policy (15 assertions). Myotis was unavailable during
this run, so default-policy success exercises fallback, not a synced Myotis node.

| Name                     | Destination chain | Expected and observed address                |
| ------------------------ | ----------------- | -------------------------------------------- |
| ur.integration-tests.eth | Ethereum          | `0x2222222222222222222222222222222222222222` |
| test.offchaindemo.eth    | Ethereum          | `0x779981590E7Ccc0CFAe8040Ce7151324747cDb97` |
| gregskril.com            | Ethereum          | `0x179A862703a4adfb29896552DF9e307980D19285` |
| test.ses.eth             | Ethereum          | `0x2B0F09F23193de2Fb66258a10886B9f06903276c` |
| test.ses.eth             | Base              | `0x7d3a48269416507E6d207a9449E7800971823Ffa` |

The Electron wallet checks use actual ENS network resolution with Colibri/quorum
and mocked wallet balances, fees and signing. No transaction is sent. The content
checks use the actual installed freedom-ipfs native node in an isolated profile.

```sh
NODE_OPTIONS=--experimental-vm-modules ENSV2_E2E=1 npm run test:unit -- --runInBand src/main/__tests__/integration/ensv2-readiness.test.js
ENSV2_UI_LIVE=1 npx playwright test test-e2e/ensv2.spec.js --workers=1
```

Without those opt-in flags, the network suite is skipped and wallet UI checks use
fixtures. Unit tests cover chain separation, reverse forward-verification,
normalization, nested CCIP callbacks, sender rejection, callback limits, node
lifecycle changes, MIME handling and navigation semantics.

## Why the checker downloaded

The live contenthash is
`ipfs://Qmaisz6NMhDB51cCvNWa1GMS7LU1pAxdF4Ld6Ft9kZEP2a`.
The native gateway returned 200 with `Content-Type: application/octet-stream`,
`Content-Length: 32`, and the UTF-8 body `Hello from IPFS Gateway Checker` plus a
newline. The fixture is a plain text file, not an HTML website. Name resolution
was working; generic MIME caused Chromium to download it.

Freedom now displays small, complete UTF-8 octet-stream responses as
`text/plain; charset=utf-8` with `nosniff`. The probe is limited to 4 KiB and
preserves binary data, explicit download headers, ranges and declared MIME.
It never promotes content to executable HTML. Both live browser checks observed
zero download events after entering `ur.integration-tests.eth`.

## Screenshots

| Surface                          | Dark                                             | Light                                             |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| Before: DNS recipient rejected   | [Before](before-dark-dns.png)                    | [Before](before-light-dns.png)                    |
| Universal Resolver fixture       | [After](after-dark-ur.integration-tests.eth.png) | [After](after-light-ur.integration-tests.eth.png) |
| Offchain fixture                 | [After](after-dark-test.offchaindemo.eth.png)    | [After](after-light-test.offchaindemo.eth.png)    |
| DNS fixture                      | [After](after-dark-gregskril.com.png)            | [After](after-light-gregskril.com.png)            |
| Ethereum address of test.ses.eth | [After](after-dark-test.ses.eth.png)             | [After](after-light-test.ses.eth.png)             |
| Base address of test.ses.eth     | [After](after-dark-test.ses.eth-8453.png)        | [After](after-light-test.ses.eth-8453.png)        |
| IPFS checker displayed inline    | [After](after-dark-ipfs-checker-inline.png)      | [After](after-light-ipfs-checker-inline.png)      |

## Remaining validation limits

- Colibri alone fails `gregskril.com` with nested DNSSEC
  `SignatureNotValidYet(inception, now=0)`. Quorum resolves it correctly. This
  PR fixes fallback; it does not claim to fix Colibri's execution timestamp.
- Myotis v0.1.7 did not finish cold sync within the two-minute smoke budget;
  catch-up stalled at period 1825. Related:
  [existing Myotis cold-sync issue #200](https://github.com/solardev-xyz/freedom-browser/issues/200).
  The new adapter has deterministic EVM/CCIP tests but still needs a live run
  against a fully synced node. Its generic calls use optimistic state and are
  cryptographically verified against a sync-committee-attested optimistic root.
  Freedom reports `trust.level: verified` and `finality: optimistic`; the native
  record's `verified: false` denotes lack of finality, not lack of proof. No
  finalized or shared-block guarantee is claimed across its callbacks.
- Full `npm test` run: 4,316 passed, 25 skipped, 3 failed. The same three failures
  reproduce on unchanged `origin/main` e06b44e9: two macOS shortcut expectations
  in `settings-store.test.js`, and the Gnosis-only guard in `safe-fork.test.js`.
- Lint passes. Whole-file Prettier checks still report existing formatting drift
  in baseline files; new files and previously clean changed files are formatted.
  Unrelated source was not reformatted to clear baseline warnings.
- Theme parity: six checks passed, including both wallet/permission themes;
  the two chrome checks failed on a hidden Find bar and stale node-menu contrast
  exceptions. Both Find-bar failures reproduced on unchanged main.
- Linux screenshot baselines were not regenerated on macOS.

These results support review of the read integration and the required screenshots;
ENS launch-partner acceptance remains ENS's decision. A synced-Myotis live run is
still needed before claiming every configured backend has passed independently.

## PR review follow-up (2026-09-14)

Reviewed the original change plus commits `ec293b7e` and `78cbc5aa` against the
review comments and the installed ethers implementation.

- Confirmed the gateway-form URL carve-out, navigation-only MIME inference,
  WNS/GNS rejection outside mainnet, chain-pinned reverse display, and new
  address-bar/ENS CI job.
- Fixed the remaining Colibri automatic-CCIP path to use the shared 15-second,
  4-MiB-per-gateway fetcher. New tests use the actual ethers BrowserProvider
  and OffchainLookup callback machinery for forward and reverse queries;
  both fail before the provider override and pass afterward.
- Added real address-bar regression cases for `ipfs.io`, `dweb.link`,
  `127.0.0.1` and `localhost:8080`. These run in the new CI job and verify that
  the embedded CID loads without an ENS error dialog.
- Corrected the Myotis trust explanation above: optimistic proof verification
  is distinct from finality. This corrects audit wording; the trust policy
  itself is unchanged.
- Retained the existing full-resolution screenshots and commit history. PR
  description links use immutable commit references so deleting the branch
  does not break the evidence.

Local verification: lint passed; 200 resolver/CCIP tests passed; 16 offline
address-bar/wallet browser tests passed (two live-only checks skipped); all
15 live mainnet resolution assertions and four live browser checks passed. Full `npm test`: 4,350 passed,
25 skipped, and the same three previously reproduced baseline failures in
settings shortcuts and the Safe fork test.

### Additional wallet review

- Reproduced a late network-switch race: an ENS recipient could resolve on one
  chain, then reach review under another chain if the user switched networks
  during gas estimation or unlock setup. The final chain check now runs after
  all asynchronous preparation and before the review becomes visible.
- Reverse-name adoption also runs after unlock setup, so a network switch in
  that interval cannot display the previous chain's primary name.
- Network changes reject preparation for address-only recipients too, because
  their gas estimate and selected token also belong to the preceding chain.
- Automatic Touch ID starts only after the final network check and visible
  review; leaving that review before the timer fires cancels the prompt.
- Reproduced stale primary names after Edit → change network → Continue.
  Each Continue now clears the preceding review's name before resolving again.
- Regression tests drive both asynchronous windows and the repeated-review
  flow. The new ENS race tests and repeated-review test failed before their
  respective fixes. All 15 wallet tests pass afterward.
- Full local suite after these changes: 4,376 passed, 25 skipped, and the same
  three baseline failures described above. Lint passes.

### Adversarial CCIP review

- Resolver-controlled gateways now require HTTPS with normal certificate and
  hostname verification. IP literals, local/single-label names, credentials,
  and redirects are rejected. TLS is the protection against sending plaintext
  POST requests to local node APIs; hostname filtering alone would not prevent
  a public DNS name resolving to a private address.
- The existing overall RPC-leg deadline remains in place. Expiry while waiting
  on a gateway aborts that fetch and all later gateway attempts, without
  quarantining the healthy RPC. Gateway failures are retryable errors, not
  agreed missing records or negative-cache entries. Regression tests cover
  timeout and explicit failure through direct and quorum strategies, then retry
  both the same name and an unrelated name without resetting provider health.
- Expiry during a callback also keeps the RPC healthy when an earlier gateway
  round used some of that shared deadline. The callback-budget test reproduced
  healthy-provider quarantine before this correction. Explicit RPC failures
  retain their existing quarantine behavior. Callback calls remain pinned to
  the original block.
- All 15 live mainnet assertions pass with the stricter gateway policy.
- The combined address-bar and live ENS browser suite passes all 18 checks,
  including both wallet themes and native IPFS checker rendering.
- Gateway requests still run independently per quorum leg. Sharing requests
  would reduce duplicate work, but is an optional performance improvement;
  the existing requests remain bounded and cancelled when their leg ends.
- ENSIP-19 default-address handling remains in the resolver contract; the
  client continues querying the destination chain's coin type, as specified in
  [ENSIP-19](https://docs.ens.domains/ensip/19/).

The owner is upgrading Myotis in a separate worktree; its node upgrade and
live validation are explicitly outside this PR's remaining review scope.
