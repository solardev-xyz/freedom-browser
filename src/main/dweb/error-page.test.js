/**
 * The error page a navigation gets (freedom-core design 0009, "The error
 * page"): fixed plain words per cause, nothing unescaped, no script.
 */
const { errorPage, textsFor, MAX_SHOWN_URL } = require('./error-page');

const MESSAGES = [
  'Swarm content verification failed',
  'IPFS content verification failed',
  "This content can't be verified with the external Swarm node",
  "This content can't be verified with the external IPFS gateway",
  'This content needs more memory to verify than one request may use',
  'This IPFS content is malformed',
  'Not found on the external Swarm node',
  'Not found on the external IPFS gateway',
  'Too many requests',
  'Deadline passed',
  'The core is unavailable',
];

test("every cause of 0009's Failures table has its own plain words", () => {
  const generic = textsFor('something main never writes');
  const texts = MESSAGES.map((message) => textsFor(message).text);
  expect(new Set(texts).size).toBe(MESSAGES.length);
  expect(texts).not.toContain(generic.text);
  // MEMORY tells the core's limit apart from the node's or the content's.
  expect(textsFor(MESSAGES[4]).text).toBe(
    'Checking this content needs more memory than Freedom lets one request use, so ' +
      "Freedom didn't show it. This is Freedom's limit, not a fault of your node or the content."
  );
  expect(textsFor('The external IPFS gateway answered 429').text).toBe(
    'Your external IPFS gateway answered with an error (429).'
  );
});

test('the page: the status, no script, no store, and everything escaped', async () => {
  const url = 'bzz://site.eth/<img src=x onerror=alert(1)>?"q"';
  const res = errorPage(404, '<b>name</b> has no contenthash', url);
  expect(res.status).toBe(404);
  expect(res.headers.get('content-security-policy')).toBe(
    "default-src 'none'; style-src 'unsafe-inline'"
  );
  expect(res.headers.get('cache-control')).toBe('no-store');
  const html = await res.text();
  expect(html).not.toMatch(/<script|<img|<b>/);
  expect(html).toContain('404: &lt;b&gt;name&lt;/b&gt; has no contenthash');
  expect(html).toContain('href="bzz://site.eth/&lt;img src=x onerror=alert(1)&gt;?&quot;q&quot;"');
  expect(html).toContain('<title>Content unavailable</title>');
});

test('a URL past what the page shows is left out, with its Try again link', async () => {
  const html = await errorPage(
    414,
    'request URL too long',
    `bzz://a/${'x'.repeat(MAX_SHOWN_URL)}`
  ).text();
  expect(html).not.toContain('xxxx');
  expect(html).not.toContain('Try again');
  expect(html).toContain('414: request URL too long');
});
