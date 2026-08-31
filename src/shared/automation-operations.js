'use strict';

const OPERATIONS = Object.freeze({
  LIST_TABS: 'browser_list_tabs',
  CREATE_TAB: 'browser_create_tab',
  GET_TAB: 'browser_get_tab',
  FOCUS_TAB: 'browser_focus_tab',
  CLOSE_TAB: 'browser_close_tab',
  NAVIGATE: 'browser_navigate',
  SNAPSHOT: 'browser_snapshot',
  CLICK: 'browser_click',
  TYPE: 'browser_type',
  SELECT: 'browser_select',
  PRESS: 'browser_press',
  UPLOAD: 'browser_upload',
  DOWNLOAD: 'browser_download',
  WALLET_ACTION: 'browser_wallet_action',
  WALLET_TRANSFER: 'wallet_transfer',
  NODE_STATUS: 'node_status',
  NODE_REQUEST: 'node_request',
  NODE_OPERATION_STATUS: 'node_operation_status',
  NODE_LIFECYCLE: 'node_lifecycle',
  NODE_DIAGNOSTICS: 'node_diagnostics',
  APP_DIAGNOSTICS: 'app_diagnostics',
  SWARM_PUBLISH: 'swarm_publish',
  SWARM_PUBLICATION_STATUS: 'swarm_publication_status',
  LIST_DOWNLOADS: 'browser_list_downloads',
  SCREENSHOT: 'browser_screenshot',
  WAIT: 'browser_wait',
  STOP_LOADING: 'browser_stop_loading',
});
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_DIAGNOSTIC_MAX_LINES = 200;
const MAX_DIAGNOSTIC_LINES = 400;
const DEFAULT_DIAGNOSTIC_MAX_BYTES = 49_152;
const MAX_DIAGNOSTIC_BYTES = 65_536;
const MAX_NODE_REQUEST_BODY_BYTES = 65_536;
const MAX_NODE_RESPONSE_BYTES = 65_536;
const MAX_SWARM_PUBLISH_TEXT_BYTES = 262_144;
const NODE_REQUEST_SERVICES = Object.freeze(['ant', 'radicle', 'ipfs']);
const NODE_LIFECYCLE_SERVICES = Object.freeze([
  'ant',
  'ipfs',
  'radicle',
  'tor',
  'myotis-ethereum',
  'myotis-gnosis',
]);
const DIAGNOSTIC_SERVICES = Object.freeze([
  'ant',
  'ipfs',
  'radicle',
  'tor',
  'myotis-ethereum',
  'myotis-gnosis',
]);

module.exports = {
  DEFAULT_DIAGNOSTIC_MAX_BYTES,
  DEFAULT_DIAGNOSTIC_MAX_LINES,
  DEFAULT_WAIT_TIMEOUT_MS,
  DIAGNOSTIC_SERVICES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_LINES,
  MAX_NODE_REQUEST_BODY_BYTES,
  MAX_NODE_RESPONSE_BYTES,
  MAX_SWARM_PUBLISH_TEXT_BYTES,
  MAX_WAIT_TIMEOUT_MS,
  NODE_LIFECYCLE_SERVICES,
  NODE_REQUEST_SERVICES,
  OPERATIONS,
};
