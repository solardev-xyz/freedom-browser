/**
 * Settings → Nodes, under the external Swarm node (freedom-core design 0015,
 * Messaging, question 4; SWM-7's PR 7.5): "Settings > Nodes says the same
 * under the external Swarm node, on the same condition". Main words it and
 * says when (src/main/swarm/subscription-route-notices.js: an external node
 * not on loopback that the session reaches through a proxy or Tor); the page
 * shows main's `settings` text under the Swarm row while that row is on
 * "Use external node".
 *
 * As the other Settings tests do, the helpers are lifted out of the shipped
 * page script and evaluated, so the assertions are on the real code.
 */

const fs = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'settings.js'), 'utf8');
const PRELOAD = fs.readFileSync(
  path.join(__dirname, '..', '..', 'main', 'webview-preload.js'),
  'utf8'
);

const TOR = {
  panel: 'Live messages are off while Tor is on: they would go around it to your external node',
  settings: 'Live messages are off while Tor is on: they would go around it to your external node.',
};
const PROXY = {
  panel: 'Live messages are off while your proxy is on: they would go around it to your external node',
  settings: 'Live messages are off while your proxy is on: they would go around it to your external node.',
};
const OFF = { panel: null, settings: null };

function loadHelpers({ freedomAPI = {}, profileFields = {} } = {}) {
  const start = SCRIPT.indexOf('let swarmMessagesRoute = null;');
  expect(start).toBeGreaterThanOrEqual(0);
  const refreshAt = SCRIPT.indexOf('const refreshSwarmMessagesRoute = ', start);
  expect(refreshAt).toBeGreaterThan(start);
  const end = SCRIPT.indexOf('\n};\n', refreshAt) + '\n};\n'.length;
  const body = SCRIPT.slice(start, end);
  return new Function(
    'freedomAPI',
    'profileFields',
    `${body}\nreturn { setRoute: (route) => { swarmMessagesRoute = route; }, takeSwarmMessagesRoute, messagesOffText, applyMessagesOffNote, refreshSwarmMessagesRoute };`
  )(freedomAPI, profileFields);
}

function row(protocol = 'bee') {
  const note = { id: `profile-${protocol}-messages-off-note`, textContent: '', hidden: true };
  const field = {
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
  };
  return {
    dataset: { protocol },
    note,
    field,
    querySelector: (selector) =>
      selector === '[data-messages-off-note]'
        ? note
        : selector === '[data-endpoint-field]'
          ? field
          : null,
  };
}

