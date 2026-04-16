/**
 * Price Service
 *
 * Fetches spot prices for native tokens from public price APIs.
 * Results are cached in-memory to avoid rate limits.
 *
 * Used by the address-bar tipping UI to convert USD-denominated tip amounts
 * (e.g. "$1", "$2") into ETH wei.
 *
 * Sources, tried in order:
 *   1. Coinbase spot price  (no headers required, generally unblocked)
 *   2. CoinGecko simple/price (requires a User-Agent; often 403s otherwise)
 *   3. Kraken public ticker  (ETHUSD)
 *
 * Any single source returning a valid number short-circuits the fallback chain.
 */

const https = require('https');
const { ipcMain } = require('electron');
const IPC = require('../../shared/ipc-channels');
const log = require('../logger');

const PRICE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT = 'FreedomBrowser/0.6 (+https://freedom.build)';

let cachedPrice = null;
let cachedAt = 0;
let inflight = null;

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Invalid JSON: ${err.message}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

async function fromCoinbase() {
  const data = await httpGetJson('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  const raw = data?.data?.amount;
  const price = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Coinbase response missing data.amount');
  }
  return price;
}

async function fromCoinGecko() {
  const data = await httpGetJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
  );
  const price = data?.ethereum?.usd;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('CoinGecko response missing ethereum.usd');
  }
  return price;
}

async function fromKraken() {
  const data = await httpGetJson('https://api.kraken.com/0/public/Ticker?pair=ETHUSD');
  const result = data?.result;
  const pair = result && Object.values(result)[0];
  const raw = pair?.c?.[0];
  const price = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Kraken response missing result.*.c[0]');
  }
  return price;
}

async function fetchEthUsd() {
  const sources = [
    ['coinbase', fromCoinbase],
    ['coingecko', fromCoinGecko],
    ['kraken', fromKraken],
  ];
  const errors = [];
  for (const [name, fn] of sources) {
    try {
      const price = await fn();
      log.info(`[price] ETH/USD from ${name}: $${price}`);
      return price;
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      log.warn(`[price] ${name} failed: ${err.message}`);
    }
  }
  throw new Error(`All price sources failed (${errors.join('; ')})`);
}

async function getEthUsdPrice() {
  const now = Date.now();
  if (cachedPrice && now - cachedAt < PRICE_TTL_MS) {
    return { success: true, price: cachedPrice, fromCache: true, fetchedAt: cachedAt };
  }

  if (inflight) {
    return inflight;
  }

  inflight = (async () => {
    try {
      const price = await fetchEthUsd();
      cachedPrice = price;
      cachedAt = Date.now();
      return { success: true, price, fromCache: false, fetchedAt: cachedAt };
    } catch (err) {
      if (cachedPrice) {
        return {
          success: true,
          price: cachedPrice,
          fromCache: true,
          stale: true,
          fetchedAt: cachedAt,
          error: err.message,
        };
      }
      return { success: false, error: err.message };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

function registerPriceIpc() {
  ipcMain.handle(IPC.PRICE_GET_ETH_USD, () => getEthUsdPrice());
}

module.exports = {
  getEthUsdPrice,
  registerPriceIpc,
};
