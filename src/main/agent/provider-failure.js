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

const PROVIDER_FAILURE_CAUSES = Object.freeze({
  CREDENTIALS_REJECTED: 'credentials_rejected',
  USAGE_LIMIT_REACHED: 'usage_limit_reached',
  MODEL_UNAVAILABLE: 'model_unavailable',
  REQUEST_TOO_LARGE: 'request_too_large',
  RATE_LIMITED: 'rate_limited',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  HTTP_ERROR: 'http_error',
  TIMEOUT: 'timeout',
  DNS_FAILED: 'dns_failed',
  TLS_FAILED: 'tls_failed',
  CONNECTION_REFUSED: 'connection_refused',
  CONNECTION_RESET: 'connection_reset',
  RESPONSE_STREAM_CLOSED: 'response_stream_closed',
  NETWORK_UNAVAILABLE: 'network_unavailable',
  UNKNOWN: 'unknown',
});

const PROVIDER_FAILURE_PHASES = Object.freeze({
  CONNECTING: 'connecting',
  WAITING: 'waiting',
  STREAMING: 'streaming',
  RESPONSE: 'response',
  REQUEST: 'request',
  UNKNOWN: 'unknown',
});

const SAFE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const FAILURE_CAUSE_SET = new Set(Object.values(PROVIDER_FAILURE_CAUSES));
const FAILURE_PHASE_SET = new Set(Object.values(PROVIDER_FAILURE_PHASES));
const NON_SPECIFIC_CAUSES = new Set([
  PROVIDER_FAILURE_CAUSES.UNKNOWN,
  PROVIDER_FAILURE_CAUSES.NETWORK_UNAVAILABLE,
]);
const MAX_PROVIDER_DETAIL_LENGTH = 500;

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

function combinedFailureText(value) {
  const parts = [];
  const seen = new Set();
  const queue = [value];
  for (let examined = 0; examined < 12 && queue.length; examined += 1) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    if ((typeof current === 'object' || typeof current === 'function') && current !== null) {
      seen.add(current);
    }
    const text = failureText(current);
    if (text) parts.push(text.slice(0, 4_096));
    if (typeof current !== 'object') continue;
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(0, 8));
  }
  return parts.join(' · ').slice(0, 16_384);
}

function firstSafeInteger(value, keys) {
  let current = value;
  const seen = new Set();
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth += 1) {
    if (typeof current !== 'object') break;
    seen.add(current);
    for (const key of keys) {
      const candidate = Number(current[key]);
      if (Number.isSafeInteger(candidate)) return candidate;
    }
    if (current.response && typeof current.response === 'object') {
      for (const key of keys) {
        const candidate = Number(current.response[key]);
        if (Number.isSafeInteger(candidate)) return candidate;
      }
    }
    current = current.cause;
  }
  return null;
}

function safeNetworkCode(value, text) {
  const seen = new Set();
  const queue = [value];
  for (let examined = 0; examined < 12 && queue.length; examined += 1) {
    const current = queue.shift();
    if (!current || seen.has(current) || typeof current !== 'object') continue;
    seen.add(current);
    const candidate = typeof current.code === 'string' ? current.code.toUpperCase() : '';
    if (SAFE_NETWORK_CODES.has(candidate)) return candidate;
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors.slice(0, 8));
  }
  for (const code of SAFE_NETWORK_CODES) {
    if (new RegExp(`(?:^|[^A-Z0-9_])${code}(?:$|[^A-Z0-9_])`, 'i').test(text)) return code;
  }
  return '';
}

function safeHttpStatus(value, text) {
  const structured = firstSafeInteger(value, ['status', 'statusCode']);
  if (structured >= 400 && structured <= 599) return structured;
  const match = text.match(/(?:^|[^:\d])([45]\d{2}|529)(?=$|[^\d])/i);
  return match ? Number(match[1]) : null;
}

