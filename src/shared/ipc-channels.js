// IPC channel names shared between main and renderer processes

module.exports = {
  // Bookmarks
  BOOKMARKS_GET: 'bookmarks:get',
  BOOKMARKS_ADD: 'bookmarks:add',
  BOOKMARKS_UPDATE: 'bookmarks:update',
  BOOKMARKS_REMOVE: 'bookmarks:remove',
  BOOKMARKS_BAR_TOGGLE: 'bookmarks-bar:toggle',

  // Bee node management
  BEE_START: 'bee:start',
  BEE_STOP: 'bee:stop',
  BEE_GET_STATUS: 'bee:getStatus',
  BEE_STATUS_UPDATE: 'bee:statusUpdate',
  BEE_CHECK_BINARY: 'bee:checkBinary',

  // IPFS node management
  IPFS_START: 'ipfs:start',
  IPFS_STOP: 'ipfs:stop',
  IPFS_GET_STATUS: 'ipfs:getStatus',
  IPFS_STATUS_UPDATE: 'ipfs:statusUpdate',
  IPFS_CHECK_BINARY: 'ipfs:checkBinary',

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

  // ENS resolution
  ENS_RESOLVE: 'ens:resolve',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',

  // Bzz routing (Swarm)
  BZZ_SET_BASE: 'bzz:set-base',
  BZZ_CLEAR_BASE: 'bzz:clear-base',

  // IPFS routing
  IPFS_SET_BASE: 'ipfs:set-base',
  IPFS_CLEAR_BASE: 'ipfs:clear-base',

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
  WINDOW_GET_PLATFORM: 'window:get-platform',

  // App
  APP_SHOW_ABOUT: 'app:show-about',

  // History
  HISTORY_GET: 'history:get',
  HISTORY_ADD: 'history:add',
  HISTORY_REMOVE: 'history:remove',
  HISTORY_CLEAR: 'history:clear',

  // Internal
  GET_WEBVIEW_PRELOAD_PATH: 'internal:get-webview-preload-path',
  GET_INTERNAL_PAGES: 'internal:get-pages',
  OPEN_URL_IN_NEW_TAB: 'internal:open-url-in-new-tab',

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
  GITHUB_BRIDGE_VALIDATE_URL: 'github-bridge:validate-url',

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

  // Chain Registry
  CHAIN_REGISTRY_GET_CHAINS: 'chain-registry:get-chains',
  CHAIN_REGISTRY_GET_TOKENS: 'chain-registry:get-tokens',
  CHAIN_REGISTRY_GET_CHAIN: 'chain-registry:get-chain',
  CHAIN_REGISTRY_GET_TOKEN: 'chain-registry:get-token',
  CHAIN_REGISTRY_ADD_CHAIN: 'chain-registry:add-chain',
  CHAIN_REGISTRY_ADD_TOKEN: 'chain-registry:add-token',
  CHAIN_REGISTRY_REMOVE_CHAIN: 'chain-registry:remove-chain',
  CHAIN_REGISTRY_REMOVE_TOKEN: 'chain-registry:remove-token',

  // Wallet Transactions
  WALLET_ESTIMATE_GAS: 'wallet:estimate-gas',
  WALLET_GET_GAS_PRICE: 'wallet:get-gas-price',
  WALLET_BUILD_ERC20_DATA: 'wallet:build-erc20-data',
  WALLET_PARSE_AMOUNT: 'wallet:parse-amount',
  WALLET_SEND_TRANSACTION: 'wallet:send-transaction',
  WALLET_GET_TRANSACTION_STATUS: 'wallet:get-transaction-status',
  WALLET_WAIT_FOR_TRANSACTION: 'wallet:wait-for-transaction',

  // dApp Permissions
  DAPP_GET_PERMISSION: 'dapp:get-permission',
  DAPP_GRANT_PERMISSION: 'dapp:grant-permission',
  DAPP_REVOKE_PERMISSION: 'dapp:revoke-permission',
  DAPP_GET_ALL_PERMISSIONS: 'dapp:get-all-permissions',
  DAPP_UPDATE_LAST_USED: 'dapp:update-last-used',

  // dApp Provider (webview ↔ renderer ↔ main)
  DAPP_PROVIDER_REQUEST: 'dapp:provider-request',
  DAPP_PROVIDER_RESPONSE: 'dapp:provider-response',
  DAPP_PROVIDER_EVENT: 'dapp:provider-event',
};
