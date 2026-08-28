'use strict';

const { OPERATIONS } = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');
const { activityProgress, buildAgentOutcome, createToolReceipt } = require('./agent-progress');

describe('Agent progress projection', () => {
  test('projects only an origin and opaque page identity from browser receipts', () => {
    const receipt = createToolReceipt(OPERATIONS.SNAPSHOT, {
      envelope: {
        ok: true,
        tabId: 'tab_private',
        result: {
          url: 'https://accounts.example/private?token=secret#section',
          title: 'Private account',
          text: 'sensitive page contents',
        },
      },
    });

    expect(receipt).toEqual({
      pageId: 'tab_private',
      origin: 'https://accounts.example',
    });
    expect(JSON.stringify(receipt)).not.toMatch(/token|secret|Private account|sensitive/);
    expect(activityProgress(OPERATIONS.SNAPSHOT, receipt)).toMatchObject({
      intent: 'Reading https://accounts.example',
      label: 'Read https://accounts.example',
      effect: 'observed',
    });
  });

  test('summarizes listed tabs without retaining their URLs', () => {
    const receipt = createToolReceipt(OPERATIONS.LIST_TABS, {
      envelope: {
        ok: true,
        result: {
          tabs: [
            { tabId: 'tab_1', url: 'https://one.example/private' },
            { tabId: 'tab_2', url: 'ipfs://bafy/private' },
          ],
        },
      },
    });

    expect(receipt).toEqual({ pageCount: 2 });
    expect(activityProgress(OPERATIONS.LIST_TABS, receipt)).toMatchObject({
      intent: 'Checking 2 Agent tabs',
      label: 'Checked 2 Agent tabs',
    });
  });

  test('projects a safe artifact receipt and verifies completed downloads', () => {
    const artifact = {
      artifactId: 'artifact_1234567890abcdef1234',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      bytes: 2048,
      state: 'completed',
      sourceOrigin: 'https://files.example',
      location: 'downloads',
      available: true,
      savePath: '/Users/private/report.pdf',
    };
    const receipt = createToolReceipt(OPERATIONS.DOWNLOAD, {
      envelope: { ok: true, result: { artifact } },
    });

    expect(receipt).toEqual({
      artifact: expect.not.objectContaining({ savePath: expect.anything() }),
    });
    expect(activityProgress(OPERATIONS.DOWNLOAD, receipt)).toMatchObject({
      intent: 'Downloading report.pdf',
      label: 'Downloaded report.pdf',
      effect: 'changed',
    });
    expect(
      buildAgentOutcome(
        [{ operation: OPERATIONS.DOWNLOAD, status: 'succeeded', artifact }],
        'completed'
      )
    ).toMatchObject({
      verification: 'artifact_available',
      headline: 'File downloaded',
      counts: { artifacts: 1 },
    });
  });

  test('projects an attached-file receipt without retaining its local path', () => {
    const receipt = createToolReceipt(OPERATIONS.UPLOAD, {
      envelope: {
        ok: true,
        result: {
          upload: {
            filename: 'résumé.pdf',
            mimeType: 'application/pdf',
            bytes: 4096,
            state: 'attached',
            path: '/Users/private/Documents/résumé.pdf',
          },
        },
      },
    });

    expect(receipt).toEqual({
      upload: {
        filename: 'résumé.pdf',
        mimeType: 'application/pdf',
        bytes: 4096,
        state: 'attached',
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('/Users/private');
    expect(activityProgress(OPERATIONS.UPLOAD, receipt)).toMatchObject({
      intent: 'Choosing résumé.pdf',
      label: 'Attached résumé.pdf',
      effect: 'changed',
    });
  });

  test('projects only the safe direct wallet broadcast receipt', () => {
    const receipt = createToolReceipt(OPERATIONS.WALLET_TRANSFER, {
      envelope: {
        ok: true,
        result: {
          wallet: {
            action: 'broadcast',
            transactionHash: '0xtransaction',
            paymentId: 'payment_test',
            chainId: 100,
            recipient: '0x3333333333333333333333333333333333333333',
            amount: '0.01',
            asset: 'GNO',
            privateKey: 'secret',
            rawTransaction: '0xsigned',
          },
        },
      },
    });

    expect(receipt).toEqual({
      wallet: {
        action: 'broadcast',
        transactionHash: '0xtransaction',
        paymentId: 'payment_test',
        chainId: 100,
        recipient: '0x3333333333333333333333333333333333333333',
        amount: '0.01',
        asset: 'GNO',
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/secret|signed|privateKey|rawTransaction/);
    expect(activityProgress(OPERATIONS.WALLET_TRANSFER, receipt)).toMatchObject({
      intent: 'Sending 0.01 GNO',
      label: 'Sent 0.01 GNO',
      effect: 'changed',
    });
    expect(
      buildAgentOutcome(
        [
          {
            operation: OPERATIONS.WALLET_TRANSFER,
            status: 'succeeded',
            effect: 'changed',
            wallet: receipt.wallet,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'wallet_broadcast',
      headline: 'Wallet transfer broadcast',
      detail: expect.stringContaining('0xtransaction'),
      counts: { walletTransfers: 1 },
    });
  });

  test('projects only a bounded node summary and reports node-specific completion', () => {
    const receipt = createToolReceipt(OPERATIONS.NODE_STATUS, {
      envelope: {
        ok: true,
        result: {
          summary: { total: 6, ready: 3, active: 4, disabled: 1, attention: 2 },
          nodes: [
            {
              id: 'ipfs',
              state: 'error',
              endpoint: 'http://127.0.0.1:secret',
              error: 'private daemon failure',
            },
          ],
        },
      },
    });

    expect(receipt).toEqual({
      nodeStatus: { total: 6, ready: 3, active: 4, disabled: 1, attention: 2 },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/endpoint|secret|daemon|nodes/);
    expect(activityProgress(OPERATIONS.NODE_STATUS, receipt)).toMatchObject({
      intent: 'Checking 6 services',
      label: 'Checked 6 services',
      effect: 'observed',
    });
    expect(
      buildAgentOutcome(
        [
          {
            operation: OPERATIONS.NODE_STATUS,
            status: 'succeeded',
            effect: 'observed',
            nodeStatus: receipt.nodeStatus,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'nodes_inspected',
      tone: 'caution',
      headline: 'Node status checked',
      detail: 'Freedom checked 6 integrated services: 3 ready, 1 disabled, 2 need attention.',
      counts: { nodeChecks: 1, pages: 0 },
    });
  });

  test('projects only diagnostic counts and never raw logs into Agent history', () => {
    const receipt = createToolReceipt(OPERATIONS.NODE_DIAGNOSTICS, {
      envelope: {
        ok: true,
        result: {
          scope: 'node',
          service: 'ipfs',
          runtime: { platform: 'darwin' },
          status: { id: 'ipfs', error: 'private failure' },
          logs: {
            entries: [{ text: '/Users/private/node.log authorization header' }],
            lineCount: 1,
            bytes: 51,
            truncated: false,
          },
          summary: {
            scope: 'node',
            service: 'ipfs',
            lineCount: 1,
            bytes: 51,
            truncated: false,
          },
        },
      },
    });

    expect(receipt).toEqual({
      diagnostic: {
        scope: 'node',
        service: 'ipfs',
        lineCount: 1,
        bytes: 51,
        truncated: false,
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/private|authorization|runtime|status|entries/);
    expect(activityProgress(OPERATIONS.NODE_DIAGNOSTICS, receipt)).toMatchObject({
      intent: 'Inspecting ipfs diagnostics',
      label: 'Inspected 1 diagnostic line',
      effect: 'observed',
    });
    expect(
      buildAgentOutcome(
        [
          {
            operation: OPERATIONS.NODE_STATUS,
            status: 'succeeded',
            effect: 'observed',
            nodeStatus: { total: 6, ready: 3, active: 4, disabled: 1, attention: 2 },
          },
          {
            operation: OPERATIONS.NODE_DIAGNOSTICS,
            status: 'succeeded',
            effect: 'observed',
            diagnostic: receipt.diagnostic,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'diagnostics_inspected',
      headline: 'Diagnostics inspected',
      diagnostic: receipt.diagnostic,
      counts: { diagnostics: 1, nodeChecks: 1, pages: 0 },
    });
  });

  test('treats a declined wallet request as a final user decision, not a failure', () => {
    expect(
      buildAgentOutcome(
        [
          {
            operation: OPERATIONS.WALLET_TRANSFER,
            status: 'failed',
            effect: 'changed',
            approval: 'declined',
            errorCode: ERROR_CODES.WALLET_REQUEST_CANCELLED_BY_USER,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'wallet_declined',
      tone: 'neutral',
      headline: 'Wallet request declined',
      counts: { failed: 0, declinedWalletRequests: 1 },
    });
  });

  test('treats a user-cancelled download as a neutral terminal state without an artifact', () => {
    const cancelledArtifact = {
      artifactId: 'artifact_1234567890abcdef1234',
      filename: 'large.iso',
      bytes: 0,
      state: 'cancelled',
      location: 'downloads',
      available: false,
    };

    expect(
      createToolReceipt(OPERATIONS.DOWNLOAD, {
        envelope: { ok: true, result: { artifact: cancelledArtifact } },
      })
    ).toEqual({});
    expect(
      buildAgentOutcome(
        [
          {
            operation: OPERATIONS.DOWNLOAD,
            status: 'failed',
            effect: 'changed',
            errorCode: ERROR_CODES.DOWNLOAD_CANCELLED_BY_USER,
            artifact: cancelledArtifact,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'download_cancelled',
      tone: 'neutral',
      headline: 'Download cancelled',
      counts: { failed: 0, cancelledDownloads: 1 },
    });
  });

  test('treats a cancelled native file picker as a neutral terminal state', () => {
    expect(
      buildAgentOutcome(
        [
          {
            operation: OPERATIONS.UPLOAD,
            status: 'failed',
            effect: 'changed',
            errorCode: ERROR_CODES.FILE_UPLOAD_CANCELLED_BY_USER,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'file_selection_cancelled',
      tone: 'neutral',
      headline: 'File selection cancelled',
      counts: { failed: 0, cancelledUploads: 1 },
    });
  });

  test('distinguishes a rechecked result from an action-only completion', () => {
    const changed = {
      operation: OPERATIONS.CLICK,
      status: 'succeeded',
      effect: 'changed',
      pageId: 'tab_1',
    };
    expect(buildAgentOutcome([changed], 'completed')).toMatchObject({
      verification: 'actions_recorded',
      headline: 'Browser actions recorded',
      counts: { successful: 1, changed: 1, observed: 0, pages: 1 },
    });

    expect(
      buildAgentOutcome(
        [
          changed,
          {
            operation: OPERATIONS.SNAPSHOT,
            status: 'succeeded',
            effect: 'observed',
            pageId: 'tab_1',
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'result_observed',
      headline: 'Result checked in the browser',
      counts: { successful: 2, changed: 1, observed: 1, pages: 1 },
    });
  });

  test('does not require browser evidence for a conversational response', () => {
    expect(buildAgentOutcome([], 'completed')).toEqual({
      kind: 'completed',
      verification: 'not_applicable',
      tone: 'neutral',
      destinations: [],
      counts: {
        successful: 0,
        failed: 0,
        changed: 0,
        observed: 0,
        pages: 0,
        approvals: { requested: 0, approved: 0, declined: 0, withdrawn: 0 },
      },
    });
  });

  test('does not treat an observation on another page as result verification', () => {
    const outcome = buildAgentOutcome(
      [
        {
          operation: OPERATIONS.TYPE,
          status: 'succeeded',
          effect: 'changed',
          pageId: 'tab_1',
        },
        {
          operation: OPERATIONS.SNAPSHOT,
          status: 'succeeded',
          effect: 'observed',
          pageId: 'tab_2',
        },
      ],
      'completed'
    );

    expect(outcome.verification).toBe('actions_recorded');
  });

  test('gives conservative recovery guidance after partial browser changes', () => {
    const outcome = buildAgentOutcome(
      [
        {
          operation: OPERATIONS.TYPE,
          status: 'succeeded',
          effect: 'changed',
          pageId: 'tab_1',
        },
        {
          operation: OPERATIONS.CLICK,
          status: 'failed',
          effect: 'changed',
          pageId: 'tab_1',
          errorCode: ERROR_CODES.STALE_ELEMENT_REFERENCE,
        },
      ],
      'failed',
      { code: 'PROVIDER_ERROR' }
    );

    expect(outcome).toMatchObject({
      kind: 'recovery',
      retrySafety: 'review',
      counts: { successful: 1, failed: 1, changed: 1 },
    });
    expect(outcome.detail).toContain('model connection failed');
    expect(outcome.detail).toContain('earlier browser change remains');
    expect(outcome.nextStep).toContain('Review the Agent tabs');
  });

  test('marks a retry safe only when Freedom verified no browser changes', () => {
    const outcome = buildAgentOutcome([], 'failed', { code: 'PROVIDER_ERROR' });
    expect(outcome).toMatchObject({ retrySafety: 'safe' });
    expect(outcome.detail).toContain('did not verify any browser changes');
    expect(outcome.nextStep).toBe('You can safely try the task again.');
  });

  test('retains approval counts without persisting the approval payload', () => {
    const outcome = buildAgentOutcome(
      [
        {
          operation: OPERATIONS.CLICK,
          status: 'succeeded',
          effect: 'changed',
          pageId: 'tab_1',
          approval: 'approved',
          destinationOrigin: 'https://submit.example/private?token=secret',
        },
      ],
      'completed'
    );

    expect(outcome.counts.approvals).toEqual({
      requested: 1,
      approved: 1,
      declined: 0,
      withdrawn: 0,
    });
    expect(outcome.detail).toContain('approved by the user');
    expect(outcome.detail).toContain('Approved destination: https://submit.example');
    expect(outcome.destinations).toEqual(['https://submit.example']);
    expect(JSON.stringify(outcome)).not.toMatch(/token|secret|private|form|payload/);
  });

  test('requires review when an interrupted change has an uncertain outcome', () => {
    const outcome = buildAgentOutcome(
      [
        {
          operation: OPERATIONS.CLICK,
          status: 'running',
          effect: 'changed',
          pageId: 'tab_1',
        },
      ],
      'interrupted'
    );

    expect(outcome).toMatchObject({ retrySafety: 'review' });
    expect(outcome.detail).toContain('cannot confirm whether the interrupted browser action');
  });
});
