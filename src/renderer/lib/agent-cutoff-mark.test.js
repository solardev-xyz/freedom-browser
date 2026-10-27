const { cutOffMarkHost, setCutOffMark, CUTOFF_HOST_CLASS } = require('./agent-cutoff-mark');

// A tiny element tree: el('ul', el('li', 'text')) etc. Strings are text nodes
// and don't count as element children, as in the DOM.
function el(tag, ...kids) {
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    children: kids.filter(kid => typeof kid !== 'string'),
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
    },
    get lastElementChild() {
      return this.children.at(-1) || null;
    },
    querySelectorAll(selector) {
      const name = selector.slice(1);
      const out = [];
      const walk = n => n.children.forEach(c => { if (c.classList.contains(name)) out.push(c); walk(c); });
      walk(this);
      return out;
    },
  };
  return node;
}

function markdown(...kids) {
  const output = el('div', ...kids);
  output.classList.add('rendered-markdown');
  return output;
}

describe('cutOffMarkHost', () => {
  test('plain streamed text marks the output itself', () => {
    const output = el('div', 'Comparing the first');
    expect(cutOffMarkHost(output)).toBe(output);
  });

  test.each([
    ['paragraph', () => { const p = el('p', 'x'); return [markdown(el('p', 'a'), p), p]; }],
    ['heading', () => { const h = el('h3', 'x'); return [markdown(el('p', 'a'), h), h]; }],
    ['tight list item', () => { const li = el('li', 'x'); return [markdown(el('ul', el('li', 'a'), li)), li]; }],
    ['loose list item', () => { const p = el('p', 'x'); return [markdown(el('ol', el('li', el('p', 'a')), el('li', p))), p]; }],
    ['loose nested list', () => {
      const p = el('p', 'Comparing');
      return [markdown(el('ul', el('li', el('p', 'a'), el('ul', el('li', p))))), p];
    }],
    ['three-level list', () => {
      const li = el('li', 'x');
      return [markdown(el('ul', el('li', 'a', el('ul', el('li', 'b', el('ol', li)))))), li];
    }],
    ['quoted paragraph', () => { const p = el('p', 'x'); return [markdown(el('blockquote', p)), p]; }],
    ['nested blockquote', () => { const p = el('p', 'x'); return [markdown(el('blockquote', el('blockquote', p))), p]; }],
    ['blockquote ending in a list', () => {
      const li = el('li', 'x');
      return [markdown(el('blockquote', el('p', 'a'), el('ul', li))), li];
    }],
    ['list item ending in inline markup', () => {
      const li = el('li', 'x ', el('strong', 'y'));
      return [markdown(el('ul', li)), li];
    }],
  ])('%s: the block the sentence ends in carries the mark', (_name, build) => {
    const [output, host] = build();
    expect(cutOffMarkHost(output)).toBe(host);
  });

  test.each([
    ['code block', () => markdown(el('p', 'a'), el('pre', el('code', 'x')))],
    ['table', () => markdown(el('table', el('tbody')))],
    ['rule', () => markdown(el('p', 'a'), el('hr'))],
    ['list item ending in a code block', () => markdown(el('ul', el('li', el('p', 'a'), el('pre', el('code', 'x')))))],
    ['blockquote ending in a code block', () => markdown(el('blockquote', el('pre', el('code', 'x'))))],
  ])('%s: the output carries the mark on its own line', (_name, build) => {
    const output = build();
    expect(cutOffMarkHost(output)).toBe(output);
  });
});

describe('setCutOffMark', () => {
  test('tags exactly one host and clears it again', () => {
    const p = el('p', 'x');
    const output = markdown(el('ul', el('li', el('p', 'a'), el('ul', el('li', p)))));
    setCutOffMark(output, true);
    expect(output.classList.contains('incomplete')).toBe(true);
    expect(p.classList.contains(CUTOFF_HOST_CLASS)).toBe(true);
    expect(output.querySelectorAll(`.${CUTOFF_HOST_CLASS}`)).toEqual([p]);
    setCutOffMark(output, false);
    expect(output.classList.contains('incomplete')).toBe(false);
    expect(output.querySelectorAll(`.${CUTOFF_HOST_CLASS}`)).toEqual([]);
    expect(output.classList.contains(CUTOFF_HOST_CLASS)).toBe(false);
  });

  test('plain text tags the output itself', () => {
    const output = el('div', 'x');
    setCutOffMark(output, true);
    expect(output.classList.contains(CUTOFF_HOST_CLASS)).toBe(true);
  });
});
