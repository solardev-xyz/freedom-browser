'use strict';

const crypto = require('crypto');
const { OPERATIONS } = require('../automation/contract/operations');
const { ERROR_CODES } = require('../automation/contract/errors');

const OBSERVATIONS = new Set([OPERATIONS.SNAPSHOT, OPERATIONS.READ_FRAME]);
const RETRYABLE_ATTEMPTS = new Set([
  ...OBSERVATIONS,
  OPERATIONS.CLICK,
  OPERATIONS.TYPE,
  OPERATIONS.SELECT,
  OPERATIONS.PRESS,
  OPERATIONS.SCROLL,
]);
const RECOVERABLE_ERRORS = new Set([
  ERROR_CODES.STALE_ELEMENT_REFERENCE,
  ERROR_CODES.ELEMENT_NOT_FOUND,
  ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
  ERROR_CODES.CAPABILITY_UNAVAILABLE,
]);
const PROGRESS_RECEIPTS = new Set([
  OPERATIONS.NAVIGATE,
  OPERATIONS.TYPE,
  OPERATIONS.SELECT,
  OPERATIONS.WAIT,
]);
const MAX_PAGES = 8;
const MAX_REFERENCES = 512;
const ATTEMPT_WINDOW = 20;
const IDLE_RESET_MS = 120_000;

function canonical(value, frameIndexes) {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, frameIndexes));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'ref') continue;
    if (key === 'frameId' || key === 'parentFrameId') {
      result[key] = frameIndexes.get(value[key]) ?? null;
    } else {
      result[key] = canonical(value[key], frameIndexes);
    }
  }
  return result;
}

function hint(kind, count) {
  if (count !== 4 && count !== 8) return null;
  const lead =
    kind === 'observation'
      ? `The same returned browser observation has appeared ${count} times.`
      : kind === 'scroll'
        ? `Scrolling this target has reported no movement ${count} times.`
        : `The same browser attempt has returned the same retryable error ${count} times.`;
  const next =
    kind === 'observation'
      ? 'Use continuation offsets or a targeted query for missing content, or wait for an expected state.'
      : kind === 'scroll'
        ? 'Check the observed viewport or container and its boundaries; scrolling it again may not reveal more content.'
        : 'Read the current state, check the error, and use a fresh observed reference or another supported approach.';
  return `Freedom browser recovery: ${lead} ${next} Check previous action receipts before retrying: unchanged visible content does not establish whether an interaction had side effects.${count === 8 ? ' Change approach; if no supported route remains, explain the observed blocker and any changes already made.' : ''}`;
}

// Advisory evidence only: no permissions, retries, tool calls or task completion.
// Retain keyed digests in this tool session, never raw observations/input payloads
// or persistent hashes that can be compared across conversations.
class BrowserRecoveryTracker {
  #secret = crypto.randomBytes(32);
  #pages = new Map();
  #lastAt = 0;
  #now;

  constructor(now = Date.now) {
    this.#now = now;
  }

  reset() {
    this.#pages.clear();
  }

  record(operation, input, envelope, error) {
    try {
      return this.#record(operation, input, envelope, error);
    } catch {
      // Advisory bookkeeping must never change an executed operation's outcome.
      this.reset();
      return null;
    }
  }

