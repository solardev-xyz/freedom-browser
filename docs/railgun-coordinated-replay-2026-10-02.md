# Railgun coordinated public-history replay — October 2, 2026

The real pinned engine9.6 now replays the captured Sepolia history through the
exclusive host coordinator, independent encrypted source ledger, expiring source
evidence and durable scan journal. The source-only planner independently derives
all public record payloads and Merkle roots before an engine apply window opens.
This is development infrastructure, not wallet readiness or a spending grant.

## Evidence

[The complete source-bound report](qualification/railgun-coordinated-replay-2026-10-02.json)
records 121 contiguous ranges, all 14,822 captured logs, a forced SIGKILL after
nullifier writes in the range ending at block 7,099,999, recovery with a changed
archived provider identity, and a final cold restart. All range observations and
the cold observation match their independently projected states. The final state
contains 10,194 commitments, 5,614 nullifiers and 2,546 unshields, with tree0 root
`0x23bbe9f01d6f06e47cffa08b31836ea8ee26c48cb7f959ffd70a5840c7910098`.

Of 122 apply callbacks, 59 precede the first Shield and intentionally skip engine
execution while journaling the independently checked empty public state.

The runner serves archived public responses to the actual scoped source issuer;
it makes no live RPC requests. Two dense original capture pages were split at
available adjacent captured headers to respect the 512-event-block limit. This
qualifies those fixed partitions, not adaptive live range sizing. Each source
projection streams the independently stored full prefix into a fresh guarded
child, with acknowledged bounded messages. The engine gets only the current
range and its expected public state. Actual apply/recovery runs use encrypted
host workers and atomic tree groups; the whole range remains journaled rather
than atomically committed. Only one crash phase is exercised through this new
coordinator; the older five-phase matrix is separate historical evidence.

The planner checks decoded ABI data against every stored canonical public field,
including encrypted payloads, blinded sender and receiver viewing keys, token preimages and
fees. Shield hashes and tree roots are independently recomputed. Engine9.6 omits
zero Shield fees; this is preserved as the canonical absent field, not rewritten
as a stored zero. Empty Shields preserve the current insertion position without
creating an empty persisted tree; empty Transacts are refused. Unknown events
fail closed. Recognized governance events are accepted only through the explicitly
qualified historical block 11,829,346 (pinned in source, not a field in this report); later contract changes require a new host
qualification. That boundary is pinned twice in this Node fixture and must be
supplied from reviewed deployment evidence in the next runtime integration.

Public records and cryptography remain under the wallet main-process service
boundary, with expensive engine/planner work in child processes. No renderer or
new public IPC capability is introduced. The source planner has no engine database,
wallet key, signer or network capability. Process guards prevent accidental egress;
they are not an operating-system sandbox. Matching recorded logs and headers does
not prove RPC completeness, receipt validity or provider independence.

## Validation and continuation

Twelve focused projector tests pass; full regression passes 7,585 tests with 33
skips, and lint passes. Claude reviewed event validation and the borrowed Electron
broker lifecycle as engineering review, not a security audit. The supervisor can
now borrow a coordinator dispatch capability without creating or owning another
storage session. Profile/broker revocation stops the child; normal child shutdown
leaves the persistent store with its owner. Thirty-three supervisor tests pass.
Actual Electron coordinated replay is being qualified separately.

Still open: fixed production runtime entries and authenticated packaging, actual
Electron coordinator qualification and interruption cases, adaptive live acquisition,
wallet decryption and current Kohaku balance/note semantics, artifacts and deployed
verification-key matching, operation-bound proofs/signing, POI/relay transport, and
funded recoverable shield/transfer/unshield. No Railgun funds have moved. The
existing authorized Sepolia funds remain available for that later step.
