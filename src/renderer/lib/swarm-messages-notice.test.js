/**
 * Question 4's notice in the chrome (freedom-core design 0015, Messaging;
 * SWM-7's PR 7.5): main sends one per site per session, already worded
 * (src/main/swarm/subscription-route-notices.js); the toast shows each
 * sentence until dismissed, above the other corner toasts.
 */

const fs = require('fs');
const path = require('path');
const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const originalWindow = global.window;
const originalDocument = global.document;

// The sentences the toast shows, one block each.
const shown = (text) => text.children.map((line) => {
  expect(line.className).toBe('swarm-messages-notice-line');
  return line.textContent;
});

const PROXY_NOTICE =
  'Live messages from myapp.eth are off while your proxy is on: they would go around it to your external Swarm node';
const TOR_NOTICE =
  'Live messages from chat.eth are off while Tor is on: they would go around it to your external Swarm node';

async function load({ api = true } = {}) {
  jest.resetModules();
  const notice = createElement('div');
  notice.hidden = true; // as the markup ships it
  const text = createElement('span');
  const close = createElement('button');
  const updateToast = createElement('div');
  updateToast.hidden = true;
  const myotisNotice = createElement('div');
  myotisNotice.hidden = true;
  global.document = createDocument({
    elementsById: {
      'swarm-messages-notice': notice,
      'swarm-messages-notice-text': text,
      'swarm-messages-notice-close': close,
      'update-toast': updateToast,
      'myotis-recovery-notice': myotisNotice,
    },
  });
  let onNotice = null;
  global.window = {
    innerHeight: 900,
    addEventListener: jest.fn(),
    ...(api ? { swarmMessages: { onNotice: jest.fn((handler) => (onNotice = handler)) } } : {}),
  };
  const mod = await import('./swarm-messages-notice.js');
  mod.initSwarmMessagesNotice();
  return { mod, notice, text, close, updateToast, myotisNotice, send: (payload) => onNotice(payload) };
}

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
});

describe('the live messages notice', () => {
  test('the markup: a corner toast like the Myotis notice, hidden until main sends one', () => {
    const start = HTML.indexOf('id="swarm-messages-notice"');
    expect(start).toBeGreaterThan(0);
    const markup = HTML.slice(HTML.lastIndexOf('<div', start), HTML.indexOf('</div>\n    </div>', start));
    expect(markup).toMatch(/class="update-toast" role="status" hidden/);
    expect(markup).toContain('id="swarm-messages-notice-text"');
    expect(markup).toMatch(/id="swarm-messages-notice-close"\s+class="update-toast-close"/);
    expect(markup).toContain('aria-label="Dismiss live messages notice"');
  });

  test("shows main's sentence, as it was sent", async () => {
    const ctx = await load();
    expect(ctx.notice.hidden).toBe(true);
    ctx.send({ site: 'myapp.eth', text: PROXY_NOTICE });
    expect(ctx.notice.hidden).toBe(false);
    expect(shown(ctx.text)).toEqual([PROXY_NOTICE]);
  });

  test('a second site adds its sentence, a repeat adds nothing, and dismissing clears them', async () => {
    const ctx = await load();
    ctx.send({ site: 'myapp.eth', text: PROXY_NOTICE });
    ctx.send({ site: 'chat.eth', text: TOR_NOTICE });
    ctx.send({ site: 'chat.eth', text: TOR_NOTICE });
    expect(shown(ctx.text)).toEqual([PROXY_NOTICE, TOR_NOTICE]);
    ctx.close.dispatch('click');
    expect(ctx.notice.hidden).toBe(true);
    expect(shown(ctx.text)).toEqual([]);
    // A later notice shows on its own.
    ctx.send({ site: 'other.eth', text: 'Live messages from other.eth are off' });
    expect(shown(ctx.text)).toEqual(['Live messages from other.eth are off']);
  });

  test('nothing for an empty or malformed notice', async () => {
    const ctx = await load();
    for (const bad of [null, undefined, {}, { text: '' }, { text: '   ' }, { text: 7 }]) ctx.send(bad);
    expect(ctx.notice.hidden).toBe(true);
  });

  test('sits above the other corner toasts while they show', async () => {
    const ctx = await load();
    ctx.send({ site: 'myapp.eth', text: PROXY_NOTICE });
    expect(ctx.notice.style.bottom).toBe('16px');
    ctx.dismiss = () => ctx.close.dispatch('click');
    ctx.dismiss();
    // The Myotis notice is up (88 px from the bottom, 60 px tall).
    ctx.myotisNotice.hidden = false;
    ctx.myotisNotice.setRect({ top: 900 - 88 - 60, height: 60 });
    ctx.send({ site: 'myapp.eth', text: PROXY_NOTICE });
    expect(ctx.notice.style.bottom).toBe(`${88 + 60 + 8}px`);
    ctx.dismiss();
    // Only the update toast (16 px, 48 px tall).
    ctx.myotisNotice.hidden = true;
    ctx.updateToast.hidden = false;
    ctx.updateToast.setRect({ top: 900 - 16 - 48, height: 48 });
    ctx.send({ site: 'myapp.eth', text: PROXY_NOTICE });
    expect(ctx.notice.style.bottom).toBe(`${16 + 48 + 8}px`);
  });

  test('a chrome with no such API shows nothing and fails nothing', async () => {
    const ctx = await load({ api: false });
    expect(ctx.notice.hidden).toBe(true);
  });
});
