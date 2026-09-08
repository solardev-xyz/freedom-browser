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

Injected into the page realm of every web page before `DOMContentLoaded`,
alongside `window.swarm`:

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
never touched.

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
-32602 and `data.reason: 'not_seeded'`.

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
- **Private repos** are invisible to the public `rad:` URL scheme. v1 does
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
- Rate-limit write methods per origin to protect the network and the
  user's reputation from runaway dApps.
