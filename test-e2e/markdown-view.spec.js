// Markdown documents (#1035), driven through the real app.
//
// webview-preload-markdown.test.js pins the front matter, the URL rules and
// the rendered body; markdown-view-ui.test.js the address bar's per-tab
// bookkeeping; gateway-response-headers.test.js the Swarm/IPFS relabel. This
// spec pins what only a real tab shows: a Markdown file becomes a page in
// place, titled and linked from its front matter, with nothing in it able to
// run; Dave Winer's conventions (a post with no title headed by its date, the
// description, margin images and captioned pictures, heading links,
// `?format=markdown`) as BonBon draws them; the address bar's Markdown button
// flips to the source and back; the button comes and goes with the page; and
// the page follows the app theme.
//
// Files are served by the harness' https stub with the type under test, so
// nothing here touches the network. That stub is a protocol.handle override,
// which webRequest never sees, so the header half of the feature
// (markdownDocumentHeaders: UTF-8 for a file with no charset, and Freedom's
// reader policy in place of the server's) is unit-tested in
// src/main/markdown-view.test.js instead.
//
// One case would pass here even if that hook were broken: a server CSP
// `sandbox` that forbids script (GitHub's raw files) stops the tab preload
// from starting at all, until something creates the page's script context,
// and Playwright attaching to every page over the DevTools protocol does
// exactly that. Only a launch without a debugger attached shows the
// difference.

const { test, expect } = require('./fixtures');

const POST_URL = 'https://notes.example.org/2026/11/08/markdown.md';
const POST = `---
title: "Markdown in Freedom"
link: "https://example.org/original"
author: "Ada Writer"
pubDate: "Sun, 08 Nov 2026 10:00:00 GMT"
description: "How a file becomes a page."
source:
  title: "Not the page title"
urlPrev: "../07/earlier.md"
urlNext: "later.md"
urlParent: "../08.md"
---

Freedom renders **Markdown** in place.

## Second heading

<script>window.__markdownRan = 'script'</script>

<img src="missing.png" onerror="window.__markdownRan = 'onerror'">

A [safe link](later.md), an [unsafe one](javascript:window.__markdownRan='link') and
[a heading](#second-heading).

![A picture](picture.png)
`;

const inGuest = (window, source) =>
  window.evaluate(async (js) => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    if (!wv?.executeJavaScript) return null;
    try {
      return await wv.executeJavaScript(js, true);
    } catch {
      return null;
    }
  }, source);

const navigateTo = async (window, value) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(value);
  await input.press('Enter');
};

const markdownView = (window) =>
  inGuest(window, `document.documentElement.getAttribute('data-freedom-markdown')`);

const openPost = async (window, harness) => {
  await harness.setContentFixture(POST_URL, {
    body: POST,
    contentType: 'text/markdown; charset=utf-8',
  });
  await navigateTo(window, POST_URL);
  await expect.poll(() => markdownView(window), { timeout: 15_000 }).toBe('formatted');
};

