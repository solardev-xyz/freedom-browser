/**
 * ERC-8244 contract-hosted application protocol.
 *
 * Freedom maps `web3://<contract>.eip155-<chainId>/` to a read-only `eth_call` of
 * `html()` (`0x33c34ac3`). The returned UTF-8 document is served as the
 * top-level response under the contract-and-chain-scoped `web3:` origin.
 * Network access from the document is denied by response policy; Ethereum
 * reads and signing continue through Freedom's existing EIP-1193 bridge.
 */

const { ethers } = require('ethers');
const log = require('../logger');
const chainData = require('../networks/chain-data-router');
const networkRegistry = require('../networks/network-registry');
const { registerWebRequestHandler } = require('../webrequest-dispatcher');
const {
  runWithPrivateLogContext,
  redactUrlForLog,
} = require('../private/private-log-context');

const HTML_SELECTOR = '0x33c34ac3';
const PROVENANCE_HEADER = 'X-Freedom-Onchain-App-Provenance';
const DEFAULT_CHAIN_ID = 1;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const ETHEREUM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HTML_RESULT_INTERFACE = new ethers.Interface(['function html() view returns (string)']);
const provenanceByWebContentsId = new Map();
const observedWebContentsIds = new Set();

const ONCHAIN_APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // Preserve the contract+chain `web3:` origin for app-local storage while
  // keeping navigation/popups and every unlisted sandbox capability denied.
  // This cannot expose host storage: every contract and chain has a distinct
  // custom-scheme origin, inside a context-isolated webview.
  'sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-downloads',
].join('; ');

const ONCHAIN_APP_PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'publickey-credentials-create=()',
  'publickey-credentials-get=()',
  'usb=()',
].join(', ');

function parseOnchainAppUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  const canonicalMatch = raw.match(
    /^web3:\/\/(0x[0-9a-f]{40})\.eip155-([0-9]+)(?:[/?#]|$)/i
  );
  // Also accept the typed shorthand at this boundary for testability and
  // defensive compatibility. Renderer navigation always loads the canonical
  // hostname-safe form before Chromium creates the request.
  const friendlyMatch = raw.match(
    /^web3:\/\/(0x[0-9a-f]{40})(?::([0-9]+))?(?:[/?#]|$)/i
  );
  const match = canonicalMatch || friendlyMatch;
  if (!match || !ETHEREUM_ADDRESS_RE.test(match[1])) return null;

  const chainId = Number(match[2] || DEFAULT_CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;

  return {
    address: ethers.getAddress(match[1]),
    chainId,
  };
}

function textResponse(status, message, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function buildOnchainProvenance(html, app, chainResult = {}) {
  const network = networkRegistry.getNetwork(app.chainId);
  return {
    version: 1,
    chainId: app.chainId,
    network: network?.name || `Chain ${app.chainId}`,
    contract: app.address,
    htmlHash: ethers.keccak256(ethers.toUtf8Bytes(html)),
    trust: chainResult.trust || {
      level: chainResult.verified === true ? 'verified' : 'unverified',
      method: chainResult.source || 'direct',
      block: null,
      agreed: [],
      dissented: [],
      queried: [],
    },
  };
}

function encodeOnchainProvenance(provenance) {
  return Buffer.from(JSON.stringify(provenance), 'utf8').toString('base64url');
}

function decodeOnchainProvenance(value) {
  if (typeof value !== 'string' || !value || value.length > 16_384) return null;
  try {
    const provenance = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      provenance?.version !== 1 ||
      !Number.isSafeInteger(provenance.chainId) ||
      provenance.chainId <= 0 ||
      !ETHEREUM_ADDRESS_RE.test(provenance.contract) ||
      !/^0x[0-9a-f]{64}$/i.test(provenance.htmlHash) ||
      !provenance.trust?.level
    ) {
      return null;
    }
    return provenance;
  } catch {
    return null;
  }
}

function htmlResponse(html, app, chainResult, method) {
  const provenance = buildOnchainProvenance(html, app, chainResult);
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': ONCHAIN_APP_CSP,
    'Permissions-Policy': ONCHAIN_APP_PERMISSIONS_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Freedom-Onchain-App-Chain-Id': String(app.chainId),
    'X-Freedom-Onchain-App-Contract': app.address,
    'X-Freedom-Onchain-App-Source': chainResult.source || 'unknown',
    'X-Freedom-Onchain-App-Verified': chainResult.verified === true ? 'true' : 'false',
    [PROVENANCE_HEADER]: encodeOnchainProvenance(provenance),
  };
  return new Response(method === 'HEAD' ? null : html, { status: 200, headers });
}

function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function withDeadline(promise, timeoutMs, signal) {
  let timeoutId;
  let abortHandler;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(abortError('onchain app request timed out')), timeoutMs);
    if (signal) {
      abortHandler = () => reject(abortError('onchain app request aborted'));
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timeoutId);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

function decodeHtmlResult(result) {
  if (typeof result !== 'string' || !/^0x[0-9a-f]*$/i.test(result)) {
    throw new Error('html() returned malformed ABI data');
  }
  const encodedBytes = (result.length - 2) / 2;
  // ABI adds an offset, a length word, and up to 31 bytes of padding.
  if (encodedBytes > MAX_HTML_BYTES + 95) {
    const error = new Error('html() response exceeds Freedom\'s 8 MiB limit');
    error.code = 'ONCHAIN_APP_TOO_LARGE';
    throw error;
  }

  const [html] = HTML_RESULT_INTERFACE.decodeFunctionResult('html', result);
  const byteLength = Buffer.byteLength(html, 'utf8');
  if (byteLength > MAX_HTML_BYTES) {
    const error = new Error('html() response exceeds Freedom\'s 8 MiB limit');
    error.code = 'ONCHAIN_APP_TOO_LARGE';
    throw error;
  }
  return html;
}

async function handleOnchainAppRequest(
  request,
  { chainRequest = chainData.request, timeoutMs = REQUEST_TIMEOUT_MS } = {}
) {
  const method = (request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return textResponse(405, 'onchain applications only support GET and HEAD', {
      Allow: 'GET, HEAD',
    });
  }

  const app = parseOnchainAppUrl(request.url);
  if (!app) {
    return textResponse(
      400,
      'invalid onchain application URL; expected web3://<contract>.eip155-<chainId>/'
    );
  }

  try {
    const chainResult = await withDeadline(
      Promise.resolve(
        chainRequest(
          app.chainId,
          'eth_call',
          [{ to: app.address, data: HTML_SELECTOR }, 'latest'],
          { includeTrust: true }
        )
      ),
      timeoutMs,
      request.signal
    );
    const html = decodeHtmlResult(chainResult?.result);
    return htmlResponse(html, app, chainResult || {}, method);
  } catch (error) {
    const loggedUrl = redactUrlForLog(request.url);
    if (error?.code === 'ONCHAIN_APP_TOO_LARGE') {
      log.warn(`[onchain-app] rejected oversized html() response for ${loggedUrl}`);
      return textResponse(413, error.message);
    }
    if (error?.name === 'AbortError') {
      log.warn(`[onchain-app] timed out loading ${loggedUrl}`);
      return textResponse(504, 'onchain application read timed out');
    }
    log.warn(`[onchain-app] failed to load ${loggedUrl}: ${error?.message || error}`);
    return textResponse(
      502,
      'the contract did not return a valid ERC-8244 html() document on this chain'
    );
  }
}

function responseHeader(responseHeaders, name) {
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(responseHeaders || {})) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(values) ? values[0] : values;
  }
  return null;
}

function documentUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function captureOnchainProvenance(details) {
  if (details?.resourceType !== 'mainFrame' || details.statusCode !== 200) return null;
  if (!documentUrl(details.url).startsWith('web3://')) return null;
  const encoded = responseHeader(details.responseHeaders, PROVENANCE_HEADER);
  const provenance = decodeOnchainProvenance(encoded);
  const contents = details.webContents;
  if (!provenance || !contents?.id) return null;

  provenanceByWebContentsId.set(contents.id, {
    url: documentUrl(details.url),
    provenance,
  });
  if (!observedWebContentsIds.has(contents.id)) {
    observedWebContentsIds.add(contents.id);
    contents.once?.('destroyed', () => {
      provenanceByWebContentsId.delete(contents.id);
      observedWebContentsIds.delete(contents.id);
    });
  }
  return null;
}

function installOnchainProvenanceCapture() {
  registerWebRequestHandler(
    'onHeadersReceived',
    'onchain-provenance',
    captureOnchainProvenance
  );
}

function registerOnchainProvenanceIpc() {
  const { ipcMain, webContents } = require('electron');
  const IPC = require('../../shared/ipc-channels');
  ipcMain.handle(IPC.ONCHAIN_APP_GET_PROVENANCE, (event, payload = {}) => {
    const webContentsId = Number(payload.webContentsId);
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return null;
    const guest = webContents.fromId(webContentsId);
    if (!guest || guest.hostWebContents?.id !== event.sender.id) return null;
    const record = provenanceByWebContentsId.get(webContentsId);
    if (!record || record.url !== documentUrl(payload.url)) return null;
    return record.provenance;
  });
}

function registerOnchainAppProtocol(targetSession, { privatePartition = null } = {}) {
  if (!targetSession?.protocol?.handle) {
    log.warn('[onchain-app] session.protocol.handle unavailable — skipping');
    return;
  }
  const isPrivate = !!privatePartition;
  try {
    targetSession.protocol.handle('web3', (request) =>
      runWithPrivateLogContext(isPrivate, () => handleOnchainAppRequest(request))
    );
    log.info('[onchain-app] web3: handler registered');
  } catch (error) {
    log.error('[onchain-app] failed to register web3: handler:', error);
  }
}

module.exports = {
  DEFAULT_CHAIN_ID,
  HTML_SELECTOR,
  MAX_HTML_BYTES,
  ONCHAIN_APP_CSP,
  ONCHAIN_APP_PERMISSIONS_POLICY,
  REQUEST_TIMEOUT_MS,
  PROVENANCE_HEADER,
  buildOnchainProvenance,
  captureOnchainProvenance,
  decodeOnchainProvenance,
  decodeHtmlResult,
  encodeOnchainProvenance,
  handleOnchainAppRequest,
  installOnchainProvenanceCapture,
  parseOnchainAppUrl,
  registerOnchainProvenanceIpc,
  registerOnchainAppProtocol,
};
