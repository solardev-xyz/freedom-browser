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

function loadHelpers() {
  const start = SCRIPT.indexOf('let swarmMessagesRoute = null;');
  expect(start).toBeGreaterThanOrEqual(0);
  const applyAt = SCRIPT.indexOf('const applyMessagesOffNote = ', start);
  expect(applyAt).toBeGreaterThan(start);
  const end = SCRIPT.indexOf('\n};\n', applyAt) + '\n};\n'.length;
  const body = SCRIPT.slice(start, end);
  return new Function(
    `${body}\nreturn { setRoute: (route) => { swarmMessagesRoute = route; }, messagesOffText, applyMessagesOffNote };`
  )();
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

  test("main's answer is read with the rest of the section, every refresh, keeping the last on a failure", () => {
    expect(SCRIPT).toContain(
      'freedomAPI.getSwarmMessagesRoute?.().catch(() => swarmMessagesRoute),'
    );
    expect(SCRIPT).toContain('swarmMessagesRoute = messagesRoute ?? null;');
    // Settings only, as the policy has it.
    expect(PRELOAD).toMatch(
      /getSwarmMessagesRoute: guardSettingsPage\('getSwarmMessagesRoute', \(\) =>\s+ipcRenderer\.invoke\('swarm:messages-route-get'\)/
    );
  });
});
