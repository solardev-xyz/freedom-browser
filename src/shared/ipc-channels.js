// IPC channel names shared between main and renderer processes

module.exports = {
  // Bookmarks
  BOOKMARKS_GET: 'bookmarks:get',
  BOOKMARKS_ADD: 'bookmarks:add',
  BOOKMARKS_UPDATE: 'bookmarks:update',
  BOOKMARKS_REMOVE: 'bookmarks:remove',

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
};
