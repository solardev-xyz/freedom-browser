/**
 * Tests for the Radicle consent subscreen — specifically the owner binding:
 * a pending prompt is owned by the webview whose document requested it, and
 * dismissRadicleConsent(owner) rejects it only for that owner (used when the
 * requesting document navigates away or its tab closes).
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
  mod.initRadicleConsent();

  return { mod, elementsById, sidebarMocks };
};

describe('radicle-consent owner binding', () => {
  afterEach(() => {
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('dismissRadicleConsent(owner) rejects the pending prompt of that owner', async () => {
    const { mod, elementsById } = await loadConsent();
    const owner = createElement('webview');

    const promptPromise = mod.showRadicleConnect('https://app.example', owner);
    mod.dismissRadicleConsent(owner);

    await expect(promptPromise).rejects.toEqual({
      code: 4001,
      message: 'User rejected the request',
    });
    expect(elementsById['sidebar-radicle-consent'].classList.contains('hidden')).toBe(true);
  });

  test('dismissRadicleConsent with a different owner is a no-op', async () => {
    const { mod, elementsById } = await loadConsent();
    const owner = createElement('webview');
    const otherWebview = createElement('webview');

    const promptPromise = mod.showRadicleSigningApproval('https://app.example', owner);
    let settled = false;
    promptPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    mod.dismissRadicleConsent(otherWebview);
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(elementsById['sidebar-radicle-consent'].classList.contains('hidden')).toBe(false);

    // Approval still works afterwards — the prompt was untouched.
    elementsById['radicle-consent-approve'].dispatch('click');
    await expect(promptPromise).resolves.toBeUndefined();
  });

  test('dismissRadicleConsent without a pending prompt is a no-op', async () => {
    const { mod } = await loadConsent();
    expect(() => mod.dismissRadicleConsent(createElement('webview'))).not.toThrow();
  });

  test('the per-write prompt shows the exact content to be signed', async () => {
    const { mod, elementsById } = await loadConsent();
    const owner = createElement('webview');

    const promptPromise = mod.showRadicleSignedWriteApproval(
      'https://app.example',
      'radicle_createIssue',
      { rid: 'rad:zExample', title: '<b>Bug</b>', description: 'Steps to reproduce' },
      owner
    );

    expect(elementsById['radicle-consent-title'].textContent).toBe('Open this issue as you?');
    expect(elementsById['radicle-consent-wants'].textContent).toBe(
      'asks to open an issue in rad:zExample'
    );
    expect(elementsById['radicle-consent-allows'].children.map((li) => li.textContent)).toEqual([
      'Title: <b>Bug</b>',
      'Description: Steps to reproduce',
    ]);
    const warning = elementsById['radicle-consent-warning'].textContent;
    expect(warning).toContain('signed with your Radicle identity');
    expect(warning).toContain('public and permanent');
    expect(warning).not.toContain('Freedom Agent');
    expect(elementsById['radicle-consent-approve'].textContent).toBe('Open issue');
    expect(elementsById['sidebar-radicle-consent'].classList.contains('hidden')).toBe(false);
    // The site's "always allow writes" rule is offered, off.
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(false);
    expect(elementsById['radicle-consent-always-label'].textContent).toContain('Always allow');
    expect(elementsById['radicle-consent-always'].checked).toBe(false);

    elementsById['radicle-consent-approve'].dispatch('click');
    await expect(promptPromise).resolves.toEqual({ alwaysAllow: false });
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(true);
  });

  test('the per-write prompt reports the "always allow" checkbox as approved', async () => {
    const { mod, elementsById } = await loadConsent();
    const owner = createElement('webview');
    const params = { rid: 'rad:zExample', issueId: 'cccc', body: 'Hi' };

    // Shown because main's limit stopped an automatic write: the box is checked.
    let promptPromise = mod.showRadicleSignedWriteApproval(
      'https://app.example',
      'radicle_commentIssue',
      params,
      owner,
      { alwaysAllow: true }
    );
    expect(elementsById['radicle-consent-always'].checked).toBe(true);
    elementsById['radicle-consent-always'].checked = false;
    elementsById['radicle-consent-approve'].dispatch('click');
    await expect(promptPromise).resolves.toEqual({ alwaysAllow: false });

    promptPromise = mod.showRadicleSignedWriteApproval(
      'https://app.example',
      'radicle_commentIssue',
      params,
      owner
    );
    elementsById['radicle-consent-always'].checked = true;
    elementsById['radicle-consent-approve'].dispatch('click');
    await expect(promptPromise).resolves.toEqual({ alwaysAllow: true });
  });

  test('on a tab in Agent custody the per-write prompt offers no rule', async () => {
    const { mod, elementsById } = await loadConsent();
    const owner = createElement('webview');

    const promptPromise = mod.showRadicleSignedWriteApproval(
      'https://app.example',
      'radicle_createIssue',
      { rid: 'rad:zExample', title: 'Bug', description: 'Steps' },
      owner,
      { agentHeld: true }
    );

    const warning = elementsById['radicle-consent-warning'].textContent;
    expect(warning).toContain('Freedom Agent');
    expect(warning).toContain('public and permanent');
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(true);

    elementsById['radicle-consent-approve'].dispatch('click');
    await expect(promptPromise).resolves.toBeUndefined();
  });

  test('other prompts never show the "always allow" checkbox', async () => {
    const { mod, elementsById } = await loadConsent();
    const owner = createElement('webview');

    const promptPromise = mod.showRadicleSigningApproval('https://app.example', owner);
    expect(elementsById['radicle-consent-always-row'].classList.contains('hidden')).toBe(true);
    elementsById['radicle-consent-approve'].dispatch('click');
    await expect(promptPromise).resolves.toBeUndefined();
  });

  test('the per-write prompt names every parameter main signs with', async () => {
    const { mod, elementsById } = await loadConsent();
    const owner = createElement('webview');
    const lines = () => elementsById['radicle-consent-allows'].children.map((li) => li.textContent);
    const show = (method, params) => {
      const promptPromise = mod.showRadicleSignedWriteApproval(
        'https://app.example',
        method,
        params,
        owner
      );
      const seen = {
        title: elementsById['radicle-consent-title'].textContent,
        wants: elementsById['radicle-consent-wants'].textContent,
        allows: lines(),
      };
      elementsById['radicle-consent-approve'].dispatch('click');
      return promptPromise.then(() => seen);
    };

    // commentPatch is signed against revisionId when given, not patchId.
    const patch = await show('radicle_commentPatch', {
      rid: 'rad:zExample',
      patchId: 'aaaa',
      revisionId: 'bbbb',
      body: 'LGTM',
    });
    expect(patch.wants).toBe(
      'asks to comment on revision bbbb (the page says it belongs to patch aaaa) in rad:zExample'
    );
    expect(patch.allows).toEqual(['Comment: LGTM']);
    const plainPatch = await show('radicle_commentPatch', {
      rid: 'rad:zExample',
      patchId: 'aaaa',
      body: 'x',
    });
    expect(plainPatch.wants).toBe('asks to comment on patch aaaa in rad:zExample');

    const labelled = await show('radicle_createIssue', {
      rid: 'rad:zExample',
      title: 'T',
      description: 'D',
      labels: ['bug', 'a, b'],
    });
    expect(labelled.allows).toEqual(['Title: T', 'Description: D', 'Label: bug', 'Label: a, b']);

    const reply = await show('radicle_commentIssue', {
      rid: 'rad:zExample',
      issueId: 'cccc',
      body: 'Me too',
      replyTo: 'dddd',
    });
    expect(reply.allows).toEqual(['Comment: Me too', 'In reply to comment dddd']);

    // An unknown signed write never borrows another method's summary.
    const unknown = await show('radicle_somethingNew', { rid: 'rad:zExample', x: 1 });
    expect(unknown.title).toBe('Sign this as you?');
    expect(unknown.allows).toEqual(['Parameters: {"rid":"rad:zExample","x":1}']);
  });
});
