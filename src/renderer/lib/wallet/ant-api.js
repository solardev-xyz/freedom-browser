/**
 * Shared Ant API read helper for the chrome.
 *
 * Goes through the main process (`window.ant.apiGet` → `ant:api-get`) rather
 * than `fetch()`: the node no longer accepts the chrome's `file:` origin over
 * CORS, and web content is blocked from the node's port entirely (security
 * audit O-1, #428). GET only, allowlisted endpoints — see
 * src/main/swarm/ant-api-chrome.js.
 *
 * Resolves `{ ok, status, data }`; rejects when no response was received
 * (node not ready / unreachable), like the `fetch()` it replaces.
 */

export async function fetchAntJson(endpoint) {
  const apiGet = window.ant?.apiGet;
  if (typeof apiGet !== 'function') {
    throw new Error('Ant API is not available');
  }
  const result = await apiGet(endpoint);
  if (!result || result.error) {
    throw new Error(result?.error || 'Ant API unreachable');
  }
  return { ok: Boolean(result.ok), status: result.status, data: result.data ?? null };
}
