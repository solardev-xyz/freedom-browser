'use strict';

// Freedom owns the browser-facing login UI. The protocol follows Pi 1.0.2's
// openai-chatgpt flow; Pi still owns credential storage, refresh and requests.
const { createHash, randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loginFailure, loginFailureDetails, oauthFailureContext, networkLoginFailure } = require('./chatgpt-login-errors');

const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const randomValue = () => randomBytes(32).toString('base64url');

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function loginPage(outcome, error) {
  const copy = {
    success: ['ChatGPT connected', 'Return to Freedom Browser to continue. You can close this tab.'],
    cancelled: ['Connection cancelled', 'ChatGPT was not connected to Freedom Browser. You can close this tab and try again from Models & providers.'],
    failed: ['Connection unsuccessful', 'ChatGPT could not be connected to Freedom Browser. Return to Models & providers and try again.'],
    invalid: ['Invalid sign-in link', 'This link does not match the pending sign-in. Return to Freedom Browser and complete the current sign-in or start again.'],
  }[outcome];
  const knownFailure = loginFailureDetails(error);
  const diagnostic = knownFailure?.reason === 'callback_request' ? null :
    knownFailure || (outcome === 'failed' ? loginFailureDetails(loginFailure('unexpected')) : null);
  const details = diagnostic ? `<p class="next-step">${escapeHtml(diagnostic.action)}</p>
<details><summary>Details for support</summary><pre>${escapeHtml(diagnostic.report)}</pre>
<p class="support-note">You can copy these details when reporting a problem. Do not share the sign-in page’s address.</p></details>` : '';
  const assets = process.resourcesPath
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../../assets');
  const iconPath = fs.existsSync(path.join(assets, 'icons/128x128.png'))
    ? path.join(assets, 'icons/128x128.png')
    : path.join(__dirname, '../../../assets/icons/128x128.png');
  const icon = fs.readFileSync(iconPath).toString('base64');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${copy[0]} · Freedom Browser</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f8; --text: #202126; --muted: #5e6069; }
@media (prefers-color-scheme: dark) { :root { --bg: #202020; --text: #f5f5f7; --muted: #bcbec5; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, sans-serif; text-align: center; }
main { max-width: 480px; }
img { width: 80px; height: 80px; }
.brand { margin: 12px 0 32px; color: var(--muted); font-size: 14px; }
h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.2; }
p { color: var(--muted); margin: 0; }
.next-step { margin-top: 16px; }
details { margin-top: 24px; text-align: left; }
summary { cursor: pointer; color: var(--text); }
summary:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.6 ui-monospace, monospace; }
.support-note { font-size: 13px; }
</style></head><body><main><img src="data:image/png;base64,${icon}" alt="Freedom Browser">
<p class="brand">Freedom Browser</p><h1>${copy[0]}</h1><p>${escapeHtml(diagnostic?.summary || copy[1])}</p>${details}</main></body></html>`;
}

function sendPage(response, status, outcome, error) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(loginPage(outcome, error));
}

function callbackResult(url, state) {
  const expected = new URL(REDIRECT_URI);
  const invalidFields = [
    ...(url.origin !== expected.origin ? ['origin'] : []),
    ...(url.pathname !== expected.pathname ? ['path'] : []),
    ...(url.searchParams.get('state') !== state ? ['state'] : []),
  ];
  if (invalidFields.length) throw loginFailure('callback_mismatch', { invalidFields });
  const error = url.searchParams.get('error');
  if (error) return { error };
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client_id')?.trim();
  if (!code || !clientId) throw loginFailure('callback_fields', { invalidFields: [
    ...(!code ? ['code'] : []), ...(!clientId ? ['client_id'] : []),
  ] });
  return { code, clientId };
}

async function exchangeCode(result, verifier, signal) {
  let response;
  try {
    response = await fetch('https://auth.openai.com/api/accounts/oauth/token', {
      method: 'POST', signal,
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: result.clientId,
        code: result.code, code_verifier: verifier, redirect_uri: REDIRECT_URI, resource: RESOURCE }),
    });
  } catch (error) {
    signal.throwIfAborted();
    throw networkLoginFailure(error);
  }
  if (!response.ok) throw loginFailure('token_http', await oauthFailureContext(response));
  const context = { httpStatus: response.status || 200, requestId: response.headers?.get?.('x-request-id') };
  const token = await response.json().catch(() => {
    throw loginFailure('token_json', context);
  });
  const invalidFields = ['access_token', 'refresh_token', 'id_token', 'scope'].filter(key => typeof token?.[key] !== 'string' || !token[key].trim());
  if (!Number.isFinite(token?.expires_in) || token.expires_in <= 0) invalidFields.push('expires_in');
  if (invalidFields.length) throw loginFailure('token_fields', { ...context, invalidFields });
  if (!token.scope.split(/\s+/).includes(DIRECT_SCOPE)) throw loginFailure('permission', context);
  return { type: 'oauth', access: token.access_token, refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000 - 180_000, clientId: result.clientId,
    scopes: token.scope.trim().split(/\s+/) };
}

async function loginChatGPT(interaction, options) {
  const deviceId = options?.getDeviceId?.();
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw loginFailure('installation');
  }
  interaction.signal.throwIfAborted();
  const verifier = randomValue();
  const state = randomValue();
  const controller = new AbortController();
  const signal = AbortSignal.any([interaction.signal, controller.signal]);
  let settle;
  let reject;
  let accepted = false;
  let browserResponse;
  const result = new Promise((resolve, rejectResult) => { settle = resolve; reject = rejectResult; });
  // A callback can arrive while the interaction prompt is being set up.
  void result.catch(() => {});
  const accept = (value, response) => {
    if (accepted) {
      if (response) sendPage(response, 409, 'invalid', loginFailure('callback_used'));
      return;
    }
    accepted = true;
    browserResponse = response;
    settle(value);
  };
  const server = createServer((request, response) => {
    try {
      if (request.method !== 'GET' || request.headers.host !== '127.0.0.1:1455') throw loginFailure('callback_request');
      accept(callbackResult(new URL(request.url, REDIRECT_URI), state), response);
    } catch (error) {
      if (loginFailureDetails(error)?.reason === 'callback_fields') {
        // callbackResult checks origin, path and secret state before fields.
        // A malformed reply to this attempt should not turn into a later timeout.
        accept({ failure: error }, response);
      } else sendPage(response, 400, 'invalid', loginFailureDetails(error) ? error : loginFailure('callback_request'));
    }
  });
  const cancelled = () => loginFailure(signal.reason?.code === 'AGENT_PROVIDER_AUTH_TIMEOUT' ? 'timeout' : 'cancelled');
  const abort = () => reject(cancelled());
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(1455, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolve(); });
    }).catch(error => {
      throw loginFailure(error.code === 'EADDRINUSE' ? 'listener_busy' : 'listener');
    });
    server.on('error', () => reject(loginFailure('listener')));
    signal.throwIfAborted();
    const authorization = new URL('https://auth.openai.com/api/accounts/authorize');
    authorization.search = new URLSearchParams({ client_id: 'dynamic_agent_client', agent_name_hint: 'Freedom Browser',
      ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`, response_type: 'code', redirect_uri: REDIRECT_URI,
      resource: RESOURCE, scope: `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`,
      state, nonce: randomValue(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    interaction.notify({ type: 'auth_url', url: authorization.toString(), instructions: 'Complete sign-in in your browser, then return to Freedom Browser.' });
    Promise.resolve().then(() => interaction.prompt({ type: 'manual_code', signal,
      message: 'If sign-in does not complete, paste the full callback URL:', placeholder: REDIRECT_URI }))
      .then(input => accept(callbackResult(new URL(input.trim()), state)), error => { if (!accepted) reject(error); })
      .catch(error => { if (!accepted) reject(error); });
    const authorizationResult = await result;
    if (authorizationResult.failure) throw authorizationResult.failure;
    if (authorizationResult.error) {
      throw loginFailure(authorizationResult.error === 'access_denied' ? 'cancelled' : 'authorization', { providerError: authorizationResult.error });
    }
    interaction.notify({ type: 'progress', message: 'Connecting ChatGPT to Freedom Browser…' });
    const credential = await exchangeCode(authorizationResult, verifier, signal);
    if (browserResponse) sendPage(browserResponse, 200, 'success');
    return credential;
  } catch (error) {
    const failure = signal.aborted ? cancelled() : loginFailureDetails(error) ? error : loginFailure('unexpected');
    if (browserResponse && !browserResponse.writableEnded) {
      sendPage(browserResponse, 400, failure.code === 'AGENT_PROVIDER_AUTH_CANCELLED' ? 'cancelled' : 'failed', failure);
    }
    throw failure;
  } finally {
    signal.removeEventListener('abort', abort);
    controller.abort();
    // Let the response flush before removing spare browser connections.
    if (browserResponse && !browserResponse.writableFinished && !browserResponse.destroyed) {
      await new Promise(resolve => { browserResponse.once('finish', resolve); browserResponse.once('close', resolve); });
    }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

module.exports = { loginChatGPT, loginPage };
