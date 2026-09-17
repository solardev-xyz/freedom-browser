'use strict';

const path = require('path');
const { test, expect } = require('./fixtures');

const FIXTURE_URL = 'https://automation-observation.test/form';
const ADAPTER_PATH = path.resolve(
  __dirname,
  '../src/main/automation/adapters/web-contents-page-adapter.js'
);

function execute(electronApp, operation, input) {
  return electronApp.evaluate(
    (_electron, payload) =>
      globalThis.__FREEDOM_TEST_HARNESS__.automationExecute(payload.operation, payload.input),
    { operation, input }
  );
}

async function openFixture({ electronApp, window, harness }, mode, body) {
  await harness.setContentFixture(FIXTURE_URL, { body: `<!doctype html>${body}` });
  if (mode === 'hidden') {
    return electronApp.evaluate(
      (_electron, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
      FIXTURE_URL
    );
  }
  const address = window.locator('[data-test="address-input"]');
  await address.fill(FIXTURE_URL);
  await address.press('Enter');
  let tab;
  await expect
    .poll(async () => {
      const result = await execute(electronApp, 'browser_list_tabs', {});
      tab = result.result.tabs.find((candidate) => candidate.url === FIXTURE_URL);
      return tab?.tabId;
    })
    .toBeTruthy();
  await expect(
    execute(electronApp, 'browser_wait', { tabId: tab.tabId, condition: 'load' })
  ).resolves.toMatchObject({ ok: true });
  return tab.tabId;
}

async function snapshot(electronApp, tabId) {
  const response = await execute(electronApp, 'browser_snapshot', { tabId });
  expect(response.ok).toBe(true);
  return response.result;
}

function named(observation, name) {
  const matches = observation.elements.filter((element) => element.name === name);
  expect(matches, `one control named ${name}`).toHaveLength(1);
  return matches[0];
}

for (const mode of ['desktop', 'hidden']) {
  test(`${mode} observations retrieve omitted text and controls with document-bound live windows`, async ({
    electronApp,
    window,
    harness,
  }) => {
    const tabId = await openFixture(
      { electronApp, window, harness },
      mode,
      `
      <title>Long page</title><p>${'a'.repeat(11_999)}😀AFTER-TEXT-LIMIT</p>
      ${Array.from({ length: 300 }, (_unused, index) => `<button>Control ${index}</button>`).join('')}
      <button onclick="document.querySelector('#result').textContent='Late action trusted=' + event.isTrusted">Late target</button>
      <p id="result">Waiting</p>
    `
    );
    const first = await snapshot(electronApp, tabId);
    expect(first).toMatchObject({
      textTruncated: true,
      elementsTruncated: true,
      scanTruncated: false,
      textCollectionTruncated: false,
      nextElementOffset: 250,
    });
    expect(first.elements).toHaveLength(250);
    expect(first.text).not.toContain('AFTER-TEXT-LIMIT');
    expect(first.text).not.toMatch(/[\uD800-\uDBFF]$/);
    const next = await execute(electronApp, 'browser_snapshot', {
      tabId,
      textOffset: first.nextTextOffset,
      elementOffset: first.nextElementOffset,
      navigationId: first.navigationId,
      documentId: first.documentId,
    });
    expect(next.ok).toBe(true);
    expect(next.result.text).toContain('😀AFTER-TEXT-LIMIT');
    expect(next.result.elements).toHaveLength(51);
    named(next.result, 'Late target');
    expect(next.result.elementsTruncated).toBe(false);
    expect(next.result).not.toHaveProperty('nextElementOffset');
    const search = await execute(electronApp, 'browser_snapshot', { tabId, query: 'lAtE tArGeT' });
    expect(search.ok).toBe(true);
    expect(search.result.elements).toHaveLength(1);
    await expect(
      execute(electronApp, 'browser_click', {
        tabId,
        ref: named(search.result, 'Late target').ref,
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      execute(electronApp, 'browser_wait', {
        tabId,
        condition: 'text',
        text: 'Late action trusted=true',
      })
    ).resolves.toMatchObject({ ok: true });
    await execute(electronApp, 'browser_navigate', { tabId, url: `${FIXTURE_URL}?changed` });
    expect(
      await execute(electronApp, 'browser_snapshot', {
        tabId,
        textOffset: first.nextTextOffset,
        navigationId: first.navigationId,
        documentId: first.documentId,
      })
    ).toMatchObject({ ok: false, error: { code: 'STALE_ELEMENT_REFERENCE' } });
  });

  test(`${mode} observations use associated labels without exposing input values as names`, async ({
    electronApp,
    window,
    harness,
  }) => {
    const tabId = await openFixture(
      { electronApp, window, harness },
      mode,
      `
      <title>Label discovery</title>
      <label for="email">Contact <strong>email</strong></label>
      <input id="email" placeholder="Fallback placeholder" title="Fallback title" value="existing-value-marker">
      <label>Display name <input id="display"></label>
      <label for="multiple">Shipping</label><label for="multiple">address</label>
      <textarea id="multiple"></textarea>
      <label for="region">Region</label><select id="region"><option>Europe</option></select>
      <label for="aria">HTML name</label><input id="aria" aria-label="ARIA name">
      <span id="first">Referenced</span><span id="second">name</span>
      <input aria-labelledby="first second" aria-label="Lower precedence">
      <label for="blank">Blank ARIA fallback</label><input id="blank" aria-label="   ">
      <label for="missing">Missing reference fallback</label><input id="missing" aria-labelledby="missing-id">
      <label for="password">Password</label><input id="password" type="password" value="private-password-marker">
      <input type="password" value="unlabelled-password-marker">
      <input value="unlabelled-value-marker">
      <input type="button" value="Value-named button">
      <span id="outer-only">Wrong outer label</span>
      <div id="host"></div>
      <iframe srcdoc='<label for="child">Frame label</label><input id="child">'></iframe>
      <script>
        document.querySelector('#host').attachShadow({mode: 'open'}).innerHTML =
          '<label for="local">Shadow label</label><input id="local">' +
          '<input aria-labelledby="outer-only" aria-label="Shadow fallback">';
      </script>
    `
    );

    const first = await snapshot(electronApp, tabId);
    for (const name of [
      'Contact email',
      'Display name',
      'Shipping address',
      'Region',
      'ARIA name',
      'Referenced name',
      'Blank ARIA fallback',
      'Missing reference fallback',
      'Password',
      'Value-named button',
      'Shadow label',
      'Shadow fallback',
      'Frame label',
    ])
      named(first, name);
    expect(JSON.stringify(first)).not.toMatch(/private-password-marker|unlabelled-password-marker/);
    expect(first.elements.map((element) => element.name)).not.toEqual(
      expect.arrayContaining([
        'existing-value-marker',
        'unlabelled-value-marker',
        'Wrong outer label',
      ])
    );

    // Exercise the same naming path used by approval inspection, in the real
    // isolated world, without introducing another production test-harness API.
    const descriptions = await electronApp.evaluate(
      async ({ webContents }, payload) => {
        const { WebContentsPageAdapter } = process.mainModule.require(payload.adapterPath);
        const guest = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL() === payload.url);
        const adapter = new WebContentsPageAdapter(guest);
        try {
          const observed = await adapter.snapshot();
          const password = observed.elements.find((entry) => entry.name === 'Password');
          const email = observed.elements.find((entry) => entry.name === 'Contact email');
          return {
            email: await adapter.inspectAction(email.ref, { operation: 'browser_type' }),
            password: await adapter.inspectAction(password.ref, { operation: 'browser_type' }),
          };
        } finally {
          adapter.dispose();
        }
      },
      { adapterPath: ADAPTER_PATH, url: FIXTURE_URL }
    );
    expect(descriptions.email.label).toBe('Contact email');
    expect(descriptions.password.label).toBe('Password');
    expect(JSON.stringify(descriptions)).not.toContain('private-password-marker');

    await expect(
      execute(electronApp, 'browser_type', {
        tabId,
        ref: named(first, 'Display name').ref,
        text: 'Entered name',
      })
    ).resolves.toMatchObject({ ok: true });
    expect(named(await snapshot(electronApp, tabId), 'Display name').role).toBe('textbox');
  });

  test(`${mode} observations report control state before and after trusted input`, async ({
    electronApp,
    window,
    harness,
  }) => {
    const tabId = await openFixture(
      { electronApp, window, harness },
      mode,
      `
      <title>Control states</title>
      <label><input type="checkbox" checked aria-checked="false">Enabled</label>
      <label><input id="mixed" type="checkbox">Partial</label>
      <label><input type="radio" name="sort" checked>Featured</label>
      <label><input type="radio" name="sort">Newest</label>
      <button aria-pressed="false" onclick="this.setAttribute('aria-pressed', 'true')">Pin</button>
      <button aria-expanded="false" onclick="this.setAttribute('aria-expanded', 'true')">Details</button>
      <button aria-pressed="mixed">Mixed toggle</button>
      <div role="switch" aria-checked="mixed">Two-state switch</div>
      <div role="checkbox" aria-checked="mixed">ARIA partial</div>
      <div role="listbox"><div role="option" aria-selected="true">Selected item</div>
        <div role="option" aria-selected="false">Other item</div></div>
      <button>Ordinary</button><button aria-pressed="invalid">Invalid toggle</button>
      <div role="generic" aria-checked="true" aria-pressed="true" aria-selected="true">Not a control</div>
      <fieldset disabled><label><input type="checkbox" checked>Unavailable</label></fieldset>
      <div id="host"></div>
      <script>
        document.querySelector('#mixed').indeterminate = true;
        document.querySelector('#host').attachShadow({mode: 'open'}).innerHTML =
          '<label><input type="checkbox" checked>Shadow choice</label>';
        document.addEventListener('click', (event) => {
          document.body.dataset.trusted = String(event.isTrusted);
        });
      </script>
    `
    );
    const first = await snapshot(electronApp, tabId);
    for (const [name, state] of [
      ['Enabled', { checked: true }],
      ['Partial', { checked: 'mixed' }],
      ['Featured', { checked: true }],
      ['Newest', { checked: false }],
      ['Pin', { pressed: false }],
      ['Details', { expanded: false }],
      ['Mixed toggle', { pressed: 'mixed' }],
      ['Two-state switch', { checked: false }],
      ['ARIA partial', { checked: 'mixed' }],
      ['Selected item', { selected: true }],
      ['Other item', { selected: false }],
      ['Unavailable', { checked: true, disabled: true }],
      ['Shadow choice', { checked: true }],
    ])
      expect(named(first, name)).toMatchObject(state);
    for (const name of ['Ordinary', 'Invalid toggle', 'Not a control']) {
      for (const key of ['checked', 'pressed', 'expanded', 'selected']) {
        expect(named(first, name)).not.toHaveProperty(key);
      }
    }

    for (const name of ['Enabled', 'Newest', 'Pin', 'Details']) {
      const current = await snapshot(electronApp, tabId);
      await expect(
        execute(electronApp, 'browser_click', {
          tabId,
          ref: named(current, name).ref,
        })
      ).resolves.toMatchObject({ ok: true });
    }
    const after = await snapshot(electronApp, tabId);
    expect(named(after, 'Enabled').checked).toBe(false);
    expect(named(after, 'Featured').checked).toBe(false);
    expect(named(after, 'Newest').checked).toBe(true);
    expect(named(after, 'Pin').pressed).toBe(true);
    expect(named(after, 'Details').expanded).toBe(true);
    expect(named(first, 'Enabled').checked).toBe(true);
    const trusted = await electronApp.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((entry) => entry.getURL() === url);
      return guest.executeJavaScript('document.body.dataset.trusted');
    }, FIXTURE_URL);
    expect(trusted).toBe('true');

    await execute(electronApp, 'browser_navigate', { tabId, url: `${FIXTURE_URL}?next` });
    const stale = await execute(electronApp, 'browser_click', {
      tabId,
      ref: named(after, 'Enabled').ref,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'STALE_ELEMENT_REFERENCE' } });
  });
}

