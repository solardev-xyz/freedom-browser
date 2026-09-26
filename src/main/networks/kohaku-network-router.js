/** Dispatch one Kohaku HTTP interface to role-separated capabilities. Refuse
 * overlapping grants rather than choosing a role by ordering or retrying one.
 */
const { createKohakuNetwork } = require('./kohaku-network');
const { getPrivacyContext, privacyError } = require('./privacy-context');

function createKohakuNetworkRouter(groups) {
  const refused = () => privacyError('PRIVATE_SDK_REQUEST_REFUSED', 'SDK request has no unique network capability');
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > 4) throw refused();
  const routes = [], prepared = [];
  let account;
  const roles = new Set();
  for (const { handle, endpoints } of groups) {
    const context = getPrivacyContext(handle);
    const { role, ...subject } = context.subject;
    const identity = JSON.stringify([context.profileId, context.generation, subject, context.requirements]);
    if ((account && account !== identity) || roles.has(role) || !['asp', 'relayer', 'indexer', 'artifacts'].includes(role) ||
        !Array.isArray(endpoints) || !endpoints.length || endpoints.length > 16) throw refused();
    account = identity; roles.add(role);
    const copied = endpoints.map((endpoint) => ({ ...endpoint, methods: [...endpoint.methods] }));
    const index = prepared.length;
    for (const endpoint of copied) {
      const url = new URL(endpoint.url);
      const route = { origin: url.origin, path: url.pathname, methods: endpoint.methods, index };
      if (routes.some((other) => other.origin === route.origin && other.methods.some((method) => route.methods.includes(method)) &&
          (other.path === route.path || (other.path.endsWith('/') && route.path.startsWith(other.path)) ||
            (route.path.endsWith('/') && other.path.startsWith(route.path))))) throw refused();
      routes.push(route);
    }
    prepared.push({ handle, endpoints: copied });
  }
  const networks = prepared.map(createKohakuNetwork);
  return Object.freeze({
    async fetch(input, init = {}) {
      let target, method;
      try {
        const request = input instanceof Request ? input : null;
        target = new URL(request ? request.url : input);
        method = init.method || request?.method || 'GET';
      } catch { throw refused(); }
      const selected = routes.filter((route) => route.origin === target.origin && route.methods.includes(method) &&
        (target.pathname === route.path || (route.path.endsWith('/') && target.pathname.startsWith(route.path))));
      if (selected.length !== 1) throw refused();
      // The selected capability revalidates URL, headers, method, body and life.
      return networks[selected[0].index].fetch(input, init);
    },
  });
}

module.exports = { createKohakuNetworkRouter };
