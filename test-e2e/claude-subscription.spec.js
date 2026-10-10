const { test, expect } = require('./fixtures');

// Opt-in real subscription test: no credentials are read or copied by the harness.
test.skip(process.env.FREEDOM_CLAUDE_LIVE !== '1', 'Requires an authenticated native Claude installation');
test.setTimeout(360000);

test('connect installed Claude, chat, remember context, and show privacy in the normal UI', async ({ window }, testInfo) => {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Anthropic', exact: true }).click();
  await expect(window.locator('#agent-subscription-method-title')).toHaveText('Claude subscription');
  await window.locator('#agent-provider-chatgpt').click();
  await expect(window.locator('#agent-provider-login')).toHaveText('Connect installed Claude');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await window.locator('#agent-sidebar').screenshot({ path: testInfo.outputPath(`claude-connect-${theme}.png`) });
  }
  await window.locator('#agent-provider-login').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected', { timeout: 25000 });
  await window.locator('#agent-sidebar-back').click();
  await window.locator('#agent-prompt').fill('Remember the word ORBIT. Reply exactly: Ready.');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 60000 });
  await expect(window.locator('.agent-output').last()).toContainText('Ready');
  await window.locator('#agent-prompt').fill('What word did I ask you to remember? Answer with just that word.');
  await window.locator('#agent-run').click();
  await expect(window.locator('.agent-output').last()).toHaveText('ORBIT', { timeout: 60000 });
  await expect(window.locator('#agent-run-status')).toHaveText('Complete');
  await window.locator('#agent-session-privacy').click();
  await expect(window.locator('#agent-session-privacy-panel')).toContainText('anthropic-claude');
  await expect(window.locator('#agent-session-privacy-panel')).toContainText('2 requests');
  await window.locator('#agent-session-privacy-panel summary').filter({ hasText: 'Technical details' }).click();
  await expect(window.locator('#agent-session-privacy-panel')).toContainText('Connection handled by installed Claude Code');
  await expect(window.locator('#agent-session-privacy-panel')).not.toContainText('This endpoint does not use HTTPS.');
});


test('Claude browser actions retain real UI approval, decline and Stop; helpers return reports', async ({ window, harness, electronApp }) => {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Anthropic', exact: true }).click();
  await window.locator('#agent-provider-chatgpt').click();
  await window.locator('#agent-provider-login').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected', { timeout: 25000 });
  await window.locator('#agent-sidebar-back').click();
  await window.locator('#agent-approval-mode-button').click();
  await window.locator('#agent-approval-mode-every').click();
  const url = 'https://freedom-claude-qualification.test/';
  await harness.setContentFixture(url, { body: '<h1>ORBIT-731</h1><button id="confirm">Confirm fixture</button><p id="count">0</p><script>document.querySelector("#confirm").onclick=()=>{const p=document.querySelector("#count");p.textContent=Number(p.textContent)+1}</script>' });
  const send = async prompt => { await window.locator('#agent-prompt').fill(prompt); await window.locator('#agent-run').click(); };
  const snapshot = async () => electronApp.evaluate(async () => {
    const harness = globalThis.__FREEDOM_TEST_HARNESS__;
    const tabs = await harness.automationExecute('browser_list_tabs', {});
    const tab = tabs.result.tabs.find(t => t.url === 'https://freedom-claude-qualification.test/');
    return tab ? JSON.stringify(await harness.automationExecute('browser_snapshot', { tabId: tab.tabId })) : '';
  });
  const counter = () => electronApp.evaluate(async ({ webContents }) => {
    const page = webContents.getAllWebContents().find(c => c.getURL() === 'https://freedom-claude-qualification.test/');
    return page?.executeJavaScript('document.querySelector("#count").textContent');
  });
  await send('Open '+url+' in a new tab, read it, and click Confirm fixture exactly once. Do this yourself, without helpers. Report the resulting counter.');
  await expect(window.locator('#agent-approval')).toBeVisible({ timeout: 60000 });
  await window.locator('#agent-approval-approve').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 60000 });
  expect(await snapshot()).toContain('ORBIT-731');
  expect(await counter()).toBe('1');
  await send('Click Confirm fixture once more. Do this yourself.');
  await expect(window.locator('#agent-approval')).toBeVisible({ timeout: 60000 });
  await window.locator('#agent-approval-decline').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 60000 });
  expect(await counter()).toBe('1');
  await send('I now authorize another click on Confirm fixture. Do this yourself.');
  await expect(window.locator('#agent-approval')).toBeVisible({ timeout: 60000 });
  await window.locator('#agent-approval-stop').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Stopped', { timeout: 15000 });
  expect(await counter()).toBe('1');
  await send('Use one browser helper to read '+url+' in its own tab and return the exact heading. Summarize its report. Do not click anything.');
  await expect(window.locator('.agent-subagent-report')).toBeVisible({ timeout: 90000 });
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 90000 });
  await expect(window.locator('.agent-output').last()).toContainText('ORBIT-731');
});


test('Claude builds a managed workspace through Freedom tools and opens its preview', async ({ window, electronApp }) => {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Anthropic', exact: true }).click();
  await expect(window.locator('#agent-subscription-method-title')).toHaveText('Claude subscription');
  await window.locator('#agent-provider-chatgpt').click();
  await expect(window.locator('#agent-provider-login')).toHaveText('Connect installed Claude');
  await window.locator('#agent-provider-login').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected', { timeout: 25000 });
  await window.locator('#agent-sidebar-back').click();
  await window.locator('#agent-prompt').fill('Create a tiny static index.html in this new workspace. The page should have a heading ORBIT BUILD 731 and an accessible button that toggles a paragraph. Use codemode for the file work. Open the working preview. Do not install dependencies or run shell commands.');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 120000 });
  const tabs = await electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.automationExecute('browser_list_tabs', {}));
  expect(tabs.result.tabs.some(tab => tab.title?.includes('ORBIT BUILD 731'))).toBe(true);
  const pages = await electronApp.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().filter(c => c.getType() === 'webview');
    return Promise.all(contents.map(c => c.executeJavaScript('document.body.innerText').catch(() => '')));
  });
  expect(pages.some(text => text.includes('ORBIT BUILD 731'))).toBe(true);
  await expect(window.locator('.agent-tool-item').filter({ hasText: /tool script/i }).first()).toHaveCount(1);
});
