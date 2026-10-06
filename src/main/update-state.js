/**
 * Auto-update state machine (#87).
 *
 * `updater.js` feeds electron-updater's events in here; the result is one
 * snapshot every surface renders from — the hamburger menu item, the dot on
 * the hamburger button and Settings → About Freedom → Updates. It is pure (no electron, no
 * timers) so the transitions are unit-testable on their own.
 *
 * Statuses:
 *   idle         nothing has happened yet this session (or a check is due)
 *   checking     asking the update server
 *   downloading  an update was found and is downloading (`percent`)
 *   ready        downloaded; restart to install (sticky — see below)
 *   up-to-date   the last check found nothing newer
 *   error        the last check or download failed
 *   unsupported  this process can't update itself (`reason` says why)
 *
 * The snapshot never carries a raw error message: it is broadcast to every
 * webContents, and electron-updater's messages can contain the feed URL or a
 * local file path. The full error goes to the log only.
 */

const STATUS = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  UP_TO_DATE: 'up-to-date',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
});

const UNSUPPORTED_REASON = Object.freeze({
  // A dev checkout run without ENABLE_DEV_UPDATER.
  DEVELOPMENT: 'development',
  // electron-updater can't update this copy: not packaged, a Linux build that
  // isn't an AppImage/deb/pacman install, or no app-update.yml in the package.
  BUILD: 'build',
  // Another open profile process holds the updater lock (updater-owner-lock).
  NOT_OWNER: 'not-owner',
  // The updater was never started in this process (E2E test mode).
  INACTIVE: 'inactive',
});

const UNSUPPORTED_MESSAGES = {
  [UNSUPPORTED_REASON.DEVELOPMENT]: 'Updates are off in development builds.',
  [UNSUPPORTED_REASON.BUILD]:
    "This copy of Freedom can't update itself. Get new versions from freedom.baby.",
  [UNSUPPORTED_REASON.NOT_OWNER]: 'Another open Freedom profile is handling updates.',
  [UNSUPPORTED_REASON.INACTIVE]: "Updates aren't checked in this session.",
};

const ERROR_MESSAGES = {
  network: "Couldn't reach the update server.",
  download: "The update couldn't be downloaded.",
  check: 'The update check failed.',
};

// What happens next depends on the "Automatically check for updates" switch:
// with it off nothing retries in the background, so don't promise it. This
// sentence is shared by Settings → About Freedom → Updates and the hamburger menu row's
// tooltip, whose controls are labelled differently ("Check now" vs "Check for
// Updates…"), so it names neither.
const RETRY_NOTE = {
  auto: 'Freedom will try again later.',
  manual: "Automatic checks are off, so Freedom won't retry on its own.",
};

