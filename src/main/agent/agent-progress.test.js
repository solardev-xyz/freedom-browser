'use strict';

const { OPERATIONS } = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');
const {
  ATTACHMENT_OPERATIONS,
  WORKSPACE_OPERATIONS,
  activityProgress,
  buildAgentOutcome,
  createToolReceipt,
  normalizeAttachmentReceipt,
  normalizePublicationReceipt,
  normalizeWorkspaceReceipt,
} = require('./agent-progress');

describe('Agent progress projection', () => {
  test.each(['cancelled', 'interrupted'])('describes a %s dependency setup as project work', (status) => {
    const workspace = {
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa', kind: 'command',
      command: 'npm install', workingDirectory: '.', backend: 'macos-seatbelt',
      state: 'failed', exitCode: 1, sideEffects: 'unknown',
      terminationGuarantee: 'best_effort',
    };
    const permission = { ...workspace, command: 'Use corepack, node', state: 'cancelled',
      exitCode: null, sideEffects: 'none' };
    const items = [
      { operation: 'write', status: 'succeeded', effect: 'changed',
        workspace: { ...workspace, kind: 'file_write', command: 'Write package.json', state: 'completed' } },
      { operation: 'bash', status: 'failed', effect: 'changed', workspace,
        errorCode: 'WORKSPACE_COMMAND_FAILED' },
      { operation: 'request_permissions', status: 'failed', approval: 'declined',
        workspace: permission, errorCode: 'WORKSPACE_OPERATION_CANCELLED' },
    ];
    const outcome = buildAgentOutcome(items, status);
    expect(outcome.detail).toContain('3 project operations were recorded');
    expect(outcome.detail).toContain('not rolled back');
    expect(outcome.detail).toContain('Shell-command side effects inside the workspace remain unknown');
    expect(outcome.detail).not.toContain('browser');
    expect(activityProgress('request_permissions', { workspace: permission })).toMatchObject({
      label: 'Project permission request stopped', intent: 'Requesting project permissions', effect: 'managed',
    });
    const mixed = buildAgentOutcome([...items, { operation: OPERATIONS.CLICK,
      status: 'running', effect: 'changed', pageId: 'tab_1' }], status);
    expect(mixed.detail).toContain('interrupted browser action');
    expect(mixed.detail).toContain('project operations');
  });

  test('a permission check alone does not imply a shell command ran', () => {
    const workspace = { kind: 'command', command: 'Use npm', workingDirectory: '.',
      backend: 'freedom-workspace-files', state: 'completed', sideEffects: 'none',
      terminationGuarantee: 'not_applicable' };
    expect(activityProgress('request_permissions', { workspace }).label).toBe('Checked project permissions');
    expect(activityProgress('request_permissions', { workspace: { ...workspace, state: 'running' } }).label).not.toContain('failed');
    const outcome = buildAgentOutcome([{ operation: 'request_permissions', status: 'succeeded', workspace }], 'completed');
    expect(outcome.detail).not.toContain('Shell-command side effects');
  });

  test('projects bounded workspace activity without command output or host paths', () => {
    const workspace = normalizeWorkspaceReceipt({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
      kind: 'command',
      command: 'npm test\n--runInBand',
      workingDirectory: '.',
      backend: 'linux-bubblewrap',
      networkPosture: 'full',
      state: 'completed',
      durationMs: 120,
      exitCode: 0,
      stdout: 'private output from /Users/private',
      stderr: 'private diagnostics',
      terminationGuarantee: 'namespace_scoped',
      terminationScope: 'pid_namespace',
      sideEffects: 'unknown',
      completeDescendantTermination: true,
    });

    expect(workspace).toEqual({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
      kind: 'command',
      command: 'npm test --runInBand',
      workingDirectory: '.',
      backend: 'linux-bubblewrap',
      networkPosture: 'full',
      state: 'completed',
      durationMs: 120,
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      terminationGuarantee: 'namespace_scoped',
      terminationScope: 'pid_namespace',
      sideEffects: 'unknown',
      survivorsPossible: false,
      completeDescendantTermination: true,
    });
    expect(JSON.stringify(workspace)).not.toMatch(/private output|private diagnostics|\/Users/);
    expect(activityProgress(WORKSPACE_OPERATIONS.BASH, { workspace })).toMatchObject({
      intent: 'Running npm test --runInBand',
      label: 'Ran npm test --runInBand',
      effect: 'changed',
    });
    expect(
      buildAgentOutcome(
        [{ operation: WORKSPACE_OPERATIONS.BASH, status: 'succeeded', workspace }],
        'completed'
      )
    ).toMatchObject({
      verification: 'workspace_execution_recorded',
      headline: 'Project command completed',
      counts: { workspaceCommands: 1 },
    });
  });

  test('treats workspace discovery as read-only project evidence', () => {
    const workspace = normalizeWorkspaceReceipt({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      kind: 'file_search',
      command: 'Search for TODO in src',
      workingDirectory: '.',
      backend: 'freedom-workspace-files',
      state: 'completed',
      terminationGuarantee: 'not_applicable',
      sideEffects: 'none',
      completeDescendantTermination: true,
    });

    expect(activityProgress(WORKSPACE_OPERATIONS.GREP, { workspace })).toMatchObject({
      intent: 'Searching for TODO in src',
      label: 'Searched for TODO in src',
      effect: 'observed',
    });
    expect(
      buildAgentOutcome(
        [{ operation: WORKSPACE_OPERATIONS.GREP, status: 'succeeded', workspace }],
        'completed'
      )
    ).toMatchObject({
      verification: 'workspace_execution_recorded',
      headline: 'Project files inspected',
      counts: { workspaceCommands: 1 },
    });
  });

  test('presents managed process state without duplicating action verbs', () => {
    const process = normalizeWorkspaceReceipt({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
      processId: 'workspace_process_cccccccccccccccccccccccc',
      kind: 'process',
      command: 'Stop workspace_process_cccccccccccccccccccccccc',
      workingDirectory: '.',
      backend: 'linux-bubblewrap',
      state: 'cancelled',
      signal: 'SIGKILL',
      terminationGuarantee: 'namespace_scoped',
      terminationScope: 'pid_namespace',
      sideEffects: 'unknown',
      completeDescendantTermination: true,
    });

    expect(activityProgress(WORKSPACE_OPERATIONS.PROCESS, { workspace: process })).toMatchObject({
      intent: 'Stop workspace_process_cccccccccccccccccccccccc',
      label: 'Process stopped — workspace_process_cccccccccccccccccccccccc',
      effect: 'managed',
    });
  });

  test('reports empty workspace discovery without claiming that it found results', () => {
    const find = normalizeWorkspaceReceipt({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      kind: 'file_find',
      command: 'Find **/*swarm* in .',
      workingDirectory: '.',
      backend: 'freedom-workspace-files',
      state: 'completed',
      resultCount: 0,
      terminationGuarantee: 'not_applicable',
      sideEffects: 'none',
      completeDescendantTermination: true,
    });
    const grep = normalizeWorkspaceReceipt({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      kind: 'file_search',
      command: 'Search for TODO in .',
      workingDirectory: '.',
      backend: 'freedom-workspace-files',
      state: 'completed',
      matchCount: 0,
      terminationGuarantee: 'not_applicable',
      sideEffects: 'none',
      completeDescendantTermination: true,
    });

    expect(activityProgress(WORKSPACE_OPERATIONS.FIND, { workspace: find }).label).toBe(
      'No files matched **/*swarm* in .'
    );
    expect(activityProgress(WORKSPACE_OPERATIONS.GREP, { workspace: grep }).label).toBe(
      'No matches for TODO in .'
    );
  });

  test('presents static preview activity without exposing its opaque origin', () => {
    const workspace = normalizeWorkspaceReceipt({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      kind: 'static_preview',
      command: 'Preview site',
      workingDirectory: '.',
      backend: 'freedom-workspace-files',
      state: 'completed',
      terminationGuarantee: 'not_applicable',
      sideEffects: 'unknown',
      completeDescendantTermination: true,
    });

    expect(activityProgress(WORKSPACE_OPERATIONS.PREVIEW, { workspace })).toMatchObject({
      intent: 'Opening site',
      label: 'Opened preview for site',
      effect: 'managed',
    });
    expect(
      activityProgress(OPERATIONS.SNAPSHOT, {
        origin: `freedom-preview://${'a'.repeat(40)}`,
      })
    ).toMatchObject({
      intent: 'Reading workspace preview',
      label: 'Read workspace preview',
      origin: 'workspace preview',
    });
    expect(
      buildAgentOutcome(
        [{ operation: WORKSPACE_OPERATIONS.PREVIEW, status: 'succeeded', workspace }],
        'completed'
      )
    ).toMatchObject({
      verification: 'workspace_preview_opened',
      headline: 'Static preview opened',
    });
  });

  test('presents a managed server preview without exposing its opaque origin', () => {
    const workspace = normalizeWorkspaceReceipt({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      processId: 'workspace_process_cccccccccccccccccccccccc',
      kind: 'server_preview',
      command: 'Preview server on port 4173',
      workingDirectory: '.',
      backend: 'freedom-workspace-server-preview',
      networkPosture: 'full',
      previewPort: 4_173,
      state: 'completed',
      terminationGuarantee: 'not_applicable',
      sideEffects: 'unknown',
      completeDescendantTermination: true,
    });

    expect(workspace).toMatchObject({
      kind: 'server_preview',
      processId: 'workspace_process_cccccccccccccccccccccccc',
      networkPosture: 'full',
      previewPort: 4_173,
    });
    expect(
      buildAgentOutcome(
        [{ operation: WORKSPACE_OPERATIONS.PREVIEW, status: 'succeeded', workspace }],
        'completed'
      )
    ).toMatchObject({
      verification: 'workspace_preview_opened',
      headline: 'Server preview opened',
      detail: expect.stringContaining('approved localhost port'),
    });
  });

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

  test('projects screenshot observation without retaining image pixels', () => {
    const pixels = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const receipt = createToolReceipt(OPERATIONS.SCREENSHOT, {
      envelope: {
        ok: true,
        tabId: 'tab_visual',
        result: { mediaType: 'image/png', bytes: 1234, base64: pixels },
      },
      origin: 'https://visual.example/private',
    });

    expect(receipt).toEqual({
      pageId: 'tab_visual',
      origin: 'https://visual.example',
    });
    expect(JSON.stringify(receipt)).not.toContain(pixels);
    expect(activityProgress(OPERATIONS.SCREENSHOT, receipt)).toMatchObject({
      intent: 'Looking at https://visual.example',
      label: 'Looked at https://visual.example',
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

  test('reports a slow unsafe node request as running without implying failure', () => {
    const nodeRequest = {
      operationId: 'node_op_aaaaaaaaaaaaaaaaaaaaaaaa',
      state: 'in_flight',
      retrySafety: 'unsafe',
      service: 'ant',
      method: 'POST',
      path: '/stamps/100/20',
      effect: 'financial',
    };
    const receipt = createToolReceipt(OPERATIONS.NODE_REQUEST, {
      envelope: { ok: true, result: { summary: nodeRequest } },
    });

    expect(receipt).toEqual({ nodeRequest });
    expect(activityProgress(OPERATIONS.NODE_REQUEST, receipt)).toMatchObject({
      label: 'Requested POST /stamps/100/20 — still running',
      effect: 'changed',
    });
    expect(
      buildAgentOutcome(
        [
          {
            operation: OPERATIONS.NODE_REQUEST,
            status: 'succeeded',
            effect: 'changed',
            nodeRequest,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'node_request_in_flight',
      tone: 'caution',
      headline: 'Node request still running',
      nodeRequest,
    });
  });

  test('reports lost observability as uncertain and warns against a blind retry', () => {
    const nodeRequest = {
      operationId: 'node_op_bbbbbbbbbbbbbbbbbbbbbbbb',
      state: 'delivery_uncertain',
      retrySafety: 'unsafe',
      service: 'ant',
      method: 'POST',
      path: '/stamps/100/20',
      effect: 'financial',
    };

    const outcome = buildAgentOutcome(
      [
        {
          operation: OPERATIONS.NODE_OPERATION_STATUS,
          status: 'succeeded',
          effect: 'changed',
          nodeRequest,
        },
      ],
      'completed'
    );

    expect(outcome).toMatchObject({
      verification: 'node_delivery_uncertain',
      tone: 'caution',
      headline: 'Node outcome uncertain',
      nodeRequest,
    });
    expect(outcome.detail).toContain('do not retry it without reconciliation');
  });

  test('projects and reports only verified node lifecycle state', () => {
    const receipt = createToolReceipt(OPERATIONS.NODE_LIFECYCLE, {
      envelope: {
        ok: true,
        result: {
          service: 'ipfs',
          action: 'restart',
          beforeState: 'running',
          afterState: 'running',
          verified: true,
          summary: {
            service: 'ipfs',
            action: 'restart',
            beforeState: 'running',
            afterState: 'running',
            verified: true,
          },
        },
      },
    });

    expect(receipt).toEqual({
      nodeLifecycle: {
        service: 'ipfs',
        action: 'restart',
        beforeState: 'running',
        afterState: 'running',
        verified: true,
      },
    });
    expect(activityProgress(OPERATIONS.NODE_LIFECYCLE, receipt)).toMatchObject({
      intent: 'Restarting ipfs',
      label: 'Restarted ipfs — running',
      effect: 'changed',
    });
    expect(
      buildAgentOutcome(
        [
          {
            operation: OPERATIONS.NODE_LIFECYCLE,
            status: 'succeeded',
            effect: 'changed',
            nodeLifecycle: receipt.nodeLifecycle,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'node_lifecycle_verified',
      headline: 'Node state verified',
      nodeLifecycle: receipt.nodeLifecycle,
      counts: { nodeLifecycles: 1, pages: 0 },
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
    expect(outcome.detail).toContain('could not complete the request');
    expect(outcome.technicalDetails).toContain('did not provide a usable failure reason');
    expect(outcome.detail).toContain('earlier browser change remains');
    expect(outcome.nextStep).toContain('Review the Agent tabs');
    expect(outcome.nextStep).toContain('Try continuing once');
  });

  test('marks a retry safe only when Freedom verified no browser changes', () => {
    const outcome = buildAgentOutcome([], 'failed', { code: 'PROVIDER_ERROR' });
    expect(outcome).toMatchObject({ retrySafety: 'safe' });
    expect(outcome.detail).toContain('did not verify any browser changes');
    expect(outcome.nextStep).toContain('Try continuing once');
  });

  test('reconstructs provider recovery evidence from persisted safe error copy', () => {
    const outcome = buildAgentOutcome([], 'failed', {
      code: 'PROVIDER_ERROR',
      message: 'The model provider remained unavailable. Freedom exhausted 2 automatic retries.',
    });

    expect(outcome.detail).toContain('remained unavailable after 3 attempts');
    expect(outcome.technicalDetails).toContain('was temporarily unavailable');
    expect(outcome.technicalDetails).toContain('3 attempts total');
    expect(outcome.technicalDetails).toContain('2 automatic retries');
    expect(outcome.canRetry).toBe(true);
    expect(outcome.nextStep).toContain('Wait a moment');
  });

  test('preserves an in-flight node operation across a provider disconnect', () => {
    const nodeRequest = {
      operationId: 'node_op_cccccccccccccccccccccccc',
      state: 'in_flight',
      retrySafety: 'unsafe',
      service: 'ant',
      method: 'POST',
      path: '/stamps/100/20',
      effect: 'financial',
    };
    const outcome = buildAgentOutcome(
      [
        {
          operation: OPERATIONS.NODE_REQUEST,
          status: 'succeeded',
          effect: 'changed',
          nodeRequest,
        },
      ],
      'failed',
      {
        code: 'PROVIDER_ERROR',
        message: 'The model provider remained unavailable.',
        providerFailure: { category: 'service_unavailable', recovery: 'transient' },
        retryCount: 2,
      }
    );

    expect(outcome).toMatchObject({
      verification: 'node_operation_unresolved',
      tone: 'caution',
      headline: 'Model disconnected; node request still running',
      retrySafety: 'review',
      nodeRequest,
    });
    expect(outcome.detail).toContain('after 3 attempts');
    expect(outcome.technicalDetails).toContain('3 attempts total');
    expect(outcome.technicalDetails).toContain('2 automatic retries');
    expect(outcome.detail).toContain(nodeRequest.operationId);
    expect(outcome.detail).not.toContain('browser change');
    expect(outcome.nextStep).toContain('check the existing node operation');
  });

  test('keeps a specific safe provider reason beside partial browser-state recovery', () => {
    const outcome = buildAgentOutcome(
      [
        {
          operation: OPERATIONS.TYPE,
          status: 'succeeded',
          effect: 'changed',
          pageId: 'tab_1',
        },
      ],
      'failed',
      {
        code: 'PROVIDER_ERROR',
        providerFailure: {
          category: 'connection',
          recovery: 'transient',
          cause: 'response_stream_closed',
          phase: 'streaming',
        },
        providerAttempts: {
          total: 3,
          automaticRetries: 2,
          observedFailures: 3,
          sameReason: true,
        },
        provider: { label: 'ChatGPT (Codex)', modelId: 'gpt-5.6-sol' },
        retryCount: 2,
      }
    );

    expect(outcome.technicalDetails).toContain(
      'ChatGPT (Codex) using gpt-5.6-sol closed the response stream before the model finished'
    );
    expect(outcome.technicalDetails).toContain('Every attempt failed for the same reason');
    expect(outcome.detail).toContain('1 earlier browser change remains');
    expect(outcome.nextStep).toContain('Review the Agent tabs');
    expect(outcome.nextStep).toContain('Check the connection');
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

  test('treats bounded attachment reads as source evidence rather than browser activity', () => {
    const firstChunk = normalizeAttachmentReceipt(
      {
        resourceId: `folder_${'a'.repeat(20)}`,
        resourceKind: 'folder',
        folderName: 'Bug reports',
        name: 'ant-report.json',
        relativePath: 'results/ant-report.json',
        bytesRead: 262_144,
        offset: 0,
        truncated: true,
        sourcePath: '/Users/private/Bug reports/results/ant-report.json',
      },
      ATTACHMENT_OPERATIONS.READ
    );
    const finalChunk = normalizeAttachmentReceipt(
      { ...firstChunk, bytesRead: 50, offset: 262_144, truncated: false },
      ATTACHMENT_OPERATIONS.READ
    );

    expect(firstChunk).toEqual({
      action: 'read',
      resourceId: `folder_${'a'.repeat(20)}`,
      resourceKind: 'folder',
      name: 'ant-report.json',
      folderName: 'Bug reports',
      relativePath: 'results/ant-report.json',
      bytesRead: 262_144,
      offset: 0,
      truncated: true,
    });
    expect(JSON.stringify(firstChunk)).not.toContain('/Users/private');
    expect(activityProgress(ATTACHMENT_OPERATIONS.READ, { attachment: firstChunk })).toMatchObject({
      intent: 'Reading results/ant-report.json',
      label: 'Read results/ant-report.json',
      effect: 'observed',
    });

    const outcome = buildAgentOutcome(
      [firstChunk, finalChunk].map((attachment, index) => ({
        toolCallId: `call_${index}`,
        operation: ATTACHMENT_OPERATIONS.READ,
        status: 'succeeded',
        effect: 'observed',
        attachment,
      })),
      'completed'
    );
    expect(outcome).toMatchObject({
      verification: 'attachments_inspected',
      headline: 'Attached sources inspected',
      counts: { successful: 2, attachmentReads: 1, attachmentObservations: 2 },
    });
    expect(outcome.detail).toContain('1 attached file in the shared folder “Bug reports”');
    expect(outcome.detail).not.toContain('browser evidence');
  });

  test('drops absolute paths from attachment receipts', () => {
    expect(
      normalizeAttachmentReceipt(
        {
          resourceId: `folder_${'b'.repeat(20)}`,
          resourceKind: 'folder',
          folderName: '/Users/private',
          name: '/Users/private/secret.txt',
          relativePath: '/Users/private/secret.txt',
          bytesRead: 12,
          offset: 0,
        },
        ATTACHMENT_OPERATIONS.READ
      )
    ).toBeNull();
  });

  test('projects PDF page reads and renders without retaining text or pixels', () => {
    const attachment = normalizeAttachmentReceipt(
      {
        resourceId: `attachment_${'c'.repeat(20)}`,
        resourceKind: 'file',
        name: 'report.pdf',
        bytesRead: 10_000,
        page: 7,
        pagesRead: 1,
        pageCount: 20,
        width: 900,
        height: 1200,
        pixels: 'private-image-data',
        text: 'private extracted text',
      },
      ATTACHMENT_OPERATIONS.RENDER_PAGE
    );
    expect(attachment).toEqual({
      action: 'read',
      resourceId: `attachment_${'c'.repeat(20)}`,
      resourceKind: 'file',
      name: 'report.pdf',
      bytesRead: 10_000,
      page: 7,
      pagesRead: 1,
      pageCount: 20,
      truncated: false,
    });
    expect(JSON.stringify(attachment)).not.toMatch(/private-image|private extracted/);
    expect(activityProgress(ATTACHMENT_OPERATIONS.RENDER_PAGE, { attachment })).toMatchObject({
      intent: 'Looking at report.pdf — page 7 of 20',
      label: 'Looked at report.pdf — page 7 of 20',
      effect: 'observed',
    });
    expect(
      buildAgentOutcome(
        [
          {
            toolCallId: 'pdf_page',
            operation: ATTACHMENT_OPERATIONS.RENDER_PAGE,
            status: 'succeeded',
            effect: 'observed',
            attachment,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'attachments_inspected',
      counts: { attachmentReads: 1, attachmentObservations: 1 },
    });
  });

  test('projects verified Swarm publications without local paths and recovers in-flight work', () => {
    const publication = normalizePublicationReceipt({
      publicationId: `swarm_pub_${'a'.repeat(24)}`,
      state: 'completed',
      applicationState: 'applied',
      kind: 'folder',
      name: 'My site',
      public: true,
      progress: 100,
      reference: 'b'.repeat(64),
      bzzUrl: `bzz://${'b'.repeat(64)}`,
      verified: true,
      sourcePath: '/Users/private/My site',
    });
    expect(publication).toEqual({
      publicationId: `swarm_pub_${'a'.repeat(24)}`,
      state: 'completed',
      applicationState: 'applied',
      kind: 'folder',
      name: 'My site',
      public: true,
      progress: 100,
      reference: 'b'.repeat(64),
      bzzUrl: `bzz://${'b'.repeat(64)}`,
      verified: true,
    });
    expect(JSON.stringify(publication)).not.toContain('/Users/private');
    expect(activityProgress(OPERATIONS.SWARM_PUBLISH, { publication })).toMatchObject({
      label: 'Published My site to Swarm',
      effect: 'changed',
    });
    expect(
      buildAgentOutcome(
        [
          {
            operation: OPERATIONS.SWARM_PUBLISH,
            status: 'succeeded',
            effect: 'changed',
            publication,
          },
        ],
        'completed'
      )
    ).toMatchObject({
      verification: 'swarm_publication_verified',
      headline: 'Published and verified on Swarm',
      publication,
    });

    const inFlight = {
      ...publication,
      state: 'uploading',
      applicationState: 'possibly_applied',
      progress: 30,
      verified: undefined,
      reference: undefined,
      bzzUrl: undefined,
    };
    const recovery = buildAgentOutcome(
      [
        {
          operation: OPERATIONS.SWARM_PUBLISH,
          status: 'succeeded',
          effect: 'changed',
          publication: inFlight,
        },
      ],
      'failed',
      {
        code: 'PROVIDER_ERROR',
        providerFailure: { category: 'connection', recovery: 'transient' },
        retryCount: 2,
      }
    );
    expect(recovery).toMatchObject({
      verification: 'swarm_publication_unresolved',
      retrySafety: 'review',
      publication: expect.objectContaining({ state: 'uploading' }),
    });
  });

  test('describes inline Swarm data as text rather than as a file', () => {
    const publication = normalizePublicationReceipt({
      publicationId: `swarm_pub_${'c'.repeat(24)}`,
      state: 'completed',
      applicationState: 'applied',
      kind: 'text',
      name: 'Text',
      public: true,
      reference: 'd'.repeat(64),
      bzzUrl: `bzz://${'d'.repeat(64)}`,
      verified: true,
    });

    expect(activityProgress(OPERATIONS.SWARM_PUBLISH, { publication })).toMatchObject({
      intent: 'Checking text',
      label: 'Published text to Swarm',
    });
    const outcome = buildAgentOutcome(
      [{ operation: OPERATIONS.SWARM_PUBLISH, status: 'succeeded', publication }],
      'completed'
    );
    expect(outcome.detail).toContain('Freedom published the text');
    expect(outcome.detail).not.toContain('“Text”');
    expect(outcome.detail).not.toContain('.txt');
  });
});
