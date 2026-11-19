'use strict';

/**
 * Agent custody of a page's tab, read live at a request (freedom-core design
 * 0011): the Ethereum dispatcher (`page-ethereum.js`) and the core's sends
 * (`page-core-sends.js`) offer a tab the agent holds to the agent's route and
 * refuse it a standing rule; Swarm's and Radicle's dispatchers read it too.
 *
 * It lived in `page-signing.js`, main's own signing route, until APB-4d
 * removed that route.
 */

/** Whether the agent holds the tab `guestId` now (`agent-tab-custody.js`). */
function guestInCustody(guestId) {
  const { webContents } = require('electron');
  let contents;
  try {
    contents = webContents.fromId(guestId);
  } catch {
    contents = null;
  }
  return require('../wallet/agent-tab-custody').isAgentPage(contents);
}

module.exports = { guestInCustody };
