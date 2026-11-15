/**
 * The drain of the forget file (freedom-core design 0013, "Forgetting an
 * item", step PRF-2): deleted profiles' key-store items, which main forgets
 * through the helper, with no core.
 *
 * `profile delete` records the target's items in the app's forget file
 * (`profile-registry.json.forget`) before the catalog changes, and lists them
 * in its result. Main then:
 *
 * - **right after a delete,** runs the helper's `forget` for each item the
 *   result lists, then `profile forget-done` for those that answered `ok` or
 *   `not_found` (an item already gone counts as forgotten), each read
 *   exactly as the core reads a helper's answer;
 * - **at the start of any profile** whose `profile open` reported
 *   `forget_pending`, after its first window and never on the startup path,
 *   runs `profile forget-list`, the helper for each item, then
 *   `forget-done`;
 * - **for a delete refused with `forget_backlog`** (the forget file is
 *   full), drains the file and asks once more (profile-manager.js).
 *
 * Every other answer keeps the record, and the next start tries again:
 * nothing retries on a timer. Each step can die without harm. Main killed
 * before the helper runs leaves the record; a helper killed or held past its
 * 10 s leaves it too; main killed between the helper's answer and
 * `forget-done` leaves a record whose next `forget` answers `not_found`. Two
 * mains draining at once do no harm: a second `forget` of an item answers
 * `not_found`, and `forget-done` for an id no longer listed changes nothing.
 *
 * The helper runs through keystore-shell.js's runner, one at a time with the
 * core's own `shell.keystore` calls, each under `forget`'s 10 s deadline,
 * and only where the helper has a key store (macOS). Elsewhere no item is
 * made, but the drain still runs `forget-list`, which drops the records a
 * profile copied from another OS brought, and calls no helper.
 */

const {
  MAX_ANSWER_BYTES,
  checkRequest,
  getHelperRunner,
  hasKeystoreBackend,
} = require('./core/keystore-shell');
const subcommands = require('./profile-subcommands');

const NOOP_STEP = () => {};

// The helper's answer, as the core reads it (freedom-cored's
// `keystore::Answer::parse`): one JSON object, each member at most once.
// `NotFound` has these members, and its `reason` a fixed form.
const NOT_FOUND_MEMBERS = new Set(['ok', 'error', 'reason']);
const REASON = /^[a-z0-9_]{1,32}$/;
// JSON's whitespace, a string (no raw control character; JSON's escapes),
// and the two literals a member of a forget's answer can be.
const SPACE = /[ \t\n\r]*/y;
// eslint-disable-next-line no-control-regex -- JSON refuses them raw in a string.
const STRING = /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y;
const BOOLEAN = /true|false/y;

function defaultLog() {
  return require('./logger');
}

/** `freedom-cored profile <sub> --app-root <dir> …`'s result. */
async function runSubcommand(sub, appRoot, extra = []) {
  const command = require('./core/cored-binary').getCoredBinaryPath();
  const { result } = await subcommands.run(command, [
    'profile',
    sub,
    '--app-root',
    appRoot,
    ...extra,
  ]);
  return result;
}

/**
 * The members of the JSON object `line` is, in a Map, read from its bytes:
 * null for anything else, for a member named twice (JSON.parse would keep
 * the last; the core refuses it), and for a member whose value isn't a
 * string or a boolean (no answer a forget can clear has one).
 */
function answerMembers(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_ANSWER_BYTES) return null;
  let at = 0;
  const take = (pattern) => {
    pattern.lastIndex = at;
    const match = pattern.exec(line);
    if (match === null) return null;
    at = pattern.lastIndex;
    return match[0];
  };
  const members = new Map();
  take(SPACE);
  if (line[at] !== '{') return null;
  at += 1;
  take(SPACE);
  if (line[at] === '}') {
    at += 1;
  } else {
    for (;;) {
      take(SPACE);
      const name = take(STRING);
      if (name === null) return null;
      take(SPACE);
      if (line[at] !== ':') return null;
      at += 1;
      take(SPACE);
      const value = take(STRING) ?? take(BOOLEAN);
      if (value === null) return null;
      const key = JSON.parse(name);
      if (members.has(key)) return null;
      members.set(key, JSON.parse(value));
      take(SPACE);
      if (line[at] === ',') {
        at += 1;
      } else if (line[at] === '}') {
        at += 1;
        break;
      } else {
        return null;
      }
    }
  }
  take(SPACE);
  return at === line.length ? members : null;
}

