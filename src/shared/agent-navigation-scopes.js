'use strict';

const AGENT_NAVIGATION_SCOPES = Object.freeze({
  WORKSPACE: 'workspace',
});

const AGENT_NAVIGATION_SCOPE_VALUES = new Set(Object.values(AGENT_NAVIGATION_SCOPES));

function normalizeAgentNavigationScope(value) {
  const scope = value === undefined ? AGENT_NAVIGATION_SCOPES.WORKSPACE : value;
  return AGENT_NAVIGATION_SCOPE_VALUES.has(scope) ? scope : null;
}

module.exports = {
  AGENT_NAVIGATION_SCOPES,
  normalizeAgentNavigationScope,
};
