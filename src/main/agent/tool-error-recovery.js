'use strict';

const { isTrustedBuiltInToolOverride, trustBuiltInToolOverride } = require('./pi-trusted-tools');

const wrappedTools = new WeakSet();
const decoratedErrors = new WeakSet();
const decoratedResults = new WeakSet();
const step = (action, instruction, extra = {}) => Object.freeze({ action, instruction, ...extra });

// Main-owned guidance only. Never interpret page content, error prose or a model's
// proposed fix as authority to grant permissions or replay a consequential action.
function recoveryForToolError(code, operation) {
  if (code === 'COMMAND_REVIEW_STALE') return step('request_permission',
    'Project evidence changed after approval. Call request_permissions for the exact command and workingDirectory again before retrying.', { tool: 'request_permissions' });
  if (code === 'WORKSPACE_AUDIT_FINDINGS') return step('inspect_outcome',
    'Read the advisory report. This audit completed with findings; do not repeat it merely because the exit status is nonzero. Apply only task-authorized compatible fixes and verify afterwards.');
  if (['POSTAGE_CAPACITY_INSUFFICIENT', 'POSTAGE_UNAVAILABLE'].includes(code)) return step('inspect_outcome',
    'Check existing stamps and pending purchases. Compare the reported upload requirement with effective capacity, not theoretical capacity or usable alone. Propose sufficient capacity and obtain approval before buying or changing a batch; never repeat a completed purchase.');
  if (/DECLINED|CANCELLED|ABORT_ERR/.test(code)) return step('stop',
    'Stop this action. Do not retry, request the same permission again, or use a workaround unless the user gives a new instruction. Earlier effects may remain.');
  if (code === 'PROJECT_READ_ONLY') return step('request_permission',
    'For read-only inspection, use read, ls, find, grep or workspace_history (status/diff/review); do not request editing just to inspect changes. If the task requires edits, commits or shell execution, call request_permissions with project: "write" and a concise reason for the intended change. Omit command, workingDirectory, executables and network. If approved, re-read affected files and obtain fresh Git review tokens before retrying. If declined, stop.',
    { tool: 'request_permissions', arguments: { project: 'write' } });
  if (['PROJECT_RECONNECT_REQUIRED', 'PROJECT_CHANGED'].includes(code)) return step('ask_user',
    'Ask the user to reconnect the original project from the project menu. After reconnection, read current state again. Reconnection starts read-only. Do not guess a replacement path.');
  if (code === 'PROJECT_UNAVAILABLE') return step('ask_user',
    'Ask the user to attach the intended folder using Open project. Do not create a replacement project or guess a host path.');
  if (code === 'PROJECT_IN_USE') return step('ask_user',
    'Ask the user to remove editing access from the overlapping conversation before requesting access here. Do not grant access to another copy as a workaround.');
  if (code === 'PROJECT_ACCESS_INVALID') return step('inspect_state',
    'Check the current project association. A changed or expired permission request needs a fresh request for the same user-authorized task; never reuse an old approval.');
  if (code === 'WORKSPACE_COMMAND_NOT_FOUND') return step('request_permission',
    'Call request_permissions with the exact executable names, intended command and workingDirectory before retrying. Exit 127 does not prove software is absent. Do not substitute an installer or download method.', { tool: 'request_permissions' });
  if (code === 'WORKSPACE_PREVIEW_NETWORK_REQUIRED') return step('request_permission',
    'Request network: "full" through request_permissions for the exact server launch command and workingDirectory. Only launch after approval; then preview its returned processId.', { tool: 'request_permissions' });
  if (code === 'WORKSPACE_DIFF_UNAVAILABLE') return step('inspect_state',
    'Read accessible current files and explain that an exact bounded diff is unavailable, or ask the user to inspect it in their Git client. Editing access does not fix this limitation; do not bypass the diff limits with shell Git.', { tool: 'read' });
  if (code === 'WORKSPACE_HISTORY_CHANGED') return step('refresh_state',
    'Read the file again, reassess the intended change against its current contents, then retry only if still appropriate.', { tool: 'read' });
  if (code === 'WORKSPACE_HISTORY_UNAVAILABLE') return step('inspect_outcome',
    'Follow the specific Git limitation or recovery instructions in the error. Inspect workspace_history status before retrying. An attempted commit may already exist. Do not repeat it blindly, remove locks, bypass protections with shell Git, or alter hooks/signing/configuration. Ask the user to resolve unsupported or uncertain repository state in their Git client.',
    { tool: 'workspace_history', arguments: { action: 'status' } });
  if (operation === 'browser_call_page_tool' && !['INVALID_ARGUMENT', 'POLICY_DENIED', 'APPROVAL_REQUIRED'].includes(code)) return step('inspect_outcome',
    'Use browser_list_page_tools and inspect the page for the previous result and fresh tool references. The website tool may have had effects despite failure. Do not automatically invoke it again.', { tool: 'browser_list_page_tools' });
  if (['STALE_ELEMENT_REFERENCE', 'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_INTERACTABLE'].includes(code)) return step('refresh_state',
    'Take a fresh browser_snapshot and select current references. For an embedded document, refresh browser_list_frames then browser_read_frame. Reassess the intended action and do not repeat a possibly completed submission.', { tool: 'browser_snapshot' });
  if (code === 'TAB_NOT_FOUND') return step('refresh_state',
    'Call browser_list_tabs and choose a current task-owned tab. Create a new task tab only if the user task requires one; do not reuse a stale tab ID.', { tool: 'browser_list_tabs' });
  if (['NAVIGATION_FAILED', 'WAIT_TIMEOUT'].includes(code)) return step('inspect_outcome',
    'Read browser_get_tab and a fresh browser_snapshot to determine what loaded or changed. Correct the URL or wait condition if needed; do not repeat a potentially completed action.', { tool: 'browser_get_tab' });
  if (code === 'APPROVAL_REQUIRED') return step('ask_user',
    'The action still requires user approval. Use the supported tool approval flow or ask the user to complete it. Do not bypass or assume approval.');
  if (['UNTRUSTED_CAPABILITY_AUTHORITY', 'EXECUTABLE_SCOPE_TOO_BROAD'].includes(code)) return step('stop',
    'Explain the refused authority or executable scope and stop. Do not broaden the request or select another execution path to bypass this boundary.');
  if (['WORKSPACE_HISTORY_BUSY', 'WORKSPACE_PROCESS_LIMIT_REACHED'].includes(code)) return step('inspect_state',
    'Wait for the active operation to finish or inspect the known process sessions with write_stdin. Do not start duplicate operations or terminate unrelated work.');
  if (['WORKSPACE_PROCESS_NOT_FOUND', 'WORKSPACE_PROCESS_INPUT_UNAVAILABLE'].includes(code)) return step('inspect_outcome',
    'Inspect the previous process result and current project state. The session may have finished or expired; do not reuse its ID or restart a possibly completed command blindly.');
  if (code === 'POLICY_DENIED' || /PROTECTED|UNSAFE|PATH_DENIED|SANDBOX_DENIED|POLICY_FAILED/.test(code)) return step('stop',
    'Explain the enforced boundary and stop this action. Do not bypass it using another tool, path, command or permission request. Offer a supported alternative only if it preserves the same boundary.');
  if (/INVALID.*(?:ARGUMENT|REQUEST|GRANT)|PDF_PAGE_OUT_OF_RANGE/.test(code)) return step('correct_input',
    'Read this tool’s parameter schema and the validation error. Correct the supplied arguments using observed state, then retry only the corrected authorized operation. Do not invent IDs or paths.');
  if (/UNSUPPORTED|PLATFORM_UNAVAILABLE|CAPABILITY_UNAVAILABLE|RUNTIME_UNAVAILABLE|NETWORK_PERMISSION_UNAVAILABLE|PDF_PASSWORD_REQUIRED/.test(code)) return step('unsupported',
    'Explain the unavailable capability. Use a supported alternative only if it preserves user intent and permissions; otherwise ask the user to perform this step. Retry only after the indicated capability or setup has changed.');
  if (code === 'ENOENT' && operation.startsWith('attachment_')) return step('refresh_state',
    'Use attachment_list to check current resource IDs and paths. If the source is no longer available, ask the user to attach it again.', { tool: 'attachment_list' });
  if (operation.startsWith('attachment_')) return step('inspect_state',
    'Use attachment_list to verify the source, then correct the path, page or bounded range indicated by the error. For unreadable, encrypted or malformed sources, ask for an accessible supported copy; do not keep repeating the same read.', { tool: 'attachment_list' });
  if (['WORKSPACE_PATH_NOT_FOUND', 'WORKSPACE_DIRECTORY_UNAVAILABLE', 'WORKSPACE_PATH_TYPE_MISMATCH'].includes(code)) return step('refresh_state',
    'List the relevant project directory with ls or locate the file with find. Use the observed project-relative path and correct file/directory type; do not guess host paths.', { tool: 'ls' });
  if (/TOO_LARGE|LIMIT/.test(code)) return step('correct_input',
    'Reduce the requested range, file set or output size within the tool’s documented limits. If the operation cannot fit, explain the limitation; do not bypass limits with another execution path.');
  if (/WORKSPACE_COMMAND|WORKSPACE_EXECUTION|WORKSPACE_WRITE|WORKSPACE_FILE/.test(code)) return step('inspect_outcome',
    'Inspect current project files and any returned command output before deciding what to change. A failure does not roll back earlier effects. Correct the demonstrated cause or ask the user for help; do not repeat unchanged commands or assume files are unchanged.');
  return step('inspect_outcome',
    'The cause is not established. Inspect current state with the relevant read-only tools before deciding whether a corrected retry is safe. Do not assume failure means no effects. If the cause remains unclear, explain it and ask the user how to proceed; do not loop or invent a workaround.');
}

