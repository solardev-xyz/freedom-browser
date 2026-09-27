'use strict';

const { DELEGATED_BROWSER_OPERATIONS, originScopeForUrl } = require('../automation/origin-scoped-controller');

const SUBAGENT_TOOL_NAME = 'delegate_task';
const MAX_SUBAGENT_BATCH_SIZE = 6;
const SUBAGENT_STATES = ['running', 'completed', 'cancelled', 'timed_out', 'limited', 'failed'];

function safePaths(values) {
  return Object.freeze(Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && value.length <= 1024 &&
    value && !value.includes('\\') && !/\p{Cc}/u.test(value) && !value.startsWith('/') &&
    !value.split('/').some(part => !part || part === '.' || part === '..')))].slice(0, 20) : []);
}

function normalizeSubagentReceipt(value) {
  if (!value || !/^delegate_[a-f0-9]{24}$/.test(value.taskId) ||
      !SUBAGENT_STATES.includes(value.state) || typeof value.title !== 'string') return null;
  const count = name => Number.isSafeInteger(value[name]) && value[name] >= 0 ? value[name] : 0;
  return Object.freeze({
    taskId: value.taskId,
    title: value.title.replace(/\p{Cc}/gu, ' ').trim().slice(0, 100),
    state: value.state,
    ...(value.state === 'running' && typeof value.activity === 'string' && { activity: value.activity.replace(/\p{Cc}/gu, ' ').slice(0, 160) }),
    toolCalls: count('toolCalls'),
    totalTokens: count('totalTokens'),
    durationMs: count('durationMs'),
    ...(value.mode === 'edit' && {
      mode: 'edit',
      changedFiles: safePaths(value.changedFiles), attemptedFiles: safePaths(value.attemptedFiles), writesPending: value.writesPending === true,
    }),
    ...(value.mode === 'browser' && {
      mode: 'browser',
      tabIds: Object.freeze(Array.isArray(value.tabIds) ? [...new Set(value.tabIds.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))].slice(0, 16) : []),
      browserPending: value.browserPending === true,
      browserActions: Object.freeze(Array.isArray(value.browserActions) ? value.browserActions
        .filter(action => action && DELEGATED_BROWSER_OPERATIONS.has(action.operation) && ['succeeded', 'failed'].includes(action.status))
        .slice(0, 48).map(action => Object.freeze({ operation: action.operation, status: action.status,
          ...(typeof action.pageId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(action.pageId) && { pageId: action.pageId }),
          ...(typeof action.errorCode === 'string' && /^[A-Z_]{1,80}$/.test(action.errorCode) && { errorCode: action.errorCode }),
          ...(typeof action.label === 'string' && { label: action.label.replace(/\p{Cc}/gu, ' ').slice(0, 160) }),
          origin: originScopeForUrl(action.origin) || '',
          pageTitle: typeof action.pageTitle === 'string' ? action.pageTitle.replace(/\p{Cc}/gu, ' ').slice(0, 160) : '',
        })) : []),
    }),
    // A report is model-generated evidence, never a verified task result.
    report: typeof value.report === 'string' ? value.report : '',
    ...(/^report_[a-f0-9]{64}$/.test(value.reportId || '') && { reportId: value.reportId, reportChars: count('reportChars') }),
    reportTruncated: value.reportTruncated === true,
  });
}

function normalizeSubagentReceipts(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_SUBAGENT_BATCH_SIZE) return null;
  const receipts = values.map(normalizeSubagentReceipt);
  if (receipts.some(value => !value) || new Set(receipts.map(value => value.taskId)).size !== receipts.length) return null;
  return Object.freeze(receipts);
}

function summarizeSubagents(receipts) {
  const count = state => receipts.filter(receipt => receipt?.state === state).length;
  const reports = count('completed');
  const stopped = count('cancelled');
  const running = count('running');
  const incomplete = receipts.length - reports - stopped - running;
  const parts = [];
  if (reports) parts.push(`${reports} ${reports === 1 ? 'report' : 'reports'} received`);
  if (stopped) parts.push(`${stopped} ${stopped === 1 ? 'task' : 'tasks'} stopped`);
  if (running) parts.push(`${running} ${running === 1 ? 'helper' : 'helpers'} working`);
  if (incomplete) parts.push(`${incomplete} ${incomplete === 1 ? 'task' : 'tasks'} incomplete`);
  return {
    headline: reports ? (reports === 1 ? 'Helper report received' : 'Helper reports received')
      : incomplete ? 'Delegated task incomplete' : 'Delegated tasks stopped',
    detail: parts.join(' · '),
    tone: incomplete ? 'caution' : 'neutral',
  };
}

module.exports = { MAX_SUBAGENT_BATCH_SIZE, SUBAGENT_TOOL_NAME, normalizeSubagentReceipt, normalizeSubagentReceipts, summarizeSubagents };