function defaultCauseForCategory(category, httpStatus) {
  if (category === PROVIDER_FAILURE_CATEGORIES.AUTHENTICATION) {
    return PROVIDER_FAILURE_CAUSES.CREDENTIALS_REJECTED;
  }
  if (category === PROVIDER_FAILURE_CATEGORIES.USAGE_LIMIT) {
    return PROVIDER_FAILURE_CAUSES.USAGE_LIMIT_REACHED;
  }
  if (category === PROVIDER_FAILURE_CATEGORIES.MODEL_UNAVAILABLE) {
    return PROVIDER_FAILURE_CAUSES.MODEL_UNAVAILABLE;
  }
  if (category === PROVIDER_FAILURE_CATEGORIES.REQUEST_TOO_LARGE) {
    return PROVIDER_FAILURE_CAUSES.REQUEST_TOO_LARGE;
  }
  if (category === PROVIDER_FAILURE_CATEGORIES.RATE_LIMITED) {
    return PROVIDER_FAILURE_CAUSES.RATE_LIMITED;
  }
  if (category === PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE) {
    return httpStatus
      ? PROVIDER_FAILURE_CAUSES.HTTP_ERROR
      : PROVIDER_FAILURE_CAUSES.PROVIDER_UNAVAILABLE;
  }
  if (category === PROVIDER_FAILURE_CATEGORIES.TIMEOUT) {
    return PROVIDER_FAILURE_CAUSES.TIMEOUT;
  }
  if (category === PROVIDER_FAILURE_CATEGORIES.CONNECTION) {
    return PROVIDER_FAILURE_CAUSES.NETWORK_UNAVAILABLE;
  }
  return PROVIDER_FAILURE_CAUSES.UNKNOWN;
}

function classifyProviderCause(category, text, networkCode, httpStatus) {
  if (networkCode === 'ENOTFOUND' || networkCode === 'EAI_AGAIN' || /getaddrinfo/i.test(text)) {
    return PROVIDER_FAILURE_CAUSES.DNS_FAILED;
  }
  if (
    /(?:tls|ssl|certificate|cert[_ -]?(?:has )?expired|self.?signed|unable to verify)/i.test(text)
  ) {
    return PROVIDER_FAILURE_CAUSES.TLS_FAILED;
  }
  if (networkCode === 'ECONNREFUSED' || /connection refused/i.test(text)) {
    return PROVIDER_FAILURE_CAUSES.CONNECTION_REFUSED;
  }
  if (networkCode === 'ECONNRESET' || /(?:connection reset|socket hang up)/i.test(text)) {
    return PROVIDER_FAILURE_CAUSES.CONNECTION_RESET;
  }
  if (
    /(?:stream ended|ended without|terminated|other side closed|response stream|premature close|http2 request did not get a response)/i.test(
      text
    )
  ) {
    return PROVIDER_FAILURE_CAUSES.RESPONSE_STREAM_CLOSED;
  }
  return defaultCauseForCategory(category, httpStatus);
}

function phaseForCause(cause) {
  if (
    [
      PROVIDER_FAILURE_CAUSES.DNS_FAILED,
      PROVIDER_FAILURE_CAUSES.TLS_FAILED,
      PROVIDER_FAILURE_CAUSES.CONNECTION_REFUSED,
      PROVIDER_FAILURE_CAUSES.NETWORK_UNAVAILABLE,
    ].includes(cause)
  ) {
    return PROVIDER_FAILURE_PHASES.CONNECTING;
  }
  if (cause === PROVIDER_FAILURE_CAUSES.TIMEOUT) return PROVIDER_FAILURE_PHASES.WAITING;
  if (
    [
      PROVIDER_FAILURE_CAUSES.CONNECTION_RESET,
      PROVIDER_FAILURE_CAUSES.RESPONSE_STREAM_CLOSED,
    ].includes(cause)
  ) {
    return PROVIDER_FAILURE_PHASES.STREAMING;
  }
  if (
    [PROVIDER_FAILURE_CAUSES.HTTP_ERROR, PROVIDER_FAILURE_CAUSES.PROVIDER_UNAVAILABLE].includes(
      cause
    )
  ) {
    return PROVIDER_FAILURE_PHASES.RESPONSE;
  }
  if (cause !== PROVIDER_FAILURE_CAUSES.UNKNOWN) return PROVIDER_FAILURE_PHASES.REQUEST;
  return PROVIDER_FAILURE_PHASES.UNKNOWN;
}

function matches(value, pattern) {
  return pattern.test(value);
}

