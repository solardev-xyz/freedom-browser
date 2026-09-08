# Settings UI/UX audit — 2026-09

Scope: `freedom://settings` — `src/renderer/pages/settings.html` (4635 lines: the
nav, the 14 sections, and the five controllers that render Nodes, Shortcuts,
Chains, RPC Providers, Name Resolution and Site Permissions at runtime). This is
an analysis pass; no product code is changed here. Every actionable finding has
its own issue, linked below.

The bar throughout is Chrome's Settings: how it sorts and groups sections, how it
labels controls, and how little it explains. **Less is more** — a short, striking
control label should replace an explainer sentence underneath it, and a helper
line is kept only where the consequence of the control is non-obvious.

## Method

- Driver: `.claude/skills/run-freedom/` — `recipes.settings(ctx, <target>)` for
  each of the 14 nav targets plus the `chains/1` sub-route, in dark and light,
  under `xvfb-run -a -s "-screen 0 1440x900x24"` with `FREEDOM_TEST_MODE=1`.
  60 screenshots (15 targets × 2 themes × 2 passes: full-section and cropped).
- Base commit: `00fce923` (`main`).
- Numbers in this report — label and helper character counts, icon `getBBox()`
  ink boxes, button disabled state, `location.hash` after a bad deep link — were
  read out of the running app with `page.evaluate`, not counted off a screenshot.
  Quoted console output in each finding is verbatim from those runs.
- Conventions checked against `docs/agent-playbooks/ui-consistency.md`.
- Issues #223–#261 (the 0.8.5 audit and the 2026-09 UI-consistency audit) are
  excluded. Where a proposal here depends on one of them, it is named in
  "Dependencies on excluded issues" at the end.

## What was exercised

Every nav target — `appearance`, `search`, `profile`, `nodes`, `startup`,
`downloads`, `shortcuts`, `chains`, `rpc`, `ens`, `adblock`, `permissions`,
`experimental`, `updates` — plus the `chains/1` chain detail, in both themes.
Beyond the nav targets: the `chains/9999` (unknown chain) and `#privacy`
(unknown section) deep-link cases, the Search "add engine" form, the RPC
"add key" row, the Site Permissions empty state, the Nodes external-node editor,
and the Shortcuts search and conflict banner.

Static passes over `settings.html`: every `.row-label`/`.row-help` pair extracted
and measured; every `<button>` label collected per section; all 14 nav `<svg>`
elements compared on `viewBox`, pixel size, `stroke-width`, `fill` and rendered
ink box; every user-facing string checked for jargon against a
non-technical-reader test.

## Findings

Ranked by user impact.

