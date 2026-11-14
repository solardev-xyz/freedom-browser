# Design system

The chrome and the internal pages paint from one set of tokens and draw their controls from one sheet of shared blocks. Tracking issue: [#1198](https://github.com/solardev-xyz/freedom-browser/issues/1198). Screens move onto it one pull request at a time; until a screen has moved, its old styles keep working.

| File                                        | What it holds                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/renderer/pages/styles/tokens.css`      | Colours for both themes, the private window and the Tor window, plus the spacing, radius, type and control-height scales             |
| `src/renderer/pages/styles/ui.css`          | The twelve `ui-` blocks                                                                                                              |
| `src/renderer/pages/ui-catalog.html`        | Every block and variant in both themes, side by side. `npm run ui:catalog`, or open the file in any browser. Not in packaged builds. |
| `src/renderer/design-system-inventory.json` | What the renderer still does outside the system, per file; it may only shrink                                                        |

The chrome loads both sheets through `styles.css`. An internal page links them, `styles/tokens.css` then `styles/ui.css`, when it migrates (see below).

## Tokens

Dark is the default; `data-theme='light'` switches a document, or any element's subtree. Colours are the chrome's palette.

| Token                                                    | Use it for                                            |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `--surface-canvas`                                       | window and page background                            |
| `--surface`                                              | sidebar, toolbar, panels                              |
| `--surface-raised`                                       | menus, popovers, modals                               |
| `--surface-inset`                                        | a detail card or well inside a surface                |
| `--surface-hover`                                        | hover fill of rows and secondary buttons              |
| `--text`, `--text-strong`                                | body text; headings and values                        |
| `--text-muted`, `--text-faint`                           | secondary labels; hints, placeholders, disabled text  |
| `--text-on-accent`                                       | text on a filled accent (dark text in the dark theme) |
| `--border`, `--border-strong`                            | default lines; emphasised and dashed lines            |
| `--accent`, `--accent-hover`, `--accent-soft`            | the primary action, links, selection                  |
| `--danger`, `--warning`, `--success` (each with `-soft`) | status colour, and its tinted background              |
| `--info-soft`                                            | a neutral notice's background                         |
| `--focus-ring`                                           | the focus outline                                     |
| `--shadow-raised`, `--shadow-overlay`                    | elevation                                             |

Scales: `--space-1` to `--space-6` (4 to 24px), `--radius-sm|md|lg|xl|pill` (4, 6, 8, 12, 999px), `--font-size-xs` to `--font-size-display` (11, 12, 13, 14, 16, 20, 28px), `--control-xs|sm|md|lg` (24, 28, 36, 44px). Sizes are `--font-size-*` because `--text-*` names are colours.

Three things to know:

- **A token that refers to another resolves where it is declared.** `--a: var(--b)` on `:root` keeps the root's `--b` even inside a nested `data-theme` or the private window, so such tokens are declared on every theme scope (the alias block at the end of `tokens.css`).
- **On an internal page, `tokens.css` wins over `theme.css`.** Its `:root` selector is more specific than `theme.css`'s `html`, so where both define a name (`--text`, `--accent`, `--border`…) the chrome's value applies. That is why a page links `tokens.css` only when it migrates, and why the six pages on GitHub's palette change colour then.
- **Old names stay valid until their screens move.** `variables.css` keeps the chrome's names (`--toolbar`, `--muted`, `--menu-bg`…), `theme.css` keeps the pages' (`--shell-*`, `--bg-card`…), and seven names `sidebar.css` used without any definition (`--foreground`, `--hover`…) are aliases in `tokens.css`. A migrated screen uses none of them.

## Blocks

Every class starts with `ui-`; variants are `--modifier`, parts are `__part`. The catalog shows the markup for each.

| Block            | Variants and parts                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui-button`      | `--primary` (filled accent, one per screen), `--danger` (outlined), `--ghost`; `--sm`, `--lg`, `--block`. The bare class is the secondary button.                              |
| `ui-button-row`  | `--end`. Secondary first, primary last; equal widths unless `--end`.                                                                                                           |
| `ui-icon-button` | `--sm` (24px), default (28px), `--lg` (36px); `--round`, `--danger`. Always with an `aria-label`.                                                                              |
| `ui-card`        | `--inset`, `--interactive`; `__title`                                                                                                                                          |
| `ui-detail-list` | a `<dl>` of label and value rows; `--mono`, or `<code>` in a value                                                                                                             |
| `ui-callout`     | `--info`, `--warning`, `--danger`, `--success`; `__icon`, `__body`, `__title`, `__action`                                                                                      |
| `ui-badge`       | `--accent`, `--success`, `--warning`, `--danger`                                                                                                                               |
| `ui-field`       | `__label`, `__control` (input, select, textarea), `__help`, `__error`; `--invalid`, `--sm`                                                                                     |
| `ui-list-row`    | `--interactive`, `--selected`; `__icon`, `__main`, `__title`, `__subtitle`, `__meta`, `__actions`                                                                              |
| `ui-sheet`       | a sidebar sub-screen's content under `.subscreen-header`: `__body`, `__footer`; `--approval` (44px buttons, `__origin` with `__origin-icon`, `__origin-name`, `__origin-note`) |
| `ui-page-header` | `__title` (the shared 28px accent title with its icon), `__count`, `__actions`, `__subtitle`. A Clear action is disabled while there is nothing to clear.                      |
| `ui-empty-state` | `__icon`, `__title`, `__text`, and an optional button                                                                                                                          |

## Rules

1. **Use a block.** A screen never styles its own button, card, badge, callout or field.
2. **Never restyle a block from a screen's stylesheet.** If no block or variant fits, add a variant to `ui.css` in the same pull request, and show it in the catalog.
3. **Colours come from `tokens.css`.** A literal is allowed only with a `/* theme-literal: <reason> */` annotation, for brand and status colours that are not surfaces.
4. **Font sizes, radii and control heights come from the scales.**
5. **Focus is never removed without a ring.** Every block draws `--focus-ring` on `:focus-visible`.

The Agent UI is outside these rules: its stream owns that look and adopts the shared tokens when it chooses.

## Moving a screen

1. On an internal page, link `styles/tokens.css` and `styles/ui.css` and stop linking the page's palette from `theme.css`.
2. Replace the screen's own classes with blocks, and its old token names with tokens. Delete the CSS that is no longer used.
3. Run `npm run ui:inventory -- --write`. The inventory must shrink; it refuses to grow.
4. Run `npm run styles:inventory -- --write` if colour literals went away.
5. Attach before and after screenshots in both themes (the PR template), and refresh the screenshot baselines from the CI artifact (`node scripts/apply-screenshot-baselines.js <artifact>`).

## How it is enforced

| Test                                                                          | Checks                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/design-system.test.js`                                          | the token sets match across themes; the blocks paint only from tokens and the scales; no other sheet restyles a `ui-` class; the catalog shows every block; and the inventory, both ways: nothing new, nothing stale |
| `src/renderer/styles/theme-tokens.test.js`                                    | no `var(--token)` the chrome paints from is undefined, with or without a fallback                                                                                                                                    |
| `src/renderer/renderer-styles.test.js`                                        | the colour-literal ratchet (#261), with `tokens.css` as a token file                                                                                                                                                 |
| `src/renderer/styles/destructive-buttons.test.js`, `approval-primary.test.js` | danger buttons are outlined and primaries filled accent, `ui.css` included                                                                                                                                           |

The inventory's four sections: `legacyClasses` (block-like classes a sheet styles itself), `oldTokens` (names `tokens.css` does not define), `literalSizes` (`font-size` and `border-radius` as lengths) and `bareOutlines` (outlines removed with no ring for the same selector). The last is a list of candidates, not proven bugs: a chrome field that drops its outline at rest still gets the shared ring from `styles/inputs.css`, so check each one when its screen migrates.
