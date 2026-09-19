'use strict';

const crypto = require('crypto');
const { AutomationError, ERROR_CODES } = require('../contract/errors');
const {
  supportedPageToolSchema,
  matchesPageToolArguments,
} = require('../contract/page-tool-schema');

// This function runs only in our isolated world. Never fall back to a website's
// polyfill or inject model-provided JavaScript into the page's main world.
async function pageToolsBridge(action, input = {}) {
  const context = document.modelContext;
  if (!context?.getTools || !context?.executeTool || !isSecureContext)
    return { available: false, tools: [] };
  const state = (globalThis.__FREEDOM_PAGE_TOOLS__ ||= (() => {
    const value = { revision: 0, tools: new Map(), job: null };
    context.addEventListener('toolchange', () => {
      value.revision += 1;
    });
    return value;
  })());
  const publicJob = () => state.job?.result || null;
  if (action === 'cancel') {
    state.tools.clear();
    if (state.job && !state.job.finished) {
      state.job.controller.abort();
      state.job.finish({ status: input?.status === 'timed_out' ? 'timed_out' : 'cancelled' });
    }
    return publicJob();
  }
  if (action === 'status') return publicJob();

  const revision = state.revision;
  const nativeTools = await context.getTools();
  if (revision !== state.revision) return { stale: true };
  const describe = (tool) => {
    const schemaText =
      typeof tool.inputSchema === 'string'
        ? tool.inputSchema
        : JSON.stringify(tool.inputSchema || { type: 'object' });
    if (
      !schemaText ||
      schemaText.length > 16_384 ||
      tool.name.length > 128 ||
      tool.description.length > 2_000
    )
      return null;
    let inputSchema;
    try {
      inputSchema = JSON.parse(schemaText);
    } catch {
      return null;
    }
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return null;
    const form = Array.from(document.forms)
      .slice(0, 256)
      .find((candidate) => candidate.getAttribute('toolname') === tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema,
      annotations: {
        readOnlyHint: tool.annotations?.readOnlyHint === true,
        consequentialHint: tool.annotations?.consequentialHint === true,
      },
      manualSubmit: Boolean(form && !form.hasAttribute('toolautosubmit')),
      ...(form && { formAction: form.action, formMethod: form.method }),
    };
  };
  const topLevelTools = nativeTools.slice(0, 1024).filter((tool) => tool.window === window);
  if (action === 'list') {
    state.tools.clear();
    const tools = [];
    let size = 0;
    for (const tool of topLevelTools.slice(0, 64)) {
      const descriptor = describe(tool);
      if (!descriptor) continue;
      size += JSON.stringify(descriptor).length;
      if (size > 65_536) break;
      const toolRef = `${input.prefix}_${tools.length}`;
      state.tools.set(toolRef, { descriptor, revision });
      tools.push({ toolRef, ...descriptor });
    }
    return {
      available: true,
      tools,
      truncated: nativeTools.length > 1024 || tools.length !== topLevelTools.length,
      execution: publicJob(),
    };
  }
  const entry = state.tools.get(input.toolRef);
  const tool = entry && topLevelTools.find((candidate) => candidate.name === entry.descriptor.name);
  if (
    !entry ||
    !tool ||
    entry.revision !== revision ||
    JSON.stringify(describe(tool)) !== JSON.stringify(entry.descriptor)
  )
    return { stale: true };
  if (action === 'inspect') return entry.descriptor;
  if (action !== 'call') return { stale: true };
  if (state.job && !state.job.finished) return { busy: true };
  const controller = new AbortController();
  const job = {
    controller,
    finished: false,
    result: {
      executionRef: input.executionRef,
      name: tool.name,
      status: entry.descriptor.manualSubmit ? 'awaiting_user' : 'running',
      mayHaveChanged: true,
    },
  };
  state.job = job;
  let timer;
  job.finish = (result) => {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(timer);
    job.result = { ...job.result, ...result };
  };
  timer = setTimeout(
    () => {
      job.finish({ status: 'timed_out' });
      controller.abort();
    },
    entry.descriptor.manualSubmit ? 300_000 : 30_000
  );
  // Electron 44's native API takes JSON text. Never retry with another calling
  // convention: the first invocation might already have produced side effects.
  try {
    Promise.resolve(
      context.executeTool(tool, JSON.stringify(input.arguments), { signal: controller.signal })
    ).then(
      (value) => {
        if (value === null || value === undefined) return job.finish({ status: 'outcome_unknown' });
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        job.finish({
          status: 'completed',
          output: text.slice(0, 32_768),
          outputTruncated: text.length > 32_768,
        });
      },
      (error) => {
        if (job.finished && error?.name === 'AbortError') {
          job.result.cancellationAcknowledged = true;
          return;
        }
        job.finish({
          status: 'failed',
          errorCategory: [
            'AbortError',
            'NotAllowedError',
            'NotFoundError',
            'TypeError',
            'UnknownError',
          ].includes(error?.name)
            ? error.name
            : 'ToolError',
        });
      }
    );
  } catch {
    job.finish({ status: 'failed', errorCategory: 'ToolError' });
  }
  return publicJob();
}

class PageTools {
  constructor({ evaluate, identity, url, timeoutMs = 30_000 }) {
    Object.assign(this, { evaluate, identity, url, timeoutMs });
    this.references = new Map();
    this.execution = null;
    this.generation = 0;
    this.callPending = false;
  }

