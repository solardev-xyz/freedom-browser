/**
 * Wallet Path Presets
 *
 * The derivation schemes other wallets use, so a seed imported from one of
 * them can reach the same addresses. Main validates every path it receives;
 * these only fill it in for the user.
 */

const MAX_ACCOUNT_INDEX = 0x7fffffff;

const PRESET_BUILDERS = {
  live: (index) => `m/44'/60'/${index}'/0/0`,
  metamask: (index) => `m/44'/60'/0'/0/${index}`,
  legacy: (index) => `m/44'/60'/0'/${index}`,
};

/**
 * @param {string} scheme - A key of PRESET_BUILDERS
 * @param {string} accountIndex - The number field's text
 * @returns {string} The path, or '' when the scheme or the number isn't valid
 */
export function presetWalletPath(scheme, accountIndex) {
  const text = String(accountIndex).trim();
  if (
    !Object.hasOwn(PRESET_BUILDERS, scheme) ||
    !/^\d+$/.test(text) ||
    Number(text) > MAX_ACCOUNT_INDEX
  ) {
    return '';
  }
  return PRESET_BUILDERS[scheme](Number(text));
}
