// Where a stopped run's cut-off answer draws its " …" mark.
//
// The mark belongs at the end of the sentence the stream stopped in. Plain
// streamed text ends in the output itself. A segment closed as markdown (by
// guidance sent mid-answer) ends in its last text block, which can sit at any
// depth: a list item inside a list item inside a blockquote, a loose item's
// paragraph, and so on. CSS can't select "the deepest last block" for an
// arbitrary nesting, so walk the last-child chain here and tag the block the
// text actually ends in. When the answer ends in a code block, table or rule
// there is no sentence to end, so the output itself carries the mark and it
// sits on its own line below.
//
// Text can also trail the last element directly: DOMPurify strips a raw HTML
// block tag (`<div>tail`) but keeps its content, leaving a bare text node after
// the last list or paragraph. That text is where the answer ends, so the mark
// goes on the node holding it, not inside the element before it.

export const CUTOFF_HOST_CLASS = 'agent-cutoff-end';

const TEXT_BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const CONTAINERS = new Set(['UL', 'OL', 'LI', 'BLOCKQUOTE']);
const OWN_LINE = new Set(['PRE', 'TABLE', 'HR']);
const TEXT_NODE = 3;

// True when a non-blank text node comes after the last element child of `node`.
function endsInBareText(node) {
  for (let child = node.lastChild; child && child !== node.lastElementChild; child = child.previousSibling) {
    if (child.nodeType === TEXT_NODE && /\S/.test(child.textContent || '')) return true;
  }
  return false;
}

export function cutOffMarkHost(output) {
  if (!output?.classList?.contains('rendered-markdown')) return output;
  let node = output;
  for (;;) {
    const last = node.lastElementChild;
    if (!last || endsInBareText(node)) return node;
    const tag = String(last.tagName || '').toUpperCase();
    if (TEXT_BLOCKS.has(tag)) return last;
    if (CONTAINERS.has(tag)) {
      node = last;
      continue;
    }
    if (OWN_LINE.has(tag)) return output;
    // An inline element (strong, code, br, …) ends the text of `node` itself.
    return node;
  }
}

export function setCutOffMark(output, cutOff) {
  if (!output) return;
  output.classList.toggle('incomplete', Boolean(cutOff));
  for (const marked of [...(output.querySelectorAll?.(`.${CUTOFF_HOST_CLASS}`) || [])]) {
    marked.classList.remove(CUTOFF_HOST_CLASS);
  }
  output.classList.remove(CUTOFF_HOST_CLASS);
  if (cutOff) cutOffMarkHost(output)?.classList.add(CUTOFF_HOST_CLASS);
}