test('observation collection reports scan and text limits instead of claiming complete absence', async ({
  electronApp,
  window,
  harness,
}) => {
  const tabId = await openFixture(
    { electronApp, window, harness },
    'hidden',
    `
    <p>${'x'.repeat(1_000_001)}</p>
    ${'<div></div>'.repeat(20_001)}<button>Beyond scan budget</button>
  `
  );
  const result = await execute(electronApp, 'browser_snapshot', {
    tabId,
    query: 'Beyond scan budget',
  });
  expect(result).toMatchObject({
    ok: true,
    result: {
      elements: [],
      scanTruncated: true,
      textCollectionTruncated: true,
      truncated: true,
    },
  });
  expect(result.result.text.length).toBeLessThanOrEqual(12000);
  expect(result.result).not.toHaveProperty('nextElementOffset');
});

test('oversized labels and dropdowns stay bounded without inventing option values', async ({
  electronApp,
  window,
  harness,
}) => {
  const label = '界'.repeat(3_000);
  const oversizedValue = 'value'.repeat(1_000);
  const tabId = await openFixture(
    { electronApp, window, harness },
    'hidden',
    `<select aria-label="Choices"><option value="${oversizedValue}">Oversized value</option>
      <option value="exact">${label}</option><option value="short">Short</option></select>
      ${Array.from({ length: 100 }, (_, index) => `<button aria-label="${index} ${label}">Button</button>`).join('')}`
  );
  const first = await snapshot(electronApp, tabId);
  expect(first.fieldsTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(384_000);
  const select = named(first, 'Choices');
  expect(select).toMatchObject({ valueOmitted: true, optionsTruncated: true });
  expect(select).not.toHaveProperty('value');
  expect(select.options).toEqual([
    expect.objectContaining({ value: 'exact', labelTruncated: true }),
    expect.objectContaining({ value: 'short', label: 'Short' }),
  ]);
  expect(select.options[0].label.length).toBeLessThanOrEqual(2_000);
  expect(first.nextElementOffset).toBeGreaterThan(0);
  expect(first.nextElementOffset).toBeLessThan(101);
  const next = await execute(electronApp, 'browser_snapshot', {
    tabId,
    documentId: first.documentId,
    navigationId: first.navigationId,
    elementOffset: first.nextElementOffset,
  });
  expect(next.ok).toBe(true);
  expect(next.result.elements[0].name).toMatch(new RegExp(`^${first.nextElementOffset - 1} `));
  expect(next.result.nextElementOffset).toBeGreaterThan(first.nextElementOffset);
  expect(Buffer.byteLength(JSON.stringify(next.result))).toBeLessThan(384_000);
  const selected = await execute(electronApp, 'browser_select', {
    tabId,
    ref: select.ref,
    value: 'exact',
  });
  expect(selected.ok).toBe(true);
  const after = await snapshot(electronApp, tabId);
  expect(named(after, 'Choices').value).toBe('exact');
});

for (const mode of ['desktop', 'hidden']) {
  test(`${mode} scrolls page and nested containers with measured movement and trusted input`, async ({
    electronApp,
    window,
    harness,
  }) => {
    const tabId = await openFixture(
      { electronApp, window, harness },
      mode,
      `
      <style>body { margin: 0 } #list { width: 300px; height: 200px; overflow: auto; }
      #content { height: 1500px; width: 900px } #blocked { height: 120px; width: 300px; overflow: auto }</style>
      <div id="list" aria-label="Results list"><div id="content">Items</div></div>
      <div id="blocked" aria-label="Wheel blocked"><div style="height:1000px">Blocked</div></div>
      <button>Ordinary button</button><div style="height:3500px">Long page</div>
      <script>
        document.addEventListener('wheel', event => { document.body.dataset.trusted = String(event.isTrusted) });
        document.querySelector('#blocked').addEventListener('wheel', event => event.preventDefault(), {passive:false});
        document.querySelector('#list').addEventListener('scroll', () => {
          if (!document.querySelector('#revealed')) {
            const button = document.createElement('button'); button.id = 'revealed';
            button.textContent = 'Loaded after scrolling'; document.querySelector('#content').prepend(button);
          }
        });
      </script>`
    );
    const first = await snapshot(electronApp, tabId);
    const viewport = first.frames[0].viewport;
    const list = named(first, 'Results list');
    expect(viewport.vertical).toBe(true);
    for (const ref of [viewport.ref, list.ref]) {
      expect(await execute(electronApp, 'browser_click', { tabId, ref })).toMatchObject({
        ok: false,
        error: { code: 'CAPABILITY_UNAVAILABLE' },
      });
    }
    expect(list.scrollable).toMatchObject({ vertical: true, horizontal: true, y: 0, x: 0 });
    const scroll = (ref, direction, pages = 1) =>
      execute(electronApp, 'browser_scroll', { tabId, ref, direction, pages });
    const down = await scroll(list.ref, 'down');
    expect(down).toMatchObject({ ok: true, result: { moved: true, outcome: 'moved' } });
    expect(down.result.deltaY).toBeGreaterThan(0);
    const afterList = await snapshot(electronApp, tabId);
    expect(afterList.frames[0].viewport.y).toBe(0);
    named(afterList, 'Loaded after scrolling');
    const right = await scroll(named(afterList, 'Results list').ref, 'right');
    expect(right).toMatchObject({ ok: true, result: { moved: true } });
    expect(right.result.deltaX).toBeGreaterThan(0);
    expect(await scroll(named(afterList, 'Results list').ref, 'left')).toMatchObject({
      ok: true,
      result: { moved: true },
    });
    expect(await scroll(list.ref, 'up', 3)).toMatchObject({ ok: true, result: { moved: true } });
    expect(await scroll(list.ref, 'up')).toMatchObject({
      ok: true,
      result: { moved: false, outcome: 'boundary' },
    });
    expect((await snapshot(electronApp, tabId)).frames[0].viewport.y).toBe(0);
    expect(await scroll(named(first, 'Wheel blocked').ref, 'down')).toMatchObject({
      ok: true,
      result: { moved: false, outcome: 'no_movement' },
    });
    expect(await scroll(named(first, 'Ordinary button').ref, 'down')).toMatchObject({
      ok: false,
      error: { code: 'ELEMENT_NOT_INTERACTABLE' },
    });
    const pageDown = await scroll(viewport.ref, 'down');
    expect(pageDown).toMatchObject({ ok: true, result: { moved: true } });
    expect(pageDown.result.deltaY).toBeGreaterThan(0);
    const trusted = await electronApp.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((entry) => entry.getURL() === url);
      return guest.executeJavaScript('document.body.dataset.trusted');
    }, FIXTURE_URL);
    expect(trusted).toBe('true');
    await execute(electronApp, 'browser_navigate', { tabId, url: `${FIXTURE_URL}?next` });
    expect(await scroll(viewport.ref, 'down')).toMatchObject({
      ok: false,
      error: { code: 'STALE_ELEMENT_REFERENCE' },
    });
  });
}

