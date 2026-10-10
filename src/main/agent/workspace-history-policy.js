'use strict';

const { unsafeWindowsRelativePath } = require('./workspace-execution/windows-paths');

const HISTORY_LIMITS = Object.freeze({ files: 200, fileBytes: 64 * 1024, totalBytes: 512 * 1024 });

// These functions also run inside the fixed sandbox helper. Keep them self-contained.
// Parent-process coverage counters cannot be serialized into that child. The
// history suite still exercises these functions under coverage via the helper.
/* istanbul ignore next */
function historyPathReason(value, includeGenerated = false) {
  // Only explicit viewer reads opt in; Array.some passes a numeric index here.
  includeGenerated = includeGenerated === true;
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    value.startsWith('/') ||
    unsafeWindowsRelativePath(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return 'unsupported path';
  }
  const parts = value.toLowerCase().split('/');
  if (
    parts.includes('.git') || (!includeGenerated && parts.some((part) =>
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
    ))
  )
    return 'generated or private directory';
  if (
    parts.some((part) =>
      ['secrets', 'secret', '.ssh', '.aws', '.azure', '.gnupg', '.gcloud'].includes(part)
    )
  )
    return 'credential directory';
  const name = parts[parts.length - 1];
  if (/^\.freedom-write-[a-f0-9]{32}$/.test(name)) return 'interrupted private write';
  if (
    /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519))$/.test(
      name
    ) ||
    /\.(?:pem|key|p12|pfx|keystore)$/.test(name)
  )
    return 'secret file';
  if (!includeGenerated && (/\.(?:log|map|zip|tar|gz|tgz|7z|db|sqlite|sqlite3)$/.test(name) || name === '.ds_store'))
    return 'generated or archive file';
  return null;
}

/* istanbul ignore next -- Also serialized into the sandbox helper (see above). */
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

// Validate before acquiring a workspace lease or starting a Git operation. These
// messages contain no caller-supplied data and can be returned directly to models.
function validateHistoryRequest(request) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const invalid = message => fail('WORKSPACE_HISTORY_INVALID_REQUEST', message);
  const actions = ['status', 'diff', 'review', 'exclude', 'include', 'commit', 'checkpoint', 'recovery', 'recover'];
  if (!request || typeof request !== 'object' || Array.isArray(request) || !actions.includes(request.action)) {
    invalid('Choose a supported workspace_history action: status, diff, review, exclude, include, commit, checkpoint, recovery or recover.');
  }
  if (Object.keys(request).some(key => !['action', 'path', 'reason', 'label', 'token', 'resolution', 'reviewIds'].includes(key))) {
    invalid('Use only the documented workspace_history fields. Checkpoint and commit take reviewIds and label, not file paths or shell commands.');
  }
  if (['diff', 'review', 'exclude', 'include'].includes(request.action)) {
    if (typeof request.path !== 'string' || !request.path.trim() || request.path === '.') {
      fail('WORKSPACE_HISTORY_INVALID_PATH', 'Supply path as one exact project-relative filename from status or ls, not the project directory. For example: {"action":"review","path":"index.html"}.');
    }
    if (historyPathReason(request.path)) {
      fail('WORKSPACE_PROTECTED_PATH', 'This path is excluded from project history or is outside the supported project-relative file boundary.');
    }
  }
  if (['commit', 'checkpoint'].includes(request.action)) {
    if (!Array.isArray(request.reviewIds) || !request.reviewIds.length || request.reviewIds.length > HISTORY_LIMITS.files ||
        request.reviewIds.some(id => typeof id !== 'string' || !/^review_[a-f0-9]{32}$/.test(id)) || new Set(request.reviewIds).size !== request.reviewIds.length) {
      fail('WORKSPACE_HISTORY_REVIEW_REQUIRED', 'No commit was attempted. Call workspace_history action review with each selected file path, assess the returned contents, then pass the returned reviewId values in reviewIds with a label. Reading, writing or diffing a file does not create a review token. Never invent tokens.');
    }
    if (typeof request.label !== 'string' || !request.label.trim() || request.label.length > 80 ||
        [...request.label].some(character => character.charCodeAt(0) < 32) || historyContainsSecret(request.label)) {
      invalid('No commit was attempted. Supply label as a short commit message (1–80 characters), without credentials or control characters. Keep the selected reviewIds.');
    }
  }
  if (['exclude', 'include'].includes(request.action) || (request.action === 'recover' && request.resolution === 'keep_current')) {
    if (typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 160 || historyContainsSecret(request.reason)) {
      invalid('Supply reason as a short explanation (1–160 characters) without private data.');
    }
  }
  if (request.action === 'recover' && (typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token) ||
      (request.resolution !== undefined && !['automatic', 'keep_current'].includes(request.resolution)))) {
    invalid('First call action recovery. Use its returned token with action recover and resolution automatic, or keep_current with a reason when appropriate. Do not invent a recovery token.');
  }
}

module.exports = { HISTORY_LIMITS, historyPathReason, historyContainsSecret, validateHistoryRequest };
