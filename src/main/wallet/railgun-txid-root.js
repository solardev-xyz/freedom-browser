/** Main-owned, short-lived POI-node root observations. A receipt attests only
 * that the fixed public service accepted a locally computed TXID root. It is
 * neither independent event coverage nor account POI/spending authority.
 */
const { getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunPublicServices } = require('./railgun-public-services');
const MAX_AGE_MS = 60000;
const fail = (code = 'RAILGUN_TXID_ROOT_REFUSED') =>
  Object.assign(new Error('Railgun TXID root unavailable'), {
    code,
  });
const check = (v) => {
  if (!v) throw fail();
};
function checkpoint(value) {
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, 'index') &&
      Object.hasOwn(value, 'root') &&
      Object.keys(value).length === 2 &&
      Number.isSafeInteger(value.index) &&
      value.index >= 0 &&
      value.index < 8000 &&
      typeof value.root === 'string' &&
      /^[0-9a-f]{64}$/.test(value.root)
  );
  check(
    BigInt('0x' + value.root) <
      21888242871839275222246405745257275088548364400416034343698204186575808495617n
  );
  return Object.freeze({ index: value.index, root: value.root });
}
function createRailgunTxidRootSource(handle) {
  getPrivacyContext(handle);
  const services = createRailgunPublicServices(handle),
    receipts = new WeakMap();
  let busy = false,
    closed = false;
  const active = () => {
    check(!closed && !services.signal.aborted);
    getPrivacyContext(handle);
  };
  const close = () => {
    closed = true;
    services.close();
  };
  async function acquire(input) {
    active();
    check(!busy);
    const point = checkpoint(input);
    const started = performance.now();
    const fresh = () => {
      active();
      const now = performance.now();
      check(now >= started && now - started < MAX_AGE_MS);
    };
    const deadline = setTimeout(close, MAX_AGE_MS);
    deadline.unref?.();
    busy = true;
    try {
      const latest = await services.latestTxid();
      fresh();
      check(latest.index >= point.index);
      if (latest.index === point.index && latest.root !== point.root)
        throw fail('RAILGUN_TXID_ROOT_REJECTED');
      if ((await services.validateTxidRoot({ tree: 0, ...point })) !== true)
        throw fail('RAILGUN_TXID_ROOT_REJECTED');
      fresh();
      const receipt = Object.freeze({});
      receipts.set(receipt, {
        point,
        // Acquisition cannot renew the age of the first service observation.
        at: started,
        observation: Object.freeze({
          ...point,
          service: 'sepolia-ppoi-fdi',
          accepted: true,
          observedAt: new Date().toISOString(),
          latestIndex: latest.index,
        }),
      });
      return receipt;
    } catch (error) {
      close();
      throw fail(error?.code === 'RAILGUN_TXID_ROOT_REJECTED' ? error.code : undefined);
    } finally {
      clearTimeout(deadline);
      busy = false;
    }
  }
  function assertRoot(receipt, input, minimumRemainingMs = 0) {
    active();
    check(
      Number.isSafeInteger(minimumRemainingMs) &&
        minimumRemainingMs >= 0 &&
        minimumRemainingMs < MAX_AGE_MS
    );
    const point = checkpoint(input),
      value = receipts.get(receipt),
      now = performance.now();
    check(
      value &&
        value.point.index === point.index &&
        value.point.root === point.root &&
        now >= value.at &&
        now - value.at + minimumRemainingMs < MAX_AGE_MS
    );
    return value.observation;
  }
  return Object.freeze({ acquire, assertRoot, close, signal: services.signal });
}
module.exports = { createRailgunTxidRootSource, MAX_AGE_MS };
