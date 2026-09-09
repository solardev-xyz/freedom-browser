// TEMPORARY diagnostic spec — delete before the final commit.
const { test, expect } = require('./fixtures');

test('repro: second Downloads click', async ({ window }) => {
  const activeUrl = () =>
    window.evaluate(() => {
      const wv = document.querySelector('webview.active, webview:not(.hidden)');
      return wv?.getURL?.() || wv?.getAttribute?.('src') || '';
    });

  await window.evaluate(() => {
    const d = (el) =>
      el === window
        ? 'WINDOW'
        : el === document
          ? 'DOCUMENT'
          : el
            ? `${el.tagName}#${el.id || ''}.${typeof el.className === 'string' ? el.className : ''}`
            : 'null';
    window.__log = [];
    const push = (m) => window.__log.push(`${Math.round(performance.now())} ${m}`);

    const dd = document.getElementById('menu-dropdown');
    const origToggle = DOMTokenList.prototype.toggle;
    DOMTokenList.prototype.toggle = function (...a) {
      if (this === dd.classList && String(a[0]) === 'open') {
        push(
          `dropdown.open->${a[1]} @ ${(new Error().stack || '').split('\n').slice(2, 5).join(' | ')}`
        );
      }
      return origToggle.apply(this, a);
    };

    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      document.addEventListener(
        type,
        (e) => push(`${type} ${d(e.target)} @${Math.round(e.clientX)},${Math.round(e.clientY)}`),
        true
      );
    }
    document
      .getElementById('downloads-btn')
      ?.addEventListener('click', () => push('*** DOWNLOADS ROW HANDLER RAN ***'));
    const tabsNow = () =>
      [...document.querySelectorAll('[data-test="tab"]')]
        .map((t) => `${t.className}|${t.textContent.trim().slice(0, 12)}`)
        .join(' ;; ');
    window.__tabsNow = tabsNow;
    const origAdd = EventTarget.prototype.addEventListener;
    window.addEventListener(
      'blur',
      (e) => push(`blur target=${d(e.target)} active=${d(document.activeElement)} hasFocus=${document.hasFocus()}`),
      true
    );
    window.addEventListener(
      'focus',
      (e) => push(`focus target=${d(e.target)} active=${d(document.activeElement)}`),
      true
    );
    window.addEventListener('resize', () => push(`resize ${innerWidth}x${innerHeight}`), true);
  });

  const geom = () =>
    window.evaluate(() => {
      const dd = document.getElementById('menu-dropdown');
      const btn = document.getElementById('downloads-btn');
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const bd = document.getElementById('menu-backdrop');
      return {
        inner: `${window.innerWidth}x${window.innerHeight}`,
        dd: `${Math.round(dd.getBoundingClientRect().top)}..${Math.round(dd.getBoundingClientRect().bottom)}`,
        ddScroll: dd.scrollHeight,
        ddClient: dd.clientHeight,
        ddScrollTop: dd.scrollTop,
        inlineMax: dd.style.maxHeight,
        open: dd.classList.contains('open'),
        btn: `${Math.round(r.top)}..${Math.round(r.bottom)} x ${Math.round(r.left)}..${Math.round(r.right)}`,
        hitAt: hit ? `${hit.tagName}#${hit.id}.${hit.className}` : 'null',
        backdropHidden: bd.classList.contains('hidden'),
        docScrollHeight: document.documentElement.scrollHeight,
        hasFocus: document.hasFocus(),
        rows: [...document.querySelectorAll('#menu-dropdown .menu-item')].map(
          (el) =>
            `${el.id || el.className}:${Math.round(el.getBoundingClientRect().top)}-${Math.round(el.getBoundingClientRect().bottom)}`
        ),
      };
    });

  await window.locator('#menu-button').click();
  await expect(window.locator('#downloads-btn')).toBeVisible();
  console.log('GEOM-1 ' + JSON.stringify(await geom()));

  await window.locator('#downloads-btn').click();
  await expect.poll(activeUrl, { timeout: 10_000 }).toMatch(/pages\/downloads\.html/);
  await expect
    .poll(() => window.evaluate(() => document.activeElement?.tagName), { timeout: 10_000 })
    .toBe('WEBVIEW');

  await window.locator('[data-test="tab"]').first().click();
  await expect.poll(activeUrl, { timeout: 10_000 }).not.toMatch(/pages\/downloads\.html/);

  await window.locator('#menu-button').click();
  await expect
    .poll(() =>
      window.evaluate(() => document.getElementById('menu-dropdown').classList.contains('open'))
    )
    .toBe(true);
  console.log('GEOM-2 ' + JSON.stringify(await geom()));
  await window.locator('#downloads-btn').click();
  let ok = true;
  try {
    await expect.poll(activeUrl, { timeout: 6_000 }).toMatch(/pages\/downloads\.html/);
  } catch {
    ok = false;
  }
  console.log('GEOM-3 ' + JSON.stringify(await geom()));
  console.log('TABS ' + (await window.evaluate(() => window.__tabsNow())));
  const log = await window.evaluate(() => window.__log);
  console.log('SECOND CLICK OK = ' + ok);
  console.log('LOG\n' + log.join('\n'));
  expect(ok).toBe(true);
});
