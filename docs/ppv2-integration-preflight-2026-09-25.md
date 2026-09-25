# PPv2 integration preflight

Date: 2026-09-25. Decision: begin a bounded internal Sepolia spike through Kohaku's PPv2 adapter; wait for audit/final deployment qualification before mainnet activation. Florian reports that 0xbow is awaiting its final security audit and otherwise considers PPv2 ready for mainnet. This is partner information, not an independently verified audit result or a claim that the inspected SDK commit matches the audited candidate.

**Later September 25:** source access is now working after invitation acceptance. The `v2.0` SDK builds, independent derivation checks pass, and a real deposit proof verifies in a separate Node process. Kohaku needs finality/exit-state updates and the existing Node worker cannot host this prover. See [the current SDK qualification and next implementation slice](ppv2-sdk-qualification-2026-09-25.md). The checks below preserve the earlier access investigation.

## Earlier access checkpoint (before invitation acceptance)

| Check | Result |
| --- | --- |
| Freedom main | Still `2983dc62`; already merged. No new dependency or node refresh required. |
| Kohaku master | `cae352597009b369c7f3a2aafbef4653385a092d`, September 25 |
| PPv2 PR #258 | Still open at `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e` |
| CLI main | Still `e7d8e9d54661cbfe3134a7afa415910adad0e711`, September 7 |
| SDK registry, authenticated as `flotob` | HTTP 403, `permission_denied` |
| Existing GitHub token scopes | `read:packages` is not listed |
| Referenced `0xbow-io/v2-monorepo`, authenticated lookup | HTTP 404 |

The registry request used existing GitHub CLI authentication in memory, sent only to GitHub's package registry, with redirects disabled. No credential was printed, saved, committed, refreshed or given additional scopes. **The 403 does not establish that the account itself lacks package entitlement:** missing package-read scope is a known obstacle. The repository 404 also does not distinguish missing access from an obsolete repository location.

At this earlier checkpoint, full SDK execution was blocked until a supported package/source access route became available. No package installation, proof generation, live relayer submission or wallet transaction was attempted. The request for access information is pending with Florian; no message was sent to maintainers.

Useful request to 0xbow, ready to forward:

> We're building a Kohaku-based PPv2 integration for Freedom and starting with an internal Sepolia test. Could you confirm the supported SDK/source access route for GitHub account `flotob`, whether `@0xbow-io/privacy-pools-v2-sdk@0.2.0-beta.0` and Kohaku PR #258 are the intended integration candidate, and which SDK revision, Sepolia deployment and circuit/verifier set match the candidate under audit? Please flag expected breaking changes and the applicable SDK/artifact redistribution terms.

## Adapter choice and CLI inspiration

The intended dependency path is Freedom's host → Kohaku PPv2 adapter → 0xbow SDK. The [open PPv2 PR](https://github.com/ethereum/kohaku/pull/258) contains the implementation; current master does not supply that completed adapter. Freedom should not depend on a package name or version alone and assume that the PR's code is present.

The [CLI host factory](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/host/makeHost.ts) is the reference for assembling provider, network, storage and keystore. Its [protocol runtime](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/lib/protocol-runtime.ts) illustrates plugin creation, session reuse and cleanup; its [shield flow](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/lib/shield-flow.ts) distinguishes preparation, approvals and transaction calls. These are useful patterns. The current CLI's protocol store IDs are `rg`, `ppv1`, and `tc`; it is not our PPv2 release-candidate example.

