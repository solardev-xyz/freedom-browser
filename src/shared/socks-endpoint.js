function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function bracketIpv6Host(host) {
  if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) {
    return `[${host}]`;
  }
  return host;
}

function unbracketHost(host) {
  return host.replace(/^\[(.*)\]$/, '$1');
}

function parseSocksEndpoint(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(hasUrlScheme(trimmed) ? trimmed : `socks5://${trimmed}`);
  } catch {
    return null;
  }

  if (!['socks:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  const pathSuffix = `${parsed.pathname || ''}${parsed.search || ''}${parsed.hash || ''}`;
  if (pathSuffix && pathSuffix !== '/') {
    return null;
  }

  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }

  const host = unbracketHost(parsed.hostname || '');
  if (!host) return null;

  return { host, port };
}

function normalizeSocksEndpoint(rawValue) {
  const parsed = parseSocksEndpoint(rawValue);
  if (!parsed) return null;
  return `${bracketIpv6Host(parsed.host)}:${parsed.port}`;
}

module.exports = {
  normalizeSocksEndpoint,
  parseSocksEndpoint,
};
