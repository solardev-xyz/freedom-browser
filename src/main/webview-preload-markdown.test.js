// The Markdown view (#1035): front matter, the URL rules and the rendered
// body, with the vendored marked the tab uses. Mounting the page (the header,
// the image layout, the heading links) needs a real document and is covered
// end to end in test-e2e/markdown-view.spec.js.

const marked = require('../renderer/vendor/marked.min.js');
const {
  createMarkdownView,
  splitFrontMatter,
  slugify,
  createSlugger,
  formatDate,
  asksForSource,
  isSafeLinkUrl,
  isSafeImageUrl,
} = require('./webview-preload-markdown');

const { renderBody } = createMarkdownView({ marked, DOMPurify: null });

describe('splitFrontMatter', () => {
  // The shape of every post in Dave Winer's markdownWeb archive.
  const WINER_POST = [
    '---',
    'title: "Electric  Outliner"',
    'author: "Dave Winer"',
    'pubDate: "Thu, 04 May 2017 14:11:29 GMT"',
    'source:',
    '  url: "http://scripting.com/rss.xml"',
    '  title: "Scripting News"',
    'generator: "opmlToMarkdown v0.5.11"',
    'urlPrev: "../03/151242.md"',
    'urlNext: "152544.md"',
    '---',
    '',
    'Todo',
    '',
  ].join('\n');

  test('reads the markdownWeb keys and leaves nested ones alone', () => {
    const { meta, frontMatter, body } = splitFrontMatter(WINER_POST);
    expect(meta).toEqual({
      title: 'Electric  Outliner',
      author: 'Dave Winer',
      pubDate: 'Thu, 04 May 2017 14:11:29 GMT',
      urlPrev: '../03/151242.md',
      urlNext: '152544.md',
    });
    expect(body).toBe('\nTodo\n');
    expect(frontMatter + body).toBe(WINER_POST);
  });

  test("reads the description, a link post's link and a margin image", () => {
    const { meta } = splitFrontMatter(
      [
        '---',
        'title: "Worth reading"',
        'link: "https://example.org/original"',
        'description: "Why this matters."',
        'rightMarginImage: "https://imgs.example.org/truck.png"',
        '---',
        '',
      ].join('\n')
    );
    expect(meta).toEqual({
      title: 'Worth reading',
      link: 'https://example.org/original',
      description: 'Why this matters.',
      rightMarginImage: 'https://imgs.example.org/truck.png',
    });
  });

  test('ignores keys it does not use', () => {
    // `image` and `inlineImage` repeat an image the text already shows;
    // `metaImage` is for link previews, `enclosure` for podcast apps.
    const { meta } = splitFrontMatter(
      '---\ngenerator: x\nimage: z.png\ninlineImage: i.png\nmetaImage: m.png\nenclosure: a.m4a\n---\nHi'
    );
    expect(meta).toEqual({});
  });

  test.each([
    ['double-quoted with escapes', 'title: "Say \\"hi\\" \\u00e9"', 'Say "hi" é'],
    ['single-quoted', "title: 'It''s here'", "It's here"],
    ['plain, with a comment', 'title: Plain words # note', 'Plain words'],
    ['plain with a colon', 'urlNext: https://example.org/next.md', 'https://example.org/next.md'],
  ])('a %s value', (_label, line, expected) => {
    const key = line.split(':')[0];
    expect(splitFrontMatter(`---\n${line}\n---\n`).meta[key]).toBe(expected);
  });

  test.each([
    ['a block scalar', 'title: >\n  folded'],
    ['a flow list', 'title: [a, b]'],
    ['an anchor', 'title: &anchor x'],
    ['an unterminated quote', 'title: "open'],
    ['no space after the colon', 'title:joined'],
  ])('skips %s', (_label, block) => {
    expect(splitFrontMatter(`---\n${block}\n---\n`).meta.title).toBeUndefined();
  });

  test('the first of a repeated key wins', () => {
    expect(splitFrontMatter('---\ntitle: one\ntitle: two\n---\n').meta.title).toBe('one');
  });

  test.each([
    ['CRLF line ends', '---\r\ntitle: Win\r\n---\r\nBody'],
    ['a byte-order mark', '﻿---\ntitle: Win\n---\nBody'],
    ['a ... closer', '---\ntitle: Win\n...\nBody'],
    ['a closer at the very end', '---\ntitle: Win\n---'],
  ])('handles %s', (_label, text) => {
    const { meta, frontMatter, body } = splitFrontMatter(text);
    expect(meta.title).toBe('Win');
    expect(frontMatter + body).toBe(text);
    expect(body.trim()).toBe(text.endsWith('---') ? '' : 'Body');
  });

  test.each([
    ['no opening line', 'title: x\n---\nBody'],
    ['no closing line', '---\ntitle: x\nBody'],
    ['a rule above prose', '---\nJust a paragraph between rules.\n---\nMore'],
    ['an opening line further down', '\n---\ntitle: x\n---\n'],
  ])('is not front matter with %s', (_label, text) => {
    expect(splitFrontMatter(text)).toEqual({ meta: {}, frontMatter: '', body: text });
  });

  test('an empty block is front matter with nothing in it', () => {
    expect(splitFrontMatter('---\n---\n# Hi')).toEqual({
      meta: {},
      frontMatter: '---\n---\n',
      body: '# Hi',
    });
  });
});