function classifyProviderFailure(value) {
  if (Object.values(PROVIDER_FAILURE_CATEGORIES).includes(value?.category)) {
    const presentation = FAILURE_PRESENTATIONS[value.category];
    const httpStatus =
      Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599
        ? value.httpStatus
        : null;
    const networkCode = SAFE_NETWORK_CODES.has(value.networkCode) ? value.networkCode : '';
    const cause = FAILURE_CAUSE_SET.has(value.cause)
      ? value.cause
      : defaultCauseForCategory(value.category, httpStatus);
    const phase = FAILURE_PHASE_SET.has(value.phase) ? value.phase : phaseForCause(cause);
    const detail = sanitizeProviderDetail(value.detail);
    return Object.freeze({
      category: value.category,
      recovery: presentation.recovery,
      cause,
      phase,
      ...(httpStatus && { httpStatus }),
      ...(networkCode && { networkCode }),
      ...(detail && { detail }),
    });
  }
  const text = combinedFailureText(value);
  const detail = sanitizeProviderDetail(value);
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
      /(?:model\s+(?:(?:'[^']+'|"[^"]+"|\S+)\s+)?(?:is\s+)?(?:not found|unavailable|unsupported|invalid)|unknown model|does not exist.*model|model.*does not exist|no access to model)/i
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

  const httpStatus = safeHttpStatus(value, text);
  const networkCode = safeNetworkCode(value, text);
  if (
    [
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(networkCode)
  ) {
    category = PROVIDER_FAILURE_CATEGORIES.TIMEOUT;
  }
  const presentation = FAILURE_PRESENTATIONS[category];
  const cause = classifyProviderCause(category, text, networkCode, httpStatus);
  return Object.freeze({
    category,
    recovery: presentation.recovery,
    cause,
    phase: phaseForCause(cause),
    ...(httpStatus && { httpStatus }),
    ...(networkCode && { networkCode }),
    ...(detail && { detail }),
  });
}

function normalizeRetryCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 20) : 0;
}

function providerRetryCount(value) {
  const match = failureText(value).match(
    /(?:Freedom exhausted|initial request plus) (\d{1,2}) automatic retr(?:y|ies)\./i
  );
  return match ? normalizeRetryCount(Number(match[1])) : 0;
}

function boundedDisplayString(value, maxLength) {
  if (typeof value !== 'string') return '';
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0);
    result += code <= 0x1f || code === 0x7f ? ' ' : character;
    if (result.length >= maxLength) break;
  }
  return result.trim().slice(0, maxLength);
}

function sanitizeProviderDetail(value) {
  const raw = combinedFailureText(value);
  if (!raw) return '';
  return boundedDisplayString(
    raw
      .replace(/\s+/g, ' ')
      .replace(
        /(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|credential)["']\s*:\s*["'])[^"']*(["'])/gi,
        '$1[redacted]$2'
      )
      .replace(
        /\bAuthorization\s*:\s*(?:(?:Bearer|Basic|Token)\s+)?[^\s,;}"']+/gi,
        'Authorization: [redacted]'
      )
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted authorization]')
      .replace(/\b(?:sk|ak)[-_][A-Za-z0-9_-]{6,}\b/gi, '[redacted credential]')
      .replace(
        /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|credential)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,
        '$1[redacted]'
      )
      .replace(
        /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token)=)[^&#\s]+/gi,
        '$1[redacted]'
      ),
    MAX_PROVIDER_DETAIL_LENGTH
  );
}

function hasConcreteProviderEvidence(failure) {
  return Boolean(
    failure?.httpStatus ||
      failure?.networkCode ||
      (failure?.cause && !NON_SPECIFIC_CAUSES.has(failure.cause))
  );
}

function providerFailureScore(failure) {
  let score = 0;
  if (failure.httpStatus) score += 100;
  if (failure.networkCode) score += 100;
  if (failure.cause && !NON_SPECIFIC_CAUSES.has(failure.cause)) score += 50;
  if (failure.category !== PROVIDER_FAILURE_CATEGORIES.UNKNOWN) score += 20;
  if (failure.detail) score += Math.min(20, Math.ceil(failure.detail.length / 25));
  return score;
}

function mostInformativeProviderFailure(values, fallback) {
  const candidates = [...(Array.isArray(values) ? values : []), fallback]
    .filter(Boolean)
    .map(classifyProviderFailure);
  if (!candidates.length) return classifyProviderFailure(fallback);
  return candidates.reduce((best, candidate) =>
    providerFailureScore(candidate) >= providerFailureScore(best) ? candidate : best
  );
}

function providerFailureFingerprint(value) {
  const failure = classifyProviderFailure(value);
  return JSON.stringify([
    failure.category,
    failure.cause,
    failure.phase,
    failure.httpStatus || null,
    failure.networkCode || null,
    failure.detail || null,
  ]);
}

function summarizeProviderAttempts(failures, retryCount) {
  const automaticRetries = normalizeRetryCount(retryCount);
  const total = Math.max(1, automaticRetries + 1);
  const normalized = Array.isArray(failures)
    ? failures.slice(-total).map((failure) => classifyProviderFailure(failure))
    : [];
  const observedFailures = Math.min(total, normalized.length);
  const comparable = normalized.length > 0 && normalized.every(hasConcreteProviderEvidence);
  const complete = total > 1 && observedFailures === total;
  const fingerprintsMatch =
    complete &&
    normalized.every(
      (failure) => providerFailureFingerprint(failure) === providerFailureFingerprint(normalized[0])
    );
  let sameReason = null;
  if (complete && !fingerprintsMatch) sameReason = false;
  if (complete && fingerprintsMatch && comparable) sameReason = true;
  return Object.freeze({
    total,
    automaticRetries,
    observedFailures,
    sameReason,
    reasons: Object.freeze(normalized.map((failure) => failure)),
  });
}

