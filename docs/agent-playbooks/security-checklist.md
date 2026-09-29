# Security Checklist Playbook

Use this checklist before commit and before creating a PR.

## Sensitive Data

- Ensure no secrets are added (`.env`, API keys, private tokens, credentials).
- Check staged files for accidental secret material.

## Change Risk

- Confirm no debug backdoors or permissive defaults were introduced.
- Confirm access checks and validation logic were not weakened.

## Electron Surface

- A new `ipcMain` channel is chrome-only by default: `src/main/ipc-sender-policy.js`
  refuses it from every tab webview. If `webview-preload.js` must reach it,
  add it to the tier matching its `freedomAPI` guard. `ipc-sender-policy.test.js`
  fails until the two agree.
- Don't weaken the forced guest preferences in `webcontents-setup.js`
  (`will-attach-webview`), the chrome window's navigation/popup lock, or the
  pinned `webPreferences` in `windows/mainWindow.js`.
- Check new findings against `docs/security-audit-electron.md`, and update its
  open items when you close one.

## Dependency and Surface Changes

- Verify new dependencies are necessary and from trusted sources.
- Review network-facing changes for input validation and error handling.

## Final Verification

- Ensure logs and error messages do not expose sensitive information.
- Keep the final diff focused on requested behavior.
