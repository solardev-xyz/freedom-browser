'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { insidePath } = require('./execution-policy');

const PACKAGED_USER_DATA_ENV = 'FREEDOM_PACKAGED_QUALIFICATION_USER_DATA';
const PACKAGED_USER_DATA_PREFIX = 'freedom-packaged-sandbox-user-data-';

function validateQualificationUserData(userDataRoot, options = {}) {
  if (!userDataRoot || typeof userDataRoot !== 'string') {
    throw new Error('Packaged qualification requires an explicit temporary user-data root');
  }
  const temporaryRoot = fs.realpathSync(options.temporaryRoot || os.tmpdir());
  const canonical = fs.realpathSync(userDataRoot);
  const stats = fs.statSync(canonical);
  if (
    !stats.isDirectory() ||
    canonical === temporaryRoot ||
    !insidePath(temporaryRoot, canonical) ||
    path.dirname(canonical) !== temporaryRoot ||
    !path.basename(canonical).startsWith(PACKAGED_USER_DATA_PREFIX)
  ) {
    throw new Error('Refusing packaged qualification outside its validated user-data root');
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error('Packaged qualification user-data root must be private');
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('Packaged qualification user-data root has an unexpected owner');
  }
  if (options.requireEmpty === true && fs.readdirSync(canonical).length !== 0) {
    throw new Error('Packaged qualification user-data root must be fresh and empty');
  }
  return canonical;
}

function configurePackagedQualificationUserData(electronApp, environment = process.env) {
  if (!electronApp.isPackaged) return null;
  const canonical = validateQualificationUserData(environment[PACKAGED_USER_DATA_ENV], {
    requireEmpty: true,
  });
  electronApp.setPath('userData', canonical);
  return canonical;
}

module.exports = {
  PACKAGED_USER_DATA_ENV,
  PACKAGED_USER_DATA_PREFIX,
  configurePackagedQualificationUserData,
  validateQualificationUserData,
};
