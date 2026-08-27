const http = require('http');
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

const MODEL_ID = 'freedom-product-qualification-fixture';
const WALLET_PASSWORD = 'Freedom-Agent-Wallet-E2E-2026!';
const PRODUCT_ORIGIN = 'https://agent-product.test';
const FOREIGN_ORIGIN = 'https://agent-research-source.test';
const URLS = Object.freeze({
  researchStart: `${PRODUCT_ORIGIN}/research/start`,
  researchNorthstar: `${PRODUCT_ORIGIN}/research/northstar`,
  researchMeridian: `${PRODUCT_ORIGIN}/research/meridian`,
  richForm: `${PRODUCT_ORIGIN}/workflow/preferences`,
  collaborativeForm: `${PRODUCT_ORIGIN}/workflow/application`,
  crossOriginStart: `${PRODUCT_ORIGIN}/research/cross-origin-start`,
  crossOriginTarget: `${FOREIGN_ORIGIN}/independent-report`,
  multiTab: `${PRODUCT_ORIGIN}/research/multi-tab`,
  fileDownload: `${PRODUCT_ORIGIN}/files/report`,
  fileTarget: `${PRODUCT_ORIGIN}/files/quarterly-report.txt`,
  fileUpload: `${PRODUCT_ORIGIN}/workflow/upload`,
  wallet: `${PRODUCT_ORIGIN}/wallet/agent-native`,
  walletTransaction: `${PRODUCT_ORIGIN}/wallet/transaction`,
  walletDecline: `${PRODUCT_ORIGIN}/wallet/decline`,
});

const CLASSIFICATION = Object.freeze({
  PASS: 'pass',
  PARTIAL: 'partially_works',
  MISSING: 'missing_capability',
  MODEL_FAILURE: 'model_failure',
  UX_FAILURE: 'ux_failure',
});

const EXPECTED_TOOL_NAMES = Object.freeze([
  'browser_get_tab',
  'browser_list_tabs',
  'browser_create_tab',
  'browser_focus_tab',
  'browser_close_tab',
  'browser_snapshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_upload',
  'browser_download',
  'browser_list_downloads',
  'browser_wait',
  'browser_stop_loading',
]);

let server;
let baseUrl;
let requestCount = 0;
let observedPolicyDenial = false;
let advertisedToolNames = [];
let observedTaskTabCount = 0;
let observedDownloadArtifact = null;
let observedUploadReceipt = null;
let observedWalletReceipts = [];
const operations = [];

function completionChunk({ delta = {}, finishReason = null, usage }) {
  return {
    id: 'chatcmpl_freedom_product_qualification',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage && { usage }),
  };
}

