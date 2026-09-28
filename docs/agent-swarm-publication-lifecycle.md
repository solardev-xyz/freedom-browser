# Agent Swarm publication lifecycle

Implemented on `feature/freedom-automation-kernel`, 2026-09-28.

A publication is a host-managed operation owned by its conversation. The main
agent waits for active publication receipts after its model turn and resumes once
with the result. Waiting needs no repeated model calls or additional helper/model.
A provisional tool response after ten seconds is not the end of the user task.

## Readiness and retries

After public-network approval, Freedom selects and retains one postage batch.
A recent successful purchase receipt in this conversation takes precedence over
another automatically selected batch. A purchase is never repeated by publication
code. The approved file/text snapshot stays in memory and is reused unchanged for
propagation retries; later project edits are not included.

Freedom checks local usability, effective capacity with the existing 1.5x margin,
and on-chain existence/lifetime via `/stamps/{id}` and `/batches/{id}`. It waits
for ten additional blocks using `/chainstate`. A real creation block is used when
available. Ant v0.5.44 reports creation block zero, so Freedom counts from its
first successful on-chain observation instead. That observation can be reused for
subsequent publications with the same batch and backend, but current lifetime,
capacity and usability are still checked. No dummy upload is required. These
checks reduce propagation failures; they do not prove every peer is synchronized.

Only an explicit peer batch-not-found rejection naming this exact batch is
retried automatically: up to three upload attempts, separated by 30 seconds and
fresh readiness checks, inside a ten-minute job budget. Other errors are not
silently retried. Readiness polling uses five-second intervals and bounded reads.
A definitive HTTP client rejection is an upload failure; transport uncertainty
remains an unknown outcome. Even failed uploads can have sent some chunks.

## Confirmation and recovery

Stages are `waiting_postage`, `uploading`, `confirming`, `verifying`, then
`completed`, `failed` or `outcome_unknown`. Tag completion requires acknowledged
and already-seen chunks to cover the split count, rather than just sent chunks.
Tag polling is bounded to two minutes; a poll error or deadline cannot become
success. Local retrieval is reported separately from upload confirmation.

The profile's `agent-publications.json` stores at most 500 operation receipts,
with atomic replacement and private permissions. It includes conversation,
reference/tag, selected batch, backend fingerprint and stage, never approved source
bytes or API credentials. Terminal records are pruned first; pending records are
not silently discarded to make room. Conversation deletion removes its receipts.

After reopening, the status tool can resume observation of a known reference/tag
on the same configured backend. A recovered tag must name the original reference,
so a recycled tag ID cannot prove success. A request interrupted before dispatch
can be prepared and approved again. A dispatched upload without a known reference
remains uncertain and is never automatically replayed. Discovery returns the
conversation's recent receipts; it does not authorize another upload.

Stop prevents further waits/retries from dispatching another request. It does not
claim to recall bytes already sent: the in-flight transport may finish, and its
receipt must be checked. Source snapshots are not persisted, so restarting the app
never silently restarts an upload or repeats a purchase.

The sidebar updates one card per publication, with technical errors inside a
collapsed detail view. Distinct assistant messages retain paragraph boundaries.

## Qualification

Deterministic tests cover block-based readiness, expiry/capacity, exact-batch
selection, propagation-only retries, duplicate preparation, unknown delivery,
confirmation timeouts, owner/backend recovery, recycled tags, Stop, atomic journal
failure and parent continuation. A disposable Electron test exercises the card's
stages in both themes. These tests do not spend postage or publish real content;
a real-network smoke remains useful for node/peer-specific behavior.
