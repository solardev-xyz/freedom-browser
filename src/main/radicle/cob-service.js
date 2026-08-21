/**
 * Radicle COB (collaborative object) write service.
 *
 * Backend for the window.radicle provider's signing-tier methods. Every
 * write shells out to the bundled `rad` CLI against the active RAD_HOME —
 * COB operations work storage-only via `--repo <rid>`, no working copy.
 * Args are discrete argv entries (never a shell), so payload content can't
 * inject options or commands.
 *
 * Writes announce to the network by default (the node gossips them); the
 * radicle node must be RUNNING or the CLI fails.
 */

const log = require('../logger');
const { runRad, validateAndNormalizeRid, getActiveRadHome } = require('../radicle-manager');

// COB ids as returned by the CLI / accepted by it (full or truncated hex).
const COB_ID_RE = /^[0-9a-f]{6,40}$/;
// `rad issue open` prints "│ Issue   <40-hex> │" — the only 40-hex token
// labelled Issue in the output.
const ISSUE_ID_OUT_RE = /Issue\s+([0-9a-f]{40})/;

const LIMITS = {
  maxTitleBytes: 200,
  maxBodyBytes: 65536,
  maxLabelBytes: 100,
  maxLabels: 10,
};

class CobValidationError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'CobValidationError';
    this.reason = reason;
  }
}

function requireRid(rid) {
  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) throw new CobValidationError('invalid_rid', 'Invalid Radicle repository ID');
  return fullRid;
}

function requireCobId(id, reason) {
  if (typeof id !== 'string' || !COB_ID_RE.test(id)) {
    throw new CobValidationError(reason, 'Invalid collaborative object id');
  }
  return id;
}

