// Radicle Browser JavaScript
  // =============================================
  // STATE & CONFIGURATION
  // =============================================

  const params = new URLSearchParams(window.location.search);
  const rid = params.get('rid');
  const base = params.get('base') || 'http://127.0.0.1:8780';
  const PUBLIC_SEED = 'https://seed.radicle.xyz';

  // App state
  let repoMeta = null;   // Repo metadata from API root
  let headSha = null;    // HEAD commit SHA
  let projectName = '';   // Repo name
  let currentView = null; // 'root' | 'tree' | 'blob'
  let currentPath = '';   // Current path within repo

  // DOM elements
  const displayRid = document.getElementById('display-rid');
  const loadingState = document.getElementById('loading-state');
  const errorState = document.getElementById('error-state');
  const successState = document.getElementById('success-state');
  const connectionError = document.getElementById('connection-error');
  const invalidRidError = document.getElementById('invalid-rid-error');
  const errorRid = document.getElementById('error-rid');
  const seedBtn = document.getElementById('seed-btn');
  const seedStatus = document.getElementById('seed-status');
  const repoCount = document.getElementById('repo-count');
  const repoList = document.getElementById('repo-list');
  const networkCount = document.getElementById('network-count');
  const networkList = document.getElementById('network-list');
  const invalidRidInput = document.getElementById('invalid-rid-input');

  // Code browser elements
  const repoHeaderEl = document.getElementById('repo-header');
  const statsBarEl = document.getElementById('stats-bar');
  const breadcrumbEl = document.getElementById('breadcrumb-container');
  const lastCommitEl = document.getElementById('last-commit');
  const fileTreeEl = document.getElementById('file-tree-container');
  const fileViewerEl = document.getElementById('file-viewer-container');
  const readmeEl = document.getElementById('readme-container');

  // Set up highlight.js theme based on color scheme
  function updateHljsTheme() {
    const link = document.getElementById('hljs-theme');
    if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      link.href = '../vendor/hljs-github-light.css';
    } else {
      link.href = '../vendor/hljs-github-dark.css';
    }
  }
  updateHljsTheme();
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', updateHljsTheme);

  // Show RID in header
  displayRid.textContent = rid ? `rad://${rid}` : 'rad://...';

  // =============================================
  // UTILITIES
  // =============================================

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() / 1000) - timestamp);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years !== 1 ? 's' : ''} ago`;
  }

  function formatNumber(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(n);
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
  }

  function getLanguage(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
      rs: 'rust', js: 'javascript', ts: 'typescript', jsx: 'javascript',
      tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go', c: 'c',
      h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp',
      java: 'java', kt: 'kotlin', swift: 'swift', sh: 'bash',
      bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell',
      html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
      css: 'css', scss: 'scss', less: 'less', sass: 'scss',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
      ini: 'ini', cfg: 'ini', conf: 'ini',
      md: 'markdown', markdown: 'markdown',
      sql: 'sql', graphql: 'graphql', gql: 'graphql',
      dockerfile: 'dockerfile', makefile: 'makefile',
      r: 'r', lua: 'lua', perl: 'perl', pl: 'perl',
      php: 'php', ex: 'elixir', exs: 'elixir', erl: 'erlang',
      hs: 'haskell', ml: 'ocaml', mli: 'ocaml', clj: 'clojure',
      vim: 'vim', diff: 'diff', patch: 'diff',
      tf: 'hcl', nix: 'nix', zig: 'zig',
      proto: 'protobuf', cmake: 'cmake',
    };
    return map[ext] || null;
  }

  function sortEntries(entries) {
    const dirs = entries.filter(e => e.kind === 'tree' || e.kind === 'submodule');
    const files = entries.filter(e => e.kind === 'blob');
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  // Resolve a relative path against a base path
  // e.g., resolvePath('docs/api', '../README.md') => 'README.md'
  // e.g., resolvePath('', 'HACKING.md') => 'HACKING.md'
  function resolvePath(basePath, relativePath) {
    // Handle absolute paths (starting with /)
    if (relativePath.startsWith('/')) {
      return relativePath.slice(1);
    }

    // Split base path into segments (empty string = root)
    const baseSegments = basePath ? basePath.split('/').filter(Boolean) : [];

    // Split relative path and process each segment
    const relSegments = relativePath.split('/').filter(Boolean);
    const result = [...baseSegments];

    for (const segment of relSegments) {
      if (segment === '..') {
        result.pop();
      } else if (segment !== '.') {
        result.push(segment);
      }
    }

    return result.join('/');
  }

  // Handle clicks on links within rendered markdown (README, etc.)
  function handleMarkdownLinkClick(event) {
    const link = event.target.closest('a');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href) return;

    // Prevent default navigation
    event.preventDefault();

    // External URLs - open in new tab
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      window.freedomAPI?.openInNewTab?.(href);
      return;
    }

    // Anchor links - scroll within page
    if (href.startsWith('#')) {
      const target = document.querySelector(href);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }

    // Relative or absolute path within repo
    // Determine base path from current view
    let basePath = '';
    if (currentView === 'tree' && currentPath) {
      basePath = currentPath;
    } else if (currentView === 'blob' && currentPath) {
      // For blob view, base is the parent directory
      const lastSlash = currentPath.lastIndexOf('/');
      basePath = lastSlash > 0 ? currentPath.slice(0, lastSlash) : '';
    }

    // Resolve the path
    const resolvedPath = resolvePath(basePath, href);

    // Determine if it's likely a file or directory
    // Heuristic: if it has an extension, treat as blob; otherwise tree
    // Also handle trailing slash as directory
    const isDirectory = href.endsWith('/') || !resolvedPath.includes('.') || resolvedPath.endsWith('/');

    if (isDirectory) {
      const cleanPath = resolvedPath.replace(/\/$/, '');
      navigate(cleanPath ? `tree/${cleanPath}` : '');
    } else {
      navigate(`blob/${resolvedPath}`);
    }
  }

  // =============================================
  // DATA FETCHING
  // =============================================

  async function fetchRepoMeta() {
    const res = await fetch(`${base}/api/v1/repos/rad:${rid}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async function fetchTree(sha, path) {
    const url = path
      ? `${base}/api/v1/repos/rad:${rid}/tree/${sha}/${path}`
      : `${base}/api/v1/repos/rad:${rid}/tree/${sha}/`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async function fetchBlob(sha, path) {
    const res = await fetch(`${base}/api/v1/repos/rad:${rid}/blob/${sha}/${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async function fetchReadme(sha) {
    try {
      const res = await fetch(`${base}/api/v1/repos/rad:${rid}/readme/${sha}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function fetchStats(sha) {
    try {
      const res = await fetch(`${base}/api/v1/repos/rad:${rid}/stats/tree/${sha}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function fetchRemotes() {
    try {
      const res = await fetch(`${base}/api/v1/repos/rad:${rid}/remotes`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  // Get head SHA from delegates' remotes (fallback when xyz.radicle.project is missing)
  function getHeadFromRemotes(remotes, defaultBranch) {
    // Find delegates (canonical sources)
    const delegates = remotes.filter(r => r.delegate);
    const branches = [defaultBranch, 'master', 'main'].filter(Boolean);

    for (const delegate of delegates) {
      const heads = delegate.heads || {};
      for (const branch of branches) {
        if (heads[branch]) {
          return { sha: heads[branch], branch };
        }
      }
    }

    // Fallback: try any remote with master/main
    for (const remote of remotes) {
      const heads = remote.heads || {};
      for (const branch of branches) {
        if (heads[branch]) {
          return { sha: heads[branch], branch };
        }
      }
    }

    return null;
  }

  // Fetch repo payload via CLI (workaround for radicle-httpd bug)
  async function fetchPayloadViaCli() {
    if (!window.freedomAPI?.getRadicleRepoPayload) {
      return null;
    }
    try {
      const result = await window.freedomAPI.getRadicleRepoPayload(rid);
      if (result.success && result.payload) {
        return result.payload;
      }
      return null;
    } catch {
      return null;
    }
  }

  // =============================================
  // RENDERING
  // =============================================

  // Track if we used CLI fallback for metadata
  let usedCliFallback = false;

  function renderRepoHeader(meta, cliPayload = null) {
    // Prefer HTTP API data, fall back to CLI payload
    const httpProject = meta.payloads?.['xyz.radicle.project']?.data;
    const cliProject = cliPayload?.['xyz.radicle.project'];
    const project = httpProject || cliProject || {};

    const name = project.name || `rad:${rid}`;
    const desc = project.description || '';
    const visibility = meta.visibility?.type || 'public';
    const delegates = meta.delegates?.length || 0;
    const seeding = meta.seeding || 0;

    projectName = name;

    // Update page header
    document.querySelector('.header-text h1').textContent = name;

    let html = `
      <h2>${escapeHtml(name)}</h2>
      ${desc ? `<p class="description">${escapeHtml(desc)}</p>` : ''}
      <div class="repo-meta">
        <div class="repo-meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span class="value">${seeding} seeders</span>
        </div>
        <div class="repo-meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
          </svg>
          <span class="value">${delegates} delegate${delegates !== 1 ? 's' : ''}</span>
        </div>
        <div class="repo-meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
          <span class="value">${visibility}</span>
        </div>
      </div>
      ${usedCliFallback ? '<div class="metadata-notice">Metadata loaded via CLI fallback (httpd issue)</div>' : ''}
    `;
    repoHeaderEl.innerHTML = html;
  }

  function renderStats(stats) {
    if (!stats) {
      statsBarEl.classList.add('hidden');
      return;
    }
    statsBarEl.classList.remove('hidden');
    statsBarEl.innerHTML = `
      <div class="stat-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="4"/>
          <line x1="1.05" y1="12" x2="7" y2="12"/>
          <line x1="17.01" y1="12" x2="22.96" y2="12"/>
        </svg>
        <strong>${formatNumber(stats.commits || 0)}</strong> commits
      </div>
      <div class="stat-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="6" y1="3" x2="6" y2="15"/>
          <circle cx="18" cy="6" r="3"/>
          <circle cx="6" cy="18" r="3"/>
          <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
        <strong>${formatNumber(stats.branches || 0)}</strong> branch${(stats.branches || 0) !== 1 ? 'es' : ''}
      </div>
      <div class="stat-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <strong>${formatNumber(stats.contributors || 0)}</strong> contributors
      </div>
    `;
  }

  function renderBreadcrumb(currentPath) {
    if (!currentPath) {
      breadcrumbEl.innerHTML = '';
      return;
    }

    const parts = currentPath.split('/').filter(Boolean);
    let html = '<nav class="breadcrumb">';
    html += `<a href="#" data-nav="root">${escapeHtml(projectName)}</a>`;

    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      html += '<span class="separator">/</span>';
      accumulated += (accumulated ? '/' : '') + parts[i];
      if (i === parts.length - 1) {
        html += `<span class="current">${escapeHtml(parts[i])}</span>`;
      } else {
        html += `<a href="#" data-nav="tree" data-path="${escapeHtml(accumulated)}">${escapeHtml(parts[i])}</a>`;
      }
    }

    html += '</nav>';
    breadcrumbEl.innerHTML = html;

    // Bind click handlers
    breadcrumbEl.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const nav = a.dataset.nav;
        if (nav === 'root') {
          navigate('');
        } else if (nav === 'tree') {
          navigate('tree/' + a.dataset.path);
        }
      });
    });
  }

  function renderLastCommit(commit) {
    if (!commit) {
      lastCommitEl.classList.add('hidden');
      return;
    }
    lastCommitEl.classList.remove('hidden');
    lastCommitEl.className = 'last-commit';

    const author = commit.author?.name || commit.committer?.name || 'Unknown';
    const summary = commit.summary || '';
    const sha = (commit.id || '').slice(0, 7);
    const time = commit.committer?.time ? timeAgo(commit.committer.time) : '';

    lastCommitEl.innerHTML = `
      <span class="commit-author">${escapeHtml(author)}</span>
      <span class="commit-message">${escapeHtml(summary)}</span>
      ${sha ? `<span class="commit-sha">${sha}</span>` : ''}
      ${time ? `<span class="commit-time">${time}</span>` : ''}
    `;
  }

  function renderTree(tree) {
    const entries = sortEntries(tree.entries || []);
    if (entries.length === 0) {
      fileTreeEl.innerHTML = '<div class="empty-state"><p>Empty directory</p></div>';
      return;
    }

    const hasCommitHeader = !lastCommitEl.classList.contains('hidden');
    let html = `<div class="file-tree${hasCommitHeader ? '' : ' no-commit-header'}">`;

    for (const entry of entries) {
      const isDir = entry.kind === 'tree';
      const isSub = entry.kind === 'submodule';
      let icon, iconClass, nameClass;

      if (isDir) {
        icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
        iconClass = 'folder';
        nameClass = 'name folder-name';
      } else if (isSub) {
        icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
        iconClass = 'submodule';
        nameClass = 'name';
      } else {
        icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
        iconClass = 'file';
        nameClass = 'name';
      }

      const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      const navType = (isDir || isSub) ? 'tree' : 'blob';

      html += `
        <div class="file-tree-row" data-nav="${navType}" data-path="${escapeHtml(entryPath)}">
          <span class="icon ${iconClass}">${icon}</span>
          <span class="${nameClass}">${escapeHtml(entry.name)}</span>
        </div>
      `;
    }

    html += '</div>';
    fileTreeEl.innerHTML = html;

    // Bind click handlers
    fileTreeEl.querySelectorAll('.file-tree-row').forEach(row => {
      row.addEventListener('click', () => {
        const nav = row.dataset.nav;
        const path = row.dataset.path;
        navigate(nav + '/' + path);
      });
    });
  }

  function renderReadme(blob) {
    if (!blob || !blob.content) {
      readmeEl.innerHTML = '';
      return;
    }

    // Configure marked with highlight.js
    const renderer = new marked.Renderer();
    renderer.code = function({ text, lang }) {
      let highlighted;
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(text, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(text).value;
      }
      return `<pre><code class="hljs">${highlighted}</code></pre>`;
    };

    marked.setOptions({
      renderer: renderer,
      gfm: true,
      breaks: false,
    });

    const rawHtml = marked.parse(blob.content);
    const cleanHtml = DOMPurify.sanitize(rawHtml);

    readmeEl.innerHTML = `
      <div class="readme-section">
        <div class="readme-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
          ${escapeHtml(blob.name || 'README.md')}
        </div>
        <div class="readme-body">
          <div class="markdown-body">${cleanHtml}</div>
        </div>
      </div>
    `;

    // Intercept link clicks to navigate within the repo
    // Use a flag to ensure we only add the listener once
    if (!readmeEl._hasLinkHandler) {
      readmeEl.addEventListener('click', handleMarkdownLinkClick);
      readmeEl._hasLinkHandler = true;
    }
  }

  function renderBlob(blob) {
    if (!blob) {
      fileViewerEl.innerHTML = '<div class="empty-state"><p>Could not load file</p></div>';
      return;
    }

    if (blob.binary) {
      fileViewerEl.innerHTML = `
        <div class="file-viewer">
          <div class="file-viewer-header">
            <div class="file-info">
              <span>${escapeHtml(blob.name || '')}</span>
            </div>
          </div>
          <div class="file-viewer-binary">
            Binary file not shown.
          </div>
        </div>
      `;
      return;
    }

    const content = blob.content || '';
    const lines = content.split('\n');
    // Remove trailing empty line from split
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const lineCount = lines.length;
    const byteSize = new TextEncoder().encode(content).length;
    const lang = getLanguage(blob.name || '');

    let html = `
      <div class="file-viewer">
        <div class="file-viewer-header">
          <div class="file-info">
            <span>${escapeHtml(blob.name || '')}</span>
            <span>${lineCount} line${lineCount !== 1 ? 's' : ''}</span>
            <span>${formatBytes(byteSize)}</span>
          </div>
        </div>
    `;

    // For large files, skip highlighting
    if (byteSize > 100 * 1024) {
      html += `<div class="file-viewer-plain">${escapeHtml(content)}</div>`;
    } else {
      let highlighted;
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(content, { language: lang }).value;
      } else {
        highlighted = hljs.highlightAuto(content).value;
      }

      // Split highlighted content by lines
      const highlightedLines = highlighted.split('\n');
      // Remove trailing empty from split
      if (highlightedLines.length > 0 && highlightedLines[highlightedLines.length - 1] === '') {
        highlightedLines.pop();
      }

      html += '<div class="file-viewer-content"><table>';
      for (let i = 0; i < highlightedLines.length; i++) {
        html += `<tr><td class="line-number">${i + 1}</td><td class="line-code">${highlightedLines[i] || ' '}</td></tr>`;
      }
      html += '</table></div>';
    }

    html += '</div>';
    fileViewerEl.innerHTML = html;
  }

  function renderFileHeader(blob) {
    // File header info is now part of renderBlob
  }

  // =============================================
  // NAVIGATION / ROUTING
  // =============================================

  async function navigate(newPath) {
    // Parse the path: "" = root, "tree/src/lib" = dir, "blob/src/main.rs" = file
    let viewType, viewPath;

    if (!newPath || newPath === '') {
      viewType = 'root';
      viewPath = '';
    } else if (newPath.startsWith('tree/')) {
      viewType = 'tree';
      viewPath = newPath.slice(5); // Remove "tree/"
    } else if (newPath.startsWith('blob/')) {
      viewType = 'blob';
      viewPath = newPath.slice(5); // Remove "blob/"
    } else {
      viewType = 'root';
      viewPath = '';
    }

    // Update URL
    const url = new URL(window.location);
    if (newPath) {
      url.searchParams.set('path', newPath);
    } else {
      url.searchParams.delete('path');
    }
    history.pushState({ path: newPath }, '', url);

    await renderView(viewType, viewPath);
  }

  async function renderView(viewType, viewPath) {
    currentView = viewType;
    currentPath = viewPath;

    // Clear containers
    fileTreeEl.innerHTML = '';
    fileViewerEl.innerHTML = '';
    readmeEl.innerHTML = '';
    lastCommitEl.classList.add('hidden');

    if (viewType === 'root') {
      // Root view: stats + tree + readme
      renderBreadcrumb('');
      statsBarEl.classList.remove('hidden');

      try {
        // Show loading indicator in tree area
        fileTreeEl.innerHTML = '<div class="loading-inline"><div class="spinner"></div><span>Loading files...</span></div>';

        const [tree, readme] = await Promise.all([
          fetchTree(headSha, ''),
          fetchReadme(headSha),
        ]);

        renderLastCommit(tree.lastCommit);
        renderTree(tree);
        renderReadme(readme);
      } catch (err) {
        console.error('Error loading root view:', err);
        fileTreeEl.innerHTML = '<div class="empty-state"><p>Failed to load file tree</p></div>';
      }

    } else if (viewType === 'tree') {
      // Subdirectory view
      renderBreadcrumb(viewPath);
      statsBarEl.classList.add('hidden');

      try {
        fileTreeEl.innerHTML = '<div class="loading-inline"><div class="spinner"></div><span>Loading files...</span></div>';

        const tree = await fetchTree(headSha, viewPath);
        renderLastCommit(tree.lastCommit);
        renderTree(tree);
      } catch (err) {
        console.error('Error loading tree:', err);
        fileTreeEl.innerHTML = '<div class="empty-state"><p>Failed to load directory</p></div>';
      }

    } else if (viewType === 'blob') {
      // File view
      renderBreadcrumb(viewPath);
      statsBarEl.classList.add('hidden');

      try {
        fileViewerEl.innerHTML = '<div class="loading-inline"><div class="spinner"></div><span>Loading file...</span></div>';

        const blob = await fetchBlob(headSha, viewPath);
        renderBlob(blob);
      } catch (err) {
        console.error('Error loading blob:', err);
        fileViewerEl.innerHTML = '<div class="empty-state"><p>Failed to load file</p></div>';
      }
    }
  }

  // Handle browser back/forward
  window.addEventListener('popstate', (e) => {
    if (!repoMeta) return; // Not in code browser mode
    const state = e.state;
    const path = state?.path || '';
    let viewType, viewPath;

    if (!path) {
      viewType = 'root';
      viewPath = '';
    } else if (path.startsWith('tree/')) {
      viewType = 'tree';
      viewPath = path.slice(5);
    } else if (path.startsWith('blob/')) {
      viewType = 'blob';
      viewPath = path.slice(5);
    } else {
      viewType = 'root';
      viewPath = '';
    }

    renderView(viewType, viewPath);
  });

  // =============================================
  // ERROR STATE HELPERS (preserved from original)
  // =============================================

  function showState(state) {
    loadingState.classList.add('hidden');
    errorState.classList.add('hidden');
    successState.classList.add('hidden');
    connectionError.classList.add('hidden');
    invalidRidError.classList.add('hidden');

    if (state === 'loading') loadingState.classList.remove('hidden');
    else if (state === 'error') errorState.classList.remove('hidden');
    else if (state === 'success') successState.classList.remove('hidden');
    else if (state === 'connection-error') connectionError.classList.remove('hidden');
    else if (state === 'invalid-rid') invalidRidError.classList.remove('hidden');
  }

  async function fetchAvailableRepos() {
    try {
      const res = await fetch(`${base}/api/v1/repos`);
      if (!res.ok) return [];
      return await res.json();
    } catch (e) {
      console.error('Failed to fetch repos:', e);
      return [];
    }
  }

  function renderRepoList(repos) {
    repoCount.textContent = repos.length;

    if (repos.length === 0) {
      repoList.innerHTML = '<div class="empty-state"><p>No repositories seeded yet</p></div>';
      return;
    }

    repoList.innerHTML = repos.map(repo => {
      const repoRid = (repo.rid || '').replace('rad:', '');
      const shortRid = repoRid.slice(0, 12) + '...';
      const repoData = repo.payloads?.['xyz.radicle.project']?.data || {};
      const name = repoData.name || repo.name || 'Unnamed';
      const desc = repoData.description || repo.description || 'No description';
      return `
        <div class="repo-item" data-rid="${repoRid}">
          <div class="repo-item-header">
            <span class="repo-item-name">${escapeHtml(name)}</span>
            <span class="repo-item-rid">${shortRid}</span>
          </div>
          <div class="repo-item-desc">${escapeHtml(desc)}</div>
        </div>
      `;
    }).join('');

    repoList.querySelectorAll('.repo-item').forEach(item => {
      item.addEventListener('click', () => {
        const itemRid = item.dataset.rid;
        window.location.href = `rad-browser.html?rid=${itemRid}&base=${encodeURIComponent(base)}`;
      });
    });
  }

  async function fetchNetworkRepos() {
    try {
      const res = await fetch(`${PUBLIC_SEED}/api/v1/repos?show=all`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) return [];
      const repos = await res.json();
      return repos.sort((a, b) => (b.seeding || 0) - (a.seeding || 0));
    } catch (e) {
      console.error('Failed to fetch network repos:', e);
      return [];
    }
  }

  function renderNetworkRepoList(repos) {
    networkCount.textContent = repos.length;

    if (repos.length === 0) {
      networkList.innerHTML = '<div class="empty-state"><p>Could not load network repositories</p></div>';
      return;
    }

    const topRepos = repos.slice(0, 20);

    networkList.innerHTML = topRepos.map(repo => {
      const repoData = repo.payloads?.['xyz.radicle.project']?.data || {};
      const name = repoData.name || 'Unnamed';
      const desc = repoData.description || 'No description';
      const repoRid = (repo.rid || '').replace('rad:', '');
      const shortRid = repoRid.slice(0, 12) + '...';
      const seeders = repo.seeding || 0;

      return `
        <div class="repo-item network" data-rid="${repoRid}">
          <div class="repo-item-header">
            <span class="repo-item-name">${escapeHtml(name)}</span>
            <span class="repo-item-rid">${shortRid}</span>
          </div>
          <div class="repo-item-desc">${escapeHtml(desc)}</div>
          <div class="repo-item-meta">
            <span class="seeders">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              ${seeders} seeders
            </span>
          </div>
        </div>
      `;
    }).join('');

    networkList.querySelectorAll('.repo-item').forEach(item => {
      item.addEventListener('click', () => {
        const itemRid = item.dataset.rid;
        window.location.href = `rad-browser.html?rid=${itemRid}&base=${encodeURIComponent(base)}`;
      });
    });
  }

  async function seedRepository() {
    if (!rid) return;

    seedBtn.disabled = true;
    seedStatus.className = 'seed-status show seeding';
    seedStatus.textContent = 'Seeding repository... This may take a moment.';

    try {
      if (window.freedomAPI?.seedRadicle) {
        const result = await window.freedomAPI.seedRadicle(rid);
        if (result.success) {
          seedStatus.className = 'seed-status show success';
          seedStatus.textContent = 'Repository seeded successfully! Reloading...';
          setTimeout(() => window.location.reload(), 1500);
        } else {
          throw new Error(result.error || 'Unknown error');
        }
      } else {
        throw new Error('Freedom API not available');
      }
    } catch (err) {
      seedBtn.disabled = false;
      seedStatus.className = 'seed-status show error';
      seedStatus.textContent = `Failed to seed: ${err.message}`;
    }
  }

  // =============================================
  // MAIN INIT
  // =============================================

  async function init() {
    // Handle invalid RID error (passed from navigation.js)
    if (params.get('error') === 'invalid-rid') {
      const input = params.get('input') || '';
      displayRid.textContent = input ? `rad://${input}` : 'rad://...';
      invalidRidInput.textContent = input || '(empty)';
      showState('invalid-rid');
      return;
    }

    if (!rid) {
      showState('error');
      errorRid.textContent = 'No RID provided';
      return;
    }

    errorRid.textContent = `rad://${rid}`;

    // If navigation.js passed status=offline, verify the actual node status
    // This handles the case where user activates the node and then refreshes
    if (params.get('status') === 'offline') {
      try {
        const status = await window.freedomAPI?.getRadicleStatus?.();
        if (status?.status !== 'running') {
          // Node is still not running, show error immediately
          showState('connection-error');
          return;
        }
        // Node is now running, continue with normal flow
      } catch {
        // Couldn't check status, show error
        showState('connection-error');
        return;
      }
    }

    try {
      // First, check if we can connect to the node
      const nodeRes = await fetch(`${base}/`, {
        signal: AbortSignal.timeout(3000)
      }).catch(() => null);

      if (!nodeRes || !nodeRes.ok) {
        showState('connection-error');
        return;
      }

      // Fetch repo metadata
      const meta = await fetchRepoMeta();

      if (!meta) {
        // 404 — repository not found
        showState('error');
        const repos = await fetchAvailableRepos();
        renderRepoList(repos);
        seedBtn.addEventListener('click', seedRepository);
        fetchNetworkRepos().then(renderNetworkRepoList);
        return;
      }

      // Success — we have the repo
      repoMeta = meta;
      let cliPayload = null;
      const httpProject = meta.payloads?.['xyz.radicle.project'];
      headSha = httpProject?.meta?.head;
      let defaultBranch = httpProject?.data?.defaultBranch;

      // Fallback: if HTTP API is missing project payload, try CLI
      if (!httpProject) {
        cliPayload = await fetchPayloadViaCli();
        if (cliPayload?.['xyz.radicle.project']) {
          usedCliFallback = true;
          const cliProject = cliPayload['xyz.radicle.project'];
          defaultBranch = defaultBranch || cliProject.defaultBranch;
        }
      }

      // Fallback: if no head SHA from project payload, try to get it from remotes
      if (!headSha) {
        const remotes = await fetchRemotes();
        const headInfo = getHeadFromRemotes(remotes, defaultBranch);
        if (headInfo) {
          headSha = headInfo.sha;
          defaultBranch = headInfo.branch;
        }
      }

      if (!headSha) {
        // Still no head SHA — can't browse files
        showState('success');
        renderRepoHeader(meta, cliPayload);
        repoHeaderEl.insertAdjacentHTML('beforeend',
          '<div class="empty-state" style="margin-top:24px"><p>No commit history found for this repository.</p></div>');
        return;
      }

      showState('success');
      renderRepoHeader(meta, cliPayload);

      // Fetch stats in background
      fetchStats(headSha).then(renderStats);

      // Check if we have a path from URL (for back/forward or direct link)
      const urlPath = params.get('path') || '';

      // Set initial state in history
      if (!history.state) {
        history.replaceState({ path: urlPath }, '');
      }

      // Route to the right view
      let viewType = 'root';
      let viewPath = '';

      if (urlPath.startsWith('tree/')) {
        viewType = 'tree';
        viewPath = urlPath.slice(5);
      } else if (urlPath.startsWith('blob/')) {
        viewType = 'blob';
        viewPath = urlPath.slice(5);
      }

      await renderView(viewType, viewPath);

    } catch (err) {
      console.error('Error fetching repo:', err);
      if (err.name === 'TimeoutError' || err.message.includes('fetch')) {
        showState('connection-error');
      } else {
        showState('error');
        const repos = await fetchAvailableRepos();
        renderRepoList(repos);
        seedBtn.addEventListener('click', seedRepository);
        fetchNetworkRepos().then(renderNetworkRepoList);
      }
    }
  }

  init();
// Paste JS here (everything between <script> and </script>)
