const fs = require('fs');
const path = require('path');

function addonPathCandidates() {
  const devPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'native',
    'freedom-ipfs-node',
    'build',
    'Release',
    'freedom_ipfs_native.node'
  );
  const packagedPath =
    process.resourcesPath &&
    path.join(process.resourcesPath, 'freedom-ipfs-node', 'freedom_ipfs_native.node');
  return [devPath, packagedPath].filter(Boolean);
}

function loadNativeBinding() {
  const tried = [];
  for (const candidate of addonPathCandidates()) {
    tried.push(candidate);
    if (!fs.existsSync(candidate)) continue;
    return require(candidate);
  }
  const message = `freedom-ipfs native addon not found. Tried: ${tried.join(', ')}`;
  const err = new Error(message);
  err.code = 'FREEDOM_IPFS_NATIVE_ADDON_MISSING';
  throw err;
}

// Why the add-on can't load, or null when it can.
function nativeBindingLoadError() {
  try {
    loadNativeBinding();
    return null;
  } catch (err) {
    return err;
  }
}

function isNativeBindingAvailable() {
  return nativeBindingLoadError() === null;
}

// Linux's dynamic loader names the first symbol version the system lacks:
// "version `GLIBC_2.38' not found (required by …/freedom_ipfs_native.node)".
// The add-on is built against a newer glibc than older distributions ship
// (#350), and no restart fixes that.
const GLIBC_MISSING_RE = /GLIBC_[\d.]+'? not found/;

function hostGlibcVersion() {
  try {
    return process.report?.getReport?.()?.header?.glibcVersionRuntime || null;
  } catch {
    return null;
  }
}

// `{ host }` (the system's glibc version, when known) if `err` is that
// failure, otherwise null.
function describeGlibcTooOld(err) {
  if (!GLIBC_MISSING_RE.test(String(err?.message || ''))) return null;
  return { host: hostGlibcVersion() };
}

module.exports = {
  loadNativeBinding,
  nativeBindingLoadError,
  isNativeBindingAvailable,
  describeGlibcTooOld,
  addonPathCandidates,
};
