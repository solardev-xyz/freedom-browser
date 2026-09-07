/**
 * The shared wallet-sidebar sub-screen header (#238).
 *
 * Two halves, because either one alone lets the drift back in:
 *
 *  - the renderer: it must produce chevron + "Back" + title for every
 *    declaration, keep the ids the wallet modules cache, and never emit a
 *    close control (see the module header for why);
 *  - the guard over `index.html`: every sub-screen must *declare* its header
 *    rather than hand-write one. That is the half that would have caught the
 *    three layouts in the first place — the renderer can be perfect and a
 *    new screen can still paste its own markup next door.
 */

const fs = require('fs');
const path = require('path');

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');
const { renderSubscreenHeaders } = require('./subscreen-header.js');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/** A header declaration, as it appears in index.html. */
const declare = ({ back, title, titleId }) =>
  createElement('div', {
    classes: ['subscreen-header'],
    dataset: {
      ...(back ? { back } : {}),
      ...(title === undefined ? {} : { title }),
      ...(titleId ? { titleId } : {}),
    },
  });

function render(...headers) {
  const body = createElement('body');
  headers.forEach((header) => body.appendChild(header));
  const doc = createDocument({ body });
  const count = renderSubscreenHeaders(doc);
  return { count, doc };
}

describe('renderSubscreenHeaders', () => {
  test('renders chevron + Back + title, keeping the declared ids', () => {
    const header = declare({ back: 'send-back', title: 'Send' });
    expect(render(header).count).toBe(1);

    const [button, heading] = header.children;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.className).toBe('subscreen-back-btn');
    expect(button.id).toBe('send-back');
    // The chevron is markup on the button; the label is a real child so the
    // button has an accessible name without an aria-label.
    expect(button.innerHTML).toContain('<polyline points="15 18 9 12 15 6" />');
    expect(button.children.map((child) => child.textContent)).toEqual(['Back']);

    expect(heading.tagName).toBe('H3');
    expect(heading.className).toBe('subscreen-title');
    expect(heading.textContent).toBe('Send');
    expect(heading.id).toBeUndefined();
  });

  test('names the heading when the screen retitles itself at runtime', () => {
    const header = declare({
      back: 'swarm-feed-back',
      title: 'Feed Access',
      titleId: 'swarm-feed-title',
    });
    render(header);

    const heading = header.children[1];
    expect(heading.id).toBe('swarm-feed-title');
    expect(heading.textContent).toBe('Feed Access');
  });

  test('omits the back button only when no back id is declared', () => {
    const header = declare({ title: 'Confirm on Your Phone' });
    render(header);

    expect(header.children).toHaveLength(1);
    expect(header.children[0].tagName).toBe('H3');
  });

  test('emits no close control on any shape', () => {
    const withBack = declare({ back: 'dapp-tx-back', title: 'Confirm Transaction' });
    const withoutBack = declare({ title: 'Confirm on Your Phone' });
    render(withBack, withoutBack);

    for (const header of [withBack, withoutBack]) {
      const markup = header.children.map((child) => child.className).join(' ');
      expect(markup).not.toMatch(/close/);
      expect(header.children.map((child) => child.textContent).join(' ')).not.toContain('×');
    }
  });

  test('is idempotent — a second pass does not stack a second header', () => {
    const header = declare({ back: 'send-back', title: 'Send' });
    const { doc } = render(header);

    renderSubscreenHeaders(doc);

    expect(header.children).toHaveLength(2);
    expect(header.children[0].id).toBe('send-back');
  });

  test('leaves an undeclared header alone rather than emptying it', () => {
    const legacy = createElement('div', { classes: ['subscreen-header'] });
    legacy.appendChild(createElement('h3', { textContent: 'Hand-written' }));

    expect(render(legacy).count).toBe(0);
    expect(legacy.children).toHaveLength(1);
    expect(legacy.children[0].textContent).toBe('Hand-written');
  });
});

// --- the drift guard over index.html --------------------------------------

const HEADER_TAG = /<div\s+class="subscreen-header"([\s\S]*?)><\/div>/g;
const HEADER_MULTILINE = /<div\s*\n\s*class="subscreen-header"([\s\S]*?)><\/div>/g;

/** Every `.subscreen-header` declaration in `html`, as attribute strings. */
function declarations(html) {
  const found = [];
  for (const source of [HEADER_TAG, HEADER_MULTILINE]) {
    source.lastIndex = 0;
    let match;
    while ((match = source.exec(html))) {
      found.push({ index: match.index, attrs: match[1].replace(/\s+/g, ' ').trim() });
    }
  }
  // Both patterns can match the same single-line declaration; de-duplicate on
  // source offset, and report them in document order.
  return [...new Map(found.map((entry) => [entry.index, entry])).values()]
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.attrs);
}

const attr = (attrs, name) => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || null;

describe('index.html sub-screen headers', () => {
  const found = declarations(INDEX_HTML);

  test('every sub-screen header is declared, not hand-written', () => {
    // One declaration per `.subscreen-header` occurrence: anything left over
    // is markup this component does not own.
    const occurrences = (INDEX_HTML.match(/class="subscreen-header"/g) || []).length;
    expect(found).toHaveLength(occurrences);
    expect(occurrences).toBeGreaterThan(0);

    // The three hand-copied layouts this replaced are gone for good: no
    // sub-screen spells its own chevron button or title out any more.
    expect(INDEX_HTML).not.toContain('subscreen-back-btn');
    expect(INDEX_HTML).not.toContain('subscreen-title');
  });

  test('every declaration carries a title, and a back id unless it is the remote-signing panel', () => {
    const titleless = found.filter((attrs) => !attr(attrs, 'data-title'));
    expect(titleless).toEqual([]);

    // The one screen with no way back, named explicitly so adding a second
    // one is a decision someone has to make here rather than a copy-paste.
    const backless = found.filter((attrs) => !attr(attrs, 'data-back'));
    expect(backless.map((attrs) => attr(attrs, 'data-title'))).toEqual(['Confirm on Your Phone']);
  });

  test('every declared id is unique and is actually wired up in the renderer', () => {
    const ids = found.flatMap((attrs) =>
      [attr(attrs, 'data-back'), attr(attrs, 'data-title-id')].filter(Boolean)
    );
    expect(new Set(ids).size).toBe(ids.length);

    // A typo in a data-back id is otherwise silent: the button renders, and
    // nothing ever finds it. Every id must be looked up by some renderer
    // module.
    const rendererSource = collectRendererSource(path.join(__dirname, '..'));
    const orphans = ids.filter((id) => !rendererSource.includes(`'${id}'`));
    expect(orphans).toEqual([]);
  });

  test('the guard sees a hand-written header for what it is', () => {
    // Mutation check: the shape this component replaced must not read as a
    // declaration.
    const handWritten = `
      <div class="subscreen-header">
        <button type="button" class="subscreen-back-btn" id="send-back">
          <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" /></svg>
          <span>Back</span>
        </button>
        <h3 class="subscreen-title">Send</h3>
      </div>`;
    expect(declarations(handWritten)).toEqual([]);
    expect((handWritten.match(/class="subscreen-header"/g) || []).length).toBe(1);
  });
});

function collectRendererSource(dir) {
  let source = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      source += collectRendererSource(full);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      source += fs.readFileSync(full, 'utf8');
    }
  }
  return source;
}
