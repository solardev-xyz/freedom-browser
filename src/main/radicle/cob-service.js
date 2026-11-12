/**
 * Radicle COB (collaborative object) write service.
 *
 * Backend for the window.radicle provider's signing-tier methods. Writes
 * go directly through the in-process libradicle addon and its COB stores.
 *
 * Under the freedom-radicled service (freedom-core design 0008, Main's
 * side, "The active identity belongs to the generation"):
 * - **a write is admitted by the running generation alone:** while its key
 *   is a throwaway one, each write is refused (`needs_vault`, a
 *   CobAdmissionError) before anything is sent, before its guard and again
 *   just before the write's call, in the guard's run;
 * - **the identity is kept for its generation only:** a restart, under a
 *   new throwaway key or the derived one, reads it again.
 */

const embedded = require('../radicle-embedded');
const {
  validateAndNormalizeRid,
  activeRadicleIdentity,
  radicleWriteRefusal,
} = require('../radicle-manager');

// COB ids as returned by the CLI / accepted by it (full or truncated hex).
const COB_ID_RE = /^[0-9a-f]{6,40}$/;

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

// A write the running node can't make: under the service, a generation with
// a throwaway key (`needs_vault`; 0008, "Profiles without a vault").
class CobAdmissionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'CobAdmissionError';
    this.reason = reason;
  }
}

/** Throws a CobAdmissionError unless the running node may write now. */
function requireWriteAdmission() {
  const refusal = radicleWriteRefusal();
  if (refusal) throw new CobAdmissionError(refusal.reason, refusal.message);
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

function nativeError(err) {
  if (/announce refs failed/i.test(err.message)) err.reason = 'announce_failed';
  else err.reason = /not found/i.test(err.message) ? 'repo_not_found' : 'native_failed';
  return err;
}

// What each signed write signs, from the page's params as the write accepts
// them: the repository id normalized, each id in its form and each text
// within its bound. Throws a CobValidationError for params it refuses. Main's
// per-write prompt shows exactly these fields (freedom-core design 0011,
// "What a prompt shows"), and the write signs them.

function issueFields({ rid, title, description, labels } = {}) {
  const fields = { rid: requireRid(rid) };
  fields.title = requireText(title, { field: 'title', reason: 'invalid_title', maxBytes: LIMITS.maxTitleBytes });
  fields.description = requireText(description, {
    field: 'description',
    reason: 'invalid_body',
    maxBytes: LIMITS.maxBodyBytes,
  });
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
    fields.labels = labels.slice();
  }
  return fields;
}

function issueCommentFields({ rid, issueId, body, replyTo } = {}) {
  const fields = { rid: requireRid(rid), issueId: requireCobId(issueId, 'invalid_id') };
  fields.body = requireText(body, { field: 'body', reason: 'invalid_body', maxBytes: LIMITS.maxBodyBytes });
  if (replyTo !== undefined) fields.replyTo = requireCobId(replyTo, 'invalid_id');
  return fields;
}

const ISSUE_STATES = new Set(['open', 'closed', 'solved']);

function issueStateFields({ rid, issueId, state } = {}) {
  const fields = { rid: requireRid(rid), issueId: requireCobId(issueId, 'invalid_id') };
  if (!ISSUE_STATES.has(state)) {
    throw new CobValidationError('invalid_state', "state must be 'open', 'closed' or 'solved'");
  }
  fields.state = state;
  return fields;
}

// The patch id doubles as the first revision's id, so callers without a
// specific revision can pass the patch id.
function patchCommentFields({ rid, patchId, body, revisionId } = {}) {
  const fields = { rid: requireRid(rid), patchId: requireCobId(patchId, 'invalid_id') };
  if (revisionId !== undefined) fields.revisionId = requireCobId(revisionId, 'invalid_id');
  fields.body = requireText(body, { field: 'body', reason: 'invalid_body', maxBytes: LIMITS.maxBodyBytes });
  return fields;
}

