/**
 * Radicle's repair in the Nodes menu (radicle-repair-ui.js; freedom-core
 * design 0008, "The deadline" and "The escape", Main's view): the warning's
 * text, Remove behind its confirmation and bound to the entry main showed,
 * "still repairing" with Retry, and an untrusted name that never becomes
 * markup.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const OTHER_RID = 'rad:z4V1sjrXqjvFdnCUbxPFqd5p4DtH5';
const QID = '0123456789abcdef0123456789abcdef';
const OTHER_QID = 'fedcba9876543210fedcba9876543210';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const entry = (overrides = {}) => ({
  rid: RID,
  qid: QID,
  kind: 'cache',
  step: 'cache',
  unit: null,
  name: 'heartwood',
  ...overrides,
});

async function load({ removeResult = { success: true, removed: true } } = {}) {
  jest.resetModules();
  const elements = {
    'radicle-repair': createElement('div'),
    'radicle-repairing-message': createElement('p'),
    'radicle-repair-retry': createElement('button'),
    'radicle-quarantine-list': createElement('ul'),
    'radicle-quarantine-more': createElement('p'),
  };
  for (const el of Object.values(elements)) el.hidden = true;
  const document = createDocument({ elementsById: elements });
  let onRepair = null;
  const radicle = {
    start: jest.fn(async () => ({ status: 'starting', error: null })),
    removeQuarantined: jest.fn(async () => removeResult),
    onRepairUpdate: jest.fn((handler) => {
      onRepair = handler;
    }),
  };
  global.window = { radicle };
  global.document = document;
  const debug = { pushDebug: jest.fn() };
  jest.doMock('./debug.js', () => debug);
  const mod = await import('./radicle-repair-ui.js');
  mod.initRadicleRepairUi();
  return {
    mod,
    radicle,
    debug,
    document,
    elements,
    send: (snapshot) => onRepair(snapshot),
    list: () => elements['radicle-quarantine-list'],
    items: () => elements['radicle-quarantine-list'].children,
  };
}

/** Every element under `root`, `root` included. */
const walk = (root) => [root, ...root.children.flatMap(walk)];

/** An entry's parts, by their classes. */
const parts = (item) => ({
  title: item.querySelector('.radicle-repair-message'),
  detail: item.querySelector('.radicle-quarantine-detail'),
  remove: item.children.find(
    (c) => c.classList.contains('radicle-quarantine-remove') && c.tagName === 'BUTTON'
  ),
  confirm: item.querySelector('.radicle-quarantine-confirm'),
  warning: item.querySelector('.radicle-quarantine-warning'),
  confirmRemove: item.querySelector('.radicle-quarantine-confirm-remove'),
  cancel: item
    .querySelector('.radicle-quarantine-actions')
    .children.find((c) => c.textContent === 'Cancel'),
  error: item.querySelector('.radicle-quarantine-error'),
});

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
  jest.restoreAllMocks();
});

describe('the warning', () => {
  test('"Radicle couldn\'t repair <name>", with the kind and the step, and Remove', async () => {
    const ctx = await load();
    ctx.send({
      repairing: false,
      count: 2,
      entries: [
        entry(),
        entry({
          rid: OTHER_RID,
          qid: OTHER_QID,
          kind: 'namespace',
          step: 'namespaces',
          name: null,
        }),
      ],
    });

    expect(ctx.elements['radicle-repair'].hidden).toBe(false);
    expect(ctx.list().hidden).toBe(false);
    expect(ctx.items()).toHaveLength(2);
    const [first, second] = ctx.items().map(parts);
    expect(first.title.textContent).toBe("Radicle couldn't repair heartwood");
    expect(first.title.getAttribute('title')).toBe(RID);
    expect(first.detail.textContent).toBe('Kind: issue and patch cache · Step: cache rebuild');
    expect(first.remove.textContent).toBe('Remove');
    expect(first.remove.hidden).toBe(false);
    expect(first.confirm.hidden).toBe(true);
    // No name: the repository's ID.
    expect(second.title.textContent).toBe(`Radicle couldn't repair ${OTHER_RID}`);
    expect(second.detail.textContent).toBe(
      'Kind: signed references · Step: signed reference check'
    );
    // Nothing more than shown.
    expect(ctx.elements['radicle-quarantine-more'].hidden).toBe(true);
    expect(ctx.elements['radicle-repairing-message'].hidden).toBe(true);
    expect(ctx.elements['radicle-repair-retry'].hidden).toBe(true);
  });

  test("a kind or step it doesn't know shows as the service wrote it", async () => {
    const ctx = await load();
    ctx.send({ repairing: false, count: 1, entries: [entry({ kind: 'blobs', step: 'objects' })] });
    expect(parts(ctx.items()[0]).detail.textContent).toBe('Kind: blobs · Step: objects');
  });

  test("more than main holds: how many more Radicle couldn't repair", async () => {
    const ctx = await load();
    ctx.send({ repairing: false, count: 4097, entries: [entry()] });
    expect(ctx.elements['radicle-quarantine-more'].hidden).toBe(false);
    expect(ctx.elements['radicle-quarantine-more'].textContent).toBe(
      "Radicle couldn't repair 4096 more repositories"
    );
    ctx.send({ repairing: false, count: 2, entries: [entry()] });
    expect(ctx.elements['radicle-quarantine-more'].textContent).toBe(
      "Radicle couldn't repair 1 more repository"
    );
  });

  test('nothing to show: the section is hidden', async () => {
    const ctx = await load();
    ctx.send({ repairing: false, count: 1, entries: [entry()] });
    ctx.send({ repairing: false, count: 0, entries: [] });
    expect(ctx.elements['radicle-repair'].hidden).toBe(true);
    expect(ctx.list().hidden).toBe(true);
    expect(ctx.items()).toHaveLength(0);
    ctx.send(null);
    expect(ctx.elements['radicle-repair'].hidden).toBe(true);
  });

  test('malformed entries are left out', async () => {
    const ctx = await load();
    ctx.send({
      repairing: false,
      count: 3,
      entries: [entry(), entry({ qid: 7 }), entry({ name: { toString: () => 'x' } }), null],
    });
    expect(ctx.items()).toHaveLength(1);
  });
});

