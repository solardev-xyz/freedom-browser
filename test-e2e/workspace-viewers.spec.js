const { test, expect } = require('./fixtures');

// Product renderer with deterministic API fixtures in a disposable Electron
// profile. Filesystem mutation/recovery is covered separately through main.
for (const theme of ['dark', 'light']) for (const layout of ['browser', 'agent']) {
  test(`project viewers: ${theme}, ${layout}`, async ({ window }, testInfo) => {
    await window.evaluate(async ({ theme, layout }) => {
      document.documentElement.dataset.theme = theme;
      document.body.classList.toggle('agent-first-mode', layout === 'agent');
      const { createWorkspaceViewers } = await import('./lib/workspace-viewers.js');
      const host = document.createElement('div'); host.id = 'viewer-test-host';
      Object.assign(host.style, { position: 'fixed', inset: '70px 20px 20px', zIndex: '99999', display: 'flex', flexDirection: 'column', background: 'var(--bg)' });
      const strip = document.createElement('div'); strip.className = layout === 'agent' ? 'agent-task-page-list' : 'tab-bar';
      Object.assign(strip.style, { height: '34px', flex: '0 0 34px', padding: '0' });
      const tab = document.createElement('div'); tab.className = 'tab active'; tab.textContent = 'Project'; strip.appendChild(tab); host.appendChild(strip);
      document.body.appendChild(host);
      const id = 'a'.repeat(40); const older = 'b'.repeat(40);
      const versions = [{ id, label: 'Add planet facts', createdAt: 1700000000000, reviewed: true }, { id: older, label: 'Create solar system', createdAt: 1699900000000, reviewed: true }];
      const changes = [{ path: 'app/page.tsx', status: 'modified', staged: true, unstaged: true }, { path: 'README.md', status: 'added' }];
      const before = 'export default function Planet() {\n  const title = "Earth";\n  return title;\n}\n';
      const after = 'export default function Planet() {\n  const title = "Our solar system";\n  const planets = 8;\n  return `${title}: ${planets} planets`;\n}\n';
      const api = {
        inspectAgentWorkspace: async (conversationId, kind) => ({ ok: true, conversationId, result: kind === 'changes' ? { available: true, project: true, changes }
          : kind === 'tree' ? { entries: [{ name: 'app', type: 'directory' }, { name: 'README.md', type: 'file' }] }
            : kind === 'diff' ? { text: '@@ -1,4 +1,5 @@\n export default function Planet() {\n-  const title = "Earth";\n-  return title;\n+  const title = "Our solar system";\n+  const planets = 8;\n+  return `${title}: ${planets} planets`;\n }' }
              : { text: '# Orbit\nAn interactive solar system.\n<script>window.projectExecuted = true</script>\n![remote](https://example.invalid/image.png)' } }),
        agentWorkspaceHistory: async (conversationId, action, options) => ({ ok: true, conversationId, result: action === 'list' ? { versions }
          : action === 'comparison' ? { files: changes, baseId: older, versionId: id }
            : action === 'comparison_file' ? { before: { text: before }, after: { text: after } }
              : action === 'files' ? { files: changes } : action === 'file' ? { text: after }
                : action === 'prepare_restore' ? { token: 'restore_' + 'c'.repeat(32), changes: [{ path: 'app/page.tsx', action: 'write', before: { text: after }, after: { text: before } }] }
                  : action === 'restore' ? { saved: true, id: options.token } : { pending: false } }),
      };
      const viewer = createWorkspaceViewers({ api, openTab: ({ content }) => { content.classList.add('workspace-viewer-surface'); Object.assign(content.style, { position: 'relative', flex: '1', inset: 'auto' }); host.appendChild(content); return { id: 1 }; }, closeTab: () => {} });
      viewer.setConversation('fixture'); viewer.open('fixture');
    }, { theme, layout });
    const host = window.locator('#viewer-test-host');
    await expect(host.locator('.workspace-code-added')).toHaveCount(3);
    const colors = await host.evaluate(element => ({ tab: getComputedStyle(element.querySelector('.tab.active')).backgroundColor, heading: getComputedStyle(element.querySelector('.workspace-viewer-heading')).backgroundColor }));
    expect(colors.heading).toBe(colors.tab);
    await host.getByRole('button', { name: 'Side by side', exact: true }).click();
    await expect(host.locator('.workspace-code-pair')).not.toHaveCount(0);
    await host.screenshot({ path: testInfo.outputPath(`changes-${theme}-${layout}.png`) });
    await host.getByRole('button', { name: 'History', exact: true }).click();
    await host.getByRole('button', { name: /Add planet facts/ }).click();
    await expect(host.locator('.workspace-viewer-message').first()).toContainText('bbbbbbb → aaaaaaa');
    await host.getByRole('button', { name: 'Restore file…', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Back up reviewed work and restore' })).toBeEnabled();
    await expect(host.locator('.workspace-code-deleted')).not.toHaveCount(0);
    await host.screenshot({ path: testInfo.outputPath(`restore-${theme}-${layout}.png`) });
    await host.getByRole('button', { name: 'Files', exact: true }).click();
    await host.getByRole('button', { name: 'README.md', exact: true }).click();
    await host.getByRole('button', { name: 'Markdown preview', exact: true }).click();
    expect(await window.evaluate(() => window.projectExecuted)).toBeUndefined();
    await expect(host.locator('.workspace-viewer-code img, .workspace-viewer-code script')).toHaveCount(0);
    await host.evaluate(element => { element.style.width = '360px'; element.style.right = 'auto'; });
    await host.screenshot({ path: testInfo.outputPath(`files-narrow-${theme}-${layout}.png`) });
    expect(await host.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
