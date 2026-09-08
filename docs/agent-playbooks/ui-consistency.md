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
`playwright test`.

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
