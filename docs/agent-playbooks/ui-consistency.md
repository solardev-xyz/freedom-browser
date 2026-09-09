# UI Consistency Playbook

Read this before changing anything under `src/renderer/` (chrome, sidebar,
internal pages, settings) and when reviewing such a change. It encodes the
conventions the UI already follows so new surfaces match their siblings, and
it lists the checks that catch drift. It was distilled from the visual audit
of the 0.8.5 cycle (issues #223–#242).

## Conventions

**Tokens, not literals.** The chrome's colours come from
`src/renderer/styles/variables.css` (`--bg`, `--toolbar`, `--border`, `--text`,
`--muted`, `--accent`, `--danger`, `--secure-fg`, `--warning-fg`, `--menu-bg`,
`--modal-bg`); a hard-coded colour there needs a matching `[data-theme='light']`
override in `light-theme.css`. Internal pages (`src/renderer/pages/`) have one
palette between them, `pages/styles/theme.css`: both themes are declared there,
keyed on `html[data-theme]`, and every page links it and paints from
`var(--token)`. A page has no light block of its own to override a literal in,
so a new colour is a new token in that file — with both values — not a literal
in the page. `pages/styles/theme.test.js` holds the single-source rule (every
page links the sheet and its CSP can load it, no page re-declares a palette, no
page paints from an undefined token, no token goes unused) and
`settings-styles.test.js` fails any hard-coded dark background left in
`settings.html`.

Since #261, `src/renderer/renderer-styles.test.js` enforces the rule
mechanically over _every_ stylesheet, inline `<style>` block and `style=""`
attribute under `src/renderer/`: a new hex, `rgb()`, `hsl()` or named colour
fails the unit suite. Two ways out, and only two:

- paint from a `var(--token)`; or
- annotate the declaration when the colour genuinely is not a theme surface —
  a drop shadow, a protocol's brand colour, a node's status green, the fixed
  contrast pair on a filled accent button:

  ```css
  /* theme-literal: Swarm's brand orange, the badge's identity, not a surface */
  background: #f7931a;
  ```

  The comment goes on the declaration's own line or the line directly above it,
  and has to say _why_. A trailing annotation covers its own line only.

`src/renderer/renderer-color-literals.json` records the literals that predate
the guard — mostly the per-page palettes #261 item 2 exists to delete. It is a
ratchet: a pair that is not in it fails, and a pair in it that no longer appears
fails too. After removing literals, run `npm run styles:inventory -- --write`
and commit the shrunken file.

**Both themes, always.** Every surface renders in dark and light. The chrome
reads the theme from `data-theme` on `<html>`; internal pages must follow the
same Appearance setting (see #233), not only the OS scheme.

**Inputs.** One focus treatment for chrome text inputs (address bar, find bar,
modal and sidebar inputs). Monospace (`.rpc-input` in settings) is for URLs,
hashes and keys; search boxes and names use the sans font.

**Buttons.** Primary action filled `--accent`, secondary outlined, destructive
outlined `--danger` ("Clear All", "Remove all", "Restore defaults"). The same
action uses the same verb everywhere (a remembered permission is _removed_ in
every surface). Every approval screen in the sidebar — wallet, dApp and Swarm —
pairs one filled `--accent` primary with an outlined secondary; the Swarm
screens' orange primary was the one exception until #239.

The _reject_ verb has not converged. The four dApp approvals and the four Swarm
approvals say "Reject", and `renderer-copy.test.js` pins that on those eight
screens only. Elsewhere the same decision is still worded per screen: Radicle
Access says "Cancel" (`#radicle-consent-reject`), App permissions says "Don't
allow" (`#swarm-manifest-reject`), the toolbar permission prompt says "Block"
(`#permission-prompt-block`). Treat those as unpinned drift, not as a rule
being broken — check the verb against the screen you are touching, and settle a
screen's wording on its issue before changing it. "Cancel" is correct where
there is no request to reject: dismissing a form, an unlock prompt.

**Approval callouts.** Two kinds, both in `styles/sidebar.css`: amber with the
warning triangle (`.dapp-tx-warning`, `.swarm-connect-warning`) for the
consequence of the action being confirmed, blue with the "i" glyph
(`.dapp-sign-warning`, `.swarm-connect-note`) for what the access being
granted means. The icon lives in the markup, not in the class, so changing the
kind means changing both.

`renderer-copy.test.js` pins that pairing on the four Swarm approvals only, and
two amber callouts outside that sweep do not follow it: the Radicle Access
callout uses `.swarm-connect-warning` with the "i" glyph, and App permissions'
`#swarm-manifest-identity-note` is a `.swarm-connect-warning` with no glyph at
all. Both are known drift waiting on a per-screen kind decision (#239); do not
repaint them to the pairing without one, and do not read them as evidence the
pairing above is wrong.

**Sidebar sub-screens.** One header component: chevron, "Back", title, and
the same close control on every screen (Send, Confirm Transaction, Sign
Message, Connect, Swarm Access, Confirm Publish, Confirm Message, Feed
Access, Connect Ledger, Connect Phone).

**Settings sections.** `h2.section-title` for the section, `h3.row-label` (or
the 12 px uppercase category style) for sub-headings, never a second large
heading. Cards with `.row` / `.row.sub` for nested toggles. Links inside copy
use the `row-help` link style, not the default anchor.

**Menus and counters.** The Nodes menu shows `0` for an empty counter, never
`--`. Shortcut hints render as `Ctrl+T` on Linux/Windows and `⌘T` on macOS in
every surface (hamburger menu, Shortcuts settings, tooltips).

**Popovers are bounded, the chrome is not scrollable.** Every dropdown,
flyout, context menu and popover in the chrome carries `.chrome-popover`
(`styles/popovers.css`) and is opened through `lib/popover-bounds.js`:
`boundPopoverToViewport` for an anchored popover, `placePopoverAtPoint` for a
pointer-anchored context menu (clamp, flip up, then scroll). That is what keeps
a menu inside the window — `html, body { overflow: hidden }` means an
unbounded one would clip rather than scroll, and before #324 it scrolled the
toolbar away instead. A new popover joins the mechanism rather than growing its
own `max-height`; `styles/popovers.test.js` fails a popover that forgets the
class, and it works out what a popover *is* from the sheets themselves —
anything positioned `fixed`/`absolute` at menu tier (z-index ≥ 9999) — so a
brand-new class name is enrolled without editing the test. A surface at that
tier that genuinely is not a popover (the backdrop, a corner toast, a tooltip)
goes in that file's `NOT_POPOVERS` map with its reason.

**Dismissing on focus loss goes through `lib/window-deactivation.js`.** A
window `blur` in the chrome does not mean the user left the window: a
`<webview>` guest taking the keyboard raises the same event, and every tab
activation hands the page focus (#304) with the guest's ack landing
asynchronously — late enough to tear down a menu the user has just opened and
swallow the click on its way (#328). A surface that raises `#menu-backdrop`
(so a click into the page is already caught in the chrome) dismisses through
`onWindowDeactivated`, never a raw `blur` listener. The trust and permission
popovers are the two documented exceptions: they raise no backdrop, so the
guest-focus blur is what closes them on a click into page content. This is a
claim about every surface, so it is checked as one: `window-deactivation.test.js`
sweeps `lib/` for the modules that call `showMenuBackdrop()` and fails any that
does not also register `onWindowDeactivated` — six today, including both
bookmarks menus.

**A surface that raises the backdrop owns the keyboard too.** The backdrop
makes a menu modal over the page for the *pointer*; `lib/menu-backdrop.js`
does the same for the keyboard, through `onGuestTookKeyboard` — the exact
complement of `onWindowDeactivated`. Without it the guest ack above leaves the
page holding the keyboard under an open menu, and neither Escape (#306) nor
Enter on a row reaches the shell's `document` handlers, so the menu can only be
dismissed with the mouse. The reclaim is deferred one turn of the event loop:
focusing inside the `blur` handler only moves the embedder's `activeElement`
back while the guest still ends up with the keys. `page-context-menu.js` keeps
its own version of this (it is raised from inside the guest and hands focus
back on close, #319).

**Empty states.** Internal pages use the icon + one-line message pattern of
History and Downloads ("No history yet", "No downloads yet").

**Address bar.** Never show a `file://` path; interstitials keep the name the
user typed, error pages keep the requested URL. Tab and history titles come
from the page that is actually shown.

## What CI checks for you (#261 item 1)

These run on every PR that touches `src/renderer/`, the run-freedom harness or
the specs themselves; run them locally before pushing rather than finding out
from a red check.

| Check                           | Command                                            | Catches                                                            |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| Colour literals + brace balance | `npm test -- src/renderer/renderer-styles.test.js` | #223, and any new hard-coded colour                                |
| Theme parity + WCAG contrast    | `xvfb-run -a npm run test:e2e:theme-parity`        | #224, #233, #249 — anything that renders illegibly in either theme |
| Screenshot baselines            | `xvfb-run -a npm run test:e2e:screenshots`         | any unintended repaint of a surface the tour visits                |

Baselines are rendered on Linux and compared on Linux only, and both screenshot
scripts set `FREEDOM_E2E_STABLE_TEXT=1` (Chromium's LCD text antialiasing flips
between subpixel and greyscale as composited layers come and go, which repaints
every glyph). Always run them through the npm script, never a bare
`playwright test`: without that variable the spec skips itself with the script
name as the reason, which is also what keeps the screenshot walk out of a plain
`npm run test:e2e`.

To adopt a change you meant to make: `xvfb-run -a npm run test:e2e:screenshots:update`, then read
`git diff --stat test-e2e/__screenshots__/` before committing. When a CI run
disagrees with a local one, take CI's: download the `renderer-screenshots-diff`
artifact from the failed job and run
`node scripts/apply-screenshot-baselines.js <unzipped-artifact>`.

## Checks before opening or approving a PR that touches the renderer

1. Run the tour from `.claude/skills/run-freedom/` in both themes, or at
   least screenshot the touched surface in both, and attach before/after
   images to the PR.
2. Put the new surface next to its nearest sibling (another settings
   section, another sidebar screen, another internal page) and compare:
   spacing, heading sizes, button styles and verbs, input fonts, empty
   states, focus rings.
3. `grep` the diff for hex/rgb literals; each one needs a token or a light
   override.
4. If a shortcut, count, or permission verb is displayed, check the other
   places that display the same thing.
5. New CSS in an inline `<style>` block: confirm braces balance (an unclosed
   rule silently swallows everything after it, including the light theme; see
   #223).
