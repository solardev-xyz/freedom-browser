/**
 * The error page a navigation gets in place of a `{ code, message }` body
 * (freedom-core design 0009, "The error page"; decision 4).
 *
 * - **Which answers:** every `{ code, message }` body main writes for a
 *   `bzz:`, `ipfs:` or `ipns:` request, from the core (an error plan, a
 *   `dweb.verify` failure before the head) or from main (its local
 *   failures), when the request is navigation-like: a GET whose first
 *   `Accept` token is exactly `text/html`, the rule `small_text` reads. A
 *   `protocol.handle` request carries no exact navigation signal, so a
 *   `fetch` that sends that `Accept` gets the page too; every other request
 *   keeps the JSON body. A node's own answer, and the bundled node's bodies
 *   the core reproduces, are content, and never replaced.
 * - **The page:** the same status, and a fixed template in plain words:
 *   what failed, whose node, what the user can do, the URL and a "Try
 *   again" link. No script, under `default-src 'none'; style-src
 *   'unsafe-inline'`, and `Cache-Control: no-store`. Nothing from the node:
 *   the message the page explains is the core's or main's own text, shown
 *   escaped as the details line.
 * - **Its texts** are plain-words versions of the messages, one per cause
 *   (0009's Failures table), the user's to change. A message the table
 *   doesn't know gets the generic text.
 *
 * The handler answers a request, not a tab, so the page can't be the
 * shell's own `pages/error.html`; it follows that page's look and words.
 */

/** The longest URL the page shows; a longer one (a 414's) is left out. */
const MAX_SHOWN_URL = 2048;

const SWARM = 'your external Swarm node';
const GATEWAY = 'your external IPFS gateway';

/** A cause's headline and plain words, by the exact message. */
const TEXTS = new Map([
  [
    'Swarm content verification failed',
    {
      title: "This content didn't pass verification",
      text: `The content ${SWARM} sent doesn't match its address, so Freedom didn't show it.`,
    },
  ],
  [
    'IPFS content verification failed',
    {
      title: "This content didn't pass verification",
      text: `The content ${GATEWAY} sent doesn't match its address, so Freedom didn't show it.`,
    },
  ],
  [
    "This content can't be verified with the external Swarm node",
    {
      title: "This content can't be verified",
      text: `Freedom can't check this content with ${SWARM}, so it didn't show it.`,
    },
  ],
  [
    "This content can't be verified with the external IPFS gateway",
    {
      title: "This content can't be verified",
      text: `Freedom can't check this content with ${GATEWAY}, so it didn't show it.`,
    },
  ],
  [
    'This content needs more memory to verify than one request may use',
    {
      title: 'This content is too large to verify',
      text:
        'Checking this content needs more memory than Freedom lets one request use, so ' +
        "Freedom didn't show it. This is Freedom's limit, not a fault of your node or the content.",
    },
  ],
  [
    'This IPFS content is malformed',
    {
      title: "This content can't be read",
      text: `The content ${GATEWAY} sent matches its address, but it is malformed, so Freedom didn't show it.`,
    },
  ],
  [
    'Not found on the external Swarm node',
    { title: 'Content not found', text: `${capitalized(SWARM)} couldn't find this content.` },
  ],
  [
    'Not found on the external IPFS gateway',
    { title: 'Content not found', text: `${capitalized(GATEWAY)} couldn't find this content.` },
  ],
  [
    'Too many requests',
    {
      title: 'Freedom is busy',
      text: 'Freedom is loading too much content at once. Try again in a moment.',
    },
  ],
  [
    'Deadline passed',
    { title: 'This took too long', text: 'Freedom gave up waiting for this content.' },
  ],
  [
    'The core is unavailable',
    {
      title: "Freedom couldn't load this",
      text: 'A part of Freedom that loads this content stopped. Try again in a moment.',
    },
  ],
]);

/** A node's final answer: "The external Swarm node answered 500". */
const ANSWERED = /^The external (Swarm node|IPFS gateway) answered (\d{3})$/;

const GENERIC = {
  title: 'Content unavailable',
  text:
    'This content could not be retrieved from the decentralized network. The address may be ' +
    'invalid, the content may no longer exist, or no peers are serving it.',
};

function capitalized(text) {
  return text[0].toUpperCase() + text.slice(1);
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/** The headline and plain words for a message. */
function textsFor(message) {
  const known = TEXTS.get(message);
  if (known) return known;
  const answered = ANSWERED.exec(message);
  if (answered) {
    const who = answered[1] === 'Swarm node' ? SWARM : GATEWAY;
    return {
      title: "Couldn't get this content",
      text: `${capitalized(who)} answered with an error (${answered[2]}).`,
    };
  }
  return GENERIC;
}

/**
 * The page for a `{ code, message }` answer.
 *
 * @param {number} status
 * @param {string} message - the core's or main's text
 * @param {string} url - the request's URL
 * @returns {Response}
 */
function errorPage(status, message, url) {
  const { title, text } = textsFor(message);
  const shown = typeof url === 'string' && url.length <= MAX_SHOWN_URL ? url : null;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #59636e;
  --surface: #f6f8fa; --border: #d1d9e0; --danger: #cf222e; --accent: #0969da; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --surface: #151b23;
    --border: #3d444d; --danger: #ff7b72; --accent: #4493f8; --on-accent: #0d1117; }
}
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.container { max-width: 640px; margin: 15vh auto 0; padding: 0 24px; }
h1 { font-size: 24px; font-weight: 600; margin: 0 0 12px; }
p { color: var(--muted); margin: 0 0 20px; }
.url { overflow-wrap: anywhere; color: var(--fg); }
.details { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px 16px; margin: 0 0 20px; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--danger); overflow-wrap: anywhere; white-space: pre-wrap; }
a.retry { display: inline-block; padding: 8px 16px; border-radius: 6px; background: var(--accent);
  color: var(--on-accent); text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<div class="container">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(text)}</p>
${shown ? `<p class="url">${escapeHtml(shown)}</p>\n` : ''}<div class="details">${escapeHtml(`${status}: ${message}`)}</div>
${shown ? `<a class="retry" href="${escapeHtml(shown)}">Try again</a>\n` : ''}</div>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Cache-Control': 'no-store',
    },
  });
}

module.exports = { errorPage, textsFor, MAX_SHOWN_URL };
