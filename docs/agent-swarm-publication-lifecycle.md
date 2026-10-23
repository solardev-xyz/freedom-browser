# Agent Swarm publication lifecycle

Implemented on `feature/freedom-automation-kernel`, 2026-09-28.

A publication is a host-managed operation owned by its conversation. The main
agent waits for active publication receipts after its model turn and resumes once
with the result. Waiting needs no repeated model calls or additional helper/model.
A provisional tool response after ten seconds is not the end of the user task.

## Pre-publish scan and approval

Every source kind (managed workspace, attachment, inline text) goes through
`src/main/agent/publication-scan.js` before the approval is shown. The main
process calls it through `publication-scan-host.js`, which runs the scan in a
lazily spawned worker thread (`publication-scan-worker.js`, managed by
`src/main/task-worker-host.js`) so a large publication does not freeze every
window. Only if that worker cannot start, or crashes on the request, does the
scan fall back to running on the main thread; a scan that exceeds the 60 s
worker timeout fails the publication instead (nothing is uploaded). It runs on
the in-memory snapshot that is later uploaded, so the scanned bytes are the
uploaded bytes:

- Path exclusions from the source reader (hidden files except `.well-known`,
  credential file names, `.git`) are listed on the card by name and reason.
- Metadata is removed losslessly and listed as such: `*.map` files and
  `Thumbs.db`/`desktop.ini` are left out of folder publications;
  `sourceMappingURL` comments are removed from `.js`/`.mjs`/`.cjs`/`.css`;
  EXIF/XMP/IPTC/comment segments are removed from JPEG, including any between
  progressive scans, along with bytes after the end-of-image marker (a Motion
  Photo's video, vendor trailers); orientation is kept in a minimal EXIF block.
  Text/time/eXIf chunks are removed from PNG, EXIF/XMP chunks from
  WebP. Pixel data is copied unchanged. An image whose container cannot be
  parsed is left untouched and reported as a metadata warning.
- Every file is scanned in full, whatever its size, with named rules: PEM private keys, cloud/API tokens
  (AWS, OpenAI-style, GitHub, Slack, Stripe, Google, Twilio, SendGrid), JWTs,
  passwords in URLs and key assignments, Ethereum private keys on a line that
  names a key, BIP-39 recovery phrases (12 or more consecutive wordlist words),
  Web3 keystore JSON, RPC URLs with embedded Infura/Alchemy/QuickNode/Ankr keys,
  Slack/Discord webhooks; and, as warnings, email addresses, `+`-prefixed phone
  numbers, checksum-valid IBANs and street addresses. The older
  `historyContainsSecret` check still runs as a backstop. Binary files
  (a NUL in the first 8 KiB) are read byte for byte and checked for secrets
  only, not personal data. Every secret is listed; only warnings are capped at
  25 per file and 200 per publication, and more than 200 secrets refuses the
  publication outright. Rules are written against each provider's documented format
  rather than vendored from gitleaks (RE2 syntax, mostly unrelated services).

Findings carry a redacted excerpt for the card. Secrets block: "Publish
publicly" stays disabled until each one is resolved by **Exclude file**
(folders only), a per-finding **Publish anyway** checkbox, or **Ask Agent to
fix**, which declines and returns only rule names, paths and line numbers to the
model. Main re-checks the choices against the listed files and finding IDs and
refuses an approval that leaves a secret unresolved. The model-facing receipt
carries `prepublishScan` counts and rule names only. The card's permanence line
is fixed markup, not request text, and swarm publications never offer
"Allow for conversation".

Not implemented yet (issue #741): encrypted draft uploads, feed-based stable
addresses, postage cost/TTL on the card, and third-party script/tracker checks.

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