function writeSse(response, chunk) {
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function finishSse(response, finishReason = 'stop') {
  writeSse(
    response,
    completionChunk({
      finishReason,
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    })
  );
  response.end('data: [DONE]\n\n');
}

function emitToolCall(response, index, name, args) {
  operations.push(name);
  writeSse(
    response,
    completionChunk({
      delta: {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${index}_${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    })
  );
  finishSse(response, 'tool_calls');
}

function emitFinal(response, content) {
  writeSse(response, completionChunk({ delta: { role: 'assistant', content } }));
  finishSse(response);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
}

function hasUserMarker(messages, marker) {
  return messages.some(
    (message) => message?.role === 'user' && contentText(message.content).includes(marker)
  );
}

function latestUserText(messages) {
  const message = [...messages].reverse().find((candidate) => candidate?.role === 'user');
  return contentText(message?.content);
}

function toolEnvelopes(messages) {
  const envelopes = [];
  for (const message of messages) {
    if (message?.role !== 'tool') continue;
    try {
      envelopes.push(JSON.parse(contentText(message.content)));
    } catch {
      // Typed Pi tool failures are intentionally not success envelopes.
    }
  }
  return envelopes;
}

function snapshotElements(messages) {
  return (
    toolEnvelopes(messages).findLast((envelope) => Array.isArray(envelope?.result?.elements))
      ?.result?.elements || []
  );
}

function allSnapshotTexts(messages) {
  return toolEnvelopes(messages)
    .filter((envelope) => typeof envelope?.result?.text === 'string')
    .map((envelope) => envelope.result.text);
}

function requireRef(elements, name) {
  const ref = elements.find((element) => element?.name === name)?.ref;
  if (typeof ref !== 'string' || !ref) throw new Error(`Missing snapshot ref for ${name}`);
  return ref;
}

function advertisedNames(body) {
  return (body.tools || [])
    .map((tool) => tool?.function?.name || tool?.name)
    .filter((name) => typeof name === 'string')
    .sort();
}

function trustedWalletEvents(messages) {
  const prefix = 'Freedom wallet event (trusted browser result): ';
  return messages
    .filter((message) => message?.role === 'user')
    .map((message) => contentText(message.content))
    .filter((value) => value.startsWith(prefix))
    .map((value) => {
      try {
        return JSON.parse(value.slice(prefix.length));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function handleCompletion(request, response) {
  const body = await readJsonBody(request);
  requestCount += 1;
  const messages = body.messages || [];
  const toolResults = messages.filter((message) => message?.role === 'tool');
  const elements = snapshotElements(messages);
  observedWalletReceipts = trustedWalletEvents(messages)
    .map((event) => event?.wallet)
    .filter(Boolean);
  advertisedToolNames = advertisedNames(body);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (hasUserMarker(messages, 'PRODUCT_SAME_ORIGIN_RESEARCH')) {
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_snapshot', {});
        break;
      case 1:
        emitToolCall(response, 2, 'browser_navigate', { url: URLS.researchNorthstar });
        break;
      case 2:
        emitToolCall(response, 3, 'browser_snapshot', {});
        break;
      case 3:
        emitToolCall(response, 4, 'browser_navigate', { url: URLS.researchMeridian });
        break;
      case 4:
        emitToolCall(response, 5, 'browser_snapshot', {});
        break;
      default: {
        const evidence = allSnapshotTexts(messages).join('\n');
        const northstar = evidence.match(/Northstar monthly price:\s*(\d+ credits)/)?.[1] || '';
        const meridian = evidence.match(/Meridian monthly price:\s*(\d+ credits)/)?.[1] || '';
        emitFinal(
          response,
          `Northstar costs ${northstar} (${URLS.researchNorthstar}). Meridian costs ${meridian} (${URLS.researchMeridian}). Meridian costs 6 credits more.`
        );
      }
    }
    return;
  }

  if (hasUserMarker(messages, 'PRODUCT_RICH_FORM')) {
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_snapshot', {});
        break;
      case 1:
        if (
          !elements
            .find((element) => element.name === 'Deployment region')
            ?.options?.some((option) => option.value === 'eu-west' && option.label === 'EU West')
        ) {
          throw new Error('The semantic snapshot did not expose the requested select option');
        }
        emitToolCall(response, 2, 'browser_select', {
          ref: requireRef(elements, 'Deployment region'),
          value: 'eu-west',
        });
        break;
      case 2:
        emitToolCall(response, 3, 'browser_type', {
          ref: requireRef(elements, 'Environment'),
          text: 'Prod',
        });
        break;
      case 3:
        emitToolCall(response, 4, 'browser_press', {
          ref: requireRef(elements, 'Environment'),
          key: 'ArrowDown',
        });
        break;
      case 4:
        emitToolCall(response, 5, 'browser_press', {
          ref: requireRef(elements, 'Environment'),
          key: 'Enter',
        });
        break;
      case 5:
        emitToolCall(response, 6, 'browser_click', {
          ref: requireRef(elements, 'Include audit logs'),
        });
        break;
      case 6:
        emitToolCall(response, 7, 'browser_click', {
          ref: requireRef(elements, 'Save preferences'),
        });
        break;
      default:
        emitFinal(response, 'EU West Production preferences were saved with audit logs enabled.');
    }
    return;
  }

  if (hasUserMarker(messages, 'PRODUCT_COLLABORATIVE_COMMIT')) {
    const resumed = latestUserText(messages).includes('The user resumed this task');
    if (resumed) {
      switch (toolResults.length) {
        case 3:
          emitToolCall(response, 3, 'browser_get_tab', {});
          break;
        case 4:
          emitToolCall(response, 4, 'browser_snapshot', {});
          break;
        case 5:
          emitToolCall(response, 5, 'browser_press', {
            ref: requireRef(elements, 'Contact email'),
            key: 'Enter',
          });
          break;
        default:
          emitFinal(response, 'The human-edited application was submitted after fresh approval.');
      }
      return;
    }
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_snapshot', {});
        break;
      case 1:
        emitToolCall(response, 2, 'browser_type', {
          ref: requireRef(elements, 'Contact email'),
          text: 'agent-draft@example.test',
        });
        break;
      default:
        emitToolCall(response, 3, 'browser_click', {
          ref: requireRef(elements, 'Submit application'),
        });
    }
    return;
  }

  if (hasUserMarker(messages, 'PRODUCT_CROSS_ORIGIN_RESEARCH')) {
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_snapshot', {});
        break;
      case 1:
        emitToolCall(response, 2, 'browser_create_tab', { url: URLS.crossOriginTarget });
        break;
      case 2:
        emitToolCall(response, 3, 'browser_snapshot', {});
        break;
      case 3:
        emitToolCall(response, 4, 'browser_click', {
          ref: requireRef(elements, 'Mark source reviewed'),
        });
        break;
      case 4:
        emitToolCall(response, 5, 'browser_list_tabs', {});
        break;
      default: {
        const envelopes = toolEnvelopes(messages);
        const latestList = envelopes.findLast((envelope) => Array.isArray(envelope?.result?.tabs));
        observedTaskTabCount = latestList?.result?.tabs?.length || 0;
        observedPolicyDenial = toolResults.some((message) =>
          contentText(message.content).includes('POLICY_DENIED')
        );
        const evidence = allSnapshotTexts(messages).join('\n');
        const primary = evidence.match(/Primary finding:\s*(local evidence)/)?.[1] || '';
        const independent =
          evidence.match(/Independent finding:\s*(verified external evidence)/)?.[1] || '';
        emitFinal(
          response,
          `Primary source reports ${primary} (${URLS.crossOriginStart}). Independent source reports ${independent} (${URLS.crossOriginTarget}).`
        );
      }
    }
    return;
  }

  if (hasUserMarker(messages, 'PRODUCT_MULTI_TAB_COMPARISON')) {
    const envelopes = toolEnvelopes(messages);
    const createdTabs = envelopes
      .map((envelope) => envelope?.result?.tab)
      .filter((tab) => typeof tab?.tabId === 'string');
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_list_tabs', {});
        break;
      case 1:
        emitToolCall(response, 2, 'browser_create_tab', {
          url: `${PRODUCT_ORIGIN}/dashboard/alpha`,
        });
        break;
      case 2:
        emitToolCall(response, 3, 'browser_snapshot', {});
        break;
      case 3:
        emitToolCall(response, 4, 'browser_create_tab', {
          url: `${PRODUCT_ORIGIN}/dashboard/beta`,
        });
        break;
      case 4:
        emitToolCall(response, 5, 'browser_snapshot', {});
        break;
      case 5:
        emitToolCall(response, 6, 'browser_list_tabs', {});
        break;
      case 6: {
        const latestList = envelopes.findLast((envelope) => Array.isArray(envelope?.result?.tabs));
        observedTaskTabCount = latestList?.result?.tabs?.length || 0;
        emitToolCall(response, 7, 'browser_focus_tab', {
          tabId: createdTabs[0]?.tabId || '',
        });
        break;
      }
      case 7:
        emitToolCall(response, 8, 'browser_snapshot', {});
        break;
      default: {
        const evidence = allSnapshotTexts(messages).join('\n');
        const alpha = evidence.match(/Alpha score:\s*(\d+)/)?.[1] || '';
        const beta = evidence.match(/Beta score:\s*(\d+)/)?.[1] || '';
        emitFinal(
          response,
          `Alpha scores ${alpha}; Beta scores ${beta}. Beta is 6 points higher. Both task tabs remain open for inspection.`
        );
      }
    }
    return;
  }

  if (hasUserMarker(messages, 'PRODUCT_FILE_DOWNLOAD')) {
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_snapshot', {});
        break;
      case 1:
        emitToolCall(response, 2, 'browser_download', {
          ref: requireRef(elements, 'Download quarterly report'),
        });
        break;
      case 2:
        emitToolCall(response, 3, 'browser_list_downloads', {});
        break;
      default: {
        const envelopes = toolEnvelopes(messages);
        observedDownloadArtifact =
          envelopes.findLast((envelope) => Array.isArray(envelope?.result?.artifacts))?.result
            ?.artifacts?.[0] ||
          envelopes.find((envelope) => envelope?.result?.artifact)?.result?.artifact ||
          null;
        emitFinal(
          response,
          `Downloaded ${observedDownloadArtifact?.filename || 'the report'} to Freedom's ${observedDownloadArtifact?.location === 'downloads' ? 'Downloads folder' : 'chosen location'} and verified that the artifact is available.`
        );
      }
    }
    return;
  }

  if (hasUserMarker(messages, 'PRODUCT_FILE_UPLOAD')) {
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_snapshot', {});
        break;
      case 1:
        emitToolCall(response, 2, 'browser_upload', {
          ref: requireRef(elements, 'Résumé file'),
        });
        break;
      case 2:
        emitToolCall(response, 3, 'browser_snapshot', {});
        break;
      default: {
        const envelopes = toolEnvelopes(messages);
        observedUploadReceipt =
          envelopes.find((envelope) => envelope?.result?.upload)?.result?.upload || null;
        const evidence = allSnapshotTexts(messages).join('\n');
        const selected = evidence.match(/Selected file:\s*([^\n]+)/)?.[1] || '';
        emitFinal(
          response,
          `Attached ${observedUploadReceipt?.filename || 'the selected file'} to the page. The page reports: ${selected}`
        );
      }
    }
    return;
  }

  if (hasUserMarker(messages, 'PRODUCT_AGENT_WALLET_APPROVE')) {
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_snapshot', {});
        break;
      case 1:
        emitToolCall(response, 2, 'browser_click', {
          ref: requireRef(elements, 'Connect wallet'),
        });
        break;
      case 2:
        emitToolCall(response, 3, 'browser_snapshot', {});
        break;
      case 3:
        emitToolCall(response, 4, 'browser_click', {
          ref: requireRef(elements, 'Freedom wallet'),
        });
        break;
      case 4:
        emitToolCall(response, 5, 'browser_snapshot', {});
        break;
      case 5:
        emitToolCall(response, 6, 'browser_click', {
          ref: requireRef(elements, 'Sign personal message'),
        });
        break;
      case 6:
        emitToolCall(response, 7, 'browser_snapshot', {});
        break;
      case 7:
        emitToolCall(response, 8, 'browser_click', {
          ref: requireRef(elements, 'Sign typed data'),
        });
        break;
      case 8:
        emitToolCall(response, 9, 'browser_snapshot', {});
        break;
      default:
        emitFinal(
          response,
          'Connected the selected Freedom account and completed both explicitly approved signatures. Freedom returned only safe wallet receipts.'
        );
    }
    return;
  }

  if (hasUserMarker(messages, 'PRODUCT_AGENT_WALLET_TRANSACTION')) {
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_snapshot', {});
        break;
      case 1:
        emitToolCall(response, 2, 'browser_click', {
          ref: requireRef(elements, 'Connect wallet'),
        });
        break;
      case 2:
        emitToolCall(response, 3, 'browser_snapshot', {});
        break;
      case 3:
        emitToolCall(response, 4, 'browser_click', {
          ref: requireRef(elements, 'Freedom wallet'),
        });
        break;
      case 4:
        emitToolCall(response, 5, 'browser_snapshot', {});
        break;
      case 5:
        emitToolCall(response, 6, 'browser_click', {
          ref: requireRef(elements, 'Send test transaction'),
        });
        break;
      case 6:
        emitToolCall(response, 7, 'browser_snapshot', {});
        break;
      default:
        emitFinal(
          response,
          'Connected the wallet and broadcast the explicitly approved transaction. Freedom returned only its safe transaction receipt.'
        );
    }
    return;
  }

  if (hasUserMarker(messages, 'PRODUCT_AGENT_WALLET_DECLINE')) {
    switch (toolResults.length) {
      case 0:
        emitToolCall(response, 1, 'browser_snapshot', {});
        break;
      case 1:
        emitToolCall(response, 2, 'browser_click', {
          ref: requireRef(elements, 'Connect wallet'),
        });
        break;
      case 2:
        emitToolCall(response, 3, 'browser_snapshot', {});
        break;
      case 3:
        emitToolCall(response, 4, 'browser_click', {
          ref: requireRef(elements, 'Freedom wallet'),
        });
        break;
      default:
        emitFinal(response, 'You declined the wallet connection, so I left it disconnected.');
    }
    return;
  }

  emitFinal(response, 'Qualification task marker missing.');
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      handleCompletion(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});

