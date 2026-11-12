// Screen sharing (#951): a site's getDisplayMedia() opens Freedom's picker,
// and the pick is what the site gets.
//
// The windows and screens the picker lists come from the test harness
// (src/main/test-harness.js, `__FREEDOM_TEST_SCREEN_SHARE__`), so no run lists
// or records a real desktop; only tab sharing captures for real. Everything
// between the click and the stream is the real path: the session's
// `display-capture` permission request, src/main/permissions/screen-share.js,
// the chrome's picker and Electron's display-media handler.
const { test, expect } = require('./fixtures');
const { evalInWebview } = require('./permission-fixtures');

const MEET_URL = 'https://meet.example.com/';
const SLIDES_URL = 'https://slides.example.org/';

const MEET_BODY = [
  '<!doctype html><title>Team meeting</title>',
  '<style>button { display: block; margin: 16px; font-size: 24px; }</style>',
  '<button id="share">Present now</button>',
  '<button id="legacy">Present the old way</button>',
  '<div id="out">ready</div>',
  '<script>',
  '  const out = document.getElementById("out");',
  '  window.share = async () => {',
  '    try {',
  '      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });',
  '      window.__stream = stream;',
  '      const surface = stream.getVideoTracks()[0].getSettings().displaySurface;',
  '      out.textContent = `shared ${surface} audio=${stream.getAudioTracks().length}`;',
  '    } catch (err) {',
  '      out.textContent = err.name;',
  '    }',
  '  };',
  '  document.getElementById("share").addEventListener("click", window.share);',
  '  document.getElementById("legacy").addEventListener("click", async () => {',
  '    try {',
  '      const stream = await navigator.mediaDevices.getUserMedia({',
  '        video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: window.__sourceId } },',
  '      });',
  '      out.textContent = `legacy stream ${stream.getVideoTracks().length}`;',
  '    } catch (err) {',
  '      out.textContent = err.name;',
  '    }',
  '  });',
  '</script>',
].join('\n');

const SLIDES_BODY =
  '<!doctype html><title>Quarterly slides</title><body style="background:#1f6feb">Q3</body>';

const readOut = (window) =>
  evalInWebview(window, "document.getElementById('out')?.textContent || null");

async function open(window, url) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
}

// The slides in one tab, the meeting in a second, active one.
async function openMeeting(window, electronApp) {
  await electronApp.evaluate(
    (_e, fixtures) => {
      for (const [url, body] of fixtures) {
        globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(url, { body });
      }
    },
    [
      [MEET_URL, MEET_BODY],
      [SLIDES_URL, SLIDES_BODY],
    ]
  );
  await open(window, SLIDES_URL);
  await expect.poll(() => evalInWebview(window, 'document.title')).toBe('Quarterly slides');
  await window.locator('[data-test="new-tab-btn"]').click();
  await open(window, MEET_URL);
  await expect.poll(() => readOut(window), { timeout: 10_000 }).toBe('ready');
}

// A real click inside the meeting tab: input sent to the guest's own
// webContents, so the gesture check sees user input — a scripted `.click()`
// would not, and must not open the picker.
async function realClick(window, electronApp, id) {
  const box = await evalInWebview(
    window,
    `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
      return { x: Math.round(r.left + 10), y: Math.round(r.top + r.height / 2) }; })()`
  );
  expect(box).not.toBeNull();
  await electronApp.evaluate(
    ({ webContents }, { x, y, url }) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL() === url);
      if (!guest) throw new Error('meeting tab not found');
      guest.sendInputEvent({ type: 'mouseMove', x, y });
      guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    },
    { ...box, url: MEET_URL }
  );
}

const picker = (window) => window.locator('[data-test="screen-share-picker"]');
const options = (window) => picker(window).locator('[role="option"]');

