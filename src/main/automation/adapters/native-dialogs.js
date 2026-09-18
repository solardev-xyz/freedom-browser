'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { AutomationError, ERROR_CODES } = require('../contract/errors');

const unavailable = () =>
  new AutomationError(
    ERROR_CODES.CAPABILITY_UNAVAILABLE,
    'Native dialog observation is unavailable; close DevTools before enabling it'
  );
const blocked = () =>
  new AutomationError(
    ERROR_CODES.CAPABILITY_UNAVAILABLE,
    'A native dialog interrupted page execution. Inspect it with browser_get_dialog; do not repeat the preceding action.',
    { retryable: false }
  );

// Enabled for an owned page before task interactions or explicit inspection. The
// connection is shared only with this adapter's fixed frame/file operations;
// an independently attached debugger is never borrowed or displaced.
class NativeDialogs extends EventEmitter {
  constructor(webContents) {
    super();
    this.webContents = webContents;
    this.api = webContents.debugger;
    this.owned = false;
    this.pending = null;
    this.revision = 0;
    this.navigationAttempt = null;
    this.resuming = null;
    this.onDetach = () => {
      this.owned = false;
      this.pending = null;
      this.revision++;
      this.emit('interrupted');
    };
    this.onMessage = (_event, method, params, sessionId) => {
      if (!this.owned || sessionId) return;
      if (method === 'Page.javascriptDialogOpening') {
        if (params.type === 'beforeunload' && this.resuming?.source === this.source(params.url))
          return;
        this.pending = {
          dialogRef: `dialog_${crypto.randomUUID()}`,
          type: params.type,
          url: String(params.url || '').slice(0, 8192),
          message: String(params.message || '').slice(0, 2000),
          messageTruncated: String(params.message || '').length > 2000,
          defaultPrompt: String(params.defaultPrompt || '').slice(0, 2000),
          revision: this.revision,
          source: this.source(params.url),
          ...(params.type === 'beforeunload' &&
            this.navigationAttempt && {
              navigation: this.navigationAttempt,
              navigationTarget: this.navigationAttempt.url,
            }),
        };
        this.emit('opened');
      }
      if (method === 'Page.javascriptDialogClosed') {
        if (
          this.pending?.type === 'beforeunload' &&
          params.result === false &&
          this.pending.navigation
        )
          this.pending.navigationCancelled = true;
        else this.pending = null;
      }
      if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
        this.revision++;
        this.pending = null;
      }
    };
  }

  source(url) {
    try {
      const root = this.webContents.mainFrame;
      // Bind only a uniquely identified top-level document across supported CDP
      // versions; URL equality alone cannot authorize an ambiguous subframe.
      if (
        !root ||
        root.detached ||
        root.url !== url ||
        !root.origin ||
        root.origin === 'null' ||
        root.framesInSubtree.filter((frame) => frame.url === url).length !== 1
      )
        return null;
      return `${root.processId}:${root.frameToken}:${root.origin}`;
    } catch {
      return null;
    }
  }

  ownsConnection() {
    return this.owned && this.api?.isAttached() === true;
  }

  async start() {
    if (this.ownsConnection()) return;
    this.api?.removeListener?.('message', this.onMessage);
    this.api?.removeListener?.('detach', this.onDetach);
    if (!this.api || this.api.isAttached() || this.webContents.isDevToolsOpened?.())
      throw unavailable();
    this.api.on('message', this.onMessage);
    this.api.on('detach', this.onDetach);
    try {
      this.api.attach('1.3');
      this.owned = true;
      let timer;
      try {
        await Promise.race([
          this.api.sendCommand('Page.enable'),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(unavailable()), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!this.ownsConnection()) throw unavailable();
    } catch {
      this.dispose();
      throw unavailable();
    }
  }

  current() {
    if (!this.ownsConnection() || !this.pending) return null;
    if (!this.pending.source || this.pending.source !== this.source(this.pending.url))
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'This dialog cannot be bound to a unique top-level document; handle it manually'
      );
    const {
      revision: _revision,
      source: _source,
      navigation: _navigation,
      ...dialog
    } = this.pending;
    return { ...dialog, untrusted: true };
  }

  inspect(input) {
    const dialog = this.current();
    if (!dialog || dialog.dialogRef !== input.dialogRef || this.pending.revision !== this.revision)
      throw new AutomationError(
        ERROR_CODES.STALE_ELEMENT_REFERENCE,
        'This dialog is no longer current'
      );
    if (dialog.type === 'prompt' && input.accept && input.promptText === undefined)
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'Accepting a prompt requires explicit promptText'
      );
    if (input.promptText !== undefined && (dialog.type !== 'prompt' || !input.accept))
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'Prompt text requires accepting a prompt dialog'
      );
    return dialog;
  }

  async respond(input, execution) {
    const dialog = this.inspect(input);
    // The host supplies authorization after approval; input cannot forge it.
    if (
      execution?.expectedDialog !==
      JSON.stringify({ ...dialog, accept: input.accept, promptText: input.promptText })
    )
      throw new AutomationError(
        ERROR_CODES.POLICY_DENIED,
        'Dialog response requires current approval'
      );
    const pending = this.pending;
    if (dialog.navigationCancelled) {
      this.pending = null;
      if (!input.accept) return { handled: true, type: dialog.type, accepted: false, stayed: true };
      const resume = { source: pending.source, used: false };
      this.resuming = resume;
      const allowLeave = (event) => {
        if (!resume.used && this.resuming === resume && resume.source === this.source(dialog.url)) {
          resume.used = true;
          event.preventDefault();
        }
      };
      this.webContents.on('will-prevent-unload', allowLeave);
      try {
        await this.guard(pending.navigation.task);
        return { handled: true, type: dialog.type, accepted: true, navigationRetried: true };
      } finally {
        this.webContents.removeListener('will-prevent-unload', allowLeave);
        if (this.resuming === resume) this.resuming = null;
      }
    }
    await this.api.sendCommand('Page.handleJavaScriptDialog', {
      accept: input.accept,
      ...(input.promptText !== undefined && { promptText: input.promptText }),
    });
    if (this.pending === pending) this.pending = null;
    return { handled: true, type: dialog.type, accepted: input.accept };
  }

  // Renderer execution can pause inside alert/confirm/prompt. Return control to
  // the agent without retrying or claiming the interrupted operation completed.
  async navigate(url, task) {
    if (!this.ownsConnection()) return task();
    if (this.navigationAttempt) throw blocked();
    this.navigationAttempt = { url, task };
    try {
      return await this.guard(task);
    } finally {
      this.navigationAttempt = null;
    }
  }

  async guard(task) {
    if (this.pending) throw blocked();
    let interrupt;
    const interrupted = new Promise((_resolve, reject) => {
      interrupt = () => reject(blocked());
      this.once('opened', interrupt);
      this.once('interrupted', interrupt);
    });
    try {
      return await Promise.race([task(), interrupted]);
    } finally {
      this.removeListener('opened', interrupt);
      this.removeListener('interrupted', interrupt);
    }
  }

  stop() {
    this.resuming = null;
    // Stop withdraws pending authorization, not the website's confirmation.
    // Keep an open dialog untouched; a subsequent explicit observation gets
    // a new handle. Never silently accept or dismiss a confirm/beforeunload.
    if (this.pending) {
      this.pending.dialogRef = `dialog_${crypto.randomUUID()}`;
      this.emit('interrupted');
    } else this.dispose();
  }

  dispose() {
    const owned = this.ownsConnection();
    this.owned = false;
    this.pending = null;
    this.resuming = null;
    this.revision++;
    this.api?.removeListener?.('message', this.onMessage);
    this.api?.removeListener?.('detach', this.onDetach);
    if (owned) {
      try {
        this.api.detach();
      } catch {
        /* Page already closed. */
      }
    }
    this.emit('interrupted');
  }
}

module.exports = { NativeDialogs };