describe('URL rules', () => {
  test.each([
    'https://example.org/',
    'http://example.org/',
    'bzz://abc/post.md',
    'ipfs://bafy/README.md',
    'ipns://name.eth/',
    'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree',
    'web3://0xabc/',
    'ethereum:0xabc@1',
    'mailto:dave@example.org',
    '../03/151242.md',
    '152544.md',
    '/root.md',
    '#install',
    '?page=2',
    '',
  ])('a link to %p stays a link', (url) => {
    expect(isSafeLinkUrl(url)).toBe(true);
  });

  test.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    ' \u0001javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'freedom://settings',
    'blob:https://example.org/uuid',
  ])('a link to %p loses its href', (url) => {
    expect(isSafeLinkUrl(url)).toBe(false);
  });

  test.each([
    'https://example.org/a.png',
    'bzz://abc/a.png',
    'ipfs://bafy/a.png',
    'a.png',
    'data:image/png;base64,AAAA',
    'DATA:image/svg+xml,<svg/>',
  ])('an image from %p loads', (url) => {
    expect(isSafeImageUrl(url)).toBe(true);
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'mailto:a@b.c',
    'rad:z3gq/a.png',
    'file:///tmp/a.png',
  ])('an image from %p shows its alt text', (url) => {
    expect(isSafeImageUrl(url)).toBe(false);
  });
});

