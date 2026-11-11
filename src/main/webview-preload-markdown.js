/**
 * Markdown document view (#1035).
 *
 * IMPORTANT: this file is source-as-data, like webview-preload-ethereum-inject.js.
 * The app never requires it: main reads it as text (markdown-view.js) and
 * hands it to the tab preload together with the vendored marked and
 * DOMPurify, and the preload evaluates all three in its own isolated world —
 * never the page's main world — as CommonJS modules. So it may not `require`
 * anything, reach Electron or Node, or use a global the page could have
 * replaced: everything it touches comes in through `createMarkdownView` and
 * `mount`. Tests require it like any module.
 *
 * What it renders follows Dave Winer's Web of Markdown, the idea behind his
 * BonBon browser (https://github.com/scripting/markdownWeb): the writer owns
 * the words, the reader's browser owns how they look. So the page gets
 * Freedom's reading style and no CSS or JavaScript of its own; raw HTML in
 * the file is dropped; and of the front matter, the keys below are read and
 * the rest is ignored — `title` names the tab and heads the page (a link to
 * `link`, for a link post), `author` and `pubDate` make the byline,
 * `description` the line under it, and `urlPrev` / `urlNext` / `urlParent`
 * become the links above and below the text. A post with no title is headed
 * by its date. `date` is the byline's fallback for the static-site
 * generators (Jekyll, Hugo) that markdownWeb aims to interoperate with.
 *
 * BonBon's conventions for the text itself are followed too: an image that
 * opens a paragraph sits in the right margin (as does the front matter's
 * `rightMarginImage`), an image alone in its paragraph is a picture captioned
 * with its alt text, every heading of the text offers a link to itself, and
 * `?format=markdown` on an address opens the page on its source.
 */

// Front-matter keys this view reads, nothing else.
const META_KEYS = new Set([
  'title',
  'link',
  'author',
  'pubDate',
  'date',
  'description',
  'rightMarginImage',
  'urlPrev',
  'urlNext',
  'urlParent',
]);

// A link keeps its href only for these schemes (or no scheme: a relative
// link or a fragment). Anything else, javascript: above all, keeps its text
// and loses the link.
const LINK_SCHEMES = new Set([
  'http',
  'https',
  'ipfs',
  'ipns',
  'bzz',
  'rad',
  'web3',
  'ethereum',
  'mailto',
  'tel',
  'xmpp',
  'matrix',
]);

// An image loads from these, a relative path, or a `data:image/` URL;
// anything else shows its alt text.
const IMAGE_SCHEMES = new Set(['http', 'https', 'ipfs', 'ipns', 'bzz', 'web3']);

// DOMPurify's second check on every URL attribute, the same schemes as
// above. The two trailing alternatives are DOMPurify's own: a value with no
// scheme in front (a relative URL, or a plain attribute value such as
// `align="center"`) passes. It lets `data:` through on <img> by itself.
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|ipfs|ipns|bzz|rad|web3|ethereum|mailto|tel|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const PURIFY_CONFIG = {
  ALLOWED_URI_REGEXP,
  FORBID_TAGS: ['style'],
  FORBID_ATTR: ['style'],
  RETURN_DOM_FRAGMENT: true,
};

// Defence in depth for the rendered page: nothing in it may run. Pages a
// server already locks down keep their own, stricter policy too.
const CONTENT_SECURITY_POLICY = "script-src 'none'; object-src 'none'; base-uri 'none'";

const TITLE_MAX = 300;
const BYLINE_PART_MAX = 200;
const DESCRIPTION_MAX = 1000;
const CAPTION_MAX = 1000;

