'use strict';

const SUBAGENT_TOOL_NAME = 'delegate_task';
const SUBAGENT_STATES = ['completed', 'cancelled', 'timed_out', 'limited', 'failed'];

function normalizeSubagentReceipt(value) {
  if (!value || !/^delegate_[a-f0-9]{24}$/.test(value.taskId) ||
      !SUBAGENT_STATES.includes(value.state) || typeof value.title !== 'string') return null;
  const count = name => Number.isSafeInteger(value[name]) && value[name] >= 0 ? value[name] : 0;
  return Object.freeze({
    taskId: value.taskId,
    title: value.title.replace(/\p{Cc}/gu, ' ').trim().slice(0, 100),
    state: value.state,
    toolCalls: count('toolCalls'),
    totalTokens: count('totalTokens'),
    durationMs: count('durationMs'),
    // A report is model-generated evidence, never a verified task result.
    report: typeof value.report === 'string' ? value.report.slice(0, 12000) : '',
    reportTruncated: value.reportTruncated === true || (typeof value.report === 'string' && value.report.length > 12000),
  });
}

module.exports = { SUBAGENT_TOOL_NAME, normalizeSubagentReceipt };