test.beforeEach(() => {
  requestCount = 0;
  observedPolicyDenial = false;
  advertisedToolNames = [];
  observedTaskTabCount = 0;
  observedDownloadArtifact = null;
  observedUploadReceipt = null;
  observedWalletReceipts = [];
  operations.length = 0;
});

async function openFixture(window, harness, url, body) {
  await harness.setContentFixture(url, { body });
  const addressInput = window.locator('[data-test="address-input"]');
  await addressInput.click();
  await addressInput.fill(url);
  await addressInput.press('Enter');
  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL?.() || '')
    )
    .toBe(url);
}

async function selectApprovalMode(window, mode) {
  await window.locator('#agent-approval-mode-button').click();
  await window.locator(`#agent-approval-mode-${mode}`).click();
}

async function configureFixtureProvider(window, approvalMode = 'allow') {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-select').selectOption('ollama');
  await window.locator('#agent-ollama-model').fill(MODEL_ID);
  await window.locator('#agent-ollama-url').fill(`${baseUrl}/v1`);
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toContainText(`Ollama · ${MODEL_ID}`);
  await selectApprovalMode(window, approvalMode);
}

async function prepareTask(window, harness, url, body, approvalMode = 'allow') {
  await openFixture(window, harness, url, body);
  await configureFixtureProvider(window, approvalMode);
}

async function runTask(window, prompt) {
  await window.locator('#agent-prompt').fill(prompt);
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 15_000 });
}

async function currentUrl(window) {
  return window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL?.() || '');
}

async function guestValue(window, expression) {
  return window.evaluate((script) => {
    return document.querySelector('webview:not(.hidden)')?.executeJavaScript(script);
  }, expression);
}

async function createUnlockedTestWallet(window) {
  await window.evaluate(async (password) => {
    const result = await window.identity.createVault(password, 128, true);
    if (!result?.success) throw new Error(result?.error || 'Could not create test wallet');
    return true;
  }, WALLET_PASSWORD);
}