  #record(operation, input, envelope, error) {
    const at = this.#now();
    if (at - this.#lastAt > IDLE_RESET_MS) this.reset();
    this.#lastAt = at;
    if (operation === OPERATIONS.STOP_LOADING || operation === OPERATIONS.CLOSE_TAB) {
      this.reset();
      return null;
    }
    if (
      !input?.tabId ||
      (!OBSERVATIONS.has(operation) &&
        !RETRYABLE_ATTEMPTS.has(operation) &&
        !PROGRESS_RECEIPTS.has(operation))
    )
      return null;
    const pageKey = this.#digest(input.tabId);
    if (!this.#pages.has(pageKey)) {
      this.#pages.set(pageKey, {
        observation: null,
        repeats: 0,
        attempts: [],
        recent: [],
        references: new Map(),
      });
      if (this.#pages.size > MAX_PAGES) this.#pages.delete(this.#pages.keys().next().value);
    }
    const page = this.#pages.get(pageKey);
    const result = envelope?.result;
    if (error) {
      if (
        error.retryable !== true ||
        !RECOVERABLE_ERRORS.has(error.code) ||
        !RETRYABLE_ATTEMPTS.has(operation)
      )
        return null;
      return this.#attempt(page, operation, input, error.code, 'failure');
    }
    if (envelope?.ok !== true) return null;
    if (
      PROGRESS_RECEIPTS.has(operation) ||
      (operation === OPERATIONS.SCROLL && result?.moved === true)
    ) {
      page.observation = null;
      page.repeats = 0;
      page.attempts = [];
      page.recent = [];
      if (operation === OPERATIONS.NAVIGATE) page.references.clear();
      return null;
    }
    if (operation === OPERATIONS.SCROLL && ['boundary', 'no_movement'].includes(result?.outcome)) {
      return this.#attempt(page, operation, input, result.outcome, 'scroll');
    }
    if (!OBSERVATIONS.has(operation) || !result || typeof result.text !== 'string') return null;
    const frames = new Map((result.frames || []).map((frame, index) => [frame.frameId, index]));
    const scope = this.#digest({
      operation,
      frameRef: input.frameRef,
      // These tools match literal text case-insensitively. Preserve punctuation
      // and word order, unlike keyword-search normalization.
      query: (input.query || '').trim().replace(/\s+/g, ' ').toLowerCase(),
      textQuery: (input.textQuery || '').trim().replace(/\s+/g, ' ').toLowerCase(),
      elementOffset: input.elementOffset || 0,
      textOffset: input.textOffset || 0,
    });
    const { query: _query, textQuery: _textQuery, ...observed } = result;
    const observation = this.#digest({
      scope,
      navigationId: envelope.navigationId,
      result: canonical(observed, frames),
    });
    if (page.observation === observation) page.repeats += 1;
    else {
      page.observation = observation;
      page.repeats = 1;
      page.attempts = [];
    }
    for (const [index, element] of (result.elements || []).entries()) {
      if (typeof element.ref !== 'string') continue;
      this.#remember(page, element.ref, { scope, index, element: canonical(element, frames) });
    }
    for (const [index, frame] of (result.frames || []).entries()) {
      if (typeof frame.viewport?.ref !== 'string') continue;
      this.#remember(page, frame.viewport.ref, { scope, index, viewport: true, url: frame.url });
    }
    page.recent.push({ scope, observation });
    if (page.recent.length > 6) page.recent.shift();
    const repeated = hint('observation', page.repeats);
    if (repeated) return repeated;
    const recent = page.recent;
    if (
      recent.length === 6 &&
      recent.every((entry) => entry.scope === scope) &&
      recent[0].observation !== recent[1].observation &&
      recent.every((entry, index) => entry.observation === recent[index % 2].observation)
    ) {
      page.recent = [];
      return 'Freedom browser recovery: The same two observed states have alternated three times. Check earlier evidence with browser_recall_evidence and confirm whether the requested outcome changed before repeating this cycle. This is advisory; previous interactions may have had side effects.';
    }
    return null;
  }

  #attempt(page, operation, input, outcome, kind) {
    const target =
      page.references.get(this.#digest(input.ref || '')) || this.#digest(input.ref || '');
    const signature = this.#digest({
      operation,
      outcome,
      target,
      frameRef: input.frameRef,
      text: input.text,
      replace: input.replace,
      key: input.key,
      value: input.value,
      direction: input.direction,
      pages: input.pages ?? 1,
      query: input.query,
      textQuery: input.textQuery,
      elementOffset: input.elementOffset || 0,
      textOffset: input.textOffset || 0,
    });
    page.attempts.push(signature);
    if (page.attempts.length > ATTEMPT_WINDOW) page.attempts.shift();
    return hint(kind, page.attempts.filter((entry) => entry === signature).length);
  }

  #remember(page, ref, descriptor) {
    page.references.set(this.#digest(ref), this.#digest(descriptor));
    if (page.references.size > MAX_REFERENCES)
      page.references.delete(page.references.keys().next().value);
  }

  #digest(value) {
    return crypto.createHmac('sha256', this.#secret).update(JSON.stringify(value)).digest('hex');
  }
}

module.exports = { BrowserRecoveryTracker };