describe('names are untrusted: the DOM is built, never parsed', () => {
  test('markup in a name is text, and no element is given markup', async () => {
    const ctx = await load();
    const name = '<img src=x onerror="alert(1)"><b>repo</b>';
    ctx.send({ repairing: false, count: 1, entries: [entry({ name })] });
    const item = ctx.items()[0];
    const { title, warning } = parts(item);
    expect(title.textContent).toBe(`Radicle couldn't repair ${name}`);
    expect(warning.textContent).toContain(name);
    // Only the entry's own elements were made, and none was given markup.
    const made = ctx.document.createElement.mock.calls.map(([tag]) => tag);
    expect(new Set(made)).toEqual(new Set(['li', 'p', 'button', 'div']));
    for (const el of walk(ctx.list())) expect(el.innerHTML).toBe('');
  });

  test('control and bidi characters are dropped; a long name is cut with an ellipsis', async () => {
    const ctx = await load();
    // U+202E (right-to-left override), U+2066 (isolate), a NUL and a newline,
    // made at runtime so no tool decodes them on the way.
    const rlo = String.fromCodePoint(0x202e);
    const isolate = String.fromCodePoint(0x2066);
    const nul = String.fromCodePoint(0);
    ctx.send({
      repairing: false,
      count: 2,
      entries: [
        entry({ name: `evil${rlo}gnp.exe${isolate}${nul}\nname` }),
        entry({ rid: OTHER_RID, qid: OTHER_QID, name: 'n'.repeat(100) }),
      ],
    });
    const [first, second] = ctx.items().map(parts);
    expect(first.title.textContent).toBe("Radicle couldn't repair evilgnp.exe name");
    expect(second.title.textContent).toBe(`Radicle couldn't repair ${'n'.repeat(63)}…`);
    // A name of only such characters is no name.
    ctx.send({ repairing: false, count: 1, entries: [entry({ name: `${rlo}${nul} ` })] });
    expect(parts(ctx.items()[0]).title.textContent).toBe(`Radicle couldn't repair ${RID}`);
  });

  test('the module never writes markup', () => {
    const source = fs.readFileSync(path.join(__dirname, 'radicle-repair-ui.js'), 'utf8');
    expect(source).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment/
    );
  });
});

