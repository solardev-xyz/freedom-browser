const path = require('path');
const { test, expect } = require('./fixtures');

// Explicit opt-in: these tests use the user's Claude subscription, not a stub.
const executable = process.env.FREEDOM_CLAUDE_SPIKE_EXECUTABLE;
const root = path.resolve(__dirname, '..');
const url = 'https://freedom-claude-spike.test/';
test.skip(!executable, 'Set FREEDOM_CLAUDE_SPIKE_EXECUTABLE to an authenticated local Claude binary');
test.setTimeout(150000);

for (const decision of ['approved', 'declined', 'stop']) {
  test(`Claude subscription reaches Freedom browser tools; ${decision} gates the actual click`, async ({ window, electronApp, harness }) => {
    await harness.setContentFixture(url, { body: `<!doctype html><title>Freedom bridge test</title>
      <h1>ORBIT-731</h1><button id="confirm">Confirm fixture</button><p id="result">Not confirmed</p>
      <script>document.querySelector('#confirm').onclick = () => document.querySelector('#result').textContent = 'Confirmed ORBIT-731';</script>` });
    const address = window.locator('[data-test="address-input"]');
    await address.fill(url); await address.press('Enter');
    let tabId;
    await expect.poll(async () => {
      const tabs = await electronApp.evaluate(() => globalThis.__FREEDOM_TEST_HARNESS__.automationExecute('browser_list_tabs', {}));
      tabId = tabs.result.tabs.find(tab => tab.url === url)?.tabId;
      return tabId;
    }).toBeTruthy();
    await electronApp.evaluate(async (_electron, options) => {
      const require = process.getBuiltinModule('module').createRequire(options.root + '/package.json');
      const { automationController } = require(options.root + '/src/main/automation/runtime');
      const { createOriginScopedAutomationController } = require(options.root + '/src/main/automation/origin-scoped-controller');
      const { createFreedomBrowserTools } = require(options.root + '/src/main/agent/pi-browser-tools');
      const { runClaudeSpike } = require(options.root + '/scripts/claude-subscription-spike');
      const state = globalThis.claudeSpike = { abort: new AbortController(), approvals: 0, deltas: 0, calls: [], done: false };
      const controller = await createOriginScopedAutomationController({ controller: automationController,
        tabId: options.tabId, approvalMode: 'every_interaction',
        requestApproval: () => { state.approvals++; return new Promise(resolve => { state.decide = resolve; }); } });
      const tools = (await createFreedomBrowserTools({ controller, tabId: options.tabId }))
        .filter(tool => ['browser_snapshot', 'browser_click'].includes(tool.name));
      state.promise = runClaudeSpike({ executable: options.executable, tools, signal: state.abort.signal,
        prompt: 'Read the current page. Tell me the exact heading, then click Confirm fixture once using the current observed reference. After success, read the page again and report the result. If denied, report that and stop without retrying.',
        onTool: event => state.calls.push(event),
        onEvent: event => {
          if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') state.deltas++;
          if (event.type === 'system' && event.subtype === 'init') state.inventory = { tools: event.tools, apiKeySource: event.apiKeySource, model: event.model };
        },
      }).then(result => { state.result = result.result; }, error => { state.error = error.message; })
        .finally(() => { state.done = true; });
    }, { root, executable, tabId });
    try {
      await expect.poll(() => electronApp.evaluate(() => ({ approvals: globalThis.claudeSpike.approvals, error: globalThis.claudeSpike.error })), { timeout: 90000 })
        .toEqual({ approvals: 1, error: undefined });
      const readPage = () => electronApp.evaluate((_electron, tabId) => globalThis.__FREEDOM_TEST_HARNESS__.automationExecute('browser_snapshot', { tabId }), tabId);
      expect(JSON.stringify(await readPage())).toContain('Not confirmed');
      await electronApp.evaluate((_electron, decision) => {
        const state = globalThis.claudeSpike;
        if (decision === 'stop') { state.abort.abort(new Error('Stopped by spike')); state.decide('withdrawn'); }
        else state.decide(decision);
      }, decision);
      await expect.poll(() => electronApp.evaluate(() => globalThis.claudeSpike.done), { timeout: 30000 }).toBe(true);
      const state = await electronApp.evaluate(() => {
        const { approvals, deltas, calls, result, error, inventory } = globalThis.claudeSpike;
        return { approvals, deltas, calls, result, error, inventory };
      });
      expect(state.approvals).toBe(1);
      expect(state.inventory.apiKeySource).toBe('none');
      expect(state.inventory.tools).toEqual(expect.arrayContaining(['mcp__freedom__browser_snapshot', 'mcp__freedom__browser_click']));
      expect(state.calls.some(call => call.name === 'browser_snapshot' && call.state === 'finished')).toBe(true);
      if (decision === 'stop') expect(state.error).toBe('Stopped by spike');
      else { expect(state.error).toBeUndefined(); expect(state.deltas).toBeGreaterThan(0); }
      const final = JSON.stringify(await readPage());
      expect(final).toContain(decision === 'approved' ? 'Confirmed ORBIT-731' : 'Not confirmed');
      console.log(JSON.stringify({ decision, ...state }));
    } finally {
      await electronApp.evaluate(async () => {
        const state = globalThis.claudeSpike;
        state.abort.abort(); state.decide?.('withdrawn'); await state.promise;
      });
    }
  });
}
