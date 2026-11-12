/**
 * Tests for the Radicle consent subscreen: it renders main's prompts for a
 * page's window.radicle requests (freedom-core design 0011) and answers
 * them by handle.
 */

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalDocument = global.document;

const loadConsent = async () => {
  jest.resetModules();

  const walletStateMocks = {
    registerScreenHider: jest.fn(),
    hideAllSubscreens: jest.fn(),
    walletState: { identityView: createElement('div') },
  };
  const sidebarMocks = {
    openForConsent: jest.fn(),
    close: jest.fn(),
    isVisible: jest.fn(() => false),
  };

  const elementsById = {
    'sidebar-radicle-consent': createElement('div', { classes: ['hidden'] }),
    'radicle-consent-title': createElement('h2'),
    'radicle-consent-site': createElement('div'),
    'radicle-consent-wants': createElement('div'),
    'radicle-consent-allows': createElement('ul'),
    'radicle-consent-warning': createElement('p'),
    'radicle-consent-always-row': createElement('label', { classes: ['hidden'] }),
    'radicle-consent-always': createElement('input'),
    'radicle-consent-always-label': createElement('span'),
    'radicle-consent-approve': createElement('button'),
    'radicle-consent-reject': createElement('button'),
    'radicle-consent-back': createElement('button'),
  };

  global.document = createDocument({ elementsById });

  jest.doMock('./wallet/wallet-state.js', () => walletStateMocks);
  jest.doMock('./sidebar.js', () => sidebarMocks);

  const mod = await import('./radicle-consent.js');
  const renderers = await import('./page-prompt-renderers.js');
  mod.initRadicleConsent();

  return { mod, elementsById, sidebarMocks, walletStateMocks, renderers };
};

