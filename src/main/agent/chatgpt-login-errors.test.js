'use strict';

const { loginFailure, loginFailureDetails, oauthFailureContext } = require('./chatgpt-login-errors');
const requestId = 'req_0123456789abcdef0123456789abcdef';

test('diagnostics retain only recognized machine codes, request IDs and field names', () => {
  const error = loginFailure('token_http', { httpStatus: 401, providerError: 'invalid_grant', requestId,
    invalidFields: ['refresh_token', 'private-field-canary', 'refresh_token'] });
  const diagnostic = loginFailureDetails(error);
  expect(diagnostic.message).toContain('OpenAI HTTP status: 401');
  expect(diagnostic.report).toContain('OpenAI error: invalid_grant');
  expect(diagnostic.report).toContain(requestId);
  expect(diagnostic.report).toContain('Missing or invalid fields: refresh_token');
  expect(diagnostic.message).not.toContain('private-field-canary');
  expect(diagnostic.report).toContain(require('../../../package.json').version);
  expect(diagnostic.report).toContain(process.platform);
});

test('arbitrary exception text and forged diagnostic objects cannot cross the public error boundary', () => {
  const forged = Object.assign(new Error('private-exception-canary'), {
    code: 'AGENT_CHATGPT_LOGIN_FAILED', diagnostic: { message: 'private-forged-canary' },
  });
  expect(loginFailureDetails(forged)).toBeNull();
  const error = loginFailure('token_network');
  error.message = 'private-mutated-canary';
  expect(loginFailureDetails(error).message).not.toContain('private-mutated-canary');
});

test('unrecognized provider fields are omitted rather than rendered or guessed', () => {
  const diagnostic = loginFailureDetails(loginFailure('__proto__', {
    httpStatus: '401', providerError: '<script>private-error-canary</script>',
    requestId: 'private-request-canary', invalidFields: ['private-field-canary'],
  }));
  expect(diagnostic.reference).toBe('CHATGPT_UNEXPECTED');
  expect(diagnostic.report).not.toMatch(/private-|script|OpenAI HTTP|OpenAI error|request ID|invalid fields/);
});

test('HTTP failures retain an allowlisted code without reflecting their body or descriptions', async () => {
  const response = new Response(JSON.stringify({ error: { code: 'invalid_client', message: 'private-body-canary' },
    error_description: 'private-description-canary', access_token: 'private-access-canary' }), {
    status: 403, headers: { 'x-request-id': requestId },
  });
  const diagnostic = loginFailureDetails(loginFailure('token_http', await oauthFailureContext(response)));
  expect(diagnostic.report).toContain('invalid_client');
  expect(diagnostic.report).toContain(requestId);
  expect(diagnostic.action).toContain('app registration');
  expect(JSON.stringify(diagnostic)).not.toContain('private-');
});

test.each([
  [429, 'invalid_request', 'Wait a while'],
  [503, undefined, 'temporarily unavailable'],
  [403, 'subscription_sharing_user_not_eligible', 'account or workspace is not eligible'],
])('gives recovery appropriate to status %s / code %s', (httpStatus, providerError, recovery) => {
  expect(loginFailureDetails(loginFailure('token_http', { httpStatus, providerError })).action).toContain(recovery);
});

test('oversized, non-JSON and locked bodies retain the HTTP status without retaining body content', async () => {
  for (const response of [
    new Response('private-body-canary'.repeat(2000), { status: 502 }),
    new Response('<html>private-body-canary</html>', { status: 502 }),
  ]) expect(await oauthFailureContext(response)).toEqual({ httpStatus: 502, requestId: null });
  const locked = new Response('private-body-canary', { status: 502 });
  const reader = locked.body.getReader();
  expect(await oauthFailureContext(locked)).toEqual({ httpStatus: 502, requestId: null });
  await reader.cancel();
});

test('an error body that never finishes cannot delay the failure page indefinitely', async () => {
  jest.useFakeTimers();
  let cancelled = false;
  try {
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 });
    const pending = oauthFailureContext(response);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ httpStatus: 500, requestId: null });
    expect(cancelled).toBe(true);
  } finally { jest.useRealTimers(); }
});