// The reading style. Two palettes keyed on the `data-theme` the preload
// stamps from Settings > Appearance; the toggle in the address bar flips
// `data-freedom-markdown` between the formatted page and Chromium's own
// <pre> with the file's text. Scoped to the attribute so it can only ever
// apply to a page this view rendered.
const VIEW_CSS = `
html[data-freedom-markdown] {
  --md-page: #ffffff;
  --md-ink: #1f2328;
  --md-ink-soft: #555b63;
  --md-rule: #e4e6ea;
  --md-code-bg: #f4f5f7;
  --md-link: #1a5fc8;
  --md-quote: #c9ced6;
  --md-font-read: Charter, 'Bitstream Charter', 'Sitka Text', Cambria, ui-serif, Georgia, serif;
  --md-font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --md-font-mono: ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  color-scheme: light;
  background: var(--md-page);
  color: var(--md-ink);
}
html[data-freedom-markdown][data-theme='dark'] {
  --md-page: #202122;
  --md-ink: #d9dadc;
  --md-ink-soft: #a3a7ad;
  --md-rule: #3a3c3f;
  --md-code-bg: #2b2d30;
  --md-link: #8ab4f8;
  --md-quote: #4a4d52;
  color-scheme: dark;
}
html[data-freedom-markdown] body { margin: 0; }
html[data-freedom-markdown='formatted'] body > pre { display: none; }
html[data-freedom-markdown='source'] body > .md-page { display: none; }

html[data-freedom-markdown] body > pre {
  margin: 0;
  padding: 24px 28px 60px;
  font-family: var(--md-font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--md-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
html[data-freedom-markdown] body > pre .md-front-matter { color: var(--md-ink-soft); }

.md-page {
  display: flow-root;
  box-sizing: border-box;
  max-width: 44rem;
  margin: 0 auto;
  padding: 40px 28px 72px;
  color: var(--md-ink);
  font-family: var(--md-font-read);
  font-size: 19px;
  line-height: 1.62;
  overflow-wrap: break-word;
}
.md-page .md-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  align-items: center;
  justify-content: space-between;
  font-family: var(--md-font-ui);
  font-size: 13px;
  color: var(--md-ink-soft);
  padding-bottom: 14px;
  margin-bottom: 30px;
  border-bottom: 1px solid var(--md-rule);
}
.md-page .md-nav.md-nav-bottom {
  margin: 44px 0 0;
  padding: 14px 0 0;
  border-bottom: 0;
  border-top: 1px solid var(--md-rule);
}
.md-page .md-nav span { display: inline-flex; gap: 18px; }
.md-page .md-nav a { color: var(--md-ink-soft); text-decoration: none; }
.md-page .md-nav a:hover { color: var(--md-link); text-decoration: underline; }
.md-page .md-byline {
  font-family: var(--md-font-ui);
  font-size: 13.5px;
  color: var(--md-ink-soft);
  margin: 0 0 28px;
}
.md-page h1 + .md-byline { margin-top: -14px; }
.md-page .md-description {
  margin: 0 0 28px;
  font-style: italic;
  color: var(--md-ink-soft);
}
.md-page .md-byline + .md-description { margin-top: -14px; }
.md-page a.md-title-link { text-decoration: none; }
.md-page a.md-title-link:hover { text-decoration: underline; }
.md-page h1, .md-page h2, .md-page h3, .md-page h4, .md-page h5, .md-page h6 {
  font-family: var(--md-font-ui);
  color: var(--md-ink);
  line-height: 1.22;
  letter-spacing: -0.012em;
  text-wrap: balance;
}
.md-page h1 { font-size: 2.05rem; font-weight: 700; margin: 44px 0 22px; }
.md-page h2 { font-size: 1.35rem; font-weight: 650; margin: 38px 0 10px; }
.md-page h3 { font-size: 1.08rem; font-weight: 650; margin: 28px 0 8px; }
.md-page h4, .md-page h5, .md-page h6 { font-size: 1rem; font-weight: 650; margin: 24px 0 8px; }
.md-page > :is(h1, h2, h3, h4, h5, h6):first-child,
.md-page > .md-nav + :is(h1, h2, h3, h4, h5, h6) { margin-top: 0; }
.md-page a.md-anchor {
  display: inline-flex;
  margin-left: 0.3em;
  vertical-align: middle;
  color: var(--md-ink-soft);
  opacity: 0;
}
.md-page a.md-anchor svg { width: 16px; height: 16px; }
.md-page :is(h1, h2, h3, h4, h5, h6):hover > a.md-anchor,
.md-page a.md-anchor:focus-visible { opacity: 1; }
.md-page a.md-anchor:hover { color: var(--md-link); }
.md-page p { margin: 0 0 18px; }
.md-page a { color: var(--md-link); text-decoration-thickness: 1px; text-underline-offset: 2px; }
.md-page ul, .md-page ol { margin: 0 0 18px; padding-left: 1.4em; }
.md-page li { margin: 4px 0; }
.md-page li > p { margin: 0 0 8px; }
.md-page li > ul, .md-page li > ol { margin: 4px 0 0; }
.md-page li:has(> input[type='checkbox']) { list-style: none; }
.md-page li > input[type='checkbox'] { margin: 0 0.45em 0 -1.3em; }
.md-page blockquote {
  margin: 22px 0;
  padding: 2px 0 2px 18px;
  border-left: 3px solid var(--md-quote);
  color: var(--md-ink-soft);
  font-style: italic;
}
.md-page blockquote > :last-child { margin-bottom: 0; }
.md-page code {
  font-family: var(--md-font-mono);
  font-size: 0.82em;
  background: var(--md-code-bg);
  padding: 2px 5px;
  border-radius: 4px;
}
.md-page pre {
  background: var(--md-code-bg);
  padding: 14px 16px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 0 0 20px;
  line-height: 1.5;
}
.md-page pre code { background: none; padding: 0; font-size: 0.78em; }
.md-page hr { border: 0; border-top: 1px solid var(--md-rule); margin: 32px 0; }
.md-page img { max-width: 100%; height: auto; }
.md-page .md-margin-image {
  float: right;
  max-width: 38%;
  margin: 0.3em 0 0.75em 1.4em;
}
.md-page .md-picture { margin: 30px 0; }
.md-page .md-picture img { display: block; margin: 0 auto; }
.md-page .md-picture figcaption {
  margin-top: 10px;
  text-align: center;
  font-family: var(--md-font-ui);
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--md-ink-soft);
}
.md-page hr, .md-page .md-picture, .md-page .md-nav-bottom { clear: both; }
.md-page table {
  border-collapse: collapse;
  margin: 0 0 20px;
  font-size: 0.86em;
  display: block;
  max-width: 100%;
  overflow-x: auto;
}
.md-page th, .md-page td { border: 1px solid var(--md-rule); padding: 6px 10px; text-align: left; }
.md-page th { font-family: var(--md-font-ui); font-size: 0.92em; }
.md-page th[align='center'], .md-page td[align='center'] { text-align: center; }
.md-page th[align='right'], .md-page td[align='right'] { text-align: right; }

@media (max-width: 640px) {
  .md-page { padding: 26px 18px 56px; font-size: 17.5px; }
  .md-page h1 { font-size: 1.65rem; }
  .md-page .md-margin-image { max-width: 42%; margin-left: 1em; }
  html[data-freedom-markdown] body > pre { padding: 18px 16px 48px; }
}
@media print {
  .md-page .md-nav, .md-page .md-anchor { display: none; }
}
`;

