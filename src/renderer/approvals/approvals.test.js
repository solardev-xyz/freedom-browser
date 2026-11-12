/**
 * The approvals document's own rules (freedom-core design 0011, "Rendering a
 * page's data"; APS-1): the closed, bounded schema per kind, text encoded
 * for where it shows, and the input gate: nothing for 500 ms after a prompt
 * appears, changes, shows again or moves, an activation counts only if its
 * press came after the delay too, and Enter never approves. The real
 * document runs these in real Electron (test-e2e/approvals-document.spec.js).
 */

const fs = require('fs');
const path = require('path');

const core = require('./approvals-core.js');
const kinds = require('./approvals-kinds.js');

const { conforms, visible, cut, createInputGate, INPUT_DELAY_MS, MAX_VIEW_BYTES, CUT_AT } = core;
const { checkMessage } = kinds;
const SCHEMAS = Object.fromEntries(Object.entries(kinds.KINDS).map(([kind, def]) => [kind, def.schema]));

const HANDLE = 'f'.repeat(64);
const SITE = { key: `bzz://${'a'.repeat(64)}`, label: `bzz://${'a'.repeat(64)}` };
const VIEW = { title: 'Title', message: 'Message', rows: [{ label: 'Row', value: 'Value' }] };
const message = (fields = {}) => ({ handle: HANDLE, revision: 3, guest: 3, kind: 'test.prompt', site: SITE, view: VIEW, ...fields });
const cp = (code) => String.fromCodePoint(code);
const BACKSLASH = String.fromCharCode(92);
const escaped = (hex) => `${BACKSLASH}u{${hex}}`;

