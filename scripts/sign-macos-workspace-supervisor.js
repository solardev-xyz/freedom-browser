'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createRequire } = require('module');

const CODESIGN_OPTIONS = { timeout: 60000, maxBuffer: 64 * 1024 };

async function verifySupervisor(run, helper) {
  await run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', helper], CODESIGN_OPTIONS);
  const entitlements = await run('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', helper], CODESIGN_OPTIONS);
  const xml = entitlements.stdout.trim().replace(/^<\?xml[^?]*\?>\s*/, '')
    .replace(/^<!DOCTYPE[^>]*>\s*/, '');
  if (xml !== '' && !/^<plist version="1\.0">\s*(?:<dict\s*\/>|<dict>\s*<\/dict>)\s*<\/plist>$/.test(xml)) {
    throw new Error('Workspace supervisor signing did not produce empty entitlements');
  }
  const details = await run('/usr/bin/codesign', ['--display', '--verbose=2', helper], CODESIGN_OPTIONS);
  if (!/^CodeDirectory .*flags=0x[0-9a-f]+\([^\n)]*\bruntime\b[^\n)]*\)/m.test(details.stderr)) {
    throw new Error('Workspace supervisor is missing hardened runtime signing');
  }
  const team = details.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1];
  if (!team || team === 'not set') throw new Error('Workspace supervisor has no signing team');
  return team;
}

// Sign this leaf first, then update its manifest before the containing app is
// sealed. The normal signer must not rewrite the leaf and invalidate its hash.
function createSupervisorSigner({ run = promisify(execFile), sign } = {}) {
  return async (options) => {
    const helper = path.join(options.app, 'Contents/Resources/workspace-supervisor/freedom-workspace-supervisor');
    const manifestPath = path.join(path.dirname(helper), 'manifest.json');
    const stats = await fs.promises.lstat(helper);
    if (!stats.isFile() || stats.isSymbolicLink() || !options.identity) throw new Error('Cannot sign the workspace supervisor');
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    const args = ['--force', '--sign', options.identity, '--options', 'runtime', '--entitlements',
      path.join(__dirname, '../config/entitlements.workspace-supervisor.mac.plist')];
    if (options.keychain) args.push('--keychain', options.keychain);
    const timestamp = options.optionsForFile?.(helper)?.timestamp;
    args.push(timestamp === false ? '--timestamp=none' : timestamp ? `--timestamp=${timestamp}` : '--timestamp');
    args.push(helper);
    await run('/usr/bin/codesign', args, CODESIGN_OPTIONS);
    const team = await verifySupervisor(run, helper);
    const hash = async () => crypto.createHash('sha256').update(await fs.promises.readFile(helper)).digest('hex');
    const signedHash = await hash();
    await fs.promises.writeFile(manifestPath, `${JSON.stringify({ ...manifest, binarySha256: signedHash }, null, 2)}\n`);
    const originalIgnore = options.ignore;
    const ignore = (file) => file === helper || [originalIgnore].flat().filter(Boolean).some((rule) =>
      typeof rule === 'function' ? rule(file) : Boolean(file.match(rule)));
    // Use the signer already supplied by electron-builder, without acquiring a
    // second tool or changing its identity validation / nested-app behavior.
    const builderRequire = createRequire(require.resolve('app-builder-lib'));
    const signApplication = sign || builderRequire('@electron/osx-sign').signAsync;
    await signApplication({ ...options, ignore });
    if (await hash() !== signedHash) throw new Error('Application signing changed the supervisor after its manifest was sealed');
    if (await verifySupervisor(run, helper) !== team) throw new Error('Workspace supervisor signing team changed');
    const appDetails = await run('/usr/bin/codesign', ['--display', '--verbose=2', options.app], CODESIGN_OPTIONS);
    if (appDetails.stderr.match(/^TeamIdentifier=(.+)$/m)?.[1] !== team) {
      throw new Error('Workspace supervisor and application signing teams differ');
    }
  };
}

exports.createSupervisorSigner = createSupervisorSigner;
exports.default = createSupervisorSigner();
