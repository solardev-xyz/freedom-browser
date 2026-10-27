'use strict';

const {
  PROVIDER_FAILURE_CAUSES,
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_FAILURE_PHASES,
  PROVIDER_FAILURE_RECOVERY,
  classifyProviderFailure,
  createProviderTerminalError,
  isPermanentModelFailure,
  providerFailurePresentation,
  providerRetryCount,
} = require('./provider-failure');

describe('provider failure classification', () => {
  test.each([
    'Model temporarily unavailable, please retry',
    '503: {"error":{"message":"The model is unavailable due to high load"}}',
    'model "gpt-x" is overloaded, try again later',
  ])('treats capacity wording about a model as a transient outage: %s', (message) => {
    const failure = classifyProviderFailure(message);
    expect(failure.category).toBe(PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE);
    expect(failure.recovery).toBe(PROVIDER_FAILURE_RECOVERY.TRANSIENT);
    expect(isPermanentModelFailure({ stopReason: 'error', errorMessage: message })).toBe(false);
  });

  test.each([
    ['500: {"message":"model \\"qwen3:8b\\" not found, try pulling it first"}', true],
    ['The model `gpt-9` does not exist or you do not have access to it.', true],
    ['unknown model: foo', true],
    // Ambiguous: also how capacity outages are worded, so Pi keeps retrying it.
    ['model unavailable', false],
    ['503 service unavailable', false],
    ['500 internal server error', false],
    // Generation errors that merely mention the model are not a missing model.
    ['500 model generated invalid JSON', false],
    ['500 model returned invalid tool call', false],
    ['model gpt-4o is invalid', true],
    ["model 'freedom-test' is unsupported", true],
    ['model `gpt-x` is invalid', true],
    ['model does not exist', true],
    ["Model 'qwen3:8b' does not exist", true],
    // "does not exist" about something the model did, not the model itself.
    ['500 model called tool "browser_open" which does not exist', false],
    ['500 model runner process does not exist', false],
    ['tool does not exist for this model', false],
  ])('only vetoes retries for wording that names a missing model: %s', (message, permanent) => {
    expect(isPermanentModelFailure({ stopReason: 'error', errorMessage: message })).toBe(permanent);
  });

  test.each([
    ['401 invalid API key sk-secret', PROVIDER_FAILURE_CATEGORIES.AUTHENTICATION],
    ['insufficient_quota: billing limit', PROVIDER_FAILURE_CATEGORIES.USAGE_LIMIT],
    ['model does not exist', PROVIDER_FAILURE_CATEGORIES.MODEL_UNAVAILABLE],
    ["404: model 'freedom-test' not found", PROVIDER_FAILURE_CATEGORIES.MODEL_UNAVAILABLE],
    ['413 request too large', PROVIDER_FAILURE_CATEGORIES.REQUEST_TOO_LARGE],
    ['429 too many requests', PROVIDER_FAILURE_CATEGORIES.RATE_LIMITED],
    ['529 overloaded_error', PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE],
    ['request timed out', PROVIDER_FAILURE_CATEGORIES.TIMEOUT],
    ['socket connection was closed', PROVIDER_FAILURE_CATEGORIES.CONNECTION],
    ['provider emitted something novel', PROVIDER_FAILURE_CATEGORIES.UNKNOWN],
  ])('classifies %s', (message, category) => {
    expect(classifyProviderFailure(message).category).toBe(category);
  });

  test.each([
    '503 model unavailable',
    '502: {"error":{"message":"model unavailable"}}',
    '500 model returned invalid tool call',
    '500 model called tool "browser_open" which does not exist',
    '500 model runner process does not exist',
  ])('a retried server error mentioning the model stays a transient outage: %s', (message) => {
    const failure = classifyProviderFailure(message);
    expect(isPermanentModelFailure({ stopReason: 'error', errorMessage: message })).toBe(false);
    expect(failure.category).toBe(PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE);
    expect(failure.recovery).toBe(PROVIDER_FAILURE_RECOVERY.TRANSIENT);
  });

  test.each(['404 model unavailable', 'model unavailable'])(
    'ambiguous model wording without a server error still points at the model: %s',
    (message) => {
      expect(classifyProviderFailure(message).category).toBe(
        PROVIDER_FAILURE_CATEGORIES.MODEL_UNAVAILABLE
      );
    }
  );

  test('distinguishes transient failures from provider setup and request problems', () => {
    expect(classifyProviderFailure('503 service unavailable').recovery).toBe(
      PROVIDER_FAILURE_RECOVERY.TRANSIENT
    );
    expect(classifyProviderFailure('invalid API key').recovery).toBe(
      PROVIDER_FAILURE_RECOVERY.PROVIDER_SETUP
    );
    expect(classifyProviderFailure('maximum context length exceeded').recovery).toBe(
      PROVIDER_FAILURE_RECOVERY.CHANGE_REQUEST
    );
  });

  test.each([
    [
      Object.assign(new Error('getaddrinfo ENOTFOUND provider.test'), { code: 'ENOTFOUND' }),
      PROVIDER_FAILURE_CAUSES.DNS_FAILED,
      PROVIDER_FAILURE_PHASES.CONNECTING,
    ],
    [
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      PROVIDER_FAILURE_CAUSES.CONNECTION_RESET,
      PROVIDER_FAILURE_PHASES.STREAMING,
    ],
    [
      'stream ended without a final response',
      PROVIDER_FAILURE_CAUSES.RESPONSE_STREAM_CLOSED,
      PROVIDER_FAILURE_PHASES.STREAMING,
    ],
  ])('retains a safe transport diagnosis for %s', (raw, cause, phase) => {
    expect(classifyProviderFailure(raw)).toMatchObject({ cause, phase });
  });

  test('finds network evidence nested inside aggregate fetch failures', () => {
    const socketError = Object.assign(new Error('connection failed'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const aggregate = new AggregateError([socketError], 'multiple connection attempts failed');
    const error = new TypeError('fetch failed', { cause: aggregate });

    expect(classifyProviderFailure(error)).toMatchObject({
      category: PROVIDER_FAILURE_CATEGORIES.TIMEOUT,
      cause: PROVIDER_FAILURE_CAUSES.TIMEOUT,
      networkCode: 'UND_ERR_CONNECT_TIMEOUT',
    });
  });

  test('does not mistake a destination port for an HTTP response status', () => {
    const failure = classifyProviderFailure(
      'fetch failed · Connect Timeout Error (attempted address: chatgpt.com:443, timeout: 10000ms) · UND_ERR_CONNECT_TIMEOUT'
    );
    expect(failure).toMatchObject({
      category: PROVIDER_FAILURE_CATEGORIES.TIMEOUT,
      cause: PROVIDER_FAILURE_CAUSES.TIMEOUT,
      networkCode: 'UND_ERR_CONNECT_TIMEOUT',
    });
    expect(failure).not.toHaveProperty('httpStatus');
  });

  test('preserves bounded provider detail while redacting credentials', () => {
    const raw = '429 request sk-secret-key Authorization: Bearer private-token';
    const error = createProviderTerminalError(new Error(raw), {
      retryCount: 200,
      failures: [raw],
      providerLabel: 'Hosted provider\n<script>',
      modelId: 'model_test',
    });
    const presentation = providerFailurePresentation(error.providerFailure, {
      retryCount: error.retryCount,
      attempts: error.providerAttempts,
      providerLabel: error.provider.label,
      modelId: error.provider.modelId,
    });

    expect(error).toMatchObject({
      code: 'PROVIDER_ERROR',
      retryCount: 20,
      providerFailure: {
        category: PROVIDER_FAILURE_CATEGORIES.RATE_LIMITED,
        recovery: PROVIDER_FAILURE_RECOVERY.TRANSIENT,
        cause: PROVIDER_FAILURE_CAUSES.RATE_LIMITED,
        httpStatus: 429,
      },
      providerAttempts: { total: 21, automaticRetries: 20, observedFailures: 1 },
    });
    expect(error.message).toContain('21 attempts total');
    expect(error.message).toContain('20 automatic retries');
    expect(error.message).toContain('Provider detail:');
    expect(error.message).toContain('[redacted credential]');
    expect(error.message).toContain('Authorization: [redacted]');
    expect(presentation.nextStep).toContain('Wait a moment');
    expect(JSON.stringify({ error, presentation })).not.toContain('sk-secret');
    expect(JSON.stringify({ error, presentation })).not.toContain('private-token');
  });

  test('redacts common authorization and token shapes from preserved detail', () => {
    const error = createProviderTerminalError(
      'fetch failed Authorization: Basic dXNlcjpwYXNz {"client_secret":"private-client-secret","refresh_token":"private-refresh-token"}'
    );
    const serialized = JSON.stringify(error);

    expect(serialized).toContain('[redacted');
    expect(serialized).not.toContain('dXNlcjpwYXNz');
    expect(serialized).not.toContain('private-client-secret');
    expect(serialized).not.toContain('private-refresh-token');
  });

  test('reconstructs safe category and retry evidence from persisted fixed copy', () => {
    const error = createProviderTerminalError('503 service unavailable', { retryCount: 2 });

    expect(classifyProviderFailure(error.message)).toMatchObject({
      category: PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE,
      recovery: PROVIDER_FAILURE_RECOVERY.TRANSIENT,
      cause: PROVIDER_FAILURE_CAUSES.HTTP_ERROR,
      phase: PROVIDER_FAILURE_PHASES.RESPONSE,
      httpStatus: 503,
    });
    expect(providerRetryCount(error.message)).toBe(2);
    expect(providerRetryCount('Freedom exhausted 99 automatic retries.')).toBe(20);
    expect(providerRetryCount('raw provider said retry 2')).toBe(0);
  });

  test('reports whether all observed attempts failed for the same safe reason', () => {
    const repeated = createProviderTerminalError('stream ended without response', {
      retryCount: 2,
      failures: [
        'stream ended without response',
        'stream ended without response',
        'stream ended without response',
      ],
    });
    const mixed = createProviderTerminalError('503 service unavailable', {
      retryCount: 2,
      failures: ['request timed out', '503 service unavailable', '503 service unavailable'],
    });

    expect(repeated.providerAttempts).toMatchObject({
      total: 3,
      observedFailures: 3,
      sameReason: true,
    });
    expect(repeated.message).toContain('Every attempt failed for the same reason');
    expect(mixed.providerAttempts.sameReason).toBe(false);
    expect(mixed.message).toContain('Attempt details:');
    expect(mixed.message).toContain('1) “request timed out”');
    expect(mixed.message).toContain('2) HTTP 503');
  });

  test('does not claim an exact repeated reason from broad network classifications', () => {
    const error = createProviderTerminalError('Network error', {
      retryCount: 2,
      failures: ['Network error', 'Network error', 'Network error'],
      providerLabel: 'ChatGPT (Codex)',
      modelId: 'gpt-test',
    });

    expect(error.providerAttempts.sameReason).toBeNull();
    expect(error.message).toContain('Provider detail: “Network error”');
    expect(error.message).toContain(
      'No HTTP status, network error code, or more specific reason was supplied.'
    );
    expect(error.message).not.toContain('same reason');
  });

  test('prefers concrete evidence from an earlier attempt over a vague final error', () => {
    const error = createProviderTerminalError('Network error', {
      retryCount: 2,
      failures: ['HTTP 503 overloaded_error', 'Network error', 'Network error'],
      providerLabel: 'ChatGPT (Codex)',
      modelId: 'gpt-test',
    });

    expect(error.providerFailure).toMatchObject({
      cause: PROVIDER_FAILURE_CAUSES.HTTP_ERROR,
      httpStatus: 503,
      detail: 'HTTP 503 overloaded_error',
    });
    expect(error.message).toContain('returned HTTP 503');
    expect(error.message).toContain('Attempt details:');
    expect(error.message).toContain('1) HTTP 503');
    expect(error.message).toContain('2) “Network error”');
  });

  test('preserves an unrecognized provider reason instead of replacing it with vague copy', () => {
    const error = createProviderTerminalError('something entirely novel', {
      providerLabel: 'OpenRouter',
      modelId: 'example/model',
    });

    expect(error.message).toBe(
      'OpenRouter using example/model reported: “something entirely novel” It supplied no recognized HTTP status or error code.'
    );
    expect(error.providerFailure.detail).toBe('something entirely novel');
  });
});
