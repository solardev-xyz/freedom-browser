'use strict';

// Custody outlives a model turn, Stop, and AI runtime disposal. Weak ownership
// disappears with the actual guest, or when the user explicitly takes control.
const agentPages = new WeakSet();
function setAgentPageCustody(contents, owned) {
  if (!contents || typeof contents !== 'object') return;
  if (owned) agentPages.add(contents);
  else agentPages.delete(contents);
}
const isAgentPage = contents => Boolean(contents && agentPages.has(contents));
module.exports = { setAgentPageCustody, isAgentPage };