function requireText(value, { field, reason, maxBytes, allowEmpty = false }) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new CobValidationError(reason, `${field} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new CobValidationError('payload_too_large', `${field} exceeds ${maxBytes} bytes`);
  }
  return value;
}

/**
 * Extract the created COB id from `-q` output. The id is printed on its
 * own line, but announce chatter ("No seeds found for …") may follow it,
 * so scan for the hex line instead of taking the last one.
 */
function parseQuietCobId(stdout, operation) {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^[0-9a-f]{40}$/.test(l));
  if (!line) {
    log.warn(`[cob-service] ${operation}: could not parse id from quiet output`);
    throw Object.assign(new Error(`${operation} succeeded but id could not be determined`), {
      reason: 'cli_failed',
    });
  }
  return line;
}

/** Map CLI failures to a stable error shape for the provider layer. */
function cliError(err, operation) {
  const stderr = err.stderr?.toString() || '';
  log.error(`[cob-service] ${operation} failed: ${err.message} ${stderr}`);
  const e = new Error(stderr.trim().split('\n').pop() || err.message);
  e.reason = /not found/i.test(stderr) ? 'repo_not_found' : 'cli_failed';
  return e;
}

/**
 * Open an issue. @returns {Promise<{id: string}>}
 */
async function createIssue({ rid, title, description, labels } = {}) {
  const fullRid = requireRid(rid);
  requireText(title, { field: 'title', reason: 'invalid_title', maxBytes: LIMITS.maxTitleBytes });
  requireText(description, {
    field: 'description',
    reason: 'invalid_body',
    maxBytes: LIMITS.maxBodyBytes,
  });

  const args = ['issue', 'open', '--repo', fullRid, '--title', title, '--description', description];
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.length > LIMITS.maxLabels) {
      throw new CobValidationError('invalid_labels', 'labels must be an array (max 10)');
    }
    for (const label of labels) {
      requireText(label, {
        field: 'label',
        reason: 'invalid_labels',
        maxBytes: LIMITS.maxLabelBytes,
      });
    }
    if (labels.length) args.push('--labels', labels.join(','));
  }

  // Deliberately NOT -q: unlike `issue comment`, `issue open -q` prints
  // nothing at all (verified on rad 1.9.1), so the id must be parsed from
  // the verbose output.
  let stdout;
  try {
    ({ stdout } = await runRad(args));
  } catch (err) {
    throw cliError(err, 'createIssue');
  }
  const match = ISSUE_ID_OUT_RE.exec(stdout);
  if (!match) {
    log.warn('[cob-service] createIssue: could not parse issue id from output');
    throw Object.assign(new Error('issue created but id could not be determined'), {
      reason: 'cli_failed',
    });
  }
  return { id: match[1] };
}

/**
 * Comment on an issue. @returns {Promise<{id: string}>}
 */
async function commentIssue({ rid, issueId, body, replyTo } = {}) {
  const fullRid = requireRid(rid);
  requireCobId(issueId, 'invalid_id');
  requireText(body, { field: 'body', reason: 'invalid_body', maxBytes: LIMITS.maxBodyBytes });

  const args = ['issue', 'comment', issueId, '--repo', fullRid, '--message', body, '-q'];
  if (replyTo !== undefined) {
    requireCobId(replyTo, 'invalid_id');
    args.push('--reply-to', replyTo);
  }

  try {
    const { stdout } = await runRad(args);
    return { id: parseQuietCobId(stdout, 'commentIssue') };
  } catch (err) {
    throw cliError(err, 'commentIssue');
  }
}

const ISSUE_STATES = { open: '--open', closed: '--closed', solved: '--solved' };

/**
 * Transition issue state. @returns {Promise<{id: string, state: string}>}
 */
async function editIssueState({ rid, issueId, state } = {}) {
  const fullRid = requireRid(rid);
  requireCobId(issueId, 'invalid_id');
  const flag = ISSUE_STATES[state];
  if (!flag) {
    throw new CobValidationError('invalid_state', "state must be 'open', 'closed' or 'solved'");
  }

  try {
    await runRad(['issue', 'state', issueId, '--repo', fullRid, flag, '-q']);
    return { id: issueId, state };
  } catch (err) {
    throw cliError(err, 'editIssueState');
  }
}

/**
 * Comment on a patch revision. The patch id doubles as the first revision's
 * id, so callers without a specific revision can pass the patch id.
 * @returns {Promise<{id: string}>}
 */
async function commentPatch({ rid, patchId, body, revisionId } = {}) {
  const fullRid = requireRid(rid);
  requireCobId(patchId, 'invalid_id');
  const target = revisionId !== undefined ? requireCobId(revisionId, 'invalid_id') : patchId;
  requireText(body, { field: 'body', reason: 'invalid_body', maxBytes: LIMITS.maxBodyBytes });

  try {
    const { stdout } = await runRad([
      'patch',
      'comment',
      target,
      '--repo',
      fullRid,
      '--message',
      body,
      '-q',
    ]);
    return { id: parseQuietCobId(stdout, 'commentPatch') };
  } catch (err) {
    throw cliError(err, 'commentPatch');
  }
}

/**
 * The user's Radicle identity. Immutable for a given RAD_HOME, so the two
 * CLI spawns are memoized per home — getNodeStatus may be polled.
 * @returns {Promise<{did, nid, alias}>}
 */
let identityCache = null; // { radHome, identity }
/** Invalidate the memoized identity (e.g. after an alias change). */
function clearIdentityCache() {
  identityCache = null;
}
async function getIdentity() {
  const radHome = getActiveRadHome();
  if (identityCache?.radHome === radHome) return identityCache.identity;
  try {
    const [didOut, aliasOut] = await Promise.all([
      runRad(['self', '--did']),
      runRad(['self', '--alias']),
    ]);
    const did = didOut.stdout.trim();
    const identity = { did, nid: did.replace(/^did:key:/, ''), alias: aliasOut.stdout.trim() };
    identityCache = { radHome, identity };
    return identity;
  } catch (err) {
    throw cliError(err, 'getIdentity');
  }
}

module.exports = {
  createIssue,
  commentIssue,
  editIssueState,
  commentPatch,
  getIdentity,
  clearIdentityCache,
  CobValidationError,
  LIMITS,
};