test('scroll targets stay inside visible same-origin frames and reject covered or detached containers', async ({
  electronApp,
  window,
  harness,
}) => {
  const tabId = await openFixture(
    { electronApp, window, harness },
    'hidden',
    `
    <style>body { margin:0 } iframe { width:400px; height:220px; border:3px solid }
      #cover { display:none; position:fixed; inset:0; z-index:10; background:white }
      #rtl { direction:rtl; width:300px; height:100px; overflow:auto }</style>
    <iframe name="Inner page" srcdoc="<style>body{margin:0}</style><div style='height:2000px'>Frame content</div>"></iframe>
    <div id="rtl" aria-label="RTL list"><div style="width:1000px;height:80px">Wide</div></div>
    <div id="cover">Cover</div>
    <script>document.addEventListener('wheel', () => document.body.dataset.wheels = String(Number(document.body.dataset.wheels || 0) + 1))</script>`
  );
  const first = await snapshot(electronApp, tabId);
  const frame = first.frames.find((entry) => entry.name === 'Inner page');
  expect(frame.viewport.vertical).toBe(true);
  const scroll = (ref, direction) =>
    execute(electronApp, 'browser_scroll', { tabId, ref, direction });
  expect(await scroll(frame.viewport.ref, 'down')).toMatchObject({
    ok: true,
    result: { moved: true },
  });
  const afterFrame = await snapshot(electronApp, tabId);
  expect(afterFrame.frames[0].viewport.y).toBe(first.frames[0].viewport.y);
  const rtl = named(afterFrame, 'RTL list');
  const left = await scroll(rtl.ref, 'left');
  expect(left).toMatchObject({ ok: true, result: { moved: true } });
  expect(left.result.deltaX).toBeLessThan(0);
  const mutateFixture = (script) =>
    electronApp.evaluate(
      async ({ webContents }, payload) => {
        const guest = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL() === payload.url);
        return guest.executeJavaScript(payload.script);
      },
      { url: FIXTURE_URL, script }
    );
  await mutateFixture("document.querySelector('#cover').style.display = 'block'");
  expect(await scroll(frame.viewport.ref, 'down')).toMatchObject({
    ok: false,
    error: { code: 'ELEMENT_NOT_INTERACTABLE' },
  });
  expect(await scroll(rtl.ref, 'left')).toMatchObject({
    ok: false,
    error: { code: 'ELEMENT_NOT_INTERACTABLE' },
  });
  await mutateFixture("document.querySelector('#rtl').remove()");
  expect(await scroll(rtl.ref, 'left')).toMatchObject({
    ok: false,
    error: { code: 'STALE_ELEMENT_REFERENCE' },
  });
});