Freedom keeps its own account derivation, per-account/role transport contexts, explicit transaction review and authoritative vault cancellation. The CLI's account-index mapping conflicts with Freedom's reserved Ant identity path, and its [Tor helper](https://github.com/kassandraoftroy/kohaku-cli/blob/e7d8e9d54661cbfe3134a7afa415910adad0e711/src/utils/tor.ts) explicitly leaves Ethereum RPC outside Tor. Its session-held mnemonic/password and global fetch patch are not adopted as Freedom lifecycle/network policy. The earlier [CLI source study](../research/kohaku-wallet-integration-research.md) explains these differences.

Railgun remains a separate target. September 24 removed the previous implementation; September 25's [replacement package](https://github.com/ethereum/kohaku/blob/cae352597009b369c7f3a2aafbef4653385a092d/packages/railgun/package.json) is private, describes itself as a placeholder, and builds empty exports. Its [README](https://github.com/ethereum/kohaku/blob/cae352597009b369c7f3a2aafbef4653385a092d/packages/railgun/README.md) says the real implementation is to be reintroduced. The directory's return does not qualify a maintained Railgun adapter. Existing CLI pins and earlier Freedom WASM evidence refer to the older implementation.

## Candidate compatibility and recovery traps

Direct source comparison of the PR and current Kohaku shows no change to `packages/provider/src/provider.ts` or the base plugin errors. The host module adds an external-sync materialization helper; its core provider/network/storage/keystore fields remain. This narrows the interface concern, but is not a successful rebase, full typecheck or build of the inaccessible SDK. No mergeability claim is made from the shallow scratch checkout.

The [PPv2 live session](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/examples/ppv2-sample-app/src/live/session.ts) needs deliberate changes for our qualification harness:

- Its fresh-store default begins note discovery roughly 100 blocks behind the current head. Recovery of an existing account must start from the correct deployment/account history, not that convenience default.
- It pre-seeds revocable-key index zero unless `FULL_KEY_SCAN=1`. Restore tests must exercise discovery of a rotated key, with independent expected results.
- It caches logs and introduces retries; those need explicit range/freshness/reorg and cancellation policy. The adapter's recursive scan bisection must not amplify permission refusals into unbounded work.
- It fetches an ASP public key at runtime. Confirm the intended authentication/pinning model with the audited candidate before sending sensitive payloads.
- It has optional request/response dump logging. Freedom's harness must not enable payload dumps or use a real wallet key.

The [derivation module](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/privacy-pools/src/v2/account/derivation.ts) asks the host for `m/28784'/2'/<accountIndex>'`, signs canonical typed data in memory, and passes that signature into SDK key derivation. Freedom's existing Railgun-only keystore deliberately refuses this path. Add a separate restricted PPv2 keystore only when SDK constants and independently reproducible derivation vectors are available; do not guess `APP_IDENTIFIER` or broaden Railgun's allowlist.

The [session assembly](https://github.com/ethereum/kohaku/blob/6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e/packages/privacy-pools/src/v2/session.ts) injects HTTP/RPC/storage, but a single host network object must still dispatch to our distinct ASP/relayer/artifact capabilities. A local prover factory is available in the sample; using it with Freedom's verified-artifact loader and worker requires an actual SDK compatibility check. These remain implementation work, not completed connections.

## Work completed despite the access gate

Extended `scripts/spike-kohaku-ppv2.js` to compile the exact PR's storage adapter and error hierarchy into a scratch fixture, alongside the existing HTTP fixture. The bundle uses pinned Git blobs, removes type-only SDK imports, has no external runtime imports and adds no application dependencies. No upstream SDK implementation is substituted or faked.

Tests run the actual storage adapter against Freedom's encrypted store. They verify JSON persistence across reopening, separation of instance namespaces, durable tombstones, refusal of a wholesale clear, malformed JSON and ciphertext rejection, value-size limits and lock revocation. Synthetic note-shaped values are used; this is storage interoperability, not proof of shielded-note reconstruction or protocol recovery.

Reproduce by running the spike script against a checkout containing the PR commit. Set `FREEDOM_PP_V2_STORAGE_FIXTURE` to its `storageOutput` and `FREEDOM_PP_V2_HTTP_FIXTURE` to its `output`, then run `npm test -- -- --runInBand src/main/wallet/kohaku-storage.test.js src/main/networks/kohaku-network.test.js`. Source digests, fixture paths and access-check outcomes are in [the preflight report](qualification/ppv2-integration-preflight-2026-09-25.json).

## Original resume point (superseded by the SDK qualification)

Once supported SDK access and the matching candidate are confirmed: install the reviewed dependencies only in the isolated spike, reproduce derivation vectors, connect the real host/prover, and attempt registration → shield → sync/ASP approval → reviewed unshield. Test restart, full-history reconstruction and rotated-key recovery separately. Stop for substantial API forks; keep production activation off until the completed audit/fixes and final deployment are reviewed.

## Validation

The full suite with the pinned HTTP/storage fixtures reports **5,560 passed, 25 skipped, and the same 3 baseline failures** (two macOS shortcut-remap cases and the Safe fork case). Lint and diff whitespace checks pass. Logs: `/private/tmp/freedom-ppv2-preflight-tests.log` and `/private/tmp/freedom-ppv2-preflight-lint.log`. This change adds a scratch compilation fixture, tests and documentation; it does not change application runtime code, dependencies or node pins. The preceding packaged qualification remains historical evidence for the host primitives, not a new packaged SDK test.
