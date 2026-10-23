'use strict';

const fs = require('fs');
const path = require('path');
const removeLocales = require('./remove-locales').default;

exports.default = async function prepareAgentSandboxLinuxPackage(context) {
  await removeLocales(context);
  const helper = path.join(context.appOutDir, 'chrome-sandbox');
  const stats = await fs.promises.stat(helper);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Qualification package Chromium sandbox helper is not a regular file');
  }
  // Chromium refuses a non-root launch when this bundled helper is present but
  // lacks its required setuid mode. This is the standard upstream Chromium
  // process sandbox, not a --no-sandbox qualification workaround.
  await fs.promises.chmod(helper, 0o4755);
};