/**
 * Whether the helper's answer to a `forget` says the item is gone, read as
 * the core reads it (0013, "The answer"): `Done`, which is `{ ok: true }`
 * and nothing else, or `NotFound`, which is `{ ok: false, error:
 * "not_found" }` with at most a `reason` in form. A member named twice, an
 * unknown member, a `key` or `sealed`, an `error` or `reason` beside `ok:
 * true`, or anything out of form keeps the record.
 */
function isForgotten(line) {
  const members = answerMembers(line);
  if (members === null) return false;
  if (members.get('ok') === true) return members.size === 1;
  if (members.get('ok') !== false || members.get('error') !== 'not_found') return false;
  if (![...members.keys()].every((name) => NOT_FOUND_MEMBERS.has(name))) return false;
  const reason = members.get('reason');
  return reason === undefined || (typeof reason === 'string' && REASON.test(reason));
}

/** The `{ policy, item }` entries of `listed` in form, each once. */
function itemsInForm(listed) {
  const seen = new Set();
  const items = [];
  for (const entry of Array.isArray(listed) ? listed : []) {
    let request;
    try {
      request = checkRequest({ op: 'forget', policy: entry?.policy, item: entry?.item });
    } catch {
      continue;
    }
    if (seen.has(request.item)) continue;
    seen.add(request.item);
    items.push(request);
  }
  return items;
}

/**
 * Forgets `listed` (`[{ policy, item }]`, as `profile delete` and `forget-list`
 * give them) through the helper, then drops those that are gone from the
 * forget file with `forget-done`. Resolves to `{ forgotten, kept }`, the
 * counts.
 *
 * @param {string} appRoot - the app root whose forget file names them
 * @param {Array} listed
 * @param {object} [deps]
 * @param {object} [deps.runner] - keystore-shell.js's runner
 * @param {Function} [deps.subcommand] - `(sub, appRoot, extraArgs)` → result
 * @param {Function} [deps.step] - called with `before-helper` and
 *   `before-forget-done`, for tests that stop main there
 * @param {string} [deps.platform]
 */
async function forgetItems(appRoot, listed, deps = {}) {
  const {
    runner = getHelperRunner(),
    subcommand = runSubcommand,
    step = NOOP_STEP,
    platform = process.platform,
    log = defaultLog(),
  } = deps;
  const items = itemsInForm(listed);
  // No helper call where it has no key store: nothing is forgotten.
  if (!hasKeystoreBackend(platform)) return { forgotten: 0, kept: items.length };
  if (items.length === 0) return { forgotten: 0, kept: 0 };
  const gone = [];
  for (const request of items) {
    await step('before-helper', request.item);
    let line = null;
    try {
      line = await runner.run(request);
    } catch (error) {
      log.warn('[keystore] A forget did not finish; the record stays', { code: error?.code });
    }
    if (line !== null && isForgotten(line)) gone.push(request.item);
  }
  if (gone.length > 0) {
    await step('before-forget-done', gone);
    await subcommand(
      'forget-done',
      appRoot,
      gone.flatMap((item) => ['--item', item])
    );
  }
  return { forgotten: gone.length, kept: items.length - gone.length };
}

/**
 * Drains the forget file at `appRoot`: `forget-list`, the helper for each
 * item, then `forget-done`. Resolves to forgetItems' counts.
 *
 * `forget-list` runs on every OS: it drops, with no call, each record of a
 * backend this OS doesn't have (a profile copied from another OS, 0013 "An
 * item already gone"). Where the helper has no key store (Linux and
 * Windows, until PRF-7) no helper runs for what it lists, and no
 * `forget-done` either.
 */
async function drainForgetFile(appRoot, deps = {}) {
  const { subcommand = runSubcommand } = deps;
  const listed = await subcommand('forget-list', appRoot, []);
  return forgetItems(appRoot, listed?.items, deps);
}

/**
 * The start's drain, after the first window (index.js): only for a catalog
 * profile whose `profile open` reported `forget_pending`. Never throws.
 */
async function drainAfterFirstWindow(deps = {}) {
  const resolver = deps.resolver || require('./profile-resolver');
  const log = deps.log || defaultLog();
  const pending = resolver.getProfileLaunchReport()?.forgetPending;
  const profile = resolver.getActiveProfile();
  if (!(pending > 0) || profile?.source !== 'catalog') return null;
  try {
    const counts = await drainForgetFile(profile.appRoot, { ...deps, log });
    log.info('[keystore] Drained the forget file', counts);
    return counts;
  } catch (error) {
    log.warn('[keystore] Could not drain the forget file', { code: error?.code });
    return null;
  }
}

module.exports = {
  drainAfterFirstWindow,
  drainForgetFile,
  forgetItems,
  isForgotten,
  itemsInForm,
};
