/** Account/session-scoped experimental balance refresh and observation cache. */
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { openPrivacySession } = require('./privacy-session');
const cache = require('./balance-cache');
const { getTokens } = require('../token-registry');
const { getWalletSocksEndpoint } = require('../tor-manager');
const { isWalletTorExperimentAvailable } = require('../settings-store');
const states = new WeakMap();
const liveStates = new Set();
const TTL_MS = 30000;
const MODE = 'tor-experimental';

function unavailable(code) {
  return { privacyMode: MODE, status: 'unavailable', refreshError: code, lastUpdated: null };
}

function stale(data, code = null) {
  if (!data) return unavailable(code || 'PRIVATE_BALANCE_NOT_OBSERVED');
  const result = { ...data, status: 'stale', refreshError: code };
  for (const [key, value] of Object.entries(data)) {
    if (key.includes(':')) result[key] = { ...value, stale: true, refreshError: code };
  }
  return result;
}

function stateFor(address) {
  const scope = openPrivacySession();
  const handle = scope.getContext({
    kind: 'public-address',
    principal: address,
    chainId: 11155111,
    role: 'balance-rpc',
  });
  let state = states.get(handle);
  if (!state) {
    const context = getPrivacyContext(handle);
    state = {
      scope,
      handle,
      profileId: context.profileId,
      address: context.subject.principal,
      data: null,
      refresh: null,
    };
    states.set(handle, state);
    liveStates.add(state);
    scope.signal.addEventListener(
      'abort',
      () => {
        state.data = null;
        liveStates.delete(state);
      },
      { once: true }
    );
  }
  return state;
}

function observedData(state) {
  return state.data || cache.getPrivateBalances(state.profileId, state.address);
}

function isFresh(state) {
  return (
    state.data?.status === 'fresh' &&
    Date.now() - state.completedAt < TTL_MS &&
    state.endpoint &&
    state.endpoint === getWalletSocksEndpoint() &&
    !state.endpoint.signal.aborted
  );
}

function getPrivateBalances(address, { cacheOnly = false, force = false } = {}) {
  if (!isWalletTorExperimentAvailable())
    return Promise.resolve(unavailable('PRIVACY_EXPERIMENT_UNQUALIFIED'));
  let state;
  try {
    state = stateFor(address);
  } catch {
    return Promise.resolve(unavailable('PRIVACY_SESSION_UNAVAILABLE'));
  }
  if (!force && isFresh(state)) return Promise.resolve(state.data);
  if (cacheOnly) return Promise.resolve(stale(observedData(state)));
  if (state.refresh) return state.refresh;
  state.refresh = refresh(state).finally(() => {
    state.refresh = null;
  });
  return state.refresh;
}

async function refresh(state) {
  const { scope, handle } = state;
  const endpoint = getWalletSocksEndpoint();
  const previous = observedData(state);
  if (!endpoint || endpoint.signal.aborted) return stale(previous, 'TOR_NOT_READY');
  const signal = AbortSignal.any([scope.signal, endpoint.signal]);
  try {
    const data = await scope.run(handle, async () => {
      const { getNativeBalance, getTokenBalance } = require('./balance-service');
      const balances = {
        privacyMode: MODE,
        status: 'fresh',
        lastUpdated: previous?.lastUpdated || null,
        refreshError: null,
      };
      let successes = 0;
      // Sequential tokens bound concurrency per account and never form a
      // multi-account batch. Token metadata shares the account context.
      for (const [key, token] of Object.entries(getTokens())) {
        if (signal.aborted)
          throw privacyError('PRIVACY_REQUEST_ABORTED', 'Balance refresh cancelled');
        if (Number(token.chainId) !== 11155111) continue;
        try {
          const options = { privacyContext: handle, includeTrust: true, signal };
          const value =
            token.address === null
              ? await getNativeBalance(state.address, token.chainId, token, options)
              : await getTokenBalance(state.address, token.address, token.chainId, token, options);
          balances[key] = { ...value, stale: false, refreshError: null };
          balances.lastUpdated = value.observedAt;
          successes += 1;
        } catch {
          balances.refreshError = 'PRIVATE_BALANCE_REFRESH_FAILED';
          balances[key] = previous?.[key]
            ? { ...previous[key], stale: true, refreshError: balances.refreshError }
            : {
                symbol: token.symbol,
                stale: true,
                refreshError: balances.refreshError,
                observedAt: null,
              };
        }
      }
      if (!successes) balances.status = previous?.lastUpdated ? 'stale' : 'unavailable';
      else if (balances.refreshError) balances.status = 'stale';
      return balances;
    });
    getPrivacyContext(handle);
    if (signal.aborted || endpoint !== getWalletSocksEndpoint()) {
      return stale(previous, 'PRIVACY_REQUEST_ABORTED');
    }
    return scope.commit(handle, () => {
      state.data = data;
      state.completedAt = Date.now();
      state.endpoint = endpoint;
      cache.setPrivateBalances(state.profileId, state.address, data);
      return data;
    });
  } catch {
    // A revoked session may not return an old account snapshot to the UI.
    try {
      getPrivacyContext(handle);
    } catch {
      return unavailable('PRIVACY_SESSION_UNAVAILABLE');
    }
    return stale(previous, 'PRIVACY_REQUEST_ABORTED');
  }
}

function clearPrivateBalanceCache(address, discard = false) {
  for (const state of liveStates) {
    if (address && address.toLowerCase() !== state.address) continue;
    state.completedAt = 0;
    if (discard) state.data = null;
  }
}

module.exports = { getPrivateBalances, clearPrivateBalanceCache };
