const { test, expect } = require('./fixtures');

test('Agent, wallet, and menu actions remain on the address-bar row', async ({ window }) => {
  const geometry = await window.evaluate(() => {
    const rect = (selector) => {
      const { top, bottom, height } = document.querySelector(selector).getBoundingClientRect();
      return { top, bottom, center: top + height / 2 };
    };
    return {
      toolbar: rect('.toolbar'),
      address: rect('[data-test="address-input"]'),
      agent: rect('[data-test="agent-toggle-btn"]'),
      wallet: rect('#wallet-toggle-btn'),
      menu: rect('#menu-button'),
    };
  });

  expect(Math.abs(geometry.agent.center - geometry.address.center)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.wallet.center - geometry.address.center)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.menu.center - geometry.address.center)).toBeLessThanOrEqual(1);
  expect(geometry.menu.top).toBeGreaterThanOrEqual(geometry.toolbar.top);
  expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.toolbar.bottom);
});

test('Agent sidebar configures hosted and local models and reports the run lifecycle', async ({
  window,
}) => {
  const toggle = window.locator('[data-test="agent-toggle-btn"]');
  const panel = window.locator('#agent-sidebar');

  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(panel).not.toHaveClass(/collapsed/);
  await expect(window.locator('#agent-setup-view')).toBeVisible();
  await expect(window.locator('#agent-workspace-view')).toBeHidden();
  await expect(window.locator('#agent-sidebar-title')).toHaveText('Set up Agent');
  await expect(window.locator('#agent-provider-status')).toHaveText('Not configured');

  await window.locator('#agent-provider-select').selectOption('freepi');
  await expect(window.locator('#agent-provider-privacy')).toContainText('sent to Free Pi');
  await expect(window.locator('#agent-provider-privacy')).toContainText('sensitive information');
  await expect(window.locator('#agent-model-select')).toHaveValue('deepseek/deepseek-v4-flash');
  await window.locator('#agent-api-key').fill('test-only-not-a-credential');
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toContainText(
    'Free Pi · deepseek/deepseek-v4-flash'
  );
  await expect(window.locator('#agent-api-key')).toHaveValue('');
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
  await expect(window.locator('#agent-setup-view')).toBeHidden();
  await expect(window.locator('#agent-active-model-label')).toHaveText('DeepSeek V4 Flash');
  await window.locator('#agent-approval-mode-button').click();
  await expect(window.locator('#agent-approval-mode-popover')).toBeVisible();
  await expect(window.locator('#agent-approval-mode-every')).toContainText(
    'Ask before every interaction'
  );
  await expect(window.locator('#agent-approval-mode-sensitive')).toBeDisabled();
  await expect(window.locator('#agent-approval-mode-sensitive')).toContainText('Coming soon');
  await expect(window.locator('#agent-approval-mode-allow')).toContainText(
    'Allow website interactions'
  );

  await window.locator('#agent-model-menu-button').click();
  await expect(window.locator('#agent-model-menu')).toBeVisible();
  await window.locator('#agent-manage-providers').click();
  await expect(window.locator('#agent-setup-view')).toBeVisible();
  await expect(window.locator('#agent-connected-provider-list')).toContainText('Free Pi');

  await window.locator('#agent-provider-select').selectOption('openai-codex');
  await expect(window.locator('#agent-provider-privacy')).toContainText(
    'through your ChatGPT subscription'
  );
  await expect(window.locator('#agent-subscription-fields')).not.toHaveClass(/hidden/);
  await expect(window.locator('#agent-api-key-field')).toHaveClass(/hidden/);
  await expect(window.locator('#agent-provider-save')).toBeHidden();
  await expect(window.locator('#agent-provider-login')).toHaveText('Continue with ChatGPT');
  await expect(window.locator('#agent-model-select')).not.toHaveValue('');

  await window.locator('#agent-provider-select').selectOption('ollama');
  await expect(window.locator('#agent-provider-privacy')).toHaveText(
    'Model requests stay on this device and are sent only to your local Ollama server.'
  );
  await expect(window.locator('#agent-hosted-fields')).toHaveClass(/hidden/);
  await expect(window.locator('#agent-ollama-fields')).not.toHaveClass(/hidden/);
  await window.locator('#agent-ollama-model').fill('freedom-e2e-no-server');
  await window.locator('#agent-provider-save').click();

  await expect(window.locator('#agent-provider-status')).toContainText(
    'Ollama · freedom-e2e-no-server'
  );
  await expect(window.locator('#agent-provider-message')).toHaveText(
    'Model saved for this profile'
  );
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
  await expect(window.locator('#agent-active-model-label')).toHaveText('freedom-e2e-no-server');
  await window.locator('#agent-model-menu-button').click();
  await expect(window.locator('#agent-model-menu-list')).toContainText('DeepSeek V4 Flash');
  await expect(window.locator('#agent-model-menu-list')).toContainText('freedom-e2e-no-server');
  await window.getByRole('menuitemradio', { name: 'DeepSeek V4 Flash' }).click();
  await expect(window.locator('#agent-active-model-label')).toHaveText('DeepSeek V4 Flash');
  await window.locator('#agent-model-menu-button').click();
  await window.getByRole('menuitemradio', { name: 'freedom-e2e-no-server' }).click();
  await expect(window.locator('#agent-active-model-label')).toHaveText('freedom-e2e-no-server');
  await window.locator('#agent-model-menu-button').click();
  await window.locator('#agent-manage-providers').click();
  await expect(window.locator('#agent-connected-provider-list')).toContainText('Free Pi');
  await expect(window.locator('#agent-connected-provider-list')).toContainText('Ollama');
  await window.locator('#agent-sidebar-back').click();

  const compactComposer = await window.evaluate(() => {
    const footer = document.querySelector('.agent-composer-footer').getBoundingClientRect();
    const controls = [
      '[data-test="agent-attachment"]',
      '#agent-approval-mode-button',
      '#agent-model-menu-button',
      '[data-test="agent-dictation"]',
      '#agent-run',
    ].map((selector) => document.querySelector(selector).getBoundingClientRect());
    return {
      footer: { left: footer.left, right: footer.right },
      controls: controls.map(({ left, right }) => ({ left, right })),
    };
  });
  for (const control of compactComposer.controls) {
    expect(control.left).toBeGreaterThanOrEqual(compactComposer.footer.left);
    expect(control.right).toBeLessThanOrEqual(compactComposer.footer.right);
  }

  const agentFirstToggle = window.locator('[data-test="agent-first-toggle"]');
  await expect(agentFirstToggle).toBeVisible();
  await agentFirstToggle.click();
  await expect(window.locator('body')).toHaveClass(/agent-first-mode/);
  await expect(window.locator('.toolbar')).toBeHidden();
  await expect(window.locator('#agent-first-titlebar')).toBeVisible();
  await expect(window.locator('[data-test="agent-session-sidebar"]')).toBeVisible();
  await expect(window.locator('[data-test="agent-task-pages"]')).toBeVisible();
  await expect(window.locator('#agent-page-surface .content')).toBeVisible();
  await expect(window.locator('#agent-task-page-count')).toHaveText('1');
  await expect(window.locator('#agent-task-page-list .agent-task-page')).toHaveCount(1);
  await expect(window.locator('#agent-task-pages-note')).toContainText('currently viewing');
  await expect(window.locator('#agent-workspace-nav')).toBeVisible();
  await expect(window.locator('#agent-workspace-address')).not.toHaveValue('');
  const paneOrder = await window.evaluate(() => ({
    sessions: document.querySelector('#agent-session-sidebar').getBoundingClientRect().left,
    conversation: document.querySelector('#agent-sidebar').getBoundingClientRect().left,
    workspace: document.querySelector('#agent-page-surface').getBoundingClientRect().left,
  }));
  expect(paneOrder.sessions).toBeLessThan(paneOrder.conversation);
  expect(paneOrder.conversation).toBeLessThan(paneOrder.workspace);
  const titlebarLayout = await window.evaluate(() => {
    const rect = (selector) => {
      const { left, right, top, bottom, width } = document
        .querySelector(selector)
        .getBoundingClientRect();
      return { left, right, top, bottom, width };
    };
    return {
      titlebar: rect('.title-bar'),
      sessionTitlebar: rect('.agent-first-titlebar-left'),
      sessions: rect('#agent-session-sidebar'),
      conversationTitlebar: rect('.agent-first-titlebar-center'),
      conversation: rect('#agent-sidebar'),
      title: rect('#agent-first-title'),
      workspaceTitlebar: rect('.agent-first-titlebar-right'),
      workspace: rect('#agent-page-surface'),
      tabs: rect('#agent-task-pages'),
    };
  });
  expect(
    Math.abs(titlebarLayout.sessionTitlebar.right - titlebarLayout.sessions.right)
  ).toBeLessThan(2);
  expect(
    Math.abs(titlebarLayout.conversationTitlebar.left - titlebarLayout.conversation.left)
  ).toBeLessThan(2);
  expect(
    Math.abs(titlebarLayout.workspaceTitlebar.left - titlebarLayout.workspace.left)
  ).toBeLessThan(2);
  expect(titlebarLayout.title.left).toBeLessThan(
    titlebarLayout.conversationTitlebar.left + titlebarLayout.conversationTitlebar.width / 3
  );
  expect(titlebarLayout.tabs.top).toBeGreaterThanOrEqual(titlebarLayout.titlebar.top);
  expect(titlebarLayout.tabs.bottom).toBeLessThanOrEqual(titlebarLayout.titlebar.bottom + 1);
  const unifiedChrome = await window.evaluate(() => {
    const background = (selector) =>
      getComputedStyle(document.querySelector(selector)).backgroundColor;
    return {
      titlebar: background('.title-bar'),
      sessions: background('#agent-session-sidebar'),
      conversation: background('#agent-sidebar'),
      workspace: background('#agent-task-pages'),
      composer: background('.agent-composer-wrap'),
    };
  });
  expect(unifiedChrome.sessions).not.toBe(unifiedChrome.titlebar);
  expect(unifiedChrome.conversation).toBe(unifiedChrome.titlebar);
  expect(unifiedChrome.workspace).toBe(unifiedChrome.titlebar);
  expect(unifiedChrome.composer).toBe(unifiedChrome.titlebar);
  await expect(window.locator('[data-test="agent-attachment"]')).toBeDisabled();
  await expect(window.locator('[data-test="agent-dictation"]')).toBeDisabled();
  const composerLayout = await window.evaluate(() => {
    const rect = (selector) => {
      const { left, right, width, height } = document
        .querySelector(selector)
        .getBoundingClientRect();
      return { left, right, width, height };
    };
    const composerStyle = getComputedStyle(document.querySelector('.agent-composer'));
    const promptStyle = getComputedStyle(document.querySelector('#agent-prompt'));
    const sendStyle = getComputedStyle(document.querySelector('#agent-run'));
    return {
      attachment: rect('[data-test="agent-attachment"]'),
      approval: rect('#agent-approval-mode-button'),
      model: rect('#agent-model-menu-button'),
      dictation: rect('[data-test="agent-dictation"]'),
      send: rect('#agent-run'),
      borderRadius: Number.parseFloat(composerStyle.borderTopLeftRadius),
      promptFontSize: Number.parseFloat(promptStyle.fontSize),
      promptMinHeight: Number.parseFloat(promptStyle.minHeight),
      sendRadius: Number.parseFloat(sendStyle.borderTopLeftRadius),
    };
  });
  expect(composerLayout.attachment.left).toBeLessThan(composerLayout.approval.left);
  expect(composerLayout.approval.right).toBeLessThanOrEqual(composerLayout.model.left);
  expect(composerLayout.model.left).toBeLessThan(composerLayout.dictation.left);
  expect(composerLayout.dictation.left).toBeLessThan(composerLayout.send.left);
  expect(composerLayout.borderRadius).toBeGreaterThanOrEqual(20);
  expect(composerLayout.promptFontSize).toBe(14);
  expect(composerLayout.promptMinHeight).toBeGreaterThanOrEqual(60);
  expect(Math.abs(composerLayout.send.width - composerLayout.send.height)).toBeLessThan(1);
  expect(composerLayout.sendRadius).toBeGreaterThanOrEqual(composerLayout.send.width / 2 - 1);
  const sidebarThemeContrast = await window.evaluate(() => {
    const root = document.documentElement;
    const originalTheme = root.getAttribute('data-theme');
    const intensity = (color) => {
      const values = color
        .match(/[\d.]+/g)
        .map(Number)
        .slice(0, 3);
      const scale = color.startsWith('color(') ? 255 : 1;
      return values.reduce((total, value) => total + value * scale, 0);
    };
    const sample = (theme) => {
      root.setAttribute('data-theme', theme);
      return {
        sidebar: intensity(
          getComputedStyle(document.querySelector('#agent-session-sidebar')).backgroundColor
        ),
        main: intensity(getComputedStyle(document.querySelector('#agent-sidebar')).backgroundColor),
      };
    };
    const result = { dark: sample('dark'), light: sample('light') };
    if (originalTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', originalTheme);
    return result;
  });
  expect(sidebarThemeContrast.dark.sidebar).toBeGreaterThan(sidebarThemeContrast.dark.main);
  expect(sidebarThemeContrast.light.sidebar).toBeLessThan(sidebarThemeContrast.light.main);

  const paneMotion = await window.evaluate(() => ({
    sessions: getComputedStyle(document.querySelector('#agent-session-sidebar')).transitionDuration,
    workspace: getComputedStyle(document.querySelector('#agent-page-surface')).transitionDuration,
  }));
  expect(paneMotion.sessions).not.toBe('0s');
  expect(paneMotion.workspace).not.toBe('0s');

  const initialSessionWidth = await window
    .locator('#agent-session-sidebar')
    .evaluate((sidebar) => sidebar.getBoundingClientRect().width);
  const sessionResizeBox = await window
    .locator('[data-test="agent-session-resizer"]')
    .boundingBox();
  await window.mouse.move(
    sessionResizeBox.x + sessionResizeBox.width / 2,
    sessionResizeBox.y + sessionResizeBox.height / 2
  );
  await window.mouse.down();
  await expect(window.locator('body')).toHaveClass(/agent-sidebar-resizing/);
  await window.mouse.move(
    sessionResizeBox.x + 36,
    sessionResizeBox.y + sessionResizeBox.height / 2
  );
  await window.mouse.up();
  const resizedSessionGeometry = await window.evaluate(() => ({
    sidebar: document.querySelector('#agent-session-sidebar').getBoundingClientRect().width,
    titlebar: document.querySelector('.agent-first-titlebar-left').getBoundingClientRect().width,
  }));
  expect(resizedSessionGeometry.sidebar).toBeGreaterThan(initialSessionWidth + 25);
  expect(Math.abs(resizedSessionGeometry.sidebar - resizedSessionGeometry.titlebar)).toBeLessThan(
    2
  );

  const initialWorkspaceWidth = await window
    .locator('#agent-page-surface')
    .evaluate((sidebar) => sidebar.getBoundingClientRect().width);
  const workspaceResizeBox = await window
    .locator('[data-test="agent-workspace-resizer"]')
    .boundingBox();
  await window.mouse.move(
    workspaceResizeBox.x + workspaceResizeBox.width / 2,
    workspaceResizeBox.y + workspaceResizeBox.height / 2
  );
  await window.mouse.down();
  await expect(window.locator('body')).toHaveClass(/agent-sidebar-resizing/);
  await window.mouse.move(
    workspaceResizeBox.x - 36,
    workspaceResizeBox.y + workspaceResizeBox.height / 2
  );
  await window.mouse.up();
  const resizedWorkspaceGeometry = await window.evaluate(() => ({
    sidebar: document.querySelector('#agent-page-surface').getBoundingClientRect().width,
    titlebar: document.querySelector('.agent-first-titlebar-right').getBoundingClientRect().width,
  }));
  expect(resizedWorkspaceGeometry.sidebar).toBeGreaterThan(initialWorkspaceWidth + 25);
  expect(
    Math.abs(resizedWorkspaceGeometry.sidebar - resizedWorkspaceGeometry.titlebar)
  ).toBeLessThan(2);

  const openSessionToggleLeft = await window
    .locator('[data-test="agent-session-sidebar-toggle"]')
    .evaluate((button) => button.getBoundingClientRect().left);
  await window.locator('[data-test="agent-session-sidebar-toggle"]').click();
  await expect(window.locator('body')).toHaveClass(/agent-session-sidebar-closed/);
  await window.waitForTimeout(260);
  const closedSessionToggleLeft = await window
    .locator('[data-test="agent-session-sidebar-toggle"]')
    .evaluate((button) => button.getBoundingClientRect().left);
  expect(Math.abs(closedSessionToggleLeft - openSessionToggleLeft)).toBeLessThan(1);
  const closedSessionChrome = await window.evaluate(() => ({
    sidebarDisplay: getComputedStyle(document.querySelector('#agent-session-sidebar')).display,
    headerBackground: getComputedStyle(document.querySelector('.agent-first-titlebar-left'))
      .backgroundColor,
    titlebarBackground: getComputedStyle(document.querySelector('.title-bar')).backgroundColor,
    slidingSurfaceTransform: getComputedStyle(
      document.querySelector('.agent-first-titlebar-left'),
      '::before'
    ).transform,
  }));
  expect(closedSessionChrome.sidebarDisplay).toBe('flex');
  expect(closedSessionChrome.headerBackground).toBe(closedSessionChrome.titlebarBackground);
  expect(closedSessionChrome.slidingSurfaceTransform).not.toBe('none');
  await window.locator('[data-test="agent-workspace-sidebar-toggle"]').click();
  await expect(window.locator('body')).toHaveClass(/agent-workspace-sidebar-closed/);
  await window.waitForTimeout(260);
  await expect(window.locator('#agent-page-surface')).toHaveCSS('display', 'flex');
  await window.locator('[data-test="agent-session-sidebar-toggle"]').click();
  await window.locator('[data-test="agent-workspace-sidebar-toggle"]').click();

  await window.locator('[data-test="agent-first-browser-return"]').click();
  await expect(window.locator('body')).not.toHaveClass(/agent-first-mode/);
  await expect(window.locator('.toolbar')).toBeVisible();

  await window.locator('webview:not(.hidden)').waitFor({ state: 'attached' });
  await window.locator('#agent-prompt').fill('Summarize this page');
  await expect(window.locator('#agent-stop')).toHaveText('Take over');
  const tabMarkedAtStart = await window.evaluate(() => {
    document.querySelector('#agent-run').click();
    return document
      .querySelector('[data-test="tab"].active')
      .classList.contains('agent-controlled');
  });
  expect(tabMarkedAtStart).toBe(true);

  await expect(window.locator('#agent-run-status')).toHaveText('failed', { timeout: 15_000 });
  await expect(window.locator('#agent-run-message')).toHaveText(
    'The model provider request failed'
  );
  await expect(window.locator('.agent-user-message')).toHaveText('Summarize this page');
  await expect(window.locator('#agent-prompt')).toBeEnabled();
  await expect(window.locator('#agent-run')).toBeDisabled();
  await expect(window.locator('#agent-stop')).toBeDisabled();
  await expect(window.locator('#agent-new-chat')).toBeEnabled();
  await expect(window.locator('#agent-model-menu-button')).toBeDisabled();
  await expect(window.locator('#agent-approval-mode-button')).toBeDisabled();
  await expect(window.locator('[data-test="tab"].active')).not.toHaveClass(/agent-controlled/);

  await window.locator('#agent-new-chat').click();
  await expect(window.locator('#agent-empty-state')).toBeVisible();
  await expect(window.locator('#agent-transcript')).toBeHidden();
  await expect(window.locator('#agent-model-menu-button')).toBeEnabled();
  await expect(window.locator('#agent-approval-mode-button')).toBeEnabled();
});
