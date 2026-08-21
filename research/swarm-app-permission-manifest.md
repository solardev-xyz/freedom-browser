# Swarm Application Permission Manifest

Status: **Draft interoperability profile, version 1** (2026-07-20).

This document specifies the portable behavior of the application permission
manifest implemented by Freedom Browser in
[PR #168](https://github.com/solardev-xyz/freedom-browser/pull/168). It is a
starting point for coordination with other Swarm clients and SwarmID, not an
adopted Swarm standard. The filename and schema identifier match the working
implementation and remain open to change in a future, jointly versioned
profile.

The detailed Freedom Browser design and implementation rationale remain in
[permission-manifest-design.md](permission-manifest-design.md).

## 1. Scope and terminology

A Swarm application can publish a small declarative manifest at the root of
its Bzz origin. The manifest tells a compatible client which existing Swarm
capabilities the application wants and why. The client can present those
requests together, remember the user's decision, and safely reconcile that
decision when the application is redeployed with a different capability set.

The manifest batches consent; it does not define new provider methods, grant
new kinds of authority, unlock keys, select postage stamps, or bypass runtime
resource and policy checks.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
describe interoperability or security requirements.

- **Application origin**: the client's canonical permission principal for the
  committed top-level page. A named origin is normally keyed by name; a raw
  content origin is normally keyed by its root reference.
- **Capability row**: one entry in `capabilities.swarm`.
- **Projection**: the complete set of existing client grants represented by a
  capability row.
- **Manifest-managed grant**: a grant that the client enabled because the user
  approved a manifest row and that remains subject to manifest removal.
- **User-owned grant**: a grant created or modified outside manifest approval.
  Manifest reconciliation MUST NOT revoke or silently take ownership of it.
- **Tracked origin**: an origin for which the client retains a manifest
  observation, acknowledgements, or manifest-managed provenance.

## 2. Discovery

### 2.1 Location and transport

Version 1 applies only to applications whose committed top-level URL uses the
`bzz:` scheme. The manifest URL is:

```text
bzz://<committed-host>/freedom-manifest.json
```

The manifest is rooted at the host and does not inherit the page path.

The client MUST retrieve the manifest through the same native Bzz content and
name-resolution path it uses to load application content. It MUST NOT use an
unrelated public HTTP gateway. Before applying the result, it MUST verify that
the canonical origin derived from the committed URL equals the origin whose
permissions are being considered.

For a raw Swarm reference, this binds discovery to immutable content. For a
named origin, version 1 binds authority to the name and the same resolution
path; it does not claim that the page and a later manifest fetch are
byte-for-byte from the same resolved snapshot. A client SHOULD record the
resolved snapshot reference as audit metadata when its resolution layer makes
that value available. The snapshot reference MUST NOT replace the application
origin as the permission principal.

Other transports are outside version 1. If a tracked named origin is opened
through another transport, the client MUST treat the manifest-managed
capability set as empty before falling back to its non-manifest permission
flow. This prevents permissions established by a Bzz manifest from silently
carrying over to content loaded through an unsupported resolution path.

### 2.2 When to check

A client MUST check a tracked origin at least once for every committed
top-level navigation before allowing that navigation to consume stored
manifest-managed authority. Calling an explicit connection method can trigger
discovery early, but it MUST NOT be the only freshness boundary: an already
authorized application might call a privileged operation directly.

Concurrent checks for the same origin and committed navigation SHOULD share
one in-flight discovery and consent result. A completed result MUST NOT be
cached across later top-level navigations, even when a named URL is unchanged.

Public reads and capability introspection that require no permission MAY
bypass discovery. Cleanup operations such as unsubscribe SHOULD bypass it so
that transient retrieval failures cannot prevent resource teardown.

For an untracked origin, a client MAY limit discovery to its explicit
connection flow. A transient discovery failure MUST NOT permanently classify
that origin as manifest-free; later qualifying navigations SHOULD retry with a
bounded session backoff. The current Freedom Browser profile uses delays of 2,
10, 30, and then 60 seconds between unresolved attempts.

### 2.3 Retrieval and outcomes

The response body MUST be no larger than 8 KiB. The limit MUST be enforced
while streaming, not after buffering an arbitrarily large response. The body
MUST be decoded as strict UTF-8 and parsed as JSON.

Discovery has five outcomes:

| Outcome | Meaning |
|---|---|
| `found` | A successful response was decoded, parsed, and validated. |
| `absent` | Retrieval definitively returned HTTP 404. |
| `invalid` | Content was present but failed retrieval or schema rules, including other definitive 4xx responses. |
| `unresolved` | The node, network, or name resolution failed temporarily, timed out, or returned a non-definitive server failure. |
| `unsupported_transport` | The committed top-level page did not use `bzz:`. |

For a tracked origin, `absent`, `invalid`, and `unsupported_transport` MUST be
treated as an empty manifest capability set: remove manifest-managed authority
and drop manifest tracking while preserving user-owned grants. An invalid
manifest SHOULD also produce a developer-visible diagnostic.

`unresolved` MUST NOT be treated as absence and MUST NOT revoke grants. A
tracked navigation MUST NOT consume manifest-managed authority until freshness
can be established; the client should return a temporary availability error
and retry subject to backoff. An untracked origin MAY continue through the
client's ordinary per-action permission flow.

## 3. Version 1 schema

The top-level JSON object has this form:

```json
{
  "schema": "freedom-manifest/1",
  "name": "Example app",
  "description": "An optional short description",
  "capabilities": {
    "swarm": {
      "publish": { "why": "Store your encrypted files" },
      "feeds": { "why": "Maintain stable document addresses" },
      "signing": { "why": "Create signed Swarm updates" },
      "messaging": { "why": "Synchronize live collaboration" }
    }
  }
}
```

Validation is strict:

- The root object MUST contain `schema`, `name`, and `capabilities`. It MAY
  contain `description`. No other root member is allowed.
- `schema` MUST equal `freedom-manifest/1`.
- `name` MUST be a non-blank string of at most 32 Unicode code points.
- `description`, when present, MUST be a string of at most 160 Unicode code
  points. It may be empty.
- `capabilities` MUST contain exactly one member, `swarm`.
- `capabilities.swarm` MUST be a non-empty object. Its keys MUST come from the
  version 1 registry in section 4.
- Each capability value MUST be an object containing exactly one member,
  `why`.
- `why` MUST be a non-blank string of at most 140 Unicode code points.

All displayed strings MUST be treated as plain, attacker-controlled text. The
client MUST reject rather than strip a string containing:

- C0 control characters (`U+0000`-`U+001F`);
- C1 control characters (`U+007F`-`U+009F`);
- line or paragraph separators (`U+2028`, `U+2029`); or
- bidirectional embedding, override, or isolate controls
  (`U+202A`-`U+202E`, `U+2066`-`U+2069`).

Unknown fields, capability keys, capability groups, and schema identifiers
invalidate the whole manifest. A version 1 client MUST NOT silently grant the
subset it recognizes because that subset may not match the consent presentation
intended by a newer application.

## 4. Capability registry

Approving a capability represents its complete projection below. A client MAY
use different internal storage, but the resulting consent boundaries MUST be
equivalent.

| Capability | Projection |
|---|---|
| `publish` | Establish the base application connection and allow publishing without a repeated per-operation approval. |
| `feeds` | Establish the base connection, grant feed access, ensure a publisher identity exists, and allow feed creation and updates without repeated approval. |
| `signing` | Establish the base connection, grant feed/signing access, ensure a publisher identity exists, and allow Swarm content signing without repeated approval. |
| `messaging` | Establish the base connection, grant the messaging tier, and allow supported PSS/GSOC messaging operations without repeated approval. |

**Informative method mapping.** Capability semantics above are stated
behaviorally because clients differ in internal permission granularity.
For clients exposing the Swarm provider API (the `window.swarm` SWIP
draft and its messaging extension), the reference implementation maps
capabilities to provider methods as follows; a successor profile should
make this mapping normative once the provider API is finalized:

| Category | Provider methods covered |
|---|---|
| Connection establishment | `swarm_requestAccess` |
| Base connection only | `swarm_getUploadStatus` (origin-owned uploads), `swarm_unsubscribe` (origin-owned teardown; freshness bypassed) |
| `publish` | `swarm_publishData`, `swarm_publishFiles`, `swarm_publishChunk` |
| `feeds` | `swarm_createFeed`, `swarm_updateFeed`, `swarm_writeFeedEntry` |
| `signing` | `swarm_writeSingleOwnerChunk`, `swarm_getSigningIdentity` |
| `messaging` | `swarm_getMessagingIdentity`, `swarm_subscribe`, `swarm_sendPss`, `swarm_sendGsoc` |

Permission-free methods (`swarm_getCapabilities`, `swarm_readFeedEntry`,
`swarm_readChunk`, `swarm_readSingleOwnerChunk`, `swarm_listFeeds`) are
not affected by any capability. `swarm_unsubscribe` remains connection- and
origin-scoped, but bypasses the freshness boundary so teardown cannot be
blocked (section 2.2).

The `feeds` and `signing` projections share the feed grant and publisher
identity dependency. A client MUST track those shared dependencies so removing
one capability does not revoke a dependency still justified by the other.

Publisher identity handling follows an **ensure, never replace** rule:

- If the application already has an active publisher identity, approval MUST
  preserve it regardless of its identity mode.
- If no publisher identity exists, the client creates or reserves its
  privacy-preserving app-scoped identity and makes it active.
- Removing capabilities or disconnecting MUST NOT silently delete identity
  records or change the user's identity selection.
- Creating identity metadata MUST NOT unlock a vault or expose key material.
  Any runtime vault-unlock requirement remains in force when the key is used.

The base connection is implicit rather than a manifest row. Choosing
individual approvals may establish only that connection; each declared
capability then follows the client's ordinary per-action or per-tier prompts.

## 5. Consent and change semantics

### 5.1 Consent presentation

The application origin MUST be the primary identity shown to the user.
Manifest-provided `name` and `description` are secondary context. Capability
labels and explanations of their authority MUST be client-owned; only the
corresponding `why` text comes from the application.

The client MUST offer three semantically distinct outcomes:

1. **Allow all**: acknowledge the displayed rows as managed and apply their
   projections. Only grants newly enabled by this decision become
   manifest-managed; an already-enabled user-owned grant stays user-owned.
2. **Use individual approvals**: acknowledge the displayed rows as individual
   without enabling their capability projections. The client may establish the
   implicit base connection. Later operations use ordinary prompts, and the
   same rows are not offered again as a batch unless they are removed and later
   re-added.
3. **Don't allow**: do not acknowledge or project the displayed additions.
   Removals already discovered from a mixed update still apply. On first
   contact, the client MUST NOT create a durable manifest record solely because
   of rejection. It SHOULD suppress duplicate prompts for at least the current
   committed navigation.

If `feeds` or `signing` would create an app-scoped identity, the consent view
MUST say so. If an identity already exists, it MUST say that the existing
identity will be preserved.

### 5.2 Semantic comparison

Authority is bound to the set of capability keys, not to the exact manifest
bytes. Clients MUST compare the schema identifier plus the sorted capability
keys when deciding whether the authority request changed.

A SHA-256 hash of the exact served bytes MAY be retained for audit and
debugging, but it MUST NOT control authority. Changes only to whitespace,
`name`, `description`, or `why` do not require renewed consent. Consent history
MUST preserve the text actually shown when a decision was made.

Clients MUST separately represent:

- the latest successfully observed capability set; and
- the capability rows the user has acknowledged as managed or individual.

These values differ after, for example, a mixed update whose removals were
applied but whose additions were rejected.

### 5.3 Additions and removals

For a successfully validated manifest, let `current` be its capability keys and
`acknowledged` be the rows with a prior managed or individual decision.

1. Apply removals, `acknowledged - current`, before considering additions.
   Remove each acknowledgement and its ownership of projected grants. Disable
   a projected grant only when it has no remaining manifest owners and has not
   become user-owned.
2. Compute additions, `current - acknowledged`.
3. If an addition's complete projection is already enabled through user action,
   acknowledge it as individual without prompting or taking ownership.
4. If additions remain, display only those new rows. Allowing them projects only
   those rows; it MUST NOT silently reapply unchanged rows.

Removing a capability and later adding it again creates a new addition and
requires a new decision. Removed publisher identity records are the exception:
they are retained as described in section 4.

### 5.4 Manual changes, revocation, and provenance

A client MUST retain enough provenance to distinguish manifest-managed grants
from user-owned grants.

- Any manual change to a projected grant detaches that grant from manifest
  management, whether the user turns it on or off.
- Manifest reconciliation MUST NOT change a detached or otherwise user-owned
  grant.
- Approval of a later diff applies only to the rows displayed in that diff. It
  MUST NOT re-enable an unchanged capability that the user manually disabled.
- When multiple rows share a projected grant, the client MUST retain all owning
  rows and revoke that grant only after the last owner is removed.
- A full disconnect MUST revoke the base connection and applicable runtime
  grants, terminate live resources, demote feed access, and remove manifest
  tracking as one serialized logical operation. Identity records remain.

## 6. Security and state requirements

- **No new authority:** a manifest projection MUST be equivalent to authority
  the client could already grant through its ordinary prompts. Runtime limits,
  postage economics, and vault requirements remain independent.
- **Authoritative processing:** fetching, validation, semantic comparison,
  provenance, and grant mutation MUST occur in a trusted client component. An
  untrusted application or rendering context MUST NOT submit manifest bytes as
  the authority to grant permissions.
- **Consent binding:** a consent action MUST be bound to an opaque or otherwise
  unforgeable pending decision containing at least the origin, observed
  semantic capability set, displayed rows, and current permission-state
  revision. Expired, unknown, replayed with a different result, or stale
  decisions MUST NOT grant authority. Retrying the same completed decision MAY
  return its original result.
- **Origin serialization:** manifest decisions, navigation reconciliation,
  manual permission changes, and disconnects for the same origin MUST be
  serialized. A stale approval MUST NOT overwrite newer state.
- **Crash consistency:** if one decision updates multiple authority stores, the
  client MUST durably record intent before applying changes and MUST recover by
  completing idempotent operations. A crash MUST NOT cause a partially applied
  manifest grant to be mistaken for a user-owned grant.
- **Fail-closed parsing:** size, UTF-8, schema, key, and displayed-text rules are
  enforced before a consent model is created.
- **Fail-safe retrieval:** a definitive empty capability set removes only
  manifest-managed authority. A temporary retrieval failure neither broadens
  nor revokes authority, but blocks its use until freshness is established.
- **Bounded state:** consent receipts, completed-decision replay state, and
  retry bookkeeping SHOULD be bounded so an application cannot cause
  unbounded client storage growth.

## 7. Versioning and coordination

The on-wire version 1 compatibility points are currently:

- filename: `freedom-manifest.json`;
- schema identifier: `freedom-manifest/1`;
- one required capability group: `swarm`; and
- capability keys: `publish`, `feeds`, `signing`, and `messaging`.

The Freedom-specific names are historical and provisional from a standards
perspective, but changing either one requires a new compatibility profile or a
defined dual-discovery transition.

Most importantly, a SwarmID capability group cannot be added to a version 1
manifest while remaining compatible with current clients: unknown groups
invalidate the whole file by design. SwarmID permissions therefore require a
coordinated successor schema (or another explicitly negotiated extension
mechanism) that defines:

- the group name and individual capability semantics;
- whether partial understanding is ever safe;
- how clients advertise supported schema versions and groups;
- how consent and revocation interact with Swarm identity selection; and
- how applications migrate while version 1 clients remain in use.

Until that successor is agreed, applications targeting the implemented profile
MUST emit exactly the version 1 schema described here.