describe('the live messages note under the external Swarm node', () => {
  test("shown with main's words under a Swarm row on external, Tor or proxy as main says", () => {
    const helpers = loadHelpers();
    for (const route of [TOR, PROXY]) {
      helpers.setRoute(route);
      const swarm = row();
      helpers.applyMessagesOffNote(swarm, 'external');
      expect(swarm.note.hidden).toBe(false);
      expect(swarm.note.textContent).toBe(route.settings);
      // It describes the node's endpoint field while it shows.
      expect(swarm.field.attributes['aria-describedby']).toBe(swarm.note.id);
    }
  });

  test('hidden while main says nothing: a node on loopback, the bundled node, a direct route', () => {
    const helpers = loadHelpers();
    for (const route of [OFF, null, undefined, {}, { settings: 7 }]) {
      helpers.setRoute(route);
      const swarm = row();
      helpers.applyMessagesOffNote(swarm, 'external');
      expect(swarm.note.hidden).toBe(true);
      expect(swarm.note.textContent).toBe('');
      expect(swarm.field.attributes['aria-describedby']).toBeUndefined();
    }
  });

  test('never under a row not on external, nor under another node', () => {
    const helpers = loadHelpers();
    helpers.setRoute(PROXY);
    for (const mode of ['managed', 'disabled', undefined]) {
      const swarm = row();
      helpers.applyMessagesOffNote(swarm, mode);
      expect(swarm.note.hidden).toBe(true);
    }
    expect(helpers.messagesOffText('ipfs', 'external')).toBe('');
    expect(helpers.messagesOffText('tor', 'external')).toBe('');
  });

  test('it updates as main changes its answer, and a row switched off external hides it', () => {
    const helpers = loadHelpers();
    const swarm = row();
    helpers.setRoute(PROXY);
    helpers.applyMessagesOffNote(swarm, 'external');
    expect(swarm.note.textContent).toBe(PROXY.settings);
    helpers.setRoute(TOR);
    helpers.applyMessagesOffNote(swarm, 'external');
    expect(swarm.note.textContent).toBe(TOR.settings);
    helpers.applyMessagesOffNote(swarm, 'managed');
    expect(swarm.note.hidden).toBe(true);
    expect(swarm.field.attributes['aria-describedby']).toBeUndefined();
    helpers.setRoute(OFF);
    helpers.applyMessagesOffNote(swarm, 'external');
    expect(swarm.note.hidden).toBe(true);
  });

  test('the Swarm row renders the note, hidden, and only the Swarm row', () => {
    expect(SCRIPT).toContain(
      "${protocol === 'bee' ? `<p class=\"profile-node-note\" id=\"profile-bee-messages-off-note\" data-messages-off-note hidden></p>` : ''}"
    );
    // Filled in after each render, from each row's own mode select, and
    // again when the select changes.
    expect(SCRIPT).toMatch(
      /profileFields\.nodesCard\.innerHTML = rows\.join\(''\);\n\s+for \(const row of profileFields\.nodesCard\.querySelectorAll\('\.profile-node'\)\) \{\n\s+applyMessagesOffNote\(row, row\.querySelector\('\[data-node-mode\]'\)\?\.value\);/
    );
    expect(SCRIPT).toContain('  applyMessagesOffNote(row, modeSelect.value);\n  commitNodeRow(row);');
  });

  test("main's answer is read at each refresh but apart from the section, so neither holds the other back", () => {
    const refresh = SCRIPT.slice(SCRIPT.indexOf('const refreshProfileSection = '));
    const body = refresh.slice(0, refresh.indexOf('\n};\n'));
    expect(body).not.toContain('getSwarmMessagesRoute');
    // Started before the focus guard, so a focused Nodes control holds back
    // the section's render but never the route poll (Codex round 5).
    const routeAt = body.indexOf('refreshSwarmMessagesRoute();');
    const guardAt = body.indexOf('document.activeElement');
    expect(routeAt).toBeGreaterThan(0);
    expect(guardAt).toBeGreaterThan(routeAt);
    expect(body.match(/refreshSwarmMessagesRoute\(\);/g)).toHaveLength(1);
    // Settings only, as the policy has it.
    expect(PRELOAD).toMatch(
      /getSwarmMessagesRoute: guardSettingsPage\('getSwarmMessagesRoute', \(\) =>\s+ipcRenderer\.invoke\('swarm:messages-route-get'\)/
    );
  });

  test('route reads slower than the poll each land, the newest kept (Codex round 4 on #1382)', async () => {
    const pending = [];
    const swarm = row();
    swarm.querySelector = ((inner) => (selector) =>
      selector === '[data-node-mode]' ? { value: 'external' } : inner(selector))(swarm.querySelector);
    const helpers = loadHelpers({
      freedomAPI: { getSwarmMessagesRoute: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
      profileFields: { nodesCard: { querySelector: () => swarm } },
    });
    // Three polls start before any read settles, as a route test slower
    // than the 5 s poll gives.
    const reads = [helpers.refreshSwarmMessagesRoute(), helpers.refreshSwarmMessagesRoute(), helpers.refreshSwarmMessagesRoute()];
    // The second lands first, then the third, then the first, late.
    pending[1].resolve({ ...PROXY, revision: 2 });
    await reads[1];
    expect(swarm.note.textContent).toBe(PROXY.settings);
    pending[2].resolve({ ...TOR, revision: 3 });
    await reads[2];
    expect(swarm.note.textContent).toBe(TOR.settings);
    pending[0].resolve({ ...OFF, revision: 1 });
    await reads[0];
    // The late, older answer is dropped: the note keeps the newest.
    expect(swarm.note.hidden).toBe(false);
    expect(swarm.note.textContent).toBe(TOR.settings);
    // A failed read keeps it too.
    const failed = helpers.refreshSwarmMessagesRoute();
    pending[3].reject(new Error('gone'));
    await failed;
    expect(swarm.note.textContent).toBe(TOR.settings);
  });

  test('a focused Nodes control holds back the section render, never the route poll (Codex round 5)', async () => {
    const start = SCRIPT.indexOf('let swarmMessagesRoute = null;');
    const refreshAt = SCRIPT.indexOf('const refreshSwarmMessagesRoute = ', start);
    const helpers = SCRIPT.slice(start, SCRIPT.indexOf('\n};\n', refreshAt) + '\n};\n'.length);
    const sectionAt = SCRIPT.indexOf('const refreshProfileSection = ');
    const section = SCRIPT.slice(sectionAt, SCRIPT.indexOf('\n};\n', sectionAt) + '\n};\n'.length);
    const focused = { id: 'profile-bee-api' };
    const swarm = row();
    swarm.querySelector = ((inner) => (selector) =>
      selector === '[data-node-mode]' ? { value: 'external' } : inner(selector))(swarm.querySelector);
    const nodesCard = { contains: (el) => el === focused, querySelector: () => swarm };
    const freedomAPI = {
      getSwarmMessagesRoute: jest.fn(async () => ({ ...PROXY, revision: 1 })),
      getActiveProfile: jest.fn(async () => ({})),
      getServiceRegistry: jest.fn(async () => ({})),
      getSettings: jest.fn(async () => ({})),
    };
    const run = new Function(
      'freedomAPI',
      'profileFields',
      'document',
      `let profileRefreshSeq = 0; let activeProfileId = null; let savedProfileName = '';
       const nodeDrafts = new Map(); const renderProfileNodes = () => {};
       ${helpers}\n${section}\nreturn refreshProfileSection;`
    )(freedomAPI, { nodesCard, nameInput: null }, { activeElement: focused });
    await run();
    await new Promise((resolve) => setImmediate(resolve));
    // The section skipped its render while the field has focus...
    expect(freedomAPI.getActiveProfile).not.toHaveBeenCalled();
    // ...but main's route was read and the note set from it.
    expect(freedomAPI.getSwarmMessagesRoute).toHaveBeenCalledTimes(1);
    expect(swarm.note.hidden).toBe(false);
    expect(swarm.note.textContent).toBe(PROXY.settings);
  });
});
