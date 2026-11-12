/**
 * The approvals document's kinds (freedom-core design 0011, "What a prompt
 * shows" and "Rendering a page's data"; APS-1, APS-2): for each prompt kind
 * main issues, its closed schema, its heading and approve label, and its
 * fixed template.
 *
 * A template gets the checked view and the builders (approvals-core.js),
 * and nothing else: every element comes from a fixed tag and class, every
 * value goes in as text. A value main owns (the account, the chain, the fee
 * check's verdict, a warning code) is shown as main's (`ui.own`, or fixed
 * copy picked by a code from a fixed list); a value a page chose is shown
 * as the page's (`ui.page`), encoded and cut. A template returns what the
 * page reads the user's choices from: `choices()`, the decision's
 * `choices`, or null while there is nothing to approve yet.
 *
 * A classic script, loaded after approvals-core.js.
 */
(function approvalsKinds(root, factory) {
  'use strict';
  const fromNode = typeof module === 'object' && module.exports;
  const api = factory(fromNode ? require('./approvals-core.js') : root.ApprovalsCore);
  if (fromNode) module.exports = api;
  else Object.defineProperty(root, 'ApprovalsKinds', { value: api });
})(typeof window === 'undefined' ? globalThis : window, function kinds(core) {
  'use strict';

  const { text, list, record } = core.schema;
  const { isPlainObject, conforms, viewBytes, MAX_VIEW_BYTES } = core;

  const HANDLE = /^[0-9a-f]{64}$/;
  const MESSAGE_KEYS = ['handle', 'guest', 'kind', 'site', 'view'];
  const SITE = record({ key: text(2048), label: text(2048) });
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  const KINDS = Object.freeze({
    // The harness's prompt (APS-1): every field is the test's choice, and is
    // treated as a page's. Main issues it only under the E2E harness.
    'test.prompt': Object.freeze({
      schema: record({
        title: text(120),
        message: text(4096, { multiline: true }),
        rows: list(16, record({ label: text(64), value: text(4096) })),
      }),
      heading: () => 'Test request',
      approve: () => 'Approve',
      render(view, ui, body) {
        body.append(ui.page('Title', view.title), ui.page('Message', view.message, { multiline: true }));
        for (const row of view.rows) body.append(ui.page(row.label, row.value));
        return null;
      },
    }),
  });

  /**
   * A `page:prompt` message, checked. Null when it names no handle (there
   * is nothing to answer); otherwise the handle, and its site and view only
   * when the whole message fits its kind's schema (`valid`). An invalid one
   * shows the fixed error and can only be rejected.
   */
  function checkMessage(message) {
    if (!isPlainObject(message)) return null;
    const { handle } = message;
    if (typeof handle !== 'string' || !HANDLE.test(handle)) return null;
    const keys = Object.keys(message);
    const kind = typeof message.kind === 'string' && hasOwn(KINDS, message.kind) ? message.kind : null;
    const valid =
      kind !== null &&
      keys.length === MESSAGE_KEYS.length &&
      keys.every((key) => MESSAGE_KEYS.includes(key)) &&
      Number.isInteger(message.guest) &&
      conforms(message.site, SITE) &&
      viewBytes(message.view) <= MAX_VIEW_BYTES &&
      conforms(message.view, KINDS[kind].schema);
    return valid
      ? { handle, kind, site: message.site, view: message.view, valid: true }
      : { handle, kind: null, site: null, view: null, valid: false };
  }

  return Object.freeze({ KINDS, SITE, checkMessage });
});
