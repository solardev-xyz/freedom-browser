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

module.exports = { OPERATIONS };
