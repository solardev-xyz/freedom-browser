const { test, expect } = require('./fixtures');
const recipes = require('../.claude/skills/run-freedom/recipes');
const live = process.env.ENSV2_UI_LIVE === '1';
const names = [
  ['ur.integration-tests.eth', '0x2222222222222222222222222222222222222222'],
  ['test.offchaindemo.eth', '0x779981590E7Ccc0CFAe8040Ce7151324747cDb97'],
  ['gregskril.com', '0x179A862703a4adfb29896552DF9e307980D19285'],
  ['test.ses.eth', '0x2B0F09F23193de2Fb66258a10886B9f06903276c', 1],
  ['test.ses.eth', '0x7d3a48269416507E6d207a9449E7800971823Ffa', 8453],
];
for (const theme of ['dark', 'light']) {
  test.describe(`ENSv2 ${theme}`, () => {
    test.use({ seedSettings: { theme } });
    test('wallet accepts DNS names and shows the resolved address on the selected chain', async ({
      electronApp,
      window,
    }, testInfo) => {
      test.setTimeout(120000);
      await recipes.stubWalletIpc({ app: electronApp });
      await electronApp.evaluate(
        ({ ipcMain }, { names, live }) => {
          const registry = process.mainModule.require('./src/main/networks/network-registry');
          const resolver = process.mainModule.require('./src/main/ens-resolver');
          const original = registry.getNetwork;
          registry.getNetwork = (chain) => {
            const network = original(chain);
            return chain === 1
              ? {
                  ...network,
                  verification: { ...network.verification, order: ['colibri', 'quorum'] },
                }
              : network;
          };
          resolver.invalidateCachedProvider();
          globalThis.__ensv2Requests = [];
          ipcMain.removeHandler('ens:resolve-address');
          ipcMain.handle('ens:resolve-address', async (_event, payload) => {
            globalThis.__ensv2Requests.push(payload);
            if (live) return resolver.resolveEnsAddress(payload.name, payload.chainId);
            const address = names.find(
              ([name, , chainId = 1]) => name === payload.name && chainId === payload.chainId
            )?.[1];
            return { success: !!address, address, name: payload.name };
          });
        },
        { names, live }
      );
      await recipes.sendForm({ app: electronApp, win: window });
      for (const [name, address, chainId = 1] of names) {
        await window.evaluate(
          async ({ recipient, chainId }) => {
            const { walletState } = await import('./lib/wallet/wallet-state.js');
            const { openSend } = await import('./lib/wallet/send.js');
            walletState.registeredChains = {
              [chainId]: {
                chainId,
                name: chainId === 1 ? 'Ethereum' : 'Base',
                nativeSymbol: 'ETH',
              },
            };
            walletState.registeredTokens = {
              'eth-native': {
                chainId,
                symbol: 'ETH',
                name: 'Ether',
                decimals: 18,
                address: null,
                builtin: true,
              },
            };
            walletState.currentBalances = { 'eth-native': { formatted: '1.0', symbol: 'ETH' } };
            openSend({ recipient, chainId });
          },
          { recipient: name, chainId }
        );
        await window.fill('#send-amount', '0.001');
        await window.click('#send-continue-btn');
        await expect(window.locator('#send-review-to')).toContainText(name, { timeout: 60000 });
        await expect(window.locator('#send-review-to')).toContainText(address);
        await window.screenshot({
          path: testInfo.outputPath(`${theme}-${name}${chainId === 1 ? '' : `-${chainId}`}.png`),
        });
      }
      const requests = await electronApp.evaluate(() => globalThis.__ensv2Requests);
      expect(requests).toEqual(names.map(([name, , chainId = 1]) => ({ name, chainId })));
    });
  });
}

for (const theme of ['dark', 'light']) {
  test.describe(`ENS checker ${theme}`, () => {
    test.use({ seedSettings: { theme } });
    test('native IPFS checker content renders as text without downloading', async ({
      electronApp,
      window,
    }, testInfo) => {
      test.skip(!live, 'Set ENSV2_UI_LIVE=1 to retrieve the actual ENS checker content');
      test.setTimeout(90000);
      await electronApp.evaluate(({ session, app, ipcMain }) => {
        const load = process.mainModule.require.bind(process.mainModule);
        const path = load('node:path');
        const { FreedomIpfsNativeNode } = load('./src/main/ipfs/freedom-ipfs-native-node');
        const { handleRequest } = load('./src/main/ipfs/ipfs-protocol');
        const registry = load('./src/main/networks/network-registry');
        const resolver = load('./src/main/ens-resolver');
        const original = registry.getNetwork;
        registry.getNetwork = (chain) => {
          const network = original(chain);
          return chain === 1
            ? {
                ...network,
                verification: { ...network.verification, order: ['colibri', 'quorum'] },
              }
            : network;
        };
        resolver.invalidateCachedProvider();
        ipcMain.removeHandler('ens:resolve');
        ipcMain.handle('ens:resolve', (_event, { name }) => resolver.resolveEnsContent(name));
        const node = new FreedomIpfsNativeNode({
          dataDir: path.join(app.getPath('userData'), 'ens-checker-ipfs'),
        });
        node.start();
        globalThis.__ensCheckerNode = node;
        globalThis.__ensCheckerDownloads = 0;
        for (const partition of [session.defaultSession]) {
          partition.on('will-download', (event) => {
            event.preventDefault();
            globalThis.__ensCheckerDownloads++;
          });
          partition.protocol.unhandle('ipfs');
          partition.protocol.handle('ipfs', (request) =>
            handleRequest('ipfs', request, {
              requestImpl: (args) => node.request(args),
            })
          );
        }
      });
      try {
        await window.locator('[data-test="address-input"]').fill('ur.integration-tests.eth');
        await window.locator('[data-test="address-input"]').press('Enter');
        await expect
          .poll(
            async () =>
              window.evaluate(async () => {
                const webview = document.querySelector('webview:not(.hidden)');
                try {
                  return await webview.executeJavaScript('document.body.innerText');
                } catch {
                  return '';
                }
              }),
            { timeout: 60000 }
          )
          .toContain('Hello from IPFS Gateway Checker');
        expect(
          await window.evaluate(() => document.querySelector('webview:not(.hidden)').getURL())
        ).toContain('ur.integration-tests.eth');
        expect(await electronApp.evaluate(() => globalThis.__ensCheckerDownloads)).toBe(0);
        await window.screenshot({ path: testInfo.outputPath(`${theme}-ipfs-checker-inline.png`) });
      } finally {
        await electronApp.evaluate(async () => {
          await globalThis.__ensCheckerNode.stop();
        });
      }
    });
  });
}
