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
class.

**Dismissing on focus loss goes through `lib/window-deactivation.js`.** A
window `blur` in the chrome does not mean the user left the window: a
`<webview>` guest taking the keyboard raises the same event, and every tab
activation hands the page focus (#304) with the guest's ack landing
asynchronously — late enough to tear down a menu the user has just opened and
swallow the click on its way (#328). A surface that raises `#menu-backdrop`
(so a click into the page is already caught in the chrome) dismisses through
`onWindowDeactivated`, never a raw `blur` listener. The trust and permission
popovers are the two documented exceptions: they raise no backdrop, so the
guest-focus blur is what closes them on a click into page content.

**Empty states.** Internal pages use the icon + one-line message pattern of
History and Downloads ("No history yet", "No downloads yet").

**Address bar.** Never show a `file://` path; interstitials keep the name the
user typed, error pages keep the requested URL. Tab and history titles come
from the page that is actually shown.

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
