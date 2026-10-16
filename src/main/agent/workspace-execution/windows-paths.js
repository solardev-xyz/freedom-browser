'use strict';

// Serialized into the fixed file helper too; keep this function self-contained.
/* istanbul ignore next */
function unsafeWindowsRelativePath(value, platform = process.platform) {
  if (platform !== 'win32') return false;
  return value.split('/').some(part =>
    /[:\\<>"|?*]/.test(part) || [...part].some(character => character.charCodeAt(0) < 32) || /[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}

module.exports = { unsafeWindowsRelativePath };
