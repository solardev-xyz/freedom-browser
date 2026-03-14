# Swarm Publishing Research

Date: 2026-03-13

This note studies the current "Unified Identity & Wallet" branch and how it can grow into first-class Swarm publishing inside Freedom Browser.

## Executive Summary

The branch already gives us most of the hard prerequisites:

- a deterministic Bee identity derived from the vault mnemonic
- a local Bee node with a stable API URL routed through the service registry
- a built-in wallet that already understands Gnosis Chain, xDAI, and xBZZ
- a sidebar UI that already exposes the Bee wallet, postage-stamp placeholders, and an "Upgrade to Light Node" CTA
- first-class `bzz://` browsing and ENS-to-Swarm resolution

The main blocker is node mode. Freedom currently runs Bee in an ultra-light / DHT-client-style configuration. That is good for browsing, but Bee's upload and postage workflows are only available on light and full nodes. In practice, Swarm publishing should start with a Bee light-node upgrade path, then add batch management, then add file/site uploads, then add feed-backed mutable publishing.

The other major design point is identity separation. The docs are explicit that feed publishers should use dedicated private keys, not the Bee node key and not a real funded wallet. The current branch does not derive dedicated Swarm publisher keys yet, so that should be added before we ship feed-based publishing.

## What This Branch Already Gives Us

### Identity and wallet foundations

- `src/main/identity-manager.js` already derives and injects a dedicated Bee wallet at `m/44'/60'/0'/0/1`.
- `src/main/identity/injection.js` writes Bee's `keys/swarm.key` keystore and `config.yaml`.
- `src/main/identity/derivation.js` already has a clean place to add more deterministic secp256k1 identities if we want dedicated Swarm publisher keys later.
- `src/main/wallet/transaction-service.js` already signs and broadcasts EVM transactions, so funding the Bee wallet with xDAI/xBZZ can reuse existing wallet infrastructure.
- `src/main/wallet/chains.js` and `src/shared/tokens.json` already know about Gnosis Chain, xBZZ, and the postage-stamp contract address.

### Bee integration foundations

- `src/main/bee-manager.js` already owns Bee lifecycle, config writing, port management, and health checks.
- `src/main/service-registry.js` already centralizes the Bee API URL, which is ideal for a future `SwarmPublishingService`.
- `src/main/request-rewriter.js` already makes `bzz://` URLs first-class and keeps navigation inside a Swarm manifest/hash context.
- README.md already documents Freedom's current browsing-oriented Swarm setup and explicitly describes it as ultra-light / DHT-client style.

### UI foundations

- `src/renderer/index.html` already has a Swarm node card with:
  - Bee wallet display
  - xDAI and xBZZ balance slots
  - postage-stamp count and summary
  - an "Upgrade to Light Node" CTA with the hint "Enable uploads and publishing"
- `src/renderer/lib/wallet/node-status.js` already contains placeholder logic for:
  - sending xDAI/xBZZ to the node wallet
  - warning when there are no postage stamps
  - buying stamps
  - upgrading to a light node

One important detail: those Swarm balance/stamp helpers in `src/renderer/lib/wallet/node-status.js` are currently not wired to any backend fetch path yet, and the action handlers are still TODO placeholders. So the UI shell is there, but the publishing backend does not exist yet.

## Key Findings From Swarm Docs

### 1. Freedom's current Bee mode is good for browsing, not publishing

The Bee JavaScript SDK docs show that upload APIs are not available on ultra-light nodes, but are available on light and full nodes. The Swarm node-type docs also make it clear that light nodes are the practical entry point for uploads, while full nodes are mainly needed for heavier network participation.

This matches the local code:

- `src/main/bee-manager.js` writes a config with `swap-enable: false`, `full-node: false`, and no blockchain RPC endpoint.
- README.md describes the current Bee mode as ultra-light / DHT client.

Conclusion: the first real Swarm publishing milestone is not "add upload UI". It is "teach Freedom how to run Bee as a light node when the user opts in."

Relevant sources:

