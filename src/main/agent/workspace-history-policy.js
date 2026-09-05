'use strict';

const HISTORY_LIMITS = Object.freeze({ files: 200, fileBytes: 64 * 1024, totalBytes: 512 * 1024 });

// These functions also run inside the fixed sandbox helper. Keep them self-contained.
function historyPathReason(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return 'unsupported path';
  }
  const parts = value.toLowerCase().split('/');
  if (
    parts.some((part) =>
      [
        '.git',
        'node_modules',
        'dist',
        'build',
        'coverage',
        '.vite',
        '.next',
        '.nuxt',
        '.cache',
        '.parcel-cache',
        '.turbo',
        '.svelte-kit',
        '.pytest_cache',
        '.mypy_cache',
        '.ruff_cache',
        '__pycache__',
        '.venv',
        'venv',
        'target',
        '.idea',
      ].includes(part)
    )
  )
    return 'generated or private directory';
  if (
    parts.some((part) =>
      ['secrets', 'secret', '.ssh', '.aws', '.azure', '.gnupg', '.gcloud'].includes(part)
    )
  )
    return 'credential directory';
  const name = parts[parts.length - 1];
  if (
    /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519))$/.test(
      name
    ) ||
    /\.(?:pem|key|p12|pfx|keystore)$/.test(name)
  )
    return 'secret file';
  if (/\.(?:log|map|zip|tar|gz|tgz|7z|db|sqlite|sqlite3)$/.test(name) || name === '.ds_store')
    return 'generated or archive file';
  return null;
}

function historyContainsSecret(value) {
  const text = typeof value === 'string' ? value : value.toString('utf8');
  if (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{20,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/.test(
      text
    )
  )
    return true;
  if (/https?:\/\/[^\s/:]+:[^\s/@]+@/i.test(text)) return true;
  const assignments =
    /["']?(?:password|passwd|api[_-]?key|secret|token|access[_-]?token|auth[_-]?token|authorization|private[_-]?key|credential)["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi;
  for (const match of text.matchAll(assignments)) {
    if (
      !/^(?:\$\{|process\.env\.|your[_ -]|example|placeholder|changeme|test|dummy|<)/i.test(
        match[1]
      )
    )
      return true;
  }
  const bareAssignments =
    /^\s*(?:password|passwd|api[_-]?key|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*([A-Za-z0-9_+/.=-]{8,})\s*(?:#.*)?$/gim;
  for (const match of text.matchAll(bareAssignments)) {
    if (!/^(?:your[_-]|example|placeholder|changeme|test|dummy)/i.test(match[1])) return true;
  }
  return false;
}

module.exports = { HISTORY_LIMITS, historyPathReason, historyContainsSecret };