test('a Markdown file opens as a page, titled and linked from its front matter, with nothing able to run', async ({
  window,
  harness,
}) => {
  await openPost(window, harness);

  const page = await inGuest(
    window,
    `(() => {
      const article = document.querySelector('article.md-page');
      const link = (rel) => document.querySelector('.md-nav a[rel="' + rel + '"]')?.href || null;
      return {
        title: document.title,
        heading: article.querySelector('h1')?.textContent,
        headingLink: article.querySelector('h1 > a')?.getAttribute('href'),
        headingId: article.querySelector('h1').id,
        header: [...article.children].slice(1, 4).map((el) => el.className),
        description: article.querySelector('.md-description')?.textContent,
        anchors: [...article.querySelectorAll('a.md-anchor')].map((a) => [
          a.getAttribute('href'),
          a.getAttribute('aria-label'),
          a.parentElement.id,
        ]),
        caption: article.querySelector('figure.md-picture > img + figcaption')?.textContent,
        byline: article.querySelector('.md-byline')?.textContent,
        bylineTime: article.querySelector('.md-byline time')?.getAttribute('datetime'),
        navs: article.querySelectorAll('.md-nav').length,
        prev: link('prev'),
        up: link('up'),
        next: link('next'),
        anchor: document.getElementById('second-heading')?.tagName,
        text: article.textContent,
        hrefs: [...article.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        images: [...article.querySelectorAll('img')].map((img) => [
          img.getAttribute('src'),
          img.referrerPolicy,
        ]),
        scripts: document.scripts.length,
        handlers: document.querySelectorAll('[onerror], [onclick], [onload]').length,
        sourceShown: getComputedStyle(document.querySelector('body > pre')).display !== 'none',
        ran: window.__markdownRan ?? null,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
      };
    })()`
  );

  expect(page.title).toBe('Markdown in Freedom');
  expect(page.heading).toBe('Markdown in Freedom');
  // A link post: the title goes where the post points.
  expect(page.headingLink).toBe('https://example.org/original');
  expect(page.header).toEqual(['md-title', 'md-byline', 'md-description']);
  expect(page.description).toBe('How a file becomes a page.');
  // The text's headings link to themselves; the page's own title has no id,
  // so the text's ids stay GitHub's.
  expect(page.headingId).toBe('');
  expect(page.anchors).toEqual([['#second-heading', 'Link to “Second heading”', 'second-heading']]);
  // An image alone in its paragraph is a picture, captioned with its alt text.
  expect(page.caption).toBe('A picture');
  expect(page.byline).toMatch(/^Ada Writer · /);
  expect(page.bylineTime).toBe('2026-11-08T10:00:00.000Z');
  expect(page.navs).toBe(2);
  expect(page.prev).toBe('https://notes.example.org/2026/11/07/earlier.md');
  expect(page.up).toBe('https://notes.example.org/2026/11/08.md');
  expect(page.next).toBe('https://notes.example.org/2026/11/08/later.md');
  expect(page.anchor).toBe('H2');
  expect(page.text).toContain('Freedom renders Markdown in place.');
  expect(page.text).toContain('unsafe one');
  expect(page.text).not.toContain('Not the page title');
  expect(page.hrefs).toEqual(expect.arrayContaining(['later.md', '#second-heading']));
  expect(page.hrefs.some((href) => /javascript/i.test(href))).toBe(false);
  // No referrer off the page's own site, whatever the server's policy says.
  expect(page.images).toEqual([['picture.png', 'same-origin']]);
  expect(page.scripts).toBe(0);
  expect(page.handlers).toBe(0);
  expect(page.sourceShown).toBe(false);
  expect(page.ran).toBeNull();
  expect(page.csp).toContain("script-src 'none'");

  await expect(window.locator('[data-test="tab"] .tab-title').first()).toHaveText(
    'Markdown in Freedom',
    { timeout: 10_000 }
  );
});

