'use strict';

const { version } = require('../../../package.json');

const failures = new WeakMap();
const reasons = Object.freeze({
  authorization: ['OpenAI authorization', 'OpenAI did not authorize this connection.', 'Check the account and workspace selected during sign-in, then try connecting again.'],
  token_http: ['Token exchange', 'OpenAI rejected the sign-in exchange.', 'Start a new connection attempt from Models & providers.'],
  token_network: ['Token exchange', 'Freedom could not reach OpenAI to finish signing in.', 'Check your connection, then try connecting again.'],
  token_tls: ['Token exchange', 'Freedom could not establish a secure connection to OpenAI.', 'Check your network and system clock, then try connecting again.'],
  token_json: ['Token response', 'OpenAI returned an unreadable sign-in response.', 'Try connecting again. If it happens again, share the support details below.'],
  token_fields: ['Token response', 'OpenAI returned an incomplete sign-in response.', 'Try connecting again. If it happens again, share the support details below.'],
  permission: ['ChatGPT plan permission', 'Sign-in completed, but OpenAI did not grant Freedom permission to use your ChatGPT plan.', 'Start a new connection attempt and review the requested permissions.'],
  callback_mismatch: ['Browser callback', 'This sign-in link does not match the pending sign-in.', 'Return to Freedom and complete the current sign-in, or start a new connection attempt.'],
  callback_fields: ['Browser callback', 'The sign-in callback is missing its code or issued client ID.', 'Start a new connection attempt from Models & providers.'],
  callback_request: ['Browser callback', 'Freedom received an invalid sign-in callback request.', 'Return to Freedom and complete the current sign-in, or start again.'],
  callback_used: ['Browser callback', 'This sign-in link has already been used.', 'Return to Freedom to check the connection. Start a new connection attempt if it is not connected.'],
  listener_busy: ['Local callback listener', 'ChatGPT sign-in port 1455 is busy.', 'Cancel the other pending sign-in, then try connecting again.'],
  listener: ['Local callback listener', 'Freedom could not start the local ChatGPT sign-in listener.', 'Restart Freedom, then try connecting again.'],
  installation: ['Sign-in setup', 'ChatGPT sign-in requires a valid installation ID.', 'Restart Freedom. If this persists, share the support details below.'],
  timeout: ['Sign-in wait', 'ChatGPT sign-in timed out.', 'Start a new connection attempt and complete it within five minutes.'],
  cancelled: ['Sign-in', 'ChatGPT sign-in was cancelled or the connection was declined.', 'You can try connecting again from Models & providers.'],
  unexpected: ['Sign-in', 'Freedom could not finish connecting ChatGPT.', 'Try connecting again. If it happens again, share the support details below.'],
});
const oauthCodes = new Set([
  'access_denied', 'invalid_request', 'invalid_client', 'unauthorized_client',
  'invalid_grant', 'invalid_scope', 'unsupported_grant_type', 'unsupported_response_type',
  'server_error', 'temporarily_unavailable', 'interaction_required', 'login_required', 'consent_required',
  'subscription_sharing_user_not_eligible', 'chatpass_v2_scope_not_authorized',
  'chatpass_v2_invalid_authorization_context',
]);
const fields = new Set(['access_token', 'refresh_token', 'id_token', 'scope', 'expires_in', 'origin', 'path', 'state', 'code', 'client_id']);
const tlsCodes = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN']);
const networkCodes = new Set([...tlsCodes, 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET',
  'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function networkLoginFailure(error) {
  const codes = [];
  for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth++) codes.push(cause.code);
  const networkCode = codes.find(code => tlsCodes.has(code)) || codes.find(code => networkCodes.has(code));
  return loginFailure(tlsCodes.has(networkCode) ? 'token_tls' : 'token_network', { networkCode });
}

// Only errors created here can cross the IPC boundary with diagnostic text.
// Never reflect arbitrary exception messages, OAuth descriptions or bodies.
function loginFailure(reason, context = {}) {
  if (!Object.hasOwn(reasons, reason)) reason = 'unexpected';
  const [stage, summary, defaultAction] = reasons[reason];
  const httpStatus = Number.isSafeInteger(context.httpStatus) && context.httpStatus >= 100 && context.httpStatus <= 599
    ? context.httpStatus : null;
  const providerError = oauthCodes.has(context.providerError) ? context.providerError : null;
  const requestId = typeof context.requestId === 'string' && /^req[_-][a-f0-9-]{16,80}$/i.test(context.requestId)
    ? context.requestId : null;
  let action = defaultAction;
  if (providerError === 'subscription_sharing_user_not_eligible') {
    action = 'OpenAI reports that this account or workspace is not eligible. Review its access requirements or choose another provider.';
  } else if (providerError === 'invalid_client') {
    action = 'OpenAI did not accept the app registration. Share the support details below with Freedom support.';
  } else if (httpStatus === 429) {
    action = 'OpenAI is limiting sign-in attempts. Wait a while before trying again.';
  } else if (httpStatus >= 500 || ['server_error', 'temporarily_unavailable'].includes(providerError)) {
    action = 'OpenAI’s sign-in service is temporarily unavailable. Try again later.';
  }
  const reference = `CHATGPT_${reason.toUpperCase()}`;
  const report = [
    `Freedom Browser: ${version}`,
    `Platform: ${process.platform} (${process.arch})`,
    `Stage: ${stage}`,
    `Reference: ${reference}`,
    ...(httpStatus ? [`OpenAI HTTP status: ${httpStatus}`] : []),
    ...(providerError ? [`OpenAI error: ${providerError}`] : []),
    ...(requestId ? [`OpenAI request ID: ${requestId}`] : []),
    ...(networkCodes.has(context.networkCode) ? [`Network error: ${context.networkCode}`] : []),
    ...(Array.isArray(context.invalidFields) && context.invalidFields.some(field => fields.has(field))
      ? [`Missing or invalid fields: ${[...new Set(context.invalidFields.filter(field => fields.has(field)))].join(', ')}`] : []),
  ].join('\n');
  const userMessage = `${summary} ${action}`;
  const message = `${userMessage}\n${report}`;
  const error = new Error(message);
  error.code = reason === 'cancelled' ? 'AGENT_PROVIDER_AUTH_CANCELLED'
    : reason === 'timeout' ? 'AGENT_PROVIDER_AUTH_TIMEOUT' : 'AGENT_CHATGPT_LOGIN_FAILED';
  failures.set(error, Object.freeze({ reason, code: error.code, summary, action, report, reference, message, userMessage }));
  return error;
}

function loginFailureDetails(error) {
  return error && typeof error === 'object' ? failures.get(error) || null : null;
}

// Error JSON can contain tokens or personal data. Read only a small bounded
// body and return its machine code; the factory above still allowlists it.
async function oauthFailureContext(response) {
  const context = { httpStatus: response.status, requestId: response.headers?.get?.('x-request-id') };
  if (typeof response.body?.getReader !== 'function') return context;
  let reader;
  try { reader = response.body.getReader(); } catch { return context; }
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); });
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (!part) return context;
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16 * 1024) return context;
      chunks.push(Buffer.from(part.value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    context.providerError = typeof body?.error === 'string' ? body.error : body?.error?.code || body?.error?.type;
  } catch { /* HTTP status remains useful when a body is absent or unreadable. */ }
  finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  return context;
}

module.exports = { loginFailure, loginFailureDetails, oauthFailureContext, networkLoginFailure };