- [bee-js SDK overview](https://bee-js.ethswarm.org/docs/sdk-overview/)
- [Swarm node types](https://docs.ethswarm.org/docs/bee/working-with-bee/node-modes/)
- [Swarm quickstart](https://docs.ethswarm.org/docs/quickstart/)

### 2. `bee-js` is a strong fit for Freedom's privileged main-process model

The bee-js docs cover the full publishing surface we will need:

- upload data/files/collections
- track upload tags
- buy and inspect postage batches
- pin and reupload pinned references
- create and update feeds
- create feed manifests
- ACT for private access later

Freedom already routes sensitive wallet operations through main-process IPC rather than exposing them directly to content. Swarm publishing should follow the same pattern:

- main process owns Bee client creation
- renderer sends privileged publish requests over IPC
- signing keys never leave the vault boundary
- webviews do not get raw publish powers

Conclusion: use `@ethersphere/bee-js` in the main process, not ad hoc fetches from renderer code for the core publish path.

Relevant source:

- [bee-js docs](https://bee-js.ethswarm.org/docs/)

### 3. There are two distinct publishing paths: immutable uploads and mutable feeds

Swarm's core upload model is immutable:

- upload bytes or files
- get back a content reference
- browse it directly via `bzz://<reference>`

For mutable publishing, the recommended pattern is:

1. upload new immutable content
2. publish the new reference into a feed
3. expose the feed through a feed manifest so it resolves like normal Swarm content

This is a very good fit for Freedom:

- immutable publish is the simplest MVP
- feed-backed publish gives us stable URLs for sites/blogs/homepages
- Freedom already resolves `bzz://` and ENS content hashes, so feed manifests naturally fit the browsing model we already have

Relevant sources:

- [Upload and download data](https://bee-js.ethswarm.org/docs/upload-download-data/)
- [SOC and feeds](https://bee-js.ethswarm.org/docs/soc-and-feeds/)
- [Host your website on Swarm](https://docs.ethswarm.org/docs/develop/access-the-swarm/host-your-website/)

### 4. Feed publishers should use dedicated keys, not the Bee wallet or the user's funded wallet

This was the single most important design note in the docs.

The bee-js feed guide explicitly recommends using dedicated publisher private keys for feeds instead of:

- the Bee node's private key
- a "real wallet" private key with funds

That matters a lot for this branch. Right now we have:

- `userWallet` for the main EVM wallet
- `beeWallet` for the Bee node wallet
- extra user wallets for normal EVM accounts

What we do **not** have yet is a dedicated Swarm publisher identity namespace.

Conclusion: before shipping feed-based publishing, Freedom should derive one or more dedicated Swarm publisher keys from the vault mnemonic on a new documented path. These keys can remain unfunded; the Bee node handles postage usage while the feed key only signs feed updates.

This is a much cleaner security model than reusing the Bee wallet or the active user wallet.

Relevant source:

- [SOC and feeds](https://bee-js.ethswarm.org/docs/soc-and-feeds/)

### 5. Postage-batch management is a first-class product feature, not a backend detail

Publishing on Swarm requires a usable postage batch. The docs show batch-management concepts we should surface to users:

- batch usability
- remaining size
- duration
- mutability / immutability
- top-up / dilution style operations
- storage-cost estimation

The quickstart docs also describe the light-node prerequisites in concrete economic terms: some xBZZ for storage and some xDAI for chain operations. That lines up with the existing sidebar idea of showing the Bee node wallet's xDAI/xBZZ balances.

Conclusion: "buy stamps" should be treated as a core wallet/node flow, not as a hidden implementation step. The current sidebar already points in the right direction.

Relevant sources:

- [Buying storage](https://bee-js.ethswarm.org/docs/buying-storage/)
- [Swarm quickstart](https://docs.ethswarm.org/docs/quickstart/)

### 6. Upload progress and deferred uploads need explicit UX

The Bee API docs and bee-js docs both emphasize upload tags and deferred upload behavior.

Important practical implications:

- tags are the right primitive for progress reporting
- deferred uploads return quickly, before the full sync story is done
- for user-facing publishing, `deferred: false` is safer unless we intentionally build around tag polling and "still syncing" states

Conclusion:

- small uploads should probably default to `deferred: false`
- large uploads and website uploads should create a tag and show progress explicitly
- the app should persist recent publish jobs with tag IDs, refs, timestamps, and status

Relevant sources:

- [Track upload status](https://docs.ethswarm.org/api/#tag/Tag)
- [Upload and download data](https://bee-js.ethswarm.org/docs/upload-download-data/)

### 7. Site publishing is a manifest problem as much as an upload problem

Swarm site hosting is not just "upload a folder". Manifests and routing matter:

- `indexDocument` and `errorDocument` should be set for website-style uploads
- path routing lives inside the manifest / virtual filesystem model
- feed manifests can point a stable entrypoint at the latest site version

This suggests a staged Freedom UX:

- first: publish file / publish folder
- next: publish website with `index.html` + optional 404 page
- later: manifest-aware editing and feed-backed updates

Relevant sources:

- [Host your website on Swarm](https://docs.ethswarm.org/docs/develop/access-the-swarm/host-your-website/)
- [Manifests: a virtual filesystem](https://docs.ethswarm.org/docs/develop/manifests/)
- [Website routing on Swarm](https://docs.ethswarm.org/docs/develop/routing/)

### 8. Pinning is useful, but it is not the same thing as network durability

The bee-js pinning docs are useful for a Freedom-specific durability story:

- pinning keeps content locally retained by the user's Bee node
- `isReferenceRetrievable` can check network availability
- `reuploadPinnedData` can help recover availability if needed

That is valuable because Freedom is already a local-node browser. A good first durability model is:

- default to `pin: true` for user-published content
- show whether published refs are locally pinned
- later add a background stewardship pass for pinned user content

But we should not oversell pinning as permanent availability by itself.

Relevant source:

- [Pinning files](https://bee-js.ethswarm.org/docs/pinning-files/)

### 9. ACT is a real future direction, but not a v1 requirement

bee-js already exposes ACT (Access Control Toolkit) flows for private / grant-based access. That is interesting for future private sharing inside Freedom, especially because the branch already has a vault and identity layer.

I would not use ACT to scope the first publishing milestone. It belongs after basic light-node publishing, feed updates, and website hosting are working.

Relevant source:

- [Access control](https://bee-js.ethswarm.org/docs/access-control/)

## Capability Map

| Capability | Bee / bee-js surface | Why it matters for Freedom |
| --- | --- | --- |
| Publish raw content | `/bytes`, `uploadData` | Good MVP for notes, JSON, exports, and editor-created content |
| Publish file or website | `/bzz`, `uploadFile`, `uploadFiles`, `uploadCollection`, `uploadFilesFromDirectory` | Main user-facing publish flow |
| Track progress | tags, `createTag`, `retrieveTag` | Needed for large uploads and clear UX |
| Manage storage | stamps / postage batches, `buyStorage`, `getAllPostageBatch`, extensions | Required before uploads work reliably |
| Mutable publishing | SOC + feeds, `makeFeedWriter`, `createFeedManifest` | Stable URLs, site updates, ENS integration |
| Local durability | pinning, `pin`, `getAllPins`, `isReferenceRetrievable`, `reuploadPinnedData` | Better retention story for local publishers |
| Private publishing later | ACT | Future premium / private-sharing direction |

## Recommended Architecture For Freedom

### 1. Add a main-process `SwarmPublishingService`

Suggested location:

- `src/main/swarm-publishing/`

Suggested responsibilities:

- create Bee client instances from the service registry's active Bee API URL
- expose privileged IPC for publish operations
- own tag polling and recent-publish job tracking
- own batch discovery / selection logic
- own feed signing and feed-manifest creation
- own pinning / retrievability checks

This follows the architecture Freedom already uses for:

- wallet signing
- node lifecycle
- request rewriting
- other privileged network actions

### 2. Keep the renderer trusted, but do not make it the authority

The trusted Freedom renderer can initiate uploads, but the main process should remain the authority for:

- selecting which Bee node URL is active
- accessing wallet-derived signing keys
- batch selection and funding-sensitive actions
- filesystem-heavy directory publishing
- feed publisher key usage

That also avoids accidentally exposing publishing powers to arbitrary web content.

### 3. Split Swarm identities by role

Recommended identity roles:

- Bee node wallet
  - holds xDAI/xBZZ
  - buys and spends postage batches
  - remains separate from the user's browsing wallet
- User wallet(s)
  - general-purpose EVM wallet and dApp accounts
- Swarm publisher key(s)
  - dedicated secp256k1 identities only for SOC/feed signing
  - ideally one key per feed/site/project, or at least a dedicated publishing namespace

This is the cleanest model and matches the docs' advice.

### 4. Start with light nodes, not full nodes

For Freedom's first publishing release, Bee light mode looks like the right tradeoff:

- unlocks uploads and postage workflows
- keeps resource demands lower than full-node mode
- matches the existing UI copy about "Upgrade to Light Node"

Full-node support can stay a later option for advanced users.

### 5. Use opinionated upload defaults

Suggested initial defaults:

- simple content uploads:
  - `pin: true`
  - `deferred: false`
- website / directory uploads:
  - create a tag first
  - `pin: true`
  - explicit progress UI
  - set `indexDocument`
  - set `errorDocument` when provided

These defaults are more product-friendly than exposing every Bee knob immediately.

## Permissioned Swarm Publishing For Pages

The team idea makes a lot of sense: pages opened in Freedom should be able to ask for permission to publish through the user's local Swarm node. That would unlock important app categories:

- website builders running on Swarm
- decentralized forums and social apps
- publishing tools for blogs, portfolios, and storefronts
- apps that let users post media, replies, comments, or profile updates directly to Swarm

I think this fits the existing research very well, but it strengthens one conclusion:

- Freedom should expose a permissioned Swarm provider to pages
- Freedom should **not** expose raw Bee HTTP access or the full raw `bee-js` surface directly

### Why this should be a provider, not raw Bee access

Exposing raw Bee or the raw local Bee API URL would give pages too much power and too little structure. A page could otherwise:

- spend the user's storage capacity without clear UX
- trigger uploads with confusing deferred/sync behavior
- probe local node behavior too freely
- depend on Bee implementation details Freedom may later want to hide
- nudge us toward leaking too much about keys, batches, or node configuration

The better model is the same one this branch already uses for Ethereum:

- the page gets an injected browser API
- the API talks to the main process over IPC
- the main process talks to Bee and uses vault-derived keys when needed
- Freedom decides which operations are allowed, how consent works, and what gets revealed

Conceptually this should look much more like `window.ethereum` than `window.bee`.

### Recommended shape: `window.swarm` or `window.freedomSwarm`

I would expose a small request-based provider rather than a raw SDK clone.

Example capability areas:

- connection and capability discovery
- immutable publishing
- website / directory publishing
- upload-status tracking
- feed-based mutable publishing
- optional pinning and retrievability helpers later

Example method families:

- `swarm_requestAccess`
- `swarm_getCapabilities`
- `swarm_publishData`
- `swarm_publishFiles`
- `swarm_publishSite`
- `swarm_getUploadStatus`
- `swarm_createFeed`
- `swarm_updateFeed`
- `swarm_resolveFeed`
- maybe later `swarm_pin`, `swarm_checkRetrievability`

This should be a Freedom-defined API, even if some method names and payloads borrow ideas from bee-js. The browser needs room to:

- normalize UX
- hide Bee-specific transport quirks
- gate features by node mode
- evolve implementation details without breaking pages

### How it fits the architecture already described above

This idea plugs directly into the branch's existing patterns:

- a page-level injected provider, similar to the wallet provider bridge
- origin-based permission storage, similar to dApp wallet permissions
- main-process IPC handlers for all privileged operations
- vault-derived identities managed centrally in the identity manager
- service-registry based resolution of the active local Bee endpoint

In other words, the right stack looks like this:

1. page calls `window.swarm`
2. renderer bridge validates origin and forwards the request
3. main-process `SwarmPublishingService` enforces permissions and policy
4. service talks to Bee via bee-js
5. Freedom returns a normalized result to the page

That is much safer than letting the page talk to `http://127.0.0.1:1633` directly.

### Permissions should be more granular than wallet connect

This is more sensitive than a typical wallet connection because it can consume:

- xBZZ postage capacity
- xDAI for chain operations related to storage management
- local disk
- bandwidth
- node resources

So I would not use a single "allow publishing" permission. I would split permissions aggressively.

Suggested permission buckets:

- connect/read capability
  - lets a page detect that Swarm publishing is available
- immutable publish capability
  - lets a page publish data/files using approved storage
- mutable publish capability
  - lets a page create/update feeds
- pinning capability
  - lets a page request local retention
- identity capability
  - lets a page use an app-scoped Swarm publisher identity
- storage-management capability
  - batch inspection only, or batch management if we ever allow it

I would keep some actions out of page control, at least initially:

- switching Bee to light mode
- buying or extending postage batches with spend implications
- direct access to the Bee wallet or its private key
- unrestricted arbitrary Bee API calls

Pages should publish against capacity the user has already enabled, not freely spend funds by default.

### App-scoped publisher identities are probably the right model

This idea sharpens an earlier research finding: feed publishing should not reuse:

- the Bee node key
- the user's main wallet key

If pages can publish mutable content, Freedom should derive dedicated Swarm publisher keys and keep them internal. I think the cleanest long-term model is app-scoped publisher identities, for example:

- one identity per origin
- or one identity per origin plus logical project/feed

That would let a Swarm-native website builder or social app get a stable publishing identity without touching the user's funded wallet and without sharing the same feed signer across unrelated apps.

This has nice product properties too:

- the user can revoke one app without affecting another
- Freedom can show "this site is publishing as identity X"
- feed history becomes easier to reason about per app

### Good defaults for the first third-party publishing version

If we build this provider, I would keep the first version intentionally narrow.

Allowed early:

- publish text / blobs
- publish files
- publish website bundles
- query upload progress
- create or update a feed through a dedicated app-scoped identity

Deferred until later:

- raw batch lifecycle operations
- arbitrary Bee RPC passthrough
- ACT/private-sharing APIs
- unrestricted pin management
- deep manifest editing from third-party pages

That would still be enough for the use cases the team is imagining, while keeping Freedom's threat model understandable.

### UX implications

This would need explicit browser UX, not just a hidden API.

Suggested approval surfaces:

- connection prompt
- first publish prompt
- feed creation/update prompt
- optional recurring approval for a trusted app
- publish activity history per origin

The approval should tell the user things like:

- what kind of content the page wants to publish
- whether the action is immutable or feed-based
- whether it may consume existing postage capacity
- whether the page wants a persistent app-scoped publishing identity

Over time, Freedom could add quotas and policy controls such as:

- max upload size per origin
- whether pinning is allowed
- whether feed updates are auto-approved
- whether the app may reuse an existing identity or gets a new one

### Security and abuse considerations

This is powerful functionality, so a few guardrails feel essential:

- no raw loopback Bee endpoint exposure to pages
- strict origin validation, matching the wallet provider model
- per-origin permissions with durable storage and revocation UI
- per-action confirmation for sensitive actions, especially feed creation
- size limits and type-aware validation on uploads
- no direct exposure of private keys, batch private details, or sensitive node config
- explicit handling for `bzz://`, `ipfs://`, ENS-resolved pages, and origin normalization

One subtle point: a Swarm page should not automatically get special publishing trust just because it is already loaded from Swarm. The permission model should stay origin-based and explicit.

### How this changes the roadmap

This does not replace the earlier roadmap. It adds a second surface on top of the same foundation.

Updated mental model:

1. internal node foundation
   - light mode
   - funding
   - postage batches
   - internal `SwarmPublishingService`
2. minimal first-party utility surface
   - verify publishing works
   - publish file/site as a fallback
   - inspect refs, tags, and identities
3. third-party page publishing API
   - injected provider
   - permissions
   - app-scoped publisher identities

That ordering matters. If we try to build the web-facing provider before the internal publishing service and the storage/funding model are solid, we will end up exposing unstable internals too early.

### Concrete follow-up work to add to the implementation plan

- design a provider surface for `window.swarm`
- add a `swarm-permissions` store parallel to dApp wallet permissions
- define an origin normalization model for HTTP(S), `bzz://`, `ipfs://`, and ENS-backed content
- extend identity derivation with app-scoped or publisher-scoped Swarm signer keys
- implement a main-process `SwarmPublishingService` before any page API
- decide which results pages get back:
  - references
  - feed manifests
  - gateway URLs
  - tag IDs
  - publishing identity metadata
- design browser UX for grants, revocation, quotas, and activity history

This is one of the more compelling long-term features in the whole branch direction. It turns Freedom from "a browser with a local Swarm node" into "a browser that lets Swarm apps publish through the user's own node in a permissioned way."

## Concrete Product Roadmap

Roadmap principle:

- Freedom should own trusted Swarm primitives: node mode, funding, batches, identities, permissions, and publish capabilities.
- Dweb apps should own rich publishing workflows: site builders, post editors, social publishing UX, media composition, and app-specific content models.

### Milestone 0: Light-node enablement

Goal: make Bee capable of publishing at all.

Tasks:

- extend `src/main/bee-manager.js` to support a light-node config path
- add settings for opting into light mode
- decide how Bee gets a Gnosis RPC endpoint
- detect and display current Bee mode clearly in the sidebar
- make the existing "Upgrade to Light Node" CTA real

Open technical question:

- Bee seems to want a single blockchain RPC endpoint, while Freedom's wallet stack currently prefers fallback/multi-provider resolution. We need a clean "primary Gnosis RPC for Bee" strategy.

### Milestone 1: Node funding and postage-batch management

Goal: make the Bee node economically ready to publish.

Tasks:

- show Bee wallet xDAI/xBZZ balances from real Bee / batch data
- wire the existing "Send xDAI" and "Send xBZZ" actions to the wallet send flow
- list postage batches with usable / remaining / duration / mutable flags
- add "Buy Stamps" using bee-js storage helpers
- support extension / dilution operations later if needed

This is where the current wallet branch already helps a lot.

### WP2 UI State Spec: Node Mode vs Publish Readiness

The first manual light-mode smoke test surfaced an important product distinction:

- `light mode enabled` is not the same thing as `light node ready`
- an unfunded light node should be treated as blocked on initialization, not as a healthy publish-capable node
- `ultra-light` remains the right unfunded browsing mode

In practice, Freedom should model two separate concepts in the UI:

- node mode
  - `Ultra-light`
  - `Light`
  - `Full` later if we ever support it
- publish readiness
  - `Browsing only`
  - `Initializing`
  - `Funding required`
  - `No usable stamps`
  - `Ready to publish`
  - `Error`

This split matters because a user can intentionally opt into light mode and still be blocked by chequebook deployment, missing xDAI, missing xBZZ, sync delay, or lack of a usable postage batch.

#### Recommended state model

Suggested high-level states for the Swarm node card:

1. Ultra-light ready
   - mode badge: `Ultra-light`
   - readiness badge: `Browsing only`
   - explanation: browsing works, uploads do not
   - primary CTA: `Upgrade to Light Node`

2. Light requested / starting
   - mode badge: `Light`
   - readiness badge: `Initializing`
   - explanation: connecting to chain backend, deploying chequebook, or syncing startup state
   - primary CTA: none, show progress copy instead

3. Light blocked on funding
   - mode badge: `Light`
   - readiness badge: `Funding required`
   - explanation: Bee needs xDAI to complete chequebook deployment
   - primary CTA: `Fund Node`
   - secondary CTA: `Back to Ultra-light` if the user only wants browsing

4. Light funded but no usable batch
   - mode badge: `Light`
   - readiness badge: `No usable stamps`
   - explanation: the node can participate, but publishing is not yet enabled
   - primary CTA: `Buy Stamps`
   - secondary CTA: `Fund Node` if xBZZ or xDAI is still missing

5. Light publish-capable
   - mode badge: `Light`
   - readiness badge: `Ready to publish`
   - explanation: node is chain-connected and has at least one usable batch
   - primary CTA: none on the node card itself

6. Error / degraded
   - mode badge: actual configured mode when known
   - readiness badge: `Error`
   - explanation: RPC unreachable, Bee stopped, health check failed, or another startup failure
   - primary CTA: context-specific retry or troubleshooting action

#### What the browser should avoid

Freedom should avoid implying any of the following:

- that `Light` automatically means uploads will work
- that zero peers in early light-mode startup necessarily means the RPC is broken
- that an unfunded light node is equivalent to ultra-light browsing

The logs from manual testing suggest the more accurate interpretation is:

- Bee successfully connects to the blockchain backend
- Bee then tries to deploy the chequebook
- without the required xDAI, Bee cannot complete light-node initialization
- therefore the node should be shown as `Funding required`, not `Ready`

#### Recommended card layout and copy direction

The current node card already has the right rough pieces. I would evolve it toward:

- mode badge
  - answers: what kind of Bee node is configured?
- readiness badge
  - answers: can this node publish right now?
- balance row
  - xDAI
  - xBZZ
- storage row
  - usable batch count
  - concise batch summary, for example `0 usable batches` or `1 usable batch, 8.4 GB remaining`
- primary CTA area
  - one dominant next action based on readiness state
- optional secondary action
  - for example `Back to Ultra-light`, `Open funding flow`, or `View stamps`

This gives the user a simple mental model:

- mode says what the node is
- readiness says what the node can do
- CTA says what to do next

#### Proposed CTA mapping

Suggested single primary CTA by state:

- `Browsing only` -> `Upgrade to Light Node`
- `Initializing` -> no CTA, show status text
- `Funding required` -> `Fund Node`
- `No usable stamps` -> `Buy Stamps`
- `Ready to publish` -> no setup CTA
- `Error` -> `Retry` or `Troubleshoot`

Suggested secondary actions:

- when `Funding required`
  - `Send xDAI`
  - `Back to Ultra-light`
- when `No usable stamps`
  - `Send xBZZ`
  - `Fund Node`
- when `Ready to publish`
  - `View Batches`

#### Minimum status detail Freedom should expose in WP2

Even before we add a rich publishing UI, the node card should be able to answer:

- is Bee in ultra-light or light mode?
- is Bee connected to the blockchain backend?
- is the chequebook deployed yet?
- is the node blocked on missing xDAI?
- how much xDAI is in the Bee wallet?
- how much xBZZ is in the Bee wallet?
- does the node have at least one usable postage batch?

If we cannot yet answer all of those from stable Bee endpoints, the UI should stay conservative and prefer:

- `Initializing`
- `Funding required`
- `No usable stamps`

over incorrectly saying `Ready to publish`.

#### Product implication for Work Package 2

Work Package 2 should not be framed as only:

- funding the node
- buying stamps

It should also deliver a clean readiness model so users understand where they are in the path:

1. upgrade to light mode
2. fund the Bee wallet
3. let Bee finish chequebook / chain setup
4. buy or select a usable postage batch
5. reach `Ready to publish`

That state machine is part of the product, not just backend plumbing.

### Live API Investigation (2026-03-14)

The WP2 UI state spec was originally designed around the assumption that Bee's HTTP API would provide enough diagnostic information to classify the node's publish-readiness state at runtime. Live testing of the actual Bee node (v2.7.0) running inside Freedom revealed that this assumption is only partially correct. The findings below revise the detection strategy and the upgrade flow.

#### Bee API availability tiers

Live queries against the local Bee node show that endpoints fall into three distinct availability tiers:

**Tier 1 — Always available** (as soon as Bee's HTTP server starts):

| Endpoint | What it returns |
| --- | --- |
| `GET /health` | `{ status, version, apiVersion }` |
| `GET /node` | `{ beeMode, chequebookEnabled, swapEnabled }` |
| `GET /readiness` | `200 { status: "ready" }` or `400 { status: "notReady" }` |
| `GET /addresses` | `{ overlay, underlay, ethereum, publicKey, pssPublicKey }` |

These endpoints work in every mode and every lifecycle phase. They are the only reliable signals during early light-node initialization.

**Tier 2 — Available after chequebook deployment and postage sync:**

| Endpoint | What it returns when available |
| --- | --- |
| `GET /wallet` | `{ nativeTokenBalance, bzzBalance, chequebookContractAddress, walletAddress }` |
| `GET /chequebook/address` | `{ chequebookAddress }` |
| `GET /chequebook/balance` | `{ totalBalance, availableBalance }` |
| `GET /stamps` | `{ stamps: [{ batchID, usable, ... }] }` |
| `GET /status` | `{ beeMode, connectedPeers, lastSyncedBlock, ... }` |

When Bee is in light mode but has not yet deployed its chequebook (typically because the wallet has no xDAI), **all Tier 2 endpoints return `503 "Node is syncing. This endpoint is unavailable."`**. This 503 state persists indefinitely until the chequebook is deployed. It is not a transient startup delay.

**Tier 3 — Feature-gated** (return 403/405 when the feature is disabled):

In ultra-light mode, chain-dependent endpoints return clean rejection codes:

| Endpoint | Ultra-light response |
| --- | --- |
| `GET /wallet` | `403 "Swap is disabled"` |
| `GET /chequebook/balance` | `405 "chain disabled"` |
| `GET /stamps` | `403 "Chain is disabled"` |

These are intentional "feature off" signals, not errors.

#### Observed responses by mode

**Ultra-light mode (confirmed live):**

- `/health` → `200`, status OK
- `/node` → `200`, `beeMode: "ultra-light"`, `swapEnabled: false`
- `/readiness` → `200`, `status: "ready"`
- `/addresses` → `200`, returns `ethereum` address
- `/wallet` → `403` (swap disabled)
- `/chequebook/address` → `200`, `chequebookAddress: "0x0000000000000000000000000000000000000000"`
- `/chequebook/balance` → `405` (chain disabled)
- `/stamps` → `403` (chain disabled)
- `/status` → `200`, full data including `connectedPeers: 94`

**Light mode, unfunded (confirmed live):**

- `/health` → `200`, status OK
- `/node` → `200`, `beeMode: "light"`, `swapEnabled: true`
- `/readiness` → `400`, `status: "notReady"` — **no `message` or `reasons` field**
- `/addresses` → `200`, returns `ethereum` address (Tier 1, always works)
- `/wallet` → **`503`** "Node is syncing"
- `/chequebook/address` → **`503`** "Node is syncing"
- `/chequebook/balance` → **`503`** "Node is syncing"
- `/stamps` → **`503`** "Node is syncing"
- `/status` → **`503`** "Node is syncing"

**Direct chain query (confirmed live):**

- `eth_getBalance` against `https://rpc.gnosischain.com` for the Bee wallet address → `0x0` (zero xDAI)

#### Why the original runtime detection strategy does not work

The WP2 spec assumed that when Bee is running in light mode but blocked on funding, the API would return enough data to classify the state. Specifically, it assumed:

- `/readiness` would include a `message` or `reasons` field explaining why the node is not ready
- `/wallet` would return `nativeTokenBalance: "0"` indicating no xDAI
- `/chequebook/address` would return an empty or zero address indicating no chequebook

In practice, none of this is true during the funding-blocked state. `/readiness` returns only `{ status: "notReady" }` with no diagnostic information. All Tier 2 endpoints are completely unavailable (503). The Bee API makes "temporarily syncing" and "permanently blocked on funding" indistinguishable from each other.

The initial implementation worked around this by parsing Bee's stdout for the log message `"cannot continue until there is at least min xDAI (for Gas) available on address"`. This works but is brittle — it depends on a specific log format that could change across Bee versions and is not a stable API contract.

#### Revised design: gate the upgrade instead of detecting failure after the fact

The better approach is to prevent the user from entering the unfunded-light-mode state in the first place. Instead of switching to light mode and then trying to diagnose why it is stuck, Freedom should verify funding prerequisites **before** allowing the mode switch.

The upgrade gate logic:

1. Query `GET /chequebook/address` — if it returns a non-zero address, a chequebook has already been deployed (possibly in a previous session or by an external tool). Proceed with the switch regardless of xDAI balance.
2. If the chequebook address is zero (`0x000...000`), query `GET /addresses` to get the Bee wallet's Ethereum address.
3. Query `eth_getBalance` against the Gnosis Chain RPC for that address.
4. If balance > 0 → proceed with the switch. Bee will deploy the chequebook automatically.
5. If balance = 0 → block the switch. Guide the user through funding the Bee wallet first (using the existing send flow pre-filled with the Bee wallet address on Gnosis Chain).

This eliminates the 503 detection problem entirely. If the user is in light mode, they had funding when they switched, and the 503 phase is temporary — it will resolve as Bee deploys the chequebook and syncs.

#### Revised upgrade flow

Current flow (problematic):

1. User clicks "Upgrade to Light Node"
2. Bee restarts in light mode
3. Bee gets stuck on chequebook deployment (all Tier 2 endpoints return 503 indefinitely)
4. Freedom tries to figure out why from opaque API data
5. Falls back to stdout log parsing to detect "funding required"

Revised flow:

1. User clicks "Upgrade to Light Node"
2. Freedom checks `/chequebook/address` — if non-zero, skip to step 5
3. Freedom gets wallet address from `/addresses` and queries Gnosis Chain `eth_getBalance`
4. If balance is 0 → show funding CTA ("Your Bee wallet needs xDAI to enable light mode"), open the send flow pre-filled with the Bee wallet address on Gnosis Chain, and do not switch modes yet
5. Prerequisites met → switch to light mode
6. Show "Initializing" while Bee deploys chequebook and syncs (this is now a temporary state that will resolve)

#### Revised runtime state machine

Because the upgrade is gated, the runtime state machine simplifies significantly. "Funding required" becomes a pre-upgrade gate, not a runtime detection problem.

Runtime states for the node card:

1. **Ultra-light** → `Browsing only` — CTA: `Upgrade to Light Node`
2. **Light, readiness not OK** → `Initializing` — no CTA (temporary, will resolve because funding was verified before switching)
3. **Light, readiness OK, stamps not yet known** → `Initializing` — no CTA
4. **Light, readiness OK, no usable stamps** → `No usable stamps` — CTA: `Buy Stamps`
5. **Light, readiness OK, usable stamps > 0** → `Ready to publish` — no setup CTA
6. **Error** → `Error` — CTA: context-specific retry

The `Funding required` state is removed from the runtime model. It exists only in the upgrade gate flow.

#### What this means for the current WIP code

The current unstaged changes include:

- `bee-manager.js`: stdout parsing via `inspectBeeLogOutput()` and `runtimeHint` propagation — **should be removed**
- `swarm-readiness.js`: `FUNDING_REQUIRED_PATTERN` regex and `runtimeHint` input to `classifySwarmPublishState()` — **should be simplified**
- `node-status.js`: `runtimeHint` handling in status updates — **should be removed**; upgrade gate logic with chain query — **should be added to `handleUpgradeNode()`**
- `send.js`: `openSend()` export and `applySendOpenOptions()` — **should be kept**, this is how the funding flow will work

The `swarm-readiness.js` classifier and its tests are still valuable but should be revised to reflect the simpler state machine. The Bee API polling in `node-status.js` (Tier 1 always, Tier 2 opportunistically) is the right pattern and should be kept.

#### Open question: `/chequebook/address` in ultra-light mode

In ultra-light mode, `/chequebook/address` returns `200` with `"0x0000000000000000000000000000000000000000"`. It is not clear whether this means:

- (a) no chequebook has ever been deployed for this node, or
- (b) ultra-light mode always returns the zero address regardless of deployment history

The fact that this endpoint returns `200` (not `403` or `405` like other chain-dependent endpoints) suggests it is reading from local state and would return the real chequebook address if one existed. But this has not been verified against a node that has actually deployed a chequebook and then switched back to ultra-light.

If interpretation (b) turns out to be correct, the upgrade gate would fall through to the chain balance check, which is still a safe default — having xDAI is good practice for gas fees even if the chequebook exists. The only edge case where this would be incorrect is a user who deployed a chequebook, spent all their xDAI, switched to ultra-light, and is now trying to re-enter light mode. This is narrow enough to accept as a known limitation initially.

### Milestone 2: Publishing substrate and minimal utility surface

Goal: ship the internal Swarm publishing substrate plus a thin browser-owned fallback UI.

Tasks:

- implement a main-process `SwarmPublishingService`
- add publish IPC endpoints for:
  - raw bytes / text
  - single file
  - directory / website bundle
  - tag inspection
- return:
  - reference
  - `bzz://` URL
  - local Bee gateway URL
  - tag ID when relevant
- default to pinning user-published content
- persist a lightweight publish/activity history locally
- add a minimal utility UI to:
  - publish file
  - publish folder/site
  - inspect recent refs and tag state
  - inspect active publishing identities

Explicitly out of scope:

- a rich website builder
- post/reply/media authoring flows
- advanced first-party manifest editing

### Milestone 3: Third-party page publishing API

Goal: let pages publish through the user's node in a permissioned, browser-controlled way.

Tasks:

- inject a `window.swarm`-style provider into pages
- add a `swarm-permissions` store and revocation UI
- define origin normalization for HTTP(S), `bzz://`, `ipfs://`, and ENS-backed pages
- support early capabilities:
  - capability discovery
  - immutable data/file/site publishing
  - upload-status tracking
- return normalized results instead of raw Bee responses
- keep batch management and node-mode control outside page authority

This is the milestone that turns Freedom into a Swarm capability host for dweb apps.

### Milestone 4: App-scoped mutable publishing and feed identities

Goal: support stable, app-backed mutable publishing without reusing the Bee wallet or the user's main wallet.

Tasks:

- add app-scoped Swarm publisher-key derivation
- add feed creation and feed update flows to the publishing service
- create feed manifests automatically
- make provider and utility flows return a stable entrypoint, not just a new immutable ref
- add optional ENS guidance for pointing names at the resulting feed manifest

This is where third-party Swarm apps can start offering serious website-builder and social-publishing experiences on top of the browser substrate.

### Milestone 5: Durability and advanced capabilities

Goal: improve retention and enable more advanced publishing models.

Tasks:

- background pinned-content retrievability checks
- reupload pinned data when it becomes hard to retrieve
- ACT-based private sharing for advanced use cases
- optional inspect-only manifest utilities if they prove useful

Still not a core browser goal:

- becoming the primary first-party UI for website creation or social publishing

### Implementation Status (2026-03-14)

The following work from Milestones 0 and 1 has been completed on the `feature/swarm-publishing` branch:

**Milestone 0 — Light-node enablement: DONE**

- Bee light-mode config path in `bee-manager.js` (swap-enable, blockchain-rpc-endpoint, full-node: false)
- Settings toggle for opting into light mode
- Gnosis Chain RPC endpoint configured automatically
- Mode badge in the sidebar node card
- Gated upgrade flow: Freedom verifies funding prerequisites before switching to light mode

**Milestone 1 — Node funding and publishing setup: MOSTLY DONE**

- Bee wallet xDAI/xBZZ balances displayed from real Bee `/wallet` API data
- Publish setup checklist (5-step guided flow) as a sidebar sub-screen:
  1. Fund node with xDAI — context-aware: "Get xDAI" (opens receive screen for exchange funding) or "Send xDAI" (opens send flow to Bee wallet)
  2. Switch to light mode — saves setting and restarts Bee
  3. Chequebook and postage sync — automatic, shows real-time block sync progress from `/status` vs chain head
  4. Acquire xBZZ — context-aware: "Swap xDAI → xBZZ" (opens CowSwap via `ens://cowswap.eth`) or "Send xBZZ to Node" (detects xBZZ in main wallet after swap and opens send flow)
  5. Purchase postage stamps — **placeholder, not yet implemented**
- Node card CTA adapts to publish readiness state ("Set Up Publishing" / "Publishing Setup")
- CTA hidden when Bee is stopped/errored or when publish-ready
- Runtime readiness classifier (`swarm-readiness.js`) with pure-function state machine
- Shared utilities: `fetchBeeJson` (bee-api.js), `isChequebookDeployed`, `ZERO_ADDRESS` (wallet-utils.js)
- Address precedence: canonical identity-derived address preferred over Bee API cache
- Node-down handling: checklist shows appropriate blocked state instead of incorrect funding prompts

**Remaining for Milestone 1:**

- Add `@ethersphere/bee-js` as a project dependency
- Implement stamp purchase flow (step 5 of the checklist)
- Add stamp management UI for ongoing batch operations (view, extend, buy more)
- Add a post-setup stamp management entry point from the node card

### bee-js Integration Plan

#### Why bee-js

The `@ethersphere/bee-js` SDK is the right integration layer for Freedom's Swarm publishing stack. The research doc originally identified it as a strong fit (section 2 of Key Findings), and the stamp management API confirms this decisively:

- `bee.buyStorage(Size, Duration)` — users think in GB and days, not chunks and PLUR
- `bee.getStorageCost(Size, Duration)` — cost estimation before purchase
- `bee.getAllPostageBatch()` — batch inspection with `usable`, `size`, `remainingSize`, `duration`, `usage`
- `bee.extendStorageSize(batchId, Size)` / `bee.extendStorageDuration(batchId, Duration)` — top-up operations
- `bee.getSizeExtensionCost()` / `bee.getDurationExtensionCost()` — extension cost estimates
- `Size.fromGigabytes()`, `Duration.fromDays()` — human-readable unit factories

The alternative — raw HTTP against `POST /stamps/{amount}/{depth}` — would require Freedom to reimplement the amount/depth calculation, size-tier mapping, cost estimation, and all the unit conversions that bee-js already handles correctly.

Beyond stamps, bee-js is also needed for the publishing service (uploads, tags, feeds, pinning) and eventually for the `window.swarm` provider. Adding it now for stamps establishes the dependency that the rest of the stack will build on.

#### Where bee-js runs

bee-js should run in the **main process only**, consistent with how Freedom handles other privileged operations:

- The main process owns the Bee client instance, created from the service registry's active Bee API URL
- The renderer sends IPC requests for stamp operations (buy, extend, list, estimate cost)
- bee-js never runs in webview/page contexts — pages interact through `window.swarm` later
- This matches the existing architecture for wallet signing, node lifecycle, and request rewriting

#### bee-js integration scope

Phase 1 (stamps):

- `Bee` class instantiation in a new `src/main/swarm/swarm-service.js`
- IPC handlers for stamp operations
- Expose to renderer via preload API

Phase 2 (publishing):

- Upload operations (data, files, directories)
- Tag tracking
- Pinning

Phase 3 (feeds and provider):

- SOC and feed operations
- Feed manifest creation
- `window.swarm` provider bridge

### Stamp Management Design

#### Stamp purchase flow (step 5 of the publish setup checklist)

When the user reaches step 5, they need to buy at least one postage batch. The UX should be simple and opinionated for first-time users, with room for advanced control later.

**First-time purchase UX:**

1. User sees step 5 active: "Purchase postage stamps"
2. Clicks "Buy Stamps"
3. A stamp purchase form appears with preset options (see "First-time stamp defaults" below for tiers). Custom size/duration inputs are deferred to Milestone 1b.
4. The selected preset shows estimated cost in xBZZ (from `bee.getStorageCost(size, duration)`) alongside the current Bee wallet xBZZ balance.
5. On confirm, Freedom calls `bee.buyStorage(size, duration)` via IPC.
6. Shows a "Purchasing..." state (transaction takes a few seconds to ~1 minute).
7. After purchase, the batch becomes `usable` within ~1 minute.
8. The checklist polls until `usable` is true, then step 5 completes.
9. The publish setup shows all steps green — "Ready to publish".

#### Stamp management after setup

Once the user has stamps, they need a place to:

- View existing batches (usable, size, remaining size, TTL, usage %)
- Extend duration (top up a batch to keep content alive longer)
- Extend size (add capacity to an existing batch)
- Buy additional batches
- See cost estimates before extending
- Understand when batches are expiring

This should be accessible from the node card as a "Manage Storage" or "View Stamps" entry point, visible when the node is in light mode and has at least one batch.

**Stamp list view:**

For each batch:

- Usable indicator (green/yellow/red)
- Size: "4.93 GB" (from `batch.size`)
- Used: "1.2 GB / 4.93 GB (24%)" (from `batch.usage` and `batch.remainingSize`)
- Time remaining: "23 days" (from `batch.duration`, converted to human-readable)
- Batch ID: truncated with copy button
- Actions: "Extend Duration", "Extend Size"

**Extension flow:**

1. User clicks "Extend Duration" or "Extend Size" on a batch
2. Shows current value and an input for the extension amount
3. Shows estimated cost (from `bee.getDurationExtensionCost()` or `bee.getSizeExtensionCost()`)
4. User confirms
5. Freedom calls `bee.extendStorageDuration()` or `bee.extendStorageSize()` via IPC

#### Architecture: SwarmService

A new `src/main/swarm/swarm-service.js` module owns the bee-js `Bee` instance and exposes IPC handlers:

```
src/main/swarm/
  swarm-service.js     — Bee client lifecycle, IPC registration
  stamp-service.js     — stamp-specific operations (buy, extend, list, cost estimates)
```

IPC channels (Milestone 1a — read, estimate, buy):

- `swarm:get-stamps` — list all batches, normalized to Freedom batch model
- `swarm:get-storage-cost` — estimate cost for a given size (GB) + duration (days), returns formatted xBZZ
- `swarm:buy-storage` — purchase a new batch, returns batch ID

IPC channels (Milestone 1b — extensions):

- `swarm:get-size-extension-cost` — estimate cost to extend size
- `swarm:get-duration-extension-cost` — estimate cost to extend duration
- `swarm:extend-storage-size` — extend a batch's size
- `swarm:extend-storage-duration` — extend a batch's duration

Preload exposure:

```js
// Milestone 1a
window.swarmNode = {
  getStamps: () => ipcRenderer.invoke('swarm:get-stamps'),
  getStorageCost: (sizeGB, durationDays) => ipcRenderer.invoke('swarm:get-storage-cost', sizeGB, durationDays),
  buyStorage: (sizeGB, durationDays) => ipcRenderer.invoke('swarm:buy-storage', sizeGB, durationDays),
}

// Milestone 1b additions
window.swarmNode = {
  ...window.swarmNode,
  getSizeExtensionCost: (batchId, newSizeGB) => ...,
  getDurationExtensionCost: (batchId, additionalDays) => ...,
  extendStorageSize: (batchId, newSizeGB) => ...,
  extendStorageDuration: (batchId, additionalDays) => ...,
}
```

Note: this is `window.swarmNode` (internal Freedom API for the trusted renderer), not `window.swarm` (the future page-facing provider). The naming distinction matters — `window.swarm` will have permission gates and origin-scoped access; `window.swarmNode` is privileged browser-internal IPC.

#### Freedom batch model

bee-js should stay behind the service boundary. The renderer should never receive raw bee-js objects. Instead, the stamp service normalizes each batch into a Freedom-owned model before returning it over IPC:

```js
{
  batchId: string,          // hex batch ID
  usable: boolean,          // ready for uploads
  isMutable: boolean,       // mutable batch can overwrite old chunks
  sizeBytes: number,        // total storable bytes
  remainingBytes: number,   // available bytes
  usagePercent: number,     // 0-100
  ttlSeconds: number,       // estimated remaining lifetime (derived from current storage price, not exact — assumes price stays static)
  costBzz: string | null,   // original cost if known, formatted
}
```

This model is what the stamp list view, the publish setup checklist, and eventually the upload flow all consume. If bee-js changes its response shape, only the normalization layer in `stamp-service.js` needs to change.

#### Purchase state machine

The stamp purchase flow has clear states that the UI should reflect:

```
idle
  → estimating         (user picked size/duration, fetching cost)
  → ready_to_buy       (cost shown, user can confirm)
  → purchasing         (transaction submitted, waiting for chain confirmation)
  → waiting_for_usable (batch exists but not yet usable, typically <1 min)
  → usable             (batch is ready, step 5 complete)

Any state → failed     (cost estimation error, insufficient xBZZ, tx reverted, timeout)
failed → idle          (user can retry)
```

The UI should show:

- `estimating`: spinner on cost field
- `ready_to_buy`: cost displayed, confirm button enabled
- `purchasing`: "Purchasing storage…" with a progress indicator, confirm button disabled
- `waiting_for_usable`: "Batch purchased, waiting for network confirmation…"
- `usable`: step 5 checkmark, checklist complete
- `failed`: error message with retry option

#### First-time stamp defaults

For v1, the purchase UI should be opinionated with presets. Custom values are a later enhancement.

Presets:

| Label | Size | Duration | Use case |
| --- | --- | --- | --- |
| Try it out | 1 GB | 7 days | Experimenting, small file uploads |
| Small project | 1 GB | 30 days | Blog posts, small sites |
| Standard | 5 GB | 30 days | Medium sites, image collections |

The default selection should be "Small project" (1 GB / 30 days). Cost is shown dynamically from `bee.getStorageCost()`.

Custom size and duration inputs are deferred to Milestone 1b.

#### Upload-time batch selection policy

Decided now to avoid shaping the stamp UI incorrectly:

- **v1: automatic best-fit.** When the user uploads content, Freedom selects the best usable batch automatically. "Best" means: usable, has enough remaining space, longest TTL. If multiple batches qualify, prefer the one with the most remaining space. Freedom should use a conservative size estimate when checking whether a batch has enough room — upload size on Swarm is not just raw file bytes, especially for manifests and directories, so a safety margin (e.g. 1.5× raw size) should be applied when comparing against `remainingBytes`.
- **v2 (later): optional explicit choice.** Add a batch selector to the upload UI for users who want control. The automatic policy remains the default.

This means the stamp management UI does not need a "set as default batch" concept in v1. It just needs to show which batches exist and let the user extend or buy more.

#### Bee client lifecycle

The `Bee` instance should be created lazily when first needed, using the Bee API URL from the service registry. It should be recreated if the Bee node restarts or the API URL changes. The service registry already provides `getBeeApiUrl()` for this purpose.

```js
const { Bee } = require('@ethersphere/bee-js');
const { getBeeApiUrl } = require('../service-registry');

let beeClient = null;
let beeClientUrl = null;

function getBee() {
  const url = getBeeApiUrl();
  if (!beeClient || beeClientUrl !== url) {
    beeClient = new Bee(url);
    beeClientUrl = url;
  }
  return beeClient;
}
```

### Revised Concrete Product Roadmap

The original 6-milestone roadmap (Milestones 0-5) remains valid in structure. This revision updates it to reflect what has been implemented, what comes next, and how bee-js fits in.

#### Milestone 0: Light-node enablement — COMPLETE

All tasks done. Light-mode config, settings, mode detection, and gated upgrade flow are implemented and tested.

#### Milestone 1: Node funding and postage-batch management — IN PROGRESS

**Done:**

- Bee wallet balances from real API data
- Publish setup checklist with 5-step guided flow
- Context-aware funding actions (receive, send, swap via CowSwap ENS)
- Sync progress display
- Node card CTA based on publish readiness state

**Next — 1a: Add bee-js and implement stamp purchase:**

- Add `@ethersphere/bee-js` to the project
- Create `src/main/swarm/swarm-service.js` with `Bee` client lifecycle
- Create `src/main/swarm/stamp-service.js` with stamp IPC handlers
- Expose stamp operations via preload as `window.swarmNode`
- Implement stamp purchase UI in the publish setup checklist (step 5):
  - Size/duration selector with preset tiers
  - Cost estimation via `bee.getStorageCost()`
  - Purchase via `bee.buyStorage()`
  - Poll until batch becomes usable
- Update the checklist to detect `ready to publish` once a usable batch exists

**Next — 1b: Add stamp management UI:**

- Add a "Manage Storage" entry point from the node card (visible when light mode + has batches)
- Stamp list view with batch details (size, used, remaining, TTL, usage %)
- Extend duration and extend size flows with cost estimation
- Buy additional batches
- Batch expiry warnings

#### Milestone 2: Publishing substrate — NOT STARTED

Goal: let Freedom upload content to Swarm through the main-process SwarmService.

Depends on: Milestone 1a (bee-js integrated, Bee client available).

Tasks:

- Extend `swarm-service.js` with upload IPC handlers
- Support upload types: raw data, single file, directory/website bundle
- Tag-based progress tracking for large uploads
- Default to `pin: true`, `deferred: false` for simple uploads
- Return reference, `bzz://` URL, and tag ID
- Persist a publish history locally
- Add a minimal publish utility UI:
  - Publish file (file picker)
  - Publish folder/site (directory picker, auto-detect `index.html`)
  - View recent publishes with refs and status

#### Milestone 3: `window.swarm` provider — NOT STARTED

Goal: let web pages publish through the user's node in a permissioned way.

Depends on: Milestone 2 (internal publishing works).

This milestone is already well-specified in the "Permissioned Swarm Publishing For Pages" section above. Key additions from implementation experience:

- The provider should be `window.swarm`, not `window.freedomSwarm` — it is simpler and follows the `window.ethereum` convention
- The internal plumbing is `window.swarmNode` (privileged renderer IPC) → `SwarmService` (main process) → bee-js → Bee API
- The page-facing plumbing is `window.swarm` (injected provider) → renderer bridge (permission check + IPC) → `SwarmService` → bee-js → Bee API
- Permissions should be per-origin with granular capability buckets (connect, publish, feed, pin)
- App-scoped publisher identities should be derived from the vault mnemonic on a dedicated HD path

Tasks:

- Design the `window.swarm` request/response protocol
- Implement the provider injection in webview preload
- Implement the renderer-side bridge with origin validation and permission checking
- Add a `swarm-permissions` store (parallel to dApp wallet permissions)
- Implement the permission prompt UI (similar to wallet connect but with Swarm-specific capabilities)
- Support initial method set:
  - `swarm_requestAccess` — connection + capability discovery
  - `swarm_publishData` / `swarm_publishFiles` — immutable publishing
  - `swarm_getUploadStatus` — tag-based progress
- Return normalized results (reference, bzz:// URL, tag ID) instead of raw Bee responses

#### Milestone 4: Mutable publishing and feed identities — NOT STARTED

No changes from the original spec. Depends on Milestone 3.

#### Milestone 5: Durability and advanced capabilities — NOT STARTED

No changes from the original spec. Depends on Milestone 4.

### Additional Live API Findings (2026-03-14)

#### Light mode, funded, chequebook deployed, postage syncing

After funding the Bee wallet with 1 xDAI and switching to light mode:

- `/readiness` → `200 ready` (not `400` like unfunded)
- `/wallet` → `200`, `nativeTokenBalance: "999999999984674260"` (~1 xDAI minus gas), `bzzBalance: "0"`, `chequebookContractAddress: "0x5e4d..."` (non-zero — deployed)
- `/chequebook/address` → `200`, real address
- `/chequebook/balance` → `200`, `totalBalance: 0, availableBalance: 0`
- `/stamps` → `503 "syncing in progress"` (temporary — postage batch data syncing)
- `/status` → `200`, `connectedPeers: 137`, `lastSyncedBlock: 45146440`

The 503 on `/stamps` during postage sync is temporary and resolved within minutes once block sync caught up to the chain head. All other Tier 2 endpoints were available immediately after chequebook deployment.

#### Light mode, fully synced, funded with xBZZ

After swapping xDAI for xBZZ via CowSwap and sending xBZZ to the Bee wallet:

- `/stamps` → `200`, `{"stamps":[]}` — empty array (no stamps purchased yet, but endpoint is available)
- `/wallet` → `200`, `bzzBalance: "98482627564311531"` (~0.98 xBZZ with 16 decimals)
- `/chainstate` → `200`, `currentPrice: "61697"` — current storage price oracle value
- `/batches` → `200` — returns all network batches (global view, very large response)

The node is fully operational and ready for stamp purchase. `currentPrice` from `/chainstate` is the per-block-per-chunk price in PLUR — used internally by bee-js for cost calculation.

#### Resolved open question: `/chequebook/address` persistence

After deploying a chequebook in light mode and observing `chequebookAddress: "0x5E4D..."`, we can confirm the chequebook address is stored in Bee's local statestore. The open question about whether this persists across mode switches (back to ultra-light and then to light again) remains untested but is likely yes, given that the statestore is persistent on disk.

## Open Questions And Research Directions

### Resolved

- ~~Should the upgrade gate query the Gnosis RPC from the renderer directly, or route through main-process IPC?~~ **Resolved: use existing wallet infrastructure** (`window.wallet.getBalances` / `walletState.currentBalances`). No direct RPC from renderer — the CSP blocks it, and the main process already has the provider infrastructure.
- ~~How much of the Bee API should be wrapped by bee-js vs. thin direct HTTP helpers?~~ **Resolved: use bee-js for all stamp and publishing operations.** Keep thin `fetchBeeJson` for lightweight status polling (node, readiness, addresses) where bee-js is overkill.

### Still open

- Which derivation path should Freedom reserve for dedicated Swarm publisher keys?
- Should we support one publisher key per feed/site, or a single publishing identity per profile?
- Should the first publish UI live in the existing sidebar, a new `freedom://publish` page, or both?
- Should folder/site publishing happen only in the main process, or also support browser-style `FileList` uploads from the renderer?
- Should published references automatically become bookmarks or appear in a dedicated publish-history page?
- Should the app offer a one-click "point ENS name at this feed manifest" helper later?
- Should Freedom ever support full-node publishing for advanced users, or stay opinionated around light nodes?
- Does `/chequebook/address` in ultra-light mode correctly reflect a previously-deployed chequebook? Likely yes based on statestore persistence, but not yet tested with a mode-switch roundtrip.

### New questions from implementation

- What default stamp size/duration should Freedom suggest for first-time users? Proposed: 1 GB / 30 days, but this depends on typical use cases and cost at current storage prices.
- Should stamp purchase be a sub-screen within the publish setup checklist, or a standalone stamp management screen that the checklist just opens?
- How should Freedom handle batch expiry warnings? Notification, badge on the node card, or a scheduled background check?
- Should the stamp management UI show cost in xBZZ or also estimate in USD/EUR (via a price feed)?
- When the user uploads content, should Freedom auto-select the best batch, or always let the user choose which batch to use?
- Should `window.swarmNode` (internal renderer API) and `window.swarm` (page-facing provider) share the same IPC backend, or should the page-facing provider have its own permission-gated layer on top?
- How should the `Bee` client instance handle Bee restarts? Should it detect connection loss and recreate, or rely on the service registry URL change?

## Branch-Specific TODOs

### DONE (completed on `feature/swarm-publishing`)

- ~~Remove stdout-based `runtimeHint` infrastructure from `bee-manager.js`~~ — done
- ~~Simplify `swarm-readiness.js` to pure state machine~~ — done
- ~~Add gated upgrade flow with publish setup checklist~~ — done
- ~~Context-aware funding actions (receive, send, CowSwap swap)~~ — done
- ~~Node card CTA based on readiness state~~ — done
- ~~Shared utilities (fetchBeeJson, isChequebookDeployed, ZERO_ADDRESS)~~ — done
- ~~Address precedence and Bee-down handling~~ — done
- ~~Protocol URL routing in createTab (ens://, bzz://, ipfs://)~~ — done

### Next: Milestone 1a — bee-js integration and stamp purchase

Two slices:

**Slice 1: SwarmService foundation (no UI changes)**

1. `npm install @ethersphere/bee-js`
2. Create `src/main/swarm/swarm-service.js`:
   - Lazy `Bee` client instantiation from service registry URL
   - Own cached URL alongside client (not `beeClient._url`)
   - Client recreation on URL change
   - IPC handler registration
3. Create `src/main/swarm/stamp-service.js` (read + estimate + buy only — extensions in 1b):
   - `swarm:get-stamps` — list batches via `bee.getAllPostageBatch()`, normalize to Freedom batch model
   - `swarm:get-storage-cost` — estimate via `bee.getStorageCost(Size, Duration)`, return formatted xBZZ string
   - `swarm:buy-storage` — purchase via `bee.buyStorage(Size, Duration)`, return batch ID
4. Expose via preload as `window.swarmNode.getStamps()`, `.getStorageCost(sizeGB, durationDays)`, `.buyStorage(sizeGB, durationDays)`
5. Tests:
   - Unit tests for stamp-service normalization and IPC handlers (mocked bee-js)
   - Integration test against live Bee node for `getStamps` and `getStorageCost` roundtrip

**Slice 2: Checklist stamp purchase UI**

1. Wire step 5 of the publish setup checklist to `window.swarmNode`
2. Implement the purchase state machine (idle → estimating → ready_to_buy → purchasing → waiting_for_usable → usable)
3. Show preset size/duration options with live cost estimation
4. Show Bee wallet xBZZ balance alongside cost
5. Purchase flow with progress indicator
6. Poll `getStamps` until the new batch becomes `usable`
7. Flip checklist to "Ready to publish" on success
8. Tests:
   - Unit tests for purchase state transitions
   - Integration test for stamp purchase roundtrip (if Bee is available)

### After: Milestone 1b — stamp management UI

- Add stamp list view accessible from node card
- Batch detail display (size, used, remaining, TTL, usage %)
- Extend duration and size flows with cost estimation
- Batch expiry warnings
- Buy additional batches

### Later: Milestones 2-5

See revised roadmap above. Milestone 2 (publishing substrate) depends on 1a. Milestone 3 (`window.swarm` provider) depends on 2.

## References

### Local code

- `README.md`
- `src/main/bee-manager.js`
- `src/main/service-registry.js`
- `src/main/request-rewriter.js`
- `src/main/identity-manager.js`
- `src/main/identity/derivation.js`
- `src/main/identity/injection.js`
- `src/main/wallet/chains.js`
- `src/main/wallet/balance-service.js` — existing balance infrastructure (getBalances IPC, caching, provider management)
- `src/main/wallet/provider-manager.js` — Gnosis Chain RPC provider with fallback
- `src/main/preload.js` — wallet and node IPC exposure to renderer
- `src/shared/tokens.json` — token registry including xBZZ with swapUrl
- `src/shared/chains.json` — chain config including Gnosis public RPCs
- `src/renderer/index.html`
- `src/renderer/lib/wallet/node-status.js` — node card, mode/status badges, setup CTA
- `src/renderer/lib/wallet/publish-setup.js` — publish setup checklist (5-step guided flow)
- `src/renderer/lib/wallet/swarm-readiness.js` — pure-function readiness classifier and prerequisite checks
- `src/renderer/lib/wallet/bee-api.js` — shared fetchBeeJson helper
- `src/renderer/lib/wallet/wallet-utils.js` — ZERO_ADDRESS, isChequebookDeployed, formatBalance
- `src/renderer/lib/wallet/send.js` — send flow with openSend export and pre-fill options
- `src/renderer/lib/wallet/receive.js` — receive screen with QR code (openReceive export)
- `src/renderer/lib/tabs.js` — createTab with protocol URL routing (ens://, bzz://, ipfs://)

### External docs

- [Building on Swarm](https://docs.ethswarm.org/docs/develop/introduction)
- [Host your website on Swarm](https://docs.ethswarm.org/docs/develop/access-the-swarm/host-your-website/)
- [Manifests: a virtual filesystem](https://docs.ethswarm.org/docs/develop/manifests/)
- [Website routing on Swarm](https://docs.ethswarm.org/docs/develop/routing/)
- [Swarm quickstart](https://docs.ethswarm.org/docs/quickstart/)
- [Bee node types](https://docs.ethswarm.org/docs/bee/working-with-bee/node-types/)
- [Bee package manager install](https://docs.ethswarm.org/docs/bee/installation/package-manager-install/) — documents the "cannot continue until there is at least min xDAI" log message and the chequebook deployment sequence
- [Bee quick start](https://docs.ethswarm.org/docs/bee/installation/quick-start/) — documents the startup sequence, API server launch timing, and funding prerequisites
- [Fund your node](https://docs.ethswarm.org/docs/bee/installation/fund-your-node/) — documents chequebook auto-deployment, xDAI requirements, and how to query the wallet address via `/addresses`
- [Bee API reference](https://docs.ethswarm.org/api/)
- [Bee API tag docs](https://docs.ethswarm.org/api/#tag/Tag)
- [bee-js docs](https://bee-js.ethswarm.org/docs/)
- [bee-js SDK overview](https://bee-js.ethswarm.org/docs/sdk-overview/)
- [bee-js node status](https://bee-js.ethswarm.org/docs/status/) — documents `getHealth`, `getReadiness`, `getNodeAddresses`, `getNodeInfo`, `getChainState`, `getReserveState`, `getTopology`
- [bee-js chequebook](https://bee-js.ethswarm.org/docs/chequebook/) — documents `getChequebookBalance`, `depositTokens`, `withdrawTokens`, `cashoutLastCheque`
- [bee-js upload and download data](https://bee-js.ethswarm.org/docs/upload-download-data/)
- [bee-js buying storage](https://bee-js.ethswarm.org/docs/storage/) — documents `buyStorage(Size, Duration)`, `getStorageCost`, `extendStorageSize`, `extendStorageDuration`, `getAllPostageBatch`, batch properties (usable, size, remainingSize, duration, usage)
- [Buying a stamp batch](https://docs.ethswarm.org/docs/develop/tools-and-features/buy-a-stamp-batch) — documents `POST /stamps/{amount}/{depth}`, depth/amount meaning, mutable vs immutable, top-up, dilution, TTL calculation, effective utilization
- [bee-js pinning files](https://bee-js.ethswarm.org/docs/pinning-files/)
- [bee-js SOC and feeds](https://bee-js.ethswarm.org/docs/soc-and-feeds/)
- [bee-js access control](https://bee-js.ethswarm.org/docs/access-control/)
