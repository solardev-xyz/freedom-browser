// Bounded text-only rendering. Project content never becomes HTML or executable code.
export function compareText(before = '', after = '') {
  const left = before ? before.split('\n') : [], right = after ? after.split('\n') : [];
  let prefix = 0, suffix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  const a = left.slice(prefix, left.length - suffix), b = right.slice(prefix, right.length - suffix);
  const rows = left.slice(0, prefix).map(text => ({ kind: 'context', text }));
  if (a.length * b.length <= 1000000) {
    const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ kind: 'context', text: a[i++] }); j += 1; }
      else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) rows.push({ kind: 'deleted', text: a[i++] });
      else rows.push({ kind: 'added', text: b[j++] });
    }
  } else {
    // Bound CPU/memory for generated or radically different documents.
    rows.push(...a.map(text => ({ kind: 'deleted', text })), ...b.map(text => ({ kind: 'added', text })));
  }
  rows.push(...left.slice(left.length - suffix).map(text => ({ kind: 'context', text })));
  let oldLine = 0, newLine = 0;
  return rows.map(row => ({ ...row, oldLine: row.kind === 'added' ? null : ++oldLine, newLine: row.kind === 'deleted' ? null : ++newLine }));
}

export function parsePatch(text) {
  let oldLine = 0, newLine = 0, inHunk = false;
  const rows = [];
  for (const line of text.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; rows.push({ kind: 'hunk', text: line }); }
    else if (inHunk && /^[ +\-]/.test(line)) rows.push({ kind: line[0] === '+' ? 'added' : line[0] === '-' ? 'deleted' : 'context', text: line.slice(1), oldLine: line[0] === '+' ? null : oldLine++, newLine: line[0] === '-' ? null : newLine++ });
    else if (line) { inHunk = false; rows.push({ kind: 'meta', text: line }); }
  }
  return rows;
}

const element = (tag, className, text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function content(text, query, highlight) {
  const node = element('span', 'workspace-code-text');
  if (query) {
    const lower = text.toLocaleLowerCase(), needle = query.toLocaleLowerCase();
    let start = 0, at;
    while ((at = lower.indexOf(needle, start)) !== -1 && start < text.length) {
      node.appendChild(element('span', '', text.slice(start, at)));
      node.appendChild(element('mark', '', text.slice(at, at + query.length)));
      start = at + query.length;
    }
    node.appendChild(element('span', '', text.slice(start)));
  } else if (highlight && text.length < 4000) {
    const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/.*$|\b(?:const|let|var|function|return|if|else|import|export|from|class|async|await|true|false|null|def|for|while)\b)/g;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      node.appendChild(element('span', '', text.slice(start, match.index)));
      node.appendChild(element('span', 'workspace-code-token', match[0])); start = match.index + match[0].length;
    }
    node.appendChild(element('span', '', text.slice(start)));
  } else node.textContent = text || ' ';
  return node;
}

export function renderDocument(host, rows, { split = false, query = '', highlight = false, collapse = true, start = 0 } = {}) {
  host.replaceChildren(); host.classList.remove('workspace-markdown'); host.classList.toggle('workspace-code-split', split);
  if (query && start === 0) {
    const match = rows.findIndex(row => row.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    if (match >= 2000) start = Math.floor(match / 2000) * 2000;
  }
  if (rows.length > 2000) {
    const all = rows; const pager = element('div', 'workspace-viewer-document-tools');
    for (const [label, next] of [['Previous lines', start - 2000], ['Next lines', start + 2000]]) {
      const button = element('button', 'workspace-viewer-action', label); button.type = 'button'; button.disabled = next < 0 || next >= all.length;
      button.addEventListener('click', () => renderDocument(host, all, { split, query, highlight, collapse, start: next })); pager.appendChild(button);
    }
    pager.appendChild(element('span', 'workspace-viewer-caption', `Lines ${start + 1}–${Math.min(start + 2000, all.length)} of ${all.length}`)); host.appendChild(pager);
    rows = all.slice(start, start + 2000);
  }
  let group = 0, changed = false;
  const rowNode = row => {
    const node = element('div', `workspace-code-row workspace-code-${row.kind}`);
    if (['added', 'deleted'].includes(row.kind)) {
      if (!changed) { node.dataset.change = String(group++); changed = true; }
    } else changed = false;
    node.appendChild(element('span', 'workspace-line-number', row.oldLine ?? ''));
    node.appendChild(element('span', 'workspace-line-number', row.newLine ?? ''));
    node.appendChild(content(row.text, query, highlight));
    return node;
  };
  for (let index = 0; index < rows.length;) {
    const row = rows[index];
    if (collapse && !split && !query && row.kind === 'context') {
      let end = index; while (end < rows.length && rows[end].kind === 'context') end += 1;
      if (end - index > 12) {
        for (const item of rows.slice(index, index + 3)) host.appendChild(rowNode(item));
        const details = element('details', 'workspace-code-fold');
        details.appendChild(element('summary', '', `${end - index - 6} unchanged lines`));
        for (const item of rows.slice(index + 3, end - 3)) details.appendChild(rowNode(item));
        host.appendChild(details);
        for (const item of rows.slice(end - 3, end)) host.appendChild(rowNode(item));
        index = end; continue;
      }
    }
    if (split && !['meta', 'hunk'].includes(row.kind)) {
      const pair = (left, right) => {
        const line = element('div', 'workspace-code-pair');
        for (const [value, side] of [[left, 'old'], [right, 'new']]) {
          const cell = value ? rowNode({ ...value, oldLine: side === 'old' ? value.oldLine : null, newLine: side === 'new' ? value.newLine : null }) : element('div', 'workspace-code-row');
          cell.classList.add(`workspace-code-${side}`); line.appendChild(cell);
        }
        host.appendChild(line);
      };
      if (row.kind === 'context') { pair(row, row); index += 1; }
      else {
        const deleted = [], added = [];
        while (index < rows.length && ['deleted', 'added'].includes(rows[index].kind)) { (rows[index].kind === 'deleted' ? deleted : added).push(rows[index++]); }
        for (let n = 0; n < Math.max(deleted.length, added.length); n += 1) pair(deleted[n], added[n]);
      }
    } else { host.appendChild(rowNode(row)); index += 1; }
  }
  if (!rows.length) host.appendChild(element('p', 'workspace-viewer-message', 'No content to show.'));
  return group;
}

export function renderMarkdown(host, text, { query = '' } = {}) {
  host.replaceChildren(); host.classList.remove('workspace-code-split'); host.classList.add('workspace-markdown'); let code = null;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) { if (code) code = null; else { code = element('pre', ''); host.appendChild(code); } continue; }
    if (code) { code.appendChild(content(`${line}\n`, query, false)); continue; }
    const heading = /^(#{1,6})\s+(.*)/.exec(line);
    // Raw HTML, URLs and images remain literal text; no resource loads or scripts.
    const block = element(heading ? `h${heading[1].length}` : 'p', '');
    block.appendChild(content(heading ? heading[2] : line, query, false)); host.appendChild(block);
  }
}