| #   | Issue                                                              | Surface                        | Impact                                                                          |
| --- | ------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------- |
| 1   | [#268](https://github.com/solardev-xyz/freedom-browser/issues/268) | Nav                            | 14 flat items; one feature split across three of them, another across two       |
| 2   | [#269](https://github.com/solardev-xyz/freedom-browser/issues/269) | Name Resolution + chain detail | The same four sources named and explained differently on two screens            |
| 3   | [#270](https://github.com/solardev-xyz/freedom-browser/issues/270) | Name Resolution, Startup       | Nine terms a daily-driver user cannot parse, in visible labels                  |
| 4   | [#271](https://github.com/solardev-xyz/freedom-browser/issues/271) | Nodes                          | The only section with a Save button; all four enabled with nothing to save      |
| 5   | [#272](https://github.com/solardev-xyz/freedom-browser/issues/272) | Site Permissions               | Opens with a 196-character paragraph and repeats it in the empty state          |
| 6   | [#273](https://github.com/solardev-xyz/freedom-browser/issues/273) | Profile, Startup, Downloads    | Helpers that restate the label; identical rows where only some have one         |
| 7   | [#274](https://github.com/solardev-xyz/freedom-browser/issues/274) | Ad Blocking                    | "blocking is inactive" with the master toggle on and five live sub-toggles      |
| 8   | [#275](https://github.com/solardev-xyz/freedom-browser/issues/275) | Experimental                   | Catch-all: Tor's startup toggle, a status row and an Appearance preference      |
| 9   | [#276](https://github.com/solardev-xyz/freedom-browser/issues/276) | Startup, Name Resolution       | Section heading disagrees with the nav label that reached it                    |
| 10  | [#277](https://github.com/solardev-xyz/freedom-browser/issues/277) | Shortcuts                      | 23 Title Case labels on a page that is otherwise sentence case throughout       |
| 11  | [#278](https://github.com/solardev-xyz/freedom-browser/issues/278) | Search, Chains, Profile, RPC   | `+` and `→` baked into some button labels and not their siblings                |
| 12  | [#279](https://github.com/solardev-xyz/freedom-browser/issues/279) | Nav                            | Ad Blocking and Site Permissions are adjacent shields with the same ink box     |
| 13  | [#280](https://github.com/solardev-xyz/freedom-browser/issues/280) | Deep links                     | An unknown `#section` or `#chains/<id>` leaves the wrong URL in the address bar |
| 14  | [#281](https://github.com/solardev-xyz/freedom-browser/issues/281) | Whole page                     | No search within Settings, although Shortcuts has its own search box            |

---

### 1. 14 flat nav items; three of them are one feature — [#268](https://github.com/solardev-xyz/freedom-browser/issues/268)

`src/renderer/pages/settings.html:865-1105`. The nav is one ungrouped list of 14
buttons. Chrome ships 13 in four visually separated groups and never gives one
feature three entries.

**Chains, RPC Providers and Name Resolution are one feature.** All three read and
write the same object: `freedomAPI.getNetworkConfig()` backs the Chains
controller (`:3405`), the RPC Providers controller (`:4403`) and the Name
Resolution controller. They already cross-link at runtime — Name Resolution's
rows point at `#chains/1` (`:3828`, `:3835`), the chain detail's keyed rows point
at the RPC page (`:3181`), and the RPC page's own intro says keyless endpoints
"are managed per chain under Chains settings" (`:4396`). Changing where an
Ethereum name is looked up can require all three.

**Nodes and Startup are one feature.** Nodes (`:1245`) sets each service's mode;
Startup (`:1254`) sets whether the same service launches. Same four services, two
screens, and different names on each: `Myotis` in Nodes versus
`Ethereum light client (Myotis)` and `Gnosis light client (Myotis)` in Startup.

**Three items hold one control each.** Downloads is one toggle; Updates is one
toggle; Appearance is two rows.

Proposed structure — 10 entries in Chrome's order, with a rule before the last two:

```
Profile
Appearance
Search
Downloads
Shortcuts
Privacy and security     ← Ad Blocking + Site Permissions
Networks                 ← Chains + RPC Providers + Name Resolution
Nodes                    ← Nodes + Startup
────────────
Advanced                 ← Experimental
About Freedom            ← Updates + version + "Check for updates"
```

Networks keeps today's Chains master–detail; RPC Providers becomes an
`#networks/keys` sub-route (it is three API-key rows, not a section); Name
Resolution becomes a card on the Ethereum chain detail, which is where its own
links already point and the only chain it applies to (`:1388`). Nodes absorbs
Startup by giving each node row a second control, `Start when Freedom opens`.
About Freedom gives the version string and a manual update check a home they do
not currently have anywhere in Settings.

![settings nav, dark and light](images/settings-01-nav.png)

![RPC Providers — a nav item for three API-key rows](images/settings-15-rpc.png)

### 2. The same four sources, two vocabularies — [#269](https://github.com/solardev-xyz/freedom-browser/issues/269)

Two controllers hold two independent copy tables for the same four network
sources: `METHODS` at `settings.html:3811-3838` (Name Resolution) and
`accessMeta` at `settings.html:3220-3237` (chain detail).

| source    | Name Resolution label | chain-detail label                     | ENS help | chain help |
| --------- | --------------------- | -------------------------------------- | -------- | ---------- |
| `myotis`  | Myotis light client   | Myotis **P2P** light client            | 153 ch   | 61 ch      |
| `colibri` | Colibri               | Colibri **cryptographic verification** | 87 ch    | 54 ch      |
| `quorum`  | RPC quorum            | RPC quorum                             | 111 ch   | 72 ch      |
| `direct`  | Direct RPC            | Direct RPC                             | 108 ch   | 67 ch      |

Two of four labels differ; all four help sentences differ. The controls differ
too — Name Resolution gives each source a toggle, a coloured badge and nested
config rows; the chain detail gives the same four a grey badge and nothing else.
`quorum` is the worst case: three sentences for one fact, two of them one row
apart on the same screen.

Proposed shared table, written to the "less is more" bar:

| source    | label                      | help                                                            |
| --------- | -------------------------- | --------------------------------------------------------------- |
| `myotis`  | Local node                 | _(none — the `Ready`/`Syncing`/`Off` badge carries it)_         |
| `colibri` | Proof check                | A server answers; Freedom checks the proof itself.              |
| `quorum`  | Several servers must agree | _(none — the `2 of 3` badge carries it)_                        |
| `direct`  | One server, unchecked      | Fastest, and the only option with nothing verifying the answer. |

![Name Resolution (left) vs the same four sources on chains/1 (right)](images/settings-02-duplicate-source-copy.png)

### 3. Jargon in visible labels — [#270](https://github.com/solardev-xyz/freedom-browser/issues/270)

| term                                           | site                                            | proposed                                                       |
| ---------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| `optimistic beacon head`, `finalized state`    | `settings.html:3815`                            | delete                                                         |
| `WNS/GNS`                                      | `settings.html:3815`                            | delete — undefined acronyms, one use in any user-facing string |
| `byte-identical answers at one anchored block` | `settings.html:3827`                            | "must give the same answer"                                    |
| `quorum`                                       | `settings.html:3826`, `:3230`                   | "Several servers must agree"                                   |
| `prover` / `Prover endpoint`                   | `settings.html:3946`, `:3323`, `:3044`          | "Proof server", behind Advanced                                |
| `corpus.core default`                          | `settings.html:3947`                            | "Leave empty to use the default."                              |
| `light client`                                 | `settings.html:1295`, `:1311`, `:3814`, `:3222` | "Ethereum node" / "Gnosis node"                                |
| `P2P`                                          | `settings.html:1313`, `:3222`                   | spell out, or delete                                           |
| `RPC`                                          | `settings.html:1022` and ~20 more               | keep inside the Networks detail; "server" in prose             |

`postage` was checked for and does **not** appear in `settings.html` — it lives
in the wallet sidebar's stamp manager, outside this page's scope.

Proposed progressive-disclosure pattern: the plain label is the visible layer;
the technical name and mechanism go behind a per-row `Advanced` disclosure,
collapsed by default.

```
Local node                                    [Ready]   ( ●)
  ▸ Advanced
      Myotis — a peer-to-peer Ethereum light client running inside
      Freedom. ENS lookups use finalized state; newer record types
      use a verified optimistic beacon head.
```

![Name Resolution, dark and light](images/settings-03-ens-order.png)

### 4. Nodes is the only section with a Save button — [#271](https://github.com/solardev-xyz/freedom-browser/issues/271)

Every other control on the page commits on change: the theme dropdown, all 20-odd
toggles, the profile name field on blur/Enter (`settings.html:2289-2304`), the
ENS drag order, the quorum dropdowns, the prover endpoint on `focusout`
(`:3520`). Nodes gives each of its four rows a `Save` button (`:2201-2203`).

Read out of the running app on a freshly loaded page with nothing edited:

```
D nodes save buttons: [{"node":"bee","disabled":false},{"node":"ipfs","disabled":false},
                       {"node":"myotis","disabled":false},{"node":"radicle","disabled":false}]
```

All four enabled with no pending change, so the button carries no signal, and the
mode dropdown above it carries no signal that its new value has not taken effect.
Switching Swarm to `Use external node` and navigating away loses the change
silently; every sibling control would have kept it. Chrome has no Save button
anywhere in Settings.

Proposed: auto-save on `change` and drop the four buttons; commit the
external-endpoint text fields on `focusout`, exactly as the Colibri prover
endpoint already does at `:3520`.

![Nodes, dark and light](images/settings-04-nodes-save.png)

### 5. Site Permissions is 335 characters of prose and no data — [#272](https://github.com/solardev-xyz/freedom-browser/issues/272)

`settings.html:4517-4537` renders an unconditional intro card: 39-character label
plus a **196-character** helper, the longest on the page. `:4542-4546` then
repeats it in 100 more characters. On a fresh profile that is two headings, two
paragraphs, one disabled danger button and zero rows. The intro is not
conditional — it sits above every origin card in the populated state too.

Chrome's equivalent screen has no intro paragraph at all.

Proposed replacement — delete the intro, move `Remove all` next to the section
title, keep one empty state:

```
Site Permissions                                    [ Remove all ]

  No saved permissions
  Sites you allow or block with "Remember for this site" appear here.
```

20-character label, 65-character helper, down from 335. The helper survives the
non-obvious-consequence test because `Remember for this site` is the exact
checkbox string in the prompt, so it tells the user how a row gets created.

![Site Permissions, dark and light](images/settings-05-permissions.png)

### 6. Helpers that restate the label — [#273](https://github.com/solardev-xyz/freedom-browser/issues/273)

**A. Pure restatement.**

| file:line    | label                     | helper                                                                 | proposed                                                                        |
| ------------ | ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `:1220-1221` | `Name` (4)                | `The display name for the current profile.` (41)                       | delete                                                                          |
| `:1281-1284` | `Start Radicle node` (18) | `Starts this profile's embedded Radicle node when Freedom opens.` (63) | delete the default; keep the dynamic replacements at `:1671-1675`, `:1684-1685` |

**B. A shorter label makes the helper unnecessary.**

| file:line    | current                                                                                                  | proposed                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `:1295-1300` | `Start Ethereum light client (Myotis)` (36) + 156 ch                                                     | `Start Ethereum node` + `Beta` badge + `Restart to apply.` (17)                                   |
| `:1311-1315` | `Start Gnosis light client (Myotis)` (34) + 119 ch                                                       | `Start Gnosis node` + `Beta` badge + `Restart to apply.` (17)                                     |
| `:1333-1336` | `Ask where to save each file` + `When off, files are saved to your Downloads folder automatically.` (65) | same label + `Otherwise: ~/Downloads` — states the destination instead of restating the off state |

**C. Identical rows disagree on whether they get a helper.** The five Startup rows
are the same kind of row. `Start Swarm node` (`:1259`) and `Start IPFS node`
(`:1270`) have no helper; the other three have 63, 156 and 119 characters. **B**
makes it "all five, in three words".

**D. A paragraph that should shrink or become a link.** `:1523-1526`, Allowlisted
sites, 130 characters. Proposed: `Ad blocking is off on these sites and their
subdomains.` (54); Chrome does not warn about reloads on its own exceptions list.

Roughly 460 characters removed across six rows with no fact lost that the label
or a badge does not already carry.

![Startup, dark and light](images/settings-06-startup.png)

### 7. Ad Blocking: on, inactive, and interactive — [#274](https://github.com/solardev-xyz/freedom-browser/issues/274)

```
E adblock: {"master":true,
            "status":"No filter lists bundled — blocking is inactive.",
            "ads":true,
            "adsDisabled":false}
```

The master toggle reads on, the status says inactive, and all five sub-toggles
are on and interactive. The status text is written into the row's `.row-help`
slot (`settings.html:1449`) — the slot every other row uses for static
explanatory copy — so it does not read as a warning, and nothing about the row's
appearance changes. `.row.disabled` already exists and is used at `:1677` for the
Radicle startup row.

Proposed: disable the master and the five sub-rows when no lists are available,
and state the consequence once — `No filter lists available. Ad blocking cannot
run.`

Separately, four sub-row helpers are filter-list brand names: `EasyList`
(`:1461`), `EasyPrivacy` (`:1473`), `Fanboy Cookiemonster` (`:1485`),
`Fanboy Annoyances` (`:1497`). None says anything the label has not. Proposed:
delete all four and let the attribution footnote at `:1541-1544` carry the list
names — as a link, not the bare parenthesised URL it prints today.

![Ad Blocking, dark and light](images/settings-07-adblock.png)

### 8. Experimental is a catch-all — [#275](https://github.com/solardev-xyz/freedom-browser/issues/275)

`settings.html:1547-1608`. Five rows; two are experiments.

| file:line    | row                                       | what it is                                                                       |
| ------------ | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `:1550-1563` | Enable Identity & Wallet _(Beta)_         | an experiment ✓                                                                  |
| `:1564-1574` | Show IPFS load progress in the status bar | an **Appearance** preference                                                     |
| `:1575-1583` | Swarm node mode                           | a status readout + a navigation button; belongs on the Swarm row in **Nodes**    |
| `:1584-1595` | Enable Tor (.onion access) _(Beta)_       | an experiment ✓                                                                  |
| `:1596-1606` | Start Tor when Freedom opens              | the fifth "start X when Freedom opens" toggle; the other four are in **Startup** |

`(Beta)` is inline text at `:1554` and `:1586`
(`<span style="color: var(--text-muted); font-weight: 400">`), while the page
already has a badge component — `.resolver-badge`, used for `Ready` / `Verified`
/ `2 of 3` / `Public endpoint`. Proposed: render `Beta` through it, without
parentheses, so the one marker that means "this may break" looks like a marker.

![Experimental, dark and light](images/settings-08-experimental.png)

### 9. Section heading ≠ nav label — [#276](https://github.com/solardev-xyz/freedom-browser/issues/276)

Twelve of 14 match exactly. Two do not:

```
F title-vs-nav: [ {"nav":"Startup","title":"Automatic Startup"},
                  {"nav":"Name Resolution","title":"Ethereum Name Resolution"}, … ]
```

`settings.html:951` vs `:1255`, and `:1038` vs `:1385`. Chrome's page title is
always character-identical to the nav entry that reached it; that identity is
what confirms the click did what you meant.

Proposed: change the headings, not the nav labels (the labels have to fit a
260 px column). `Automatic Startup` → `Startup`; `Ethereum Name Resolution` →
`Name Resolution`. The dropped word is already carried in each case — "Automatic"
by every row beginning `Start …`, "Ethereum" by the intro line at `:1388`.

Evidence: `images/settings-06-startup.png` (the heading reads
`Automatic Startup` while the active nav item reads `Startup`).

### 10. Shortcuts is the only Title Case section — [#277](https://github.com/solardev-xyz/freedom-browser/issues/277)

Every row label on the page is sentence case — `Ask where to save each file`,
`Block cookie banners`, `Prefer verified answers`, `When only an unverified
answer is available` — except Shortcuts, whose 23 labels are all Title Case:
`New Tab`, `Close Tab`, `Reopen Closed Tab`, `Move Tab Right`, `Force Reload This
Page`, `Toggle Bookmarks Bar`, `App Developer Tools`, …

Source: the `description` field of each `src/shared/shortcuts.js` entry (`:38`,
`:46`, `:58`, `:66`, `:75`, `:87`, `:95`, `:105`, `:113`, `:121`, …).

The complication is that the same strings are the application-menu labels, where
Title Case is the macOS convention — so this cannot be fixed by lower-casing
`shortcuts.js` in place. Proposed: add `settingsLabel` alongside `description`,
render `settingsLabel ?? description` in the Shortcuts controller, and leave the
menu builder, `docs/features.md`'s shortcut table and #188's docs↔registry guard
tracking `description` untouched.

Also in scope: Shortcuts is the only section that groups rows under headers, and
those headers are the only all-caps text in Settings — the five `category`
strings in `shortcuts.js` are sentence case (`Tabs`, `Page`, `Window`,
`Navigation`, `Developer`) and are upper-cased at render by
`.shortcut-category { text-transform: uppercase }` (`settings.html:720-726`),
the file's only `text-transform` rule. Dropping that one declaration brings the
headers in line with every other heading on the page.

![Shortcuts, dark and light](images/settings-10-shortcuts-case.png)

### 11. `+` and `→` baked into button labels — [#278](https://github.com/solardev-xyz/freedom-browser/issues/278)

Three add buttons prefix a literal `+`; four do not. Two navigation buttons
suffix a literal `→`; one does not. All are the same `.btn`.

| file:line    | label                   | glyph |
| ------------ | ----------------------- | ----- |
| `:1178-1180` | `+ Add a search engine` | `+`   |
| `:3047`      | `+ Add a chain`         | `+`   |
| `:3364`      | `+ Add a custom RPC`    | `+`   |
| `:1536`      | `Add`                   | —     |
| `:3117`      | `Add chain`             | —     |
| `:3209`      | `Add endpoint`          | —     |
| `:4375`      | `Add key`               | —     |
| `:1236-1238` | `Manage all profiles →` | `→`   |
| `:2561`      | `Set up publishing →`   | `→`   |
| `:3181`      | `Manage keys`           | —     |

The same split runs through the ENS link labels (`Node settings →` `:3817`,
`Manage endpoints →` `:3829`, `Configure →` `:3836`). Because the glyph is text
content it is also part of the accessible name — "plus Add a chain", "Manage all
profiles right arrow". The chain list rows have the same problem: each announces
as `Ethereum chain 1 ›`, because the chevron at `:3017` is a text node inside the
`<button>`.

Proposed: delete every `+` and `→` from label text (Chrome uses neither on any
Settings button); if a leading `+` is wanted as an affordance, make it an
`aria-hidden` `<svg>` on all seven add buttons rather than three; and mark the
chain-row chevron `aria-hidden="true"`.

Verbs are otherwise already consistent and imperative — `Add` / `Edit` /
`Remove` / `Save` / `Cancel` / `Test` / `Restore defaults`.

![Search, dark and light](images/settings-11-search-empty.png)

![Chains list, dark and light](images/settings-16-chains-list.png)

### 12. Two adjacent shields in the nav — [#279](https://github.com/solardev-xyz/freedom-browser/issues/279)

`Ad Blocking` (`settings.html:1040-1054`) and `Site Permissions` (`:1055-1070`)
are neighbours and both use a shield. Measured `getBBox()` in the running app:

```
{"label":"Ad Blocking",      "viewBox":"0 0 24 24","px":"16x16","stroke":"2","ink":"4 2 16 20"}
{"label":"Site Permissions", "viewBox":"0 0 24 24","px":"16x16","stroke":"2","ink":"4 2 16 20"}
```

Identical ink box; at 16 px the only difference is a small check mark. They are
not even the same shield — Ad Blocking uses Feather's `shield` path (`:1051`),
Site Permissions a hand-written path with a flat top and squared shoulders
(`:1066`), visible at 3× below.

Proposed: #268 merges both into one **Privacy and security** entry and the
collision disappears. Failing that, keep the shield for Site Permissions and give
Ad Blocking Feather `slash` or `octagon`. Separately, `Nodes` (`:921-937`) uses
Feather `database` — a storage icon — for four long-running network processes;
`server` or `cpu` matches the concept.

![Ad Blocking and Site Permissions at 3×, dark and light](images/settings-12-nav-shields.png)

### 13. Bad deep links keep the bad URL — [#280](https://github.com/solardev-xyz/freedom-browser/issues/280)

```
B unknown-section hash: #privacy
B unknown-section active nav: Appearance

A unknown-chain hash: #chains/9999
A unknown-chain heading: Chains
A unknown-chain status: ""
```

The address bar reads `freedom://settings/privacy` while the page shows
Appearance. Bookmark, share or reload it and you get Appearance under a URL
promising a section that has never existed.

Cause: the URL is normalised exactly once, on first load
(`settings.html:2017-2028`). The `hashchange` listener two lines above
(`:2013-2015`) calls `showSection(resolveSection(location.hash))` and never
re-runs that check, so every in-session navigation to a bad hash keeps it. The
chain case is the same shape: `renderList()` runs whenever `config.networks[cid]`
is missing (`:3397-3399`), so `#chains/9999` shows the list under a URL claiming
a detail, with an empty status line.

Proposed: extract the canonicalisation at `:2023-2027` into a function and call
it from the `hashchange` handler too; and in the chains controller's `render()`
(`:3392-3400`), `replaceState` back to `#chains` and set the status to
`That chain is no longer configured.` when `cid` is unknown. Chrome does the
equivalent — `chrome://settings/nonsense` rewrites to the settings root.

![freedom://settings/privacy showing Appearance, dark and light](images/settings-13-deeplink.png)

### 14. No search within Settings — [#281](https://github.com/solardev-xyz/freedom-browser/issues/281)

```
C search inputs on page: ["Search shortcuts…"]
```

One search field on the whole page, and it filters the Shortcuts list only
(`#shortcut-search`, `settings.html:1356-1362`). Chrome's Settings has had a
persistent **Search settings** field since 2016; on a 14-section page it is how
most people navigate. Freedom's page is the harder case — Tor's startup toggle is
under Experimental, a chain's API keys are under RPC Providers — so
"I know the word, I don't know the section" is the normal state. A search box in
one section and none for the page also sets the wrong expectation: the user who
finds the Shortcuts field concludes Settings has no search.

Proposed: a `Search settings` input in the `<aside>` header under the `Settings`
`<h2>` (`:855-864`), above the `<nav>`. Smallest useful version filters the 14
`.nav-item` labels; the version worth building indexes every `.row-label` /
`.row-help` plus the `METHODS`/`accessMeta` copy tables and shows a flat result
list with each row's section, as Chrome does. Placeholder `Search settings…`
**with** the ellipsis: every search placeholder in the app already uses one —
`Search shortcuts…` (`:1360`), `Search chains by name or ID…` (`:3085`),
`Search history…` (`history.html:489`), `Search downloads…`
(`downloads.html:397`), `Search origins…` (`index.html:3858`),
`Search site, address, or tx hash…` (`payments.html:394`) — so `…` is the house
style #257 settled on, not a deviation.

Evidence: `images/settings-01-nav.png` — the nav header has no field.

---

## Keep as is

Checked and already at the bar, so a reviewer can confirm this pass looked:

- **Nav icons are one family in the ways that are measurable.** All 14 are
  `16x16` in a `0 0 24 24` viewBox with `stroke-width="2"`, `fill="none"`,
  `stroke="currentColor"`, and all inherit one colour token
  (`rgb(139,148,158)` inactive, `rgb(88,166,255)` active). Stroke weight,
  nominal size and colour are uniform across the set; only the two shields in
  finding 12 are a problem, and that is semantics, not drawing.
- **Sections scroll back to the top on navigation.** `showSection` calls
  `window.scrollTo({ top: 0 })` (`settings.html:1997-1999`) with a comment
  explaining why, so switching from Shortcuts to Downloads does not strand the
  user mid-page. Measured `scrollHeight` against a 712 px viewport: Shortcuts
  2087, `chains/1` 2071, Name Resolution 1023, every other target 712 (no
  scroll at all). No back-to-top control is needed for section switching, and
  the two long targets are a single scroll — short of where a back-to-top
  earns its place.
- **The active section is in the URL.** `freedom://settings/<section>` is
  reflected in the address bar and `#chains/1` survives a reload
  (`resolveSection` splits on `/`, `:1983-1986`). This is better than Chrome's
  behaviour for sub-routes, and it is what makes finding 13 worth fixing rather
  than the feature worth removing.
- **Control types are used consistently for the kind of choice.** Every boolean
  is a toggle (~20 of them); every enumerated choice is a `<select>` (theme
  light/dark/system, search engine, node mode managed/external/disabled,
  unverified-answer ask/open, the quorum `m`/`k` numbers); every action is a
  button. Nothing renders a boolean as a dropdown or an enum as a pair of
  toggles anywhere on the page.
- **Row labels outside Shortcuts are sentence case throughout**, and button
  verbs are imperative throughout — `Add`, `Edit`, `Remove`, `Save`, `Cancel`,
  `Test`, `Restore defaults`. Finding 11 is about glyphs, not verbs.
- **Every list section has an empty state.** Search
  (`No custom search engines yet`, `:1827`), Site Permissions
  (`No stored site permissions`, `:4543`), RPC Providers
  (`No keyed providers available`, `:4390`), chain detail
  (`No custom RPCs yet`, `:3363`), chain search (`No chains found`, `:3059`).
- **`Remove all` is correctly disabled when there is nothing to remove**
  (`:4530-4532`) — the one danger action on the page that can be a no-op, and it
  guards itself.
- **Both themes are complete on this page.** All 15 targets were captured in
  dark and light; there is no unstyled section, no dark-only card and no
  hard-coded literal without a light counterpart — the class of bug #223 and
  #224 fixed has not regressed here.
- **Sub-rows use one nesting convention.** `.row.sub` is the only indentation
  mechanism on the page, used seven times — the four Ad Blocking category rows
  (`:1458`, `:1470`, `:1482`, `:1494`), the auto-update row (`:1506`), the Tor
  startup row (`:1596`) and the per-permission rows under each origin card
  (`:4556`) — and it renders identically in all seven.

## Dependencies on excluded issues

Issues #223–#261 are out of scope and not re-reported. Two proposals above touch
them:

- **[#255](https://github.com/solardev-xyz/freedom-browser/issues/255)** (open) —
  the chain-detail route uses `h2.section-title` for both the page title and its
  sub-sections. Confirmed still present: the `chains/1` detail renders six
  `H2.section-title` elements (`Ethereum`, `Read and verification order`,
  `Transaction broadcast`, `Your RPCs`, `Commercial providers`, `Public RPCs`).
  The other half of that inconsistency is on Name Resolution, which uses
  `h3.row-label` for the same nesting level (`Resolution order`, `Safety`,
  `settings.html:1391`, `:1416`) — so the two screens disagree on both the tag
  and the class for sub-section headings. That is #255's fix to make, and
  findings 2 and 3 assume it lands before their shared copy table is rendered
  into headings.
- **[#259](https://github.com/solardev-xyz/freedom-browser/issues/259)** (open) —
  `Delete Wallet` is the only filled destructive button in the sidebar. The
  Settings page has the mirror-image question: `Remove all` (`:4530`) and the
  custom-search-engine `Remove` (`:1822`) are `.btn.danger`, while
  `Remove this chain` (`:3389`), the endpoint delete `✕` (`:3189`), `Remove site`
  (`:4578`) and the per-permission `Remove` (`:4564`) are plain `.btn` — six
  destructive actions, two treatments. Whatever #259 settles on for the sidebar
  should be applied to these six in the same pass rather than decided twice.
