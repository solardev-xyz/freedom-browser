---
name: dweb-domains
description: Register or renew .eth, .wei and .gwei names, manage website/address/text records, and connect a verified Swarm publication to an owned name through Freedom’s wallet.
---

# Decentralized names

Load this skill when a user wants to give a published site a name, buy/register a
domain, renew one, or change its website/address/text records. Use domain_inspect,
domain_prepare, domain_execute and domain_operation_status. These call shared
browser capabilities; the skill grants no wallet authority. Browser helpers
cannot perform domain operations.

Read the relevant bundled procedure before preparing a write:
- .eth: /freedom-agent/skills/dweb-domains/ens.md
- .wei: /freedom-agent/skills/dweb-domains/wei.md
- .gwei: /freedom-agent/skills/dweb-domains/gwei.md

## Intent and inspection

Ask for a missing name, intended term or ambiguous change. Never buy a name just
because the user wants a website: an owned name can be used without a purchase.
Inspect the full name first. Explain that candidate-name lookups go through the
user's configured chain-data service and can disclose interest in a name.
Prices and ownership come from the current chain; never use tutorial pricing.
All current direct writes use Ethereum mainnet and cost ETH for network fees.
The default supported payer/owner is the active Freedom wallet. Different
recipients, primary names, transfers, subnames, wrapping, fuses, marketplace
buying and resolver migration are outside this initial direct-tool slice.
Explain unsupported operations rather than inventing raw contract calls.

## Point an owned name at a site

Use the verified website publicationId returned by swarm_publish or
swarm_publication_status in this conversation. A batch ID, local file hash,
chunk hash or arbitrary reference is not a verified website publication.
Prepare set_website, inspect its old/new record, then execute its opaque ID.
Freedom encodes the Swarm contenthash; never supply raw ABI/calldata or a key.
Only the requested record changes. Never replace a custom resolver as a shortcut.
Use clear_website only for an explicit request to remove the website pointer.
Updating a name does not make a public site private or extend its Swarm postage.

## Register or renew

Confirm the exact normalized name and term before asking for spending approval.
Prepare register/renew and preserve the operationId. No preparation signs.
Registration is commit → on-chain wait → reveal; each transaction needs separate
wallet approval. A commit spends gas but does not buy or reserve a name.
Freedom generates and protects secrets: never request, read, print or invent one.
Use domain_operation_status while waiting; a ready reveal uses domain_execute on
the same operation. Do not end a task while its normal confirmation/commitment
wait is active. Freedom keeps waiting operations alive and returns receipts.
An expired commitment requires a new user-directed operation, not an automatic
second purchase. Renewing changes expiry, not ownership or records.

## Stop, restart and uncertain results

Stop/decline prevents future sends; it cannot undo submitted transactions.
Known IDs survive conversation deletion/restart in the profile. After compaction
or interruption, inspect domain_operation_status before preparing anything new.
A timeout, missing transaction response or provider failure is not proof of no
effect. Never resend dispatch_unknown, failed verification or a successful write
whose fresh name resolution is delayed. Report the actual state and reconcile.
Never work around a declined wallet approval without a new user request.
If the user explicitly asks to resume a declined/known-unsent step, call
domain_execute with the same operationId and resume=true. It needs a fresh
wallet approval; do not discard a paid commitment or prepare a duplicate.
This never permits resending dispatch_unknown.

## Completion

Distinguish submitted, confirmed, on-chain state verified and Freedom name
resolution verified. For a website, open the name in a fresh task tab after the
verified result. If retrieval/resolution fails, report it without paying again.
Report transaction hashes, the name, term/expiry when known and the final URL.
No request may claim a live purchase, ownership or resolved site from preparation
or a commitment alone.
