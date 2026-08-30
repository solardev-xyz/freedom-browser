'use strict';

const {
  PROVIDER_FAILURE_CAUSES,
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_FAILURE_PHASES,
  PROVIDER_FAILURE_RECOVERY,
  classifyProviderFailure,
  createProviderTerminalError,
  providerFailurePresentation,
  providerRetryCount,
} = require('./provider-failure');

describe('provider failure classification', () => {
  test.each([
    ['401 invalid API key sk-secret', PROVIDER_FAILURE_CATEGORIES.AUTHENTICATION],
    ['insufficient_quota: billing limit', PROVIDER_FAILURE_CATEGORIES.USAGE_LIMIT],
    ['model does not exist', PROVIDER_FAILURE_CATEGORIES.MODEL_UNAVAILABLE],
    ['413 request too large', PROVIDER_FAILURE_CATEGORIES.REQUEST_TOO_LARGE],
    ['429 too many requests', PROVIDER_FAILURE_CATEGORIES.RATE_LIMITED],
    ['529 overloaded_error', PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE],
    ['request timed out', PROVIDER_FAILURE_CATEGORIES.TIMEOUT],
    ['socket connection was closed', PROVIDER_FAILURE_CATEGORIES.CONNECTION],
    ['provider emitted something novel', PROVIDER_FAILURE_CATEGORIES.UNKNOWN],
  ])('classifies %s', (message, category) => {
    expect(classifyProviderFailure(message).category).toBe(category);
  });

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

  test('returns only fixed copy and bounded counters, never raw provider detail', () => {
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
    expect(presentation.nextStep).toContain('Wait a moment');
    expect(JSON.stringify({ error, presentation })).not.toContain('secret');
    expect(JSON.stringify({ error, presentation })).not.toContain('Bearer');
  });

  test('reconstructs safe category and retry evidence from persisted fixed copy', () => {
    const error = createProviderTerminalError('503 service unavailable', { retryCount: 2 });

    expect(classifyProviderFailure(error.message)).toEqual({
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
    expect(mixed.message).toContain('attempts failed for different reasons');
  });

  test('states honestly when the provider supplied no usable reason', () => {
    const error = createProviderTerminalError('something entirely novel', {
      providerLabel: 'OpenRouter',
      modelId: 'example/model',
    });

    expect(error.message).toBe(
      'OpenRouter using example/model did not provide a usable failure reason.'
    );
    expect(JSON.stringify(error)).not.toContain('entirely novel');
  });
});
