# Settings Placement Playbook

Read this before adding, moving or renaming anything in Settings
(`src/renderer/pages/settings.html`, `src/renderer/pages/scripts/settings.js`),
and before building a feature that needs a user-facing preference. Reviewers
apply it to any PR that touches Settings.

The structure here came out of the 0.8.x Settings audit
([#268](https://github.com/solardev-xyz/freedom-browser/issues/268)–[#284](https://github.com/solardev-xyz/freedom-browser/issues/284)):
14 flat nav entries had grown by each feature adding its own, so one feature
ended up in three places (Chains, RPC Providers, Name Resolution) and
Experimental became a catch-all. The rules below are to keep that from
happening again.

## 1. Does it need a setting at all?

- Prefer a good default. Add a control only if users genuinely differ in what
  they want, not because the code has a knob.
- Developer-only switches belong in an environment variable or a test-harness
  hook. They don't belong in Settings.
- A status display with no control (a node's state, a sync counter) is not a
  setting. It belongs on the feature's own surface (sidebar, status bar, Nodes
  menu). Settings may show it next to the controls it explains, but never as a
  row by itself.

## 2. Where it goes

Place a setting by **what the user is trying to do**, not by the subsystem that
implements it. Settings has ten entries, and a new setting joins one of them:

| Entry                    | Holds                                                                                                                                                                            | Doesn't hold                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Profile**              | Who this profile is: name, profile management                                                                                                                                    | Wallet or identity while it is Beta (Advanced)             |
| **Appearance**           | How Freedom looks: theme, tab layout, status-bar indicators                                                                                                                      | What a site may do (Privacy and security)                  |
| **Search**               | Address-bar search engines and suggestions                                                                                                                                       |                                                            |
| **Downloads**            | Where and how files are saved                                                                                                                                                    |                                                            |
| **Shortcuts**            | Key bindings, all of them. A new shortcut is registered here, not given a row elsewhere                                                                                          |                                                            |
| **Privacy and security** | What sites may do and what gets blocked: content blocking, site permissions, popups, per-site exceptions                                                                         | Which network or node serves the content (Networks, Nodes) |
| **Networks**             | How Freedom reaches blockchains and resolves names: chains, RPC providers and keys, name resolution, verification. Per-chain options go in the chain's detail (`#networks/<id>`) | Running a node (Nodes)                                     |
| **Nodes**                | The bundled services (Swarm, IPFS, Radicle, Ethereum and Gnosis nodes, Tor): mode, endpoint, whether each one starts with Freedom                                                | A protocol's network or chain choices (Networks)           |
| **Advanced**             | Below the rule. Beta features and power-user controls                                                                                                                            | Anything finished. It is a waiting room, not a home        |
| **About Freedom**        | Version, updates, licences, links                                                                                                                                                |                                                            |

If a setting seems to fit two entries, ask which screen a user would open to
change it, and put it there. Don't split one feature's controls across both.
The one standing exception is start-up: every bundled node's "start when
Freedom opens" toggle sits together in Nodes → Startup, even when the feature
itself is Beta. Tor is switched on in Advanced ("Enable Tor"), while its mode
and SOCKS endpoint sit in the Nodes panel and its start-up toggle in Startup.
The Ethereum and Gnosis nodes have no Advanced toggle at all: they are one
"Myotis" row in the Nodes panel and two badged start-up rows in Startup.

## 3. Adding an entry or a panel

- **Don't add a nav entry** without a maintainer's explicit approval on the
  issue. The default is a **panel** under an existing entry:
  `<section class="section panel" id="<panel>" data-nav="<entry>">`. That
  makes it reachable as `#<entry>/<panel>` and keeps it in the entry's scroll.
- Don't add a new nav entry for a single control; put it in a panel under the
  closest existing entry. (Downloads holds one control today. It is an
  established entry kept for discoverability, not a precedent.)
- When a new bundled node arrives, it gets a row in the Nodes panel and one in
  Startup, named so a user can tell they are the same node. Today's pairs
  don't all match word for word (Nodes says "Myotis" where Startup says
  "Start Ethereum node" / "Start Gnosis node"); don't rename an existing row
  just to match, and don't flag that pre-existing mismatch in an unrelated PR.
- A Beta feature's on/off switch lives in Advanced, with the `.resolver-badge`
  Beta badge, never "(Beta)" in the label. A Beta _node's_ own configuration
  (mode, endpoint) stays in the Nodes panel beside the other nodes, as Tor's
  and Myotis's do; don't move node rows into Advanced. Its start-at-launch
  toggle, if it has one, goes in Nodes → Startup beside its siblings (§2).
  Badging that toggle is not settled yet: the Ethereum and Gnosis start-up
  rows carry the Beta badge, `#start-tor-row` doesn't, because Tor's badge is
  on its Advanced enable row. Follow whichever the nearest sibling does and
  don't add or remove a badge on an existing row in passing. When a feature
  graduates, the same PR that drops its badges moves any Advanced rows to
  their home entry (§2) and adds the old hash to `LEGACY_ROUTES`.

## 4. One feature, one place, one name

- All controls for one feature live under one entry. If another surface (the
  sidebar, a popover, an interstitial) also offers the control, Settings is the
  canonical copy. The other surface deep-links to it
  (`freedom://settings/<entry>/<panel>`) and doesn't grow its own variant.
- The same thing has the same name and the same one-line explanation
  everywhere. When two places describe it, both read one shared copy table (as
  the network sources do since
  [#269](https://github.com/solardev-xyz/freedom-browser/issues/269)) rather
  than two strings that drift apart.

## 5. Labels and copy

- Label a row by what it does for the user, in sentence case. Keep jargon out
  of the label and the first help line: protocol terms, endpoint names, quorum
  sizes and prover URLs go behind the row's Advanced disclosure
  ([#270](https://github.com/solardev-xyz/freedom-browser/issues/270)).
- Add a help line only if it says something the label doesn't
  ([#273](https://github.com/solardev-xyz/freedom-browser/issues/273)).
- Headings, buttons, verbs and danger styling follow `ui-consistency.md`.

## 6. Behaviour

- **Settings apply on change. No Save buttons**
  ([#271](https://github.com/solardev-xyz/freedom-browser/issues/271)).
  Validate inline, and never commit an invalid or half-finished value: a mode
  switch that needs an endpoint waits until the endpoint is valid, and the
  stored config stays as it was until then.
- The exception is a form that **creates or edits an item** from several
  fields at once (Search's custom-provider form). It keeps explicit
  Save/Cancel (`#save-search-provider`), because a half-typed new item must
  not exist yet. Apply-on-change covers preferences, not item editors.
- If a change only takes effect after a restart, or after a node restarts, say
  so on the row.

## 7. Checklist for a PR that adds or moves a setting

1. The row sits in the entry §2 assigns it to. If it deviates, the PR body
   says why.
2. **Deep links.** A moved or renamed panel or entry adds its old hash to
   `LEGACY_ROUTES` in `scripts/settings.js`. Grep for `freedom://settings/`
   and `settings.html#` callers and update them to the new route.
   `settings-hash-routing.test.js` covers every legacy route.
3. **Search.** `buildSettingsSearchIndex` indexes the live markup. Searching
   for the new label finds the row and opens the right entry and panel. Rows
   painted later, from IPC, are indexed too.
4. **Tests and baselines.** Add a new panel to the tour in
   `test-e2e/renderer-screenshots.spec.js` and adopt its baselines in both
   themes, following `ui-consistency.md`. Update `settings-copy.test.js` for
   any new or changed copy.
5. **Docs.** `docs/features.md` and `docs/configuration.md` name the full path
   (`Settings → Networks → RPC Providers`). User-visible changes get a
   `changelog.d/` fragment.
