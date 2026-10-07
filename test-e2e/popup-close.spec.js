// Pop-ups can always be closed, and the blocker scores popupcheck.com's
// full 100 (#580).
//
// The fixture below copies https://www.popupcheck.com/'s test (its
// `PopupTestEngine` script and `/popup-window.html`, read 2026-10-07) without
// depending on the live site: every popup is a sized, *named*
// `window.open('/popup-window.html?test=<id>', 'pc_<id>_<ts>',
// 'width=420,height=260,left=140,top=140')` — Chromium's `new-window`
// disposition, so Freedom opens it as a new window — the opener calls
// `handle.close()` on it after 1.2 s, the popup reports itself over
// `BroadcastChannel('popupcheck-tests')` and calls `window.close()` on itself
// after 1.4 s. A case counts as "opened" when that report arrives within 2 s.
//
// The bug: Electron destroys a <webview>'s guest when its page calls
// `window.close()` but leaves the element (and Freedom's tab) in place. Every
// method on that element then throws, `closeTab()` threw on its first one,
// and the tab — and the popup window it was alone in — stayed up for good:
// the tab's close button, Cmd/Ctrl+W and "closing the last tab closes the
// window" all go through `closeTab()`.
//
// Opener `close()`: Freedom never hands the page a window handle — its
// window-open handler denies Chromium's own popup and reopens the URL as a
// Freedom tab or window — so `window.open` returns null and the opener has
// nothing to call `close()` on. The spec pins that (`handle: false`), and that
// the popup still goes away by its own `window.close()`.
//
// Real input goes to the guest's own webContents (`sendInputEvent`), which is
// what Chromium marks trusted and what the popup blocker's gesture tracker
// sees; a DOM `dispatchEvent` click is the "synthetic" case.

const { execFileSync } = require('child_process');
const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');
const { evalInWebview } = require('./permission-fixtures');

const SITE = `bzz://${SAMPLE_BZZ_HASH}`;
const PAGE_URL = `${SITE}/`;
const POPUP_URL = `${SITE}/popup-window.html`;
const SHOT_DIR = process.env.TMPDIR || '/tmp';

// popupcheck.com's /popup-window.html. `stay=1` (not on the real site) leaves
// out the self-close, so a popup can be closed by the user instead.
const POPUP_BODY = `<!doctype html><title>Test window | PopupCheck</title>
<p><strong>PopupCheck test window</strong></p><p id="who">popup</p>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var test = params.get('test') || 'unknown';
  document.getElementById('who').textContent = 'popup ' + test;
  var message = { test: test, opened: true };
  if (test === 'chain') {
    // This window has no user activation of its own, so this must be blocked.
    var second = null;
    try { second = window.open('/popup-window.html?test=chain2', 'pc_chain2', 'width=200,height=150'); } catch (e) {}
    message.chain = second ? 'opened' : 'blocked';
    if (second) { setTimeout(function () { try { second.close(); } catch (e) {} }, 900); }
  }
  try { new BroadcastChannel('popupcheck-tests').postMessage(message); } catch (e) {}
  if (params.get('stay') !== '1') setTimeout(function () { window.close(); }, 1400);
})();
</script>`;