describe('Remove: asked first, then bound to the entry main showed', () => {
  test('Remove asks first, naming what it deletes; Cancel sends nothing', async () => {
    const ctx = await load();
    ctx.send({ repairing: false, count: 1, entries: [entry()] });
    const p = parts(ctx.items()[0]);

    p.remove.dispatch('click');
    expect(p.remove.hidden).toBe(true);
    expect(p.confirm.hidden).toBe(false);
    expect(p.warning.textContent).toBe(
      "Remove deletes the local copy of heartwood, including your issues and comments in it that haven't been shared."
    );
    expect(p.confirmRemove.textContent).toBe('Remove');
    // The clicked button stays in the menu, so the menu's own click handler
    // sees a click inside it.
    expect(ctx.list().contains(p.remove)).toBe(true);

    p.cancel.dispatch('click');
    expect(p.confirm.hidden).toBe(true);
    expect(p.remove.hidden).toBe(false);
    expect(ctx.radicle.removeQuarantined).not.toHaveBeenCalled();
  });

  test('the confirmation sends the rid and qid main showed for that entry, and no other', async () => {
    const ctx = await load();
    ctx.send({
      repairing: false,
      count: 2,
      entries: [entry(), entry({ rid: OTHER_RID, qid: OTHER_QID, name: 'radicle-httpd' })],
    });
    const second = parts(ctx.items()[1]);
    second.remove.dispatch('click');
    second.confirmRemove.dispatch('click');
    expect(second.confirmRemove.disabled).toBe(true);
    expect(second.cancel.disabled).toBe(true);
    // A second click while it runs sends nothing more.
    second.confirmRemove.dispatch('click');
    await flush();
    expect(ctx.radicle.removeQuarantined).toHaveBeenCalledTimes(1);
    expect(ctx.radicle.removeQuarantined).toHaveBeenCalledWith(OTHER_RID, OTHER_QID);
  });

  test('a confirmation in progress survives a new state from main for the same entry', async () => {
    const ctx = await load();
    const snapshot = { repairing: false, count: 1, entries: [entry()] };
    ctx.send(snapshot);
    parts(ctx.items()[0]).remove.dispatch('click');
    ctx.send({ ...snapshot });
    const p = parts(ctx.items()[0]);
    expect(p.confirm.hidden).toBe(false);
    expect(p.remove.hidden).toBe(true);
    // A new qid for the repository is another record: asked afresh.
    ctx.send({ repairing: false, count: 1, entries: [entry({ qid: OTHER_QID })] });
    expect(parts(ctx.items()[0]).confirm.hidden).toBe(true);
  });

  test("a removal that fails shows main's message on its entry", async () => {
    const ctx = await load({
      removeResult: {
        success: false,
        error: {
          code: 'REMOVE_FAILED',
          message: 'the storage: its directory could not be flushed',
        },
      },
    });
    ctx.send({ repairing: false, count: 1, entries: [entry()] });
    const p = parts(ctx.items()[0]);
    p.remove.dispatch('click');
    p.confirmRemove.dispatch('click');
    await flush();
    const after = parts(ctx.items()[0]);
    expect(after.error.hidden).toBe(false);
    expect(after.error.textContent).toBe('the storage: its directory could not be flushed');
    // Back to Remove, for a retry with the same qid.
    expect(after.remove.hidden).toBe(false);
    expect(after.confirm.hidden).toBe(true);
  });

  test('not_quarantined shows no error: main lists the quarantine again', async () => {
    const ctx = await load({
      removeResult: { success: false, error: { code: 'NOT_QUARANTINED', message: 'gone' } },
    });
    ctx.send({ repairing: false, count: 1, entries: [entry()] });
    const p = parts(ctx.items()[0]);
    p.remove.dispatch('click');
    p.confirmRemove.dispatch('click');
    await flush();
    expect(parts(ctx.items()[0]).error.hidden).toBe(true);
  });
});

describe('"still repairing", with Retry', () => {
  test("the message and Retry show while main says so; Retry is the node's start", async () => {
    const ctx = await load();
    ctx.send({ repairing: true, count: 0, entries: [] });
    expect(ctx.elements['radicle-repair'].hidden).toBe(false);
    expect(ctx.elements['radicle-repairing-message'].hidden).toBe(false);
    expect(ctx.elements['radicle-repair-retry'].hidden).toBe(false);
    expect(ctx.mod.REPAIRING_TEXT).toBe('Radicle is still repairing its data');

    ctx.elements['radicle-repair-retry'].dispatch('click');
    expect(ctx.elements['radicle-repair-retry'].disabled).toBe(true);
    ctx.elements['radicle-repair-retry'].dispatch('click');
    await flush();
    expect(ctx.radicle.start).toHaveBeenCalledTimes(1);
    expect(ctx.elements['radicle-repair-retry'].disabled).toBe(false);

    ctx.send({ repairing: false, count: 0, entries: [] });
    expect(ctx.elements['radicle-repair'].hidden).toBe(true);
    expect(ctx.elements['radicle-repair-retry'].hidden).toBe(true);
  });

  test("the markup's message is the module's text", () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const match = html.match(/id="radicle-repairing-message"[^>]*>\s*([^<]*?)\s*<\/p>/);
    expect(match?.[1]).toBe('Radicle is still repairing its data');
  });
});