function normalizeAttemptSummary(value, retryCount) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return summarizeProviderAttempts([], retryCount);
  }
  const automaticRetries = normalizeRetryCount(value.automaticRetries ?? retryCount);
  const total = Math.max(
    1,
    Math.min(
      21,
      Number.isSafeInteger(value.total) ? value.total : automaticRetries + 1
    )
  );
  const observedFailures = Math.max(
    0,
    Math.min(
      total,
      Number.isSafeInteger(value.observedFailures) ? value.observedFailures : 0
    )
  );
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.slice(-total).map((failure) => classifyProviderFailure(failure))
    : [];
  return Object.freeze({
    total,
    automaticRetries,
    observedFailures,
    sameReason: typeof value.sameReason === 'boolean' ? value.sameReason : null,
    reasons: Object.freeze(reasons),
  });
}

function providerSubject(options = {}) {
  const label = boundedDisplayString(options.providerLabel, 80);
  const modelId = boundedDisplayString(options.modelId, 120);
  if (label && modelId) return `${label} using ${modelId}`;
  return label || modelId || 'The model provider';
}

function causePresentation(failure, options = {}) {
  const subject = providerSubject(options);
  const detail = failure.detail ? ` Provider detail: “${failure.detail}”` : '';
  switch (failure.cause) {
    case PROVIDER_FAILURE_CAUSES.CREDENTIALS_REJECTED:
      return `${subject} rejected the saved credentials.${detail}`;
    case PROVIDER_FAILURE_CAUSES.USAGE_LIMIT_REACHED:
      return `${subject} reported a usage or billing limit.${detail}`;
    case PROVIDER_FAILURE_CAUSES.MODEL_UNAVAILABLE:
      return `${subject} reported that the selected model is unavailable.${detail}`;
    case PROVIDER_FAILURE_CAUSES.REQUEST_TOO_LARGE:
      return `${subject} rejected the size of this request.${detail}`;
    case PROVIDER_FAILURE_CAUSES.RATE_LIMITED:
      return `${subject} rate-limited the request.${detail}`;
    case PROVIDER_FAILURE_CAUSES.HTTP_ERROR:
      return failure.httpStatus
        ? `${subject} returned HTTP ${failure.httpStatus}.${detail}`
        : `${subject} returned an unsuccessful response.${detail}`;
    case PROVIDER_FAILURE_CAUSES.PROVIDER_UNAVAILABLE:
      return `${subject} was temporarily unavailable.${detail}`;
    case PROVIDER_FAILURE_CAUSES.TIMEOUT:
      return `${subject} did not respond in time.${detail}`;
    case PROVIDER_FAILURE_CAUSES.DNS_FAILED:
      return `Freedom could not resolve the network address for ${subject}${failure.networkCode ? ` (${failure.networkCode})` : ''}.${detail}`;
    case PROVIDER_FAILURE_CAUSES.TLS_FAILED:
      return `Freedom could not establish a secure connection to ${subject}.${detail}`;
    case PROVIDER_FAILURE_CAUSES.CONNECTION_REFUSED:
      return `${subject} refused the connection${failure.networkCode ? ` (${failure.networkCode})` : ''}.${detail}`;
    case PROVIDER_FAILURE_CAUSES.CONNECTION_RESET:
      return `The connection to ${subject} was reset before the response finished${failure.networkCode ? ` (${failure.networkCode})` : ''}.${detail}`;
    case PROVIDER_FAILURE_CAUSES.RESPONSE_STREAM_CLOSED:
      return `${subject} closed the response stream before the model finished.${detail}`;
    case PROVIDER_FAILURE_CAUSES.NETWORK_UNAVAILABLE:
      return `${subject} reported a network failure.${detail} No HTTP status, network error code, or more specific reason was supplied.`;
    default:
      return failure.detail
        ? `${subject} reported: “${failure.detail}” It supplied no recognized HTTP status or error code.`
        : `${subject} did not provide a usable failure reason or any HTTP status or error code.`;
  }
}

