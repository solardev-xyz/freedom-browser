# PPv2 Sepolia: checks before funding

**October 1 update:** [RPC screening and revised test route](ppv2-testnet-route-2026-10-01.md) supersedes the all-testing dependency on Tor relayer support or a PP-recommended RPC. Tenderly and Sentio return the first historical events over Tor; complete replay remains pending. An explicit direct-relayer disposable test is the next planned route. The measurements below remain the September 29 record.

The published deployment is compatible with our pinned proof circuits. Funding is still gated by relayer access over Tor and complete recovery history. No funding wallet was created, no live transaction was submitted, and production remains disabled. [Machine-readable evidence](qualification/ppv2-live-preflight-2026-09-29.json).

## What passed

- Merged main `072d45e4` in `51ce8dd6`, then the newer popup-blocker main `4df82417` in `58f7be50`. After each merge, explicitly refreshed Ant 0.5.45, IPFS 0.4.3, Radicle 0.7.1 and Myotis 0.1.11/ABI29; rebuilt its supervisor. Arti already matches 2.6.0. Binary checks pass. No npm dependency version was added or upgraded.
- Live reads through the wallet's real SOCKS/TLS transport and bundled Arti checked Sepolia, finalized anchors, proxy implementation identities, bytecode hashes, contract relationships, native asset configuration and verifier selection. New pins refuse changed deployments on subsequent probes. Hashes are reviewed RPC observations, not independently verified state or audit provenance.
- The current processor `0x7430cc030d7eb8c83e76cd983996982c8c054204` exposes the relay selector, `MAX_BATCH() = 10` and a deployed announcer. It matches the live frontend and relayer details from an early Tor response and the separate direct diagnostic. The older processor in documentation should not be copied into signing configuration.
- Nine live verifier calls passed: deposit, ragequit and transact 1×1 each accepted a real synthetic proof and rejected both a changed public signal and a cross-circuit proof. The pinned archive was authenticated in main; the synthetic exit jobs are distinct from product jobs that recheck the archive in the child. No future wallet witness or spend identifier was sent.
- The ASP's 13,315 leaves, fetched over Tor, reconstructed the exact latest and finalized registry root. An earlier service/finalized mismatch later converged. Service-root equality alone is not a leaves-validation check.
- A separately labeled direct diagnostic obtained a correctly signed quote with 59,939 ms remaining. Staging therefore supports approximately 60-second quotes. The old expired fixture's artificial nine-second reference time was not a live TTL measurement. Direct diagnostics do not qualify or replace the wallet's Tor route.

The ASP changed its root 11 times in a recent 1,000-block window, with some updates only 6–7 blocks apart. The pool requires the current ASP root at execution, so a change after handoff can still invalidate a proof. This is a residual even with the new pre-journal check.

## Host changes prompted by live checks

The direct diagnostic measured a 6,738,359-byte public ASP snapshot, which exceeds the wallet's 4 MiB response cap. The actual Tor request was refused with `PRIVATE_RESPONSE_TOO_LARGE`. The cap remains unchanged. The SDK can fall back to logs, but its pending-note promotion path starts at block zero when the snapshot is unavailable.

The provider now accepts main-owned, per-contract deployment floors. Ancient windows return empty locally and straddling windows are clamped; existing range, topic, lifetime and returned-log validation remain in force. Only the four PP contracts get the floor. ERC-20 history is not truncated. With the current head, this removes roughly 4,400 unnecessary network windows in a two-event genesis scan, leaving roughly 350 deployment-to-head windows. The SDK still iterates the ancient empty windows locally. The earliest V9 deployment block `10932354` covers the first keystore event at `10994877` in that direct-only snapshot diagnostic; the ASP pool feed's `10994884` is too late as a shared recovery floor.

Immediately before journaling a withdrawal, the host now checks the proof's ASP root against the latest registry and checks pool/keystore root membership. Stale or unavailable evidence refuses before reserving or sending the attempt. These reads use that attempt's isolated protocol context, never the owner connection or the SDK's shared provider. They run under the existing handoff deadline and do not grant verified-state status. Quote expiry and uncertain-delivery rules remain unchanged.

Protocol interpretation stays in `src/main/wallet`; per-contract RPC bounds stay in `src/main/networks`. Standalone qualification scripts provide no product IPC or signing capability.

## Remaining live blockers

