'use strict';

const { OPERATIONS } = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');
const {
  activityProgress,
  buildAgentOutcome,
  createToolReceipt,
} = require('./agent-progress');

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

    expect(receipt).toEqual({ artifact: expect.not.objectContaining({ savePath: expect.anything() }) });
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