// Call only for adapter-owned failure states, never infer a code from page prose
// or shell output. Preserve the result/evidence while adding main-owned guidance.
function withToolResultRecovery(result, code, operation) {
  if (decoratedResults.has(result)) return result;
  const recovery = recoveryForToolError(code, operation);
  const wrapped = { ...result, isError: true, content: [...(result.content || []), {
    type: 'text', text: `Freedom tool failure [${code}]\nRecovery: ${JSON.stringify(recovery)}`,
  }] };
  decoratedResults.add(wrapped);
  return wrapped;
}

function isRecoveredToolResult(result) {
  return decoratedResults.has(result);
}

function withToolErrorRecovery(tool) {
  if (wrappedTools.has(tool)) return tool;
  const wrapped = { ...tool, execute: async function (...args) {
    try {
      const result = await tool.execute.apply(tool, args);
      return result?.isError === true ? withToolResultRecovery(result, args[2]?.aborted ? 'ABORT_ERR' : 'TOOL_OPERATION_FAILED', tool.name) : result;
    }
    catch (failure) {
      const error = failure instanceof Error ? failure : new Error('The tool failed without a usable error report.');
      if (!decoratedErrors.has(error)) {
        const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : args[2]?.aborted ? 'ABORT_ERR' : 'TOOL_OPERATION_FAILED';
        error.code = code;
        error.recovery = recoveryForToolError(code, tool.name);
        if (!error.message.startsWith(`[${code}]`)) error.message = `[${code}] ${error.message}`;
        if (error.recovery.action !== 'stop' && typeof error.suggestedAction === 'string' && error.suggestedAction) {
          error.message += `\nTool guidance: ${error.suggestedAction.slice(0, 600)}`;
        }
        // Pi serializes thrown errors as text. Include the typed recovery there,
        // as well as on the Error object, so every model receives the next step.
        error.message += `\nRecovery: ${JSON.stringify(error.recovery)}`;
        decoratedErrors.add(error);
      }
      throw error;
    }
  } };
  wrappedTools.add(wrapped);
  if (isTrustedBuiltInToolOverride(tool)) trustBuiltInToolOverride(wrapped);
  return wrapped;
}

module.exports = { recoveryForToolError, withToolErrorRecovery, withToolResultRecovery, isRecoveredToolResult };