test('literal text search retrieves bounded, frame-attributed excerpts without moving the page', async ({
  electronApp,
  window,
  harness,
}) => {
  const tabId = await openFixture(
    { electronApp, window, harness },
    'hidden',
    `
    <p>${'Intro '.repeat(3_000)}</p><p>İ 😀 Price (USD): $5.00 [today]</p>
    <p>${'Middle '.repeat(3_000)}</p><p>Price (USD): $5.00 [today]</p>
    <p hidden>Hidden sentinel</p>
    <iframe name="Footnotes" srcdoc="<p>Frame-only needle</p>"></iframe>`
  );
  const textQuery = 'PRICE (USD): $5.00 [today]';
  const first = await execute(electronApp, 'browser_snapshot', { tabId, textQuery });
  expect(first.ok).toBe(true);
  expect(first.result.textMatch.start).toBeGreaterThan(12_000);
  expect(first.result.textMatch.frameId).toBe('frame_main');
  expect(first.result.text).toContain('Price (USD): $5.00 [today]');
  expect(first.result.text.length).toBeLessThan(700);
  expect(first.result.frames[0].viewport.y).toBe(0);
  const next = await execute(electronApp, 'browser_snapshot', {
    tabId,
    textQuery,
    textOffset: first.result.nextMatchOffset,
    documentId: first.result.documentId,
    navigationId: first.result.navigationId,
  });
  expect(next.result.textMatch.start).toBeGreaterThan(first.result.textMatch.start);
  expect(next.result.text).toContain('Price (USD): $5.00 [today]');
  for (const missing of ['Hidden sentinel', '(a+)+$', 'Not in this document']) {
    const result = await execute(electronApp, 'browser_snapshot', { tabId, textQuery: missing });
    expect(result.result).toMatchObject({ textMatch: null, text: '' });
    expect(result.result).not.toHaveProperty('nextMatchOffset');
  }
  const frameMatch = await execute(electronApp, 'browser_snapshot', {
    tabId,
    textQuery: 'Frame-only needle',
  });
  expect(frameMatch.result.textMatch.frameId).toBe(
    frameMatch.result.frames.find((frame) => frame.name === 'Footnotes').frameId
  );
  expect(frameMatch.result.frames[0].viewport.y).toBe(0);
});

