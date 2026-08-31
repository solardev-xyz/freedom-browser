---
name: swarm-publishing
description: Publish attached files, live folders, static sites, and bounded text to Swarm through Freedom.
---

# Swarm publishing

Use this skill when the user wants to publish a file, folder, static site, or text document to Swarm. Use Freedom's `swarm_publish` tool. Do not use `window.swarm`, raw `node_request`, or a webpage upload flow for this direct Freedom capability.

## Publication semantics

- A Swarm publication is public and unencrypted. Explain that clearly before publication when the user may not expect public distribution.
- Never ask for or invent a local filesystem path. Use `attachment_list` to find the opaque `resourceId` of a file or folder the user attached to this conversation.
- An attached file is the conversation's stored attachment. An attached folder is a live read-only grant: Freedom publishes the folder's current contents when the user approves and execution begins.
- Do not copy, stage, fingerprint, or compare a folder. The user controls its contents until the upload begins.
- For a static site, publish the whole attached folder. Prefer `index.html` as `indexDocument`; specify a different safe relative document only when the user or project clearly identifies one.
- Use bounded text publication only for text you already have authority to publish. Supply a meaningful filename and content type.

## Preflight

1. Identify the exact attached resource with `attachment_list`. Inspect folder structure only as needed to find the intended root and index document.
2. If the content appears to contain secrets, private keys, credentials, or personal data, warn the user rather than silently publishing it. Do not claim exhaustive secret detection.
3. Call `node_status` if Swarm readiness is unknown.
4. Publication uses an existing usable Swarm postage batch. If Freedom reports that no usable batch exists, load `/freedom-agent/skills/swarm-postage/SKILL.md` and follow that procedure. Never purchase postage implicitly.

## Publish and recover

1. Call `swarm_publish` once with either `resourceId` or bounded `text`. Freedom presents the public-network approval and performs the upload through its canonical publisher.
2. Keep the returned `publicationId`. `uploading` and `verifying` mean Freedom is still observing the same publication.
3. Use `swarm_publication_status` with that ID. Do not repeat `swarm_publish` while the earlier publication may have applied.
4. After a provider disconnect or resumed conversation, call `swarm_publication_status` without an ID to discover recent publications, then inspect the relevant ID.
5. If the state is `outcome_unknown`, do not claim success or failure and do not blindly republish. Explain the uncertainty and reconcile using the publication receipt and safe Swarm checks.

## Completion report

Report the published name, content kind, `bzz://` URL, reference, and whether Freedom verified retrieval. Distinguish a completed but not-yet-verified publication from a verified publication. Never expose a local filesystem path.
