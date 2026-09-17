'use strict';

// Disposable research harness only. No product tool exposes CDP or these script
// bodies. This qualifies frame routing primitives before policy integration.
const { test, expect } = require('./fixtures');

const ROOT_URL = 'https://frame-owner.test/root';
const CHILD_URL = 'https://frame-content.test/child';

test('prototype discovers owned cross-origin frames through native and debugger identities', async ({
  electronApp,
  window,
  harness,
}) => {
  await expect(window.locator('body')).toBeVisible();
  await harness.setContentFixture(CHILD_URL, {
    body: `<!doctype html><label for="name">Framed name</label>
    <input id="name"><script>globalThis.pageOnlyMarker = 'page-world';
      Document.prototype.querySelector = () => { throw new Error('Page-world override') }; </script>`,
  });
  await harness.setContentFixture(`${CHILD_URL}?next`, {
    body: '<!doctype html><title>Replacement</title><p>Replacement document</p>',
  });
  await harness.setContentFixture(ROOT_URL, {
    body: `<!doctype html><h1>Owner</h1>
    <iframe name="Embedded form" src="${CHILD_URL}"></iframe>`,
  });
  const tabId = await electronApp.evaluate(
    (_electron, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
    ROOT_URL
  );
  const observation = await electronApp.evaluate(
    (_electron, tabId) =>
      globalThis.__FREEDOM_TEST_HARNESS__.automationExecute('browser_snapshot', { tabId }),
    tabId
  );
  expect(observation.ok).toBe(true);
  expect(observation.result.frames.find((frame) => frame.url === CHILD_URL).accessible).toBe(false);
  expect(observation.result.elements.some((element) => element.name === 'Framed name')).toBe(false);
  const discovery = await electronApp.evaluate(async ({ webContents }, url) => {
    const owner = webContents.getAllWebContents().find((entry) => entry.getURL() === url);
    const native = owner.mainFrame.framesInSubtree.map((frame) => ({
      url: frame.url,
      origin: frame.origin,
      frameTreeNodeId: frame.frameTreeNodeId,
      processId: frame.processId,
      routingId: frame.routingId,
      parentId: frame.parent?.frameTreeNodeId ?? null,
      isolatedMethod: typeof frame.executeJavaScriptInIsolatedWorld,
    }));
    const sessions = [];
    const contexts = [];
    const onMessage = (_event, method, params, sessionId) => {
      if (method === 'Runtime.executionContextCreated')
        contexts.push({ ...params.context, sessionId });
      if (method === 'Target.attachedToTarget')
        sessions.push({
          sessionId: params.sessionId,
          type: params.targetInfo.type,
          url: params.targetInfo.url,
        });
    };
    owner.debugger.attach('1.3');
    owner.debugger.on('message', onMessage);
    try {
      await owner.debugger.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      const tree = await owner.debugger.sendCommand('Page.getFrameTree');
      const frames = [];
      const visit = (branch) => {
        frames.push(branch.frame);
        for (const child of branch.childFrames || []) visit(child);
      };
      visit(tree.frameTree);
      const childSession = sessions.find((session) => session.type === 'iframe');
      if (!childSession) throw new Error('Missing child debugger session');
      const childTree = await owner.debugger.sendCommand(
        'Page.getFrameTree',
        {},
        childSession.sessionId
      );
      const childFrame = childTree.frameTree.frame;
      await owner.debugger.sendCommand('Runtime.enable', {}, childSession.sessionId);
      const world = await owner.debugger.sendCommand(
        'Page.createIsolatedWorld',
        {
          frameId: childFrame.id,
          worldName: 'freedom-frame-prototype',
          grantUniveralAccess: false,
        },
        childSession.sessionId
      );
      const context = contexts.find(
        (context) =>
          context.sessionId === childSession.sessionId && context.id === world.executionContextId
      );
      if (!context?.uniqueId) throw new Error('Missing unique execution-context identity');
      const expression = `(() => {
        let parentAccessible = false;
        try { parentAccessible = Boolean(parent.document.body) } catch {}
        return { label: document.querySelector('label').textContent,
          pageGlobal: typeof globalThis.pageOnlyMarker, parentAccessible, origin: location.origin };
      })()`;
      const read = await owner.debugger.sendCommand(
        'Runtime.evaluate',
        {
          expression,
          uniqueContextId: context.uniqueId,
          returnByValue: true,
          timeout: 1000,
        },
        childSession.sessionId
      );
      if (read.exceptionDetails) throw new Error('Isolated observation failed');
      // Navigation is fixture setup only. Keep the old unique context and verify
      // that it cannot silently address the replacement document.
      const navigated = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          owner.removeListener('did-frame-navigate', onNavigation);
          reject(new Error('Frame navigation did not finish within the probe bound'));
        }, 2000);
        const onNavigation = (_event, _url, _code, _status, main) => {
          if (main) return;
          owner.removeListener('did-frame-navigate', onNavigation);
          clearTimeout(timer);
          resolve();
        };
        owner.on('did-frame-navigate', onNavigation);
      });
      await owner.mainFrame.executeJavaScript(
        `document.querySelector('iframe').src = '${childFrame.url}?next'`
      );
      await navigated;
      const afterTree = await owner.debugger.sendCommand(
        'Page.getFrameTree',
        {},
        childSession.sessionId
      );
      let oldContextRejected = false;
      try {
        await owner.debugger.sendCommand(
          'Runtime.evaluate',
          {
            expression: 'document.title',
            uniqueContextId: context.uniqueId,
            returnByValue: true,
            timeout: 1000,
          },
          childSession.sessionId
        );
      } catch {
        oldContextRejected = true;
      }
      const contextBeforeNavigation = context.uniqueId;
      const replacementWorld = await owner.debugger.sendCommand(
        'Page.createIsolatedWorld',
        {
          frameId: afterTree.frameTree.frame.id,
          worldName: 'freedom-frame-prototype',
          grantUniveralAccess: false,
        },
        childSession.sessionId
      );
      const replacementContext = contexts.find(
        (context) =>
          context.sessionId === childSession.sessionId &&
          context.id === replacementWorld.executionContextId &&
          context.uniqueId !== contextBeforeNavigation
      );
      if (!replacementContext) throw new Error('Missing replacement context');
      const detached = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          owner.debugger.removeListener('message', onDetach);
          reject(new Error('Frame detach timed out'));
        }, 2000);
        const onDetach = (_event, method, params) => {
          if (method !== 'Target.detachedFromTarget' || params.sessionId !== childSession.sessionId)
            return;
          clearTimeout(timer);
          owner.debugger.removeListener('message', onDetach);
          resolve();
        };
        owner.debugger.on('message', onDetach);
      });
      await owner.mainFrame.executeJavaScript("document.querySelector('iframe').remove()");
      await detached;
      let removedContextRejected = false;
      try {
        await owner.debugger.sendCommand(
          'Runtime.evaluate',
          {
            expression: 'document.title',
            uniqueContextId: replacementContext.uniqueId,
            returnByValue: true,
          },
          childSession.sessionId
        );
      } catch {
        removedContextRejected = true;
      }
      return {
        native,
        afterUrl: afterTree.frameTree.frame.url,
        removedContextRejected,
        remainingNativeFrames: owner.mainFrame.framesInSubtree.length,
        rootFrames: frames.map((frame) => frame.url),
        childOrigin: childFrame.securityOrigin,
        isolated: read.result.value,
        oldContextRejected,
      };
    } finally {
      owner.debugger.removeListener('message', onMessage);
      owner.debugger.detach();
    }
  }, ROOT_URL);
  expect(discovery.rootFrames).not.toContain(CHILD_URL);
  expect(discovery.isolated).toEqual({
    label: 'Framed name',
    pageGlobal: 'undefined',
    parentAccessible: false,
    origin: 'https://frame-content.test',
  });
  expect(discovery.oldContextRejected).toBe(true);
  expect(discovery.afterUrl).toBe(`${CHILD_URL}?next`);
  expect(discovery.removedContextRejected).toBe(true);
  expect(discovery.remainingNativeFrames).toBe(1);
  expect(discovery.native.every((frame) => frame.isolatedMethod === 'undefined')).toBe(true);
  expect(discovery.native.find((frame) => frame.url === CHILD_URL).origin).toBe(
    'https://frame-content.test'
  );
});

