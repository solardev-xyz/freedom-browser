// IPC channel names shared between main and renderer processes

module.exports = {
  // Bookmarks
  BOOKMARKS_GET: 'bookmarks:get',
  BOOKMARKS_ADD: 'bookmarks:add',
  BOOKMARKS_UPDATE: 'bookmarks:update',
  BOOKMARKS_REMOVE: 'bookmarks:remove',
  BOOKMARKS_BAR_TOGGLE: 'bookmarks-bar:toggle',

  // Ant node management
  ANT_START: 'ant:start',
  ANT_STOP: 'ant:stop',
  ANT_GET_STATUS: 'ant:getStatus',
  ANT_STATUS_UPDATE: 'ant:statusUpdate',
  ANT_CHECK_BINARY: 'ant:checkBinary',

  // IPFS node management
  IPFS_START: 'ipfs:start',
  IPFS_STOP: 'ipfs:stop',
  IPFS_GET_STATUS: 'ipfs:getStatus',
  IPFS_STATUS_UPDATE: 'ipfs:statusUpdate',
  IPFS_CHECK_BINARY: 'ipfs:checkBinary',

  // Myotis P2P Ethereum light client (experimental)
  MYOTIS_START: 'myotis:start',
  MYOTIS_STOP: 'myotis:stop',
  MYOTIS_GET_STATUS: 'myotis:getStatus',
  MYOTIS_STATUS_UPDATE: 'myotis:statusUpdate',

  // Radicle node management
  RADICLE_START: 'radicle:start',
  RADICLE_STOP: 'radicle:stop',
  RADICLE_GET_STATUS: 'radicle:getStatus',
  RADICLE_STATUS_UPDATE: 'radicle:statusUpdate',
  RADICLE_CHECK_BINARY: 'radicle:checkBinary',
  RADICLE_SEED: 'radicle:seed',
  RADICLE_GET_CONNECTIONS: 'radicle:getConnections',
  RADICLE_GET_REPO_PAYLOAD: 'radicle:getRepoPayload',
  RADICLE_SYNC_REPO: 'radicle:syncRepo',
  RADICLE_GET_SEED_STATUS: 'radicle:getSeedStatus',

  // Tor (Arti) node management — routes .onion traffic via a local SOCKS proxy
  TOR_START: 'tor:start',
  TOR_STOP: 'tor:stop',
  TOR_GET_STATUS: 'tor:getStatus',
  TOR_STATUS_UPDATE: 'tor:statusUpdate',
  TOR_CHECK_BINARY: 'tor:checkBinary',
  TOR_GET_VERSION: 'tor:getVersion',

  // ENS resolution
  ENS_RESOLVE: 'ens:resolve',
  ENS_RESOLVE_ADDRESS: 'ens:resolve-address',
  ENS_RESOLVE_REVERSE: 'ens:resolve-reverse',
  ENS_INVALIDATE_CONTENT: 'ens:invalidate-content',

  // Tezos Domains website resolution
  TEZOS_DOMAINS_RESOLVE: 'tezos-domains:resolve',
  TEZOS_DOMAINS_INVALIDATE: 'tezos-domains:invalidate',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_UPDATED: 'settings:updated',

  // Ad blocking
  ADBLOCK_GET_STATUS: 'adblock:get-status',
  ADBLOCK_GET_ALLOWLIST: 'adblock:get-allowlist',
  ADBLOCK_ADD_ALLOWLIST_HOST: 'adblock:add-allowlist-host',
  ADBLOCK_REMOVE_ALLOWLIST_HOST: 'adblock:remove-allowlist-host',
  ADBLOCK_COSMETIC: 'adblock:cosmetic',
  // Keyboard shortcuts (Settings > Shortcuts page ↔ main). State/preview
  // are reads; set/reset persist overrides into the settings store, whose
  // SETTINGS_UPDATED broadcast then rebuilds the menu and refreshes the
  // renderer keydown matcher.
  SHORTCUTS_GET_STATE: 'shortcuts:get-state',
  SHORTCUTS_PREVIEW_BINDING: 'shortcuts:preview-binding',
  SHORTCUTS_SET_OVERRIDE: 'shortcuts:set-override',
  SHORTCUTS_RESET: 'shortcuts:reset',

  // Bzz routing (Swarm)
  BZZ_SET_BASE: 'bzz:set-base',
  BZZ_CLEAR_BASE: 'bzz:clear-base',
  BZZ_START_PROBE: 'bzz:start-probe',
  BZZ_AWAIT_PROBE: 'bzz:await-probe',
  BZZ_CANCEL_PROBE: 'bzz:cancel-probe',

  // IPFS routing
  // Radicle routing
  RAD_SET_BASE: 'rad:set-base',
  RAD_CLEAR_BASE: 'rad:clear-base',

  // Window
  WINDOW_SET_TITLE: 'window:set-title',
  WINDOW_CLOSE: 'window:close',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_TOGGLE_FULLSCREEN: 'window:toggle-fullscreen',
  WINDOW_NEW: 'window:new',
  // Private windows (ephemeral, non-persisted partition per window)
  WINDOW_NEW_PRIVATE: 'window:new-private',
  // Sync (sendSync) — webview preloads ask whether they run inside a
  // private window before injecting the wallet providers.
  PRIVATE_IS_PRIVATE: 'private:is-private',
  WINDOW_GET_PLATFORM: 'window:get-platform',
  WINDOW_GET_BUTTON_LAYOUT: 'window:get-button-layout',

  // App
  APP_SHOW_ABOUT: 'app:show-about',
  APP_RELAUNCH: 'app:relaunch',

  // Profiles
  PROFILE_GET_ACTIVE: 'profile:get-active',
  PROFILE_LIST: 'profile:list',
  PROFILE_CREATE: 'profile:create',
  PROFILE_IMPORT: 'profile:import',
  PROFILE_RENAME: 'profile:rename',
  PROFILE_OPEN: 'profile:open',
  PROFILE_DELETE: 'profile:delete',
  PROFILE_UPDATE_NODE_CONFIG: 'profile:update-node-config',
  PROFILE_EXTERNAL_CANDIDATES: 'profile:external-candidates',
  PROFILE_EXTERNAL_CANDIDATES_DECISION: 'profile:external-candidates-decision',
  PROFILE_UPDATED: 'profile:updated',
  // Create-modal round trip: a page/menu requests the chrome's create modal
  // (renderer→main), main relays a show command to the owning/focused window
  // (main→renderer) which opens the shared #profile-create-modal.
  PROFILE_REQUEST_CREATE_MODAL: 'profile:request-create-modal',
  PROFILE_SHOW_CREATE_MODAL: 'profile:show-create-modal',

  // History
  HISTORY_GET: 'history:get',
  HISTORY_ADD: 'history:add',
  HISTORY_REMOVE: 'history:remove',
  HISTORY_CLEAR: 'history:clear',

  // Downloads
  DOWNLOADS_GET: 'downloads:get',
  DOWNLOADS_PAUSE: 'downloads:pause',
  DOWNLOADS_RESUME: 'downloads:resume',
  DOWNLOADS_CANCEL: 'downloads:cancel',
  DOWNLOADS_OPEN_FILE: 'downloads:open-file',
  DOWNLOADS_SHOW_IN_FOLDER: 'downloads:show-in-folder',
  DOWNLOADS_REMOVE: 'downloads:remove',
  DOWNLOADS_CLEAR: 'downloads:clear',
  // Main→renderer, sent to the download's owning window only — drives the
  // shelf card in that window's chrome (a download started in window A must
  // not pop a card in window B).
  DOWNLOADS_UPDATED: 'downloads:updated',
  // Main→renderer broadcast to all webContents on every item mutation.
  // The freedom://downloads page subscribes; the row is already written
  // by the time it fires, so receivers just re-query.
  DOWNLOADS_CHANGED: 'downloads:changed',

  // Internal
  GET_WEBVIEW_PRELOAD_PATH: 'internal:get-webview-preload-path',
  GET_INTERNAL_PAGES: 'internal:get-pages',
  GET_ETHEREUM_INJECT_SOURCE: 'internal:get-ethereum-inject-source',
  OPEN_URL_IN_NEW_TAB: 'internal:open-url-in-new-tab',
  SIDEBAR_OPEN_PUBLISH_SETUP: 'sidebar:open-publish-setup',

  // Favicons
  FAVICON_GET: 'favicon:get',
  FAVICON_GET_CACHED: 'favicon:get-cached',
  FAVICON_FETCH: 'favicon:fetch',
  FAVICON_FETCH_WITH_KEY: 'favicon:fetch-with-key',

  // Service Registry
  SERVICE_REGISTRY_UPDATE: 'service-registry:update',
  SERVICE_REGISTRY_GET: 'service-registry:get',

  // Context Menu
  CONTEXT_MENU_SAVE_IMAGE: 'context-menu:save-image',

  // Window with URL
  WINDOW_NEW_WITH_URL: 'window:new-with-url',

  // Find in page (main → renderer: Edit menu / accelerator opens the bar)
  FIND_IN_PAGE_OPEN: 'find:open',

  // Tab navigation
  TAB_NEXT: 'tab:next',
  TAB_PREV: 'tab:prev',
  TAB_MOVE_LEFT: 'tab:move-left',
  TAB_MOVE_RIGHT: 'tab:move-right',
  TAB_REOPEN_CLOSED: 'tab:reopen-closed',

  // Bookmarks bar
  BOOKMARKS_TOGGLE_BAR: 'bookmarks:toggle-bar',

  // GitHub Bridge
  GITHUB_BRIDGE_IMPORT: 'github-bridge:import',
  GITHUB_BRIDGE_PROGRESS: 'github-bridge:progress',
  GITHUB_BRIDGE_CHECK_GIT: 'github-bridge:check-git',
  GITHUB_BRIDGE_CHECK_PREREQUISITES: 'github-bridge:check-prerequisites',
  GITHUB_BRIDGE_VALIDATE_URL: 'github-bridge:validate-url',
  GITHUB_BRIDGE_CHECK_EXISTING: 'github-bridge:check-existing',

  // Identity Management
  IDENTITY_HAS_VAULT: 'identity:has-vault',
  IDENTITY_IS_UNLOCKED: 'identity:is-unlocked',
  IDENTITY_GENERATE_MNEMONIC: 'identity:generate-mnemonic',
  IDENTITY_CREATE_VAULT: 'identity:create-vault',
  IDENTITY_IMPORT_MNEMONIC: 'identity:import-mnemonic',
  IDENTITY_UNLOCK: 'identity:unlock',
  IDENTITY_LOCK: 'identity:lock',
  IDENTITY_GET_STATUS: 'identity:get-status',
  IDENTITY_INJECT_ALL: 'identity:inject-all',
  IDENTITY_EXPORT_MNEMONIC: 'identity:export-mnemonic',
  IDENTITY_EXPORT_PRIVATE_KEY: 'identity:export-private-key',
  IDENTITY_CHANGE_PASSWORD: 'identity:change-password',
  IDENTITY_DELETE_VAULT: 'identity:delete-vault',
  IDENTITY_VALIDATE_MNEMONIC: 'identity:validate-mnemonic',

  // Chains — served by the network registry
  NETWORKS_GET_CHAINS: 'networks:get-chains',
  NETWORKS_GET_CHAIN: 'networks:get-chain',
  NETWORKS_GET_AVAILABLE_CHAINS: 'networks:get-available-chains',
  NETWORKS_IS_CHAIN_AVAILABLE: 'networks:is-chain-available',
  NETWORKS_ADD_CHAIN: 'networks:add-chain',
  NETWORKS_REMOVE_CHAIN: 'networks:remove-chain',

  // Tokens
  TOKENS_GET_TOKENS: 'tokens:get-tokens',
  TOKENS_GET_TOKEN: 'tokens:get-token',
  TOKENS_ADD_TOKEN: 'tokens:add-token',
  TOKENS_REMOVE_TOKEN: 'tokens:remove-token',

  // Wallet Transactions
  WALLET_ESTIMATE_GAS: 'wallet:estimate-gas',
  WALLET_GET_GAS_PRICE: 'wallet:get-gas-price',
  WALLET_BUILD_ERC20_DATA: 'wallet:build-erc20-data',
  WALLET_PARSE_AMOUNT: 'wallet:parse-amount',
  WALLET_SEND_TRANSACTION: 'wallet:send-transaction',
  WALLET_GET_TRANSACTION_STATUS: 'wallet:get-transaction-status',
  WALLET_WAIT_FOR_TRANSACTION: 'wallet:wait-for-transaction',

  // x402 — payment interstitial (renderer ↔ main)
  X402_GET_DETAILS: 'x402:get-details',
  X402_APPROVE: 'x402:approve',
  // Subresource approval-card reject (Option α — sign-on-click path).
  // Settles the detector's awaited approval Promise so it returns null
  // and the original 402 propagates to the page. Distinct from
  // X402_CANCEL: cancel navigates the webview away from a mainFrame
  // paywall page; reject just declines a subresource charge.
  X402_REJECT: 'x402:reject',
  // Dedicated resume channel for the locked-vault auto-pay flow. The
  // renderer's `handleAutoPayUnlock` is the only caller. Manual approve
  // clicks go through X402_APPROVE and must not consume an unlock-resume
  // token meant for a different charge.
  X402_RESUME_UNLOCK: 'x402:resume-unlock',
  X402_CANCEL: 'x402:cancel',
  // User-initiated balance refresh from the insufficient-funds card.
  // No automatic RPC at Pay click — this is the explicit escape hatch
  // when the user knows the cached balance is stale.
  X402_REFRESH_BALANCES: 'x402:refresh-balances',
  X402_GET_ALL_PERMISSIONS: 'x402:get-all-permissions',
  X402_REVOKE_PERMISSION: 'x402:revoke-permission',
  X402_REVOKE_ALL_FOR_ORIGIN: 'x402:revoke-all-for-origin',
  X402_UPDATE_PERMISSION: 'x402:update-permission',
  X402_GET_RECEIPTS: 'x402:get-receipts',

  // Unified payment history (x402 + wallet sends + dapp sends)
  PAYMENTS_GET_RECENT: 'payments:get-recent',
  PAYMENTS_GET_BY_ID: 'payments:get-by-id',
  PAYMENTS_GET_COUNT: 'payments:get-count',
  PAYMENTS_CLEAR: 'payments:clear',
  // Main→renderer broadcast on every row mutation (append / mark-
  // confirmed / mark-failed). Recent-payments mini-section + the
  // freedom://payments page subscribe; the row is already written by
  // the time it fires, so receivers just re-query.
  PAYMENTS_TX_RECORDED: 'payments:tx-recorded',

  // Site Permissions (web permission prompts: camera, mic, notifications, …)
  // Prompt round-trip: main asks the requesting window's renderer to show
  // the anchored prompt (main→renderer), the renderer answers with the
  // user's decision (renderer→main).
  PERMISSIONS_PROMPT_REQUEST: 'permissions:prompt-request',
  PERMISSIONS_PROMPT_RESPONSE: 'permissions:prompt-response',
  // Main withdraws a previously sent prompt (main→renderer): the
  // requesting document navigated away or its webContents was destroyed,
  // so the request was invalidated (denied once) on the main side.
  PERMISSIONS_PROMPT_CANCEL: 'permissions:prompt-cancel',
  // macOS only: the user allowed a site's camera/mic but the OS-level
  // privacy setting blocks Freedom itself (main→renderer notice).
  PERMISSIONS_OS_DENIED: 'permissions:os-denied',
  PERMISSIONS_GET_ALL: 'permissions:get-all',
  PERMISSIONS_GET_FOR_ORIGIN: 'permissions:get-for-origin',
  PERMISSIONS_REVOKE: 'permissions:revoke',
  PERMISSIONS_REVOKE_ORIGIN: 'permissions:revoke-origin',
  PERMISSIONS_REVOKE_ALL: 'permissions:revoke-all',
  // Main→renderer broadcast after any decision is recorded or revoked, so
  // the address-bar indicator and the settings page can re-query.
  PERMISSIONS_CHANGED: 'permissions:changed',

  // dApp Permissions
  DAPP_GET_PERMISSION: 'dapp:get-permission',
  DAPP_GRANT_PERMISSION: 'dapp:grant-permission',
  DAPP_REVOKE_PERMISSION: 'dapp:revoke-permission',
  DAPP_GET_ALL_PERMISSIONS: 'dapp:get-all-permissions',
  DAPP_UPDATE_LAST_USED: 'dapp:update-last-used',
  DAPP_GET_SIGNING_AUTO_APPROVE: 'dapp:get-signing-auto-approve',
  DAPP_SET_SIGNING_AUTO_APPROVE: 'dapp:set-signing-auto-approve',
  DAPP_IS_TX_AUTO_APPROVED: 'dapp:is-tx-auto-approved',
  DAPP_ADD_TX_AUTO_APPROVE: 'dapp:add-tx-auto-approve',
  DAPP_REMOVE_TX_AUTO_APPROVE: 'dapp:remove-tx-auto-approve',

  // dApp Provider (webview ↔ renderer ↔ main)
  DAPP_PROVIDER_REQUEST: 'dapp:provider-request',
  DAPP_PROVIDER_RESPONSE: 'dapp:provider-response',
  DAPP_PROVIDER_EVENT: 'dapp:provider-event',

  // Swarm Provider Permissions
  SWARM_GET_PERMISSION: 'swarm:get-permission',
  SWARM_GRANT_PERMISSION: 'swarm:grant-permission',
  SWARM_REVOKE_PERMISSION: 'swarm:revoke-permission',
  SWARM_GET_ALL_PERMISSIONS: 'swarm:get-all-permissions',
  SWARM_UPDATE_LAST_USED: 'swarm:update-last-used',
  SWARM_GET_AUTO_APPROVE: 'swarm:get-auto-approve',
  SWARM_SET_AUTO_APPROVE: 'swarm:set-auto-approve',
  SWARM_GRANT_MESSAGING: 'swarm:grant-messaging',
  SWARM_REVOKE_MESSAGING: 'swarm:revoke-messaging',
  SWARM_HAS_MESSAGING_GRANT: 'swarm:has-messaging-grant',

  // Swarm permission manifests
  SWARM_MANIFEST_CHECK: 'swarm:manifest-check',
  SWARM_MANIFEST_DECIDE: 'swarm:manifest-decide',
  SWARM_MANIFEST_GET: 'swarm:manifest-get',
  SWARM_MANIFEST_USE_INDIVIDUAL: 'swarm:manifest-use-individual',
  SWARM_MANIFEST_DISCONNECT: 'swarm:manifest-disconnect',

  // Swarm Provider (main-process authority)
  SWARM_PROVIDER_EXECUTE: 'swarm:provider-execute',
  SWARM_PROVIDER_EVENT: 'swarm:provider-event',

  // Swarm Feed Store
  SWARM_GET_ALL_ORIGINS: 'swarm:get-all-origins',
  SWARM_HAS_FEED_IDENTITY: 'swarm:has-feed-identity',
  SWARM_SET_FEED_IDENTITY: 'swarm:set-feed-identity',
  SWARM_HAS_FEED_GRANT: 'swarm:has-feed-grant',
  SWARM_GET_IDENTITY_MODE: 'swarm:get-identity-mode',
  SWARM_GET_ORIGIN_IDENTITIES: 'swarm:get-origin-identities',
  SWARM_PREVIEW_APP_SCOPED_IDENTITY: 'swarm:preview-app-scoped-identity',
  SWARM_CREATE_APP_SCOPED_IDENTITY: 'swarm:create-app-scoped-identity',
  SWARM_ENSURE_ANT_WALLET_IDENTITY: 'swarm:ensure-ant-wallet-identity',
  SWARM_ENSURE_ETHEREUM_WALLET_IDENTITY: 'swarm:ensure-ethereum-wallet-identity',
  SWARM_ACTIVATE_FEED_IDENTITY: 'swarm:activate-feed-identity',
  SWARM_REVOKE_FEED_ACCESS: 'swarm:revoke-feed-access',

  // Radicle Provider Permissions
  RADICLE_GET_PERMISSION: 'radicle:get-permission',
  RADICLE_GRANT_PERMISSION: 'radicle:grant-permission',
  RADICLE_REVOKE_PERMISSION: 'radicle:revoke-permission',
  RADICLE_GET_ALL_PERMISSIONS: 'radicle:get-all-permissions',
  RADICLE_UPDATE_LAST_USED: 'radicle:update-last-used',
  RADICLE_HAS_SIGNING_GRANT: 'radicle:has-signing-grant',
  RADICLE_GRANT_SIGNING: 'radicle:grant-signing',
  RADICLE_GET_AUTO_APPROVE: 'radicle:get-auto-approve',
  RADICLE_SET_AUTO_APPROVE: 'radicle:set-auto-approve',

  // Radicle Provider (main-process authority)
  RADICLE_PROVIDER_EXECUTE: 'radicle:provider-execute',

  // Radicle node alias (chrome UI: sidebar Nodes tab)
  RADICLE_GET_ALIAS: 'radicle:get-alias',
  RADICLE_SET_ALIAS: 'radicle:set-alias',
};
