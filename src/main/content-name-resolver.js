const { resolveEnsContent } = require('./ens-resolver');
const { resolveTezosDomain } = require('./tezos-domains-resolver');
const { isTezosDomainHost } = require('../shared/origin-utils');

function resolveContentName(name) {
  if (isTezosDomainHost(name)) return resolveTezosDomain(name);
  return resolveEnsContent(name);
}

function nameSystemLabelForHost(host) {
  const lower = String(host || '').toLowerCase();
  if (lower.endsWith('.tez')) return 'Tezos Domains';
  if (lower.endsWith('.wei')) return 'WNS';
  if (lower.endsWith('.gwei')) return 'GNS';
  return 'ENS';
}

function nameSystemLabelForResult(result, host) {
  if (result?.system === 'tezos') return 'Tezos Domains';
  if (result?.system === 'wns') return 'WNS';
  if (result?.system === 'gns') return 'GNS';
  return nameSystemLabelForHost(host);
}

function joinPublishedPath(basePath, requestPath) {
  const base = basePath && basePath !== '/' ? basePath.replace(/\/$/, '') : '';
  const requested = requestPath || '/';
  if (!base) return requested.startsWith('/') ? requested : `/${requested}`;
  if (requested === '/') return `${base}/`;
  return `${base}${requested.startsWith('/') ? requested : `/${requested}`}`;
}

module.exports = {
  joinPublishedPath,
  nameSystemLabelForHost,
  nameSystemLabelForResult,
  resolveContentName,
};