// popupcheck.com's engine, same cases, timings and scoring.
const PAGE_BODY = `<!doctype html><title>PopupCheck fixture</title>
<style>
  button, a { display: block; font-size: 22px; margin: 10px; }
  #hover-box { margin: 10px; padding: 20px; border: 1px dashed #888; }
</style>
<button id="start-btn">Start the popup test</button>
<a id="link-test" href="/popup-window.html?test=linkblank" target="_blank" hidden>Open the test link</a>
<button id="delayed-btn" hidden>Click here, then wait</button>
<button id="chain-btn">Open a popup that opens another</button>
<button id="stay-btn">Open a popup that stays</button>
<div id="hover-box">rest your mouse here <span id="hover-result"></span></div>
<ul id="test-list">
  <li data-test="clicked"><span class="row-result"></span></li>
  <li data-test="unsolicited"><span class="row-result"></span></li>
  <li data-test="timed"><span class="row-result"></span></li>
  <li data-test="synthetic"><span class="row-result"></span></li>
  <li data-test="popunder"><span class="row-result"></span></li>
  <li data-test="linkblank"><span class="row-result"></span></li>
  <li data-test="delayed"><span class="row-result"></span></li>
</ul>
<p>score <span id="score-num"></span></p>
<p id="chain-result"></p>
<div id="out">ready</div>
<script>
const TESTS = [
  { id: 'clicked', points: 15, scoreWhen: 'opened' },
  { id: 'unsolicited', points: 20, scoreWhen: 'blocked' },
  { id: 'timed', points: 15, scoreWhen: 'blocked' },
  { id: 'synthetic', points: 15, scoreWhen: 'blocked' },
  { id: 'popunder', points: 15, scoreWhen: 'blocked' },
  { id: 'linkblank', points: 10, scoreWhen: 'opened' },
  { id: 'delayed', points: 10, scoreWhen: 'blocked' },
];
const $ = (id) => document.getElementById(id);
const seen = new Set();
const waiting = new Map();
window.__handles = {};
window.__chain = null;
let score = 0;
const channel = new BroadcastChannel('popupcheck-tests');
channel.onmessage = (e) => {
  if (!e.data || !e.data.test) return;
  const id = String(e.data.test);
  seen.add(id);
  if (id === 'chain') { window.__chain = e.data.chain; $('chain-result').textContent = 'chain ' + e.data.chain; }
  const done = waiting.get(id);
  if (done) { waiting.delete(id); done('opened'); }
};
function openPopup(id, features) {
  let handle = null;
  try {
    handle = window.open('/popup-window.html?test=' + id, 'pc_' + id + '_' + Date.now(),
      features || 'width=420,height=260,left=140,top=140');
  } catch { handle = null; }
  window.__handles[id] = !!handle;
  if (handle) setTimeout(() => { try { handle.close(); } catch {} }, 1200);
  return handle;
}
function verdict(id) {
  return new Promise((resolve) => {
    if (seen.has(id)) return resolve('opened');
    const timer = setTimeout(() => { waiting.delete(id); resolve(seen.has(id) ? 'opened' : 'blocked'); }, 2000);
    waiting.set(id, (v) => { clearTimeout(timer); resolve(v); });
  });
}
function record(id, result) {
  const test = TESTS.find((t) => t.id === id);
  const points = result === test.scoreWhen ? test.points : 0;
  score += points;
  document.querySelector('#test-list li[data-test="' + id + '"] .row-result').textContent = result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickOf = (el) => new Promise((r) => el.addEventListener('click', () => r(), { once: true }));
async function scripted() {
  await sleep(2400);
  record('unsolicited', await verdict('unsolicited', openPopup('unsolicited')));
  await sleep(3000);
  record('timed', await verdict('timed', openPopup('timed')));
  await sleep(400);
  const fake = document.createElement('button');
  fake.addEventListener('click', () => openPopup('synthetic'));
  fake.dispatchEvent(new MouseEvent('click', { bubbles: false }));
  record('synthetic', await verdict('synthetic'));
  await sleep(400);
  const under = openPopup('popunder', 'width=180,height=120,left=4000,top=4000');
  if (under) { try { under.blur(); window.focus(); } catch {} }
  record('popunder', await verdict('popunder'));
}
async function interactive() {
  $('link-test').hidden = false;
  await clickOf($('link-test'));
  $('link-test').hidden = true;
  record('linkblank', await verdict('linkblank'));
  $('delayed-btn').hidden = false;
  await clickOf($('delayed-btn'));
  $('delayed-btn').disabled = true;
  await sleep(7000);
  record('delayed', await verdict('delayed', openPopup('delayed')));
  $('delayed-btn').hidden = true;
}
$('start-btn').addEventListener('click', async () => {
  $('start-btn').disabled = true;
  openPopup('clicked');
  const clicked = verdict('clicked').then((v) => record('clicked', v));
  await scripted();
  await interactive();
  await clicked;
  $('score-num').textContent = String(score);
});
$('hover-box').addEventListener('mouseenter', async () => {
  if ($('hover-result').textContent) return;
  $('hover-result').textContent = 'trying';
  openPopup('mouseover');
  $('hover-result').textContent = await verdict('mouseover');
});
$('chain-btn').addEventListener('click', () => openPopup('chain'));
$('stay-btn').addEventListener('click', () => {
  window.__handles.stay = !!window.open('/popup-window.html?test=stay&stay=1', 'pc_stay_' + Date.now(),
    'width=420,height=260,left=140,top=140');
});
</script>`;