test('native dropdowns preserve disabled groups and support single-select listboxes', async ({
  electronApp,
  window,
  harness,
}) => {
  const tabId = await openFixture(
    { electronApp, window, harness },
    'hidden',
    `
    <label>Plan<select><option value="basic">Basic</option>
      <optgroup label="Unavailable" disabled><option value="restricted">Restricted</option></optgroup>
      <option value="pro">Pro</option></select></label>
    <label>Size<select size="3"><option value="small">Small</option><option value="large">Large</option></select></label>
    <label>Many<select multiple><option value="one">One</option><option value="two">Two</option></select></label>`
  );
  const first = await snapshot(electronApp, tabId);
  const plan = named(first, 'Plan');
  expect(plan.options.find((option) => option.value === 'restricted').disabled).toBe(true);
  expect(
    await execute(electronApp, 'browser_select', { tabId, ref: plan.ref, value: 'restricted' })
  ).toMatchObject({ ok: false, error: { code: 'ELEMENT_NOT_FOUND' } });
  expect(named(await snapshot(electronApp, tabId), 'Plan').value).toBe('basic');
  expect(named(first, 'Size').role).toBe('listbox');
  expect(
    await execute(electronApp, 'browser_select', {
      tabId,
      ref: named(first, 'Size').ref,
      value: 'large',
    })
  ).toMatchObject({ ok: true });
  expect(named(await snapshot(electronApp, tabId), 'Size').value).toBe('large');
  expect(
    await execute(electronApp, 'browser_select', {
      tabId,
      ref: named(first, 'Many').ref,
      value: 'two',
    })
  ).toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
});

