# Railgun Kohaku contract checks — October 5, 2026

The real Freedom-owned Railgun adapter now has pinned runtime contract checks for local reads and transaction handoffs. Eight adapter cases and one ordinary-wallet compatibility case pass across nine fresh Electron processes; all original launcher processes exit zero. The change adds test instrumentation and assertions; production wallet modules, dependencies, policy pins and user-facing activation are unchanged.

## What is checked

The [contract pin](../scripts/fixtures/railgun-kohaku-contract-pin.json) records four exact upstream interface files at Kohaku `6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e`. Local reads are compared with the genuine owned-note snapshot read directly from the account (not through the adapter) and the enrolled identity descriptor. Checks cover Promise returns, bigint amounts, filtering, spent-note projection, balance conservation and the feature surface of read/private/public instances. The native histories here contain WETH; additional asset-shape and malformed-data cases remain unit evidence.

Eight owned-view windows require exactly `[11,11,11,11,13,13,13,13]` checks per adapter case. Healthy and lost-reply private cases additionally require `[private:13, read:13]`; held private review requires `[private:13]`; public cases require `[public:13]`. Every awaited read must preserve the genuine snapshot and measured RPC, transport, credential, apply/restore and utility/worker counters. This establishes no additional work at those instrumented boundaries; it does not measure SQL, filesystem syscalls or physical network traffic comprehensively.

A separate observer captures the genuine delegate Promise and the adapter caller's settlement. It checks the original result/error identity and exact instance/token delegation without replacing the result or issuing authority. Private lost-reply submission stays a fulfilled uncertain value; public lost-reply submission stays the original typed rejection. The existing copied, foreign and consumed-token refusals remain in place. Exactly one selected forwarding settlement is checked per adapter case; the total delegated-call counter also includes existing refusal controls.

## Native evidence

| Lane and case                                         | Forwarded outcome            | Read checks | Simulated EOA sends |
| ----------------------------------------------------- | ---------------------------- | ----------: | ------------------: |
| Private Shield transfer, lost reply                   | Uncertain value              |         122 |                   1 |
| Private Shield full withdrawal                        | Acknowledged                 |         122 |                   1 |
| Private received-Transact transfer                    | Acknowledged                 |         122 |                   1 |
| Private received-Transact full withdrawal, lost reply | Uncertain value              |         122 |                   1 |
| Private held transaction-review cancellation          | Refused                      |         109 |                   0 |
| Public Shield                                         | Acknowledged                 |         109 |                   1 |
| Public Shield, lost reply                             | Original uncertain rejection |         109 |                   1 |
| Public Shield, held review cancellation               | Refused                      |         109 |                   0 |
| Ordinary enrolled wallet, no adapter                  | Compatibility only           |           — |                   0 |

The eight contract cases perform 924 read checks and eight selected forwarding checks, with six genuine signatures followed by simulated Ethereum sends. Four private cases replace one pre-existing instance-ID read each; net added adapter/view calls are 920. The default case preserves the 19-stage wallet scan/recovery sequence and does not acquire a Kohaku instance.

Reports retain their synthetic public history, service/preflight boundaries and zero live-query/submission flags. Real vault signing, the existing engine/prover paths and encrypted journals still execute where the selected scenario calls for them. A cancelled transaction review can occur after private signing/proving; its zero Ethereum signing/send count does not imply zero earlier private work.

The top-level legacy `submissions:0` field describes the base wallet qualifier. Actual simulated adapter sends are counted under `kohakuQualification.rpc.sends`. Resource counters in each report are captured **before final cleanup**; some workers are still represented as pending there. Qualification requires the original process to exit zero after the final cleanup, observation drain and sticky-error gate. The pre-cleanup snapshot is not relabelled as a final resource-count report.

## Making test failures reliable

The resource meter installs before both process/worker providers are imported; a source test pins their current 17 and eight static production importers. Fixture hooks use the sticky assertion recorder, so controller error handling cannot turn a failed assertion into a passing qualification. Every cleanup error is recorded. Cleanup preserves the original dependency order while continuing after a rejected step, including scope revocation before storage barriers and vault locking before restoration of the Kohaku installation.

The public fixture retains its three labelled 150-second cleanup bounds. Meter and settlement-observer drains also fail with a sticky timeout after 150 seconds; timeout never counts as resource settlement. Tests execute the actual cleanup blocks with held or rejecting owner barriers, rather than assuming a cleanup double represents native behavior.

Root validation passes **312 tests across seven suites**, full lint and scoped formatting. Ten detached regression mutations fail as intended: substituted caller/delegate observation, omitted work measurement, weakened read vectors, missing identity binding, removed sticky gate, old skipped-owner cleanup, concurrent dependency cleanup, silent drain timeout, late scope revocation and early Kohaku restoration. These are test-harness controls, not ten production vulnerability claims. Claude and an independent Codex reviewer cleared the corrected ten-file candidate before native execution. This is engineering review, not an external security audit.

## Source identity and limits

The campaign starts from `868f43a3`, with current main `a1438027` already merged and its [bundled-node refresh](privacy-main-sync-a1438027-2026-10-05.md) completed. A fresh main fetch during qualification still returned that commit. The candidate freeze is `fe777cff6d17e57d01efd33738b34cf54027a4707097b8544b814b0a9c5f34a1`. The broader before/after freeze covers **5,778 source files and nine external inputs**; its digest is `b7fd8b038080f2ab07f4d24acf0d1a779525d83d2b5c7db88bfd51cbd62fc274`.

Each native report carries its selected source inventory: 142 private, 177 public, 139 default (178 paths in their union). These maps are not execution coverage or the entire broad freeze. The [evidence index](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-kohaku-contract-2026-10-05.json) and [independent audit](https://github.com/solardev-xyz/railgun-kohaku-adapter/blob/377c2a5d1aca18f0ed328dfdda955bd7d1ba271c/docs/freedom-qualification/railgun-kohaku-contract-audit-2026-10-05.md) preserve report hashes, process results, inputs and the pre-cleanup-counter distinction. Earlier native campaigns retain their recorded source snapshots. This campaign is committed as `c45fc866`. The later [main 9f6fec8d synchronization](privacy-main-sync-9f6fec8d-2026-10-05.md) refreshes bundled nodes, passes 330 affected tests plus lint and checks IPFS async lifecycle under network denial. All 178 selected Railgun hashes remain unchanged; seven IPFS entries in the broad freeze changed. The native reports remain pinned to their original snapshot.

This is a narrower runtime contract qualification, not TypeScript compilation, generic Kohaku Host compatibility, a portable extracted package, live private-service acceptance, physical Tor isolation, power-loss recovery or production release approval. No funded profile or live private service was accessed.

The next reviewed [public-facade cold-credit plan](railgun-public-facade-cold-credit-plan-2026-10-05.md) connects a journaled Shield through independent cold receipt resolution, ordinary wallet scanning and a further cold restore proving one retained credit. That work, restricted host extraction, live private qualification and product/UI decisions remain separate.
