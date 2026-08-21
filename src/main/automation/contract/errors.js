'use strict';

const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  WAIT_TIMEOUT: 'WAIT_TIMEOUT',
  STALE_ELEMENT_REFERENCE: 'STALE_ELEMENT_REFERENCE',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  ELEMENT_NOT_INTERACTABLE: 'ELEMENT_NOT_INTERACTABLE',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  POLICY_DENIED: 'POLICY_DENIED',
  USER_CANCELLED: 'USER_CANCELLED',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

class AutomationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AutomationError';
    this.code = code;
    this.retryable = options.retryable === true;
    if (options.suggestedAction) {
      this.suggestedAction = options.suggestedAction;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

function invalidArgument(message, details) {
  return new AutomationError(ERROR_CODES.INVALID_ARGUMENT, message, { details });
}

function toErrorPayload(error) {
  if (!(error instanceof AutomationError)) {
    return {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'The automation operation failed unexpectedly',
      retryable: false,
    };
  }

  const payload = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
  if (error.suggestedAction) payload.suggestedAction = error.suggestedAction;
  if (error.details !== undefined) payload.details = error.details;
  return payload;
}

module.exports = {
  ERROR_CODES,
  AutomationError,
  invalidArgument,
  toErrorPayload,
};