describe('the closed schema', () => {
  test('a prompt that fits its kind\'s schema shows', () => {
    expect(checkMessage(message())).toEqual({ handle: HANDLE, revision: 3, kind: 'test.prompt', site: SITE, view: VIEW, valid: true });
  });

  // Codex, #1216 round 2: every message names main's revision, the one its
  // report and its parts are for, whether its view came whole or in parts.
  test('a message without a revision main could have sent: the error, reject only, and no revision to report', () => {
    for (const revision of [undefined, null, 0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
      expect(checkMessage(message({ revision }))).toEqual({ handle: HANDLE, revision: null, kind: null, site: null, view: null, valid: false });
    }
    const { revision: _omitted, ...bare } = message();
    expect(checkMessage(bare)).toEqual({ handle: HANDLE, revision: null, kind: null, site: null, view: null, valid: false });
    // An invalid view keeps its message's revision: its fixed error is
    // reported for that delivery.
    expect(checkMessage(message({ view: null }))).toEqual({ handle: HANDLE, revision: 3, kind: null, site: null, view: null, valid: false });
  });

  test('no handle, or a malformed one: nothing to answer, nothing shown', () => {
    for (const handle of [undefined, '', 'F'.repeat(64), 'f'.repeat(63), 'g'.repeat(64), 7]) {
      expect(checkMessage(message({ handle }))).toBeNull();
    }
    expect(checkMessage(null)).toBeNull();
    expect(checkMessage([HANDLE])).toBeNull();
  });

  test('an unknown kind or field, a missing field, a wrong type or a value over its bound: the error, reject only', () => {
    const invalid = [
      message({ kind: 'eth.connect' }),
      message({ kind: 'toString' }),
      message({ kind: '__proto__' }),
      message({ guest: '3' }),
      message({ site: { key: SITE.key } }),
      message({ site: { ...SITE, extra: 'x' } }),
      message({ view: { ...VIEW, extra: 'x' } }),
      message({ view: { title: 'T', message: 'M' } }),
      message({ view: { ...VIEW, title: 7 } }),
      message({ view: { ...VIEW, title: 'x'.repeat(121) } }),
      message({ view: { ...VIEW, rows: [{ label: 'L', value: 'V', href: 'javascript:alert(1)' }] } }),
      message({ view: { ...VIEW, rows: Array.from({ length: 17 }, () => ({ label: 'L', value: 'V' })) } }),
      message({ view: { ...VIEW, rows: { 0: { label: 'L', value: 'V' }, length: 1 } } }),
      message({ view: null }),
      { ...message(), extra: true },
    ];
    for (const item of invalid) {
      expect(checkMessage(item)).toEqual({ handle: HANDLE, revision: 3, kind: null, site: null, view: null, valid: false });
    }
  });

  test('a view over 256 KiB is refused, even one each of whose fields is within its bound', () => {
    expect(MAX_VIEW_BYTES).toBe(256 * 1024);
    // A control character takes six bytes in JSON.
    const control = String.fromCharCode(1);
    const rows = Array.from({ length: 16 }, () => ({ label: 'L', value: control.repeat(4096) }));
    const view = { title: 'T', message: 'M', rows };
    expect(conforms(view, SCHEMAS['test.prompt'])).toBe(true);
    expect(checkMessage(message({ view })).valid).toBe(false);
    expect(checkMessage(message({ view: { ...view, rows: rows.slice(0, 8) } })).valid).toBe(true);
  });

  test('a record nested past its depth, a sparse list, or an object with a prototype: refused', () => {
    expect(conforms({}, { type: 'record', fields: {} }, 9)).toBe(false);
    const sparse = [];
    sparse[2] = { label: 'L', value: 'V' };
    expect(conforms(sparse, SCHEMAS['test.prompt'].fields.rows)).toBe(false);
    class Row {
      constructor() {
        this.label = 'L';
        this.value = 'V';
      }
    }
    expect(conforms([new Row()], SCHEMAS['test.prompt'].fields.rows)).toBe(false);
  });

});

describe('text, encoded for where it shows', () => {
  test('controls, bidi controls, zero-width and other invisible characters show as visible escapes', () => {
    const hostile = [
      ['202E', 0x202e],
      ['202D', 0x202d],
      ['2066', 0x2066],
      ['2069', 0x2069],
      ['200E', 0x200e],
      ['200F', 0x200f],
      ['061C', 0x061c],
      ['200B', 0x200b],
      ['200C', 0x200c],
      ['200D', 0x200d],
      ['2060', 0x2060],
      ['FEFF', 0xfeff],
      ['00AD', 0x00ad],
      ['034F', 0x034f],
      ['115F', 0x115f],
      ['3164', 0x3164],
      ['FE0F', 0xfe0f],
      ['2028', 0x2028],
      ['2029', 0x2029],
      ['0000', 0x0000],
      ['0009', 0x0009],
      ['000D', 0x000d],
      ['001B', 0x001b],
      ['007F', 0x007f],
      ['0085', 0x0085],
      ['E0041', 0xe0041],
      ['E000', 0xe000],
      ['E0100', 0xe0100],
    ];
    for (const [hex, code] of hostile) {
      expect(visible(`a${cp(code)}b`)).toBe(`a${escaped(hex)}b`);
    }
  });

  test('a lone surrogate shows as an escape too', () => {
    expect(visible(`a${String.fromCharCode(0xd800)}b`)).toBe(`a${escaped('D800')}b`);
  });

  test('a newline breaks the line only where a field is multi-line', () => {
    const nl = String.fromCharCode(10);
    expect(visible(`one${nl}two`)).toBe(`one${escaped('000A')}two`);
    expect(visible(`one${nl}two`, { multiline: true })).toBe(`one${nl}two`);
    expect(visible(`one${String.fromCharCode(13)}${nl}two`, { multiline: true })).toBe(`one${escaped('000D')}${nl}two`);
  });

  test('markup and ordinary text pass unchanged, as the text they are', () => {
    const markup = '<img src=x onerror="alert(1)"><script>x</script></style>javascript:alert(1)';
    expect(visible(markup)).toBe(markup);
    expect(visible('Ünïcödé 名前 🙂')).toBe('Ünïcödé 名前 🙂');
  });

  test('a long value is cut with a visible mark; the full text goes below', () => {
    expect(cut('x'.repeat(CUT_AT))).toEqual({ short: 'x'.repeat(CUT_AT), cut: false });
    const long = 'y'.repeat(CUT_AT + 40);
    expect(cut(long)).toEqual({ short: `${'y'.repeat(CUT_AT)} … (40 more characters below)`, cut: true });
    // Counted in characters, never splitting one.
    const emoji = cp(0x1f642).repeat(CUT_AT + 1);
    expect(cut(emoji).short.startsWith(cp(0x1f642).repeat(CUT_AT))).toBe(true);
    expect(cut(emoji)).toEqual({ short: `${cp(0x1f642).repeat(CUT_AT)} … (1 more characters below)`, cut: true });
    // Longer in code units than the cut, but not in characters: not cut.
    expect(cut(cp(0x1f642).repeat(CUT_AT))).toEqual({ short: cp(0x1f642).repeat(CUT_AT), cut: false });
  });

  test('a value megabytes long is cut and counted in place (APS-4)', () => {
    const hex = `0x${'ab'.repeat(1024 * 1024)}`;
    const started = Date.now();
    const { short, cut: isCut } = cut(hex);
    expect(isCut).toBe(true);
    expect(short).toBe(`${hex.slice(0, CUT_AT)} … (${hex.length - CUT_AT} more characters below)`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('a view in parts (APS-4)', () => {
  const { checkJoined } = kinds;
  const { MAX_PARTED_VIEW_BYTES } = core;
  const parted = (fields = {}) => ({ ...message({ view: null }), parts: { count: 2, length: 300000 }, ...fields });
  const send = (data) => ({
    account: { index: 0, name: 'Main', address: `0x${'1'.repeat(40)}`, type: 'mnemonic' },
    chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
    tx: { to: `0x${'2'.repeat(40)}`, value: '0', data },
    fee: { gasLimit: '21000', gasPrice: '1', estimate: '21000' },
    feeCheck: null,
    feeAskAgain: false,
    alwaysAllow: false,
  });
  const bigData = `0x${'cd'.repeat(300 * 1024)}`;

  test('a message whose view comes in parts: its other fields checked, its parts named, nothing valid yet', () => {
    expect(MAX_PARTED_VIEW_BYTES).toBe(4 * 1024 * 1024);
    expect(checkMessage(parted())).toEqual({
      handle: HANDLE,
      revision: 3,
      kind: 'test.prompt',
      site: SITE,
      view: null,
      valid: false,
      parts: { count: 2, length: 300000 },
    });
    const invalid = { handle: HANDLE, revision: 3, kind: null, site: null, view: null, valid: false };
    // Every part is asked for by the revision main sent (Codex, #1216).
    for (const revision of [undefined, 0, 1.5, '3']) {
      expect(checkMessage(parted({ revision }))).toEqual({ ...invalid, revision: null });
    }
    for (const item of [
      parted({ view: VIEW }),
      parted({ parts: { count: 0, length: 1 } }),
      parted({ parts: { count: 257, length: 300000 } }),
      parted({ parts: { count: 2, length: MAX_PARTED_VIEW_BYTES + 1 } }),
      parted({ parts: { count: 2, length: 300000, extra: 1 } }),
      // The revision is the message's own, not the parts' (Codex, #1216 r2).
      parted({ parts: { count: 2, length: 300000, revision: 3 } }),
      parted({ parts: null }),
      parted({ kind: 'nope' }),
      parted({ guest: null }),
      { ...parted(), extra: 1 },
    ]) {
      expect(checkMessage(item)).toEqual(invalid);
    }
  });

  test('the joined view is checked as any view, within 4 MiB rather than 256 KiB', () => {
    const view = send(bigData);
    const json = JSON.stringify(view);
    expect(json.length).toBeGreaterThan(MAX_VIEW_BYTES);
    const msg = { handle: HANDLE, revision: 1, guest: 3, kind: 'eth.send', site: SITE, view: null, parts: { count: 10, length: json.length } };
    // Within one message's bound it would be refused; joined, it fits.
    expect(checkMessage({ ...msg, parts: undefined, view }).valid).toBe(false);
    const joined = checkJoined(msg, json);
    expect(joined.valid).toBe(true);
    expect(joined.view.tx.data).toBe(bigData);
    expect(joined).not.toHaveProperty('parts');
    expect(joined.revision).toBe(1);
    // Still its kind's schema: a field off it, JSON that doesn't parse, or a
    // view over 4 MiB; each keeps the message's revision.
    const invalid = { handle: HANDLE, revision: 1, kind: null, site: null, view: null, valid: false };
    expect(checkJoined(msg, JSON.stringify({ ...view, extra: '<b>' }))).toEqual(invalid);
    expect(checkJoined(msg, json.slice(0, -1))).toEqual(invalid);
    expect(checkJoined(msg, JSON.stringify(send(`0x${'ab'.repeat(2 * 1024 * 1024)}`)))).toEqual(invalid);
    // A "__proto__" key in the JSON is an own, unknown field: refused.
    expect(checkJoined(msg, '{"__proto__":{"x":1},' + json.slice(1))).toEqual(invalid);
  });
});

describe('the input gate', () => {
  function gate() {
    let clock = 0;
    const g = createInputGate({ now: () => clock });
    return { g, at: (ms) => (clock = ms) };
  }
  const clickOn = (g, control, at, setAt, press = 'pointerdown') => {
    setAt(at);
    const admitted = g.admit(press, {}) && g.admit('click', {});
    return admitted && g.activates(control, { detail: 1, isTrusted: true });
  };

  test('a click at 0 ms and at 499 ms does nothing; at 500 ms it counts', () => {
    expect(INPUT_DELAY_MS).toBe(500);
    for (const [ms, counts] of [
      [0, false],
      [499, false],
      [500, true],
    ]) {
      const { g, at } = gate();
      at(1000);
      g.arm();
      expect(clickOn(g, 'approve', 1000 + ms, at)).toBe(counts);
    }
  });

  test('a key at 0 ms and at 499 ms does nothing; at 500 ms Space on a focused Approve counts', () => {
    for (const [ms, counts] of [
      [0, false],
      [499, false],
      [500, true],
    ]) {
      const { g, at } = gate();
      at(1000);
      g.arm();
      at(1000 + ms);
      const down = g.admit('keydown', { key: ' ', code: 'Space', target: 'approve' });
      const up = g.admit('keyup', { key: ' ', code: 'Space', target: 'approve' });
      expect(down && up && g.activates('approve', { detail: 0, isTrusted: true })).toBe(counts);
    }
  });

  test('a press inside the delay doesn\'t count when it is released after it', () => {
    const { g, at } = gate();
    at(0);
    g.arm();
    at(499);
    expect(g.admit('pointerdown', {})).toBe(false);
    at(600);
    expect(g.admit('click', {})).toBe(true);
    expect(g.activates('approve', { detail: 1, isTrusted: true })).toBe(false);
    // Space held down from inside the delay.
    at(1000);
    g.arm();
    at(1200);
    expect(g.admit('keydown', { key: ' ', target: 'approve' })).toBe(false);
    at(1600);
    expect(g.admit('keydown', { key: ' ', target: 'approve', repeat: true })).toBe(true);
    expect(g.admit('keyup', { key: ' ', target: 'approve' })).toBe(true);
    expect(g.activates('approve', { detail: 0, isTrusted: true })).toBe(false);
  });

  test('the delay starts again with every arm: a new prompt, a changed one, shown again, moved', () => {
    const { g, at } = gate();
    at(0);
    g.arm();
    for (const restart of [1000, 2000, 3000, 4000]) {
      at(restart);
      g.arm();
      expect(clickOn(g, 'approve', restart + 499, at)).toBe(false);
      expect(clickOn(g, 'approve', restart + 500, at)).toBe(true);
    }
  });

  test('a press before a re-arm is forgotten by it', () => {
    const { g, at } = gate();
    at(0);
    g.arm();
    at(600);
    expect(g.admit('pointerdown', {})).toBe(true);
    g.arm();
    at(1200);
    expect(g.admit('click', {})).toBe(true);
    expect(g.activates('approve', { detail: 1, isTrusted: true })).toBe(false);
  });

  test('nothing is armed until a prompt shows; disarmed, nothing counts', () => {
    const { g, at } = gate();
    at(10_000);
    expect(g.isOpen()).toBe(false);
    expect(g.admit('pointerdown', {})).toBe(false);
    g.arm();
    at(20_000);
    expect(g.isOpen()).toBe(true);
    g.disarm();
    expect(clickOn(g, 'approve', 30_000, at)).toBe(false);
  });

  test('Enter never approves, on any control, at any time', () => {
    const { g, at } = gate();
    at(0);
    g.arm();
    at(5000);
    for (const target of ['approve', 'reject', 'other']) {
      for (const [key, code] of [
        ['Enter', 'Enter'],
        ['Enter', 'NumpadEnter'],
        ['Process', 'Enter'],
      ]) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
          expect(g.admit(type, { key, code, target })).toBe(false);
        }
        // Whatever activation followed would have no Space press behind it.
        expect(g.activates('approve', { detail: 0, isTrusted: true })).toBe(false);
      }
    }
  });

  test('a keyboard activation counts only from Space on that very control', () => {
    const { g, at } = gate();
    at(0);
    g.arm();
    at(1000);
    g.admit('keydown', { key: ' ', target: 'reject' });
    expect(g.activates('approve', { detail: 0, isTrusted: true })).toBe(false);
    g.admit('keydown', { key: 'a', target: 'approve' });
    expect(g.activates('approve', { detail: 0, isTrusted: true })).toBe(false);
    g.admit('keydown', { key: ' ', target: 'approve' });
    expect(g.activates('approve', { detail: 1, isTrusted: true })).toBe(false);
    g.admit('pointerdown', {});
    expect(g.activates('approve', { detail: 0, isTrusted: true })).toBe(false);
  });

  test('a synthetic event never counts', () => {
    const { g, at } = gate();
    at(0);
    g.arm();
    at(1000);
    g.admit('pointerdown', {});
    expect(g.activates('approve', { detail: 1, isTrusted: false })).toBe(false);
  });
});

describe('the document\'s files', () => {
  const html = fs.readFileSync(path.join(__dirname, 'approvals.html'), 'utf8');
  const script = ['approvals-core.js', 'approvals-kinds.js', 'approvals.js']
    .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'))
    .join('\n');

  test('no inline script, style or handler; only its own files', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.map((m) => m[1].trim())).toEqual([
      'src="./approvals-core.js"',
      'src="./approvals-kinds.js"',
      'src="./approvals.js"',
    ]);
    expect(scripts.every((m) => m[2].trim() === '')).toBe(true);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect([...html.matchAll(/<link\b[^>]*href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '../styles/variables.css',
      './approvals.css',
    ]);
    expect(html).not.toMatch(/<(a|form|area|iframe|object|img|embed)\b/);
  });

  test('no markup sink, no code from strings, no URL or style from a value', () => {
    for (const sink of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
      'setAttribute(\'href',
      'setAttribute(\'src',
      'setAttribute(\'style',
      '.style.',
      'location',
      'window.open',
      'createElement(\'a\')',
      'createElement(\'img\')',
    ]) {
      expect(script).not.toContain(sink);
    }
  });

  test('no default button: both are type="button", and Reject comes first', () => {
    expect(html).toMatch(/<button type="button" id="reject"[^>]*>Reject<\/button>\s*<button type="button" id="approve"[^>]*>Approve<\/button>/);
    expect(html).not.toMatch(/autofocus/);
  });
});
