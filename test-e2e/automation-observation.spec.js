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