// freedom-core design 0011, PRQ-8a: main's own prompt for a page's request
// (`radicle.connect`) shows in this screen, from main's site and view, and
// is answered by handle once its input protection has passed. The screen
// writes no grant.
describe('radicle-consent renders main\'s radicle.connect prompt', () => {
  const PROMPT = {
    handle: 'h'.repeat(64),
    guest: 7,
    kind: 'radicle.connect',
    site: { key: 'name.eth', label: 'name.eth' },
    view: {},
  };

  beforeEach(() => {
    jest.useFakeTimers();
    global.window = { pagePrompts: { decide: jest.fn(async () => ({ ok: true })) }, radiclePermissions: {} };
  });

  afterEach(() => {
    jest.useRealTimers();
    delete global.window;
    global.document = originalDocument;
  });

  test('it shows main\'s site, arms after the input-protection window, and answers the handle alone', async () => {
    const { elementsById, sidebarMocks, renderers } = await loadConsent();
    const renderer = renderers.pagePromptRenderer('radicle.connect');
    expect(renderer).toBeDefined();
    renderer.show(PROMPT);
    expect(elementsById['sidebar-radicle-consent'].classList.contains('hidden')).toBe(false);
    expect(elementsById['radicle-consent-site'].textContent).toBe('name.eth');
    expect(elementsById['radicle-consent-title'].textContent).toBe('Connect Radicle node?');
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(true);
    expect(sidebarMocks.openForConsent).toHaveBeenCalled();
    expect(renderer.isShowing()).toBe(PROMPT.handle);
    // A click inside the input-protection window does nothing.
    expect(elementsById['radicle-consent-approve'].disabled).toBe(true);
    elementsById['radicle-consent-approve'].dispatch('click');
    expect(window.pagePrompts.decide).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500);
    expect(elementsById['radicle-consent-approve'].disabled).toBe(false);
    elementsById['radicle-consent-approve'].dispatch('click');
    expect(window.pagePrompts.decide).toHaveBeenCalledWith(PROMPT.handle, true, {});
    expect(elementsById['sidebar-radicle-consent'].classList.contains('hidden')).toBe(true);
    expect(renderer.isShowing()).toBeNull();
    // A second click decides nothing more.
    elementsById['radicle-consent-approve'].dispatch('click');
    expect(window.pagePrompts.decide).toHaveBeenCalledTimes(1);
  });

  test('a rejection, the back button and a closed panel each answer false', async () => {
    for (const how of ['radicle-consent-reject', 'radicle-consent-back', 'sidebar-closed']) {
      const { elementsById, renderers } = await loadConsent();
      const renderer = renderers.pagePromptRenderer('radicle.connect');
      renderer.show(PROMPT);
      jest.advanceTimersByTime(500);
      if (how === 'sidebar-closed') document.handlers['sidebar-closed']();
      else elementsById[how].dispatch('click');
      expect({ how, calls: window.pagePrompts.decide.mock.calls }).toEqual({ how, calls: [[PROMPT.handle, false, {}]] });
      window.pagePrompts.decide.mockClear();
    }
  });

  test('main hiding or closing its prompt takes it down, deciding nothing', async () => {
    const { elementsById, renderers } = await loadConsent();
    const renderer = renderers.pagePromptRenderer('radicle.connect');
    renderer.show(PROMPT);
    renderer.close('another handle');
    expect(renderer.isShowing()).toBe(PROMPT.handle);
    renderer.close(PROMPT.handle);
    expect(renderer.isShowing()).toBeNull();
    expect(elementsById['sidebar-radicle-consent'].classList.contains('hidden')).toBe(true);
    jest.advanceTimersByTime(500);
    elementsById['radicle-consent-approve'].dispatch('click');
    expect(window.pagePrompts.decide).not.toHaveBeenCalled();
  });

  test('another screen taking the sidebar reports main\'s prompt displaced', async () => {
    const { walletStateMocks, renderers } = await loadConsent();
    const displaced = [];
    renderers.onPagePromptDisplaced((handle) => displaced.push(handle));
    const renderer = renderers.pagePromptRenderer('radicle.connect');
    renderer.show(PROMPT);
    // Its own transition is no dismissal.
    expect(displaced).toEqual([]);
    const hider = walletStateMocks.registerScreenHider.mock.calls[0][0];
    hider();
    expect(displaced).toEqual([PROMPT.handle]);
    expect(renderer.isShowing()).toBeNull();
    expect(window.pagePrompts.decide).not.toHaveBeenCalled();
  });

  // PRQ-8b: a seed or an unseed, naming its repository as main checked it.
  test('radicle.node shows the seed or unseed copy with main\'s repository id, and answers the handle alone', async () => {
    const rid = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
    const { elementsById, renderers } = await loadConsent();
    const renderer = renderers.pagePromptRenderer('radicle.node');
    expect(renderer).toBeDefined();
    renderer.show({ ...PROMPT, kind: 'radicle.node', view: { method: 'radicle_seed', rid } });
    expect(elementsById['radicle-consent-title'].textContent).toBe('Seed this repository?');
    expect(elementsById['radicle-consent-wants'].textContent).toBe(`asks your node to seed ${rid}`);
    expect(elementsById['radicle-consent-site'].textContent).toBe('name.eth');
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(true);
    jest.advanceTimersByTime(500);
    elementsById['radicle-consent-approve'].dispatch('click');
    expect(window.pagePrompts.decide).toHaveBeenCalledWith(PROMPT.handle, true, {});

    const unseed = { ...PROMPT, handle: 'u'.repeat(64), kind: 'radicle.node', view: { method: 'radicle_unseed', rid } };
    renderer.show(unseed);
    expect(elementsById['radicle-consent-title'].textContent).toBe('Stop seeding this repository?');
    expect(elementsById['radicle-consent-approve'].textContent).toBe('Stop seeding');
    jest.advanceTimersByTime(500);
    elementsById['radicle-consent-reject'].dispatch('click');
    expect(window.pagePrompts.decide).toHaveBeenLastCalledWith(unseed.handle, false, {});
  });

  test('a radicle.node view off its form shows nothing', async () => {
    const { elementsById, renderers } = await loadConsent();
    const renderer = renderers.pagePromptRenderer('radicle.node');
    for (const view of [{}, { method: 'radicle_seed' }, { method: 'radicle_sync', rid: 'rad:z1' }, { method: 'radicle_seed', rid: 42 }]) {
      renderer.show({ ...PROMPT, kind: 'radicle.node', view });
      expect({ view, hidden: elementsById['sidebar-radicle-consent'].classList.contains('hidden') }).toEqual({ view, hidden: true });
      expect(renderer.isShowing()).toBeNull();
    }
  });

  // PRQ-8c: the signing grant, and each signed write with what main signs.
  test('radicle.sign in grant mode shows the signing copy and answers with no choice', async () => {
    const { elementsById, renderers } = await loadConsent();
    const renderer = renderers.pagePromptRenderer('radicle.sign');
    renderer.show({ ...PROMPT, kind: 'radicle.sign', view: { mode: 'grant', method: 'radicle_getIdentity' } });
    expect(elementsById['radicle-consent-title'].textContent).toBe('Act as your Radicle identity?');
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(true);
    jest.advanceTimersByTime(500);
    elementsById['radicle-consent-approve'].dispatch('click');
    expect(window.pagePrompts.decide).toHaveBeenCalledWith(PROMPT.handle, true, {});
  });

  test('radicle.sign in write mode shows exactly main\'s fields, offers "always allow" and answers it on approval', async () => {
    const rid = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
    const { elementsById, renderers } = await loadConsent();
    const renderer = renderers.pagePromptRenderer('radicle.sign');
    renderer.show({
      ...PROMPT,
      kind: 'radicle.sign',
      view: { mode: 'write', method: 'radicle_createIssue', rid, title: '<b>Bug</b>', description: 'Steps', labels: ['ui'], agentHeld: false, alwaysAllow: true },
    });
    expect(elementsById['radicle-consent-title'].textContent).toBe('Open this issue as you?');
    expect(elementsById['radicle-consent-wants'].textContent).toBe(`asks to open an issue in ${rid}`);
    expect(elementsById['radicle-consent-allows'].children.map((li) => li.textContent)).toEqual([
      'Title: <b>Bug</b>',
      'Description: Steps',
      'Label: ui',
    ]);
    const warning = elementsById['radicle-consent-warning'].textContent;
    expect(warning).toContain('signed with your Radicle identity');
    expect(warning).toContain('public and permanent');
    expect(warning).not.toContain('Freedom Agent');
    expect(elementsById['radicle-consent-approve'].textContent).toBe('Open issue');
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(false);
    expect(elementsById['radicle-consent-always'].checked).toBe(true);
    elementsById['radicle-consent-always'].checked = false;
    jest.advanceTimersByTime(500);
    elementsById['radicle-consent-approve'].dispatch('click');
    expect(window.pagePrompts.decide).toHaveBeenCalledWith(PROMPT.handle, true, { alwaysAllow: false });
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(true);

    // Off when the rule is off; the box the user checks is the answer.
    const next = { ...PROMPT, handle: 'w'.repeat(64), kind: 'radicle.sign' };
    renderer.show({ ...next, view: { mode: 'write', method: 'radicle_commentIssue', rid, issueId: 'cccc', body: 'Hi', agentHeld: false, alwaysAllow: false } });
    expect(elementsById['radicle-consent-always'].checked).toBe(false);
    elementsById['radicle-consent-always'].checked = true;
    jest.advanceTimersByTime(500);
    elementsById['radicle-consent-approve'].dispatch('click');
    expect(window.pagePrompts.decide).toHaveBeenLastCalledWith(next.handle, true, { alwaysAllow: true });
  });

  test('radicle.sign in write mode names every parameter main signs with', async () => {
    const { elementsById, renderers } = await loadConsent();
    const renderer = renderers.pagePromptRenderer('radicle.sign');
    let n = 0;
    const show = (method, params) => {
      n += 1;
      renderer.show({ ...PROMPT, handle: String(n).repeat(64), kind: 'radicle.sign', view: { mode: 'write', method, ...params } });
      return {
        title: elementsById['radicle-consent-title'].textContent,
        wants: elementsById['radicle-consent-wants'].textContent,
        allows: elementsById['radicle-consent-allows'].children.map((li) => li.textContent),
      };
    };

    // commentPatch is signed against revisionId when given, not patchId.
    const patch = show('radicle_commentPatch', {
      rid: 'rad:zExample',
      patchId: 'aaaa',
      revisionId: 'bbbb',
      body: 'LGTM',
    });
    expect(patch.wants).toBe(
      'asks to comment on revision bbbb (the page says it belongs to patch aaaa) in rad:zExample'
    );
    expect(patch.allows).toEqual(['Comment: LGTM']);
    const plainPatch = show('radicle_commentPatch', { rid: 'rad:zExample', patchId: 'aaaa', body: 'x' });
    expect(plainPatch.wants).toBe('asks to comment on patch aaaa in rad:zExample');

    const labelled = show('radicle_createIssue', {
      rid: 'rad:zExample',
      title: 'T',
      description: 'D',
      labels: ['bug', 'a, b'],
    });
    expect(labelled.allows).toEqual(['Title: T', 'Description: D', 'Label: bug', 'Label: a, b']);

    const reply = show('radicle_commentIssue', {
      rid: 'rad:zExample',
      issueId: 'cccc',
      body: 'Me too',
      replyTo: 'dddd',
    });
    expect(reply.allows).toEqual(['Comment: Me too', 'In reply to comment dddd']);

    const state = show('radicle_editIssueState', { rid: 'rad:zExample', issueId: 'cccc', state: 'closed' });
    expect(state).toEqual({
      title: 'Change this issue as you?',
      wants: 'asks to change issue cccc in rad:zExample',
      allows: ['Set its state to closed'],
    });
  });

  test('radicle.sign for a tab in Agent custody offers no rule, says so, and answers with no choice', async () => {
    const { elementsById, renderers } = await loadConsent();
    const renderer = renderers.pagePromptRenderer('radicle.sign');
    renderer.show({
      ...PROMPT,
      kind: 'radicle.sign',
      view: { mode: 'write', method: 'radicle_commentPatch', rid: 'rad:z1', patchId: 'b'.repeat(40), body: 'LGTM', agentHeld: true, alwaysAllow: false },
    });
    expect(elementsById['radicle-consent-warning'].textContent).toMatch(/^Freedom Agent is using this tab\. /);
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(true);
    jest.advanceTimersByTime(500);
    elementsById['radicle-consent-approve'].dispatch('click');
    expect(window.pagePrompts.decide).toHaveBeenCalledWith(PROMPT.handle, true, {});
  });

  test('a radicle.sign view off its form shows nothing', async () => {
    const { elementsById, renderers } = await loadConsent();
    const renderer = renderers.pagePromptRenderer('radicle.sign');
    for (const view of [{}, { mode: 'write', method: 'radicle_seed', rid: 'rad:z1' }, { mode: 'write', method: 'radicle_somethingNew', rid: 'rad:z1' }, { mode: 'other' }]) {
      renderer.show({ ...PROMPT, kind: 'radicle.sign', view });
      expect({ view, hidden: elementsById['sidebar-radicle-consent'].classList.contains('hidden') }).toEqual({ view, hidden: true });
    }
  });

  test('a kind it doesn\'t render shows nothing', async () => {
    const { elementsById, renderers } = await loadConsent();
    expect(renderers.pagePromptRenderer('eth.sign')).toBeUndefined();
    renderers.pagePromptRenderer('radicle.connect').show({ ...PROMPT, kind: 'eth.sign' });
    expect(elementsById['sidebar-radicle-consent'].classList.contains('hidden')).toBe(true);
  });
});
