## Summary

<!-- What changed, why it is needed, and what users or developers will notice. -->

## Related issue

<!-- Use "Closes #123" when the PR should close an issue. -->

## Verification

<!-- List the checks you actually ran. Do not check a box for a check you did not run. -->

- [ ] `npm run lint`
- [ ] Relevant unit tests
- [ ] Relevant Playwright or live smoke tests
- [ ] `npx prettier --check` on changed files
- [ ] `git diff --check`

## Visual changes

<!--
Anything under `src/renderer/` (chrome, sidebar, internal pages, settings):
before/after screenshots of every surface you touched, in **both themes** —
required, not optional. Nothing else renders the light theme, which is how a
month of dark-only Settings (#223) and a white-on-white sidebar (#249) shipped.

The repo's own driver takes them:

    NODE_PATH=$PWD/node_modules xvfb-run -a -s "-screen 0 1440x900x24" \
      node .claude/skills/run-freedom/tour.js both   # every surface, both themes

or `.claude/skills/run-freedom/recipes.js` for a single state. Then walk
docs/agent-playbooks/ui-consistency.md — it lists the conventions the new
surface has to match (heading sizes, button style and verb, input font, focus
ring, empty state, counters, shortcut label format) and the checks that catch
drift.

Anywhere else: screenshots or recordings if there is anything to see, or write
"Not applicable."
-->

- [ ] Touches `src/renderer/` — before/after screenshots in dark **and** light
      are attached above, and the UI consistency playbook
      (https://github.com/solardev-xyz/freedom-browser/blob/main/docs/agent-playbooks/ui-consistency.md)
      has been applied to the diff
- [ ] Does not touch `src/renderer/`

## Security and privacy

<!-- Note permission, IPC, network, storage, wallet, or sensitive-data impact, or write "No change." -->

## AI assistance

<!-- Disclose material AI assistance and confirm that you reviewed, understood, and verified the submitted work. -->
