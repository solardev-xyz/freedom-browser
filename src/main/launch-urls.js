// URLs handed to Freedom from outside the app: command-line arguments (an OS
// link handler or `freedom <url>`), a second launch forwarding its arguments to
// the running profile process (profile-focus-handoff.js), and macOS `open-url`.
//
// These strings come from whatever program launched us, so only the schemes
// Freedom itself routes as top-level navigations are accepted (the same set
// webcontents-setup.js's will-navigate hook hands to the renderer, minus
// `ethereum:` payment requests, which an outside app has no business starting).
// `file:`, `javascript:`, `data:` and anything else are dropped. The renderer
// still routes each URL through its own navigation checks.

const LAUNCH_URL_PROTOCOLS = new Set([
  'http:',
  'https:',
  'freedom:',
  'bzz:',
  'ipfs:',
  'ipns:',
  'web3:',
  'ens:',
  'rad:',
]);

// Generous for real links, small enough that a hostile launch can't flood the
// window with tabs or the handoff file with data.
const MAX_LAUNCH_URLS = 16;
const MAX_LAUNCH_URL_LENGTH = 8192;

// Switches whose value is the next argument (profile-resolver.js#getArgValue);
// that value is never a URL to open.
const SWITCHES_WITH_VALUE = new Set(['--profile', '--profile-dir']);

function isAcceptedLaunchUrl(value) {
  if (typeof value !== 'string') return false;
  if (!value || value.length > MAX_LAUNCH_URL_LENGTH) return false;
  // Whitespace or control characters never belong in a link an OS hands over.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return LAUNCH_URL_PROTOCOLS.has(parsed.protocol);
}

// Keep the accepted entries of an untrusted list, in order, deduplicated and
// capped. The raw string is kept rather than `new URL()`'s normalisation, so a
// case-sensitive CID or ENS name reaches the renderer exactly as given.
function sanitizeLaunchUrls(values) {
  if (!Array.isArray(values)) return [];
  const urls = [];
  for (const value of values) {
    if (urls.length >= MAX_LAUNCH_URLS) break;
    if (isAcceptedLaunchUrl(value) && !urls.includes(value)) {
      urls.push(value);
    }
  }
  return urls;
}

// The URLs among a process's argv. argv[0] is the executable; in development
// argv[1] is the app path ('.'), which is not a URL and so drops out anyway.
// Switches (and the value of a switch that takes one) are skipped.
function extractLaunchUrls(argv) {
  if (!Array.isArray(argv)) return [];
  const candidates = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('-')) {
      if (SWITCHES_WITH_VALUE.has(arg)) index += 1;
      continue;
    }
    candidates.push(arg);
  }
  return sanitizeLaunchUrls(candidates);
}

module.exports = {
  LAUNCH_URL_PROTOCOLS,
  MAX_LAUNCH_URLS,
  MAX_LAUNCH_URL_LENGTH,
  extractLaunchUrls,
  isAcceptedLaunchUrl,
  sanitizeLaunchUrls,
};
