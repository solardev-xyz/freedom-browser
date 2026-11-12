# Radicle Provider API (`window.radicle`) — Draft Specification

**Status:** Draft v0.1 (first implementation iteration)
**Companion:** the Swarm Provider API (`window.swarm`) SWIP, whose
request/response pattern, error model, and permission architecture this
document follows.

## Summary

A browser-injected JavaScript provider (`window.radicle`) that lets web
applications perform **actions** against the user's local Radicle node —
seeding repositories, syncing, disclosing the user's Radicle identity, and
writing collaborative objects (issues, comments, state changes) — with user
consent and origin-scoped permissions.

## Scope: actions only — reads are URL fetches

Unlike `window.swarm`, this provider deliberately has **no read methods**
for repository data. Freedom Browser resolves the `rad:` URL scheme
directly: any page can `fetch('rad:<rid>/tree/<sha>/…')` and receive JSON
from the user's in-process Radicle storage (repo-scoped, `GET`/`HEAD` only,
CORS-open — see `src/main/radicle/rad-protocol.js`). Public
repo data needs no consent: it is world-readable P2P content, and the same
bytes are obtainable from any seed.

The provider exists for everything that is **not** a public read:

| Concern                                          | Why it needs consent                                                |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Seeding                                          | Commits the user's disk + bandwidth indefinitely; node-state change |
| Syncing                                          | Consumes bandwidth on demand                                        |
| Identity disclosure                              | The user's DID is a persistent cross-site identifier                |
| COB writes                                       | Sign with the user's key; irrevocable once gossiped                 |
| Node introspection (seeded-repo list, node info) | Private information about the user                                  |

## Provider object

Installed in the page's main world of every web page's top frame before any
of the page's own scripts run, alongside `window.swarm` and `window.ethereum`.
A page's Content Security Policy does not affect it. It is not installed in
private windows, in sub-frames, or on Freedom's internal pages. Main also
refuses every method that changes lasting state when it comes from a private
window, or from a sender main cannot place in a known window: `radicle_seed`,
`radicle_unseed`, `radicle_sync`, `radicle_disconnect` and the COB writes
(`4100`, reason `private_window`). The reads it still answers there don't
record their use in the permission store, and no grant is recorded from a
private window. A page that reaches the provider channel anyway leaves
nothing behind.

```javascript
window.radicle.request({ method: string, params?: object }): Promise<any>
```

plus convenience wrappers (one per method below), and EIP-1193-style events:

```javascript
window.radicle.on('connect' | 'disconnect' | 'seedStatus', handler);
window.radicle.removeListener(event, handler);
```

`connect` fires on access grant, `disconnect` on revocation, and `seedStatus`
streams replication transitions for seed/sync actions started by this origin.
Freedom sends `connect`, `disconnect` and `seedStatus` to every open page of
the site, whichever page or screen granted or revoked the access, or started
or watched the fetch. A page whose address is a DNS name served over IPNS
hears them only while the name still serves that IPNS key. While an earlier
`seedStatus` is on its way to a page, Freedom keeps for each repository how
its last fetch ended (`fetched`, `failed` or `cancelled`) and its latest
status after that, for at most 64 repositories: a page always hears how a
fetch ended, and a repository's latest state, but may miss steps between.

The page's requests go straight to Freedom's main process, which decides who
asked from the page itself, never from the browser UI, and shows the
connection and seeding prompts (freedom-core design 0011). A request from a tab in the
background waits until you switch to that tab, with a dot on the tab and a
count on the wallet button. One whose prompt hasn't shown within its time
limit is closed with `-32603` "Request timed out"; a prompt on screen waits
for your answer. A page with no address of its own (a `data:` or `about:`
page) can't connect, and its requests are refused with `4100`.

### Errors

JSON-RPC error objects `{ code, message, data? }`, aligned with the Swarm
provider:

| Code   | Meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| 4001   | User rejected the request                                              |
| 4100   | Unauthorized (no connection grant / grant revoked / tier not granted)  |
| 4200   | Unknown method                                                         |
| 4900   | Radicle unavailable (integration disabled, node stopped, or not ready) |
| -32602 | Invalid params (`data.reason` gives a machine-readable cause)          |
| -32603 | Internal error                                                         |

An error that comes from the Radicle add-on carries a fixed message for its
kind, never the add-on's own text, which can name files in the user's
profile: `not found`, `repository data too large to serve here`,
`request cancelled`, or else `the read failed`, `the write failed`, or
`Internal error` for a failure outside a read or a write. A seed status's
`lastError`, `progress.reason` and `recentAttempts[].error` follow the same
rule, with `the fetch failed` for a failure of no other kind. The code and
`data.reason` are decided on the add-on's text, as before.

