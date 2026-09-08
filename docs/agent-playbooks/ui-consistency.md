# UI Consistency Playbook

Read this before changing anything under `src/renderer/` (chrome, sidebar,
internal pages, settings) and when reviewing such a change. It encodes the
conventions the UI already follows so new surfaces match their siblings, and
it lists the checks that catch drift. It was distilled from the visual audit
of the 0.8.5 cycle (issues #223–#242).

## Conventions

**Tokens, not literals.** Colours come from `src/renderer/styles/variables.css`
(`--bg`, `--toolbar`, `--border`, `--text`, `--muted`, `--accent`, `--danger`,
`--secure-fg`, `--warning-fg`, `--menu-bg`, `--modal-bg`). A hard-coded colour
needs a matching `[data-theme='light']` override in `light-theme.css` (chrome)
or in the page's own light block (internal pages). Every new rule in
`settings.html` that sets a dark background must appear in the
`@media (prefers-color-scheme: light)` block too; `settings-styles.test.js`
enforces this.

**Both themes, always.** Every surface renders in dark and light. The chrome
reads the theme from `data-theme` on `<html>`; internal pages must follow the
same Appearance setting (see #233), not only the OS scheme.

**Inputs.** One focus treatment for chrome text inputs (address bar, find bar,
modal and sidebar inputs). Monospace (`.rpc-input` in settings) is for URLs,
hashes and keys; search boxes and names use the sans font.

**Buttons.** Primary action filled `--accent`, secondary outlined, destructive
outlined `--danger` ("Clear All", "Remove all", "Restore defaults"). The same
action uses the same verb everywhere (a remembered permission is _removed_
in every surface; a dApp request is _rejected_). Swarm approval screens use
the orange primary deliberately; do not spread it to non-Swarm screens.

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
