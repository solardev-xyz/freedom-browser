'use strict';

const AGENT_APPROVAL_MODES = Object.freeze({
  EVERY_INTERACTION: 'every_interaction',
  SENSITIVE_ACTIONS: 'sensitive_actions',
  ALLOW_WEBSITE_INTERACTIONS: 'allow_website_interactions',
});

const IMPLEMENTED_AGENT_APPROVAL_MODES = new Set([
  AGENT_APPROVAL_MODES.EVERY_INTERACTION,
  AGENT_APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS,
]);

function normalizeAgentApprovalMode(value) {
  const mode = value === undefined ? AGENT_APPROVAL_MODES.EVERY_INTERACTION : value;
  return IMPLEMENTED_AGENT_APPROVAL_MODES.has(mode) ? mode : null;
}

module.exports = {
  AGENT_APPROVAL_MODES,
  normalizeAgentApprovalMode,
};