test('a post with no title is headed by its date, with its images in the margin or captioned', async ({
  window,
  harness,
}) => {
  // The shape of most of Scripting News: no title, a margin image named in
  // the front matter or opening a paragraph, a picture on its own.
  const url = 'https://notes.example.org/2026/11/03/a172109.md';
  await harness.setContentFixture(url, {
    body: `---
author: "Dave Winer"
pubDate: "Tue, 03 Nov 2026 17:21:09 GMT"
rightMarginImage: "truck.png"
urlPrev: "a163902.md"
---

![](cherries.png)The cherries were good this year.

![Avis is #2 on the ladder.](avis.png)

Two ![](one.png) images ![](two.png) in a line stay in it.
`,
    contentType: 'text/markdown; charset=utf-8',
  });
  await navigateTo(window, url);
  await expect.poll(() => markdownView(window), { timeout: 15_000 }).toBe('formatted');

  const page = await inGuest(
    window,
    `(() => {
      const article = document.querySelector('article.md-page');
      const img = (src) => article.querySelector('img[src="' + src + '"]');
      // Written the way the page writes them, in this tab's locale and zone.
      const posted = new Date('Tue, 03 Nov 2026 17:21:09 GMT');
      return {
        title: document.title,
        heading: article.querySelector('h1')?.textContent,
        headingTime: article.querySelector('h1 > time')?.getAttribute('datetime'),
        longDate: posted.toLocaleDateString(undefined, {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        }),
        byline: article.querySelector('.md-byline')?.textContent,
        time: posted.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        order: [...article.children]
          .slice(0, 5)
          .map((el) => el.tagName.toLowerCase() + (el.classList[0] ? '.' + el.classList[0] : '')),
        named: img('truck.png')?.className,
        opening: [img('cherries.png')?.className, img('cherries.png')?.parentElement.tagName],
        float: getComputedStyle(img('cherries.png')).float,
        picture: [img('avis.png')?.parentElement.className, article.querySelector('figcaption')?.textContent],
        inline: [img('one.png')?.className, img('two.png')?.className],
        anchors: article.querySelectorAll('.md-anchor').length,
      };
    })()`
  );

  expect(page.heading).toBe(page.longDate);
  expect(page.title).toBe(page.longDate);
  expect(page.headingTime).toBe('2026-11-03T17:21:09.000Z');
  expect(page.byline).toBe(`Dave Winer · ${page.time}`);
  expect(page.order).toEqual([
    'nav.md-nav',
    'h1.md-title',
    'p.md-byline',
    'img.md-margin-image',
    'p',
  ]);
  expect(page.named).toBe('md-margin-image');
  expect(page.opening).toEqual(['md-margin-image', 'P']);
  expect(page.float).toBe('right');
  expect(page.picture).toEqual(['md-picture', 'Avis is #2 on the ladder.']);
  expect(page.inline).toEqual(['', '']);
  expect(page.anchors).toBe(0);
});

test("a link post's own heading links on, and a picture keeps its caption and permalink", async ({
  window,
  harness,
}) => {
  // A link post that repeats its title in the text, then two items the way
  // Winer's day pages write them: a picture with whitespace after it, and a
  // picture followed by its `#` permalink.
  const url = 'https://notes.example.org/2026/11/07.md';
  await harness.setContentFixture(url, {
    body:
      '---\ntitle: "Worth reading"\nlink: "https://example.org/original"\n---\n\n' +
      '# Worth reading\n\n' +
      '![Sunset over the lake](sunset.png)\n\t\n\n' +
      '![The truck](truck.png) [#](07/a1.md "Direct link to this item.")\n',
    contentType: 'text/markdown; charset=utf-8',
  });
  await navigateTo(window, url);
  await expect.poll(() => markdownView(window), { timeout: 15_000 }).toBe('formatted');

  const page = await inGuest(
    window,
    `(() => {
      const article = document.querySelector('article.md-page');
      const h1 = article.querySelector('h1');
      return {
        h1s: article.querySelectorAll('h1').length,
        link: h1.querySelector('a.md-title-link')?.getAttribute('href'),
        linkText: h1.querySelector('a.md-title-link')?.textContent,
        anchor: h1.querySelector('a.md-anchor')?.getAttribute('href'),
        pictures: [...article.querySelectorAll('figure.md-picture')].map((figure) => [
          figure.querySelector('img').getAttribute('src'),
          figure.querySelector('figcaption')?.textContent,
          figure.querySelector('figcaption a')?.getAttribute('href') ?? null,
        ]),
        margin: article.querySelectorAll('.md-margin-image').length,
      };
    })()`
  );

  expect(page.h1s).toBe(1);
  expect(page.link).toBe('https://example.org/original');
  expect(page.linkText).toBe('Worth reading');
  expect(page.anchor).toBe('#worth-reading');
  expect(page.pictures).toEqual([
    ['sunset.png', 'Sunset over the lake', null],
    ['truck.png', 'The truck #', '07/a1.md'],
  ]);
  expect(page.margin).toBe(0);
});

test('?format=markdown opens the page on its source, and the button shows the page', async ({
  window,
  harness,
}) => {
  // The https stub matches the full address, query included.
  const url = `${POST_URL}?format=markdown`;
  await harness.setContentFixture(url, { body: POST, contentType: 'text/markdown; charset=utf-8' });
  await navigateTo(window, url);
  await expect.poll(() => markdownView(window), { timeout: 15_000 }).toBe('source');
  const button = window.locator('[data-test="markdown-toggle-btn"]');
  await expect(button).toBeVisible({ timeout: 10_000 });
  await expect(button).toHaveAttribute('aria-pressed', 'true');

  await button.click();
  await expect.poll(() => markdownView(window)).toBe('formatted');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});