  async bridge(action, input) {
    let timer;
    try {
      return await Promise.race([
        this.evaluate(pageToolsBridge, [action, input]),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AutomationError(
                  ERROR_CODES.CAPABILITY_UNAVAILABLE,
                  'The page did not respond to WebMCP. An invoked tool may have changed the page; do not retry automatically.'
                )
              ),
            3_000
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  stale() {
    return new AutomationError(
      ERROR_CODES.STALE_ELEMENT_REFERENCE,
      'This page tool changed. Discover the tools again before requesting new approval.'
    );
  }

  async list() {
    const identity = this.identity();
    const generation = this.generation;
    let result;
    // Registration events can arrive while a SPA is initially rendering. Only
    // discovery is retried, never an invocation or a document transition.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await this.bridge('list', { prefix: `page_tool_${crypto.randomUUID()}` });
      if (!result?.stale || identity !== this.identity() || generation !== this.generation) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (identity !== this.identity() || generation !== this.generation || result?.stale)
      throw this.stale();
    this.references.clear();
    const tools = (result.tools || []).filter((tool) => supportedPageToolSchema(tool.inputSchema));
    const unsupportedSchemas = (result.tools?.length || 0) - tools.length;
    for (const tool of tools) this.references.set(tool.toolRef, { identity, ...tool });
    if (result.execution && this.execution?.identity === identity)
      this.execution.result = result.execution;
    return {
      ...result,
      tools,
      unsupportedSchemas,
      truncated: result.truncated || unsupportedSchemas > 0,
      execution: this.execution?.result || null,
      untrusted: true,
    };
  }

  async inspect(input) {
    const entry = this.references.get(input.toolRef);
    if (!entry || entry.identity !== this.identity()) throw this.stale();
    const descriptor = await this.bridge('inspect', input);
    if (
      !descriptor ||
      descriptor.stale ||
      descriptor.available === false ||
      entry.identity !== this.identity() ||
      this.references.get(input.toolRef) !== entry
    )
      throw this.stale();
    if (!matchesPageToolArguments(descriptor.inputSchema, input.arguments))
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'Arguments do not match the discovered page tool schema'
      );
    return {
      ...descriptor,
      toolRef: input.toolRef,
      documentIdentity: entry.identity,
      url: this.url(),
      arguments: input.arguments,
    };
  }

  async call(input, { signal, expectedPageTool } = {}) {
    if (this.callPending || ['running', 'awaiting_user'].includes(this.execution?.result.status))
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'A page tool is still pending. Read browser_list_page_tools for its result or stop it before another invocation.'
      );
    this.callPending = true;
    let execution;
    const abort = () => this.cancel();
    try {
      const descriptor = await this.inspect(input);
      if (!expectedPageTool || expectedPageTool !== JSON.stringify(descriptor))
        throw new AutomationError(
          ERROR_CODES.APPROVAL_REQUIRED,
          'The exact page tool and arguments require approval'
        );
      if (signal?.aborted)
        throw new AutomationError(
          ERROR_CODES.USER_CANCELLED,
          'Page tool cancelled before execution'
        );
      const identity = this.identity();
      const executionRef = `page_execution_${crypto.randomUUID()}`;
      execution = {
        identity,
        result: { executionRef, name: descriptor.name, status: 'running', mayHaveChanged: true },
      };
      this.execution = execution;
      signal?.addEventListener('abort', abort, { once: true });
      const started = Date.now();
      let result = await this.bridge('call', { ...input, executionRef });
      while (true) {
        if (this.execution !== execution || execution.result.status === 'cancelled')
          return execution.result;
        if (execution.identity !== this.identity())
          return (execution.result = { ...execution.result, status: 'outcome_unknown' });
        if (result?.stale) throw this.stale();
        if (result?.busy)
          throw new AutomationError(
            ERROR_CODES.CAPABILITY_UNAVAILABLE,
            'A page tool is still pending'
          );
        if (!result?.executionRef) throw this.stale();
        execution.result = { ...result, untrusted: true };
        if (!['running', 'awaiting_user'].includes(result.status)) return execution.result;
        if (result.status === 'awaiting_user' && Date.now() - started >= 300)
          return execution.result;
        if (Date.now() - started >= this.timeoutMs) {
          this.cancel('timed_out');
          return (execution.result = { ...execution.result, status: 'timed_out' });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        result = await this.bridge('status');
      }
    } catch (error) {
      if (!execution) throw error;
      if (error.code === ERROR_CODES.STALE_ELEMENT_REFERENCE) {
        this.execution = null;
        throw error;
      }
      execution.result = { ...execution.result, status: 'outcome_unknown' };
      return execution.result;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.callPending = false;
    }
  }

  cancel(status = 'cancelled') {
    this.generation += 1;
    this.references.clear();
    if (this.execution && ['running', 'awaiting_user'].includes(this.execution.result.status)) {
      this.execution.result = { ...this.execution.result, status };
      void this.bridge('cancel', { status }).catch(() => {});
    }
  }

  invalidate(sameDocument = false) {
    this.generation += 1;
    this.references.clear();
    if (this.execution && ['running', 'awaiting_user'].includes(this.execution.result.status)) {
      if (sameDocument) {
        // The isolated-world job remains in this document after pushState/hash
        // routing. Keep observing its executionRef; never reuse old toolRefs.
        this.execution.identity = this.identity();
      } else this.execution.result = { ...this.execution.result, status: 'outcome_unknown' };
    }
  }
}

module.exports = { PageTools, pageToolsBridge };
