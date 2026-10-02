'use strict';

const crypto = require('crypto');
const path = require('path');
const { historyContainsSecret } = require('./workspace-history-policy');

function containsSecret(value) {
  if (typeof value === 'string') return historyContainsSecret(value) || /\b(?:token|password|secret|api[_-]?key|authorization)\s*=\s*(?!\$)[\"']?[A-Za-z0-9_+/.=-]{8,}/i.test(value);
  return value && typeof value === 'object' && Object.values(value).some(containsSecret);
}

// Read only through the controller's existing sandbox/project boundary. Never
// inspect host npm configuration or include raw npm credentials in a review.
async function collectCommandReviewEvidence(controller, conversationId, permission, options = {}) {
  if (!/^npm\s/.test(permission.command || '')) return { data: { status: 'not_collected', reason: 'Only npm project evidence is currently supported.' }, fingerprint: null };
  const directory = permission.workingDirectory || '.';
  if (path.posix.isAbsolute(directory) || directory.split('/').includes('..') || directory.includes('\\')) {
    return { data: { status: 'unavailable' }, fingerprint: null };
  }
  const records = [];
  const hashes = [];
  let budget = 24 * 1024;
  async function read(relativePath, format) {
    try {
      const bytes = await controller.readFile(conversationId, relativePath, { signal: options.signal });
      hashes.push([relativePath, crypto.createHash('sha256').update(bytes).digest('hex')]);
      if (bytes.length > 128 * 1024) return records.push({ path: relativePath, status: 'too_large' });
      const text = bytes.toString('utf8');
      let content;
      if (format === 'config') {
        // Presence alone is useful: custom registry/auth settings require human
        // review until they can be inspected without disclosing credentials.
        return records.push({ path: relativePath, status: 'present_not_disclosed' });
      }
      if (format === 'manifest') {
        const manifest = JSON.parse(text);
        content = Object.fromEntries(['name', 'scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'overrides', 'workspaces', 'packageManager'].filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
      } else content = text;
      const encoded = JSON.stringify(content);
      if (historyContainsSecret(encoded) || containsSecret(content)) return records.push({ path: relativePath, status: 'sensitive_content_omitted' });
      if (Buffer.byteLength(encoded) > budget) return records.push({ path: relativePath, status: 'too_large' });
      budget -= Buffer.byteLength(encoded);
      records.push({ path: relativePath, status: 'read', content });
      return content;
    } catch (error) {
      const status = error?.code === 'ENOENT' || ['WORKSPACE_FILE_NOT_FOUND', 'WORKSPACE_PATH_NOT_FOUND'].includes(error?.code) ? 'missing' : 'unavailable';
      hashes.push([relativePath, status]);
      records.push({ path: relativePath, status });
    }
  }
  const dirs = [];
  let current = directory;
  for (let count = 0; count < 8; count++) {
    dirs.push(current);
    if (current === '.') break;
    current = path.posix.dirname(current);
  }
  let manifest;
  for (const dir of dirs) {
    const value = await read(path.posix.join(dir, 'package.json'), 'manifest');
    if (dir === directory) manifest = value;
    await read(path.posix.join(dir, '.npmrc'), 'config');
  }
  // Include small directly referenced project scripts, never arbitrary paths or
  // node_modules trees. Dependencies are evidence, not a certification of code.
  const scriptFiles = new Set();
  for (const script of Object.values(manifest?.scripts || {})) {
    if (typeof script !== 'string') continue;
    for (const match of script.matchAll(/(?:^|\s)(?:node|bash|sh)\s+((?:\.\/)?[\w./-]+\.(?:js|mjs|cjs|sh))(?=\s|$)/g)) {
      if (!match[1].startsWith('/') && !match[1].split('/').includes('..')) scriptFiles.add(path.posix.join(directory, match[1]));
    }
  }
  for (const file of [...scriptFiles].slice(0, 4)) await read(file, 'script');
  return {
    data: { status: 'collected', records, scope: 'Project manifests, npm config presence and at most four directly referenced scripts. Transitive package code and lockfiles are not inspected.' },
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
  };
}

module.exports = { collectCommandReviewEvidence };
