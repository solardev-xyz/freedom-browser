'use strict';

const { TON_SUFFIXES } = require('../shared/ton-suffixes');

function buildPacScript({ proxyHost, proxyPort }) {
  if (!proxyHost || !proxyPort) {
    throw new Error('buildPacScript: proxyHost and proxyPort are required');
  }

  const suffixChecks = TON_SUFFIXES.map((s) => `lower.endsWith("${s}")`).join(' || ');

  const body = `function FindProxyForURL(url, host) {
  var lower = host.toLowerCase();
  if (lower === "ton" || ${suffixChecks}) {
    return "PROXY ${proxyHost}:${proxyPort}";
  }
  return "DIRECT";
}`;

  return 'data:application/x-ns-proxy-autoconfig,' + encodeURIComponent(body);
}

module.exports = { buildPacScript };
