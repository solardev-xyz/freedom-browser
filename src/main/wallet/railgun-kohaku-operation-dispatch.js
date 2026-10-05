/** Internal prepared-operation sequencing. Fixed main-owned ports retain every
 * authority check, one-use claim and lane-specific outcome/cleanup policy.
 * This helper issues no operation or capability and is not a generic Host.
 */
function dispatchRailgunKohakuPreparedOperation(ports, token) {
  try {
    ports.claim(token);
  } catch {
    return Promise.reject(ports.refused());
  }
  const pending = Promise.resolve()
    .then(() => ports.invoke())
    .catch((error) => ports.onRejected(error))
    .finally(() => ports.finish());
  ports.retain(pending);
  return ports.outward(pending);
}
module.exports = { dispatchRailgunKohakuPreparedOperation };