test('native frame ownership distinguishes duplicate URLs, foreign tabs and opaque origins', async ({
  electronApp,
  window,
  harness,
}) => {
  await expect(window.locator('body')).toBeVisible();
  await harness.setContentFixture(CHILD_URL, { body: '<!doctype html><p>Same resource</p>' });
  await harness.setContentFixture(ROOT_URL, {
    body: `<!doctype html>
    <iframe name="First" src="${CHILD_URL}"></iframe><iframe name="Second" src="${CHILD_URL}"></iframe>
    <iframe name="Opaque" sandbox src="${CHILD_URL}"></iframe>`,
  });
  const otherUrl = 'https://other-owner.test/root';
  await harness.setContentFixture(otherUrl, {
    body: `<!doctype html><iframe name="Foreign" src="${CHILD_URL}"></iframe>`,
  });
  for (const url of [ROOT_URL, otherUrl])
    await electronApp.evaluate(
      (_electron, url) => globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url),
      url
    );
  const ownership = await electronApp.evaluate(
    ({ webContents }, { rootUrl, otherUrl }) => {
      const root = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL() === rootUrl).mainFrame;
      const other = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL() === otherUrl).mainFrame;
      const owns = (frame) => frame.top === root && root.framesInSubtree.includes(frame);
      return {
        children: root.frames.map((frame) => ({
          name: frame.name,
          url: frame.url,
          origin: frame.origin,
          id: frame.frameTreeNodeId,
          owned: owns(frame),
        })),
        foreignOwned: owns(other.frames[0]),
      };
    },
    { rootUrl: ROOT_URL, otherUrl }
  );
  expect(ownership.children).toHaveLength(3);
  expect(ownership.children.every((child) => child.owned)).toBe(true);
  expect(new Set(ownership.children.map((child) => child.id)).size).toBe(3);
  expect(new Set(ownership.children.map((child) => child.url)).size).toBe(1);
  expect(ownership.children.find((child) => child.name === 'Opaque').origin).toBe('null');
  expect(ownership.foreignOwned).toBe(false);
});