`data.reason` values include: `invalid_rid`, `invalid_id`, `invalid_title`,
`invalid_body`, `not_seeded`, `repo_not_found`, `announce_failed`,
`payload_too_large`. A signed write the site's "always allow writes" rule
answered, and that Freedom refuses just before signing it, carries `4100`
with `agent_custody` (the tab entered Agent custody meanwhile),
`not_auto_approved` (the rule was turned off meanwhile), `not_connected` or
`signing_not_granted` (the grant was revoked meanwhile). Past the rule's
rate limit Freedom shows the per-write prompt itself.

## Permission tiers

1. **Connection** — `radicle_requestAccess`, persisted per normalized
   origin (same origin normalization as the Swarm provider: derived from
   the user-visible URL; `bzz://<ref>`, `ens name`, `rad://<rid>` and
   `https://host` origins each map to a stable key).
2. **Node actions** — `radicle_seed`, `radicle_unseed`, `radicle_sync`,
   `radicle_listSeededRepos`: require connection. `seed` and `unseed`
   present a per-repo prompt (each changes the seeding policy: a
   disk/bandwidth commitment, or dropping one the user made) unless
   auto-approve is on. `sync` does not prompt, and is therefore restricted
   to repos that already have a seeding policy.
3. **Identity & writes** — `radicle_getIdentity` and all COB writes:
   require a separate **signing grant** (analog of the Swarm feed tier).
   First call MAY prompt; rejection → 4001. Writes sign with the user's
   node identity — there are no per-origin sub-identities in v1 (a forge
   wants you to be _you_; see Design decisions).
   The grant lets a site ask; it does not answer a write. Each COB write
   prompts with its exact content, saying that it is signed with the
   user's Radicle identity and is public and permanent; rejection → 4001.
   The prompt offers a per-site **"always allow writes"** rule
   (`autoApprove.signing`), which only that choice turns on; the browser
   can only turn it off. Writes the rule answers are rate-limited per
   origin in main: a burst of 5, then 1 per 30 s, and at most 50 in any
   24 hours. Past the limit a write falls back to the prompt, where the
   user can also turn the rule off. The counts are held in memory.
   On a tab Freedom Agent holds, the rule does not apply: each write
   prompts, and its prompt offers no rule.
   The prompt shows exactly what the write signs: params the write refuses
   (`-32602` with its reason) are refused with no prompt. Freedom checks
   the page again just before the node signs and publishes the write, after
   the prompt; a write that went out answers with its id even if the page's
   name moves while it is published.

Auto-approve is stored per origin and per tier as `{ node, signing }`,
mirroring the Swarm provider's `{ publish, feeds, signing }` model, and
ends when the site disconnects.

## Methods

### `radicle_requestAccess` → `{ connected, origin, capabilities }`

Prompt (once) for connection. Repeat calls return existing state. Emits
`connect`, to every open page of the site. No prompt while Radicle is
disabled for the profile (`4900`, reason `profile-disabled`).

### `radicle_disconnect` → `{ connected: false }` (connection tier)

The inverse of `requestAccess`: the origin relinquishes its own grant
(connection AND signing, plus auto-approvals). No consent prompt — an
origin may always drop its own access. Works while the node is stopped.
Emits the `disconnect` provider event, to every open page of the site.

### `radicle_getCapabilities` → capability object (no permission)

```javascript
{
  specVersion: '0.2',
  canUseNode: boolean,        // connected AND node running
  reason: string | null,      // 'not-connected' | 'profile-disabled' |
                              // 'node-stopped' | 'node-not-ready'
  writes: ['issue', 'issueComment', 'issueState', 'patchComment']
}
```

### `radicle_getNodeStatus` → `{ running, nid?, peers? }` (connection tier)

Coarse node state for UI (peer count, running/stopped). `nid` is only
included once the signing grant exists (the NID is identifying).

### `radicle_listSeededRepos` → `[{ rid, name?, description? }]` (connection tier)

The repos the user's node is configured to seed, including an allow policy
whose first fetch has not succeeded yet (metadata is absent until it lands).
Unlike `swarm_listFeeds` this is NOT
permission-free: the seeded-repo list is private information about the
user, not data the origin could compute itself.

### `radicle_seed { rid }` / `radicle_unseed { rid }` (node tier, per-repo prompt)

`seed` writes the seeding policy and starts a **background** network
fetch, resolving immediately with `{ rid, seeded: true, status }` where
`status` is the same shape `radicle_getSeedStatus` returns. Policy and
replication are deliberately separate: the fetch can take seconds, fail
per-seed, or never complete, so its outcome is reported asynchronously rather
than awaited. Subscribe to `seedStatus` before starting the action; use
`radicle_getSeedStatus` to restore the latest snapshot after a page reload. This
is the gateway action for browsing repos the node doesn't have yet.
`unseed` removes the policy (and cancels any fetch in flight), resolving
`{ rid, seeded: false }`.

Both prompt per repository (unless the origin's `node` auto-approve is
on): seeding commits disk and bandwidth, and unseeding drops a policy the
user chose — a connected origin can already enumerate what to target with
`radicle_listSeededRepos`. A rejected prompt returns 4001 and the node is
never touched. An `rid` the method doesn't accept is refused (-32602,
`invalid_rid`) with no prompt.