const IDLE_MESSAGES = {
  auto: 'Freedom checks for updates automatically.',
  manual: 'Automatic update checks are off.',
};

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cleanVersion(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function initialState({ currentVersion = null, reason = UNSUPPORTED_REASON.INACTIVE } = {}) {
  return {
    status: STATUS.UNSUPPORTED,
    reason,
    currentVersion,
    version: null,
    percent: null,
    bytesPerSecond: null,
    transferred: null,
    total: null,
    lastChecked: null,
    error: null,
  };
}

const DOWNLOAD_FIELDS = { percent: null, bytesPerSecond: null, transferred: null, total: null };

/**
 * Pure transition: returns the next state for `event` (a new object, or the
 * same one when the event changes nothing).
 *
 * `ready` is sticky: once an update is staged, a later periodic check, a
 * "no update" answer or a transient error must not hide the Restart button.
 * Only a newer version being found (or downloaded) moves it.
 */
function reduceUpdateState(state, event, { now = Date.now } = {}) {
  if (!event || typeof event.type !== 'string') return state;

  if (state.status === STATUS.READY) {
    if (event.type === 'downloaded') {
      return { ...state, version: cleanVersion(event.version) || state.version };
    }
    if (event.type === 'available') {
      const version = cleanVersion(event.version);
      if (!version || version === state.version) return state;
      // A newer release than the staged one: fall through and download it.
    } else {
      return state;
    }
  }

  switch (event.type) {
    case 'supported':
      if (state.status !== STATUS.UNSUPPORTED) return state;
      return { ...state, status: STATUS.IDLE, reason: null, error: null };

    case 'unsupported':
      return {
        ...state,
        ...DOWNLOAD_FIELDS,
        status: STATUS.UNSUPPORTED,
        reason: UNSUPPORTED_MESSAGES[event.reason] ? event.reason : UNSUPPORTED_REASON.BUILD,
        version: null,
        error: null,
      };

    case 'checking':
      if (state.status === STATUS.UNSUPPORTED) return state;
      // electron-updater emits checking-for-update after we already moved to
      // checking ourselves; and a download that is already running keeps
      // showing its progress rather than flicking back to "Checking…".
      if (state.status === STATUS.CHECKING || state.status === STATUS.DOWNLOADING) return state;
      return { ...state, ...DOWNLOAD_FIELDS, status: STATUS.CHECKING, error: null };

    case 'available': {
      if (state.status === STATUS.UNSUPPORTED) return state;
      const version = cleanVersion(event.version);
      if (state.status === STATUS.DOWNLOADING && version === state.version) {
        return { ...state, lastChecked: now() };
      }
      return {
        ...state,
        ...DOWNLOAD_FIELDS,
        status: STATUS.DOWNLOADING,
        version,
        percent: 0,
        lastChecked: now(),
        error: null,
      };
    }

    case 'progress':
      if (state.status === STATUS.UNSUPPORTED) return state;
      return {
        ...state,
        status: STATUS.DOWNLOADING,
        percent: clampPercent(event.percent),
        bytesPerSecond: finiteOrNull(event.bytesPerSecond),
        transferred: finiteOrNull(event.transferred),
        total: finiteOrNull(event.total),
        error: null,
      };

    case 'downloaded':
      return {
        ...state,
        ...DOWNLOAD_FIELDS,
        status: STATUS.READY,
        reason: null,
        version: cleanVersion(event.version) || state.version,
        percent: 100,
        error: null,
      };

    case 'not-available':
      if (state.status === STATUS.UNSUPPORTED) return state;
      return {
        ...state,
        ...DOWNLOAD_FIELDS,
        status: STATUS.UP_TO_DATE,
        version: null,
        lastChecked: now(),
        error: null,
      };

    case 'error': {
      if (state.status === STATUS.UNSUPPORTED) return state;
      let kind = event.kind === 'network' ? 'network' : 'check';
      if (kind !== 'network' && state.status === STATUS.DOWNLOADING) kind = 'download';
      return {
        ...state,
        ...DOWNLOAD_FIELDS,
        status: STATUS.ERROR,
        error: kind,
      };
    }

    default:
      return state;
  }
}

/**
 * Human status line for a state — the one copy both renderers show.
 * `autoCheck` is the "Automatically check for updates" setting; the idle and
 * error lines only promise background checks when it is on.
 */
function describeUpdateState(state, { autoCheck = true } = {}) {
  const mode = autoCheck ? 'auto' : 'manual';
  switch (state.status) {
    case STATUS.CHECKING:
      return 'Checking for updates…';
    case STATUS.DOWNLOADING: {
      const pct = Math.floor(state.percent || 0);
      const what = state.version ? `Freedom ${state.version}` : 'update';
      return `Downloading ${what}… ${pct}%`;
    }
    case STATUS.READY:
      return state.version
        ? `Freedom ${state.version} is ready to install.`
        : 'An update is ready to install.';
    case STATUS.UP_TO_DATE:
      return 'Freedom is up to date.';
    case STATUS.ERROR:
      return `${ERROR_MESSAGES[state.error] || ERROR_MESSAGES.check} ${RETRY_NOTE[mode]}`;
    case STATUS.UNSUPPORTED:
      return UNSUPPORTED_MESSAGES[state.reason] || UNSUPPORTED_MESSAGES[UNSUPPORTED_REASON.BUILD];
    case STATUS.IDLE:
    default:
      return IDLE_MESSAGES[mode];
  }
}

/** Whether a manual check makes sense right now (drives the buttons). */
function canCheckForUpdates(state) {
  return (
    state.status === STATUS.IDLE ||
    state.status === STATUS.UP_TO_DATE ||
    state.status === STATUS.ERROR
  );
}

/**
 * Classify an electron-updater error into a transition, or `unsupported`
 * when it means this build can't update at all.
 */
function classifyUpdaterError(error) {
  const message = String(error?.message || error || '');
  if (message.includes('ENOENT') && message.includes('app-update.yml')) {
    return { type: 'unsupported', reason: UNSUPPORTED_REASON.BUILD };
  }
  if (
    message.includes('net::') ||
    /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/.test(message)
  ) {
    return { type: 'error', kind: 'network' };
  }
  return { type: 'error', kind: 'other' };
}

module.exports = {
  STATUS,
  UNSUPPORTED_REASON,
  initialState,
  reduceUpdateState,
  describeUpdateState,
  canCheckForUpdates,
  classifyUpdaterError,
};
