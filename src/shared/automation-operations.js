'use strict';

const OPERATIONS = Object.freeze({
  LIST_TABS: 'browser_list_tabs',
  CREATE_TAB: 'browser_create_tab',
  GET_TAB: 'browser_get_tab',
  CLOSE_TAB: 'browser_close_tab',
  NAVIGATE: 'browser_navigate',
  SNAPSHOT: 'browser_snapshot',
  CLICK: 'browser_click',
  TYPE: 'browser_type',
  SCREENSHOT: 'browser_screenshot',
  WAIT: 'browser_wait',
  STOP_LOADING: 'browser_stop_loading',
});
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 30_000;

module.exports = { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, OPERATIONS };