const WRITE_FIELDS = Object.freeze({
  radicle_createIssue: issueFields,
  radicle_commentIssue: issueCommentFields,
  radicle_editIssueState: issueStateFields,
  radicle_commentPatch: patchCommentFields,
});

/**
 * The fields a signed write of `method` signs, from the page's `params`.
 * Throws a CobValidationError for params the write refuses.
 */
function validateWrite(method, params) {
  const fields = Object.prototype.hasOwnProperty.call(WRITE_FIELDS, method) ? WRITE_FIELDS[method] : null;
  if (!fields) throw new CobValidationError('invalid_method', 'Not a signed write');
  return fields(params && typeof params === 'object' ? params : {});
}

/**
 * The add-on's signed write, under a page's guard (freedom-core design 0011,
 * PRQ-8c): the add-on signs and publishes in one call, so `guard(write)`
 * checks the page again and makes the call in the same run, or resolves
 * null to write nothing. With no guard, it writes.
 *
 * The running node's admission (0008, `needs_vault`) is checked before the
 * guard, and again in the guard's run, with nothing awaited between it and
 * the call: a restart while the guard waits is seen.
 */
async function signedWrite(guard, write) {
  requireWriteAdmission();
  const admitted = () => {
    requireWriteAdmission();
    return write();
  };
  try {
    return typeof guard === 'function' ? await guard(admitted) : await admitted();
  } catch (err) {
    if (err instanceof CobAdmissionError) throw err;
    throw nativeError(err);
  }
}

/**
 * Open an issue. @returns {Promise<{id: string}>}
 */
async function createIssue(params = {}, { guard } = {}) {
  const fields = issueFields(params);
  return signedWrite(guard, () =>
    embedded.createIssue(fields.rid, fields.title, fields.description, fields.labels || [])
  );
}

/**
 * Comment on an issue. @returns {Promise<{id: string}>}
 */
async function commentIssue(params = {}, { guard } = {}) {
  const fields = issueCommentFields(params);
  return signedWrite(guard, () => embedded.commentIssue(fields.rid, fields.issueId, fields.body, fields.replyTo));
}

/**
 * Transition issue state. @returns {Promise<{id: string, state: string}>}
 */
async function editIssueState(params = {}, { guard } = {}) {
  const fields = issueStateFields(params);
  return signedWrite(guard, () => embedded.editIssueState(fields.rid, fields.issueId, fields.state));
}

/**
 * Comment on a patch revision, the patch's first one unless `revisionId`
 * names another. @returns {Promise<{id: string}>}
 */
async function commentPatch(params = {}, { guard } = {}) {
  const fields = patchCommentFields(params);
  return signedWrite(guard, () => embedded.commentPatch(fields.rid, fields.revisionId ?? fields.patchId, fields.body));
}

/**
 * The user's Radicle identity. Memoized while the node is running.
 *
 * Under the service, it is kept for the generation it was read from, and
 * dropped with it (0008, Main's side): `generation` is that generation's
 * identity (activeRadicleIdentity), and a value read while another
 * generation took over is not kept. (With none running, the service's read
 * fails `stopped`.) Under the add-on, `generation` is always null, and the
 * value is kept until cleared, as before.
 * @returns {Promise<{did, nid, alias}>}
 */
let identityCache = null; // { value, generation }
/** Invalidate the memoized identity (e.g. after an alias change). */
function clearIdentityCache() {
  identityCache = null;
}
async function getIdentity() {
  const generation = activeRadicleIdentity();
  if (identityCache && identityCache.generation === generation) return identityCache.value;
  identityCache = null;
  let value;
  try {
    value = await embedded.identity();
  } catch (err) {
    throw nativeError(err);
  }
  if (activeRadicleIdentity() === generation) identityCache = { value, generation };
  return value;
}

module.exports = {
  createIssue,
  commentIssue,
  editIssueState,
  commentPatch,
  getIdentity,
  clearIdentityCache,
  validateWrite,
  CobValidationError,
  CobAdmissionError,
  LIMITS,
};
