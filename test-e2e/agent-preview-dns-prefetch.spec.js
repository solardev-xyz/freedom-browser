'use strict';

// A workspace preview must not reach the system resolver through DNS prefetch
// hints. `<link rel=dns-prefetch>` bypasses the preview's rejecting proxy and
// CSP, and Chromium ignores X-DNS-Prefetch-Control for it, so the app disables
// DNS prefetching for every renderer (src/main/index.js). The page is served by
// the real WorkspacePreviewController from a fixture workspace and loaded in a
// tab on the isolated preview partition; resolver jobs come from that
// partition's net log.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('./fixtures');

function resolverJobsByHost(netlogPath, hosts) {
  const log = JSON.parse(fs.readFileSync(netlogPath, 'utf8'));
  const types = Object.fromEntries(
    Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name])
  );
  const counts = Object.fromEntries(hosts.map(host => [host, 0]));
  for (const event of log.events) {
    if (types[event.type] !== 'HOST_RESOLVER_MANAGER_JOB') continue;
    const params = JSON.stringify(event.params || {});
    for (const host of hosts) if (params.includes(host)) counts[host] += 1;
  }
  return counts;
}

test('preview DNS prefetch hints never reach the resolver', async ({ electronApp, window }) => {
  const root = path.resolve(__dirname, '..');
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-preview-dns-'));
  const workspace = path.join(scratch, 'workspace');
  await fs.promises.mkdir(workspace);
  const tag = Math.random().toString(36).slice(2, 10);
  const host = name => `${name}-${tag}.example.com`;
  const hosts = ['link', 'metaon', 'scripted', 'frame', 'control'].map(host);
  // Every variant tries to resolve its own name; `frame` also re-enables
  // prefetching in an about:blank child that never received the header.
  await fs.promises.writeFile(path.join(workspace, 'index.html'), `<!doctype html><head>
<meta http-equiv="x-dns-prefetch-control" content="on">
<link rel="dns-prefetch" href="https://${host('link')}">
<link rel="dns-prefetch" href="//${host('metaon')}">
</head><body><h1>Loading</h1><iframe src="about:blank"></iframe><script>
const link = document.createElement('link');
link.rel = 'dns-prefetch';
link.href = 'https://${host('scripted')}';
document.head.append(link);
const child = document.querySelector('iframe').contentDocument;
child.open();
child.write('<head><meta http-equiv="x-dns-prefetch-control" content="on"><link rel="dns-prefetch" href="https://${host('frame')}"></head>');
child.close();
document.querySelector('h1').textContent = 'Probe ready';
</script></body>`);
  const netlog = path.join(scratch, 'netlog.json');
  try {
    await expect(window.locator('body')).toBeVisible();
    const url = await electronApp.evaluate(async ({ session }, { directory, workspace: fixture, netlog: logPath }) => {
      const { WorkspacePreviewController } = process.mainModule.require(
        `${directory}/src/main/agent/workspace-preview-controller`
      );
      const target = session.fromPartition('freedom-workspace-preview');
      await target.netLog.startLogging(logPath, { captureMode: 'everything' });
      await target.protocol.unhandle('freedom-preview');
      const workspaceRecord = { workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa', enabled: true };
      const controller = new WorkspacePreviewController({
        workspaceController: {
          getWorkspace: () => workspaceRecord,
          resolveWorkspacePath: async () => ({ workspace: workspaceRecord, path: fixture }),
        },
      });
      controller.register(target);
      return (await controller.createPreview('conversation_dns_probe', '.')).url;
    }, { directory: root, workspace, netlog });

    await window.evaluate(async target => (await import('./lib/tabs.js')).createTab(target).id, url);
    await expect.poll(() => electronApp.evaluate(({ webContents }, target) => {
      const page = webContents.getAllWebContents().find(contents => contents.getURL() === target);
      return page?.executeJavaScript("document.querySelector('h1')?.textContent").catch(() => null);
    }, url)).toBe('Probe ready');
    // Prefetch hints are dispatched asynchronously; give them time to reach the resolver.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    // Positive control: a lookup the main process makes on the same partition is
    // visible in this log, so zero page lookups is a real measurement.
    await electronApp.evaluate(async ({ session }, name) => {
      const target = session.fromPartition('freedom-workspace-preview');
      await target.resolveHost(name).catch(() => null);
      await target.netLog.stopLogging();
    }, host('control'));

    const counts = resolverJobsByHost(netlog, hosts);
    console.log('preview DNS resolver jobs', JSON.stringify(counts));
    expect(counts[host('control')]).toBeGreaterThan(0);
    expect(counts).toEqual({
      ...Object.fromEntries(hosts.map(name => [name, 0])),
      [host('control')]: counts[host('control')],
    });
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
});