async function lockTestWallet(window) {
  await window.evaluate(async () => {
    const result = await window.identity.lock();
    if (result?.success === false) throw new Error(result.error || 'Could not lock test wallet');
  });
}

function walletFixtureBody() {
  return `<!doctype html><title>Agent wallet fixture</title><main>
    <h1>Agent wallet fixture</h1>
    <button id="connect" type="button">Connect wallet</button>
    <freedom-wallet-picker id="wallet-picker" hidden></freedom-wallet-picker>
    <button id="personal" type="button">Sign personal message</button>
    <button id="typed" type="button">Sign typed data</button>
    <button id="transaction" type="button">Send test transaction</button>
    <p id="connection-status">Disconnected</p>
    <p id="personal-status">Personal signature pending</p>
    <p id="typed-status">Typed signature pending</p>
    <p id="transaction-status">Transaction pending</p>
    <script>
      let account = '';
      customElements.define('freedom-wallet-picker', class extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = \`<section role="dialog" aria-labelledby="picker-title">
            <h2 id="picker-title">Choose a wallet</h2>
            <button id="freedom-wallet" type="button">Freedom wallet</button>
            <button type="button">Another wallet</button>
          </section>\`;
        }
      });
      document.querySelector('#connect').addEventListener('click', async () => {
        document.querySelector('#wallet-picker').hidden = false;
      });
      document.querySelector('#wallet-picker').shadowRoot
        .querySelector('#freedom-wallet').addEventListener('click', async () => {
        try {
          const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
          account = accounts[0] || '';
          document.querySelector('#wallet-picker').hidden = true;
          document.querySelector('#connection-status').textContent = account
            ? 'Connected ' + account
            : 'No account returned';
        } catch (error) {
          document.querySelector('#connection-status').textContent =
            'Connection rejected ' + (error.code || 'unknown');
        }
      });
      document.querySelector('#personal').addEventListener('click', async () => {
        try {
          const signature = await window.ethereum.request({
            method: 'personal_sign',
            params: ['Freedom Agent exact personal message', account],
          });
          document.querySelector('#personal-status').textContent =
            'Personal signature ' + signature.slice(0, 10);
        } catch (error) {
          document.querySelector('#personal-status').textContent =
            'Personal signature rejected ' + (error.code || 'unknown');
        }
      });
      document.querySelector('#typed').addEventListener('click', async () => {
        const payload = {
          domain: { name: 'Freedom Agent Fixture', chainId: 100 },
          types: { Message: [{ name: 'contents', type: 'string' }] },
          primaryType: 'Message',
          message: { contents: 'Approve typed Freedom action' },
        };
        try {
          const signature = await window.ethereum.request({
            method: 'eth_signTypedData_v4',
            params: [account, JSON.stringify(payload)],
          });
          document.querySelector('#typed-status').textContent =
            'Typed signature ' + signature.slice(0, 10);
        } catch (error) {
          document.querySelector('#typed-status').textContent =
            'Typed signature rejected ' + (error.code || 'unknown');
        }
      });
      document.querySelector('#transaction').addEventListener('click', async () => {
        try {
          const hash = await window.ethereum.request({
            method: 'eth_sendTransaction',
            params: [{
              from: account,
              to: '0x3333333333333333333333333333333333333333',
              value: '0xde0b6b3a7640000',
              data: '0xabcdef12',
            }],
          });
          document.querySelector('#transaction-status').textContent = 'Transaction ' + hash;
        } catch (error) {
          document.querySelector('#transaction-status').textContent =
            'Transaction rejected ' + (error.code || 'unknown');
        }
      });
    </script>
  </main>`;
}

