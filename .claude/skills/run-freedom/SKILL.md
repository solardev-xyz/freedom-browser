---
name: run-freedom
description: Launch and drive the Freedom Electron app headlessly (xvfb + Playwright + the in-process test harness), reach specific UI states, and take screenshots. Use when asked to run the app, verify a UI change visually, screenshot a surface, or audit the UI for inconsistencies.
---

Freedom is an Electron app. On a headless Linux box it runs under `xvfb-run`
through Playwright's `_electron` launcher with `FREEDOM_TEST_MODE=1`, which
stubs Ant/IPFS/Radicle/Myotis and the network, so every surface can be reached
in seconds with no live services. Everything here lives in this directory:

- `lib.js` — launch, screenshot, navigate, find a guest page, close menus,
  close the sidebar, harness fixtures, application-menu clicks.
- `recipes.js` — functions that put the app into a state (find bar, permission
  prompt, download shelf, muted tab, private window, settings sections,
  shortcut conflict, wallet Send/dApp/Swarm screens, onchain app + trust
  popover, Tezos interstitials, error page).
- `tour.js` — screenshots every surface above in dark and light theme.

## Prerequisites

Repo deps installed (`npm ci`) and `xvfb-run` available. Node is not on PATH in
some shells: `export PATH="$HOME/.nvm/versions/node/v24.8.0/bin:$PATH"` (or
`~/node/bin`). Scripts outside `node_modules` need
`NODE_PATH=$PWD/node_modules` to resolve `@playwright/test`.

## Run

Full tour (about 4 minutes per theme):

```bash
NODE_PATH=$PWD/node_modules xvfb-run -a -s "-screen 0 1440x900x24" \
  node .claude/skills/run-freedom/tour.js both
```

Screenshots land in `/tmp/freedom-shots/` (override with `SHOTS_DIR`), named
`<d|l>-<nn>-<surface>.png`. The tour never stops on a failed step; it prints
`STEP FAIL <theme> <step> <reason>` and continues, then repeats the list in a
final `N STEP FAIL: ...` line and exits non-zero. Treat any failure as
invalidating the shots after it too — a step that leaves a prompt, menu or
shelf on screen contaminates every later surface.

One state, ad hoc:

```js
const { launch, shot, closeMenus } = require('./.claude/skills/run-freedom/lib');
const r = require('./.claude/skills/run-freedom/recipes');
(async () => {
  const ctx = await launch({ theme: 'light' }); // seeds settings.json
  await r.permissionPrompt(ctx, 'geolocation');
  await shot(ctx.win, 'geo-prompt');
  await ctx.app.close();
})();
```

`launch(seed)` accepts any settings key (`theme`, `showBookmarkBar`,
`shortcutOverrides`, `adblockEnabled`, ...). `theme: 'dark'` removes the
`data-theme` attribute; `'light'` sets it.

## Comparing against a baseline

To tell a regression from a pre-existing quirk, run the same script against
an older tag: `git worktree add /tmp/fb-base v0.8.0`, symlink `node_modules`,
`ant-bin`, `arti-bin`, `myotis-bin`, `radicle-bin`, `native` into it, and run
with `FB_ROOT=/tmp/fb-base`. Remove the worktree afterwards.

## Gotchas (all hit in practice)

- The Nodes and hamburger menus leave `#menu-backdrop` open; `Escape` does
  not close them. Use `closeMenus(win)`.
- Clicking the sidebar's "Get Started" opens the onboarding modal, which then
  blocks every sidebar click. `dismissOnboarding(win)` clicks "Skip for now".
- dApp/Swarm approval prompts are `.sidebar-modal` subscreens covering the
  whole sidebar, `#sidebar-close` included, so the sidebar cannot be closed
  while one is pending. Use `closeSidebar(win)`: it clicks each prompt's Back
  button (which rejects the request) and throws if the sidebar is still open,
  rather than leaving a prompt in every later screenshot. Prompts ignore
  clicks for 500 ms after appearing (input protection), so dismissals retry.
  It returns immediately when the sidebar is already collapsed, so an earlier
  failed step cannot cascade into a timeout on the hidden `#sidebar-close`.
- Keyboard shortcuts only work after clicking the address bar first; native
  menu accelerators never fire from synthetic keys. Use `menuItem(app, id)`
  (`zoom-in`, `zoom-reset`, `new-private-window`).
- Permission prompt buttons must be clicked with `dispatchEvent('click')`;
  a real click right after a guest attaches is swallowed by the guest.
- Guest webviews surface as separate Playwright pages; `pageFor(app,
'settings.html')` finds one. Webview elements are replaced on navigation,
  never cache them.
- Playwright's raw API has no default action timeout; `launch()` sets 8 s so
  a blocked click fails instead of hanging forever.
- Under xvfb `prefers-color-scheme` is always light regardless of
  `nativeTheme`, and the braille drag-handle glyph in Name Resolution renders
  as a box because the font is missing. Neither is a product bug.
- Two app instances at once are fine (separate scratch profiles); the e2e
  suite itself is `workers: 1`.

## Visual audit checklist

When using this to hunt inconsistencies, apply
`docs/agent-playbooks/ui-consistency.md` to every screenshot pair.
