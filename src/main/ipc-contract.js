function success(payload = {}) {
  return { success: true, ...payload };
}

function failure(code, message, details = undefined, payload = {}) {
  const error = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return { success: false, error, ...payload };
}

function validateWebContentsId(webContentsId) {
  return Number.isInteger(webContentsId) && webContentsId > 0;
}

function validateNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

module.exports = {
  success,
  failure,
  validateWebContentsId,
  validateNonEmptyString,
};