No prompt turns the `node` rule on, and the browser can only turn it off.
On a tab Freedom Agent holds the rule never applies: each seed and unseed
prompts. Freedom checks the page again just before the node is touched,
after the prompt: a page that has navigated, a site whose access was
revoked meanwhile (`4100`, `not_connected`), a tab that entered Agent
custody while the rule answered (`4100`, `agent_custody`), or a rule turned
off meanwhile (`4100`, `not_auto_approved`) leaves the node untouched.

### `radicle_getSeedStatus { rid }` (connection tier)

Honest replication-status snapshot for a repo. Live transitions are pushed as
`seedStatus` events whose payload has this same shape.
Resolves:

```
{
  rid,
  state: 'fetched' | 'fetching' | 'failed' | 'cancelled' | 'idle',
  inStorage: boolean,       // ground truth: repo is served locally
  seedersKnown: number|null, // network seeders discovered for the fetch
  attemptCount: number,
  recentAttempts: [{ nid, ok, error?, at }],  // last 5 per-seed results
  progress: { phase, candidates?, nid?, addr?, index?, total?, reason? }|null,
  lastError: string|null,
  startedAt: number|null,
  finishedAt: number|null
}
```

`progress.phase` is one of `starting`, `resolving`, `connecting`,
`fetching`, `peer-failed`, `done`, `failed`, or `cancelled`. Peer-level
events are streamed by the embedded node; byte-level percentages are not
currently available from Heartwood's fetch transport.

`idle` means nothing is known this session (not tracked, not stored).
A `failed` repo may still flip to `fetched` later — the node keeps
retrying in the background on refs announcements.

### `radicle_sync { rid }` (node tier)

(Re)start the background fetch for an already-seeded repo — the retry
path after `state: 'failed'`, without a second consent prompt. Resolves
immediately with `{ rid, status }`; follow `seedStatus` events for progress.

Only repos the node already has a seeding policy for are accepted: the
fetch writes that policy as it replicates, so allowing an unknown RID
here would be a promptless `radicle_seed`. An unseeded RID rejects with
-32602 and `data.reason: 'not_seeded'`. Freedom checks the page again
after it has read the seeding policy, just before the fetch starts.

### `radicle_getIdentity` → `{ did, nid, alias }` (signing tier)

The user's Radicle identity. Bootstrap path for the signing grant, like
`swarm_getSigningIdentity`.

### `radicle_createIssue { rid, title, description, labels? }` (signing tier)

→ `{ id }`. Title ≤ 200 bytes, description ≤ 64 KiB.

### `radicle_commentIssue { rid, issueId, body, replyTo? }` (signing tier)

→ `{ id }`.

### `radicle_editIssueState { rid, issueId, state }` (signing tier)

`state` ∈ `'open' | 'closed' | 'solved'`. → `{ id, state }`.

### `radicle_commentPatch { rid, patchId, body, revisionId? }` (signing tier)

→ `{ id }`. Defaults to the latest revision.

## Backend mapping (implementation note)

Every method calls the `libradicle` napi addon. Repository reads and lists,
seed policy changes, network fetches, identity disclosure, and COB writes all
operate against the profile's in-process node and storage. No Radicle CLI,
HTTP daemon, loopback port, output parsing, or executable fallback is involved.
Successful COB mutations announce their updated refs before returning.

## Design decisions (v1)

- **Single identity.** All origins act as the user's one Radicle identity
  once granted the signing tier. Rationale: a code forge is a reputation
  system; per-origin sub-identities (the Swarm app-scoped model) would
  fragment the user into unlinkable authors and break the delegate/ACL
  model. The identity is only disclosed behind the signing grant.
- **Patch creation is out of scope.** Creating a patch requires commits
  and a managed working copy. The
  recommended future design is browser-managed bare checkouts under the
  profile directory with a high-level
  `radicle_commitAndPush({ rid, changes[] })`, but v1 ships COB writes
  only (issues + patch comments cover the collaboration loop around
  existing patches).
- **Private repos** are invisible to the public `rad:` URL scheme: a
  private repository answers exactly as one this node does not store (404,
  `{ "error": "repository not found" }`), so a page cannot tell them apart.
  v1 does
  not expose them through the provider either.
- **No repo creation** (`rad init`) in v1 — it needs a working copy and
  raises squatting/spam questions; revisit with patch creation.

## Security considerations

- Origin identification comes from the browser's display URL, never from
  page-controlled values (same trust model as the Swarm provider).
- The provider MUST validate RIDs (`z` + base58, 20–60 chars) and COB ids
  (hex, 6–40 chars) before crossing the addon boundary.
- Writes are irrevocable once announced. The signing-grant prompt MUST
  make clear that the site will be able to author content as the user on
  the Radicle network.
- Write methods are rate-limited per origin when the "always allow
  writes" rule answers them (see Permission tiers), to protect the network
  and the user's reputation from runaway dApps.