test('the Markdown button shows the source and goes back to the page', async ({
  window,
  harness,
}) => {
  await openPost(window, harness);
  const button = window.locator('[data-test="markdown-toggle-btn"]');
  await expect(button).toBeVisible({ timeout: 10_000 });
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAttribute('title', 'Show Markdown source');
  await expect(button).toHaveAccessibleName('Markdown source');

  await button.click();
  await expect.poll(() => markdownView(window)).toBe('source');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(button).toHaveAttribute('title', 'Show formatted page');
  await expect(button).toContainText('Source');
  const source = await inGuest(
    window,
    `({
      text: document.querySelector('body > pre').textContent,
      frontMatter: document.querySelector('body > pre .md-front-matter')?.textContent,
      pageShown: getComputedStyle(document.querySelector('article.md-page')).display !== 'none',
    })`
  );
  expect(source.text).toBe(POST);
  expect(source.frontMatter).toMatch(/^---\ntitle: "Markdown in Freedom"/);
  expect(source.pageShown).toBe(false);

  await button.click();
  await expect.poll(() => markdownView(window)).toBe('formatted');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});

test('text/plain counts at a .md path only, and the button goes with the page', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture('https://raw.example.org/repo/README.md', {
    body: '# Read me\n\nPlain text, Markdown by name.\n',
    contentType: 'text/plain; charset=utf-8',
  });
  await harness.setContentFixture('https://raw.example.org/repo/notes.txt', {
    body: '# Not Markdown\n',
    contentType: 'text/plain; charset=utf-8',
  });
  const button = window.locator('[data-test="markdown-toggle-btn"]');

  await navigateTo(window, 'https://raw.example.org/repo/README.md');
  await expect.poll(() => markdownView(window), { timeout: 15_000 }).toBe('formatted');
  expect(await inGuest(window, `document.querySelector('article.md-page h1')?.textContent`)).toBe(
    'Read me'
  );
  await expect(button).toBeVisible({ timeout: 10_000 });

  await navigateTo(window, 'https://raw.example.org/repo/notes.txt');
  await expect
    .poll(() => inGuest(window, `location.pathname`), { timeout: 15_000 })
    .toBe('/repo/notes.txt');
  await expect(button).toBeHidden();
  expect(await markdownView(window)).toBeNull();
  expect(await inGuest(window, `document.body.textContent`)).toBe('# Not Markdown\n');
});

test('a charset the server declares is kept, even one that reads differently as UTF-8', async ({
  window,
  harness,
}) => {
  // The fixture's bytes are UTF-8 for "Café" (C3 A9), which as declared
  // Windows-1252 are the two characters "Ã©": the server's word wins.
  const url = 'https://notes.example.org/declared.md';
  await harness.setContentFixture(url, {
    body: '# Café\n',
    contentType: 'text/markdown; charset=windows-1252',
  });
  await navigateTo(window, url);
  await expect.poll(() => markdownView(window), { timeout: 15_000 }).toBe('formatted');
  const read = await inGuest(
    window,
    `({
      charset: document.characterSet,
      heading: document.querySelector('article.md-page h1')?.textContent,
    })`
  );
  expect(read).toEqual({ charset: 'windows-1252', heading: 'CafÃ©' });
});

for (const theme of ['light', 'dark']) {
  test.describe(`theme: '${theme}'`, () => {
    test.use({ seedSettings: { theme } });

    test(`the page reads in the ${theme} palette`, async ({ window, harness }) => {
      await openPost(window, harness);
      const state = await inGuest(
        window,
        `({
          theme: document.documentElement.getAttribute('data-theme'),
          scheme: getComputedStyle(document.documentElement).colorScheme,
          background: getComputedStyle(document.documentElement).backgroundColor,
        })`
      );
      expect(state.theme).toBe(theme);
      expect(state.scheme).toBe(theme);
      expect(state.background).toBe(theme === 'dark' ? 'rgb(32, 33, 34)' : 'rgb(255, 255, 255)');
    });
  });
}
