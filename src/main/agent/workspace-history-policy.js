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
  // Every pattern is bounded, and open-ended runs are walked by searching for
  // the first character outside them: an open-ended `X*` can push one regexp
  // backtrack entry per character and throw on a run of millions (see
  // publication-scan.js). Self-contained, so it still serializes.
  const runEnd = (from, stop) => {
    stop.lastIndex = from;
    const found = stop.exec(text);
    return found ? found.index : text.length;
  };
  if (
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{20}/.test(
      text
    )
  )
    return true;
  // -----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----
  const pem = /-----BEGIN /g;
  for (let match = pem.exec(text); match; match = pem.exec(text)) {
    const start = match.index + match[0].length;
    const end = runEnd(start, /[^A-Z ]/g);
    const prefix = end - start - 'PRIVATE KEY'.length;
    if (prefix >= 0 && text.startsWith('PRIVATE KEY-----', end - 'PRIVATE KEY'.length) &&
        (prefix === 0 || (prefix >= 2 && text[start + prefix - 1] === ' '))) return true;
  }
  // `\s*` around the assignment operator, walked: any run of Unicode spaces
  // (a BOM, NBSP, blank lines) before a fixed character.
  const spaceThen = (from, next) => {
    const end = runEnd(from, /\S/g);
    return next.includes(text[end]) ? end : -1;
  };
  const notToken = /[^A-Za-z0-9_-]/g;
  const jwt = /\beyJ[A-Za-z0-9_-]{12}/g;
  for (let match = jwt.exec(text); match; match = jwt.exec(text)) {
    const first = runEnd(match.index + match[0].length, notToken);
    const second = text[first] === '.' ? runEnd(first + 1, notToken) : -1;
    const third = second - first > 12 && text[second] === '.' ? runEnd(second + 1, notToken) : -1;
    if (third - second > 12) return true;
    jwt.lastIndex = Math.max(first, match.index + 1);
  }
  const url = /https?:\/\//gi;
  for (let match = url.exec(text); match; match = url.exec(text)) {
    const user = runEnd(match.index + match[0].length, /[\s/:]/g);
    if (user === match.index + match[0].length || text[user] !== ':') continue;
    const password = runEnd(user + 1, /[\s/@]/g);
    if (password > user + 1 && text[password] === '@') return true;
  }
  // ["']? key ["']? \s* [:=] \s* ["'] value{8,} ["']
  const assignments =
    /(?:password|passwd|api[_-]?key|secret|token|access[_-]?token|auth[_-]?token|authorization|private[_-]?key|credential)/gi;
  for (let match = assignments.exec(text); match; match = assignments.exec(text)) {
    const name = match.index + match[0].length;
    const operator = spaceThen(name + (text[name] === '"' || text[name] === "'" ? 1 : 0), ':=');
    const quote = operator === -1 ? -1 : spaceThen(operator + 1, '"\'');
    if (quote === -1) continue;
    const end = runEnd(quote + 1, /["'\r\n]/g);
    if (end - quote - 1 < 8 || (text[end] !== '"' && text[end] !== "'")) continue;
    // A placeholder value is skipped whole, as matchAll did.
    assignments.lastIndex = end + 1;
    if (
      !/^(?:\$\{|process\.env\.|your[_ -]|example|placeholder|changeme|test|dummy|<)/i.test(
        text.slice(quote + 1, quote + 41)
      )
    )
      return true;
  }
  // ^\s* key \s* [:=] \s* value{8,} \s* (#.*)? $, multiline.
  const lineEnd = /[\n\r\u2028\u2029]/;
  const bareAssignments =
    /(?:password|passwd|api[_-]?key|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key)/gi;
  for (let match = bareAssignments.exec(text); match; match = bareAssignments.exec(text)) {
    let lineStart = match.index;
    let opens = false;
    while (lineStart > 0 && /\s/.test(text[lineStart - 1]) && !opens) {
      lineStart -= 1;
      opens = lineEnd.test(text[lineStart]);
    }
    if (!opens && lineStart !== 0) continue;
    const operator = spaceThen(match.index + match[0].length, ':=');
    if (operator === -1) continue;
    const start = runEnd(operator + 1, /\S/g);
    // The value must end its line, optionally followed by blanks and a # comment.
    const end = runEnd(start, /[^A-Za-z0-9_+/.=-]/g);
    const after = runEnd(end, /\S|[\n\r\u2028\u2029]/g);
    if (
      end - start >= 8 &&
      (after === text.length || text[after] === '#' || lineEnd.test(text[after])) &&
      !/^(?:your[_-]|example|placeholder|changeme|test|dummy)/i.test(text.slice(start, start + 40))
    )
      return true;
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
