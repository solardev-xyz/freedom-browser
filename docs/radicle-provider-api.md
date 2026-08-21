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
from the user's local `radicle-httpd` (repo-scoped, `GET`/`HEAD` only,
rate-limitable, CORS-open — see `src/main/radicle/rad-protocol.js`). Public
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

Injected into the page realm of every web page before `DOMContentLoaded`,
alongside `window.swarm`:

```javascript
window.radicle.request({ method: string, params?: object }): Promise<any>
```

plus convenience wrappers (one per method below), and EIP-1193-style events:

```javascript
window.radicle.on('connect' | 'disconnect', handler);
window.radicle.removeListener(event, handler);
```

`connect` fires on access grant, `disconnect` on revocation.

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

`data.reason` values include: `invalid_rid`, `invalid_id`, `invalid_title`,
`invalid_body`, `not_seeded`, `repo_not_found`, `announce_failed`,
`payload_too_large`.

## Permission tiers

1. **Connection** — `radicle_requestAccess`, persisted per normalized
   origin (same origin normalization as the Swarm provider: derived from
   the user-visible URL; `bzz://<ref>`, `ens name`, `rad://<rid>` and
   `https://host` origins each map to a stable key).
2. **Node actions** — `radicle_seed`, `radicle_unseed`, `radicle_sync`,
   `radicle_listSeededRepos`: require connection. `seed` SHOULD present a
   per-repo prompt (disk/bandwidth commitment) unless auto-approve is on.
3. **Identity & writes** — `radicle_getIdentity` and all COB writes:
   require a separate **signing grant** (analog of the Swarm feed tier).
   First call MAY prompt; rejection → 4001. Writes sign with the user's
   node identity — there are no per-origin sub-identities in v1 (a forge
   wants you to be _you_; see Design decisions).

Auto-approve per origin and per tier MAY be offered, revocable at any
time, mirroring the Swarm provider's `{ publish, feeds, signing }` model
with `{ node, signing }`.

## Methods

### `radicle_requestAccess` → `{ connected, origin, capabilities }`

Prompt (once) for connection. Repeat calls return existing state. Emits
`connect`.

### `radicle_disconnect` → `{ connected: false }` (connection tier)

The inverse of `requestAccess`: the origin relinquishes its own grant
(connection AND signing, plus auto-approvals). No consent prompt — an
origin may always drop its own access. Works while the node is stopped.
Emits the `disconnect` provider event.

### `radicle_getCapabilities` → capability object (no permission)

```javascript
{
  specVersion: '0.1',
  canUseNode: boolean,        // connected AND node running
  reason: string | null,      // 'not-connected' | 'integration-disabled' |
                              // 'node-stopped' | 'node-not-ready'
  writes: ['issue', 'issueComment', 'issueState', 'patchComment']
}
```

### `radicle_getNodeStatus` → `{ running, nid?, peers? }` (connection tier)

Coarse node state for UI (peer count, running/stopped). `nid` is only
included once the signing grant exists (the NID is identifying).

### `radicle_listSeededRepos` → `[{ rid, name, description }]` (connection tier)

The repos the user's node seeds. Unlike `swarm_listFeeds` this is NOT
permission-free: the seeded-repo list is private information about the
user, not data the origin could compute itself.

### `radicle_seed { rid }` / `radicle_unseed { rid }` (node tier, per-repo prompt)

`seed` writes the seeding policy and starts a **background** network
fetch, resolving immediately with `{ rid, seeded: true, status }` where
`status` is the same shape `radicle_getSeedStatus` returns. Policy and
replication are deliberately separate: the fetch can take seconds, fail
per-seed, or never complete, so its outcome is polled, not awaited. This
is the gateway action for browsing repos the node doesn't have yet.
`unseed` removes the policy (and cancels any fetch in flight), resolving
`{ rid, seeded: false }`.

### `radicle_getSeedStatus { rid }` (connection tier)

Honest replication status for a repo; cheap and safe to poll (~2s).
Resolves:

```
{
  rid,
  state: 'fetched' | 'fetching' | 'failed' | 'idle',
  inStorage: boolean,       // ground truth: repo is served locally
  seedersKnown: number|null, // network seeders discovered for the fetch
  attemptCount: number,
  recentAttempts: [{ nid, ok, error?, at }],  // last 5 per-seed results
  lastError: string|null,
  startedAt: number|null,
  finishedAt: number|null
}
```

`idle` means nothing is known this session (not tracked, not stored).
A `failed` repo may still flip to `fetched` later — the node keeps
retrying in the background on refs announcements.

### `radicle_sync { rid }` (node tier)

(Re)start the background fetch for an already-seeded repo — the retry
path after `state: 'failed'`, without a second consent prompt. Resolves
immediately with `{ rid, status }`; poll `radicle_getSeedStatus`.

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

Writes execute the bundled `rad` CLI against the node's `RAD_HOME`
(verified non-interactive on rad 1.9.1):

| Method           | Command                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| createIssue      | `rad issue open --repo <rid> -t <title> -d <desc> [--labels …]` (verbose — `-q` prints nothing for `open`; the id is parsed from output) |
| commentIssue     | `rad issue comment <id> --repo <rid> -m <body> -q`                                                                                       |
| editIssueState   | `rad issue state <id> --repo <rid> --open/--closed/--solved`                                                                             |
| commentPatch     | `rad patch comment <rev> --repo <rid> -m <body> -q` (only the long `--repo` form exists here)                                            |
| seed/unseed/sync | `rad seed/unseed/sync <rid>`                                                                                                             |

All COB writes work storage-only via `--repo` — no working copy needed.
Writes announce to the network by default (that is the point); the node
must be running. Announce failures surface as `-32603` with
`data.reason = 'announce_failed'` but the local write persists.

## Design decisions (v1)

- **Single identity.** All origins act as the user's one Radicle identity
  once granted the signing tier. Rationale: a code forge is a reputation
  system; per-origin sub-identities (the Swarm app-scoped model) would
  fragment the user into unlinkable authors and break the delegate/ACL
  model. The identity is only disclosed behind the signing grant.
- **Patch creation is out of scope.** Creating a patch requires commits
  and a `git push` via `git-remote-rad`, i.e. a working copy. The
  recommended future design is browser-managed bare checkouts under the
  profile directory with a high-level
  `radicle_commitAndPush({ rid, changes[] })`, but v1 ships COB writes
  only (issues + patch comments cover the collaboration loop around
  existing patches).
- **Private repos** are invisible to the `rad:` URL scheme (httpd does
  not serve them). v1 does not expose them through the provider either.
- **No repo creation** (`rad init`) in v1 — it needs a working copy and
  raises squatting/spam questions; revisit with patch creation.

## Security considerations

- Origin identification comes from the browser's display URL, never from
  page-controlled values (same trust model as the Swarm provider).
- The provider MUST validate RIDs (`z` + base58, 20–60 chars) and COB ids
  (hex, 6–40 chars) before shelling out, and MUST pass them as discrete
  argv entries (never through a shell) to make injection structurally
  impossible.
- Writes are irrevocable once announced. The signing-grant prompt MUST
  make clear that the site will be able to author content as the user on
  the Radicle network.
- Rate-limit write methods per origin to protect the network and the
  user's reputation from runaway dApps.
