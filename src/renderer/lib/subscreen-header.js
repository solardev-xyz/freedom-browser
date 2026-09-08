// The one header every wallet-sidebar sub-screen uses (#238).
//
// The sidebar had grown three hand-copied header layouts, and every new
// screen inherited whichever neighbour it was pasted next to:
//
//   1. "‹ Back  Title"          — Send, Connect, the Swarm approvals, …
//   2. "‹  Title"               — dApp Confirm Transaction, Sign Message,
//                                 Payment Required (chevron, no "Back")
//   3. "Title"                  — the remote-signing panel, no way back
//
// A sub-screen now *declares* its header instead of spelling it out:
//
//   <div class="subscreen-header"
//        data-back="dapp-tx-back"
//        data-title="Confirm Transaction"></div>
//
// and `renderSubscreenHeaders()` fills in the chevron, the "Back" label and
// the <h3>. The button and heading ids are unchanged, so every existing
// handler, test and disabled-while-signing toggle keeps working.
//
//   data-back      id for the back button. Omitted only by the
//                  remote-signing panel, which deliberately offers no way
//                  back: it appears *after* the user already confirmed, and
//                  the phone is the only thing that can settle it.
//   data-title     the heading text.
//   data-title-id  id for the <h3>, for the four screens that retitle
//                  themselves at runtime (Collect signatures, Messaging
//                  Access, Feed Access, Radicle Access).
//
// Deliberately *no* close control. The sidebar's own "×" (`#sidebar-close`)
// stays the single close affordance: the approval sub-screens
// (`.sidebar-modal`) cover it on purpose so a pending dApp/Swarm request can
// only be answered, never dismissed by a stray click. Putting a "×" in this
// header would hand exactly those screens a new way out, and hiding the
// sidebar's own "×" would take one away from Send. So the close control is
// consistently absent here, and consistently the sidebar's everywhere else.

// Static markup, never interpolated. `aria-hidden` because the adjacent
// "Back" label already names the button (and, on the remote-signing panel,
// there is no button at all).
const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
  '<polyline points="15 18 9 12 15 6" />' +
  '</svg>';

/**
 * Build one header's children from its declaration.
 *
 * @param {Document} doc
 * @param {{ backId?: string, title: string, titleId?: string }} spec
 * @returns {Element[]}
 */
function buildHeader(doc, { backId, title, titleId }) {
  const children = [];

  if (backId) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'subscreen-back-btn';
    button.id = backId;
    button.innerHTML = CHEVRON_SVG;
    const label = doc.createElement('span');
    label.textContent = 'Back';
    button.appendChild(label);
    children.push(button);
  }

  const heading = doc.createElement('h3');
  heading.className = 'subscreen-title';
  if (titleId) heading.id = titleId;
  heading.textContent = title;
  children.push(heading);

  return children;
}

/**
 * Render every declared sub-screen header in `doc`.
 *
 * Must run before anything caches the ids it creates — it is the first thing
 * the renderer's DOMContentLoaded handler does. Idempotent: re-running it
 * replaces the children it previously produced. A `.subscreen-header` with no
 * `data-title` is left alone rather than emptied, so a partially-migrated
 * screen degrades to "unchanged" rather than "blank".
 *
 * @param {Document} [doc]
 * @returns {number} how many headers were rendered
 */
export function renderSubscreenHeaders(doc = document) {
  let rendered = 0;
  for (const header of doc.querySelectorAll('.subscreen-header')) {
    const title = header.dataset.title;
    if (!title) continue;
    header.replaceChildren(
      ...buildHeader(doc, {
        backId: header.dataset.back,
        title,
        titleId: header.dataset.titleId,
      })
    );
    rendered += 1;
  }
  return rendered;
}