const EXPECTED = {
  clicked: 'opened',
  unsolicited: 'blocked',
  timed: 'blocked',
  synthetic: 'blocked',
  popunder: 'blocked',
  linkblank: 'opened',
  delayed: 'blocked',
};

const hasXdotool = (() => {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return false;
  try {
    execFileSync('xdotool', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function findPopupXWindow(pid) {
  let ids;
  try {
    ids = execFileSync('xdotool', ['search', '--onlyvisible', '--pid', String(pid)], {
      encoding: 'utf-8',
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
  for (const id of ids) {
    try {
      const name = execFileSync('xdotool', ['getwindowname', id], { encoding: 'utf-8' });
      if (name.includes('PopupCheck')) return id;
    } catch {
      // gone already
    }
  }
  return null;
}

// Click a tab's close button. When it closes the window's last tab, the window
// — the page the click was sent through — goes away before the click resolves.
const clickTabClose = (tab) =>
  tab
    .locator('[data-test="tab-close"]')
    .click()
    .catch((err) => {
      if (!/closed/i.test(err.message)) throw err;
    });

const tabs = (page) => page.locator('[data-test="tab"]');

async function seedFixtures(electronApp) {
  await electronApp.evaluate(
    (_e, { fixtures }) => {
      for (const [url, body] of fixtures) {
        globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(url, { body });
      }
    },
    {
      fixtures: [
        // Longest prefix wins, so this one also answers `?test=…` queries.
        [POPUP_URL, POPUP_BODY],
        [PAGE_URL, PAGE_BODY],
      ],
    }
  );
}

// Count every BrowserWindow the app creates from here on, so a popup window
// that came and went between two polls is still seen.
async function trackCreatedWindows(electronApp) {
  await electronApp.evaluate(({ app }) => {
    globalThis.__popupCloseCreatedWindows = [];
    app.on('browser-window-created', (_event, win) => {
      globalThis.__popupCloseCreatedWindows.push(win.id);
    });
  });
}

const createdWindowCount = (electronApp) =>
  electronApp.evaluate(() => globalThis.__popupCloseCreatedWindows.length);

const liveWindows = (electronApp) =>
  electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed())
      .map((win) => ({ id: win.id, url: win.webContents.getURL() }))
  );

const popupGuestUrls = (electronApp) =>
  electronApp.evaluate(
    ({ webContents }, { popupUrl }) =>
      webContents
        .getAllWebContents()
        .filter((wc) => wc.getType() === 'webview' && wc.getURL().startsWith(popupUrl))
        .map((wc) => wc.getURL()),
    { popupUrl: POPUP_URL }
  );

async function gotoFixture(window, electronApp) {
  await seedFixtures(electronApp);
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE_URL);
  await input.press('Enter');
  await expect
    .poll(() => evalInWebview(window, "document.getElementById('out')?.textContent || null"), {
      timeout: 10_000,
    })
    .toBe('ready');
}

// Trusted input on the fixture guest. `click: false` only moves the mouse
// there (a hover, which is not a user activation).
async function realPointer(window, electronApp, id, { click = true } = {}) {
  const box = await evalInWebview(
    window,
    `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
      return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) }; })()`
  );
  expect(box).not.toBeNull();
  await electronApp.evaluate(
    ({ webContents }, { x, y, url, click }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url);
      if (!guest) throw new Error('fixture guest not found');
      guest.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
      guest.sendInputEvent({ type: 'mouseMove', x, y });
      if (click) {
        guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      }
    },
    { ...box, url: PAGE_URL, click }
  );
}

const readFixture = (window, expr) => evalInWebview(window, expr);

// The chrome page of the popup window opened for `testId`. A sized popup
// opens through createMainWindow with the popup URL as `initialUrl`.
async function popupChromePage(electronApp, testId) {
  const marker = encodeURIComponent(`popup-window.html?test=${testId}`);
  let page;
  await expect
    .poll(
      () => {
        page = electronApp
          .windows()
          .find((p) => p.url().includes('index.html') && p.url().includes(marker));
        return !!page;
      },
      { message: `Waiting for the ${testId} popup window`, timeout: 10_000 }
    )
    .toBe(true);
  await page.waitForSelector('[data-test="tab"]', { state: 'attached' });
  return page;
}

// Window id of the popup window for `testId`, from the main process.
const popupWindowId = (electronApp, testId) =>
  electronApp.evaluate(
    ({ BrowserWindow }, { marker }) =>
      BrowserWindow.getAllWindows().find(
        (win) => !win.isDestroyed() && win.webContents.getURL().includes(marker)
      )?.id ?? null,
    { marker: encodeURIComponent(`popup-window.html?test=${testId}`) }
  );

async function focusWindow(electronApp, winId) {
  await electronApp.evaluate(
    ({ BrowserWindow }, { winId }) => {
      BrowserWindow.fromId(winId)?.focus();
    },
    { winId }
  );
  await expect
    .poll(
      () =>
        electronApp.evaluate(
          ({ BrowserWindow }, { winId }) => BrowserWindow.fromId(winId)?.isFocused() ?? false,
          { winId }
        ),
      { message: `Waiting for window ${winId} to take focus` }
    )
    .toBe(true);
}

// After every popup is gone: exactly the original window, on one tab, and no
// popup page left alive anywhere.
async function expectNoStrayWindows(window, electronApp) {
  await expect
    .poll(async () => (await liveWindows(electronApp)).length, {
      message: 'Waiting for every popup window to close',
      timeout: 10_000,
    })
    .toBe(1);
  await expect.poll(() => popupGuestUrls(electronApp), { timeout: 10_000 }).toEqual([]);
  await expect(tabs(window)).toHaveCount(1);
}

// The original window still behaves: a new tab closes with its close button,
// and closing the last tab closes the window.
async function expectOriginalWindowClosesNormally(window, electronApp) {
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(tabs(window)).toHaveCount(2);
  await clickTabClose(tabs(window).nth(1));
  await expect(tabs(window)).toHaveCount(1);
  expect((await liveWindows(electronApp)).length).toBe(1);

  const closed = window.waitForEvent('close');
  await clickTabClose(tabs(window).first());
  await closed;
}

test.describe('popupcheck.com fixture', () => {
  test('scores 100: every verdict as Chrome, and every popup that opened closed itself', async ({
    window,
    electronApp,
  }) => {
    test.setTimeout(120_000);
    await trackCreatedWindows(electronApp);
    await gotoFixture(window, electronApp);

    await realPointer(window, electronApp, 'start-btn');
    // `clicked` opens a window of its own.
    await popupChromePage(electronApp, 'clicked');

    // Its turn for the user: a real click on the target=_blank link…
    await expect
      .poll(() => readFixture(window, "!document.getElementById('link-test').hidden"), {
        timeout: 30_000,
      })
      .toBe(true);
    await realPointer(window, electronApp, 'link-test');
    // …which opens as a tab in this window, and closes itself again.
    await expect(tabs(window)).toHaveCount(2);
    await expect(tabs(window)).toHaveCount(1, { timeout: 10_000 });

    // …then a click on the delayed button, and nothing for 7 s.
    await expect
      .poll(() => readFixture(window, "!document.getElementById('delayed-btn').hidden"), {
        timeout: 15_000,
      })
      .toBe(true);
    await realPointer(window, electronApp, 'delayed-btn');

    await expect
      .poll(() => readFixture(window, "document.getElementById('score-num').textContent"), {
        timeout: 30_000,
      })
      .toBe('100');
    const verdicts = await readFixture(
      window,
      `Object.fromEntries([...document.querySelectorAll('#test-list li')].map((li) =>
        [li.dataset.test, li.querySelector('.row-result').textContent]))`
    );
    expect(verdicts).toEqual(EXPECTED);
    await window.screenshot({ path: `${SHOT_DIR}/popupcheck-score.png` });

    // Freedom never hands out a window handle, so opener close() is a no-op…
    const handles = await readFixture(window, 'window.__handles');
    expect(handles).toEqual(
      expect.objectContaining({ clicked: false, unsolicited: false, delayed: false })
    );
    // …and the popups closed themselves: only the `clicked` window was ever
    // created, and nothing is left.
    expect(await createdWindowCount(electronApp)).toBe(1);
    await expectNoStrayWindows(window, electronApp);

    // Unscored: hovering is not clicking (no click in the last 5 s here: the
    // last one was the delayed button, more than 7 s ago)…
    await realPointer(window, electronApp, 'hover-box', { click: false });
    await expect
      .poll(() => readFixture(window, "document.getElementById('hover-result').textContent"), {
        timeout: 10_000,
      })
      .toBe('blocked');

    // …and a popup cannot open another one without a gesture of its own.
    await realPointer(window, electronApp, 'chain-btn');
    await popupChromePage(electronApp, 'chain');
    await expect
      .poll(() => readFixture(window, 'window.__chain'), { timeout: 10_000 })
      .toBe('blocked');
    expect(await createdWindowCount(electronApp)).toBe(2);
    await expectNoStrayWindows(window, electronApp);

    await expectOriginalWindowClosesNormally(window, electronApp);
  });
});

test.describe('a popup that stays open', () => {
  // Opens the `stay` popup (no self-close) with a real click and returns its
  // chrome page and window id.
  async function openStayingPopup(window, electronApp) {
    await gotoFixture(window, electronApp);
    await realPointer(window, electronApp, 'stay-btn');
    const page = await popupChromePage(electronApp, 'stay');
    await expect.poll(() => popupGuestUrls(electronApp), { timeout: 10_000 }).toHaveLength(1);
    await expect(tabs(page)).toHaveCount(1);
    const winId = await popupWindowId(electronApp, 'stay');
    expect(winId).not.toBeNull();
    expect(await readFixture(window, 'window.__handles.stay')).toBe(false);
    return { page, winId };
  }

  test('closes from its tab close button', async ({ window, electronApp }) => {
    const { page } = await openStayingPopup(window, electronApp);
    await page.screenshot({ path: `${SHOT_DIR}/popup-stay-window.png` });
    await clickTabClose(tabs(page).first());
    await expectNoStrayWindows(window, electronApp);
    await expectOriginalWindowClosesNormally(window, electronApp);
  });

  test('closes with Cmd/Ctrl+W', async ({ window, electronApp }) => {
    const { page, winId } = await openStayingPopup(window, electronApp);
    await focusWindow(electronApp, winId);
    if (hasXdotool) {
      // A real key event, so the native menu accelerator decides (see
      // close-tab-shortcut.spec.js). With the guest focused the key is not
      // eaten by the chrome renderer's own keydown fallback.
      await page.evaluate(() => document.querySelector('webview')?.focus());
      // The popup's own X window: the app's window titled after the popup
      // page. xvfb has no window manager, so focus it directly.
      let xid = null;
      await expect
        .poll(
          () => {
            xid = findPopupXWindow(electronApp.process().pid);
            return !!xid;
          },
          { message: 'Waiting for the popup X window', timeout: 10_000 }
        )
        .toBe(true);
      execFileSync('xdotool', ['windowfocus', '--sync', xid]);
      await focusWindow(electronApp, winId);
      execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+w']);
    } else {
      // The File > Close Tab item is what the Cmd/Ctrl+W accelerator runs.
      await electronApp.evaluate(({ Menu }) => {
        Menu.getApplicationMenu().getMenuItemById('close-tab').click();
      });
    }
    await expectNoStrayWindows(window, electronApp);
    await expectOriginalWindowClosesNormally(window, electronApp);
  });

  test('closes with its window', async ({ window, electronApp }) => {
    const { winId } = await openStayingPopup(window, electronApp);
    await focusWindow(electronApp, winId);
    // File > Close Window, i.e. what the window's own close button does.
    await electronApp.evaluate(({ Menu }) => {
      Menu.getApplicationMenu().getMenuItemById('close-window').click();
    });
    await expectNoStrayWindows(window, electronApp);
    await expectOriginalWindowClosesNormally(window, electronApp);
  });

  test('closes itself with window.close()', async ({ window, electronApp }) => {
    const { winId } = await openStayingPopup(window, electronApp);
    const guestUrl = (await popupGuestUrls(electronApp))[0];
    // The page's own close, now rather than on a timer.
    await electronApp.evaluate(
      ({ webContents }, { guestUrl }) => {
        const guest = webContents.getAllWebContents().find((wc) => wc.getURL() === guestUrl);
        // Deferred: the guest is gone before a direct call could answer.
        return guest.executeJavaScript('setTimeout(() => window.close(), 0); true');
      },
      { guestUrl }
    );
    await expect
      .poll(() => popupWindowId(electronApp, 'stay'), { timeout: 10_000 })
      .not.toBe(winId);
    await expectNoStrayWindows(window, electronApp);
    await expectOriginalWindowClosesNormally(window, electronApp);
  });
});
