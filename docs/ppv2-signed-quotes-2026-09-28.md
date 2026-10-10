# PPv2 withdrawal quote authentication

Date: 2026-09-28. Production stays disabled. The main-owned final relay policy now verifies the pinned relayer's EIP-712 withdrawal commitment before admitting a request for review or HTTP submission. No dependency, circuit, SDK revision, renderer API or live service was changed.

## Identity and signed fields

Each configured relayer needs an explicit `quoteSigner` for withdrawals. Main snapshots it independently of the SDK; it is not taken from the selected quote or discovered automatically over HTTP. The configured `address` remains the expected fee recipient. These can be different: the upstream relayer has separate signer and fee-receiver configuration. Missing signer configuration refuses withdrawal preparation; public registration/deposit and existing journal recovery remain usable.

The domain is `Privacy Pools Relayer`, version `1`, configured chain ID `11155111` and the configured ordinary relay processor as `verifyingContract`. The primary type is `RelayWithdrawalCommitment`, with ordered fields `data:bytes`, `asset:address`, `expiration:uint256`, `amountSent:uint256`, `amountReceived:uint256`. Expiration is upstream milliseconds. This comes from [the qualified relayer source](https://github.com/0xbow-io/v2-monorepo/blob/fe0244e3f14110efd83db02c60c96517dea9cd5a/packages/relayer/relayer/src/chain.service/evm.chain.service.ts), not an assumed signature format.

The signature binds the routing data and asset as well as amounts/deadline. Existing exact routing, fee arithmetic, recipient, proof signals and encrypted change context checks remain mandatory. An invalid signature refuses the handoff before independent proof verification, review, journaling or transport. Approved requests preserve the exact signed bytes; deadline checks continue through proof work, review and the final network boundary.

The summary now exposes `quoteSigner` and `quoteSignatureVerified: true`. This only authenticates a commitment to a configured key. It does not establish the operator's identity, deployment correctness, delivery, receipt truth, ASP correctness or privacy. `chainStateVerified` remains false. No EIP-1271 signer, alternate processor, swap, batch or private-transfer quote format is granted.

## Validation

The focused handoff/reconciliation/session suites pass 75 tests, including missing/wrong signer, malformed signature, wrong domain name/version/chain/contract and changed expiration. The valid signer differs from the fee recipient. Token signature binding and checksum-equivalent native addresses also pass. Electron fixtures sign with the existing viem dependency and production verifies with ethers, using ephemeral synthetic keys. The full unit suite reports 5,720 passed, 33 skipped and the same three baseline failures (two macOS shortcut remaps and the Safe fork case). Lint passes. All six packaged lifecycle checks pass; both changed production modules match source bytes. Results and byte comparisons are in [the qualification report](qualification/ppv2-signed-quotes-2026-09-28.json).

An initial source run overlapped the full unit suite: relay and native withdrawal passed, but token withdrawal preparation was refused and fixture teardown hung. The isolated token rerun passed in 42.8 seconds; the packaged run passed all six checks in 119 seconds. A final isolated source run also passed all three quote/withdrawal flows. The initial refusal’s cause is not established and is retained in the evidence rather than counted as a clean first run.

## Remaining work and handoff

The token lifecycle and signed quotes close two concrete gaps in controlled shield/withdraw infrastructure. They do not complete the entire privacy roadmap. Private transfers, zero-change/full withdrawals, larger circuits, failed/replaced outcomes, ledger capacity and broader egress/platform qualification remain engineering work.

Before investing in a production adapter revision, obtain the intended supported EVM SDK revision, matching deployment/artifact manifest and audit scope, and final account-derivation constants from the PP team. The September 28 branch has split the SDK packages (`@privacy-pools-v2/evm-sdk` currently declares version `0.0.0`, with a workspace core dependency) and still labels its derivation identifier provisional; the tested September 25 pin is unchanged. Real accounts must not silently inherit a placeholder identity domain.

Before a user-facing flow, decide the first operation set and how unverified chain/ASP evidence is presented and accepted, including what recovery actions users may approve. Current explicit review callbacks are engineering boundaries, not agreed product UX. No implementation here chooses those policies for the user.

A read-only comparison found the withdrawal quote domain, typed fields and signing function unchanged at upstream `e5c13cd124cf8fbb8c9e487db91d1c6ce131f70d`. This is a narrow schema check, not qualification of that SDK revision.
