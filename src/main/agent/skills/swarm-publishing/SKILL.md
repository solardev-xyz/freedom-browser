---
name: swarm-publishing
description: Publish managed project output, attached files, live folders, static sites, and bounded text to Swarm through Freedom.
---

# Swarm publishing

Use this skill when the user wants to publish a file, folder, static site, or text document to Swarm. Use Freedom's `swarm_publish` tool. Do not use `window.swarm`, raw `node_request`, or a webpage upload flow for this direct Freedom capability.

## Publication semantics

- A Swarm publication is public and unencrypted by default (`target` omitted or `public`). Explain that clearly before publication when the user may not expect public distribution.
- `target: "draft"` makes a **private draft link** instead: Freedom uploads it with Swarm encryption and returns a longer `bzz://` link that carries the decryption key. Use it only when the user asks for a draft, preview or private link. Tell the user plainly that anyone who gets the link can read the content, and that the encrypted data is still stored on the public network permanently; it can't be deleted. A draft never gets a stable address or a domain name. Publishing the same content publicly later is a separate `swarm_publish` call with its own approval; never present a draft as published.
- `stableAddress: "<name>"` (public only) publishes under a Swarm feed owned by the user's Swarm identity, so a later publication with the same name updates the same `bzz://` address. Use it when the user wants one address for a site they will keep fixing, and reuse the same name for every update. It needs Freedom's vault unlocked. A feed unpublishes nothing: older versions stay retrievable by anyone who has their own reference while their postage is valid. Say so when you offer it.
- Connect a name (ENS/.wei/.gwei) only when the user asks, through the existing domain tools (`dweb-domains` skill). For a publication with a stable address, the name then follows later updates of that address without another transaction.
- Never ask for or invent a host filesystem path. For content built in this conversation's managed project workspace, use a workspace-relative `workspacePath` such as `.` or `dist`. For user attachments, use `attachment_list` to find the opaque `resourceId`.
- An attached file is the conversation's stored attachment. An attached folder is a live read-only grant: Freedom freezes its current contents for the publication approval.
- A managed workspace source is read directly by trusted Freedom code before approval and frozen for that publication. Do not read project files into the model context and republish them as inline text. Freedom preserves their exact bytes and relative paths without a staging directory.
- Do not copy, stage, fingerprint, or compare a folder. Freedom snapshots and fingerprints the approved contents; later project edits are not silently included.
- For a static site, publish the whole project root, build-output folder, or attached folder. Prefer an explicit build-output folder such as `dist` when the project produces one. Prefer `index.html` as `indexDocument`; specify a different safe relative document only when the user or project clearly identifies one.
- Use bounded text publication only for text you already have authority to publish. Inline text remains a text/data publication like the manual `freedom://publish` flow; do not invent or report a filename. Supply a content type only when it is useful.

## Generated-code hygiene

- Start a new static site from `/freedom-agent/skills/swarm-publishing/site-template.html`. It carries a restrictive `Content-Security-Policy` `<meta>` (everything from the site itself, no forms to other sites). Keep it; add an origin only when the user asks for that third party.
- Bundle fonts, scripts, stylesheets and images into the site instead of loading them from CDNs or other http(s) hosts. Don't add analytics or trackers unless the user asks. Don't point a form's `action` at another site unless the user asks for that service.
- Freedom's pre-publish check lists third-party `<script src>`, `<link>`, `<img>`, `fetch()` targets and external form actions as warnings (by origin only). If the user chooses "Ask Agent to fix" for them, bundle the asset or remove the request, then publish again. Never rewrite the user's own content without being asked.

## Preflight

1. Identify the exact source. For managed project output, inspect the workspace only as needed to choose `.` or the correct build-output subtree and index document. For an attachment, use `attachment_list`.
2. If the content appears to contain secrets, private keys, credentials, or personal data, warn the user rather than silently publishing it. Freedom also scans the exact snapshot before approval and shows its findings to the user; you never see the flagged values. Do not claim exhaustive secret detection.
   - If the user chooses "Ask Agent to fix", the tool result names the rule and file (and line) for each finding. Remove or replace those values in the files without repeating them in chat, keep secrets out of published output entirely, then call `swarm_publish` again. Freedom scans the new snapshot and asks the user again.
3. Call `node_status` if Swarm readiness is unknown.
4. Publication uses an existing usable Swarm postage batch. The approval card shows the user that batch, the estimated share of its prepaid storage, its remaining time, and a warning when it is close to expiry. If Freedom reports that no usable batch exists, load `/freedom-agent/skills/swarm-postage/SKILL.md` and follow that procedure. Never purchase postage implicitly.

## Publish and recover

1. Call `swarm_publish` once with exactly one of `workspacePath`, `resourceId`, or bounded `text`. Freedom presents the public-network approval and performs the upload through its canonical publisher.
2. Keep the returned `publicationId`. `waiting_postage`, `uploading`, `confirming`, and `verifying` are active stages of the same publication. Freedom waits for postage readiness and retries explicit peer propagation rejections with the same batch and approved bytes. Never repeat the purchase.
3. Freedom keeps the turn alive for active publications and wakes you with a terminal receipt. Do not end the task with a provisional “still uploading” answer. You may use `swarm_publication_status` with that ID. Do not repeat `swarm_publish` while the earlier publication may have applied.
4. After a provider disconnect or resumed conversation, call `swarm_publication_status` without an ID to discover recent publications, then inspect the relevant ID.
5. If the state is `outcome_unknown`, do not claim success or failure and do not blindly republish. Explain the uncertainty and reconcile using the publication receipt and safe Swarm checks.

## Completion report

Report the published filename or folder name for a managed workspace or attached source. For inline text, say that the text was published without inventing a filename. Always report the content kind, `bzz://` URL, reference, and whether Freedom verified retrieval. The receipt's `target` says whether it was a public publication or a private draft link; report a draft as a private draft link, never as published. With a stable address, report `stableAddress.bzzUrl` as the address to share, and say plainly if `stableAddress.updated` is false (the content is published, but the address still points to the previous version). Distinguish a completed but not-yet-verified publication from a verified publication. Never expose a host filesystem path.

Stopping observation does not undo an upload already dispatched. After restart, known references/tags can be checked without republishing; an unknown upload result requires reconciliation. A polling deadline or local retrieval alone is not proof of network confirmation. Report an uncertain outcome as uncertain, not as a definite failure.