async function recordQualification(window, taskId, classification, evidence = {}) {
  const operationLabels = (await window.locator('.agent-tool-item').allTextContents()).map(
    (label) => label.replace(/^[•✓×]\s*/, '')
  );
  const result = {
    taskId,
    classification,
    runStatus: (await window.locator('#agent-run-status').textContent())?.trim() || '',
    assistantOutput: (await window.locator('#agent-output').textContent())?.trim() || '',
    modelRequests: requestCount,
    toolCalls: operationLabels.length,
    operations: operationLabels,
    toolStates: await window.locator('.agent-tool-state').allTextContents(),
    advertisedTools: advertisedToolNames,
    ...evidence,
  };
  await test.info().attach(`product-qualification-${taskId}`, {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  console.log(`[Agent product qualification] ${JSON.stringify(result)}`);
  test.info().annotations.push({ type: 'qualification', description: JSON.stringify(result) });
  return result;
}

test('baseline: same-origin multi-page research passes with attributable evidence', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(URLS.researchNorthstar, {
    body: `<!doctype html><title>Northstar catalog</title><main>
      <h1>Northstar catalog</h1><p>Northstar monthly price: 12 credits</p>
    </main>`,
  });
  await harness.setContentFixture(URLS.researchMeridian, {
    body: `<!doctype html><title>Meridian catalog</title><main>
      <h1>Meridian catalog</h1><p>Meridian monthly price: 18 credits</p>
    </main>`,
  });
  await prepareTask(
    window,
    harness,
    URLS.researchStart,
    `<!doctype html><title>Plan comparison</title><main>
      <h1>Compare plans</h1>
      <a href="${URLS.researchNorthstar}">Northstar source</a>
      <a href="${URLS.researchMeridian}">Meridian source</a>
    </main>`
  );

  await runTask(
    window,
    'PRODUCT_SAME_ORIGIN_RESEARCH: compare both linked plan sources, report each exact monthly price with its source URL, and state the difference.'
  );
  const result = await recordQualification(window, 'same-origin-research', CLASSIFICATION.PASS, {
    finalUrl: await currentUrl(window),
  });

  expect(result.assistantOutput).toContain('Northstar costs 12 credits');
  expect(result.assistantOutput).toContain('Meridian costs 18 credits');
  expect(result.assistantOutput).toContain(URLS.researchNorthstar);
  expect(result.assistantOutput).toContain(URLS.researchMeridian);
  expect(result.assistantOutput).toContain('6 credits more');
  expect(result.finalUrl).toBe(URLS.researchMeridian);
  await expect(window.locator('.agent-turn-outcome').last()).toContainText(
    'Result checked in the browser'
  );
  await expect(window.locator('.agent-turn-activity summary').last()).toContainText(
    'Result checked'
  );
  expect(operations).toEqual([
    'browser_snapshot',
    'browser_navigate',
    'browser_snapshot',
    'browser_navigate',
    'browser_snapshot',
  ]);
});

test('baseline: rich form passes with semantic select and bounded keyboard capabilities', async ({
  window,
  harness,
}) => {
  await prepareTask(
    window,
    harness,
    URLS.richForm,
    `<!doctype html><title>Deployment preferences</title><main>
      <h1>Deployment preferences</h1>
      <label for="region">Deployment region</label>
      <select id="region" aria-label="Deployment region">
        <option value="">Choose a region</option>
        <option value="eu-west">EU West</option>
        <option value="us-east">US East</option>
      </select>
      <label for="environment">Environment</label>
      <input id="environment" aria-label="Environment" aria-autocomplete="list">
      <label><input id="audit" type="checkbox" aria-label="Include audit logs"> Include audit logs</label>
      <button id="save">Save preferences</button>
      <p id="status">Preferences unchanged</p>
    </main>
    <script>
      window.__controlEvidence = { selectTrusted: false, typeTrusted: false, keysTrusted: [] };
      const region = document.querySelector('#region');
      const environment = document.querySelector('#environment');
      region.addEventListener('change', (event) => {
        window.__controlEvidence.selectTrusted = event.isTrusted;
      });
      environment.addEventListener('input', (event) => {
        window.__controlEvidence.typeTrusted = event.isTrusted;
      });
      environment.addEventListener('keydown', (event) => {
        window.__controlEvidence.keysTrusted.push(event.key + '=' + event.isTrusted);
        if (event.key === 'ArrowDown') environment.dataset.suggestion = 'Production';
        if (event.key === 'Enter' && environment.dataset.suggestion) {
          event.preventDefault();
          environment.value = environment.dataset.suggestion;
        }
      });
      document.querySelector('#save').addEventListener('click', (event) => {
        const audit = document.querySelector('#audit');
        document.querySelector('#status').textContent =
          'Saved ' + region.value + ' / ' + environment.value +
          ' / audit=' + audit.checked + ' / trusted click=' + event.isTrusted;
      });
    </script>`
  );

  await runTask(
    window,
    'PRODUCT_RICH_FORM: choose EU West, select the Production autocomplete option using the keyboard, include audit logs, and save the preferences.'
  );
  const result = await recordQualification(window, 'rich-form', CLASSIFICATION.PASS, {
    region: await guestValue(window, 'document.querySelector("#region").value'),
    environment: await guestValue(window, 'document.querySelector("#environment").value'),
    auditEnabled: await guestValue(window, 'document.querySelector("#audit").checked'),
    status: await guestValue(window, 'document.querySelector("#status").textContent'),
    evidence: await guestValue(window, 'window.__controlEvidence'),
  });

  expect(result.assistantOutput).toContain('EU West Production preferences were saved');
  expect(result.advertisedTools).toEqual([...EXPECTED_TOOL_NAMES].sort());
  expect(result).toMatchObject({
    region: 'eu-west',
    environment: 'Production',
    auditEnabled: true,
    status: 'Saved eu-west / Production / audit=true / trusted click=true',
    evidence: {
      selectTrusted: false,
      typeTrusted: true,
      keysTrusted: ['ArrowDown=true', 'Enter=true'],
    },
  });
  await expect(window.locator('.agent-turn-outcome').last()).toContainText(
    'Browser actions recorded'
  );
  await expect(window.locator('.agent-turn-outcome').last()).toContainText(
    'did not recheck the page after its last change'
  );
  expect(operations).toEqual([
    'browser_snapshot',
    'browser_select',
    'browser_type',
    'browser_press',
    'browser_press',
    'browser_click',
    'browser_click',
  ]);
});

test('baseline: Take over, human edit, Resume, and fresh approval preserve collaboration', async ({
  window,
  harness,
}) => {
  await prepareTask(
    window,
    harness,
    URLS.collaborativeForm,
    `<!doctype html><title>Partner application</title><main>
      <h1>Partner application</h1>
      <form id="application">
        <label for="email">Contact email</label>
        <input id="email" aria-label="Contact email">
        <button id="submit" type="submit">Submit application</button>
      </form>
      <p id="confirmation">Not submitted</p>
    </main>
    <script>
      document.querySelector('#submit').addEventListener('click', (event) => {
        event.preventDefault();
        document.querySelector('#confirmation').textContent =
          'Submitted ' + document.querySelector('#email').value +
          ' — trusted click=' + event.isTrusted;
      });
    </script>`,
    'every'
  );

  await window
    .locator('#agent-prompt')
    .fill('PRODUCT_COLLABORATIVE_COMMIT: draft and submit this partner application.');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-approval')).toBeVisible();
  await expect(window.locator('#agent-approval-action')).toContainText('Contact email');
  await window.locator('#agent-approval-approve').click();
  await expect(window.locator('#agent-approval-action')).toContainText('Submit application');
  await expect(window.locator('#agent-approval-origin')).toHaveText('agent-product.test');
  await expect(window.locator('[data-test="agent-page-interlock"]')).toBeVisible();
  await window.locator('[data-test="agent-page-interlock"]').click({ position: { x: 10, y: 10 } });
  await expect(window.locator('#agent-takeover-dialog')).toBeVisible();
  await window.locator('#agent-takeover-confirm').click();
  await expect(window.locator('#agent-run-status')).toHaveText('You’re in control', {
    timeout: 5_000,
  });
  await expect(window.locator('#agent-approval')).toBeHidden();

  await guestValue(
    window,
    `(() => {
      const input = document.querySelector('#email');
      input.value = 'human-edited@example.test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  await expect(window.locator('#agent-run')).toHaveAttribute('data-action', 'resume');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-approval')).toBeVisible({ timeout: 10_000 });
  await window.locator('#agent-approval-approve').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 15_000 });

  const confirmation = await guestValue(
    window,
    'document.querySelector("#confirmation").textContent'
  );
  const result = await recordQualification(
    window,
    'collaborative-consequential-workflow',
    CLASSIFICATION.PASS,
    { confirmation }
  );

  expect(confirmation).toBe('Submitted human-edited@example.test — trusted click=true');
  expect(result.assistantOutput).toContain('human-edited application');
  await expect(window.locator('.agent-turn-outcome').last()).toContainText(
    'Approved destination: https://agent-product.test'
  );
  expect(operations).toEqual([
    'browser_snapshot',
    'browser_type',
    'browser_click',
    'browser_get_tab',
    'browser_snapshot',
    'browser_press',
  ]);
});

test('baseline: cross-site workspace reads and interacts across origins', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(URLS.crossOriginTarget, {
    body: `<!doctype html><title>Independent report</title><main>
      <h1>Independent report</h1><p>Independent finding: verified external evidence</p>
      <button id="review">Mark source reviewed</button><p id="status">Not reviewed</p>
    </main><script>
      document.querySelector('#review').addEventListener('click', (event) => {
        document.querySelector('#status').textContent = 'Reviewed — trusted=' + event.isTrusted;
      });
    </script>`,
  });
  await prepareTask(
    window,
    harness,
    URLS.crossOriginStart,
    `<!doctype html><title>Research brief</title><main>
      <h1>Research brief</h1><p>Primary finding: local evidence</p>
      <a href="${URLS.crossOriginTarget}">Independent source</a>
    </main>`
  );
  await runTask(
    window,
    'PRODUCT_CROSS_ORIGIN_RESEARCH: compare the primary finding with the linked independent source, mark the independent source reviewed, and cite both.'
  );
  const result = await recordQualification(window, 'cross-origin-workspace', CLASSIFICATION.PASS, {
    finalUrl: await currentUrl(window),
    policyDenied: observedPolicyDenial,
    taskTabCount: observedTaskTabCount,
    reviewStatus: await guestValue(window, 'document.querySelector("#status").textContent'),
  });

  expect(result.policyDenied).toBe(false);
  expect(result.taskTabCount).toBe(2);
  expect(result.reviewStatus).toBe('Reviewed — trusted=true');
  expect(result.finalUrl).toBe(URLS.crossOriginTarget);
  expect(result.toolStates).toEqual(['✓', '✓', '✓', '✓', '✓']);
  expect(result.assistantOutput).toContain('local evidence');
  expect(result.assistantOutput).toContain('verified external evidence');
  expect(result.assistantOutput).toContain(URLS.crossOriginStart);
  expect(result.assistantOutput).toContain(URLS.crossOriginTarget);
  expect(operations).toEqual([
    'browser_snapshot',
    'browser_create_tab',
    'browser_snapshot',
    'browser_click',
    'browser_list_tabs',
  ]);
});

test('baseline: multi-tab comparison passes inside a task-owned visible workspace', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(`${PRODUCT_ORIGIN}/dashboard/alpha`, {
    body: '<!doctype html><title>Alpha dashboard</title><main><h1>Alpha dashboard</h1><p>Alpha score: 41</p></main>',
  });
  await harness.setContentFixture(`${PRODUCT_ORIGIN}/dashboard/beta`, {
    body: '<!doctype html><title>Beta dashboard</title><main><h1>Beta dashboard</h1><p>Beta score: 47</p></main>',
  });
  await prepareTask(
    window,
    harness,
    URLS.multiTab,
    `<!doctype html><title>Workspace comparison</title><main>
      <h1>Compare independent dashboards</h1>
      <a href="${PRODUCT_ORIGIN}/dashboard/alpha" target="_blank">Alpha dashboard</a>
      <a href="${PRODUCT_ORIGIN}/dashboard/beta" target="_blank">Beta dashboard</a>
    </main>`
  );

  await runTask(
    window,
    'PRODUCT_MULTI_TAB_COMPARISON: open both dashboards in separate task tabs, compare them, and keep both available for inspection.'
  );
  const result = await recordQualification(window, 'multi-tab-comparison', CLASSIFICATION.PASS, {
    browserTabCount: await window.locator('[data-test="tab"]').count(),
    taskTabCount: observedTaskTabCount,
  });

  expect(result.browserTabCount).toBe(3);
  expect(result.taskTabCount).toBe(3);
  expect(result.assistantOutput).toContain('Alpha scores 41; Beta scores 47');
  expect(result.assistantOutput).toContain('Both task tabs remain open for inspection');
  expect(operations).toEqual([
    'browser_list_tabs',
    'browser_create_tab',
    'browser_snapshot',
    'browser_create_tab',
    'browser_snapshot',
    'browser_list_tabs',
    'browser_focus_tab',
    'browser_snapshot',
  ]);
});

test('baseline: file delivery uses scoped download authority and a verified receipt', async ({
  window,
  harness,
  electronApp,
}) => {
  await harness.setContentFixture(URLS.fileTarget, {
    body: 'Freedom quarterly report fixture',
    contentType: 'text/plain; charset=utf-8',
  });
  await prepareTask(
    window,
    harness,
    URLS.fileDownload,
    `<!doctype html><title>Quarterly report</title><main>
      <h1>Quarterly report</h1>
      <a id="download" href="${URLS.fileTarget}" download="freedom-quarterly-report.txt">
        Download quarterly report
      </a>
      <p id="status">No artifact delivered</p>
    </main>`
  );

  await window
    .locator('#agent-prompt')
    .fill(
      'PRODUCT_FILE_DOWNLOAD: download the quarterly report and provide a verified artifact receipt.'
    );
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-approval')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#agent-approval-action')).toHaveText('Download quarterly report?');
  await expect(window.locator('#agent-approval-origin')).toHaveText('agent-product.test');
  const approvalLayout = await window.locator('#agent-approval').evaluate((approval) => {
    const decline = approval.querySelector('#agent-approval-decline').getBoundingClientRect();
    const allow = approval.querySelector('#agent-approval-approve').getBoundingClientRect();
    const status = approval.querySelector('.agent-approval-status').getBoundingClientRect();
    return {
      declineTop: decline.top,
      declineWidth: decline.width,
      allowTop: allow.top,
      allowWidth: allow.width,
      buttonsBottom: Math.max(decline.bottom, allow.bottom),
      statusTop: status.top,
    };
  });
  expect(Math.abs(approvalLayout.declineTop - approvalLayout.allowTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(approvalLayout.declineWidth - approvalLayout.allowWidth)).toBeLessThanOrEqual(1);
  expect(approvalLayout.statusTop).toBeGreaterThan(approvalLayout.buttonsBottom);
  await window.locator('#agent-approval-approve').click();
  const shelfCard = window.locator('#download-shelf .download-card');
  await expect(shelfCard).toBeVisible({ timeout: 10_000 });
  const shelfLayout = await shelfCard.evaluate((card) => {
    const cardRect = card.getBoundingClientRect();
    const pageRect = card.closest('.content-page').getBoundingClientRect();
    const sidebarRect = document.querySelector('#agent-sidebar').getBoundingClientRect();
    return {
      cardRight: cardRect.right,
      pageRight: pageRect.right,
      sidebarLeft: sidebarRect.left,
    };
  });
  expect(shelfLayout.cardRight).toBeLessThanOrEqual(shelfLayout.pageRight);
  expect(shelfLayout.cardRight).toBeLessThan(shelfLayout.sidebarLeft);
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 15_000 });
  const downloadsDir = await electronApp.evaluate(({ app }) => app.getPath('downloads'));
  const downloadedContent = fs.readFileSync(
    path.join(downloadsDir, 'freedom-quarterly-report.txt'),
    'utf8'
  );
  const result = await recordQualification(window, 'file-download-receipt', CLASSIFICATION.PASS, {
    artifact: observedDownloadArtifact,
    downloadedContent,
  });

  expect(result.assistantOutput).toContain("Freedom's Downloads folder");
  expect(result.assistantOutput).toContain('verified that the artifact is available');
  expect(result.advertisedTools).toEqual([...EXPECTED_TOOL_NAMES].sort());
  expect(result.downloadedContent).toBe('Freedom quarterly report fixture');
  expect(result.artifact).toMatchObject({
    artifactId: expect.stringMatching(/^artifact_[a-f0-9]{20}$/),
    filename: 'freedom-quarterly-report.txt',
    state: 'completed',
    location: 'downloads',
    available: true,
  });
  expect(result.artifact).not.toHaveProperty('savePath');
  expect(JSON.stringify(result.artifact)).not.toContain('/Users/');
  await expect(window.locator('.agent-artifact')).toContainText('freedom-quarterly-report.txt');
  await expect(window.locator('.agent-turn-outcome').last()).toContainText('File downloaded');
  expect(operations).toEqual(['browser_snapshot', 'browser_download', 'browser_list_downloads']);
});

test('baseline: file upload uses native user selection and a redacted receipt', async ({
  window,
  harness,
  electronApp,
}) => {
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  const selectedPath = path.join(userDataDir, 'private-agent-upload.txt');
  fs.writeFileSync(selectedPath, 'Freedom upload fixture', 'utf8');
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, selectedPath);
  await prepareTask(
    window,
    harness,
    URLS.fileUpload,
    `<!doctype html><title>Application upload</title><main>
      <h1>Application upload</h1>
      <label for="resume">Résumé file</label>
      <input id="resume" type="file" aria-label="Résumé file" accept=".txt">
      <p id="status">No file selected</p>
      <script>
        document.querySelector('#resume').addEventListener('change', (event) => {
          const file = event.target.files[0];
          document.querySelector('#status').textContent = file
            ? 'Selected file: ' + file.name + ' (' + file.size + ' bytes)'
            : 'No file selected';
        });
      </script>
    </main>`
  );

  await window
    .locator('#agent-prompt')
    .fill('PRODUCT_FILE_UPLOAD: attach the résumé file I choose and verify the page received it.');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-approval')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#agent-approval-action')).toHaveText(
    'Choose a file to share with agent-product.test?'
  );
  await expect(window.locator('#agent-approval-origin')).toContainText('Résumé file');
  await expect(window.locator('#agent-approval-origin')).toContainText('never shows Agent');
  await expect(window.locator('#agent-approval-approve')).toHaveText('Choose file…');
  await window.locator('#agent-approval-approve').click();

  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 15_000 });
  const result = await recordQualification(window, 'file-upload-receipt', CLASSIFICATION.PASS, {
    upload: observedUploadReceipt,
    selectedStatus: await guestValue(window, 'document.querySelector("#status").textContent'),
  });

  expect(result.assistantOutput).toContain('private-agent-upload.txt');
  expect(result.selectedStatus).toBe('Selected file: private-agent-upload.txt (22 bytes)');
  expect(result.upload).toMatchObject({
    filename: 'private-agent-upload.txt',
    bytes: 22,
    state: 'attached',
  });
  expect(result.upload).not.toHaveProperty('path');
  expect(JSON.stringify(result.upload)).not.toContain(userDataDir);
  expect(operations).toEqual(['browser_snapshot', 'browser_upload', 'browser_snapshot']);
});

test('privileged capability: wallet connect and signatures use Agent-native approval', async ({
  window,
  harness,
}) => {
  await createUnlockedTestWallet(window);
  await prepareTask(window, harness, URLS.wallet, walletFixtureBody());

  await window
    .locator('#agent-prompt')
    .fill(
      'PRODUCT_AGENT_WALLET_APPROVE: connect the wallet, sign the exact personal message, and sign the exact typed data. Ask me for every wallet decision.'
    );
  await window.locator('#agent-run').click();

  await expect(window.locator('#agent-approval')).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('#agent-approval-action')).toHaveText(
    'Connect this site to a wallet account?'
  );
  await expect(window.locator('#agent-wallet-approval-summary')).toContainText(
    'agent-product.test'
  );
  await expect(window.locator('#agent-wallet-account option')).toHaveCount(1);
  await expect(window.locator('#agent-approval-approve')).toHaveText('Connect once');
  await window.locator('#agent-approval-approve').click();

  await expect(window.locator('#agent-approval-action')).toHaveText(
    'Approve this wallet signature?',
    { timeout: 10_000 }
  );
  await expect(window.locator('#agent-wallet-approval-summary')).toContainText(
    'Freedom Agent exact personal message'
  );
  await expect(window.locator('#agent-approval-approve')).toHaveText('Sign once');
  await window.locator('#agent-approval-approve').click();

  await expect(window.locator('#agent-wallet-approval-summary')).toContainText(
    'Approve typed Freedom action',
    { timeout: 10_000 }
  );
  await expect(window.locator('#agent-wallet-approval-summary')).toContainText(
    'Freedom Agent Fixture'
  );
  await window.locator('#agent-approval-approve').click();

  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 15_000 });
  const connectionStatus = await guestValue(
    window,
    'document.querySelector("#connection-status").textContent'
  );
  const personalStatus = await guestValue(
    window,
    'document.querySelector("#personal-status").textContent'
  );
  const typedStatus = await guestValue(
    window,
    'document.querySelector("#typed-status").textContent'
  );
  const result = await recordQualification(
    window,
    'agent-native-wallet-signatures',
    CLASSIFICATION.PASS,
    { connectionStatus, personalStatus, typedStatus, walletReceipts: observedWalletReceipts }
  );

  expect(result.connectionStatus).toMatch(/^Connected 0x[0-9a-fA-F]{40}$/);
  expect(result.personalStatus).toMatch(/^Personal signature 0x[0-9a-fA-F]{8}$/);
  expect(result.typedStatus).toMatch(/^Typed signature 0x[0-9a-fA-F]{8}$/);
  expect(result.walletReceipts).toEqual([
    expect.objectContaining({ action: 'connected', origin: 'https://agent-product.test' }),
    expect.objectContaining({ action: 'signed', signatureType: 'personal_sign' }),
    expect.objectContaining({ action: 'signed', signatureType: 'eth_signTypedData_v4' }),
  ]);
  expect(JSON.stringify(result.walletReceipts)).not.toMatch(/0x[0-9a-fA-F]{130}/);
  expect(result.assistantOutput).toContain('safe wallet receipts');
  expect(operations).toEqual([
    'browser_snapshot',
    'browser_click',
    'browser_snapshot',
    'browser_click',
    'browser_snapshot',
    'browser_click',
    'browser_snapshot',
    'browser_click',
    'browser_snapshot',
  ]);
});

test('privileged capability: declining an Agent wallet request is final and recoverable', async ({
  window,
  harness,
}) => {
  await createUnlockedTestWallet(window);
  await prepareTask(window, harness, URLS.walletDecline, walletFixtureBody(), 'every');

  await window
    .locator('#agent-prompt')
    .fill('PRODUCT_AGENT_WALLET_DECLINE: try to connect the wallet once.');
  await window.locator('#agent-run').click();

  await expect(window.locator('#agent-approval-action')).toHaveText(
    'Let Agent click “Connect wallet”?',
    { timeout: 10_000 }
  );
  await window.locator('#agent-approval-approve').click();
  await expect(window.locator('#agent-approval-action')).toHaveText(
    'Let Agent click “Freedom wallet”?',
    { timeout: 10_000 }
  );
  await window.locator('#agent-approval-approve').click();
  await expect(window.locator('#agent-approval-action')).toHaveText(
    'Connect this site to a wallet account?',
    { timeout: 10_000 }
  );
  await window.locator('#agent-approval-decline').click();

  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 15_000 });
  await expect(window.locator('.agent-tool-item').last()).toContainText('Wallet request declined');
  expect(
    await guestValue(window, 'document.querySelector("#connection-status").textContent')
  ).toBe('Connection rejected 4001');
  expect((await window.locator('#agent-output').textContent()) || '').toContain(
    'left it disconnected'
  );
  expect(operations).toEqual([
    'browser_snapshot',
    'browser_click',
    'browser_snapshot',
    'browser_click',
  ]);
});

test('privileged capability: locked-wallet transaction shows exact data and returns a safe receipt', async ({
  window,
  harness,
}) => {
  await createUnlockedTestWallet(window);
  await lockTestWallet(window);
  await prepareTask(window, harness, URLS.walletTransaction, walletFixtureBody());

  await window
    .locator('#agent-prompt')
    .fill(
      'PRODUCT_AGENT_WALLET_TRANSACTION: connect the wallet and send the requested test transaction. Ask me for every wallet decision.'
    );
  await window.locator('#agent-run').click();

  await expect(window.locator('#agent-approval-action')).toHaveText(
    'Connect this site to a wallet account?',
    { timeout: 10_000 }
  );
  await window.locator('#agent-approval-approve').click();

  await expect(window.locator('#agent-approval-action')).toHaveText(
    'Approve this wallet transaction?',
    { timeout: 10_000 }
  );
  const summary = window.locator('#agent-wallet-approval-summary');
  await expect(summary).toContainText('0x3333333333333333333333333333333333333333');
  await expect(summary).toContainText('1.0 xDAI');
  await expect(summary).toContainText('0.000021 xDAI');
  await expect(summary).toContainText('0xabcdef12');
  await expect(window.locator('#agent-approval-approve')).toHaveText('Confirm transaction');
  await window.locator('#agent-approval-approve').click();

  await expect(window.locator('#agent-wallet-unlock')).toBeVisible();
  await expect(window.locator('#agent-approval-message')).toHaveText('Wallet is locked');
  await window.locator('#agent-wallet-password').fill(WALLET_PASSWORD);
  await window.locator('#agent-wallet-unlock-submit').click();

  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 15_000 });
  const deterministicHash = `0x${'ab'.repeat(32)}`;
  const transactionStatus = await guestValue(
    window,
    'document.querySelector("#transaction-status").textContent'
  );
  const identityStatus = await window.evaluate(() => window.identity.getStatus());
  const harnessState = await harness.state();
  const result = await recordQualification(
    window,
    'agent-native-wallet-transaction',
    CLASSIFICATION.PASS,
    {
      transactionStatus,
      identityUnlocked: identityStatus?.isUnlocked,
      capturedTransaction: harnessState.agentWalletTransaction,
      walletReceipts: observedWalletReceipts,
    }
  );

  expect(result.transactionStatus).toBe(`Transaction ${deterministicHash}`);
  expect(result.identityUnlocked).toBe(true);
  expect(result.capturedTransaction).toEqual({
    transaction: {
      to: '0x3333333333333333333333333333333333333333',
      value: '0xde0b6b3a7640000',
      data: '0xabcdef12',
      gasLimit: '21000',
      chainId: 100,
      gasPrice: '1000000000',
    },
    context: { kind: 'dapp-send', origin: PRODUCT_ORIGIN },
  });
  expect(result.walletReceipts).toEqual([
    expect.objectContaining({ action: 'connected', origin: PRODUCT_ORIGIN }),
    expect.objectContaining({
      action: 'broadcast',
      transactionHash: deterministicHash,
      paymentId: 'payment_agent_wallet_test',
    }),
  ]);
  expect(JSON.stringify(result.walletReceipts)).not.toContain('abcdef12');
  expect(result.assistantOutput).toContain('safe transaction receipt');
  expect(operations).toEqual([
    'browser_snapshot',
    'browser_click',
    'browser_snapshot',
    'browser_click',
    'browser_snapshot',
    'browser_click',
    'browser_snapshot',
  ]);
});