const NAV_LINKS = [
  { key: 'urlPrev', rel: 'prev', text: '← Previous', group: 'start' },
  { key: 'urlParent', rel: 'up', text: '↑ Up', group: 'start' },
  { key: 'urlNext', rel: 'next', text: 'Next →', group: 'end' },
];

const clip = (value, max) => {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// The scheme the browser would read, or '' for a URL without one. The URL
// Standard drops tabs and newlines anywhere and controls and spaces at the
// start, so `java\tscript:` is still javascript: and has to be seen as such.
function urlScheme(url) {
  const raw = String(url || '').replace(/[\t\n\r]/g, '');
  let start = 0;
  while (start < raw.length && raw.charCodeAt(start) <= 0x20) start += 1;
  const cleaned = raw.slice(start);
  const match = /^([a-z][a-z0-9+.\-]*):/i.exec(cleaned);
  return { scheme: match ? match[1].toLowerCase() : '', cleaned };
}

function isSafeLinkUrl(url) {
  const { scheme } = urlScheme(url);
  return scheme === '' || LINK_SCHEMES.has(scheme);
}

function isSafeImageUrl(url) {
  const { scheme, cleaned } = urlScheme(url);
  if (scheme === '') return true;
  if (scheme === 'data') return /^data:image\//i.test(cleaned);
  return IMAGE_SCHEMES.has(scheme);
}

// One YAML scalar: double-quoted (with escapes), single-quoted, or plain (a
// trailing ` # comment` dropped). Anything else — a block scalar, a flow
// collection, an anchor or a tag — is not a string this view uses.
function parseScalar(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value[0] === '"') {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (!match) return '';
    return match[1].replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc) => {
      if (esc[0] === 'u' || esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
      return { n: '\n', t: '\t', r: '\r', 0: '', b: '' }[esc] ?? esc;
    });
  }
  if (value[0] === "'") {
    const match = /^'((?:[^']|'')*)'/.exec(value);
    return match ? match[1].replace(/''/g, "'") : '';
  }
  if (/^[[{|>&*!%@`]/.test(value)) return '';
  return value.replace(/\s+#.*$/, '').trim();
}

// Top-level `key: value` lines only. An indented line belongs to a nested
// map (markdownWeb's `source:` carries its own `title:`), so it is skipped.
function parseMeta(block) {
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w.\-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    if (!match || !META_KEYS.has(match[1]) || Object.hasOwn(meta, match[1])) continue;
    const value = parseScalar(match[2]);
    if (value) meta[match[1]] = value;
  }
  return meta;
}

/**
 * Split YAML front matter off the top of a Markdown file: a first line of
 * `---`, then `key: value` lines, closed by `---` or `...`. A block with no
 * `key:` line at all is a horizontal rule followed by text, not front
 * matter, and stays in the body.
 * @returns {{ meta: object, frontMatter: string, body: string }}
 */
function splitFrontMatter(text) {
  const source = String(text || '');
  const none = { meta: {}, frontMatter: '', body: source };
  // A byte-order mark may sit in front of the opening line.
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open = /^---[ \t]*\r?\n/.exec(source.slice(start));
  if (!open) return none;
  const blockStart = start + open[0].length;
  const rest = source.slice(blockStart);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return none;
  const block = rest.slice(0, close.index);
  if (block.trim() && !/^[A-Za-z_][\w.\-]*[ \t]*:/m.test(block)) return none;
  const end = blockStart + close.index + close[0].length;
  return { meta: parseMeta(block), frontMatter: source.slice(0, end), body: source.slice(end) };
}

// GitHub-style heading anchors, so a README's table of contents
// (`[Install](#install)`) lands on its heading.
function slugify(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

// One page's anchors, numbered the way GitHub numbers repeats (its
// github-slugger): Foo, Foo, Foo-1 become foo, foo-1, foo-1-1, so every id
// is unique and a link copied from GitHub finds the same heading.
function createSlugger() {
  const occurrences = new Map();
  return (text) => {
    const base = slugify(text);
    let slug = base;
    while (occurrences.has(slug)) {
      const count = occurrences.get(base) + 1;
      occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A post's date, for the byline (`Nov 8, 2026`) or, `long`, for the heading
 * of a post with no title (`Sunday, November 8, 2026`), plus its time of day
 * for the byline under such a heading. A timestamp is shown in the reader's
 * time zone, a bare calendar date (`date: 2026-11-08`, as Jekyll and Hugo
 * write it) as that day wherever the reader is, and has no time. Anything
 * unparseable is shown as written, with no `iso`.
 * @param {string} value
 * @param {{ locale?: string, timeZone?: string, long?: boolean }} [options]
 *   the reader's locale and zone, by default
 * @returns {{ text: string, iso: string, time: string }}
 */
function formatDate(value, { locale, timeZone, long = false } = {}) {
  const raw = String(value || '').trim();
  const dateOnly = DATE_ONLY.test(raw);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { text: clip(raw, BYLINE_PART_MAX), iso: '', time: '' };
  }
  const day = long
    ? { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return {
    text: date.toLocaleDateString(locale, { ...day, timeZone: dateOnly ? 'UTC' : timeZone }),
    iso: dateOnly ? raw : date.toISOString(),
    time: dateOnly
      ? ''
      : date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone }),
  };
}

// `?format=markdown` on an address: the writer means the reader to see the
// file's Markdown, so the page opens on its source (BonBon's convention). The
// address bar's button still switches to the page.
const asksForSource = (search) =>
  new URLSearchParams(String(search || '')).get('format')?.toLowerCase() === 'markdown';

const SVG_NS = 'http://www.w3.org/2000/svg';
// The app's own link icon (the Agent panel's "Connected services").
const LINK_ICON_PATHS = [
  'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
  'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
];
const LINK_ICON_ATTRIBUTES = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
};

/**
 * @param {{ marked: object, DOMPurify: object }} deps
 *   `marked` is the vendored module's exports (`{ Marked, ... }`), DOMPurify
 *   an instance bound to the window this runs in.
 */
function createMarkdownView({ marked, DOMPurify }) {
  const parser = new marked.Marked({ gfm: true, breaks: false, async: false });
  parser.use({
    renderer: {
      // Raw HTML in the file is dropped, block and inline alike.
      html() {
        return '';
      },
      // `false` hands a safe link or image to marked's own renderer.
      link({ href, tokens }) {
        return isSafeLinkUrl(href) ? false : this.parser.parseInline(tokens);
      },
      image({ href, text }) {
        return isSafeImageUrl(href) ? false : escapeHtml(text || '');
      },
    },
  });

  // The body as HTML: marked with raw HTML dropped and unsafe URLs unlinked.
  const renderBody = (body) => parser.parse(String(body || ''));

  const buildNav = (doc, meta, bottom) => {
    const links = NAV_LINKS.filter(({ key }) => meta[key] && isSafeLinkUrl(meta[key]));
    if (!links.length) return null;
    const nav = doc.createElement('nav');
    nav.className = bottom ? 'md-nav md-nav-bottom' : 'md-nav';
    nav.setAttribute('aria-label', 'Previous and next pages');
    for (const group of ['start', 'end']) {
      const span = doc.createElement('span');
      for (const { key, rel, text } of links.filter((link) => link.group === group)) {
        const a = doc.createElement('a');
        a.setAttribute('href', meta[key]);
        a.setAttribute('rel', rel);
        a.textContent = text;
        span.appendChild(a);
      }
      nav.appendChild(span);
    }
    return nav;
  };

  // The page's own heading, from the front matter: its title, linked to
  // `link` for a link post, or for a post with no title its date.
  const buildTitle = (doc, title) => {
    const heading = doc.createElement('h1');
    heading.className = 'md-title';
    heading.textContent = title;
    return heading;
  };

  // A link post's heading goes where the post points: its words become a
  // link to `link`, whether the heading came from the front matter or the
  // text's own `# Title`. A heading with a link of its own keeps that one.
  const linkHeading = (doc, heading, link) => {
    if (!heading || !link || !isSafeLinkUrl(link) || heading.querySelector('a')) return;
    const a = doc.createElement('a');
    a.className = 'md-title-link';
    a.setAttribute('href', link);
    a.append(...heading.childNodes);
    heading.appendChild(a);
  };

  const buildDateHeading = (doc, date) => {
    const heading = doc.createElement('h1');
    heading.className = 'md-title md-date-heading';
    const time = doc.createElement('time');
    time.setAttribute('datetime', date.iso);
    time.textContent = date.text;
    heading.appendChild(time);
    return heading;
  };

  // Author and date; under a date heading, author and time of day.
  const buildByline = (doc, author, date, timeOnly) => {
    const name = clip(author, BYLINE_PART_MAX);
    const when = date ? (timeOnly ? date.time : date.text) : '';
    if (!name && !when) return null;
    const byline = doc.createElement('p');
    byline.className = 'md-byline';
    if (name) byline.appendChild(doc.createTextNode(name));
    if (when) {
      if (name) byline.appendChild(doc.createTextNode(' · '));
      const time = doc.createElement('time');
      if (date.iso) time.setAttribute('datetime', date.iso);
      time.textContent = when;
      byline.appendChild(time);
    }
    return byline;
  };

  const isBlank = (node) => node.nodeType === 3 && !node.textContent.trim();
  // The `[#](…)` that ends each item on Winer's day pages, its permalink.
  const isPermalink = (node) => node.nodeName === 'A' && node.textContent.trim() === '#';

  // Winer's two image conventions, as BonBon draws them. A paragraph that is
  // nothing but an image (and perhaps its `#` permalink) is a picture,
  // centred, captioned with its alt text, the permalink after the caption. A
  // paragraph that opens with an image and goes on with text has the image in
  // its right margin, the text wrapping round it, the way scripting.com
  // places one. Any other image stays in its line. Whitespace between the
  // parts doesn't count.
  const layoutImages = (doc, root) => {
    for (const paragraph of root.querySelectorAll('p')) {
      const [image, ...rest] = [...paragraph.childNodes].filter((node) => !isBlank(node));
      if (image?.nodeName !== 'IMG') continue;
      const permalink = rest.length === 1 && isPermalink(rest[0]) ? rest[0] : null;
      if (rest.length && !permalink) {
        if (paragraph.textContent.trim()) image.classList.add('md-margin-image');
        continue;
      }
      const figure = doc.createElement('figure');
      figure.className = 'md-picture';
      figure.appendChild(image);
      const caption = clip(image.getAttribute('alt'), CAPTION_MAX);
      if (caption || permalink) {
        const figcaption = doc.createElement('figcaption');
        if (caption) figcaption.appendChild(doc.createTextNode(caption));
        if (caption && permalink) figcaption.appendChild(doc.createTextNode(' '));
        if (permalink) figcaption.appendChild(permalink);
        figure.appendChild(figcaption);
      }
      paragraph.replaceWith(figure);
    }
  };

  // Ids for the text's headings, so a link to one lands on it. The page's
  // own heading, made from the front matter, takes none: the text's
  // headings keep the ids GitHub gives them.
  const addHeadingIds = (root, own) => {
    const slugFor = createSlugger();
    for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (heading === own || !slugify(heading.textContent)) continue;
      heading.id = slugFor(heading.textContent);
    }
  };

  const buildLinkIcon = (doc) => {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [name, value] of Object.entries(LINK_ICON_ATTRIBUTES)) {
      svg.setAttribute(name, value);
    }
    for (const d of LINK_ICON_PATHS) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  };

  // A link icon after each heading that has an id, shown on hover or focus:
  // the heading's address, to copy or share (GitHub's and BonBon's way).
  const addHeadingAnchors = (doc, root) => {
    for (const heading of root.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')) {
      const anchor = doc.createElement('a');
      anchor.className = 'md-anchor';
      anchor.setAttribute('href', `#${heading.id}`);
      anchor.setAttribute('title', 'Link to this heading');
      anchor.setAttribute('aria-label', `Link to “${clip(heading.textContent, TITLE_MAX)}”`);
      anchor.appendChild(buildLinkIcon(doc));
      heading.appendChild(anchor);
    }
  };

  /**
   * Render the Markdown page in place of Chromium's plain-text one.
   * @param {object} opts
   * @param {Document} opts.document the page's document
   * @param {Location} opts.location its location (for the URL fragment)
   * @param {HTMLPreElement} opts.pre Chromium's <pre> holding the file's text
   * @param {(css: string) => void} opts.insertCSS adds the reading style
   *   (outside the page's own CSP)
   * @returns {{ view: string, title: string, setView(view: string): void,
   *   setTheme(theme: string): void }}
   */
  function mount({ document: doc, location: loc, pre, insertCSS }) {
    const root = doc.documentElement;
    const text = pre.textContent;
    const { meta, frontMatter, body } = splitFrontMatter(text);

    const content = DOMPurify.sanitize(renderBody(body), PURIFY_CONFIG);
    layoutImages(doc, content);

    // The page's header, in BonBon's order: the heading (the text's own
    // leading h1, else one from the front matter), the byline, the
    // description, then the front matter's margin image.
    const lead = content.firstElementChild;
    let heading = lead && lead.tagName === 'H1' ? lead : null;
    let own = null;
    const metaTitle = clip(meta.title, TITLE_MAX);
    const when = meta.pubDate || meta.date;
    const date = when ? formatDate(when) : null;
    if (!heading) {
      if (metaTitle) {
        own = buildTitle(doc, metaTitle);
      } else if (date?.iso) {
        own = buildDateHeading(doc, formatDate(when, { long: true }));
      }
      if (own) {
        heading = own;
        content.insertBefore(own, content.firstChild);
      }
    }
    if (!own?.classList.contains('md-date-heading')) linkHeading(doc, heading, meta.link);
    let last = heading;
    const place = (node) => {
      if (!node) return;
      if (last) last.after(node);
      else content.insertBefore(node, content.firstChild);
      last = node;
    };
    place(buildByline(doc, meta.author, date, own?.classList.contains('md-date-heading')));
    const description = clip(meta.description, DESCRIPTION_MAX);
    if (description) {
      const p = doc.createElement('p');
      p.className = 'md-description';
      p.textContent = description;
      place(p);
    }
    if (meta.rightMarginImage && isSafeImageUrl(meta.rightMarginImage)) {
      const img = doc.createElement('img');
      img.className = 'md-margin-image';
      img.setAttribute('src', meta.rightMarginImage);
      img.setAttribute('alt', '');
      place(img);
    }

    addHeadingIds(content, own);
    addHeadingAnchors(doc, content);
    // Images send no referrer off the page's own site. The page is Freedom's
    // rendering, not the server's: its images may be ones the server's own
    // policy would have blocked (markdown-view.js), and a lax server referrer
    // policy must not hand them the page's full URL. Set before the article
    // joins this document, which is when the images start loading.
    for (const img of content.querySelectorAll('img')) {
      img.setAttribute('referrerpolicy', 'same-origin');
    }

    const page = doc.createElement('article');
    page.className = 'md-page';
    const navTop = buildNav(doc, meta, false);
    if (navTop) page.appendChild(navTop);
    page.appendChild(content);
    const navBottom = buildNav(doc, meta, true);
    if (navBottom) page.appendChild(navBottom);

    // The source view is Chromium's own <pre>, the front matter dimmed.
    if (frontMatter) {
      const dimmed = doc.createElement('span');
      dimmed.className = 'md-front-matter';
      dimmed.textContent = frontMatter;
      pre.replaceChildren(dimmed, doc.createTextNode(body));
    }

    insertCSS(VIEW_CSS);
    const csp = doc.createElement('meta');
    csp.setAttribute('http-equiv', 'Content-Security-Policy');
    csp.setAttribute('content', CONTENT_SECURITY_POLICY);
    (doc.head || root).appendChild(csp);

    let view = asksForSource(loc.search) ? 'source' : 'formatted';
    root.setAttribute('data-freedom-markdown', view);
    pre.before(page);

    const title = metaTitle || clip(heading?.textContent, TITLE_MAX);
    if (title) doc.title = title;

    // A link to a heading (`page.md#install`) could not find it while the
    // page was still plain text.
    if (view === 'formatted' && loc.hash.length > 1) {
      try {
        doc.getElementById(decodeURIComponent(loc.hash.slice(1)))?.scrollIntoView();
      } catch {
        // A malformed fragment just stays at the top.
      }
    }

    // Each view keeps its own scroll position across the toggle.
    const scrollTops = { formatted: 0, source: 0 };
    return {
      get view() {
        return view;
      },
      title,
      setView(next) {
        if ((next !== 'formatted' && next !== 'source') || next === view) return;
        const scroller = doc.scrollingElement || root;
        scrollTops[view] = scroller.scrollTop;
        view = next;
        root.setAttribute('data-freedom-markdown', view);
        scroller.scrollTop = scrollTops[view];
      },
      setTheme(theme) {
        root.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
      },
    };
  }

  return { renderBody, mount };
}

module.exports = {
  createMarkdownView,
  splitFrontMatter,
  slugify,
  createSlugger,
  formatDate,
  asksForSource,
  isSafeLinkUrl,
  isSafeImageUrl,
  VIEW_CSS,
  CONTENT_SECURITY_POLICY,
};
