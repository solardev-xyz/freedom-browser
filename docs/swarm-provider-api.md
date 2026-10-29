# Swarm Provider API (`window.swarm`)

**Spec version:** `1.0` (the `specVersion` returned by `swarm_getCapabilities`)

`window.swarm` lets a web page publish to Swarm, read and write chunks and
feeds, sign with a publisher identity, and send and receive PSS/GSOC
messages, all through the user's own Swarm node, with per-origin consent.

It is the only way a page reaches the node. Requests from web content to the
node's local HTTP API (`localhost:1633` and the port Freedom actually runs it
on) are blocked, and `bzz://` pages are read-only (`GET`/`HEAD`). Raw Bee
routes such as `fetch('/chunks/<ref>')` are not exposed on desktop; use
`swarm_readChunk` / `swarm_readSingleOwnerChunk` instead. Both verify the
downloaded bytes against the requested address before returning them (see
[#178](https://github.com/solardev-xyz/freedom-browser/issues/178)). For a
whole blob (the counterpart of `GET /bytes/<ref>`), use `swarm_readData`: the
node joins it and checks every chunk it fetches.

This document describes the code as it is. The sources of truth are:

| Layer           | File                                                                                                                                                       | Role                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Page shim       | `src/main/webview-preload.js` (the `window.swarm` block)                                                                                                   | Request ids, timeouts, convenience wrappers, events                             |
| Chrome renderer | `src/renderer/lib/swarm-provider.js`                                                                                                                       | Feature gate, permission manifest check, consent prompts                        |
| Main process    | `src/main/swarm/swarm-provider-ipc.js`                                                                                                                     | The authority: re-checks grants, validates params, limits, pre-flight, dispatch |
| Services        | `src/main/swarm/{publish,chunk,feed,messaging}-service.js`, `feed-store.js`, `swarm-permissions.js`, `subscription-registry.js`, `permission-manifests.js` | Node calls, identities, grants, subscriptions                                   |

The method list is `KNOWN_METHODS` in `swarm-provider-ipc.js`; behaviour is
pinned by `swarm-provider-ipc.test.js`.

## Availability

`window.swarm` is installed in the page's main world of every web page's top
frame before any of the page's own scripts run, the same way as
`window.ethereum` and `window.radicle`. Classic, `defer` and module scripts can
all read it while the page parses, and a page's Content Security Policy does
not affect it.

It is not injected into:

- **private windows** (no provider at all, same as `window.ethereum` and
  `window.radicle`);
- **Freedom's internal pages** (`freedom://…`), which talk to the main process
  through their own API;
- **iframes**: the provider exists only in the top frame, and the chrome drops
  provider messages that do not come from the tab's main frame.

When **Settings → Advanced → Enable Identity & Wallet** is off, the object is
still present but every call fails with `4900` ("Swarm provider is not
available"). Detect Freedom with `window.swarm?.isFreedomBrowser === true`.

## Provider object

```javascript
window.swarm.request({ method: string, params?: object }): Promise<any>
```

`params` defaults to `{}`. Every method also has a convenience wrapper that
calls `request` with the same name minus the `swarm_` prefix, e.g.
`window.swarm.publishData(params)`, `window.swarm.readChunk(params)`,
`window.swarm.listFeeds()`.

Events (EIP-1193 style):

```javascript
window.swarm.on(event, handler)              // also addListener
window.swarm.removeListener(event, handler)
window.swarm.removeAllListeners(event?)
```

`event` is one of `connect`, `disconnect`, `message`; see [Events](#events).

### Timeouts

The shim rejects a request that has had no answer with
`{ code: -32603, message: 'Request timed out' }` after:

- **300 s** for `swarm_publish*`, `swarm_send*`, `swarm_createFeed`,
  `swarm_updateFeed`, `swarm_writeFeedEntry`, `swarm_writeSingleOwnerChunk`,
  `swarm_getSigningIdentity`, `swarm_getMessagingIdentity` and
  `swarm_subscribe` (these may wait on a consent prompt or a node write),
  and `swarm_readData` (a blob of several MiB fetched from the network);
- **60 s** for everything else, including `swarm_requestAccess` and any
  other call that has to wait on a consent prompt: the connect prompt, or
  the [permission manifest](#permission-manifests) sheet, which any
  non-public method can open.

The budget covers the whole request, prompt included, and is set by the
method called, not by which prompt it ends up waiting on. A user who takes
longer than 60 s on a prompt opened by a 60 s method (the connect prompt
from `swarm_requestAccess`, or the manifest sheet opened by
`swarm_requestAccess`, `swarm_getUploadStatus` or another 60 s method) gets a
`-32603 Request timed out` on the page even though the decision, once made,
still takes effect (the grant lands); call `swarm_requestAccess` again, or
retry the call, to pick it up. A 300 s method that opens the manifest sheet
(a `swarm_publishData`, say) keeps waiting for up to 300 s. The node-side bounds named elsewhere (15 s to
mine a GSOC topic, 30 s for a subscription to establish) cover only that
stage, not the request end to end.

A timed-out request may still complete on the node. A response that settles
after the page navigated away is never delivered to the new document.

### Binary data

Write methods take `data` as a string (encoded as UTF-8), `Uint8Array` or
`ArrayBuffer`. Read methods return the bytes as a base64 string with
`encoding: 'base64'`.

## Errors

Rejections are `Error` objects with `code`, `message` and, for most
validation and node failures, `data`:

| Code     | Meaning                                                              | What to do                                                                 |
| -------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `4001`   | The user rejected the prompt                                         | Stop; ask the user again only on a new user action                         |
| `4100`   | Origin not authorized (`data.reason` says which grant is missing)    | Call `swarm_requestAccess`, or the tier's method to trigger its prompt     |
| `4200`   | Unknown method                                                       | Feature-detect with `swarm_getCapabilities`                                |
| `4900`   | Node unavailable or provider disabled (`data.reason`)                | Retry later; the setup reasons send the user to Freedom's publish setup    |
| `-32002` | A hardware-wallet signature is in progress in the sidebar            | Retry once the device confirmation is done                                 |
| `-32602` | Invalid params (`data.reason`, sometimes `data.limit`/`data.actual`) | Fix the request; `rate_limited` and `too_many_subscriptions` are retryable |
| `-32603` | Internal error (node error message passed through, or a timeout)     | Usually transient; retry with backoff                                      |

### `data.reason` values

**`4100`**

| Reason                   | Raised when                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `not_connected`          | The origin has no connection grant                                                           |
| `feed_not_granted`       | A feeds/signing method without the feed grant                                                |
| `messaging_not_granted`  | A messaging method without the messaging grant                                               |
| `tag_ownership_mismatch` | `swarm_getUploadStatus` for a tag this origin did not create, or one already reported `done` |
| `shared_identity`        | `swarm_writeSingleOwnerChunk` while the origin's active identity is shared with other sites |

A `4100` raised by the chrome before the request reaches the main process
carries the message `Origin not authorized. Call swarm_requestAccess first.`
and no `data`.

**`4900`**

| Reason                                | Raised when                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-stopped`                        | The node is not running or does not answer (reads probe `/node` with a 5 s timeout)                                                                                         |
| `node-not-ready`                      | The node is still connecting to Gnosis Chain or to peers, is still looking for the wallet's existing storage, or a batch bought moments ago is not yet known to the network |
| `ultra-light-mode`                    | The node runs in ultra-light mode (no Gnosis Chain connection) and cannot publish                                                                                           |
| `no-usable-stamps`                    | No postage batch with room for the write                                                                                                                                    |
| `subscription_cancelled`, `cancelled` | A subscription was torn down (navigation, tab close, grant revoked) before it was established                                                                               |
| `establish_timeout`                   | A subscription did not establish within 30 s                                                                                                                                |
| `node_subscription_limit`             | The node's subscription pool is full (possibly because of other origins)                                                                                                    |

The four setup reasons (`node-stopped`, `node-not-ready`, `ultra-light-mode`,
`no-usable-stamps`) on a write method also open Freedom's publish setup screen
for the user. Reads only ever report `node-stopped`. A `4900` without `data`
means the provider is disabled, or (message "Could not refresh this app’s
permission manifest", with a typographic apostrophe U+2019) the app's permission manifest could not be fetched.

**`-32602`**

| Reason                                                                                                          | Methods                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `invalid_params`                                                                                                | Any (generic shape error)                                                                                                |
| `unsupported_option` (+ `data.option`)                                                                          | Methods that take `options`: it must be absent or `{}`                                                                   |
| `payload_too_large` (+ `limit`, `actual`)                                                                       | Publish, chunk and message writes; `swarm_writeFeedEntry` (neither `limit` nor `actual`)                                 |
| `data_too_large` (+ `limit`, `actual`)                                                                          | `swarm_readData`                                                                                                         |
| `missing_content_type`                                                                                          | `swarm_publishData`                                                                                                      |
| `empty_files`, `too_many_files`, `invalid_path`, `duplicate_path`, `invalid_index_document`                     | `swarm_publishFiles`                                                                                                     |
| `invalid_reference`, `invalid_span`, `invalid_identifier`, `invalid_owner`                                      | Chunk methods, `swarm_readData`, `swarm_updateFeed`, feed reads                                                          |
| `chunk_not_found`, `chunk_type_mismatch`                                                                        | Chunk reads, `swarm_readData`                                                                                            |
| `invalid_feed_name`, `invalid_topic`, `feed_not_found`, `feed_empty`, `entry_not_found`, `index_already_exists` | Feed methods                                                                                                             |
| `invalid_topic`, `invalid_recipient`, `invalid_target`, `invalid_payload`, `invalid_address`, `invalid_kind`    | Messaging methods                                                                                                        |
| `subscription_not_found`                                                                                        | `swarm_unsubscribe`                                                                                                      |
| `too_many_subscriptions` (+ `limit`)                                                                            | `swarm_subscribe`                                                                                                        |
| `rate_limited`                                                                                                  | Permission-free reads (+ `windowMs`, `maxRequests`, `maxBytes`), new GSOC topics (+ `limit`, `windowMs`, `retryAfterMs`) |

**`-32603`** carries a `data.reason` only for `gsoc_mining_timeout` and
`gsoc_mining_failed` (deriving a GSOC topic's signer failed or ran past 15 s).
Bee 5xx responses and network errors are `-32603`, with two exceptions where
the node reports a missing entry as a 500: feed reads (and the next-index
lookup behind feed writes) treat any Bee 500 like a 404, so a node-internal
500 surfaces as `-32602 feed_empty` / `entry_not_found`; chunk reads map a
500 whose body is exactly `read chunk failed` to `-32602 chunk_not_found`.
So a `-32602` "not found" on a feed read means "not found, or the node
failed while looking"; retrying once is cheap if the feed is expected to
exist.

## Permission tiers

Grants are keyed by the **origin of the tab's address bar**, derived by
Freedom, never by anything the page controls (`window.location` is not used).
The key is path-insensitive:

| Address bar                                   | Permission key            |
| --------------------------------------------- | ------------------------- |
| `bzz://<ref>/page`                            | `bzz://<ref>`             |
| `bzz://myapp.eth/page`, `ens://myapp.eth/#/x` | `myapp.eth`               |
| `ipfs://<cid>/docs`                           | `ipfs://<cid>`            |
| `https://app.example.com/x`                   | `https://app.example.com` |

A content-addressed `bzz://<ref>` origin changes with every redeploy. An app
that wants its grants and feeds to survive a redeploy should be served under
an ENS name.

| Tier           | Methods                                                                                                                              | Grant                        | Prompt                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Public**     | `swarm_getCapabilities`, `swarm_readChunk`, `swarm_readData`, `swarm_readSingleOwnerChunk`, `swarm_readFeedEntry`, `swarm_listFeeds` | none                         | never                                                                                                                              |
| **Connection** | `swarm_requestAccess`                                                                                                                | —                            | once per origin                                                                                                                    |
|                | `swarm_getUploadStatus`                                                                                                              | connection                   | never                                                                                                                              |
| **Publish**    | `swarm_publishData`, `swarm_publishFiles`, `swarm_publishChunk`                                                                      | connection                   | every call, unless "always allow" (`autoApprove.publish`)                                                                          |
| **Feeds**      | `swarm_createFeed`, `swarm_updateFeed`, `swarm_writeFeedEntry`                                                                       | connection + feed grant      | the first call grants the tier and picks the identity; later calls prompt unless `autoApprove.feeds`                               |
| **Signing**    | `swarm_getSigningIdentity`, `swarm_writeSingleOwnerChunk`                                                                            | connection + feed grant      | as Feeds, with `autoApprove.signing`                                                                                               |
| **Messaging**  | `swarm_getMessagingIdentity`, `swarm_subscribe`, `swarm_sendPss`, `swarm_sendGsoc`                                                   | connection + messaging grant | the first call grants the tier; sends prompt every time unless `autoApprove.messaging`; identity and subscribe do not prompt again |
|                | `swarm_unsubscribe`                                                                                                                  | connection                   | never                                                                                                                              |

Notes:

- Feeds and Signing share **one** feed grant; they differ only in which
  auto-approve flag skips the per-call prompt.
- If the feed grant exists but the identity vault is locked, the user is asked
  to unlock it; the unlock prompt (which names the site) takes the place of
  the per-call approval for that call.
- Every rejected prompt is `4001`. No node write happens before the user
  approves.
- The main process re-checks every grant; the chrome's prompts are UX, not the
  security boundary.
- The user can revoke everything for an origin from the connection banner or
  Settings. **Disconnecting revokes the connection, the feed grant, the
  messaging grant and all auto-approvals**, closes the origin's live
  subscriptions and emits `disconnect`. It keeps the origin's publisher
  identities and feed records (see [Identity model](#identity-model)), so a
  reconnected origin signs with the same key and sees its old feeds.

### Permission manifests

A `bzz://` site can declare the capabilities it needs up front in a
`freedom-manifest.json` at its root (at most 8 KiB, no unknown fields):

```json
{
  "schema": "freedom-manifest/1",
  "name": "My App",
  "description": "Optional, up to 160 characters",
  "capabilities": {
    "swarm": {
      "publish": { "why": "Up to 140 characters, shown in the consent sheet" },
      "feeds": { "why": "…" },
      "signing": { "why": "…" },
      "messaging": { "why": "…" }
    }
  }
}
```

`name` is at most 32 characters; at least one capability is required. Freedom
fetches the manifest when the page calls `swarm_requestAccess`, and checks it
before the first non-public method call in each document. The result is
cached per document (the tab plus its committed navigation): later calls in
the same document reuse it, and a manifest redeployed while the page is open
is not re-read until the page reloads or navigates. What a failed fetch (a
network error or a 5xx) does depends on whether the origin already has a
manifest on record:

- **No manifest on record yet** (first contact): the failure is treated as
  "no manifest", and that result is cached for the document like any other.
  `swarm_requestAccess` falls back to the plain connect prompt (a `connect`
  event, no capability grants), and the manifest is not fetched again until
  the page reloads or navigates.
- **A manifest on record**: the call fails with `4900` and the failure is not
  cached in the document, so a later call asks again. Freedom backs off
  between fetches (2 s, then 10 s, 30 s and 60 s), though, and a call inside
  the backoff window fails with `4900` straight away without refetching.

A "Don't allow" on the consent sheet _is_ cached for the document: every later
non-public call, including `swarm_requestAccess`, rejects with `4001` straight
away and no sheet is shown, until the page reloads or navigates. (The one
exception: if the sheet was declined from a call other than
`swarm_requestAccess`, the first `swarm_requestAccess` after it re-checks the
manifest and can show the sheet once more.) The decline is not stored beyond the
document, so a "Connect" button that calls `swarm_requestAccess` again after a
`4001` should tell the user to reload rather than expect a fresh sheet.

When a fetched manifest names capabilities the user has not yet approved,
Freedom shows one consent sheet covering all of them. Approving a capability
grants everything it needs in one step:

| Capability  | Grants                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `publish`   | connection, `autoApprove.publish`                                                              |
| `feeds`     | connection, an app-scoped identity (if the origin has none), feed grant, `autoApprove.feeds`   |
| `signing`   | connection, an app-scoped identity (if the origin has none), feed grant, `autoApprove.signing` |
| `messaging` | connection, messaging grant, `autoApprove.messaging`                                           |

Rejecting the sheet is `4001`. A capability removed from a redeployed
manifest has the grants it created withdrawn, and a manifest that disappears
or becomes invalid withdraws all of them; a wording-only change to `why` does
not re-prompt. If the manifest of an origin that already has one on record
cannot be fetched (a transient failure, retried with backoff), non-public
calls fail with `4900`. Manifests
are read only for `bzz://` origins; other origins use the per-call prompts
above.

## Identity model

Feed and SOC writes are signed with the origin's **active publisher
identity**, which the user picks in the first feeds/signing prompt and can
change in Settings. Three kinds exist (`identityMode`):

| `identityMode`    | Key                                                                                                                                                            | Linkable across origins?                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `app-scoped`      | A dedicated key derived from the user's vault at `m/44'/73406'/{index}'/0/0`, one index per identity                                                           | No                                            |
| `bee-wallet`      | The Swarm node's wallet key                                                                                                                                    | Yes: every origin using it shares the address |
| `ethereum-wallet` | One of the user's Ethereum accounts derived from the vault's recovery phrase (Ledger, phone and Safe accounts cannot be used, since they never hand out a key) | Yes: it is the user's public wallet address   |

- Identities are stored per origin in `swarm-feeds.json` and **survive
  disconnect**. Revoking the connection does not forget the key.
- Each feed stays bound to the identity that created it, even if the origin's
  active identity changes later. `swarm_getSigningIdentity` and
  `swarm_writeSingleOwnerChunk` use the _active_ identity.
- Signing needs the identity vault to be unlocked.
- `swarm_writeSingleOwnerChunk` needs an identity **only this origin uses**:
  an `app-scoped` one whose key index no other origin holds. Under
  `bee-wallet`, `ethereum-wallet` or a shared index it fails with `4100`
  `shared_identity`, and the signing prompt says so. A raw SOC's identifier
  is the page's to choose, so under an owner other sites also sign with, a
  page could write another site's feed entries (`keccak256(topic || index)`).
  Feeds and `swarm_getSigningIdentity` work under every identity, since feed
  topics are namespaced by origin.

Messaging is different: PSS decrypts with the **node's** key, so
`swarm_getMessagingIdentity` always reports `identityMode: 'bee-wallet'`, and
the PSS public key is the same for every origin. GSOC writes are signed with a
key mined from the topic, not with any user identity.

## Origin isolation guarantees

- **Upload tags** (`tagUid` from `swarm_publishFiles`) are recorded against
  the origin that created them for the rest of the session (not persisted).
  `swarm_getUploadStatus` refuses any other origin's tag with `4100
tag_ownership_mismatch`, so a page cannot watch another site's uploads. The
  record is dropped once a status reports `done: true`; asking again after
  that also returns `tag_ownership_mismatch`.
- **Feed topics** are `keccak256("<permission key>/<feed name>")`. Two origins
  using the same feed name get different topics, and `swarm_readFeedEntry`
  `{ name }` always resolves against the _caller's_ origin. To read another
  origin's feed, pass its `topic` and `owner`.
- **`swarm_listFeeds`** returns only the caller's own feeds.
- **Subscriptions** are bound to the subscribing page. They are closed when
  that page navigates to a new document (not on hash or `pushState` routing),
  when the tab closes, or when the origin's grant is revoked, and messages are
  never delivered to a document of a different origin. `swarm_unsubscribe`
  only finds the caller's own subscription ids.
- **Messaging identity** discloses only the first 2 bytes of the node's
  overlay address (`pssTarget`), never the full overlay, which would be a
  cross-origin correlation handle and reveal the node's exact network
  position.
- PSS and GSOC topics are **not** origin-scoped: a topic string names the same
  channel for every app and every Swarm node. Use unguessable topics, or
  encrypt, if that matters.

## Limits

Reported by `swarm_getCapabilities` under `limits`:

| Limit                  | Value           | Applies to                                          |
| ---------------------- | --------------- | --------------------------------------------------- |
| `maxDataBytes`         | 10 MiB          | `swarm_publishData`                                 |
| `maxFilesBytes`        | 50 MiB (total)  | `swarm_publishFiles`                                |
| `maxFileCount`         | 100             | `swarm_publishFiles`                                |
| `maxPathBytes`         | 100 UTF-8 bytes | each `swarm_publishFiles` path                      |
| `maxChunkPayloadBytes` | 4096            | `swarm_publishChunk`, `swarm_writeSingleOwnerChunk` |
| `maxMessageBytes`      | 4000            | `swarm_sendPss`, `swarm_sendGsoc`                   |
| `maxTargetDepth`       | 3 bytes         | `swarm_sendPss` `targets`                           |
| `maxSubscriptions`     | 32 per origin   | `swarm_subscribe`                                   |

Not reported there:

- **Permission-free read budget**, per origin over a fixed 60 s window that
  starts at the first read and resets 60 s later (not a rolling window),
  shared by `swarm_readChunk`, `swarm_readData`, `swarm_readSingleOwnerChunk`,
  `swarm_readFeedEntry` and `swarm_listFeeds`: 600 requests / 5 MiB when the
  origin is connected, 120 requests / 512 KiB when it is not. Exceeding it is
  `-32602 rate_limited`; a read that crosses the byte budget is refused after
  the fact, so its data is not returned. `swarm_readData` is one request
  whatever the blob's size. Its root chunk (up to 4104 bytes) is charged as
  soon as it is read, even if the read is then refused; a blob held in that
  root chunk costs nothing more. A larger blob is charged its size in all,
  reserved before the node joins it, so a blob that would cross the byte
  budget, counting reads started earlier in the same window (including ones
  still in flight), is refused up front and is never downloaded. The
  reservation stands if the join fails. A reservation belongs to the window it
  was made in: when the window resets, a join still running from the old one
  no longer counts, so a page can have more than one window's worth of joins
  in flight at once, but never starts more than one window's worth per
  window. A blob larger than
  the whole byte budget is `data_too_large` instead (see the method).
- **New GSOC topics**: 16 per origin per 60 s (only topics that have to be
  mined count; cached topics are free). Exceeding it is `-32602 rate_limited`
  with `retryAfterMs`.
- **Feed names**: 1–64 UTF-16 code units (JavaScript `string.length`, so
  a character outside the Basic Multilingual Plane, such as most emoji,
  counts as 2), no `/`, no characters below U+0020.
- **Messaging topics**: 1–256 UTF-8 bytes, no control characters.

## Methods

Hex strings are case-insensitive and have no `0x` prefix unless noted
(owners accept an optional `0x`). A _reference_ is 64 hex characters.

### Connection and capabilities

#### `swarm_requestAccess` → `{ connected: true, origin, capabilities: ['publish'] }`

Prompts the user to connect the origin (once). Calling it again when already
connected returns the same shape without a prompt. Rejection: `4001`.

When the origin has no connection yet, what the user sees depends on whether
it serves a [permission manifest](#permission-manifests):

- **No manifest**: the connect prompt. Approving it connects the origin and
  fires the `connect` event.
- **Manifest**: the manifest sheet instead. _Allow all_ connects the origin
  and grants every listed capability, including its auto-approval.
  _Connect, but ask each time_ connects the origin only: no identity, feed
  or messaging grant, no auto-approvals, so each publish, feed write,
  signing or messaging action still prompts as if there were no manifest.
  _Don’t allow_ is `4001`. In both approving cases the call resolves with
  the usual shape, but **no `connect` event fires**: treat the resolved
  promise, not the event, as the signal that the origin is connected, and
  read `swarm_getCapabilities` rather than assuming the manifest's
  capabilities were granted.

#### `swarm_getCapabilities` → capability object (public)

```javascript
{
  specVersion: '1.0',
  canPublish: boolean,          // connected AND node ready to publish
  reason: null | 'not-connected' | 'node-stopped' | 'node-not-ready'
             | 'ultra-light-mode' | 'no-usable-stamps',
  publisherIdentityModes: ['app-scoped', 'bee-wallet', 'ethereum-wallet'],
  features: ['messaging'],
  extensions: { ethereumWalletPublisherIdentity: true, publisherSigning: true },
  limits: { maxDataBytes, maxFilesBytes, maxFileCount, maxPathBytes,
            maxChunkPayloadBytes, maxMessageBytes, maxTargetDepth,
            maxSubscriptions }
}
```

`reason` is `not-connected` whenever the origin is not connected, regardless
of node state.

### Publishing

#### `swarm_publishData { data, contentType, name? }` → `{ reference, bzzUrl }` (publish tier)

Uploads one blob. `contentType` is required (`missing_content_type`). `name`
labels the entry in the user's publish history. `bzzUrl` is
`bzz://<reference>`.

#### `swarm_publishFiles { files, indexDocument? }` → `{ reference, bzzUrl, tagUid }` (publish tier)

Uploads a directory as a manifest. `files` is an array of
`{ path, bytes, contentType? }`, where `bytes` is a `Uint8Array` or
`ArrayBuffer`. Paths are relative (`dir/file.html`): no leading `/`, no `\`,
no empty, `.` or `..` segments, no control characters, unique. `indexDocument`
must be one of the paths. Errors: `empty_files`, `too_many_files`,
`invalid_path`, `duplicate_path` (+ `path`), `invalid_index_document`,
`payload_too_large`.

#### `swarm_getUploadStatus { tagUid }` → tag status (connection tier)

`tagUid` is a positive integer from `swarm_publishFiles`. Returns:

```javascript
{ tagUid, split, seen, stored, sent, synced,
  progress: 0..100,          // sent / split
  done: boolean }            // split > 0 && sent >= split
```

Progress is measured by chunks _sent_, not _synced_, because sync can lag
indefinitely on a light node. Only the origin that created the tag may query
it, and only until it reports `done` (see
[Origin isolation](#origin-isolation-guarantees)).

### Chunks

#### `swarm_publishChunk { data, span?, options? }` → `{ reference }` (publish tier)

Uploads one content-addressed chunk (CAC). `data` is 1–4096 bytes. `span`
defaults to the payload length; pass a non-negative integer (or `BigInt` up
to 2^64−1) to build an intermediate chunk of a larger file. `options` must be
absent or `{}`.

#### `swarm_readChunk { reference, options? }` → `{ data, encoding: 'base64', span }` (public)

Downloads a CAC and verifies that its bytes hash to `reference`. `span` is a
number, or a `BigInt` above `Number.MAX_SAFE_INTEGER`. Errors:
`invalid_reference`, `chunk_not_found`, `chunk_type_mismatch` (the bytes are
not a valid CAC for that address, e.g. it is a SOC), `rate_limited`. This is
the supported route for verified raw chunk reads.

#### `swarm_readData { reference, options? }` → `{ data, encoding: 'base64' }` (public)

Downloads a whole blob, as published by `swarm_publishData` or uploaded to
`/bytes`, by its root reference. The node joins it (`GET /bytes/<ref>`): it
checks every chunk it fetches against its address, recovers erasure-coded
content from parity and falls back to the root chunk's replicas, so the page
needs no tree or coding code of its own. `data` is the blob's bytes, not a
manifest's file: a `bzz://` site reference returns the manifest's own bytes.

Freedom first reads the root chunk, verifies it against `reference` and takes
the blob's size from its span (with the redundancy level cleared from the
span's top byte). A blob larger than the origin's byte budget
([Limits](#limits): 5 MiB connected, 512 KiB not) is refused with
`data_too_large` (`data.limit`, `data.actual` in bytes) before the rest is
downloaded; one that fits the budget but not what is left of the current
window, counting reads started earlier in that window (in flight or not), is
`rate_limited`, also before the download. A join still running when the
window resets is not carried into the next one. Only unencrypted 32-byte references are accepted for now; an
encrypted 64-byte one is `invalid_reference`. Errors: `invalid_reference`,
`chunk_not_found` (the root or a chunk under it), `chunk_type_mismatch` (the
root is not a CAC for that address), `data_too_large`, `rate_limited`. The
page shim allows it 300 s (see [Timeouts](#timeouts)).

#### `swarm_writeSingleOwnerChunk { identifier, data, span?, options? }` → `{ reference, owner, identifier }` (signing tier)

Signs a single-owner chunk with the origin's active publisher identity and
uploads it. `identifier` is 32 bytes of hex. `data` is 1–4096 bytes. `owner`
is the checksummed `0x` signer address; `reference` is the SOC address. The
active identity must be one no other origin uses (an `app-scoped` identity
of its own); otherwise `4100` with `data.reason: 'shared_identity'`.

#### `swarm_readSingleOwnerChunk { address } | { owner, identifier }, options?` → SOC (public)

Pass either the SOC `address`, or `owner` (40 hex, optional `0x`) plus
`identifier`, not both. Returns:

```javascript
{ data, encoding: 'base64', span, reference, owner, identifier, signature }
```

The signature is verified against `reference` before returning. Errors as
`swarm_readChunk`, plus `invalid_owner` and `invalid_identifier`.

### Feeds

A feed is a sequence of entries at indexes `0, 1, 2, …` under a topic, signed
by one owner. Freedom derives the topic from the origin and the feed name (see
[Origin isolation](#origin-isolation-guarantees)) and keeps the feed's
metadata in its feed store.

#### `swarm_createFeed { name }` → `{ feedId, owner, topic, manifestReference, bzzUrl, identityMode }` (feeds tier)

Creates a feed and its feed manifest, signed by the origin's active identity.
`feedId` is `name`. `bzzUrl` (`bzz://<manifestReference>`) always resolves to
the content the feed currently points at. **Idempotent**: if the origin already
has a feed with this name, its stored metadata is returned and nothing is
written.

#### `swarm_updateFeed { feedId, reference }` → `{ feedId, reference, bzzUrl, index }` (feeds tier)

Points the feed at a Swarm `reference` by writing the next entry. Signed with
the identity that created the feed. Errors: `invalid_reference`,
`feed_not_found`.

#### `swarm_writeFeedEntry { name, data, index? }` → `{ index }` (feeds tier)

Writes an arbitrary payload as a feed entry. Without `index`, it is written at
the next free index; with an explicit `index`, an existing entry is never
overwritten (`index_already_exists`). The feed must exist (`feed_not_found`:
call `swarm_createFeed` first). Payloads larger than one chunk are uploaded and
wrapped by the node; one too large for that is `payload_too_large`. Writes to
one feed are serialized, so concurrent writes get distinct indexes.

#### `swarm_readFeedEntry { name | topic, owner?, index? }` → `{ data, encoding: 'base64', index, nextIndex }` (public)

Pass exactly one of:

- `name`: one of the caller's own feeds. `owner` is optional; without it, the
  owner recorded when this origin created the feed is used (`feed_not_found`
  if there is none).
- `topic` (64 hex) and `owner` (required): any feed on Swarm.

Without `index`, returns the latest entry, and `nextIndex` is the index the
next write would use as reported by the node, or `null` if the node did not
report one. With `index`, `nextIndex` is always `index + 1`, whether or not
that slot is taken; it is **not** the next free index (reading index 0 of a
ten-entry feed returns `nextIndex: 1`). To append, use `swarm_writeFeedEntry`
without `index`, or read without `index` first. Errors: `feed_empty` (no entries),
`entry_not_found` (no entry at `index`), `invalid_topic`, `invalid_owner`,
`invalid_feed_name`, `rate_limited`.

#### `swarm_listFeeds` → `[{ name, topic, owner, manifestReference, bzzUrl, createdAt, lastUpdated, lastReference }]` (public)

The caller's own feeds, from Freedom's feed store; `[]` if none. Takes no
params. Works without a connection, including after the user disconnected the
origin (feed records are kept).

### Signing identity

#### `swarm_getSigningIdentity` → `{ owner, identityMode }` (signing tier)

The address (`owner`, checksummed with `0x`) that `swarm_writeSingleOwnerChunk`
and newly created feeds will be signed with, and its kind. Does not need the
node to be running. This is the way to obtain the signing grant before the
first write.

### Messaging

PSS sends an encrypted message to one node; GSOC is a broadcast room that
anyone who knows the topic can write to and subscribe to. Both need the
messaging grant (see [Permission tiers](#permission-tiers)) and are ephemeral:
they spend postage like any write.

#### `swarm_getMessagingIdentity` → `{ pssPublicKey, pssTarget, identityMode: 'bee-wallet' }` (messaging tier)

`pssPublicKey` is the node's compressed secp256k1 key (66 hex) that peers
encrypt to; `pssTarget` is the 2-byte (4 hex) overlay prefix they send
toward. Share both with a correspondent so they can `swarm_sendPss` to you.

#### `swarm_sendPss { topic, recipient, targets, data, options? }` → `{ sent: true }` (messaging tier, prompts per send)

- `topic`: the channel string (hashed on the wire).
- `recipient`: the peer's `pssPublicKey` (66 hex starting `02` or `03`, optional `0x`).
- `targets`: the peer's `pssTarget`, 2–3 whole bytes of hex.
- `data`: 0–4000 bytes (an empty message is allowed).

Errors: `invalid_topic`, `invalid_recipient`, `invalid_target`,
`payload_too_large`.

#### `swarm_sendGsoc { topic, data, options? }` → `{ sent: true, address }` (messaging tier, prompts per send)

Broadcasts `data` (1–4000 bytes; empty is `invalid_payload`) to the topic's
room. `address` is the room's GSOC address, the same one `swarm_subscribe`
reports as `key`. Sending to a raw `address` is refused (`invalid_address`):
the signing key is mined from the topic, so the topic is required. The first
use of a topic mines its key (typically well under a second, up to 15 s);
see the new-topic limit under [Limits](#limits).

#### `swarm_subscribe { kind, topic | address, options? }` → `{ subscriptionId, kind, key }` (messaging tier)

Opens a long-lived subscription; messages arrive as `message` events.

- `kind: 'gsoc'` with either `topic` or a 64-hex `address` (not both).
- `kind: 'pss'` with `topic` (`address` is refused); receives PSS messages
  addressed to this node.

`key` is the GSOC address or the PSS topic hash. Several subscriptions to the
same `kind`/`key`, from any origins, share one node connection. Resolves
once the node accepts the subscription (bounded at 30 s). Errors:
`invalid_kind`, `invalid_topic`, `invalid_address`, `too_many_subscriptions`
(`-32602`, 32 per origin); `establish_timeout`, `node_subscription_limit`,
`subscription_cancelled` (`4900`, retryable). See
[Origin isolation](#origin-isolation-guarantees) for when subscriptions end on
their own.

#### `swarm_unsubscribe { subscriptionId }` → `{ unsubscribed: true }` (connection tier, never prompts)

Closes one of the caller's subscriptions. `subscription_not_found` if the id
is unknown or not the caller's.

## Events

| Event        | Payload      | When                                                                 |
| ------------ | ------------ | -------------------------------------------------------------------- |
| `connect`    | `{ origin }` | The user approved the connect prompt (not the manifest sheet)        |
| `disconnect` | `{ origin }` | The user disconnected the origin; sent to the page in the active tab |
| `message`    | see below    | A subscribed message arrived                                         |

```javascript
{
  type: 'swarm_subscription',
  subscription: subscriptionId,
  result: { kind: 'gsoc' | 'pss', key, data /* base64 */, encoding: 'base64',
            receivedAt /* ms since epoch */ }
}
```

`connect` is not emitted when the origin was already connected, nor when the
connection came from approving the [manifest sheet](#permission-manifests). `disconnect`
goes to whatever page is in the active tab, so compare `data.origin` with your
own; it is not emitted when only one tier is revoked (e.g. messaging in
Settings) or when a manifest change withdraws a grant. Do not treat the events as the only source of truth: a call
failing with `4100` means the grant is gone.

## Example

```javascript
if (!window.swarm?.isFreedomBrowser) throw new Error('Open this app in Freedom');

const caps = await window.swarm.getCapabilities();
await window.swarm.requestAccess(); // prompt once

const { bzzUrl } = await window.swarm.publishData({
  data: '<h1>Hello</h1>',
  contentType: 'text/html',
});

await window.swarm.createFeed({ name: 'notes' }); // grants the feed tier
const { index } = await window.swarm.writeFeedEntry({ name: 'notes', data: 'first' });
const entry = await window.swarm.readFeedEntry({ name: 'notes' });
console.log(atob(entry.data)); // "first"

window.swarm.on('message', ({ subscription, result }) => {
  /* … */
});
await window.swarm.subscribe({ kind: 'gsoc', topic: 'my-app/lobby' });
await window.swarm.sendGsoc({ topic: 'my-app/lobby', data: 'hi' });
```
