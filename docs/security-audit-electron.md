# Electron security audit (2026-09)

Audit of Freedom's Electron surface against the
[Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
and a browser threat model: **every tab renderer is hostile**. Tabs load
untrusted `https:`, `bzz:`, `ipfs:`/`ipns:`, `rad:`, `web3:` and `.onion`
content, and the same app holds a wallet, so the question for each surface is
what a hostile page — or a page that has a renderer exploit and can therefore
send any IPC message its process can reach — can make the main process do.

- **Baseline:** `main` at `2983dc62` (Electron **44.4.5**, electron-builder
  26.15.3).
- **Method:** static review of `src/main/**`, the preloads, the chrome
  renderer and the internal pages. Three findings were checked in the real
  Electron 44.4.5 binary (noted *verified* below) and the fixes were checked
  against a packaged Linux build.
- **Scope of the fixes in this PR:** config flags, missing sender checks and
  missing handlers only. Wallet key storage, ENS trust logic and anything that
  needs a product decision are listed under [Open items](#open-items) and are
  not changed.

Line numbers are for the tree this PR produces. For the open items, they are
for the unchanged files.

## Summary

| ID | Severity | Area | Status |
| --- | --- | --- | --- |
| [E-1](#e-1-no-main-side-sender-checks-on-ipc) | Critical\* | IPC sender validation | **Fixed** |
| [E-2](#e-2-the-chrome-window-can-be-navigated-away-from-indexhtml) | High | Navigation / window-open | **Fixed** |
| [E-3](#e-3-will-attach-webview-enforces-nothing) | Medium | `will-attach-webview` | **Fixed** |
| [E-4](#e-4-chrome-window-webpreferences-rely-on-defaults) | Low | `webPreferences` | **Fixed** |
| [E-5](#e-5-electron-fuses-left-at-defaults) | Medium | Fuses | **Fixed** (NodeOptions); rest in O-4 |
| [E-6](#e-6-security-webrequest-guards-fail-open) | Low | Protocol guards | **Fixed** |
| [E-7](#e-7-rad-browserhtml-has-no-csp) | Medium | CSP | **Fixed** |
| [O-1](#o-1-web-pages-can-drive-the-local-ant-api-verified) | High | Loopback node API | **Fixed** in [#445](https://github.com/solardev-xyz/freedom-browser/pull/445) (hard block) |
| [O-2](#o-2-bzz-forwards-any-method-and-most-headers-to-the-node) | Medium | `bzz:` handler | **Fixed** in [#445](https://github.com/solardev-xyz/freedom-browser/pull/445) |
| [O-3](#o-3-gateway-form-ipfs-urls-share-one-origin) | Medium | `ipfs:` origin confusion | **Fixed** in [#441](https://github.com/solardev-xyz/freedom-browser/pull/441) |
| [O-4](#o-4-remaining-fuses) | Medium | Fuses | **Partly fixed** in [#447](https://github.com/solardev-xyz/freedom-browser/pull/447): NodeCliInspect off, asar integrity + OnlyLoadAppFromAsar on. Still open ([#431](https://github.com/solardev-xyz/freedom-browser/issues/431)): RunAsNode (needs a Myotis supervision redesign), cookie encryption, file-protocol privileges |
| [O-5](#o-5-script-src-unsafe-inline-on-internal-pages) | Medium | CSP | **Fixed** in [#444](https://github.com/solardev-xyz/freedom-browser/pull/444) |
| [O-6](#o-6-sub-frame-provider-requests-are-attributed-to-the-top-page) | Medium | Provider bridges | **Fixed** in [#440](https://github.com/solardev-xyz/freedom-browser/pull/440) |
| [O-7](#o-7-wallet-signing-has-no-main-side-confirmation) | Medium | Wallet | **Fixed** in [#446](https://github.com/solardev-xyz/freedom-browser/pull/446) |
| [O-8](#o-8-quick-unlock-returns-the-vault-password-to-the-renderer) | Medium | Wallet key storage | **Fixed** in [#446](https://github.com/solardev-xyz/freedom-browser/pull/446) |
| [O-9](#o-9-external-protocol-denylist-misses-network-share-schemes) | Low | `shell.openExternal` | **Fixed** in [#443](https://github.com/solardev-xyz/freedom-browser/pull/443) |
| [O-10](#o-10-no-select-client-certificate-handler) | Low | TLS client certs | **Fixed** in [#443](https://github.com/solardev-xyz/freedom-browser/pull/443) |
| [O-11](#o-11-macos-hardened-runtime-entitlements) | Low | macOS signing | **Fixed** in [#443](https://github.com/solardev-xyz/freedom-browser/pull/443), pending a signed macOS release run |
| [O-12](#o-12-smaller-items) | Low / Info | Various | **Fixed** in [#441](https://github.com/solardev-xyz/freedom-browser/pull/441), [#443](https://github.com/solardev-xyz/freedom-browser/pull/443), [#445](https://github.com/solardev-xyz/freedom-browser/pull/445) (fingerprinting Info item kept by decision) |

\* Critical if a tab renderer is compromised. Without a renderer exploit, the
preload guards already kept web pages away from these channels.

## What is already done well

- **Tab webviews** request `contextIsolation`, `sandbox`, `nodeIntegration=no`
  and `webSecurity` (`src/renderer/lib/tabs.js:513-516`), and main now
  enforces these (E-3). No `@electron/remote`, no `nodeIntegration` anywhere,
  no `disable-web-security`, no `allowRunningInsecureContent`, and no
  `executeJavaScript` with page-derived strings in main.
- **The preload surface is narrow.** `webview-preload.js` exposes no
  `ipcRenderer`, no generic `invoke(channel)` passthrough, and never passes an
  `IpcRendererEvent` to page callbacks. `freedomAPI` checks the page
  (`file:` plus an allowlisted page name) on every call, not once at load
  (`webview-preload.js:210-275`). Sub-frames stop right after the adblock
  scriptlet step (`:183-185`). Wallet providers are top-frame only and are
  off in private windows. Request origins come from the preload, not from the
  page. `preload.js` (chrome) has fixed channels only, and every listener
  strips the event.
- **Popups:** every tab `window.open` is denied and re-routed as a tab
  (`webcontents-setup.js:230`). `web3:` pages can neither open windows nor
  navigate away (`:239`, `:293`).
- **Permissions:** unknown permissions are denied on both the request path and
  the check path (`permissions-manager.js:1017-1020`, `:1080`). The handlers
  are installed on the default session and on every private partition
  (`index.js`, `private-windows.js:194`). HID, serial, USB and display capture
  all fall through to deny. Ledger uses `node-hid` from main, not WebHID.
- **Certificates:** there is no `certificate-error` override, no
  `setCertificateVerifyProc` and no `ignore-certificate-errors`, so Chromium's
  default (reject) stands.
- **Custom protocols:** no `bypassCSP` anywhere, and no `file:` interception.
  `web3:` is registered without service workers. Upstream URLs are built from
  a fixed base plus a validated host (hex ref / CID / RID / name regex), so
  userinfo, ports and `..` in a page URL can't redirect the fetch. Redirects
  are manual. `rad:` is GET/HEAD-only with a segment decoder that rejects `.`,
  `..` and encoded separators. `radapi:` and `web3:` are gated by frame
  attribution in `onBeforeRequest`, not by `Origin`/CORS.
- **`shell.openExternal`** has one call site (`external-protocol.js:273`),
  behind a scheme denylist, a user-gesture check and a per-site prompt.
- **DevTools:** the "App Developer Tools" menu item exists only in unpackaged
  builds (`menu.js:485`, `:636`).
- **Electron version:** 44.4.5 is the current `latest` on npm as of
  2026-09-28. Electron 44.0.0 shipped 2026-08-25 and 45 is still in alpha, so
  the app is on the newest supported major.

## Fixed in this PR

### E-1 No main-side sender checks on IPC

**Critical\*** · `src/main/ipc-sender-policy.js`, `src/main/index.js:1-10`

**Finding.** Main checked who was calling on only a handful of channels:

- myotis recovery (`myotis-manager.js:783-791`);
- profile mutations, and only by path suffix (`ipc-handlers.js:129-138`);
- `clipboard:read-text` (`ipc-handlers.js:1022`).

Every other restriction lived in the renderer, in `webview-preload.js`'s
`guardInternal` / `guardSettingsPage`. Every tab, including hostile pages and
their iframes (`nodeIntegrationInSubFrames`), runs that preload and so holds a
real `ipcRenderer`. A renderer exploit skips the guards and calls, for example:

- `wallet:send-transaction`, `wallet:sign-message`,
  `wallet:sign-typed-data` and the Safe handlers
  (`wallet/wallet-ipc.js:236-477`). While the vault is unlocked, these sign
  and broadcast with no prompt: the confirmation UI lives in the chrome
  (see O-7).
- `identity:export-mnemonic` / `export-private-key` / `unlock` (unlimited
  password guessing), and `delete-vault` / `import-mnemonic`
  (`identity-manager.js:1441-1667`).
- `quick-unlock:unlock`, which returns the plaintext vault password after a
  Touch ID prompt (`quick-unlock.js:268`, `:223`).
- Self-granted permissions:
  - `dapp:grant-permission` and `dapp:add-tx-auto-approve`
    (`wallet/dapp-permissions.js:355-391`);
  - the Swarm and Radicle grants;
  - `x402:update-permission` spending caps;
  - `permissions:prompt-response`, where prompt ids are sequential
    (`permissions-manager.js:139`, `:715`), so a tab can answer its own
    camera, mic or openExternal prompt with `allow` + `remember`.
- `swarm:provider-execute` / `radicle:provider-execute` with a forged
  `origin` argument.
- `swarm:publish-file` / `publish-directory` with any path
  (`swarm/publish-service.js:266`, `:292`). That uploads `~/.ssh` or the vault
  directory to public Swarm and returns the reference.
- `downloads:open-file`, which runs `shell.openPath` on a file the page just
  downloaded (`downloads/downloads-manager.js:481-489`).
- Stamp purchases, settings, network RPC endpoints, and node start/stop.

**Exploit.** A Chromium renderer bug in any tab (a routine class of bug for a
browser) → `ipcRenderer.invoke('wallet:send-transaction', {to: attacker, …})`
→ funds gone, no prompt.

**Fix.** A central policy, installed on `ipcMain` before any module registers
a handler, so that no present or future handler escapes it:

- The **chrome renderer** may call every channel. It must be the top frame of
  *this* build's `renderer/index.html` in a `window`-type webContents, with
  the path compared exactly via `fileURLToPath`.
- A **tab webview** may call only the channels `webview-preload.js` actually
  uses, at the tier its guard implies:
  - *public*: adblock and document-start bootstrap, any frame;
  - *internal*: the top frame of an allowlisted file in this build's
    `renderer/pages/`;
  - *settings*: `settings.html` only;
  - *profile manager*: `settings.html` or `profiles.html`.

  Every wallet, identity, quick-unlock, permission-grant, provider-execute,
  x402, stamp, node and window channel is therefore chrome-only.
- **Anything else** is refused: other webContents types, sub-frames, frames
  that have already navigated away, and look-alike `…/pages/settings.html`
  files elsewhere on disk.

A refused `invoke` rejects. A refused `sendSync` gets `null`, so the caller
never hangs. The log carries the channel and the sender type/scheme, never
the URL.

`ipc-sender-policy.test.js` parses `webview-preload.js` and fails if a
channel is added there without a tier, is given a different tier from its
guard, or if a tier grants a channel the preload no longer uses.
Mutation-checked in both directions: removing a channel and changing a
channel's tier each fail the suite.

### E-2 The chrome window can be navigated away from index.html

**High** · `src/main/webcontents-setup.js:152-169`, `:202-204`;
`src/renderer/lib/wallet/safe-signing.js:650-666`

**Finding.** `will-navigate` and `setWindowOpenHandler` were installed only
for `webview` contents. The chrome `BrowserWindow`, which runs `preload.js`
with `window.wallet`, `window.identity` and `window.quickUnlock`, had neither.

**Exploit.** A page asks the user to "drag this link to your bookmarks bar".
The user drops it on the toolbar instead of the webview, and Chromium's
default drop behaviour navigates the whole chrome window to the attacker's
URL, with the privileged preload attached. A local `.html` file dropped the
same way does the same. Separately, the Safe "View on explorer" link
(`safe-signing.js`, `target="_blank"`, no handler) opened a new
`BrowserWindow` from the chrome window instead of a tab.

**Fix.**
- The chrome window denies every `will-navigate`, every `will-redirect` and
  every window open. It never navigates itself; tabs navigate inside their
  webviews, and a reload is not a navigation event.
- The Safe explorer link now opens a tab, like the Send screen's link
  already did (`wallet/send.js:242`).

### E-3 `will-attach-webview` enforces nothing

**Medium** · `src/main/webcontents-setup.js:116-150`, `:197-200`

**Finding.** The handler only set `nodeIntegrationInSubFrames`. The guest's
`sandbox`, `contextIsolation`, `nodeIntegration`, `webSecurity` and `preload`
came solely from the renderer-written `webpreferences` and `preload`
attributes (`tabs.js:513-521`).

**Exploit.** A compromised or navigated chrome renderer attaches a
`<webview nodeintegration webpreferences="contextIsolation=no,sandbox=no">`,
or one with a different preload file, and gets Node in a guest.

**Fix.** Main now forces:

- `nodeIntegration`, `nodeIntegrationInWorker`, `allowRunningInsecureContent`
  and `experimentalFeatures` off;
- `contextIsolation`, `sandbox` and `webSecurity` on;
- `enableBlinkFeatures` dropped.

It also pins the preload to `src/main/webview-preload.js` for any guest that
asked for one, rather than trusting the path it asked for.

### E-4 Chrome window `webPreferences` rely on defaults

**Low** · `src/main/windows/mainWindow.js:66-81`

**Finding.** `sandbox` was not set, relying on Electron ≥ 20's default, and
the no-op `enableRemoteModule` was set.

**Fix.**
- `sandbox`, `contextIsolation` and `webSecurity` are now pinned on
  explicitly.
- `nodeIntegration`, `nodeIntegrationInWorker`,
  `nodeIntegrationInSubFrames`, `allowRunningInsecureContent` and
  `experimentalFeatures` are pinned off.
- `preload.js` only requires `electron`, so it was already
  sandbox-compatible and nothing about its behaviour changes.

`index.html`'s CSP also gains `base-uri 'none'` (`src/renderer/index.html:9`).
`default-src 'self'` does not cover `<base>`.

### E-5 Electron fuses left at defaults

**Medium** · `package.json` `build.electronFuses`

**Finding.** No fuses were configured.

**Exploit.** Local code running as the user can start the signed app with
`NODE_OPTIONS=--require evil.js`. That runs attacker code inside Freedom's
signed identity, with its keychain items (the quick-unlock `safeStorage`
secret) and its macOS camera and microphone grants.

**Fix.** electron-builder 26 flips fuses before signing. This PR sets:

- `EnableNodeOptionsEnvironmentVariable` **off**;
- `resetAdHocDarwinSignature` on, so an unsigned `workflow_dispatch` arm64
  build still launches;
- `RunAsNode` and `EnableNodeCliInspectArguments` left **on** explicitly, for
  the reasons in O-4.

**Verified** on a local `electron-builder --linux dir` build:

- `npx @electron/fuses read` reports the fuse flipped.
- The packaged binary runs normally with `NODE_OPTIONS=--require
  /nonexistent.js`, which crashes the un-fused dev Electron.
- `ELECTRON_RUN_AS_NODE=1` still works, which Myotis needs.
- The `packaged` Playwright project, which attaches over `--inspect`, passes
  10/10 against that build.

### E-6 Security webRequest guards fail open

**Low** · `src/main/webrequest-dispatcher.js:36-43`, `:73-80`, `:88-96`

**Finding.** The dispatcher logs and *skips* any `onBeforeRequest` handler
that throws. That was deliberate for adblock, but it applies equally to
`radapi-guard` and `onchain-app-guard`. Those two are the only things keeping
web content away from private Radicle data and the `web3:` approval token.

**Fix.** `registerWebRequestHandler(…, { failClosed: true })`: a throw from
such a handler cancels the request. Both guards now register with it
(`radicle-api-protocol.js:372-374`, `onchain-app-protocol.js:572-574`). Other
handlers keep the skip-on-throw behaviour.

### E-7 `rad-browser.html` has no CSP

**Medium** · `src/renderer/pages/rad-browser.html:5-15`

**Finding.** It was the only internal page without a CSP. It writes remote
repository data (README through marked → DOMPurify, and hand-escaped file
names and commit messages) into `innerHTML`, and it runs with `freedomAPI`.

**Exploit.** Any escaping slip in `scripts/rad-browser.js` becomes script
execution on an internal page.

**Fix.** A script-only policy:
`script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
`connect-src`, `img-src` and `style-src` stay open, because the page reads
`radapi:`, public seeds and README images, and uses inline styles. The page
has no inline scripts, no inline handlers and no `eval`.

## Open items

> **Status update:** every open item below has since been addressed in a follow-up PR (see the Summary table). The sections are kept as the original findings; only the parts of O-4 listed in the table remain open, tracked in [#431](https://github.com/solardev-xyz/freedom-browser/issues/431).


These need a product decision, a larger change, or they touch areas this PR
must not change.

### O-1 Web pages can drive the local Ant API (verified)

**High** · `src/main/ant-manager.js:209-215`;
`src/main/adblock/request-classifier.js:48-56`

**Finding.** Nothing stops web content from sending requests to
`http://127.0.0.1:<ant-api-port>`. The adblock classifier exempts loopback on
purpose. The Ant API serves its admin endpoints (`/stamps`, `/chequebook`,
`/wallet`, `/stake`) on the same port.

**Verified.** In Electron 44.4.5, a page on a secure custom scheme (`bzz://`)
and a page on `https://example.com` both got
`fetch('http://127.0.0.1:<port>/stamps/1/17', {method:'POST', mode:'no-cors'})`
through to a loopback server. There was no Local Network Access prompt and
the permission handler was never consulted.

**Exploit.** Any site buys postage batches, or otherwise moves funds, through
a light-mode node with no user interaction.

The node's `cors-allowed-origins: "null"` (`ant-manager.js:215`), which is
there for the chrome's `file:` origin, also lets any `data:` frame or
sandboxed iframe (origin `null`) *read* API responses. A leftover
`cors-allowed-origins: "*"` in `identity/injection.js:169` is overwritten on
the next Ant start but should go.

**Why open.** The obvious fix is an `onBeforeRequest` guard: cancel requests
from tab webviews to the node API origin, except top-level GET navigations
and internal pages. But some Swarm dApps are written against a local Bee at
`localhost:1633`, and a guard would break them in favour of `window.swarm`.
That is a product call.

**Recommendation.**
- Ship the guard (the chrome and main-process fetches carry no webview
  attribution and are unaffected).
- Move the chrome's direct Ant calls behind IPC, then drop `"null"` from the
  CORS list.
- Enable Ant API auth if it gains one.

### O-2 `bzz:` forwards any method and most headers to the node

**Medium** · `src/main/swarm/bzz-protocol.js:88-115`, `:454-466`

**Finding.** Every method, with its body, and every request header outside a
short strip list goes to `${antApi}/bzz/<ref>/<path>`. Chromium does not
enforce CORS on custom schemes, so any page can read any `bzz:` response and
set arbitrary `Swarm-*` headers.

**Speculative.** If Ant implements ACT, a page could send `Swarm-Act*`
headers to have *this node's key* decrypt ACT-protected content. Encoded
`%2F`/`%5C` pass through unchanged; whether Ant's router can be steered out
of `/bzz/` with them is unconfirmed.

**Recommendation.**
- Allow only GET/HEAD, as `rad:` does, unless a dApp use case for writes
  through `bzz:` is intended.
- Allowlist forwarded headers (`Range`, `If-*`, `Accept*`).
- Reject encoded separators in the path.

### O-3 Gateway-form `ipfs:` URLs share one origin

**Medium** · `src/main/ipfs/ipfs-protocol.js:182-218`, `:361-387`

**Finding.** `ipfs://localhost/ipfs/<cidA>/` and
`ipfs://dweb.link/ipns/<name>/` serve content under the *gateway host's*
origin. Every CID loaded that way therefore shares localStorage, IndexedDB and
cookies. The same goes for any `*.localhost` host. Top-level navigations are
rewritten by the renderer (PR #352), but `will-navigate` doesn't fire for
iframes, so `<iframe src="ipfs://localhost/ipfs/<evil>/">` runs in the shared
origin.

**Recommendation.** Answer gateway-form URLs with a redirect to the canonical
`ipfs://<cid>/…`, or refuse them for document requests. This interacts with
the gateway-form bookmark handling from #352, so it needs care.

### O-4 Remaining fuses

**Medium** · `package.json` `build.electronFuses`

Left at their defaults, each for a stated reason:

- **`RunAsNode`: on.** `myotis-process.js:19`, `:78-81` runs the Myotis child
  under `ELECTRON_RUN_AS_NODE=1`, and `scripts/qualify-myotis-supervisor.js:25`
  asserts it. Turning it off first needs Myotis moved to
  `utilityProcess.fork`.
- **`EnableNodeCliInspectArguments`: on.** Playwright's `_electron.launch`
  attaches over `--inspect`, and `release.yml`'s smoke legs drive every
  shipped artifact that way (the `packaged` / `packaged-live` projects).
  Turning it off needs another way to smoke-test packaged builds.
- **`EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar`: off.**
  Recommended, as a pair. They need a signed macOS and Windows release run to
  validate, and the macOS pipeline has never run end-to-end (see
  `release-mac.yml`).
- **`EnableCookieEncryption`: off.** Turning it on moves cookies into the OS
  keychain or keyring. That brings a macOS keychain prompt and a migration
  for existing profiles, which is a product decision.
- **`GrantFileProtocolExtraPrivileges`: on.** The chrome and every internal
  page are `file://`. Turning it off means serving them from a custom scheme
  first.

### O-5 `script-src 'unsafe-inline'` on internal pages

**Medium**

**Finding.** `settings.html`, `history.html`, `downloads.html`,
`payments.html`, `links.html`, `profiles.html`, `error.html` and
`protocol-test.html` allow inline script. history, downloads and payments
render site-controlled strings (titles, URLs, filenames). No page other than
`rad-browser.html` and `index.html` sets `base-uri`.

**Recommendation.** Move the inline scripts into files, then drop
`'unsafe-inline'` from `script-src` and add `base-uri 'none'` everywhere.
That is a refactor per page, not a flag change.

### O-6 Sub-frame provider requests are attributed to the top page

**Medium** (needs a compromised iframe renderer) ·
`src/renderer/lib/dapp-provider.js:558`, `swarm-provider.js:50`,
`radicle-provider.js:55`

**Finding.** The preload returns early in sub-frames, but with
`nodeIntegrationInSubFrames` a compromised cross-origin iframe process still
has `ipcRenderer.sendToHost`. The chrome's `ipc-message` listeners don't check
which frame sent the message. A `dapp:provider-request` from an ad iframe is
therefore handled under the tab's permission key and its wallet grants.

**Recommendation.** Drop `ipc-message` events that did not come from the
guest's main frame. That needs a main-frame id the renderer can compare
against, which Electron exposes only indirectly. The Swarm bridge also lacks
the navigation-generation check that `dapp-provider.js:566-574` has
(`swarm-provider.js:48-56`, Low).

### O-7 Wallet signing has no main-side confirmation

**Medium** · `src/main/wallet/wallet-ipc.js:60-76`

**Finding.** `handleSendTransaction` signs and broadcasts as soon as it is
called. The user's approval exists only in chrome UI state. E-1 closes the
path from web content, but main still trusts the chrome completely.

**Recommendation.** If the chrome itself is ever in scope, main should own a
confirmation token bound to what the user approved (to, value, data,
chainId). That is a wallet architecture decision.

### O-8 Quick unlock returns the vault password to the renderer

**Medium** · `src/main/quick-unlock.js:223`, `:268`

**Finding.** After Touch ID, `quick-unlock:unlock` hands the plaintext vault
password to the chrome renderer, which then unlocks through
`identity:unlock`. E-1 makes it chrome-only.

**Recommendation.** Unlock in main and never return the secret. This is key
storage, so it is out of scope here.

### O-9 External-protocol denylist misses network-share schemes

**Low** · `src/main/external-protocol.js:95-120`

**Finding.** `smb:`, `cifs:`, `nfs:`, `afp:`, `webdav:`, `ms-settings:`,
`itms-services:`, `ldap:` and `ftp:` are not on the denylist. Page launches
need a main-frame request, a user gesture and a per-site prompt. Behind that
prompt, though, `smb://attacker/share` can leak NTLM hashes on Windows.

**Recommendation.** Deny the network-share schemes outright. Which schemes
users should still be able to launch is a product call.

### O-10 No `select-client-certificate` handler

**Low**

**Finding.** Electron's default silently picks the first matching client
certificate, which can be used to identify users across sites.

**Recommendation.** Add a prompt, or at least never auto-select for private
windows. This is UX.

### O-11 macOS hardened-runtime entitlements

**Low** · `config/entitlements.mac.plist:5-9`

**Finding.** `allow-jit`, `allow-unsigned-executable-memory` and
`disable-library-validation` are all granted. `allow-jit` is required for V8.
The other two widen what an injected dylib can do.

**Recommendation.** Check whether the native addons (Myotis, libradicle,
freedom-ipfs, better-sqlite3) still need `disable-library-validation` once
they are signed with the team ID, and drop
`allow-unsigned-executable-memory` if V8's JIT entitlement is enough.

### O-12 Smaller items

- **Low:** the IPFS native path forwards non-GET methods that have no body
  (`ipfs-protocol.js:626`, `if (body)` instead of a method check). There is
  no reachable escape; returning 405 for anything other than GET/HEAD would
  match `rad:`.
- **Low:** upstream `Set-Cookie`, `Service-Worker-Allowed` and CSP headers
  from a *user-configured* external Ant or IPFS gateway reach the page as-is
  (`bzz-protocol.js:465`). Consider stripping `Set-Cookie` and
  `Service-Worker-Allowed`.
- **Low:** synthetic `.click()` on a dweb-scheme `target=_blank` link opens a
  tab without a user gesture (`webview-preload.js:452-513`; `isTrusted` is
  checked only for `web3:`). This bypasses the popup blocker for dweb links.
  Consider requiring `isTrusted || navigator.userActivation.isActive`.
- **Low:** `permissions:prompt-response` doesn't bind the responder to the
  window that owns the prompt, and ids are sequential. After E-1 only the
  chrome can answer, so this only matters across chrome windows.
- **Info:** the permission *check* handler reports undecided permissions as
  promptable, so a site can enumerate device labels before a decision
  (`permissions-manager.js:1031-1087`). This is intentional (#361).
- **Info:** `radapi:` responses carry `Access-Control-Allow-Origin: *` even
  for private repos (`radicle-api-protocol.js:83-85`, `:348`). The frame
  guard is the real boundary, so `cors: false` for `allowPrivate` would be
  tidier.
- **Info:** `freedomAPI`, `window.swarm.isFreedomBrowser` and `window.radicle`
  exist on every top-level page, which lets sites fingerprint the browser.
- **Info:** `FREEDOM_TEST_MODE=1` enables the test harness (stub protocols,
  `test:*` IPC) in packaged builds too (`index.js:42`). Only someone with
  local access can use it, but gating it on `!app.isPackaged` would close it.
- **Info:** `app.commandLine.appendSwitch('disable-features',
  'VizDisplayCompositor')` (`index.js`) is not a security issue, but is
  worth re-checking against current Chromium.

## Verification

Run on 2026-09-28 against this PR's tree, headless under Xvfb.

**Unit tests.** `npm test`: all suites green. That includes the new
`ipc-sender-policy.test.js` and the new `webcontents-setup`,
`webrequest-dispatcher`, `radicle-api-protocol` and `onchain-app-protocol`
cases. Each new guard was mutation-checked:

- disabling the chrome-window lock, the preference forcing or `failClosed`
  fails the suite;
- so does dropping or re-tiering an IPC channel.

**Harness e2e** (`npx playwright test --project=harness`): 248 passed, 2
failed, 19 skipped. Both failures pass on a rerun in isolation:

- `settings-adblock.spec.js:58` failed only because the fresh checkout had no
  `assets/adblock` lists. It passes after `npm run adblock:download`.
- `downloads.spec.js:153` is a renderer-only timing assertion, run while
  other app instances were launched alongside it.

The address-bar, tabs, Ledger send, Safe send, permissions,
internal-page-theme, onchain-apps, private-windows, profiles and settings
specs were then rerun on the final commit: 103/103 passed.

**Packaged build** (`electron-builder --linux dir`, local):

- `@electron/fuses read` confirms NodeOptions is off and RunAsNode /
  NodeCliInspect are on.
- The `packaged` project passes 10/10, and `packaged-live/browsing.spec.js`
  passes 2/2: a local http page and `https://example.com`.
- `nodes.spec.js` fails, as expected: the local build has no bundled node
  binaries.

**App under Xvfb** (harness, plus the packaged build for real https):

- Browsing `https://example.com` works.
- A `bzz://` page renders.
- `freedom://settings` still reads settings through `freedomAPI`.
- A real vault can be created, and the wallet sidebar shows its address.

There are no `ipc-sender-policy` refusals in the main log for any of these.

**Acceptance evidence, in the same runs:**

- A tab webview on a `bzz:` page calling the real registered
  `identity:export-mnemonic` handler with its own sender and frame is refused.
- A scripted chrome-window navigation and a `window.open` from the chrome are
  blocked, and the window stays on `index.html` with its API.
- A `<webview nodeintegration webpreferences="contextIsolation=no,sandbox=no,…">`
  created by the chrome attaches with Node off, isolation on and sandbox on:
  `typeof require` is `undefined` in the guest.
