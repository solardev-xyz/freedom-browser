'use strict';

const {
  PROVIDER_FAILURE_CATEGORIES,
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

  test('returns only fixed copy and bounded counters, never raw provider detail', () => {
    const raw = '429 request sk-secret-key Authorization: Bearer private-token';
    const error = createProviderTerminalError(new Error(raw), { retryCount: 200 });
    const presentation = providerFailurePresentation(error.providerFailure, {
      retryCount: error.retryCount,
    });

    expect(error).toMatchObject({
      code: 'PROVIDER_ERROR',
      retryCount: 20,
      providerFailure: {
        category: PROVIDER_FAILURE_CATEGORIES.RATE_LIMITED,
        recovery: PROVIDER_FAILURE_RECOVERY.TRANSIENT,
      },
    });
    expect(error.message).toContain('exhausted 20 automatic retries');
    expect(presentation.nextStep).toContain('Wait a moment');
    expect(JSON.stringify({ error, presentation })).not.toContain('secret');
    expect(JSON.stringify({ error, presentation })).not.toContain('Bearer');
  });

  test('reconstructs safe category and retry evidence from persisted fixed copy', () => {
    const error = createProviderTerminalError('503 service unavailable', { retryCount: 2 });

    expect(classifyProviderFailure(error.message)).toEqual({
      category: PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE,
      recovery: PROVIDER_FAILURE_RECOVERY.TRANSIENT,
    });
    expect(providerRetryCount(error.message)).toBe(2);
    expect(providerRetryCount('Freedom exhausted 99 automatic retries.')).toBe(20);
    expect(providerRetryCount('raw provider said retry 2')).toBe(0);
  });
});
