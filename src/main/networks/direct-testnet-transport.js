/** Explicit disposable Sepolia relayer experiment. System DNS/direct HTTPS;
 * no proxy, cookies, pooling, redirect, retry or Tor fallback. Never private.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { getPrivacyContext, privacyError } = require('./privacy-context');
const MARKER = 'ppv2-direct-test.json';
const refused = () =>
  privacyError('PRIVATE_DIRECT_TEST_REFUSED', 'Direct Sepolia test route is unavailable');

function directTestExposure() {
  const profile = require('../profile-resolver').getActiveProfile();
  if (!profile?.userDataDir) return false;
  try {
    const file = path.join(profile.userDataDir, MARKER),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024) throw refused();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      value.version !== 1 ||
      value.chainId !== 11155111 ||
      value.profileId !== profile.id ||
      value.disposable !== true ||
      value.relayerExposure !== 'direct-ip'
    )
      throw refused();
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw refused();
  }
}

function assertDirectTest(handle) {
  const context = getPrivacyContext(handle),
    s = context.subject;
  const profile = require('../profile-resolver').getActiveProfile();
  if (
    require('electron').app.isPackaged ||
    !require('../settings-store').isWalletTorExperimentAvailable() ||
    !directTestExposure() ||
    s.kind !== 'private-account' ||
    s.protocol !== 'privacy-pools-v2' ||
    s.deployment !== 'sepolia' ||
    s.chainId !== 11155111 ||
    s.role !== 'relayer' ||
    context.profileId !==
      createHash('sha256')
        .update(JSON.stringify([profile.id, profile.userDataDir]))
        .digest('hex') ||
    context.requirements.content !== 'public' ||
    context.requirements.correctness !== 'any' ||
    context.requirements.maxAgeMs !== null
  )
    throw refused();
  return context;
}

function createDirectTestnetTransport() {
  const pending = new Map();
  let closed = false;
  async function request(handle, input, options = {}) {
    const context = assertDirectTest(handle);
    if (closed || pending.size >= 32) throw refused();
    if (
      Object.keys(options).some(
        (key) => !['method', 'headers', 'body', 'signal', 'timeoutMs'].includes(key)
      )
    )
      throw refused();
    const { method = 'GET', headers = {}, body, signal, timeoutMs = 30000 } = options;
    let url, requestHeaders;
    try {
      url = new URL(input);
      requestHeaders = new Headers(headers);
    } catch {
      throw refused();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.hostname.includes(':') ||
      !['GET', 'POST'].includes(method) ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 120000 ||
      (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array))
    )
      throw refused();
    for (const name of requestHeaders.keys())
      if (!['accept', 'content-type'].includes(name)) throw refused();
    const bytes = body === undefined ? undefined : Buffer.from(body);
    if (method === 'GET' && bytes !== undefined) throw refused();
    if (bytes?.length > 1024 * 1024)
      throw privacyError('PRIVATE_REQUEST_TOO_LARGE', 'Test request is too large');
    requestHeaders.set('accept-encoding', 'identity');
    if (bytes) requestHeaders.set('content-length', String(bytes.length));
    const controller = new AbortController(),
      timeout = new AbortController();
    const combined = AbortSignal.any([
      context.signal,
      controller.signal,
      timeout.signal,
      ...(signal ? [signal] : []),
    ]);
    if (combined.aborted) throw privacyError('PRIVACY_REQUEST_ABORTED', 'Test request cancelled');
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    pending.set(controller, handle);
    // An explicitly constructed agent avoids global/environment proxy agents.
    const agent = new https.Agent({
      keepAlive: false,
      maxSockets: 1,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.request(
          url,
          {
            method,
            headers: Object.fromEntries(requestHeaders),
            agent,
            rejectUnauthorized: true,
            ALPNProtocols: ['http/1.1'],
            signal: combined,
          },
          (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400) {
              response.destroy();
              reject(privacyError('PRIVATE_REDIRECT_REFUSED', 'Test redirect refused'));
              return;
            }
            if (
              response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity'
            ) {
              response.destroy();
              reject(privacyError('PRIVATE_ENCODING_REFUSED', 'Test response encoding refused'));
              return;
            }
            let size = 0;
            const chunks = [];
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > 4 * 1024 * 1024) {
                response.destroy();
                reject(privacyError('PRIVATE_RESPONSE_TOO_LARGE', 'Test response is too large'));
              } else chunks.push(chunk);
            });
            response.on('error', () => reject(refused()));
            response.on('end', () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
              })
            );
          }
        );
        req.on('error', () =>
          reject(
            combined.aborted
              ? privacyError('PRIVACY_REQUEST_ABORTED', 'Test request cancelled')
              : refused()
          )
        );
        if (bytes) req.write(bytes);
        req.end();
      });
      assertDirectTest(handle);
      if (closed || combined.aborted)
        throw privacyError('PRIVACY_REQUEST_ABORTED', 'Test request cancelled');
      return result;
    } catch (error) {
      if (typeof error?.code === 'string' && /^(PRIVATE_|PRIVACY_)/.test(error.code)) throw error;
      throw refused();
    } finally {
      clearTimeout(timer);
      pending.delete(controller);
      agent.destroy();
    }
  }
  return Object.freeze({
    request,
    close() {
      closed = true;
      for (const controller of pending.keys()) controller.abort();
    },
    release(handle) {
      for (const [controller, owner] of pending) if (owner === handle) controller.abort();
    },
  });
}
module.exports = { MARKER, directTestExposure, assertDirectTest, createDirectTestnetTransport };
