'use strict';

const trustedBuiltInOverrides = new WeakSet();

function trustBuiltInToolOverride(tool) {
  if (!tool || (typeof tool !== 'object' && typeof tool !== 'function')) {
    throw new TypeError('Trusted Pi tool overrides must be objects');
  }
  trustedBuiltInOverrides.add(tool);
  return tool;
}

function isTrustedBuiltInToolOverride(tool) {
  return Boolean(tool) && trustedBuiltInOverrides.has(tool);
}

module.exports = {
  isTrustedBuiltInToolOverride,
  trustBuiltInToolOverride,
};
