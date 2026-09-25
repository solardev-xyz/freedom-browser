// Canonical http(s) endpoint normalization for user-provided external node
// endpoints (Swarm's API, IPFS's gateway). One implementation is shared by the
// IPC boundary that validates what Settings → Nodes stores and by the node
// managers that dial the stored value, so the two can never disagree about what
// a given input means.
//
// Accepts a bare `host:port` or a full URL and returns an http(s) origin (plus
// any path prefix) with no trailing slash, or null when the value is unusable.
function normalizeHttpEndpoint(rawValue) {
  if (rawValue == null) return null;
  const trimmed = String(rawValue).trim();
  if (!trimmed) return null;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    // `http://user:pass@host` is rejected rather than stripped: undici's fetch
    // refuses to construct a Request from a credentialed URL, so storing one
    // would fail every probe and request with a misleading "unreachable".
    // Rejecting it at the boundary surfaces the real problem while the user is
    // still looking at the field.
    if (parsed.username || parsed.password) {
      return null;
    }
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

module.exports = {
  normalizeHttpEndpoint,
};