1. **Relayer over Tor.** An early run received details HTTP 200 and quote HTTP 201, but subsequent independent Tor runs repeatedly received HTTP 403 for details, quotes and API-schema reads. The direct quote worked. This suggests edge filtering; it does not establish the operator's exact reason. Ask PP for a supported Tor-compatible staging route or an edge-policy fix. No automatic circuit retry, direct fallback or relay POST was used.
2. **Complete recovery history.** The tested PublicNode endpoint returned empty old pool ranges, then first returned `LeavesInserted` at block `11795006` with start index `6138`. Replay correctly refused the gap. OnFinality and ethPandaOps did not yield usable Tor qualification during separate probes. A working history-capable endpoint is required; never treat these empty responses as proof of an empty wallet. This also blocks proving an emergency exit, which needs the complete keystore tree. Ask PP for their supported test route or use an independently qualified, unkeyed archive/self-hosted RPC reachable over Tor. The snapshot alone does not fix this: the pinned SDK builds its state and keystore trees from chain logs.
3. **Full live session qualification remains pending.** The public-tree probe is not a real Kohaku wallet sync. Before funding, finish root reconstruction and the actual unfunded SDK session/registration simulation against the selected services, reconfirm signer and fee-recipient roles, and repeat deployment checks at every signing boundary. No current preflight result grants signing authority.

The endpoint candidates were checked against [OnFinality's published Sepolia endpoint](https://www.onfinality.io/en/rpc-assistant/sepolia-public-rpc-endpoint) and the [Ethereum chain registry](https://github.com/ethereum-lists/chains/blob/master/_data/chains/eip155-11155111.json). Their documentation is not evidence of successful historical queries.

Suggested focused message to PP:

> Our pinned deposit/ragequit/transact circuits verify against your live Sepolia contracts, and the ASP leaves reproduce the registry root. Two things block our Tor-only wallet test: the staging relayer repeatedly returns HTTP 403 through Tor (direct quotes work, ~60s TTL), and our public RPC returns incomplete pool history, beginning at leaf 6138. Can you provide a supported Tor-compatible staging relayer route and an RPC with the complete V9 pool/keystore logs from block 10932354? Please also confirm the quote signer and fee recipient roles for 0x4ba5ff376865b370790a56276c63e7984dcff1f7 with processor 0x7430cc030d7eb8c83e76cd983996982c8c054204.

No message has been sent. Final derivation identity, audit/source/artifact distribution, signed-build testing, platform coverage and UI decisions remain separate production gates.

## Reproduce

Use the already qualified runtime archive, with SHA-256 `ce18c67a40fa0c72593bb1e851a995951afe7371b0ddd88dfee16d1ffa8e2cb7`. These scripts do not install an SDK or accept new runtime bytes:

```sh
node scripts/qualify-ppv2-live.js /absolute/report-directory publicnode
node_modules/.bin/electron scripts/qualify-ppv2-circuits.js /absolute/ppv2.asar /absolute/circuit-report
node_modules/.bin/electron scripts/qualify-ppv2-recovery.js /absolute/ppv2.asar /absolute/recovery-report publicnode
```

The RPC choice is explicit (`publicnode`, `onfinality`, `ethpandaops`) and never a fallback sequence. Scripts use synthetic public service contexts; a funded wallet must use the actual account/operation context paths. The circuit script's `passed` concerns verifier binding only; inspect its deployment report separately. Recovery refuses missing, duplicate, removed or discontinuous events. All reports retain unverified-state and no-signing/no-broadcast status.

## Validation and review

Implementation commit: `2151252c`. Claude reviewed the qualification code, pins, log-floor change and pre-journal guard. The initial owner-context guard was corrected to per-attempt isolation before committing; the reviewer approved the fix and found no remaining blocking code issue in this slice.

- Final merged unit suite: **6,372 passed, 33 skipped, three unchanged baseline failures** (two macOS shortcut-remap cases and one Safe fork integration case). Existing asynchronous logging warnings remain. Lint is clean.
- Source Electron: all four controlled native/ERC-20 withdrawal/recovery scenarios pass on the privacy implementation, including stale-root refusal during review, no premature journal entry, reprepare, uncertain handoff, restart and second spend/emergency exit.
- Unmodified local unsigned package: six fuse/launch smoke checks pass on the privacy implementation's main `072d45e4` baseline.
- A separate ad hoc test copy enables only the inspector fuse needed by the existing main-process test harness. Its `app.asar`, ASAR-integrity metadata and other fuse settings match the production-configured artifact. Three deposit/process/runtime-integrity checks and the native withdrawal/root-change/restart scenario pass. The production artifact remains unchanged; this test copy must not be distributed.
- The later main merge adds popup blocking and a settings permission label; it does not modify PPv2 modules or npm/node pins. Node refresh and full unit/lint checks were repeated after that merge. Seven source smoke checks (six popup-blocker cases and real controlled PPv2 deposit) pass on the merged tree. Claude also verified the startup/settings privacy changes survived byte for byte. Prior packaged results are tied to their explicit earlier baseline, not silently attributed to a newer artifact.

These are engineering checks, not audit completion, signed hardened-runtime qualification, complete platform egress testing or permission to deposit.