for (const mode of ['desktop', 'hidden']) {
  test(`${mode} handles delayed custom menus and waits on the original control state`, async ({
    electronApp,
    window,
    harness,
  }) => {
    const tabId = await openFixture(
      { electronApp, window, harness },
      mode,
      `
      <button id="menu" aria-expanded="false" onclick="setTimeout(() => {
        this.setAttribute('aria-expanded', 'true'); document.querySelector('#choices').hidden = false;
      }, 200)">Choose colour</button>
      <div id="choices" role="listbox" hidden>
        <div role="option" aria-selected="false" tabindex="0" onclick="this.setAttribute('aria-selected', 'true');
          document.querySelector('#menu').setAttribute('aria-expanded', 'false'); this.parentElement.hidden = true;
          document.querySelector('#result').textContent = 'Selected Blue trusted=' + event.isTrusted;
          setTimeout(() => document.querySelector('#save').disabled = false, 200)">Blue</div>
      </div>
      <button id="save" disabled onclick="this.replaceWith(this.cloneNode(true))">Save choice</button>
      <label><input id="check" type="checkbox">Accept choice</label>
      <p id="result">Waiting</p>`
    );
    const initial = await snapshot(electronApp, tabId);
    const trigger = named(initial, 'Choose colour');
    const save = named(initial, 'Save choice');
    const waitState = (ref, state, timeoutMs = 2000) =>
      execute(electronApp, 'browser_wait', { tabId, condition: 'element', ref, state, timeoutMs });
    expect(await waitState(trigger.ref, 'collapsed')).toMatchObject({ ok: true });
    expect(await waitState(save.ref, 'disabled')).toMatchObject({ ok: true });
    expect(await execute(electronApp, 'browser_click', { tabId, ref: trigger.ref })).toMatchObject({
      ok: true,
    });
    expect(await waitState(trigger.ref, 'expanded')).toMatchObject({
      ok: true,
      result: { matched: true, state: 'expanded' },
    });
    const expanded = await snapshot(electronApp, tabId);
    const blue = expanded.elements.find(element => element.role === 'option' && element.name === 'Blue');
    expect(blue).toBeDefined();
    expect(await execute(electronApp, 'browser_click', { tabId, ref: blue.ref })).toMatchObject({
      ok: true,
    });
    expect(await waitState(blue.ref, 'hidden')).toMatchObject({ ok: true });
    expect(await waitState(save.ref, 'enabled')).toMatchObject({ ok: true });
    expect(
      await execute(electronApp, 'browser_wait', {
        tabId,
        condition: 'text',
        text: 'Selected Blue trusted=true',
      })
    ).toMatchObject({ ok: true });
    const check = named(initial, 'Accept choice');
    expect(await waitState(check.ref, 'unchecked')).toMatchObject({ ok: true });
    expect(await execute(electronApp, 'browser_click', { tabId, ref: check.ref })).toMatchObject({
      ok: true,
    });
    expect(await waitState(check.ref, 'checked')).toMatchObject({ ok: true });
    expect(await waitState(check.ref, 'unchecked', 100)).toMatchObject({
      ok: false,
      error: { code: 'WAIT_TIMEOUT' },
    });
    expect(await execute(electronApp, 'browser_click', { tabId, ref: save.ref })).toMatchObject({
      ok: true,
    });
    expect(await waitState(save.ref, 'hidden')).toMatchObject({ ok: true });
    expect(await waitState(save.ref, 'enabled', 100)).toMatchObject({
      ok: false,
      error: { code: 'WAIT_TIMEOUT' },
    });
    await execute(electronApp, 'browser_navigate', { tabId, url: `${FIXTURE_URL}?new` });
    expect(await waitState(check.ref, 'checked')).toMatchObject({
      ok: false,
      error: { code: 'STALE_ELEMENT_REFERENCE' },
    });
  });
}
