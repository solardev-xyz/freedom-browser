/**
 * Test-only harness: run an internal page's classic script
 * (`src/renderer/pages/scripts/<page>.js`) in a `vm` context against a small
 * fake DOM. Not loaded by any page, and kept under `test/helpers/` (outside
 * `src/**`) so electron-builder never packages it.
 *
 * The fake DOM is deliberately *not* an HTML parser. `innerHTML` assignments
 * are recorded in `document.htmlWrites` and turned into an opaque text blob,
 * so a spec can assert both what the user sees (`textContent`) and that no
 * site-controlled string ever went through an HTML sink (#432) — a renderer
 * that interpolated a title into markup shows up in `htmlWrites`, however well
 * it escaped it.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'src', 'renderer', 'pages', 'scripts');

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
  }

  get textContent() {
    return this.data;
  }
}

const dataToCamel = (attr) => attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.classSet = new Set();
    this.value = '';
    this.title = '';
    this.id = '';
    this.rawHtml = null;
    const el = this;
    this.classList = {
      add: (...names) => names.forEach((n) => el.classSet.add(n)),
      remove: (...names) => names.forEach((n) => el.classSet.delete(n)),
      contains: (n) => el.classSet.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !el.classSet.has(n) : Boolean(force);
        if (on) el.classSet.add(n);
        else el.classSet.delete(n);
        return on;
      },
    };
  }

  get className() {
    return [...this.classSet].join(' ');
  }

  set className(value) {
    this.classSet = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get textContent() {
    if (this.rawHtml !== null) return this.rawHtml.replace(/<[^>]*>/g, '');
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.rawHtml = null;
    this.detachChildren();
    const text = value == null ? '' : String(value);
    if (text) this.appendChild(new FakeText(text));
  }

  get innerHTML() {
    return this.rawHtml ?? '';
  }

  set innerHTML(value) {
    const html = String(value);
    this.ownerDocument.htmlWrites.push(html);
    this.detachChildren();
    this.rawHtml = html;
  }

  insertAdjacentHTML(_position, html) {
    this.ownerDocument.htmlWrites.push(String(html));
    this.rawHtml = (this.rawHtml ?? '') + String(html);
  }

  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[dataToCamel(name)] = String(value);
    else if (name === 'class') this.className = value;
    else this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[dataToCamel(name)] ?? null;
    if (name === 'class') return this.className;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  detachChildren() {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
  }

  appendChild(node) {
    if (node instanceof FakeElement && node.tagName === '#FRAGMENT') {
      for (const child of [...node.childNodes]) this.appendChild(child);
      node.childNodes = [];
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }

  append(...nodes) {
    for (const node of nodes) {
      this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
    }
  }

  replaceChildren(...nodes) {
    this.rawHtml = null;
    this.detachChildren();
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = parent;
    parent.childNodes.splice(index, 1, node);
    this.parentNode = null;
  }

  // Compound selectors only: `tag`, `.class`, `[attr]`, `[attr="value"]`.
  matches(selector) {
    const parts = selector.match(/^[a-z]+|\.[\w-]+|\[[^\]]+\]/gi) || [];
    if (parts.join('') !== selector) throw new Error(`fake DOM: unsupported selector ${selector}`);
    return parts.every((part) => {
      if (part[0] === '.') return this.classSet.has(part.slice(1));
      if (part[0] === '[') {
        const [, name, value] = part.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
        const actual = this.getAttribute(name);
        return value === undefined ? actual !== null : actual === value;
      }
      return this.tagName === part.toUpperCase();
    });
  }

  descendants() {
    const out = [];
    for (const child of this.children) out.push(child, ...child.descendants());
    return out;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((el) => el.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el;
    return null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  // Dispatch a bubbling event from this element; resolves once every
  // (possibly async) handler has settled.
  async fire(type) {
    let stopped = false;
    const event = { type, target: this, stopPropagation: () => (stopped = true) };
    for (let el = this; el && !stopped; el = el.parentElement) {
      event.currentTarget = el;
      for (const handler of el.listeners.get(type) || []) await handler(event);
    }
  }
}

class FakeDocument {
  constructor(ids) {
    this.htmlWrites = [];
    this.byId = new Map();
    for (const [id, tag] of Object.entries(ids)) {
      const el = this.createElement(tag);
      el.id = id;
      this.byId.set(id, el);
    }
  }

  createElement(tag) {
    return new FakeElement(tag, this);
  }

  createTextNode(text) {
    return new FakeText(text);
  }

  createDocumentFragment() {
    return new FakeElement('#fragment', this);
  }

  getElementById(id) {
    return this.byId.get(id) || null;
  }
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run `scripts/<page>.js` against a fake document holding `ids`
 * (`{ id: tagName }`) and the given `freedomAPI`. Returns the document, the
 * elements by id, the queued timers and the context.
 */
async function runPageScript(page, { ids, freedomAPI, confirm = () => true, storage = {} }) {
  const document = new FakeDocument(ids);
  const timers = [];
  const context = {
    document,
    freedomAPI,
    window: { freedomAPI, location: { href: `file:///pages/${page}.html`, search: '' } },
    localStorage: {
      getItem: (key) => (key in storage ? storage[key] : null),
      setItem: (key, value) => (storage[key] = String(value)),
    },
    confirm,
    console: { error: () => {}, warn: () => {}, log: () => {} },
    setTimeout: (handler) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimeout: () => {},
    URL,
  };
  const source = fs.readFileSync(path.join(SCRIPTS_DIR, `${page}.js`), 'utf8');
  vm.runInNewContext(source, context, { filename: `scripts/${page}.js` });
  await flush();
  const elements = Object.fromEntries([...document.byId].map(([id, el]) => [id, el]));
  return { document, elements, timers, context, flush };
}

module.exports = { runPageScript, flush, FakeElement };
