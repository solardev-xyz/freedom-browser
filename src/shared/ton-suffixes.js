'use strict';

const TON_SUFFIXES = ['.ton', '.adnl', '.bag', '.t.me'];

function isTonHost(host) {
  if (!host || typeof host !== 'string') return false;
  const lower = host.toLowerCase().split(':')[0];
  if (lower === 'ton') return true;
  for (const suffix of TON_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

module.exports = { TON_SUFFIXES, isTonHost };
