'use strict';

const PROVIDER_FAILURE_CATEGORIES = Object.freeze({
  AUTHENTICATION: 'authentication',
  USAGE_LIMIT: 'usage_limit',
  MODEL_UNAVAILABLE: 'model_unavailable',
  REQUEST_TOO_LARGE: 'request_too_large',
  RATE_LIMITED: 'rate_limited',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  TIMEOUT: 'timeout',
  CONNECTION: 'connection',
  UNKNOWN: 'unknown',
});

const PROVIDER_FAILURE_RECOVERY = Object.freeze({
  TRANSIENT: 'transient',
  PROVIDER_SETUP: 'provider_setup',
  CHANGE_REQUEST: 'change_request',
  UNKNOWN: 'unknown',
});

const FAILURE_PRESENTATIONS = Object.freeze({
  [PROVIDER_FAILURE_CATEGORIES.AUTHENTICATION]: Object.freeze({
    recovery: PROVIDER_FAILURE_RECOVERY.PROVIDER_SETUP,
    retryMessage: 'The model provider rejected the saved credentials.',
    terminalMessage:
      'The model provider rejected the saved credentials. Reconnect it in Models before continuing.',
    nextStep: 'Reconnect the provider in Models, then continue this conversation.',
  }),
  [PROVIDER_FAILURE_CATEGORIES.USAGE_LIMIT]: Object.freeze({
    recovery: PROVIDER_FAILURE_RECOVERY.PROVIDER_SETUP,
    retryMessage: 'The model provider reported a usage or billing limit.',
    terminalMessage:
      'The model provider reported a usage or billing limit. Check the provider account or choose another model.',
    nextStep: 'Check the provider account or choose another model, then continue.',
  }),
  [PROVIDER_FAILURE_CATEGORIES.MODEL_UNAVAILABLE]: Object.freeze({
    recovery: PROVIDER_FAILURE_RECOVERY.PROVIDER_SETUP,
    retryMessage: 'The selected model is unavailable from this provider.',
    terminalMessage:
      'The selected model is unavailable from this provider. Choose another model or update the provider setup.',
    nextStep: 'Choose another model or update the provider setup, then continue.',
  }),
  [PROVIDER_FAILURE_CATEGORIES.REQUEST_TOO_LARGE]: Object.freeze({
    recovery: PROVIDER_FAILURE_RECOVERY.CHANGE_REQUEST,
    retryMessage: 'The model provider rejected the size of this request.',
    terminalMessage:
      'The model provider rejected the size of this request. Start a new conversation or send a smaller request.',
    nextStep: 'Start a new conversation or send a smaller request.',
  }),
  [PROVIDER_FAILURE_CATEGORIES.RATE_LIMITED]: Object.freeze({
    recovery: PROVIDER_FAILURE_RECOVERY.TRANSIENT,
    retryMessage: 'The model provider is rate-limiting requests.',
    terminalMessage: 'The model provider is still rate-limiting requests.',
    nextStep: 'Wait a moment, then continue this conversation.',
  }),
  [PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE]: Object.freeze({
    recovery: PROVIDER_FAILURE_RECOVERY.TRANSIENT,
    retryMessage: 'The model provider is temporarily unavailable.',
    terminalMessage: 'The model provider remained unavailable.',
    nextStep: 'Wait a moment, then continue this conversation.',
  }),
  [PROVIDER_FAILURE_CATEGORIES.TIMEOUT]: Object.freeze({
    recovery: PROVIDER_FAILURE_RECOVERY.TRANSIENT,
    retryMessage: 'The model provider did not respond in time.',
    terminalMessage: 'The model provider did not respond in time.',
    nextStep: 'Continue this conversation to try the request again.',
  }),
  [PROVIDER_FAILURE_CATEGORIES.CONNECTION]: Object.freeze({
    recovery: PROVIDER_FAILURE_RECOVERY.TRANSIENT,
    retryMessage: 'The connection to the model provider was interrupted.',
    terminalMessage: 'The connection to the model provider could not be restored.',
    nextStep: 'Check the connection, then continue this conversation.',
  }),
  [PROVIDER_FAILURE_CATEGORIES.UNKNOWN]: Object.freeze({
    recovery: PROVIDER_FAILURE_RECOVERY.UNKNOWN,
    retryMessage: 'The model provider request failed for an unknown reason.',
    terminalMessage:
      'The model provider request failed. Freedom could not determine whether the problem is transient.',
    nextStep: 'Try continuing once. If it fails again, check the provider setup or choose another model.',
  }),
});

function failureText(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.message === 'string') return value.message;
  if (typeof value?.errorMessage === 'string') return value.errorMessage;
  return '';
}

