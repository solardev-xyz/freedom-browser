'use strict';

// Freedom owns the browser-facing login UI. The protocol follows Pi 1.0.2's
// openai-chatgpt flow; Pi still owns credential storage, refresh and requests.
const { createHash, randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const randomValue = () => randomBytes(32).toString('base64url');

function loginPage(outcome) {
  const copy = {
    success: ['ChatGPT connected', 'Return to Freedom Browser to continue. You can close this tab.'],
    cancelled: ['Connection cancelled', 'ChatGPT was not connected to Freedom Browser. You can close this tab and try again from Models & providers.'],
    failed: ['Connection unsuccessful', 'ChatGPT could not be connected to Freedom Browser. Return to Models & providers and try again.'],
    invalid: ['Invalid sign-in link', 'This link does not match the pending sign-in. Return to Freedom Browser and complete the current sign-in or start again.'],
  }[outcome];
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
</style></head><body><main><img src="data:image/png;base64,${icon}" alt="Freedom Browser">
<p class="brand">Freedom Browser</p><h1>${copy[0]}</h1><p>${copy[1]}</p></main></body></html>`;
}

function sendPage(response, status, outcome) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(loginPage(outcome));
}

function callbackResult(url, state) {
  const expected = new URL(REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get('state') !== state) {
    throw new Error('Sign-in callback does not match the pending sign-in');
  }
  const error = url.searchParams.get('error');
  if (error) return { error };
  const code = url.searchParams.get('code');
  const clientId = url.searchParams.get('client_id')?.trim();
  if (!code || !clientId) throw new Error('Sign-in callback is missing its code or issued client ID');
  return { code, clientId };
}

async function exchangeCode(result, verifier, signal) {
  const response = await fetch('https://auth.openai.com/api/accounts/oauth/token', {
    method: 'POST', signal,
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: result.clientId,
      code: result.code, code_verifier: verifier, redirect_uri: REDIRECT_URI, resource: RESOURCE }),
  });
  if (!response.ok) throw new Error(`ChatGPT token exchange failed (${response.status}); please sign in again`);
  const token = await response.json().catch(() => {
    throw new Error('ChatGPT returned an invalid authorization response; please sign in again');
  });
  if (!token || ['access_token', 'refresh_token', 'id_token', 'scope'].some(key => typeof token[key] !== 'string' || !token[key].trim()) ||
      !Number.isFinite(token.expires_in) || token.expires_in <= 0 || !token.scope.split(/\s+/).includes(DIRECT_SCOPE)) {
    throw new Error('ChatGPT returned an incomplete authorization grant; please sign in again');
  }
  return { type: 'oauth', access: token.access_token, refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000 - 180_000, clientId: result.clientId,
    scopes: token.scope.trim().split(/\s+/) };
}

async function loginChatGPT(interaction, options) {
  const deviceId = options?.getDeviceId?.();
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw new Error('ChatGPT sign-in requires a valid installation ID');
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
      if (response) sendPage(response, 409, 'invalid');
      return;
    }
    accepted = true;
    browserResponse = response;
    settle(value);
  };
  const server = createServer((request, response) => {
    try {
      if (request.method !== 'GET' || request.headers.host !== '127.0.0.1:1455') throw new Error('Invalid callback request');
      accept(callbackResult(new URL(request.url, REDIRECT_URI), state), response);
    } catch {
      sendPage(response, 400, 'invalid');
    }
  });
  const abort = () => reject(new Error('ChatGPT sign-in cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(1455, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolve(); });
    }).catch(error => {
      if (error.code === 'EADDRINUSE') throw new Error('ChatGPT sign-in port 1455 is busy. Cancel the other pending sign-in and try again.');
      throw error;
    });
    server.on('error', reject);
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
    if (authorizationResult.error) {
      const error = new Error(authorizationResult.error === 'access_denied' ? 'ChatGPT connection cancelled' : 'ChatGPT sign-in was not completed; please try again');
      if (authorizationResult.error === 'access_denied') error.code = 'AGENT_PROVIDER_AUTH_CANCELLED';
      throw error;
    }
    interaction.notify({ type: 'progress', message: 'Connecting ChatGPT to Freedom Browser…' });
    const credential = await exchangeCode(authorizationResult, verifier, signal);
    if (browserResponse) sendPage(browserResponse, 200, 'success');
    return credential;
  } catch (error) {
    if (browserResponse && !browserResponse.writableEnded) {
      sendPage(browserResponse, 400, signal.aborted || error.code === 'AGENT_PROVIDER_AUTH_CANCELLED' ? 'cancelled' : 'failed');
    }
    throw error;
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