function attemptsPresentation(attempts) {
  if (attempts.automaticRetries === 0) return '';
  const retryWord = attempts.automaticRetries === 1 ? 'retry' : 'retries';
  const sameReason =
    attempts.sameReason === true
      ? ' Every attempt failed for the same reason.'
      : attempts.sameReason === false
        ? attemptReasonsPresentation(attempts.reasons)
        : '';
  return ` Freedom made ${attempts.total} attempts total: the initial request plus ${attempts.automaticRetries} automatic ${retryWord}.${sameReason}`;
}

function attemptReasonPresentation(failure) {
  const parts = [];
  if (failure.httpStatus) parts.push(`HTTP ${failure.httpStatus}`);
  if (failure.networkCode) parts.push(failure.networkCode);
  if (failure.detail) parts.push(`“${boundedDisplayString(failure.detail, 180)}”`);
  if (!parts.length && failure.cause && failure.cause !== PROVIDER_FAILURE_CAUSES.UNKNOWN) {
    parts.push(failure.cause.replaceAll('_', ' '));
  }
  return parts.join(' · ') || 'no additional reason supplied';
}

function attemptReasonsPresentation(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return ' Pi reported different failures, but supplied no per-attempt details.';
  }
  const details = reasons
    .map((failure, index) => `${index + 1}) ${attemptReasonPresentation(failure)}`)
    .join('; ');
  return ` Attempt details: ${details}.`;
}

function providerFailurePresentation(failure, options = {}) {
  const normalizedFailure = classifyProviderFailure(failure);
  const category = normalizedFailure.category;
  const presentation = FAILURE_PRESENTATIONS[category];
  const retryCount = normalizeRetryCount(options.retryCount);
  const attempts = normalizeAttemptSummary(options.attempts, retryCount);
  const reason = causePresentation(normalizedFailure, options);
  const subject = providerSubject(options);
  const attemptSuffix = attempts.total > 1 ? ` after ${attempts.total} attempts` : '';
  const summaryMessage = (() => {
    switch (category) {
      case PROVIDER_FAILURE_CATEGORIES.AUTHENTICATION:
        return `${subject} rejected the saved credentials.`;
      case PROVIDER_FAILURE_CATEGORIES.USAGE_LIMIT:
        return `${subject} reported a usage or billing limit.`;
      case PROVIDER_FAILURE_CATEGORIES.MODEL_UNAVAILABLE:
        return `${subject} cannot use the selected model.`;
      case PROVIDER_FAILURE_CATEGORIES.REQUEST_TOO_LARGE:
        return `${subject} rejected the size of this request.`;
      case PROVIDER_FAILURE_CATEGORIES.RATE_LIMITED:
        return `${subject} kept rate-limiting the request${attemptSuffix}.`;
      case PROVIDER_FAILURE_CATEGORIES.SERVICE_UNAVAILABLE:
        return `${subject} remained unavailable${attemptSuffix}.`;
      case PROVIDER_FAILURE_CATEGORIES.TIMEOUT:
        return `${subject} did not respond in time${attemptSuffix}.`;
      case PROVIDER_FAILURE_CATEGORIES.CONNECTION:
        return `Freedom could not restore the connection to ${subject}${attemptSuffix}.`;
      default:
        return `${subject} could not complete the request${attemptSuffix}.`;
    }
  })();
  const technicalDetails = `${reason}${attemptsPresentation(attempts)}`;
  return Object.freeze({
    category,
    recovery: presentation.recovery,
    reason,
    retryMessage: reason,
    summaryMessage,
    technicalDetails,
    terminalMessage: technicalDetails,
    nextStep: presentation.nextStep,
    attempts,
  });
}

function createProviderTerminalError(value, options = {}) {
  const failure = mostInformativeProviderFailure(options.failures, value);
  const retryCount = normalizeRetryCount(options.retryCount);
  const attempts = summarizeProviderAttempts(options.failures, retryCount);
  const presentation = providerFailurePresentation(failure, {
    retryCount,
    attempts,
    providerLabel: options.providerLabel,
    modelId: options.modelId,
  });
  return Object.freeze({
    code: 'PROVIDER_ERROR',
    message: presentation.terminalMessage,
    providerFailure: failure,
    providerAttempts: attempts,
    provider: Object.freeze({
      label: providerSubject({ providerLabel: options.providerLabel }),
      modelId: boundedDisplayString(options.modelId, 120),
    }),
    ...(retryCount && { retryCount }),
  });
}

module.exports = {
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_FAILURE_CAUSES,
  PROVIDER_FAILURE_PHASES,
  PROVIDER_FAILURE_RECOVERY,
  classifyProviderFailure,
  createProviderTerminalError,
  mostInformativeProviderFailure,
  providerFailurePresentation,
  providerRetryCount,
  summarizeProviderAttempts,
};