describe('renderBody', () => {
  test('renders GitHub-flavoured Markdown', () => {
    const html = renderBody(
      '# Title\n\n| a | b |\n| - | :-: |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~ https://example.org'
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th align="center">b</th>');
    expect(html).toContain('<input checked="" disabled="" type="checkbox">');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('<a href="https://example.org">https://example.org</a>');
  });

  test('drops raw HTML, block and inline; inline text between tags stays', () => {
    const html = renderBody(
      '<script>alert(1)</script>\n\n<details><summary>s</summary>hidden</details>\n\n' +
        'Text <b>bold</b> <img src=x onerror=alert(1)> <span style="color:red">red</span>'
    );
    expect(html).toBe('<p>Text bold  red</p>\n');
  });

  test('keeps safe links and images, unlinks the rest', () => {
    const html = renderBody(
      '[ok](../a.md) [bzz](bzz://abc/x.md) [js](javascript:alert(1)) <javascript:alert(2)> ' +
        '![pic](a.png) ![bad <b>alt</b>](javascript:x) ![svg](data:image/svg+xml,x)'
    );
    expect(html).toContain('<a href="../a.md">ok</a>');
    expect(html).toContain('<a href="bzz://abc/x.md">bzz</a>');
    expect(html).not.toMatch(/(?:href|src)="\s*javascript/i);
    // Unlinked, the text stays: the link's label, the autolink's address.
    expect(html).toContain(' js ');
    expect(html).toContain('javascript:alert(2)');
    expect(html).toContain('<img src="a.png" alt="pic">');
    expect(html).toContain('bad &lt;b&gt;alt&lt;/b&gt;');
    expect(html).toContain('<img src="data:image/svg+xml,x" alt="svg">');
  });

  test('a link title cannot break out of its attribute', () => {
    const html = renderBody('[x](https://example.org/ "a\\" onmouseover=\\"alert(1)")');
    expect(html).toContain('title="a&quot; onmouseover=&quot;alert(1)"');
    expect(html).not.toMatch(/"\s+onmouseover=/);
  });

  test('marked adds no ids of its own; the view adds them after sanitising', () => {
    expect(renderBody('## Install')).toBe('<h2>Install</h2>\n');
  });
});

describe('slugify', () => {
  test.each([
    ['Install', 'install'],
    ['Getting Started — v2.0!', 'getting-started--v20'],
    ['Über uns', 'über-uns'],
    ['snake_case and-dash', 'snake_case-and-dash'],
    ['  Padded  ', 'padded'],
    ['!!!', ''],
  ])('%p → %p', (text, slug) => {
    expect(slugify(text)).toBe(slug);
  });
});

describe('createSlugger', () => {
  test('numbers repeats the way GitHub does, so every id is unique', () => {
    const slugFor = createSlugger();
    expect(['Foo', 'Foo', 'Foo-1', 'Foo'].map(slugFor)).toEqual([
      'foo',
      'foo-1',
      'foo-1-1',
      'foo-2',
    ]);
  });

  test('each page starts its own count', () => {
    createSlugger()('Install');
    expect(createSlugger()('Install')).toBe('install');
  });
});

describe('formatDate', () => {
  const NEW_YORK = { locale: 'en-US', timeZone: 'America/New_York' };

  test('a bare calendar date is that day wherever the reader is, with no time', () => {
    expect(formatDate('2026-11-08', NEW_YORK)).toEqual({
      text: 'Nov 8, 2026',
      iso: '2026-11-08',
      time: '',
    });
    expect(formatDate('2026-11-08', { locale: 'en-US', timeZone: 'Pacific/Auckland' }).text).toBe(
      'Nov 8, 2026'
    );
  });

  test("a timestamp is shown in the reader's time zone", () => {
    expect(formatDate('Sun, 08 Nov 2026 02:00:00 GMT', NEW_YORK)).toEqual({
      text: 'Nov 7, 2026',
      iso: '2026-11-08T02:00:00.000Z',
      time: '9:00 PM',
    });
  });

  test('the long form heads a post that has no title', () => {
    expect(formatDate('Tue, 03 Nov 2026 17:21:09 GMT', { ...NEW_YORK, long: true })).toEqual({
      text: 'Tuesday, November 3, 2026',
      iso: '2026-11-03T17:21:09.000Z',
      time: '12:21 PM',
    });
    expect(formatDate('2026-11-08', { ...NEW_YORK, long: true }).text).toBe(
      'Sunday, November 8, 2026'
    );
  });

  test('anything unparseable is shown as written', () => {
    expect(formatDate(' last Tuesday ', NEW_YORK)).toEqual({
      text: 'last Tuesday',
      iso: '',
      time: '',
    });
  });
});

describe('asksForSource', () => {
  test.each([
    ['?format=markdown', true],
    ['?format=Markdown&x=1', true],
    ['?x=1&format=markdown', true],
    ['?format=html', false],
    ['?formats=markdown', false],
    ['', false],
    [undefined, false],
  ])('%p → %p', (search, expected) => {
    expect(asksForSource(search)).toBe(expected);
  });
});
