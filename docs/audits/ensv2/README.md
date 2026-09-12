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
  explicitly marked unverified by Freedom's finalized-state policy; no finalized
  or shared-block guarantee is claimed across its callbacks.
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
