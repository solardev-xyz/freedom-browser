# Permission Manifests — one-consent Swarm grants for dweb apps

Status: DESIGN v3.1 — revised after three peer-review passes (2026-07-20).
v1's capability/discovery/provenance gaps and v2's consent-state,
crash-recovery, identity-preservation, and navigation-lifecycle gaps are
addressed below; v3.1 adds non-voluntary privileged-method freshness and
fail-closed transport-switch handling. Implemented as a first version in
[PR #168](https://github.com/solardev-xyz/freedom-browser/pull/168). The
implementation-neutral interoperability profile is
[swarm-app-permission-manifest.md](swarm-app-permission-manifest.md).
Scope: **Swarm permissions only, bzz-hosted apps only (v1).** A wallet
extension is sketched in Appendix A but is explicitly NOT part of this
proposal — see §0.
Audience: freedom-browser implementer (desktop Electron first; iOS later)
Origin: ddrive/Freedom Office onboarding work (2026-07). Companion ideas:
`swarm_deriveAppSecret` (not covered here), origin continuity (partially
already shipped — see §1.4).

---

## 0. TL;DR and scope rationale

A dweb app ships a declarative `freedom-manifest.json` alongside its
build. On first connect the browser fetches it, renders ONE consolidated
consent sheet, and a single Approve projects the whole batch into the
EXISTING permission stores. Main-process method authorization and limits
do not change; the renderer gains a manifest-freshness gate before any
privileged method may consume stored authority (§5.1). The manifest is a
batch-grant front-end over grants that already exist.
The grant is bound to the manifest's **capability set**: a redeploy that
broadens it triggers a diff prompt; one that narrows or removes it prunes
manifest-managed authority. Manual Settings changes always win over the
manifest (§6.3).

**Why Swarm-only.** The dialog fatigue is entirely on the Swarm side:
connect → publish approval → feed approval (its own grant + identity
choice) → signing approval → messaging-tier grant + send approvals. The
wallet is quiet by design: ddrive-class apps sign chain transactions with
their own derived agent key over plain RPC — `window.ethereum` never sees
them. The wallet's only touchpoints are one `personal_sign` at login
(one-time via the existing signing auto-approve,
`dapp-permissions.js:185-212`) and funding transfers, which must ALWAYS
prompt (`dapp-permissions.js:217` — hard invariant, manifest or not).
Nothing worth batching there today.

**Why bzz-only (v1).** Named origins normalize transport away
(`bzz://name.gwei` and `ipfs://name.gwei` share one permission key —
§1.4), but manifest discovery must fetch from the transport the page
actually committed on. Rather than specify same-snapshot binding for
every transport, v1 supports manifests only for pages whose committed URL
is `bzz:` (raw ref or name) — sufficient for ddrive. First-contact and
unmanaged origins on other transports fall back to today's per-action
flow. A previously Bzz-manifest-tracked named origin is pruned before
that fallback so managed authority cannot cross the unsupported
transport boundary (§5.4).

---

## 1. Current state (what the manifest layer sits on)

### 1.1 Swarm permissions — `src/main/swarm/swarm-permissions.js`

- Schema (`:8-15`): `{ origin, connectedAt, lastUsed, autoApprove:
  { publish, feeds, signing, messaging }, messaging?: { grantedAt } }`.
- `VALID_AUTO_APPROVE_TYPES` (`:156`), all default false.
- `grantPermission(origin)` (`:78`), `grantMessaging(origin)` (`:208`),
  `setAutoApprove(origin, type, enabled)` (`:183`).
- **Gaps to close for this design** (prerequisite work, §10):
  `revokeMessaging` does not exist (only whole-record
  `revokePermission`, `:103`); `onRevoke` (`:124`) holds a SINGLE
  listener slot (provider layer uses it for subscription teardown) — turn
  it into a listener list.

### 1.2 Feed identity + feed grant — `src/main/swarm/feed-store.js`

A separate store the v1 draft of this doc missed. Per-origin schema
(`:13`): `{ activeIdentityId, identities, feedGranted, grantedAt,
feeds }`. Key facts:

- `feedGranted` (`hasFeedGrant`, `:879`) is its OWN consent, distinct
  from `autoApprove.feeds`: the renderer's feed/signing path
  (`swarm-provider.js:164-190`) prompts when the feed grant is missing
  BEFORE it ever consults auto-approve, then requires an unlocked vault,
  then consults auto-approve. Projecting only `autoApprove.feeds = true`
  would therefore NOT remove the first feed prompt.
- The feed grant carries a **publisher identity choice** (`:17-23`):
  default 'app-scoped' (dedicated key at `m/44'/73406'/{index}'/0/0`) vs
  'bee-wallet' (node-global). Identity switching is an explicit user
  action; identities are never silently forgotten.
- Vault unlock is a RUNTIME condition, not a grant — manifests do not
  and must not interact with it (the unlock prompt stays, §3).

### 1.3 Prompt plumbing (renderer)

`src/renderer/lib/swarm-provider.js` orders the checks (permission →
tier/feed grant → vault → auto-approve) and shows prompts; screens live
in `src/renderer/lib/wallet/swarm-connect.js` — `showSwarmConnect`
(`:250`), publish (`:416`), messaging (`:548`), feed/signing (`:680`).
`handleRequestAccess` (`swarm-provider.js:238`) SHORT-CIRCUITS when a
permission record exists — the manifest check for already-granted origins
must hook exactly there (§5.1). Origin comes from
`getDisplayUrlForWebview` (`:14,61`).

### 1.4 Origin identity — `src/shared/origin-utils.js`

Origins with an ENS-name host are keyed by NAME (`bzz://ddrive.gwei/x` →
`ddrive.gwei`); raw content origins by root ref. **Named-app grant
continuity across redeploys already exists.** The manifest layer adds:
continuity is only silent while the capability set is unchanged (§6).
Note the permission key LOSES transport — which is why discovery binds to
the committed page URL, not the key (§5.4). Keep the renderer mirror
`src/renderer/lib/origin-utils.js` in sync.

---

## 2. Design overview

1. **Manifest file** — `freedom-manifest.json` at the app origin root,
   declaring capabilities from an explicit registry (§3) with plain-text
   justifications (§4).
2. **Main-process-owned lifecycle** — fetch, validation, hashing,
   diffing, and grant application all live in main; the renderer only
   displays a model and approves an opaque pending-consent token (§7).
3. **One consent sheet** with three outcomes: Allow all / Connect with
   individual approvals / Don't allow (§8).
4. **Projection with provenance** — Approve projects through existing
   store APIs; each projected grant is marked manifest-managed; manual
   Settings changes detach management and always win (§6).

Invariants:

- A manifest can only batch grants the browser could already give through
  individual prompts + checkboxes. No new authority; no wallet reach
  (unknown capability groups reject the whole manifest).
- Apps without a manifest: today's flow, unchanged.
- Main-process provider dispatch/authorization and LIMITS
  (`swarm-provider-ipc.js`) are untouched. Renderer routing adds the
  §5.1 freshness gate before stored grants are consulted.
- Vault unlock prompts are untouched.

---

## 3. Capability registry (explicit, not derived)

The schema is defined by this registry — NOT by whatever
`VALID_AUTO_APPROVE_TYPES` happens to contain. Each capability maps to
the COMPLETE set of grants that today's prompt sequence would produce:

| Capability  | Projects to |
|---|---|
| (implicit)  | `swarm-permissions.grantPermission(origin)` — the base connect record |
| `publish`   | `autoApprove.publish = true` |
| `feeds`     | feed-store: `feedGranted = true` + ensure a publisher identity exists; `autoApprove.feeds = true` |
| `signing`   | same feed-store grant + identity as `feeds`; `autoApprove.signing = true` |
| `messaging` | `grantMessaging(origin)` + `autoApprove.messaging = true` |

Publisher identity projection is **ensure, never replace**:

- If the origin already has an active publisher identity (identity
  metadata survives disconnect), preserve it. Manifest approval never
  switches a bee-wallet, Ethereum-wallet, or existing app-scoped choice.
  The sheet names the identity that will remain active.
- If the origin has no identity, create the feed-store's
  privacy-preserving app-scoped identity metadata and make it active.
  The sheet states *"a new app-scoped signing identity will be created
  for this app"*. The bee-wallet choice remains available in Settings.

Creating the app-scoped feed-store record allocates derivation metadata;
it does not derive or expose the private key (`createAppScopedIdentity`,
`feed-store.js:600`, calls the metadata-only `createIdentity` at `:114`).
Key material is resolved later at cryptographic use
(`resolveSignerKey`, `swarm-provider-ipc.js:993-998`). Therefore identity
metadata **and `feedGranted` are projected
immediately even while the vault is locked**. Actual key use
still triggers the existing runtime vault-unlock prompt
(`swarm-provider.js:176-178`). There is no deferred permission state and
no provider-enforcement exception for manifests.

`feeds` and `signing` share the feed-store projection; granting either
marks the feed grant manifest-managed once (provenance is per projected
FLAG, §6.3, so pruning `signing` alone never removes the feed grant that
`feeds` still justifies).

---

## 4. Manifest schema

`freedom-manifest.json` at the app origin root. Schema `v1`:

```json
{
  "schema": "freedom-manifest/1",
  "name": "ddrive",
  "description": "Encrypted drive + docs on Swarm and Gnosis",
  "capabilities": {
    "swarm": {
      "publish":   { "why": "Store your encrypted files and documents" },
      "feeds":     { "why": "Keep a stable address for each document" },
      "signing":   { "why": "Anchor drive data in single-owner chunks" },
      "messaging": { "why": "Live collaboration presence and sync" }
    }
  }
}
```

Validation is strict and fail-closed (invalid manifest ⇒ per-action flow
+ console warning for the developer):

- Every JSON object uses an explicit allowlist (`additionalProperties:
  false` semantics). Root requires exactly `schema`, `name`, and
  `capabilities`, with optional `description`; `schema` must equal
  `freedom-manifest/1`. `capabilities` requires exactly a non-empty
  `swarm` object. Each capability value requires exactly `{ "why": ... }`.

- `capabilities.swarm.*` keys MUST be from the §3 registry. Unknown
  swarm keys or unknown capability GROUPS (e.g. a future `"wallet"`)
  reject the manifest as a whole — the forward-compat rule: an older
  browser meeting a newer manifest ignores it entirely rather than
  granting a subset its sheet never showed.
- `why`: non-empty string, ≤ 140 Unicode code points, plain text
  (attacker-controlled — no markup/URLs honored).
- `name`: non-empty string, ≤ 32 Unicode code points. `description` is an
  optional string ≤ 160 Unicode code points. The sheet shows the ORIGIN
  as the primary identity; name/description are secondary flavor only
  (§8).
- Reject (do not silently strip) C0/C1 controls, line/paragraph
  separators, and Unicode bidi embedding/override/isolate controls in
  all displayed strings. Validation and consent history therefore refer
  to exactly the same sanitized-free values.
- Size cap 8 KB, enforced DURING streaming of the fetch (abort past the
  cap, don't buffer-then-check).

---

## 5. Discovery lifecycle

### 5.1 When to check

`swarm_requestAccess` is the eager/natural app-init trigger, but it is
**not the security boundary**: an already-authorized page can currently
call publish/feed/signing/messaging methods without calling
`requestAccess` again. Before the renderer consults any stored base,
tier, feed, or auto-approve grant for a privileged method, it calls
`ensureManifestFresh(webview, committedNavigation, origin)`.

The freshness gate behaves as follows:

- A manifest-tracked origin whose current committed navigation has not
  been checked runs the full §5–6 lifecycle before the privileged method
  continues. If a diff sheet appears, Allow all continues with projected
  grants, individual approval continues into today's per-action prompt,
  and Don't allow rejects the triggering method.
- An origin with no base permission still receives today's UNAUTHORIZED
  result and must call `swarm_requestAccess`; a direct privileged call
  does not become an alternate connection prompt.
- An existing untracked/legacy origin keeps today's behavior. Its bounded
  manifest discovery remains tied to `swarm_requestAccess`; its authority
  is user-owned rather than subject to a manifest-binding claim.
- Permission-free public methods (`swarm_getCapabilities`, public
  reads/listing) bypass the gate. Teardown such as `swarm_unsubscribe`
  also bypasses it so cleanup can never be blocked by discovery or UI.

Concurrent eager or lazy checks are deduplicated per origin + committed
navigation (one in-flight check + sheet; all callers await it). A
completed check is cached only for that committed top-level navigation,
identified by the renderer-owned webContents/navigation sequence and
committed display URL — **not for the origin's whole browser session**.
Reloading or navigating a named origin starts a new check even when its
display URL is unchanged, so a redeploy observed during the same browser
launch still diffs/prunes promptly.

- **No permission record** (first contact): fetch manifest. Found →
  consent sheet. Not found / invalid / transport unsupported → legacy
  `showSwarmConnect`.
- **Record exists, manifest-tracked** (a `manifest-grants.json` entry,
  whether its acknowledged rows are managed or individual): fetch once
  for every committed navigation that calls `requestAccess` or reaches
  the lazy privileged-method gate. Hook both the `handleRequestAccess`
  short-circuit (`swarm-provider.js:238`) and the top-level privileged
  dispatch paths (`:72-113`). Outcome per §6.2.
- **Record exists, unmanaged** (legacy grant, or app added a manifest
  later, or first-contact fetch failed transiently): retry discovery at
  a bounded cadence — at most once per committed navigation and with a
  browser-session backoff after `unresolved`. Re-enter through the DIFF
  path (§6.2), treating a capability as already satisfied only when its
  **complete §3 projection** is currently true. Fully satisfied,
  user-owned capabilities are acknowledged as `individual` and are not
  re-asked; partial projections are additions because the manifest asks
  for persistent auto-approval, not merely the underlying tier grant.
  This closes the progressive-enhancement trap where one transient
  timeout at first contact would otherwise freeze an origin in legacy
  mode forever.

### 5.2 How to fetch

Main process only. Resolve `<origin-root>/freedom-manifest.json` through
the browser's own content path — never an external gateway:

- `bzz://<ref>` origins: local Bee/Ant HTTP API (`getAntApiUrl()`,
  `src/main/service-registry.js`, as `swarm-provider-ipc.js:44`).
- Named origins committed on bzz: `resolveEnsContent(name)`
  (`src/main/ens-resolver.js:1451`) → fetch within the snapshot returned
  by the same resolver/cache path used by `bzz:` loading. Record that
  resolved snapshot ref alongside the result (audit trail, §6.1).

For a raw-ref URL, this is exact content binding. For a named URL, the
security principal is the normalized name: the committed URL does not
carry its resolved ref, so a later manifest check is not cryptographic
proof that the already-rendered page and manifest are byte-for-byte from
the same snapshot. Capturing the fetch snapshot closes accidental
cross-fetches and provides audit evidence; exact loaded-snapshot binding
is future hardening. Security claims in §9 intentionally use
**same-origin resolution path**, not "same committed bytes."

Timeout: same bounded retrieval behavior as `bzz:` page content — a cold
collection entry can legitimately take longer than 2s; do NOT use an
aggressive fixed timeout that turns cold-cache into "no manifest". The
8 KB cap is enforced while streaming.

### 5.3 Outcome classification (drives §6.2)

- `found(manifestBytes)` — parsed + validated.
- `absent` — DEFINITIVE 404 within a successfully resolved snapshot.
- `unresolved` — timeout, node down, resolution failure. Never treated
  as absent.
- `invalid` — present but fails validation. Treated like `absent` for
  lifecycle purposes (it cannot express a capability set), plus dev
  warning.
- `unsupported_transport` — committed page is not `bzz:`. Classification
  is local and definitive; handling depends on whether the origin is
  already manifest-tracked (§5.4).

### 5.4 Transport binding

Discovery uses the COMMITTED page URL (from the tab's display URL, the
same source the trust model already relies on), not the permission key:
the key has lost transport for named origins (§1.4). Consequently,
`bzz://name.gwei` and `ipfs://name.gwei` can consume the same stored
permission flags even though v1 can validate a manifest only for the
former.

v1 rules for a committed URL that is not `bzz:`-transported:

- First-contact or untracked/legacy origin → skip discovery and use the
  legacy flow.
- Manifest-tracked origin → under the §7 journal/mutex, treat the managed
  capability set as empty: prune every still-managed projection, preserve
  user-owned/unmanaged grants, drop manifest tracking, then continue via
  the legacy flow. This runs from both `requestAccess` and the lazy
  privileged-method freshness gate, so changing transport cannot be used
  to retain Bzz-manifest authority.

Extending manifests to ipfs/ipns/https is future work and requires
per-transport retrieval and snapshot rules.

---

## 6. Grant state: fingerprints, provenance, diffs

### 6.1 `manifest-grants.json` (new store; same userData-JSON pattern,
module cache, `_resetCache`)

```js
{ "<originKey>": {
    version: 1,
    observed: {              // latest successfully fetched manifest
      capabilities: ["feeds", "messaging", "publish", "signing"],
      capabilityFingerprint,
      rawHash,               // sha256 of served bytes — audit/debug only
      snapshotRef,           // snapshot used for this fetch — audit only
      observedAt
    },
    acknowledged: {          // consent baseline, distinct from observation
      "publish": {
        decision: "managed" | "individual",
        source: "sheet" | "existing-grant",
        whyShown?,            // present only when a sheet showed the row
        decidedAt
      }, ...
    },
    managed: {               // projection provenance: flag → owning rows
      "swarm.autoApprove.publish": ["publish"],
      "feedStore.feedGranted": ["feeds", "signing"], ...
    },
    receipts: [{             // bounded audit trail of sheets acted upon
      decidedAt, outcome: "managed" | "individual",
      originShown, manifestNameShown, manifestDescriptionShown,
      rows: [{ capability, browserLabelVersion, whyShown }],
      builtInCopyVersion, rawHash, snapshotRef
    }],
    unresolvedSince?: number,
    transaction?: { ... }    // write-ahead recovery record (§7)
} }
```

`observed` answers "what does the current manifest request?";
`acknowledged` answers "which rows has the user already made a batch or
individual decision about?" They MUST NOT be collapsed into one
fingerprint. This matters after a mixed diff whose removals were applied
but whose additions were rejected: observed might be `{feeds,
messaging}`, while acknowledged is only `{feeds}`.

The semantic fingerprint includes the schema identifier plus sorted
capability keys. `rawHash` never drives authority. A redeploy that edits
only description/why/whitespace updates `observed.rawHash`, but existing
`acknowledged.*.whyShown` and receipts remain what the user actually saw;
new wording appears only on a future sheet containing that row. The
sheet says "bound to this set of permissions," not "this exact file."

Receipts are capped (implementation constant; suggested latest 20 per
origin) so attacker-driven manifest churn cannot grow the store without
bound. `acknowledged` is operational state; receipts are display/audit
history.

### 6.2 Per-navigation check outcomes (manifest-tracked origins)

For `found`, let `current` be the served capability set and `known` be
the keys of `acknowledged`. First apply removals `known − current` through
the journaled mutation path (§7): remove their acknowledgement, remove
their ownership from `managed`, and prune flags whose owner list becomes
empty. These removals are unconditional and stick even if later
additions are rejected.

Then compute additions `current − acknowledged`:

- Before prompting, an addition whose complete §3 projection is already
  true is acknowledged as `individual`; it is not re-asked and does not
  acquire new managed provenance. Existing ownership belonging to a
  different acknowledged row (for example signing's ownership of the
  shared feed grant) remains unchanged.
- No remaining additions → update `observed`, silent continuity.
- Additions remain → show a DIFF sheet listing only those rows.
  - **Allow all:** project only the shown rows, acknowledge them as
    `managed`, and update provenance dependency-by-dependency: a false
    flag is set and owned; an already manifest-managed shared flag gains
    the new row as an owner; an already true-but-unmanaged flag stays
    user-owned and gains no manifest owner.
  - **Connect with individual approvals:** acknowledge the shown rows as
    `individual` without projecting them. The same manifest does not
    re-raise a batch sheet on the next navigation; those operations use
    today's prompts. If a future manifest adds different rows, only the
    new rows may be offered in a diff sheet.
  - **Don't allow:** do not acknowledge additions and do not project
    them; keep session-scoped rejection memory. They may be offered again
    after that rejection scope expires.

This single algorithm covers unchanged, additions-only, removals-only,
and mixed manifests without requiring `observed` to pretend rejected
rows were approved. For an already tracked origin, every successful
`found` updates `observed` even when additions are rejected;
`acknowledged` remains the consent baseline. First-contact **Don't
allow** is the exception: keep the observation/token only in session
memory and do not create a disk record for an origin that has neither a
permission nor an acknowledged decision.

Non-`found` outcomes:

- `absent` / `invalid` → treat as an EMPTY capability set: prune all
  still-manifest-managed grants, drop the record (origin becomes an
  unmanaged legacy grantee of whatever survives, i.e. user-made grants).
  This is what makes "bound to the manifest" true — a named-origin
  redeploy cannot shed its manifest yet inherit broad auto-approvals.
- `unsupported_transport` → for a manifest-tracked origin, use the same
  empty-set prune/drop transition before legacy handling; for an
  untracked origin, there is no manifest state to mutate (§5.4).
- `unresolved` → keep everything, set `unresolvedSince`, retry next
  qualifying navigation subject to the §5.1 session backoff — never
  auto-prune on `unresolved`. For a TRACKED origin the freshness gate
  cannot be satisfied, so privileged methods FAIL with a temporary
  availability error until a check succeeds (this is what PR #168
  implements and what the interoperability profile §2.3 requires:
  "neither broadens nor revokes authority, but blocks its use until
  freshness is established" — earlier revisions of this doc were
  ambiguous here). Untracked origins are unaffected and continue
  through per-action prompts.

### 6.3 Provenance rules (the manual-override contract)

Every flag the projection sets records the manifest rows that own it in
`managed`. Rules:

- **Settings mutations detach.** Any manual toggle of a flag (either
  direction) via the Settings/permission UI clears its `managed` entry.
  Renderer-exposed Settings and per-action-prompt mutation IPCs call a
  user-mutation wrapper that detaches; main-process manifest projection
  uses separate internal setters and MUST NOT trigger detachment. Do not
  accept a renderer-provided `source: "manifest"` escape hatch.
- **Diffs never touch unmanaged flags.** Additions: if the flag is
  already true-but-unmanaged, approving the diff does NOT re-mark it
  managed silently — it stays the user's. Removals: only flags still in
  `managed` are pruned. Consequently: a user who manually disabled feeds
  will never have feeds silently re-enabled by a later diff approval
  that only showed messaging (re-projection re-applies ONLY the rows
  shown+approved on the diff sheet, never the unchanged remainder).
- **Shared projections prune conservatively**: removing feeds/signing
  removes that row from `managed["feedStore.feedGranted"]`; the feed grant
  is demoted only when its owner list becomes empty. An `individual` row
  is not a manifest owner. Publisher identity records and active-identity
  selection are never managed or pruned by the manifest.
- Pruning uses real revocation APIs: `setAutoApprove(…, false)`, the new
  `revokeMessaging`, and a feed-store demotion that clears `feedGranted`
  WITHOUT deleting identities or feed records (identities are never
  silently forgotten — `feed-store.js:23`).

### 6.4 Full revocation

Route Settings "disconnect" through a main-process origin-state
coordinator under the same §7 per-origin mutex. It journals the intent,
revokes the base permission, demotes feed access, cancels live resources
through the multi-listener `onRevoke` chain, then removes the manifest
record last. This makes disconnect win over an in-flight consent token
and closes the existing renderer-side two-IPC partial-disconnect window.
The manifest-store revoke listener remains as fallback cleanup for any
legacy/internal caller that invokes `revokePermission` directly; it must
not delete an in-progress disconnect journal before recovery can finish.

---

## 7. Main-process flow: pending-consent tokens, atomicity

The renderer NEVER sends a manifest as grant authority. One flow, owned
by main:

```
renderer                            main
requestAccess / privileged gate ──▶ manifest check (§5)
                                    fetch, validate, fingerprint, diff
◀── { kind: 'consent'|'diff',
      model, consentToken }         (token: opaque, single-use,
                                     session-scoped, bound to origin +
                                     navigation + observed fingerprint +
                                     manifest-record revision + shown rows)
render sheet from model
user decides ─────────────────────▶ manifest:decide(consentToken, outcome)
                                    journal + apply outcome (§3, §6.2)
◀── connected/granted/rejected      commit manifest record if mutated
```

The three authority stores are separate JSON files, so use a write-ahead
transaction in `manifest-grants.json`; **do not write the manifest record
last without a journal**. That would make partially projected flags look
user-owned after a crash and they could escape later pruning.

All manifest-driven mutations — managed/individual decisions, automatic
removals, absent/invalid pruning, Settings detachment, and full
disconnect — run under a per-origin main-process mutex:

1. Validate the token/revision when consent is involved. Compute explicit
   set-to-value operations, provenance-owner changes, acknowledgement
   changes, and the receipt/observed result.
2. Persist `transaction: { id, state: "applying", baseRevision,
   observedFingerprint, operations, targetRecord }` **before** changing
   any authority store. The durable transaction proves which partial
   flags are manifest-owned.
3. Apply operations idempotently to swarm-permissions and feed-store.
   Identity creation is ensure-if-absent; setters never toggle. Store
   methods used by this coordinator MUST propagate persistence failures
   instead of logging-and-returning success.
4. Verify that every authority-store write is durably persisted (not
   merely reflected in a module cache). Persist `targetRecord` with the
   transaction removed and an incremented revision only after all writes
   succeed. The JSON stores, including the journal, use temp-file +
   atomic-rename replacement so a process crash cannot leave truncated
   JSON. On failure, leave `transaction` applying for recovery.

On startup, before provider requests are served, recover every
`state:"applying"` transaction by finishing its idempotent operations and
committing `targetRecord`. The user decision or narrowing operation was
durable before projection began, so completion is safer than guessing
which partial writes to keep. The next normal manifest check handles any
deployment that changed while the browser was down.

Consent tokens are logically single-use, but approval is retry-safe: the
main process keeps the in-flight/completed result for each token for the
session. A duplicate call returns/awaits that same result. An unknown
token, or a token whose origin/navigation/fingerprint/base revision no
longer matches before journaling starts, is stale and triggers a fresh
check.

The pending-consent model also kills prompt races: one token per origin +
committed navigation at a time; matching `swarm_requestAccess` calls
while a sheet is open await the same resolution. The per-origin mutation
mutex serializes a navigation change, Settings detachment, disconnect,
and manifest approval so a stale token cannot overwrite newer state.

---

## 8. Consent sheet (renderer)

New screen alongside the existing ones in
`src/renderer/lib/wallet/swarm-connect.js`:

```
  ddrive.gwei                              ← ORIGIN, primary identity
  "ddrive — Encrypted drive + docs"        ← manifest name/desc, secondary

  This app wants to use your Swarm node:

  ✓ Publish data                Store your encrypted files and documents
  ✓ Create and update feeds     Keep a stable address for each document
      A new app-scoped signing identity will be created for this app.¹
  ✓ Sign single-owner chunks    Anchor drive data in single-owner chunks
  ✓ Live messaging (PSS/GSOC)   Live collaboration presence and sync

  Publishing uses your node's storage stamps and bandwidth.
  This grant is bound to this set of permissions. If a future version
  asks for more, you'll be asked again. Manage anytime in Settings.

  [ Don't allow ]   [ Use individual approvals ]   [ Allow all ]

  ¹ If an identity already exists, instead show:
    "Uses your existing <identity label>; the manifest will not change it."
```

- **Three outcomes.** `Allow all` → token approval (§7). `Use individual
  approvals` → grant only the base connection (when needed), persist
  a manifest-tracked record acknowledging every shown row as
  `individual`, and append an individual-outcome receipt. No
  auto-approval/tier projection is performed. The app's later operations
  therefore use today's operation/tier-specific prompts, but the same
  manifest does not offer the batch sheet again on the next navigation.
  A future manifest may offer only genuinely new rows. `Don't allow` → reject the
  triggering request without acknowledging rows; rejection memory is
  scoped to origin + observed fingerprint for the browser session, so a
  different manifest is not accidentally suppressed. Next launch may
  ask again.
- Row labels are browser-owned per capability; only the `why` column is
  app text. Origin display: names as-is, raw refs truncated.
- Diff sheets render only the added rows with the same outcomes. The
  individual option keeps old grants and acknowledges only the shown
  additions as individual.

---

## 9. Security analysis

- **No authority expansion** — every projected grant is reachable today
  via prompts + checkboxes; the manifest changes WHEN consent happens,
  not WHAT is grantable. Vault-unlock and stamp economics untouched.
- **Consent fatigue is the threat model** — five sequential dialogs
  train reflexive approval; one structured sheet is read with context.
- **Manifest = attacker-controlled input** — streaming size cap, schema
  fail-closed, plain-text `why`/`name`, browser-owned row labels, origin
  as primary identity (a manifest cannot dress up as another app).
- **Origin + resolution-path binding** — grants key off the
  renderer-derived committed display URL (`swarm-provider-ipc.js:11-22`)
  and manifests use the browser's own local `bzz:`/name-resolution path
  (§5.2, §5.4). Raw refs bind exact bytes. Named origins bind the name
  principal and record the fetch snapshot for audit; v1 does not claim
  cryptographic equality with an already-rendered named snapshot.
- **Downgrade honesty** — capability-fingerprint binding + absent-means-
  empty (§6.2) closes the "redeploy without a manifest, keep the broad
  grants" hole. Unsupported transport is also empty for tracked origins,
  so normalized name-key continuity cannot carry Bzz-managed authority
  into IPFS/IPNS content; `unresolved` never prunes and never broadens.
- **Non-voluntary freshness** — `requestAccess` is the eager UX trigger,
  but every privileged path is gated before stored manifest-managed
  authority is consumed. An app cannot retain stale grants by omitting
  `swarm_requestAccess` (§5.1).
- **Manual-override supremacy** — provenance rules (§6.3) guarantee an
  unchanged manifest or unrelated diff can never re-enable what a user
  turned off, and pruning never touches user-made grants. A capability
  removed and later re-added is shown again; explicit approval of that
  row is allowed to supersede the older manual choice.
- **Crash-safe provenance** — a durable write-ahead record exists before
  any cross-store projection or prune, so recovery cannot misclassify a
  partially written manifest flag as user-owned (§7).

---

## 10. Implementation plan

Foundation work (substantial infrastructure; split into independently
landable changes where practical, but schedule as part of the M1 security
unit):

- `swarm-permissions.js`: add `revokeMessaging`; convert `onRevoke` to a
  listener list.
- `feed-store.js`: expose a projection API — grant feed access with
  ensure-if-absent app-scoped identity provisioning while preserving any
  active identity, and a demotion that clears `feedGranted` without
  touching identities/feeds.
- Manifest store: versioned observed/acknowledged/provenance records,
  per-origin revision/mutex, write-ahead transaction recovery before
  provider startup, and bounded receipts (§6–7).
- Authority-store mutation APIs used by the coordinator: atomic file
  replacement, propagated write failures, and durable-success results;
  cache-only verification is insufficient (§7).
- Renderer-exposed Settings and per-action write paths: use dedicated
  user-mutation wrappers that detach provenance (§6.3); manifest code
  calls internal setters.
- Replace the renderer's sequential permission/feed disconnect calls
  with the journaled main-process origin-state coordinator (§6.4).
- Add `ensureManifestFresh` to renderer request routing before every
  privileged method that can consume base/tier/feed/auto-approve state;
  explicitly exempt permission-free reads and teardown (§5.1).

**M1 — the security unit (ships together, not separately):** manifest
fetch/validate/fingerprint (§4–5), pending-consent flow (§7), consent +
diff sheets with three outcomes (§8), projection with provenance (§3,
§6.3), full lifecycle including absent-prunes and unresolved handling
(§6.2), privileged-method freshness gating and unsupported-transport
pruning (§5), session rejection memory, AND the Settings surface (show the
acknowledged capability decisions, effective grant state, and consent
receipts per origin; per-row revoke with detach). Launching batch grants
without the downgrade lifecycle or
visibility would be a net security regression — they are one unit.

Tests: strict-schema fixtures (valid / missing or extra fields / unknown
group or key / empty capabilities / description limits / bidi-controls /
oversize streaming / non-JSON); projection round-trip against the REAL
stores, including locked-vault metadata provisioning and preservation of
each existing identity mode; diff matrix (unchanged / add / remove /
mixed-approve / mixed-reject / absent / invalid / unresolved /
unsupported-transport);
observed-vs-acknowledged and individual-decision persistence; provenance
matrix (manual-disable then unrelated diff; remove/re-add with explicit
approval; manual-enable then manifest-remove; shared feeds/signing
owners); crash recovery after every journal/store write boundary;
durable-write failure with cache divergence and truncated-file recovery;
duplicate-token result replay and stale-token rejection; concurrent
requestAccess dedupe plus a second committed navigation in the same
browser session; direct publish/feed/signing/messaging calls without
`requestAccess`; tracked `bzz://name` → `ipfs://name` transport switch;
public-read and unsubscribe gate bypass; fetch-failure → legacy fallback
→ later unmanaged upgrade.

**M2 — polish:** unresolved-notice UX, iOS port (separate Swift stores,
same design — `swarm-mobile-ios` SwarmPermissionStore/feed equivalents).

App-side integration (completed in ddrive): emit `freedom-manifest.json`
from `freedom-drive/scripts/deploy-workspace.mjs` into the collection
root. One manifest per origin — co-deployed drive+docs share it (the
union = ddrive's list above).

---

## Appendix A — future wallet extension (NOT part of this proposal)

Recorded so the thinking isn't lost; do not build any of this now.

**Why it's out of scope:** ddrive-class apps sign chain transactions with
their own derived agent key directly over RPC — the browser wallet never
sees them. The wallet's only touchpoints are one `personal_sign` at login
(one-time via the existing signing auto-approve,
`dapp-permissions.js:185-212`) and funding transfers, which must always
prompt (`:217`). There is no wallet dialog fatigue to fix today.

**The trigger that would change this:** moving app transaction signing
INTO the browser wallet. That would be a real security upgrade — it
eliminates the hot agent private key the app keeps in localStorage — but
it is only ergonomically survivable with pattern-scoped auto-approve,
because every ddrive portal is a freshly minted contract and per-contract
rules (`isTransactionAutoApproved`, `dapp-permissions.js:224-240`) never
generalize. If that day comes, the manifest grows a `wallet` capability
group with:

- **Named sign messages**: exact message strings, narrower than the
  blanket signing flag (store field `autoApprove.signMessages`).
- **Registry-mediated tx scopes**: "allow calls to any contract this
  registry attests it created", restricted to declared function
  signatures (browser derives selectors), `value == 0` enforced,
  fail-closed on RPC errors. Verification against the Fileverse registry
  is already confirmed feasible (local `fileverse-smartcontracts`
  checkout, `contracts/FileversePortalRegistry.sol`):
  `portalInfo(address) → Portal` (`:120`, call-verify — zeroed struct for
  unknown addresses), `event Mint(address indexed account, address
  indexed portal)` (`:51`, log-verify), and `ownedPortal(owner, …)`
  (`:164`) for a tightest-scope "owned-by-caller" variant. Real
  signatures for the ddrive case: `addFile(string,string,string,uint8,
  uint256)`, `editFile(uint256,string,string,string,uint8,uint256)`,
  `updateMetadata(string)`, `mint(string,string,string,bytes32,bytes32,
  bytes32,bytes32)`.

The v1 schema's fail-closed rule for unknown capability groups (§4) is
what makes this a clean later addition: a `wallet` group in a manifest
today rejects the whole manifest (per-action flow), so an M1-era browser
can never be tricked into granting wallet scopes it cannot render.