test('a click opens the picker; sharing another tab shows it and streams it', async ({
  window,
  electronApp,
}) => {
  await openMeeting(window, electronApp);
  await realClick(window, electronApp, 'share');

  await expect(picker(window)).toBeVisible();
  await expect(picker(window)).toContainText('Choose what to share with https://meet.example.com');
  await expect(options(window)).toHaveCount(2);
  await expect(options(window).filter({ hasText: 'Team meeting' })).toContainText('This tab');
  const share = window.locator('[data-test="screen-share-submit"]');
  await expect(share).toBeDisabled();
  await expect(picker(window).locator('#screen-share-audio')).toBeChecked();

  await options(window).filter({ hasText: 'Quarterly slides' }).click();
  await share.click();
  await expect(picker(window)).toBeHidden();

  // Freedom shows the shared tab, as Chrome does…
  await expect(window.locator('.tab.active')).toContainText('Quarterly slides');
  // …and keeps painting it once the meeting is in front again.
  await window.locator('.tab', { hasText: 'Team meeting' }).click();
  await expect.poll(() => readOut(window), { timeout: 10_000 }).toBe('shared browser audio=1');
  const sharedClasses = await window.evaluate(
    () => document.querySelectorAll('.webview-container webview')[0].className
  );
  expect(sharedClasses).toContain('is-screen-shared');
});

test('Cancel and Escape refuse the request', async ({ window, electronApp }) => {
  await openMeeting(window, electronApp);

  await realClick(window, electronApp, 'share');
  await expect(picker(window)).toBeVisible();
  await window.locator('[data-test="screen-share-cancel"]').click();
  await expect(picker(window)).toBeHidden();
  await expect.poll(() => readOut(window)).toBe('NotAllowedError');

  await realClick(window, electronApp, 'share');
  await expect(picker(window)).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(picker(window)).toBeHidden();
  await expect.poll(() => readOut(window)).toBe('NotAllowedError');
});

test('a page cannot open the picker without a click', async ({ window, electronApp }) => {
  await openMeeting(window, electronApp);
  await evalInWebview(window, 'window.share(); true');
  await expect.poll(() => readOut(window)).toBe('NotAllowedError');
  await expect(picker(window)).toBeHidden();
});

test("windows and screens are listed, and macOS's Screen Recording block is explained", async ({
  window,
  electronApp,
}) => {
  await openMeeting(window, electronApp);
  await realClick(window, electronApp, 'share');
  await expect(picker(window)).toBeVisible();

  await window.locator('#screen-share-kind-window').click();
  await expect(options(window)).toHaveCount(2);
  await expect(options(window).first()).toContainText('Notes');
  // A window carries no audio.
  await expect(picker(window).locator('#screen-share-audio-label')).toBeHidden();

  await electronApp.evaluate(() =>
    globalThis.__FREEDOM_TEST_HARNESS__.setScreenRecordingAccess('denied')
  );
  await window.locator('#screen-share-kind-screen').click();
  await expect(picker(window).locator('.ui-callout')).toContainText(
    'macOS is not letting Freedom see your screen'
  );
  await expect(options(window)).toHaveCount(0);

  // Tabs still work without it.
  await window.locator('#screen-share-kind-tab').click();
  await expect(options(window)).toHaveCount(2);
  await window.locator('[data-test="screen-share-cancel"]').click();
});

test("a page that asks through getUserMedia's chromeMediaSource is stopped", async ({
  window,
  electronApp,
}) => {
  await openMeeting(window, electronApp);
  // A tab source id bound to the meeting tab, which only main can mint; the
  // page names it itself, as such a page would name `screen:1:0`.
  const sourceId = await electronApp.evaluate(({ webContents }, url) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL() === url);
    return guest.getMediaSourceId(guest);
  }, MEET_URL);
  await evalInWebview(window, `window.__sourceId = ${JSON.stringify(sourceId)}; true`);

  await realClick(window, electronApp, 'legacy');
  await expect(picker(window)).toBeVisible();
  await options(window).filter({ hasText: 'Team meeting' }).click();
  await window.locator('[data-test="screen-share-submit"]').click();

  await expect(window.locator('[data-test="permission-prompt"]')).toContainText(
    'tried to share your screen without Freedom’s picker'
  );
  const crashed = await electronApp.evaluate(({ webContents }, url) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL() === url);
    return guest?.isCrashed() ?? null;
  }, MEET_URL);
  expect(crashed).toBe(true);
});