function matches(value, pattern) {
  return pattern.test(value);
}

function classifyProviderFailure(value) {
  if (Object.values(PROVIDER_FAILURE_CATEGORIES).includes(value?.category)) {
    const presentation = FAILURE_PRESENTATIONS[value.category];
    return Object.freeze({
      category: value.category,
      recovery: presentation.recovery,
    });
  }
  const text = failureText(value);
  let category = PROVIDER_FAILURE_CATEGORIES.UNKNOWN;

  if (
    matches(
      text,
      /(?:\b401\b|\b403\b|unauthori[sz]ed|authori[sz]ation failed|authentication|invalid api[_ -]?key|incorrect api[_ -]?key|invalid token|token (?:has )?expired|credentials?)/i
    )
  ) {
    category = PROVIDER_FAILURE_CATEGORIES.AUTHENTICATION;
  } else if (
    matches(
      text,
      /(?:insufficient_quota|quota exceeded|usage[_ -]?limit|monthly usage limit|out of (?:budget|credits?)|billing|payment required|credit balance)/i
    )
  ) {
    category = PROVIDER_FAILURE_CATEGORIES.USAGE_LIMIT;
  } else if (
    matches(
      text,
      /(?:model (?:is )?(?:not found|unavailable|unsupported|invalid)|unknown model|does not exist.*model|model.*does not exist|no access to model)/i
    )
  ) {
    category = PROVIDER_FAILURE_CATEGORIES.MODEL_UNAVAILABLE;
  } else if (
    matches(
      text,
      /(?:context[_ -]?(?:length|window)|maximum context|too many tokens|input (?:is )?too long|request (?:is )?too large|payload too large|\b413\b)/i
    )
  ) {
    category = PROVIDER_FAILURE_CATEGORIES.REQUEST_TOO_LARGE;
  } else if (matches(text, /(?:rate.?limit|too many requests|\b429\b|resourceexhausted)/i)) {
    category = PROVIDER_FAILURE_CATEGORIES.RATE_LIMITED;
  } else if (
    matches(
      text,
      /(?:overloaded|service.?unavailable|remained unavailable|provider.?returned.?error|internal.?server|server.?error|\b500\b|\b502\b|\b503\b|\b504\b|\b524\b)/i
    )
  ) {
    category = PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE;
  } else if (matches(text, /(?:timed? out|timeout|did not respond in time|retry delay)/i)) {
    category = PROVIDER_FAILURE_CATEGORIES.TIMEOUT;
  } else if (
    matches(
      text,
      /(?:network.?error|connection (?:error|refused|lost)|could not be restored|fetch failed|getaddrinfo|enotfound|eai_again|upstream.?connect|socket|websocket|stream ended|ended without|terminated|other side closed|reset before headers|http2 request did not get a response)/i
    )
  ) {
    category = PROVIDER_FAILURE_CATEGORIES.CONNECTION;
  }

  const presentation = FAILURE_PRESENTATIONS[category];
  return Object.freeze({
    category,
    recovery: presentation.recovery,
  });
}

function normalizeRetryCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 20) : 0;
}

function providerRetryCount(value) {
  const match = failureText(value).match(/Freedom exhausted (\d{1,2}) automatic retr(?:y|ies)\./);
  return match ? normalizeRetryCount(Number(match[1])) : 0;
}

function providerFailurePresentation(failure, options = {}) {
  const category = Object.values(PROVIDER_FAILURE_CATEGORIES).includes(failure?.category)
    ? failure.category
    : PROVIDER_FAILURE_CATEGORIES.UNKNOWN;
  const presentation = FAILURE_PRESENTATIONS[category];
  const retryCount = normalizeRetryCount(options.retryCount);
  const retrySuffix = retryCount
    ? ` Freedom exhausted ${retryCount} automatic ${retryCount === 1 ? 'retry' : 'retries'}.`
    : '';
  return Object.freeze({
    category,
    recovery: presentation.recovery,
    retryMessage: presentation.retryMessage,
    terminalMessage: `${presentation.terminalMessage}${retrySuffix}`,
    nextStep: presentation.nextStep,
  });
}

function createProviderTerminalError(value, options = {}) {
  const failure = classifyProviderFailure(value);
  const retryCount = normalizeRetryCount(options.retryCount);
  const presentation = providerFailurePresentation(failure, { retryCount });
  return Object.freeze({
    code: 'PROVIDER_ERROR',
    message: presentation.terminalMessage,
    providerFailure: failure,
    ...(retryCount && { retryCount }),
  });
}

module.exports = {
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_FAILURE_RECOVERY,
  classifyProviderFailure,
  createProviderTerminalError,
  providerFailurePresentation,
  providerRetryCount,
};
