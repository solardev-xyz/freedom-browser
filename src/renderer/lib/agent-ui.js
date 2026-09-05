import { isPrivateWindow } from './private-mode.js';
import { homeUrl } from './page-urls.js';
import { close as closeWalletSidebar, isVisible as isWalletSidebarVisible } from './sidebar.js';
import { isSignatureInFlight, onSignatureFlightChange } from './wallet/signature-flight.js';

const PROVIDER_NAMES = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'ChatGPT (Codex)',
  openrouter: 'OpenRouter',
  freepi: 'Free Pi',
  ollama: 'Ollama',
});
const APPROVAL_MODES = Object.freeze({
  EVERY_INTERACTION: 'every_interaction',
  SENSITIVE_ACTIONS: 'sensitive_actions',
  ALLOW_WEBSITE_INTERACTIONS: 'allow_website_interactions',
});
const APPROVAL_MODE_LABELS = Object.freeze({
  [APPROVAL_MODES.EVERY_INTERACTION]: 'Ask every action',
  [APPROVAL_MODES.SENSITIVE_ACTIONS]: 'Ask when needed',
  [APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS]: 'Allow website actions',
});
const PANE_RESIZE_CONFIG = Object.freeze({
  session: Object.freeze({
    cssProperty: '--agent-session-sidebar-width',
    defaultWidth: 242,
    minWidth: 190,
    maxWidth: 520,
  }),
  workspace: Object.freeze({
    cssProperty: '--agent-workspace-sidebar-width',
    defaultWidth: 420,
    minWidth: 300,
    maxWidth: 760,
  }),
});
const CODE_ATTACHMENT_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'css',
  'go',
  'graphql',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'jsx',
  'mjs',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'ts',
  'tsx',
  'xml',
]);
const ATTACHMENT_ICON_MARKUP = Object.freeze({
  folder:
    '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3.75 9.5h9l2.5 3h13v11.75a2.5 2.5 0 0 1-2.5 2.5h-19a2.5 2.5 0 0 1-2.5-2.5V8a2.5 2.5 0 0 1 2.5-2.5h5.5l2.5 4"/></svg>',
  image:
    '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="5" width="24" height="22" rx="3"/><circle cx="11.25" cy="12" r="2.25"/><path d="m6.5 24 7-7 4.25 4.25 3-3L27 24.5"/></svg>',
  pdf: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 3.75h10l6 6v18.5H8z"/><path d="M18 3.75v6h6M11.5 21.5h9M11.5 17h9"/></svg>',
  code: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="m12.25 9-7 7 7 7M19.75 9l7 7-7 7M18 5.5l-4 21"/></svg>',
  text: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 3.75h10l6 6v18.5H8z"/><path d="M18 3.75v6h6M11.5 15.5h9M11.5 20h9M11.5 24.5h6"/></svg>',
  file: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 3.75h10l6 6v18.5H8z"/><path d="M18 3.75v6h6"/></svg>',
});

let elements = {};
let getActiveTab = () => null;
let getOpenTabs = () => [];
let isTabAgentOwned = () => false;
let switchToTab = () => {};
let setAgentControlledTab = () => {};
let setAgentTabCustody = () => {};
let setAgentTabClaimHandler = () => {};
let setTabStripProjection = () => {};
let setWorkspaceNavigationProjection = () => {};
let setWorkspaceNavigationEditable = () => {};
let providerCatalog = [];
let providerCatalogPromise = null;
let providerStatus = null;
let providerReady = false;
let providerLoginPending = false;
let currentConversationId = null;
let conversationRendererTabId = null;
let dismissedPageContextTabId = null;
let pendingPromptText = '';
let currentRunId = null;
let currentRunStatus = 'idle';
let pendingAttachments = [];
let conversationResources = [];
let lastFinishedRunId = null;
let stopRequestedRunId = null;
let pendingApproval = null;
let panelOpen = false;
let agentView = 'loading';
let approvalMode = APPROVAL_MODES.EVERY_INTERACTION;
let approvalModeMutationPending = false;
let agentEventUnsubscribe = null;
let providerAuthEventUnsubscribe = null;
let tabPresentationUnsubscribe = null;
let openTabs = [];
let taskTabProjection = [];
let workspaceProjectionGeneration = 0;
let agentFirstMode = false;
let sessionSidebarOpen = true;
let workspaceSidebarOpen = true;
let conversationTitle = 'New task';
let sessionHistory = [];
let sessionHistoryLoading = false;
const paneWidths = { session: null, workspace: null };
const toolRows = new Map();
const attachmentDisplayRows = new Map();
const turnViews = new Map();
const guidanceViews = new Map();
const attachmentPreviewLoaders = new WeakMap();
let attachmentPreviewObserver = null;

function byId(id) {
  return document.getElementById(id);
}

function responseMessage(response, fallback) {
  return typeof response?.error?.message === 'string' && response.error.message
    ? response.error.message
    : fallback;
}

function setMessage(element, message = '', isError = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function providerName(providerId) {
  return PROVIDER_NAMES[providerId] || providerId || 'Model';
}

function isShareablePage(tab) {
  if (!Number.isSafeInteger(tab?.id) || tab.id < 1 || typeof tab.url !== 'string') return false;
  if (
    tab.url === homeUrl ||
    tab.url === 'freedom://home' ||
    (tab.url.startsWith('file:') && tab.url.endsWith('/pages/home.html'))
  ) {
    return false;
  }
  try {
    return ['http:', 'https:', 'bzz:', 'ipfs:', 'ipns:'].includes(new URL(tab.url).protocol);
  } catch {
    return false;
  }
}

function pageContextTab() {
  if (currentConversationId) {
    return openTabs.find((tab) => tab.id === conversationRendererTabId) || null;
  }
  const tab = getActiveTab();
  if (!isShareablePage(tab) || isTabAgentOwned(tab.id) || dismissedPageContextTabId === tab.id) {
    return null;
  }
  return tab;
}

function pageContextLabel(tab) {
  let pageName = tab?.title && tab.title !== 'New Tab' ? tab.title : '';
  if (!pageName) {
    try {
      pageName = new URL(tab.url).hostname;
    } catch {
      pageName = 'Current page';
    }
  }
  return `Current page · ${pageName}`;
}

function renderPageContext() {
  const tab = pageContextTab();
  elements.pageContext.hidden = !tab;
  renderAttachmentContexts();
  elements.pageContexts.hidden = !tab && pendingAttachments.length === 0 && !hasFolderResources();
  if (!tab) return;
  const label = pageContextLabel(tab);
  elements.pageContextLabel.textContent = label;
  elements.pageContext.disabled = Boolean(currentConversationId) || currentRunStatus !== 'idle';
  elements.pageContext.setAttribute(
    'aria-label',
    currentConversationId
      ? `Page shared with this conversation: ${label}`
      : `Remove ${label} from this conversation`
  );
  elements.pageContext.title = currentConversationId
    ? 'Shared with this conversation'
    : 'Remove current page';
}

function formatAttachmentBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KB`;
  return `${(value / 1_048_576).toFixed(value < 10_485_760 ? 1 : 0)} MB`;
}

function hasFolderResources() {
  return conversationResources.some((resource) => resource?.kind === 'folder');
}

function attachmentLabel(resource) {
  if (resource.kind === 'folder') {
    return `${resource.name || 'Folder'} · ${resource.available === false ? 're-add after restart' : 'read only'}`;
  }
  return `${resource.name || 'Attachment'}${Number.isSafeInteger(resource.bytes) ? ` · ${formatAttachmentBytes(resource.bytes)}` : ''}`;
}

function attachmentExtension(resource) {
  const name = typeof resource?.name === 'string' ? resource.name : '';
  const index = name.lastIndexOf('.');
  return index > -1 && index < name.length - 1 ? name.slice(index + 1).toLowerCase() : '';
}

function attachmentPresentation(resource) {
  if (resource?.kind === 'folder') {
    return { kind: 'folder', badge: 'Folder' };
  }
  const extension = attachmentExtension(resource);
  if (resource?.category === 'pdf' || extension === 'pdf') {
    return { kind: 'pdf', badge: 'PDF' };
  }
  if (resource?.category === 'image') {
    return { kind: 'image', badge: extension ? extension.toUpperCase() : 'Image' };
  }
  if (CODE_ATTACHMENT_EXTENSIONS.has(extension)) {
    return { kind: 'code', badge: extension.toUpperCase() };
  }
  if (resource?.category === 'text') {
    return { kind: 'text', badge: extension ? extension.toUpperCase() : 'Text' };
  }
  return { kind: 'file', badge: extension ? extension.toUpperCase() : 'File' };
}

function createMessageAttachment(resource) {
  const presentation = attachmentPresentation(resource);
  const name = resource?.name || (resource?.kind === 'folder' ? 'Folder' : 'Attachment');
  const tile = document.createElement('div');
  tile.className = 'agent-message-attachment';
  tile.dataset.kind = presentation.kind;
  tile.setAttribute('role', 'listitem');
  tile.setAttribute('aria-label', attachmentLabel(resource));
  tile.title = attachmentLabel(resource);

  const visual = document.createElement('span');
  visual.className = 'agent-message-attachment-visual';
  const icon = document.createElement('span');
  icon.className = 'agent-message-attachment-icon';
  icon.innerHTML = ATTACHMENT_ICON_MARKUP[presentation.kind] || ATTACHMENT_ICON_MARKUP.file;
  const badge = document.createElement('span');
  badge.className = 'agent-message-attachment-badge';
  badge.textContent = presentation.badge;
  visual.appendChild(icon);
  visual.appendChild(badge);

  const filename = document.createElement('span');
  filename.className = 'agent-message-attachment-name';
  filename.textContent = name;
  tile.appendChild(visual);
  tile.appendChild(filename);
  return tile;
}

async function loadMessageAttachmentPreview(tile, resource, conversationId) {
  if (
    !conversationId ||
    currentConversationId !== conversationId ||
    typeof window.electronAPI.getAgentAttachmentPreview !== 'function'
  ) {
    return;
  }
  try {
    const response = await window.electronAPI.getAgentAttachmentPreview(
      conversationId,
      resource.resourceId
    );
    const preview = response?.preview;
    if (
      !response?.ok ||
      currentConversationId !== conversationId ||
      !tile.parentNode ||
      typeof preview?.dataUrl !== 'string' ||
      !preview.dataUrl.startsWith('data:image/png;base64,') ||
      preview.dataUrl.length > 400_000 ||
      !Number.isSafeInteger(preview.width) ||
      !Number.isSafeInteger(preview.height) ||
      preview.width < 1 ||
      preview.height < 1 ||
      preview.width > 192 ||
      preview.height > 192
    ) {
      return;
    }
    const visual = tile.querySelector('.agent-message-attachment-visual');
    if (!visual) return;
    const image = document.createElement('img');
    image.className = 'agent-message-attachment-preview';
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    image.addEventListener('load', () => visual.classList.add('has-preview'), { once: true });
    image.addEventListener(
      'error',
      () => {
        visual.classList.remove('has-preview');
        image.remove();
      },
      { once: true }
    );
    image.src = preview.dataUrl;
    visual.appendChild(image);
  } catch {
    // The type-aware icon is the intentional fallback for unavailable previews.
  }
}

function queueMessageAttachmentPreview(tile, resource) {
  if (
    !['image', 'pdf'].includes(resource?.category) ||
    typeof resource.resourceId !== 'string' ||
    !currentConversationId
  ) {
    return;
  }
  const conversationId = currentConversationId;
  const load = () => loadMessageAttachmentPreview(tile, resource, conversationId);
  if (typeof window.IntersectionObserver !== 'function') {
    void load();
    return;
  }
  if (!attachmentPreviewObserver) {
    attachmentPreviewObserver = new window.IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const loader = attachmentPreviewLoaders.get(entry.target);
        attachmentPreviewLoaders.delete(entry.target);
        if (loader) void loader();
      }
    });
  }
  attachmentPreviewLoaders.set(tile, load);
  attachmentPreviewObserver.observe(tile);
}

function renderAttachmentContexts() {
  const chips = [];
  for (const resource of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'agent-attachment-chip';
    chip.dataset.selectionId = resource.selectionId;
    const label = document.createElement('span');
    label.textContent = attachmentLabel(resource);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${resource.name || 'attachment'}`);
    remove.addEventListener('click', () => removePendingAttachment(resource.selectionId));
    chip.appendChild(label);
    chip.appendChild(remove);
    chips.push(chip);
  }
  for (const resource of conversationResources.filter((item) => item?.kind === 'folder')) {
    const chip = document.createElement('div');
    chip.className = 'agent-attachment-chip conversation-resource';
    const label = document.createElement('span');
    label.textContent = attachmentLabel(resource);
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.textContent = '×';
    revoke.title = 'Stop sharing this folder';
    revoke.setAttribute('aria-label', `Stop sharing ${resource.name || 'folder'}`);
    revoke.addEventListener('click', () => revokeConversationFolder(resource));
    chip.appendChild(label);
    chip.appendChild(revoke);
    chips.push(chip);
  }
  elements.attachmentContexts.replaceChildren(...chips);
}

async function addAttachments(kind) {
  if (currentRunStatus !== 'idle') return;
  closeComposerPopovers();
  setMessage(elements.runMessage, kind === 'folder' ? 'Choose a folder…' : 'Choose files…');
  try {
    const response =
      kind === 'folder'
        ? await window.electronAPI.pickAgentFolder()
        : await window.electronAPI.pickAgentFiles();
    if (!response?.ok) {
      setMessage(elements.runMessage, responseMessage(response, 'Could not add attachment'), true);
      return;
    }
    for (const selection of Array.isArray(response.selections) ? response.selections : []) {
      if (!pendingAttachments.some((item) => item.selectionId === selection.selectionId)) {
        pendingAttachments.push(selection);
      }
    }
    setMessage(elements.runMessage);
    renderPageContext();
    focusComposer();
  } catch {
    setMessage(elements.runMessage, 'Could not add attachment', true);
  }
}

async function removePendingAttachment(selectionId) {
  if (!pendingAttachments.some((item) => item.selectionId === selectionId)) return;
  try {
    const response = await window.electronAPI.removeAgentAttachment(selectionId);
    if (!response?.ok) {
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not remove attachment'),
        true
      );
      return;
    }
    pendingAttachments = pendingAttachments.filter((item) => item.selectionId !== selectionId);
    renderPageContext();
  } catch {
    setMessage(elements.runMessage, 'Could not remove attachment', true);
  }
}

async function revokeConversationFolder(resource) {
  if (
    !currentConversationId ||
    resource?.kind !== 'folder' ||
    typeof resource.resourceId !== 'string'
  ) {
    return;
  }
  try {
    const response = await window.electronAPI.revokeAgentAttachment(
      currentConversationId,
      resource.resourceId
    );
    if (!response?.ok) {
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not stop sharing folder'),
        true
      );
      return;
    }
    conversationResources = Array.isArray(response.resources)
      ? response.resources
      : conversationResources.filter((item) => item.resourceId !== resource.resourceId);
    renderPageContext();
    setMessage(
      elements.runMessage,
      `Stopped sharing “${resource.name || 'folder'}”. Agent cannot start new reads from it; content already read remains in this conversation.`
    );
  } catch {
    setMessage(elements.runMessage, 'Could not stop sharing folder', true);
  }
}

function providerPrivacyMessage(providerId) {
  if (providerId === 'ollama') {
    return 'Model requests stay on this device and are sent only to your local Ollama server.';
  }
  if (providerId === 'openai-codex') {
    return 'Your task and page content the agent reads may be sent to OpenAI through your ChatGPT subscription. Avoid using Agent on pages containing sensitive information.';
  }
  return `Your task and page content the agent reads may be sent to ${providerName(providerId)}. Avoid using Agent on pages containing sensitive information.`;
}

function providerAuthType(providerId) {
  return (
    providerCatalog.find((candidate) => candidate.providerId === providerId)?.authType ||
    (providerId === 'openai-codex' ? 'subscription' : 'api_key')
  );
}

function providerConnections() {
  if (Array.isArray(providerStatus?.connections)) return providerStatus.connections;
  if (!providerStatus?.configured) return [];
  return [
    {
      kind: providerStatus.kind,
      providerId: providerStatus.providerId,
      modelId: providerStatus.modelId,
      ...(providerStatus.kind === 'ollama' && {
        baseUrl: providerStatus.baseUrl,
        modelIds: [providerStatus.modelId],
      }),
    },
  ];
}

function providerConnection(providerId) {
  return providerConnections().find((connection) => connection.providerId === providerId);
}

function catalogModel(providerId, modelId) {
  return providerCatalog
    .find((provider) => provider.providerId === providerId)
    ?.models?.find((model) => model.id === modelId);
}

function modelName(providerId, modelId) {
  return catalogModel(providerId, modelId)?.name || modelId || 'Model';
}

function configuredModels() {
  return providerConnections().flatMap((connection) => {
    const models =
      connection.kind === 'ollama'
        ? (connection.modelIds || [connection.modelId]).map((modelId) => ({
            id: modelId,
            name: modelId,
          }))
        : providerCatalog.find((provider) => provider.providerId === connection.providerId)
            ?.models || [{ id: connection.modelId, name: connection.modelId }];
    return models.map((model) => ({
      providerId: connection.providerId,
      modelId: model.id,
      name: model.name || model.id,
    }));
  });
}

function closeComposerPopovers() {
  elements.modelMenu.hidden = true;
  elements.approvalModePopover.hidden = true;
  elements.attachmentMenu.hidden = true;
  elements.modelMenuButton.setAttribute('aria-expanded', 'false');
  elements.approvalModeButton.setAttribute('aria-expanded', 'false');
  elements.attachmentButton.setAttribute('aria-expanded', 'false');
}

function setApprovalMode(nextMode, options = {}) {
  if (
    !Object.hasOwn(APPROVAL_MODE_LABELS, nextMode) ||
    (!options.force && currentRunStatus !== 'idle')
  ) {
    return;
  }
  approvalMode = nextMode;
  elements.activeApprovalModeLabel.textContent = APPROVAL_MODE_LABELS[nextMode];
  for (const [mode, element] of [
    [APPROVAL_MODES.EVERY_INTERACTION, elements.approvalModeEvery],
    [APPROVAL_MODES.SENSITIVE_ACTIONS, elements.approvalModeSensitive],
    [APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS, elements.approvalModeAllow],
  ]) {
    const active = nextMode === mode;
    element.classList.toggle('active', active);
    element.setAttribute('aria-pressed', String(active));
    element.querySelector('.agent-approval-mode-check').textContent = active ? '✓' : '';
  }
  closeComposerPopovers();
}

async function selectApprovalMode(nextMode) {
  if (
    approvalModeMutationPending ||
    currentRunStatus !== 'idle' ||
    !Object.hasOwn(APPROVAL_MODE_LABELS, nextMode)
  ) {
    return;
  }
  if (!currentConversationId) {
    setApprovalMode(nextMode);
    return;
  }
  if (nextMode === approvalMode) {
    closeComposerPopovers();
    return;
  }
  approvalModeMutationPending = true;
  elements.approvalModeButton.disabled = true;
  elements.attachmentButton.disabled = true;
  elements.newChat.disabled = true;
  updateSendAvailability();
  closeComposerPopovers();
  try {
    const response = await window.electronAPI.setAgentApprovalMode(currentConversationId, nextMode);
    if (!response?.ok) {
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not change the approval setting'),
        true
      );
      return;
    }
    setApprovalMode(response.approvalMode || nextMode, { force: true });
    setMessage(elements.runMessage, 'Approval setting updated for the next message.');
  } catch {
    setMessage(elements.runMessage, 'Could not change the approval setting', true);
  } finally {
    approvalModeMutationPending = false;
    elements.approvalModeButton.disabled = currentRunStatus !== 'idle';
    elements.attachmentButton.disabled = currentRunStatus !== 'idle' || Boolean(pendingApproval);
    elements.newChat.disabled = currentRunStatus !== 'idle';
    updateSendAvailability();
    focusComposer({ preserveExplicitFocus: true });
  }
}

function setAgentView(nextView) {
  if (nextView !== 'workspace' && agentFirstMode) setAgentFirstMode(false);
  agentView = nextView;
  elements.loadingView.hidden = nextView !== 'loading';
  elements.setupView.hidden = nextView !== 'setup';
  elements.workspaceView.hidden = nextView !== 'workspace';
  const setup = nextView === 'setup';
  const canReturn = setup && providerStatus?.configured === true;
  elements.back.hidden = !canReturn;
  elements.title.textContent = setup ? (canReturn ? 'Models' : 'Set up Agent') : 'Agent';
  elements.subtitle.textContent = setup
    ? canReturn
      ? 'Add or manage providers'
      : 'Connect a model to continue'
    : 'Give Agent a task';
  elements.agentFirstToggle.hidden = nextView !== 'workspace';
  closeComposerPopovers();
}

function titleFromPrompt(prompt) {
  const normalized = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'New task';
  return normalized.length > 64 ? `${normalized.slice(0, 63).trimEnd()}…` : normalized;
}

function setConversationTitle(nextTitle) {
  conversationTitle = titleFromPrompt(nextTitle);
  elements.agentFirstTitle.textContent = conversationTitle;
}

function renderSessionSidebar() {
  const rows = sessionHistory.map((session) => {
    const row = document.createElement('div');
    row.className = 'agent-session-row';
    row.dataset.conversationId = session.conversationId;
    const active = session.conversationId === currentConversationId;
    row.classList.toggle('active', active);

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'agent-session-select';
    select.disabled = currentRunStatus !== 'idle';
    select.setAttribute('aria-current', active ? 'page' : 'false');
    const title = document.createElement('span');
    title.textContent = session.title || 'Untitled session';
    const meta = document.createElement('small');
    const turnCount = Number.isSafeInteger(session.turnCount) ? session.turnCount : 0;
    meta.textContent = `${turnCount} ${turnCount === 1 ? 'turn' : 'turns'}${session.status === 'interrupted' ? ' · Interrupted' : ''}`;
    select.appendChild(title);
    select.appendChild(meta);
    select.addEventListener('click', () => openSavedSession(session.conversationId));

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'agent-session-more';
    more.textContent = '•••';
    more.title = 'Session options';
    more.setAttribute('aria-label', `Options for ${session.title || 'session'}`);
    more.setAttribute('aria-expanded', 'false');
    more.disabled = currentRunStatus !== 'idle';

    const actions = document.createElement('div');
    actions.className = 'agent-session-actions';
    actions.hidden = true;
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.textContent = 'Rename';
    rename.addEventListener('click', () => renameSavedSession(session));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => deleteSavedSession(session));
    actions.appendChild(rename);
    actions.appendChild(remove);
    more.addEventListener('click', () => {
      const nextOpen = actions.hidden;
      for (const menu of elements.sessionList.querySelectorAll('.agent-session-actions')) {
        menu.hidden = true;
      }
      actions.hidden = !nextOpen;
      more.setAttribute('aria-expanded', String(nextOpen));
    });

    row.appendChild(select);
    row.appendChild(more);
    row.appendChild(actions);
    return row;
  });
  elements.sessionList.replaceChildren(...rows);
  elements.sessionHistoryEmpty.hidden = sessionHistoryLoading || rows.length > 0;
  elements.sessionNewChat.disabled = currentRunStatus !== 'idle';
  elements.agentFirstTitle.textContent = conversationTitle;
}

async function refreshSessionHistory() {
  if (sessionHistoryLoading) return;
  sessionHistoryLoading = true;
  try {
    const response = await window.electronAPI.listAgentSessions();
    if (!response?.ok || !Array.isArray(response.sessions)) return;
    sessionHistory = response.sessions.filter(
      (session) =>
        typeof session?.conversationId === 'string' &&
        session.conversationId &&
        typeof session.title === 'string'
    );
  } catch {
    // Keep the last successfully loaded history projection.
  } finally {
    sessionHistoryLoading = false;
    renderSessionSidebar();
  }
}

function workspacePages() {
  const tabById = new Map(openTabs.map((tab) => [tab.id, tab]));
  const projected = taskTabProjection
    .map((entry) => ({ ...entry, tab: tabById.get(entry.rendererTabId) }))
    .filter((entry) => entry.tab);
  const activeTab = openTabs.find((tab) => tab.isActive);
  if (currentConversationId) return projected;
  return activeTab
    ? [{ rendererTabId: activeTab.id, agentActive: false, tab: activeTab, startsHere: true }]
    : [];
}

function ensureWorkspacePageVisible() {
  if (!agentFirstMode) return;
  const pages = workspacePages();
  if (!pages.length || pages.some((entry) => entry.tab.isActive)) return;
  const preferred = pages.find((entry) => entry.agentActive) || pages[0];
  switchToTab(preferred.rendererTabId);
}

function renderTaskPages() {
  if (!elements.taskPageList) return;
  const pages = workspacePages();
  if (agentFirstMode) {
    setTabStripProjection({
      container: elements.taskPageList,
      tabIds: pages.map((entry) => entry.rendererTabId),
    });
  }
  elements.taskPageCount.textContent = String(pages.length);
  elements.taskPagesEmpty.hidden = pages.length > 0;
  document.body.classList.toggle('agent-workspace-page-empty', pages.length === 0);
  elements.taskPagesNote.textContent = currentConversationId
    ? 'Only pages belonging to this conversation are shown.'
    : 'Agent will start from the page you are currently viewing.';
}

function activePageIsControlled() {
  if (!currentRunId || !['running', 'pausing', 'resuming', 'stopping'].includes(currentRunStatus)) {
    return false;
  }
  const activeTab = openTabs.find((tab) => tab.isActive) || getActiveTab();
  if (!Number.isSafeInteger(activeTab?.id)) return false;
  return (
    isTabAgentOwned(activeTab.id) ||
    activeTab.id === conversationRendererTabId ||
    taskTabProjection.some((entry) => entry.rendererTabId === activeTab.id)
  );
}

function setTakeoverDialogOpen(open) {
  const shouldOpen = open === true && activePageIsControlled() && currentRunStatus === 'running';
  elements.takeoverDialog.hidden = !shouldOpen;
  elements.pageInterlock.classList.toggle('dialog-open', shouldOpen);
  elements.pageLockHint.hidden = shouldOpen;
  elements.takeoverCancel.disabled = false;
  elements.takeoverConfirm.disabled = false;
  if (shouldOpen) elements.takeoverConfirm.focus();
}

function renderPageInterlock() {
  const locked = activePageIsControlled();
  elements.pageInterlock.hidden = !locked;
  elements.pageInterlock.setAttribute('aria-hidden', String(!locked));
  elements.pageLockHint.textContent =
    currentRunStatus === 'pausing'
      ? 'Taking over…'
      : currentRunStatus === 'stopping'
        ? 'Stopping Agent…'
        : 'Agent is controlling this page · Click to take over';
  if (!locked || currentRunStatus !== 'running') setTakeoverDialogOpen(false);
}

function requestTakeoverConfirmation(rendererTabId = null) {
  if (Number.isSafeInteger(rendererTabId) && getActiveTab()?.id !== rendererTabId) {
    switchToTab(rendererTabId);
  }
  renderPageInterlock();
  setTakeoverDialogOpen(true);
}

function applyWorkspaceProjection(state) {
  taskTabProjection = Array.isArray(state?.taskTabs)
    ? state.taskTabs.filter(
        (entry) =>
          Number.isSafeInteger(entry?.rendererTabId) &&
          entry.rendererTabId > 0 &&
          typeof entry.agentActive === 'boolean'
      )
    : [];
  setAgentTabCustody(Array.isArray(state?.agentTabs) ? state.agentTabs : []);
  renderTaskPages();
  ensureWorkspacePageVisible();
  renderPageInterlock();
}

async function refreshWorkspaceProjection() {
  const generation = workspaceProjectionGeneration;
  const expectedConversationId = currentConversationId;
  try {
    const response = await window.electronAPI.getAgentState();
    const state = response?.ok ? response.state : null;
    if (!state || generation !== workspaceProjectionGeneration) return;
    if (
      expectedConversationId !== currentConversationId ||
      (expectedConversationId
        ? state.conversationId !== expectedConversationId
        : Boolean(state.conversationId))
    ) {
      return;
    }
    applyWorkspaceProjection(state);
  } catch {
    // Keep the last trusted renderer projection when state refresh fails.
  }
}

function setAgentFirstMode(nextMode) {
  agentFirstMode = nextMode === true && panelOpen && agentView === 'workspace';
  if (agentFirstMode) {
    setWorkspaceNavigationProjection(elements.workspaceAddressHost);
  } else {
    setTabStripProjection();
    setWorkspaceNavigationProjection();
  }
  document.body.classList.toggle('agent-first-mode', agentFirstMode);
  document.body.classList.toggle('agent-session-sidebar-closed', !sessionSidebarOpen);
  document.body.classList.toggle('agent-workspace-sidebar-closed', !workspaceSidebarOpen);
  elements.taskPages.hidden = !agentFirstMode;
  elements.sessionSidebar.hidden = !agentFirstMode;
  elements.agentFirstTitlebar.hidden = !agentFirstMode;
  elements.agentFirstToggle.setAttribute('aria-pressed', String(agentFirstMode));
  elements.agentFirstToggle.setAttribute(
    'aria-label',
    agentFirstMode ? 'Return to browser view' : 'Make Agent the main view'
  );
  elements.agentFirstToggle.title = agentFirstMode ? 'Browser view' : 'Agent-first view';
  if (agentFirstMode) {
    openTabs = getOpenTabs();
    renderTaskPages();
    renderSessionSidebar();
    ensureWorkspacePageVisible();
    void refreshWorkspaceProjection();
    focusComposer();
  }
}

function setSessionSidebarOpen(nextOpen) {
  sessionSidebarOpen = nextOpen === true;
  document.body.classList.toggle('agent-session-sidebar-closed', !sessionSidebarOpen);
  elements.sessionSidebarToggle.setAttribute('aria-expanded', String(sessionSidebarOpen));
  elements.sessionSidebarToggle.setAttribute(
    'aria-label',
    sessionSidebarOpen ? 'Hide sessions sidebar' : 'Show sessions sidebar'
  );
}

function setWorkspaceSidebarOpen(nextOpen) {
  workspaceSidebarOpen = nextOpen === true;
  document.body.classList.toggle('agent-workspace-sidebar-closed', !workspaceSidebarOpen);
  elements.workspaceSidebarToggle.setAttribute('aria-expanded', String(workspaceSidebarOpen));
  elements.workspaceSidebarToggle.setAttribute(
    'aria-label',
    workspaceSidebarOpen ? 'Hide workspace sidebar' : 'Show workspace sidebar'
  );
}

function setBodyStyleProperty(name, value) {
  if (typeof document.body.style.setProperty === 'function') {
    document.body.style.setProperty(name, value);
  } else {
    document.body.style[name] = value;
  }
}

function removeBodyStyleProperty(name) {
  if (typeof document.body.style.removeProperty === 'function') {
    document.body.style.removeProperty(name);
  } else {
    delete document.body.style[name];
  }
}

function paneResizeMaximum(kind) {
  const config = PANE_RESIZE_CONFIG[kind];
  const oppositeWidth =
    kind === 'session'
      ? workspaceSidebarOpen
        ? elements.pageSurface.getBoundingClientRect().width
        : 0
      : sessionSidebarOpen
        ? elements.sessionSidebar.getBoundingClientRect().width
        : 0;
  const viewportWidth = Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
  return Math.max(config.minWidth, Math.min(config.maxWidth, viewportWidth - oppositeWidth - 360));
}

function setPaneWidth(kind, requestedWidth) {
  const config = PANE_RESIZE_CONFIG[kind];
  const maximum = paneResizeMaximum(kind);
  const width = Math.round(Math.max(config.minWidth, Math.min(maximum, requestedWidth)));
  paneWidths[kind] = width;
  setBodyStyleProperty(config.cssProperty, `${width}px`);
  const handle = kind === 'session' ? elements.sessionResizer : elements.workspaceResizer;
  handle.setAttribute('aria-valuemax', String(Math.round(maximum)));
  handle.setAttribute('aria-valuenow', String(width));
}

function resetPaneWidth(kind) {
  const config = PANE_RESIZE_CONFIG[kind];
  paneWidths[kind] = null;
  removeBodyStyleProperty(config.cssProperty);
  const handle = kind === 'session' ? elements.sessionResizer : elements.workspaceResizer;
  handle.setAttribute('aria-valuenow', String(config.defaultWidth));
}

function initPaneResizer(kind, handle) {
  let pointerId = null;
  const isOpen = () =>
    agentFirstMode && (kind === 'session' ? sessionSidebarOpen : workspaceSidebarOpen);
  const finishResize = (event) => {
    if (pointerId === null || (event?.pointerId != null && event.pointerId !== pointerId)) return;
    handle.releasePointerCapture?.(pointerId);
    pointerId = null;
    document.body.classList.remove('agent-sidebar-resizing');
  };

  handle.addEventListener('pointerdown', (event) => {
    if (!isOpen() || (event.button != null && event.button !== 0)) return;
    event.preventDefault();
    pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    document.body.classList.add('agent-sidebar-resizing');
  });
  handle.addEventListener('pointermove', (event) => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    const requestedWidth = kind === 'session' ? event.clientX : window.innerWidth - event.clientX;
    setPaneWidth(kind, requestedWidth);
  });
  handle.addEventListener('pointerup', finishResize);
  handle.addEventListener('pointercancel', finishResize);
  handle.addEventListener('dblclick', () => resetPaneWidth(kind));
  handle.addEventListener('keydown', (event) => {
    if (!isOpen()) return;
    const config = PANE_RESIZE_CONFIG[kind];
    const currentWidth =
      paneWidths[kind] ??
      (kind === 'session'
        ? elements.sessionSidebar.getBoundingClientRect().width
        : elements.pageSurface.getBoundingClientRect().width) ??
      config.defaultWidth;
    const direction = kind === 'session' ? 1 : -1;
    let nextWidth = null;
    if (event.key === 'ArrowLeft') nextWidth = currentWidth - 16 * direction;
    if (event.key === 'ArrowRight') nextWidth = currentWidth + 16 * direction;
    if (event.key === 'Home') nextWidth = config.minWidth;
    if (event.key === 'End') nextWidth = paneResizeMaximum(kind);
    if (nextWidth === null) return;
    event.preventDefault();
    setPaneWidth(kind, nextWidth);
  });
}

function showPrimaryView() {
  if (!providerReady) setAgentView('loading');
  else setAgentView(providerStatus?.configured ? 'workspace' : 'setup');
  focusComposer();
}

function showProviderSetup() {
  setAgentView('setup');
  renderConnectedProviders();
  elements.provider.focus();
}

function setPanelOpen(nextOpen) {
  panelOpen = nextOpen;
  elements.panel.classList.toggle('collapsed', !panelOpen);
  elements.toggle.setAttribute('aria-expanded', String(panelOpen));
}

function focusComposer(options = {}) {
  const activeElement = document.activeElement;
  const explicitFocusClaimed =
    options.preserveExplicitFocus === true &&
    activeElement &&
    ![document.body, elements.prompt, elements.run].includes(activeElement);
  if (
    !panelOpen ||
    agentView !== 'workspace' ||
    elements.prompt.disabled ||
    pendingApproval ||
    !elements.takeoverDialog.hidden ||
    !elements.walletUnlock.hidden ||
    explicitFocusClaimed
  ) {
    return false;
  }
  elements.prompt.focus({ preventScroll: true });
  return true;
}

function closePanel() {
  if (agentFirstMode) setAgentFirstMode(false);
  if (panelOpen) setPanelOpen(false);
}

function openPanel() {
  if (isPrivateWindow() || isSignatureInFlight()) return;
  if (isWalletSidebarVisible()) {
    closeWalletSidebar();
    if (isWalletSidebarVisible()) return;
  }
  setPanelOpen(true);
  showPrimaryView();
  loadProviderCatalog().then(() => {
    renderConnectedProviders();
    renderModelMenu();
  });
  document.dispatchEvent(new CustomEvent('agent-sidebar-opened'));
}

function togglePanel() {
  if (panelOpen) closePanel();
  else openPanel();
}

function renderProviderFields() {
  const providerId = elements.provider.value;
  const isOllama = providerId === 'ollama';
  const isSubscription = providerAuthType(providerId) === 'subscription';
  const connection = providerConnection(providerId);
  const isConnectedSubscription = connection?.kind === 'subscription';
  elements.providerPrivacy.textContent = providerPrivacyMessage(providerId);
  elements.hostedFields.classList.toggle('hidden', isOllama);
  elements.ollamaFields.classList.toggle('hidden', !isOllama);
  elements.apiKeyField.classList.toggle('hidden', isSubscription);
  elements.subscriptionFields.classList.toggle('hidden', !isSubscription);
  elements.saveProvider.hidden = isSubscription;
  elements.loginProvider.hidden =
    !isSubscription || isConnectedSubscription || providerLoginPending;
  elements.cancelProviderLogin.hidden = !isSubscription || !providerLoginPending;
  elements.provider.disabled = providerLoginPending;
  elements.model.disabled = providerLoginPending;
  if (!isOllama) renderModelOptions(providerId);
}

function renderModelOptions(providerId) {
  const selectedModel =
    providerStatus?.providerId === providerId ? providerStatus.modelId : elements.model.value;
  const provider = providerCatalog.find((candidate) => candidate.providerId === providerId);
  const options = (provider?.models || []).map((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name || model.id;
    return option;
  });
  elements.model.replaceChildren(...options);
  if (options.some((option) => option.value === selectedModel)) {
    elements.model.value = selectedModel;
  } else if (options[0]) {
    elements.model.value = options[0].value;
  }
}

function renderConnectedProviders() {
  const connections = providerConnections();
  elements.connectedProviders.hidden = connections.length === 0;
  const rows = connections.map((connection) => {
    const row = document.createElement('div');
    row.className = 'agent-connected-provider';
    const copy = document.createElement('div');
    copy.className = 'agent-connected-provider-copy';
    const name = document.createElement('strong');
    name.textContent = providerName(connection.providerId);
    const model = document.createElement('span');
    const count =
      connection.kind === 'ollama' ? (connection.modelIds || [connection.modelId]).length : null;
    model.textContent =
      count && count > 1
        ? `${count} local models`
        : modelName(connection.providerId, connection.modelId);
    copy.appendChild(name);
    copy.appendChild(model);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'agent-provider-remove';
    remove.textContent = 'Disconnect';
    remove.addEventListener('click', () => removeProviderConnection(connection.providerId));
    row.appendChild(copy);
    row.appendChild(remove);
    return row;
  });
  elements.connectedProviderList.replaceChildren(...rows);
}

function renderModelMenu() {
  const models = configuredModels();
  const groups = new Map();
  for (const model of models) {
    if (!groups.has(model.providerId)) groups.set(model.providerId, []);
    groups.get(model.providerId).push(model);
  }
  const content = [];
  for (const [providerId, providerModels] of groups) {
    const label = document.createElement('div');
    label.className = 'agent-model-group-label';
    label.textContent = providerName(providerId);
    content.push(label);
    for (const model of providerModels) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'agent-model-option';
      option.setAttribute('role', 'menuitemradio');
      const active =
        providerStatus?.providerId === model.providerId &&
        providerStatus?.modelId === model.modelId;
      option.classList.toggle('active', active);
      option.setAttribute('aria-checked', String(active));
      const name = document.createElement('span');
      name.textContent = model.name;
      const check = document.createElement('span');
      check.textContent = active ? '✓' : '';
      option.appendChild(name);
      option.appendChild(check);
      option.addEventListener('click', () => selectModel(model.providerId, model.modelId));
      content.push(option);
    }
  }
  elements.modelMenuList.replaceChildren(...content);
}

function renderActiveModel() {
  const configured = providerStatus?.configured === true;
  elements.activeModelLabel.textContent = configured
    ? modelName(providerStatus.providerId, providerStatus.modelId)
    : 'Choose model';
  elements.modelMenuButton.title = configured
    ? `${providerName(providerStatus.providerId)} · ${providerStatus.modelId}`
    : '';
  renderModelMenu();
}

function renderProviderStatus(status) {
  providerStatus = status;
  const configured = status?.configured === true;
  elements.providerStatus.textContent = configured
    ? `${providerName(status.providerId)} · ${status.modelId}`
    : 'Not configured';
  elements.providerStatus.classList.toggle('active', configured);
  if (configured && Object.hasOwn(PROVIDER_NAMES, status.providerId)) {
    elements.provider.value = status.providerId;
    if (status.providerId === 'ollama') {
      elements.ollamaModel.value = status.modelId || '';
      elements.ollamaUrl.value = status.baseUrl || 'http://127.0.0.1:11434/v1';
    }
  }
  renderProviderFields();
  renderConnectedProviders();
  renderActiveModel();
  updateSendAvailability();
  if (agentView === 'loading') showPrimaryView();
}

async function refreshProvider() {
  try {
    const response = await window.electronAPI.getAgentProviderStatus();
    if (!response?.ok) {
      setMessage(
        elements.providerMessage,
        responseMessage(response, 'Could not load the agent model'),
        true
      );
      providerReady = true;
      providerStatus = { configured: false, connections: [] };
      showPrimaryView();
      return;
    }
    providerReady = true;
    renderProviderStatus(response.status);
  } catch {
    providerReady = true;
    providerStatus = { configured: false, connections: [] };
    setMessage(elements.providerMessage, 'Could not load the agent model', true);
    showPrimaryView();
  }
}

async function loadProviderCatalog() {
  if (providerCatalog.length) return providerCatalog;
  if (providerCatalogPromise) return providerCatalogPromise;
  providerCatalogPromise = (async () => {
    try {
      const response = await window.electronAPI.getAgentProviderCatalog();
      if (!response?.ok || !Array.isArray(response.catalog)) return providerCatalog;
      providerCatalog = response.catalog;
      renderProviderFields();
      renderConnectedProviders();
      renderActiveModel();
      return providerCatalog;
    } catch {
      // A saved Ollama model remains usable even if the hosted catalog cannot load.
      return providerCatalog;
    } finally {
      providerCatalogPromise = null;
    }
  })();
  return providerCatalogPromise;
}

async function selectModel(providerId, modelId) {
  if (currentRunStatus !== 'idle' || currentConversationId) return;
  elements.modelMenuButton.disabled = true;
  try {
    const response = await window.electronAPI.selectAgentModel(providerId, modelId);
    if (!response?.ok) {
      setMessage(elements.runMessage, responseMessage(response, 'Could not select model'), true);
      return;
    }
    renderProviderStatus(response.status);
    closeComposerPopovers();
  } catch {
    setMessage(elements.runMessage, 'Could not select model', true);
  } finally {
    elements.modelMenuButton.disabled =
      currentRunStatus !== 'idle' || Boolean(currentConversationId);
  }
}

async function removeProviderConnection(providerId) {
  const label = providerName(providerId);
  if (!window.confirm(`Disconnect ${label} from Agent?`)) return;
  try {
    const response = await window.electronAPI.removeAgentProvider(providerId);
    if (!response?.ok) {
      setMessage(
        elements.providerMessage,
        responseMessage(response, `Could not disconnect ${label}`),
        true
      );
      return;
    }
    renderProviderStatus(response.status);
    if (!response.status?.configured) setAgentView('setup');
  } catch {
    setMessage(elements.providerMessage, `Could not disconnect ${label}`, true);
  }
}

async function saveProvider() {
  const providerId = elements.provider.value;
  elements.saveProvider.disabled = true;
  setMessage(elements.providerMessage, 'Saving…');
  try {
    let response;
    if (providerId === 'ollama') {
      response = await window.electronAPI.configureOllamaAgentProvider(
        elements.ollamaModel.value.trim(),
        elements.ollamaUrl.value.trim()
      );
    } else {
      response = await window.electronAPI.configureHostedAgentProvider(
        providerId,
        elements.model.value,
        elements.apiKey.value
      );
    }
    elements.apiKey.value = '';
    if (!response?.ok) {
      setMessage(elements.providerMessage, responseMessage(response, 'Could not save model'), true);
      return;
    }
    renderProviderStatus(response.status);
    setMessage(elements.providerMessage, 'Model saved for this profile');
    setAgentView('workspace');
    elements.prompt.focus();
  } catch {
    elements.apiKey.value = '';
    setMessage(elements.providerMessage, 'Could not save model', true);
  } finally {
    elements.saveProvider.disabled = false;
  }
}

function handleProviderAuthEvent(event) {
  if (
    !providerLoginPending ||
    event?.type !== 'device_code' ||
    event.providerId !== 'openai-codex' ||
    typeof event.userCode !== 'string'
  ) {
    return;
  }
  elements.authUserCode.textContent = event.userCode;
  elements.authCode.hidden = false;
  setMessage(elements.providerMessage, 'Finish signing in on the OpenAI page');
}

async function loginSubscriptionProvider() {
  const providerId = elements.provider.value;
  const modelId = elements.model.value;
  if (providerAuthType(providerId) !== 'subscription' || !modelId) {
    setMessage(elements.providerMessage, 'Choose a subscription model first', true);
    return;
  }
  providerLoginPending = true;
  elements.authCode.hidden = true;
  elements.authUserCode.textContent = '';
  setMessage(elements.providerMessage, 'Starting ChatGPT sign-in…');
  renderProviderFields();
  try {
    const response = await window.electronAPI.loginSubscriptionAgentProvider(providerId, modelId);
    if (!response?.ok) {
      setMessage(
        elements.providerMessage,
        responseMessage(response, 'Could not sign in with ChatGPT'),
        response?.error?.code !== 'AGENT_PROVIDER_AUTH_CANCELLED'
      );
      return;
    }
    renderProviderStatus(response.status);
    setMessage(elements.providerMessage, 'ChatGPT connected for this profile');
    setAgentView('workspace');
    elements.prompt.focus();
  } catch {
    setMessage(elements.providerMessage, 'Could not sign in with ChatGPT', true);
  } finally {
    providerLoginPending = false;
    renderProviderFields();
  }
}

async function cancelProviderLogin() {
  if (!providerLoginPending) return;
  elements.cancelProviderLogin.disabled = true;
  setMessage(elements.providerMessage, 'Cancelling sign-in…');
  try {
    await window.electronAPI.cancelAgentProviderLogin();
  } catch {
    setMessage(elements.providerMessage, 'Could not cancel sign-in', true);
  } finally {
    elements.cancelProviderLogin.disabled = false;
  }
}

function setRunState(status, label) {
  const active = status !== 'idle';
  const acceptsComposerInput = ['idle', 'running', 'paused'].includes(status) && !pendingApproval;
  currentRunStatus = status;
  setWorkspaceNavigationEditable(status === 'idle' || status === 'paused');
  elements.prompt.disabled = !acceptsComposerInput;
  elements.prompt.placeholder =
    status === 'running'
      ? 'Guide Agent…'
      : status === 'paused'
        ? 'Add guidance and resume…'
        : 'Message Agent…';
  elements.modelMenuButton.disabled = active || Boolean(currentConversationId);
  elements.approvalModeButton.disabled = active || approvalModeMutationPending;
  elements.attachmentButton.disabled = status !== 'idle' || Boolean(pendingApproval);
  elements.newChat.hidden = !currentConversationId;
  elements.newChat.disabled = active;
  elements.runStatus.textContent = label;
  elements.runStatus.classList.toggle('active', active);
  updateSendAvailability();
  renderPageInterlock();
  renderPageContext();
  renderSessionSidebar();
}

function updateSendAvailability() {
  const hasText = Boolean(elements.prompt.value.trim());
  let action = 'send';
  let label = 'Run task';
  let disabled = true;
  if (currentRunStatus === 'idle') {
    disabled = !hasText || !providerStatus?.configured || approvalModeMutationPending;
  } else if (currentRunStatus === 'running') {
    action = hasText ? 'send' : 'stop';
    label = hasText ? 'Send guidance' : 'Stop Agent';
    disabled = !currentRunId;
  } else if (currentRunStatus === 'paused') {
    action = hasText ? 'send' : 'resume';
    label = hasText ? 'Resume with guidance' : 'Resume Agent';
    disabled = !currentRunId;
  }
  elements.run.dataset.action = action;
  elements.run.disabled = disabled;
  elements.run.setAttribute('aria-label', label);
  elements.run.title = label;
}

function resetConversationUi() {
  toolRows.clear();
  attachmentDisplayRows.clear();
  turnViews.clear();
  guidanceViews.clear();
  attachmentPreviewObserver?.disconnect();
  attachmentPreviewObserver = null;
  elements.transcript.replaceChildren();
  elements.transcript.hidden = true;
  elements.emptyState.hidden = false;
  clearApproval();
  setMessage(elements.runMessage);
}

function createTurnView(turn) {
  for (const previous of turnViews.values()) {
    previous.output.removeAttribute('id');
    previous.toolList.removeAttribute('id');
  }

  const section = document.createElement('section');
  section.className = 'agent-turn';
  section.dataset.runId = turn.runId;

  const userRow = document.createElement('div');
  userRow.className = 'agent-message-row user';
  const userMessage = document.createElement('div');
  userMessage.className = 'agent-user-message';
  userMessage.textContent = turn.userText || '';
  userRow.appendChild(userMessage);
  if (Array.isArray(turn.attachments) && turn.attachments.length) {
    const attachments = document.createElement('div');
    attachments.className = 'agent-user-attachments';
    attachments.setAttribute('role', 'list');
    attachments.setAttribute('aria-label', 'Attached files and folders');
    attachments.tabIndex = 0;
    for (const resource of turn.attachments) {
      const tile = createMessageAttachment(resource);
      attachments.appendChild(tile);
      queueMessageAttachmentPreview(tile, resource);
    }
    userRow.appendChild(attachments);
  }

  const assistantRow = document.createElement('div');
  assistantRow.className = 'agent-message-row assistant';
  const output = document.createElement('div');
  output.id = 'agent-output';
  output.className = 'agent-output';
  output.textContent = turn.assistantText || '';
  assistantRow.appendChild(output);

  const outcome = document.createElement('div');
  outcome.className = 'agent-turn-outcome';
  outcome.hidden = true;
  const outcomeIcon = document.createElement('span');
  outcomeIcon.className = 'agent-turn-outcome-icon';
  outcomeIcon.setAttribute('aria-hidden', 'true');
  const outcomeCopy = document.createElement('div');
  outcomeCopy.className = 'agent-turn-outcome-copy';
  const outcomeHeadline = document.createElement('strong');
  const outcomeDetail = document.createElement('span');
  const outcomeNextStep = document.createElement('span');
  outcomeNextStep.className = 'agent-turn-outcome-next';
  const outcomeTechnical = document.createElement('details');
  outcomeTechnical.className = 'agent-turn-outcome-technical';
  outcomeTechnical.hidden = true;
  const outcomeTechnicalSummary = document.createElement('summary');
  outcomeTechnicalSummary.textContent = 'Technical details';
  const outcomeTechnicalDetail = document.createElement('span');
  outcomeTechnical.appendChild(outcomeTechnicalSummary);
  outcomeTechnical.appendChild(outcomeTechnicalDetail);
  const outcomeActions = document.createElement('div');
  outcomeActions.className = 'agent-turn-outcome-actions';
  outcomeActions.hidden = true;
  const outcomeRetry = document.createElement('button');
  outcomeRetry.type = 'button';
  outcomeRetry.textContent = 'Retry';
  outcomeRetry.addEventListener('click', () => void retryProviderTurn(view));
  outcomeActions.appendChild(outcomeRetry);
  outcomeCopy.appendChild(outcomeHeadline);
  outcomeCopy.appendChild(outcomeDetail);
  outcomeCopy.appendChild(outcomeNextStep);
  outcomeCopy.appendChild(outcomeTechnical);
  outcomeCopy.appendChild(outcomeActions);
  outcome.appendChild(outcomeIcon);
  outcome.appendChild(outcomeCopy);

  const artifactList = document.createElement('div');
  artifactList.className = 'agent-artifact-list';
  artifactList.hidden = true;

  const guidanceList = document.createElement('div');
  guidanceList.className = 'agent-guidance-list';

  const activity = document.createElement('details');
  activity.className = 'agent-turn-activity';
  activity.open = true;
  activity.hidden = true;
  const activitySummary = document.createElement('summary');
  activitySummary.textContent = 'Working…';
  const toolList = document.createElement('ol');
  toolList.id = 'agent-tool-list';
  toolList.className = 'agent-tool-list';
  activity.appendChild(activitySummary);
  activity.appendChild(toolList);

  const liveStatus = document.createElement('div');
  liveStatus.className = 'agent-live-status';
  liveStatus.hidden = true;
  liveStatus.setAttribute('aria-atomic', 'true');
  const liveStatusIndicator = document.createElement('span');
  liveStatusIndicator.className = 'agent-live-status-indicator';
  liveStatusIndicator.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 3; index += 1) {
    liveStatusIndicator.appendChild(document.createElement('span'));
  }
  const liveStatusLabel = document.createElement('span');
  liveStatusLabel.className = 'agent-live-status-label';
  liveStatus.appendChild(liveStatusIndicator);
  liveStatus.appendChild(liveStatusLabel);

  section.appendChild(userRow);
  section.appendChild(guidanceList);
  section.appendChild(assistantRow);
  section.appendChild(outcome);
  section.appendChild(artifactList);
  section.appendChild(activity);
  section.appendChild(liveStatus);
  elements.transcript.appendChild(section);
  elements.transcript.hidden = false;
  elements.emptyState.hidden = true;

  const view = {
    section,
    output,
    outcome,
    outcomeIcon,
    outcomeHeadline,
    outcomeDetail,
    outcomeNextStep,
    outcomeTechnical,
    outcomeTechnicalDetail,
    outcomeActions,
    outcomeRetry,
    artifactList,
    activity,
    activitySummary,
    toolList,
    liveStatus,
    liveStatusLabel,
    guidanceList,
    userText: turn.userText || '',
    assistantText: turn.assistantText || '',
    actionCount: 0,
  };
  turnViews.set(turn.runId, view);
  for (const guidance of Array.isArray(turn.guidance) ? turn.guidance : []) {
    createGuidanceView(turn.runId, guidance);
  }
  section.scrollIntoView?.({ block: 'end' });
  return view;
}

function setLiveStatus(runId, label, { active = true } = {}) {
  const view = turnView(runId);
  if (!view || typeof label !== 'string' || !label) return;
  const unchanged =
    !view.liveStatus.hidden &&
    view.liveStatusLabel.textContent === label &&
    view.liveStatus.classList.contains(active ? 'active' : 'waiting');
  if (unchanged) return;
  view.liveStatusLabel.textContent = label;
  view.liveStatus.hidden = false;
  view.liveStatus.classList.toggle('active', active);
  view.liveStatus.classList.toggle('waiting', !active);
  view.section.scrollIntoView?.({ block: 'end' });
}

function clearLiveStatus(runId) {
  const view = turnView(runId);
  if (!view) return;
  view.liveStatus.hidden = true;
  view.liveStatus.classList.remove('active', 'waiting');
  view.liveStatusLabel.textContent = '';
}

function guidanceStatusLabel(status) {
  if (status === 'queued') return 'Guidance queued';
  if (status === 'applying') return 'Applying guidance…';
  if (status === 'cancelled') return 'Not applied';
  return '';
}

function createGuidanceView(runId, guidance) {
  const view = turnView(runId);
  if (
    !view ||
    typeof guidance?.guidanceId !== 'string' ||
    !guidance.guidanceId ||
    typeof guidance.text !== 'string'
  ) {
    return null;
  }
  const key = `${runId}:${guidance.guidanceId}`;
  const existing = guidanceViews.get(key);
  if (existing) return existing;
  const row = document.createElement('div');
  row.className = 'agent-message-row user guidance';
  const content = document.createElement('div');
  content.className = 'agent-guidance-content';
  const message = document.createElement('div');
  message.className = 'agent-user-message agent-guidance-message';
  message.textContent = guidance.text;
  const status = document.createElement('small');
  status.className = 'agent-guidance-status';
  content.appendChild(message);
  content.appendChild(status);
  row.appendChild(content);
  view.guidanceList.appendChild(row);
  const record = { row, status };
  guidanceViews.set(key, record);
  updateGuidanceView(runId, guidance.guidanceId, guidance.status);
  row.scrollIntoView?.({ block: 'end' });
  return record;
}

function updateGuidanceView(runId, guidanceId, status) {
  const record = guidanceViews.get(`${runId}:${guidanceId}`);
  if (!record) return;
  const label = guidanceStatusLabel(status);
  record.status.textContent = label;
  record.status.hidden = !label;
  record.row.classList.toggle('cancelled', status === 'cancelled');
}

function turnView(runId) {
  return turnViews.get(runId) || null;
}

function formatDuration(durationMs) {
  const seconds = Math.max(1, Math.round((Number(durationMs) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function renderAssistantMarkdown(view) {
  if (!view?.assistantText || !window.marked?.parse || !window.DOMPurify?.sanitize) return;
  try {
    const rendered = window.marked.parse(view.assistantText, { gfm: true, breaks: true });
    if (typeof rendered !== 'string') return;
    view.output.innerHTML = window.DOMPurify.sanitize(rendered, {
      ALLOWED_TAGS: [
        'p',
        'br',
        'strong',
        'em',
        'del',
        'code',
        'pre',
        'blockquote',
        'ul',
        'ol',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'hr',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
      ],
      ALLOWED_ATTR: [],
    });
    view.output.classList.add('rendered-markdown');
  } catch {
    view.output.textContent = view.assistantText;
    view.output.classList.remove('rendered-markdown');
  }
}

function restoreTranscript(transcript = []) {
  resetConversationUi();
  for (const turn of transcript) {
    if (!turn || typeof turn.runId !== 'string') continue;
    const view = createTurnView(turn);
    for (const item of Array.isArray(turn.activity) ? turn.activity : []) {
      addToolRow({ ...item, runId: turn.runId });
      if (item.status !== 'running') finishToolRow({ ...item, runId: turn.runId });
    }
    if (
      turn.status &&
      !['starting', 'running', 'pausing', 'paused', 'resuming'].includes(turn.status)
    ) {
      finishTurnView(turn.runId, turn);
    }
    if (view.assistantText && turn.status === 'completed') renderAssistantMarkdown(view);
  }
}

function clearApproval() {
  pendingApproval = null;
  elements.approval.hidden = true;
  elements.approval.classList.remove('diagnostic-approval');
  elements.approval.classList.remove('conversation-approval');
  elements.composer.classList.remove('approval-pending');
  elements.approvalApprove.textContent = 'Allow once';
  elements.approvalApprove.classList.add('primary');
  elements.approvalApprove.classList.remove('secondary');
  elements.approvalAllowConversation.hidden = true;
  elements.walletApprovalDetails.hidden = true;
  elements.walletApprovalSummary.replaceChildren();
  elements.nodeRequestDetails.hidden = true;
  elements.nodeRequestSummary.replaceChildren();
  elements.publicationDetails.hidden = true;
  elements.publicationSummary.replaceChildren();
  elements.workspacePermissionDetails.hidden = true;
  elements.workspacePermissionDetails.open = false;
  elements.workspacePermissionSummary.textContent = '';
  elements.walletAccountField.hidden = true;
  elements.walletAccount.replaceChildren();
  elements.walletUnlock.hidden = true;
  elements.walletPassword.value = '';
  setApprovalControlsDisabled(false);
  setMessage(elements.approvalMessage);
}

function appendWalletSummary(label, value) {
  if (!value) return;
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  elements.walletApprovalSummary.appendChild(term);
  elements.walletApprovalSummary.appendChild(description);
}

function appendNodeRequestSummary(label, value) {
  if (!value) return;
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  elements.nodeRequestSummary.appendChild(term);
  elements.nodeRequestSummary.appendChild(description);
}

function appendPublicationSummary(label, value) {
  if (!value) return;
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  elements.publicationSummary.appendChild(term);
  elements.publicationSummary.appendChild(description);
}

function publicationSubject(publication) {
  return publication?.kind === 'text' ? 'text' : publication?.name || 'content';
}

function renderPublicationApproval(request) {
  const publication = request.publication;
  elements.publicationDetails.hidden = false;
  elements.publicationSummary.replaceChildren();
  appendPublicationSummary(
    'Content',
    publication.workspacePath
      ? publication.kind === 'folder'
        ? 'Managed project folder'
        : 'Managed project file'
      : publication.kind === 'folder'
        ? 'Attached folder · current contents'
        : publication.kind === 'file'
          ? 'Attached file'
          : 'Text'
  );
  if (publication.kind !== 'text') appendPublicationSummary('Name', publication.name);
  appendPublicationSummary('Project path', publication.workspacePath);
  if (Number.isSafeInteger(publication.bytes)) {
    appendPublicationSummary('Size', formatArtifactBytes(publication.bytes));
  }
  appendPublicationSummary('Default document', publication.indexDocument);
  appendPublicationSummary('Network', 'Public Swarm network');
}

function effectLabel(value) {
  return (
    {
      read: 'Read-only',
      reversible_admin: 'Reversible admin change',
      persistent_change: 'Persistent change',
      financial: 'Financial action',
      destructive: 'Destructive action',
      unknown: 'Uncertain effect',
    }[value] || 'Uncertain effect'
  );
}

function renderNodeRequestApproval(request) {
  const nodeRequest = request.nodeRequest;
  const wireRequest = nodeRequest.request;
  elements.nodeRequestDetails.hidden = false;
  elements.nodeRequestSummary.replaceChildren();
  appendNodeRequestSummary('Request', `${wireRequest.method} ${wireRequest.path}`);
  appendNodeRequestSummary('Effect', effectLabel(nodeRequest.effect));
  appendNodeRequestSummary('Classifier', nodeRequest.classification?.summary);
  if (nodeRequest.classification?.uncertainties?.length) {
    appendNodeRequestSummary('Uncertainty', nodeRequest.classification.uncertainties.join('\n'));
  }
  if (wireRequest.headers && Object.keys(wireRequest.headers).length) {
    appendNodeRequestSummary(
      'Headers',
      Object.entries(wireRequest.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n')
    );
  }
  if (typeof wireRequest.body === 'string') appendNodeRequestSummary('Body', wireRequest.body);
}

function renderNodeLifecycleApproval(request) {
  const lifecycle = request.nodeLifecycle;
  elements.nodeRequestDetails.hidden = false;
  elements.nodeRequestSummary.replaceChildren();
  appendNodeRequestSummary('Action', `${lifecycle.action} ${lifecycle.service}`);
  appendNodeRequestSummary('Current state', lifecycle.beforeState);
  appendNodeRequestSummary('Effect', effectLabel(lifecycle.effect));
  appendNodeRequestSummary('Classifier', lifecycle.classification?.summary);
  if (lifecycle.classification?.uncertainties?.length) {
    appendNodeRequestSummary('Uncertainty', lifecycle.classification.uncertainties.join('\n'));
  }
}

function shortAddress(value) {
  return typeof value === 'string' && value.length > 18
    ? `${value.slice(0, 10)}…${value.slice(-6)}`
    : value || '';
}

function renderWalletApproval(request) {
  const wallet = request.wallet;
  elements.walletApprovalDetails.hidden = false;
  elements.walletApprovalSummary.replaceChildren();
  appendWalletSummary('Site', request.origin);
  appendWalletSummary('Network', wallet.chainName || `Chain ${wallet.chainId}`);
  if (wallet.kind === 'connection') {
    elements.walletAccountField.hidden = false;
    elements.walletAccount.replaceChildren();
    for (const account of wallet.wallets || []) {
      const option = document.createElement('option');
      option.value = String(account.index);
      option.textContent = `${account.name || 'Wallet'} · ${shortAddress(account.address)}`;
      option.selected = account.index === wallet.defaultWalletIndex;
      elements.walletAccount.appendChild(option);
    }
  } else {
    elements.walletAccountField.hidden = true;
    appendWalletSummary(
      'Account',
      `${wallet.account?.name || 'Wallet'} · ${shortAddress(wallet.account?.address)}`
    );
  }
  if (wallet.kind === 'transaction' || wallet.kind === 'transfer') {
    appendWalletSummary('To', wallet.to);
    if (wallet.recipientVerification) {
      appendWalletSummary('Recipient verification', wallet.recipientVerification);
    }
    appendWalletSummary('Amount', wallet.value);
    appendWalletSummary('Maximum fee', wallet.maxFee);
    if (wallet.tokenContract) appendWalletSummary('Token contract', wallet.tokenContract);
    if (wallet.data) appendWalletSummary('Contract data', wallet.data);
  } else if (wallet.kind === 'signature') {
    appendWalletSummary(wallet.signatureType || 'Signature', wallet.summary);
  }
}

function setApprovalControlsDisabled(disabled) {
  elements.approvalApprove.disabled = disabled;
  elements.approvalAllowConversation.disabled = disabled;
  elements.approvalDecline.disabled = disabled;
  elements.approvalStop.disabled = disabled;
}

function describeApprovalOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    const key = url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`;
    return { key, label: url.host || url.protocol.replace(/:$/, '') };
  } catch {
    return null;
  }
}

function approvalOriginSummary(request) {
  const source = describeApprovalOrigin(request.origin);
  const destination = describeApprovalOrigin(request.destinationOrigin);
  if (!source && !destination) return 'Site unavailable';
  if (!source) return destination.label;
  if (!destination || source.key === destination.key) return source.label;
  if (source.label === destination.label) {
    return `${source.key} → ${destination.key}`;
  }
  return `${source.label} → ${destination.label}`;
}

function workspaceEnablementDetails(workspace) {
  const lifecycle =
    workspace?.backend === 'macos-seatbelt'
      ? 'On macOS, stopping detached subprocesses is best-effort. Any survivor remains inside the same filesystem and network boundary.'
      : 'On Linux, Freedom tears down the complete sandbox process namespace when a command stops.';
  return `Freedom stores one local workspace for this conversation and removes it when the conversation is deleted. Agent may write only inside that workspace; protected .git metadata remains read-only. Workspace commands may read and execute required system tools and separately approved executable packages, but cannot write to them. This approval does not grant internet, localhost, or LAN access; those require a separate capability.\n\n${lifecycle}`;
}

function workspaceCommandPermissionDetails(permission, reason) {
  const requestedExecutables = permission.commands
    .filter((command) => command.status === 'requires_permission')
    .map((command) => command.name);
  const requestedRoots = [
    ...new Set(
      permission.commands
        .filter((command) => command.status === 'requires_permission')
        .map((command) => command.rootPath)
    ),
  ];
  const paragraphs = [
    `Working directory: ${permission.workingDirectory === '.' ? 'Project workspace' : permission.workingDirectory}`,
  ];
  if (requestedRoots.length) {
    paragraphs.push(
      `Requires read and execute access to ${requestedRoots.join(', ')}. Agent may read and execute within ${requestedExecutables.length === 1 ? 'this package' : 'these packages'}, but cannot write there.`
    );
  }
  if (permission.network) {
    const socketDisclosure =
      permission.network.hostAbstractUnixSockets === 'reachable'
        ? ' On Linux, this direct-network mode also reaches host abstract Unix sockets; pathname sockets outside mounted files remain inaccessible.'
        : ' Host Unix sockets remain inaccessible.';
    paragraphs.push(
      `Requires full direct networking: public internet, services on this computer’s localhost, and private/LAN addresses.${socketDisclosure}`
    );
  } else {
    paragraphs.push('Network access is not part of this request.');
  }
  const retainedAuthority = permission.network
    ? requestedRoots.length
      ? 'the disclosed network and package access'
      : 'the disclosed network access'
    : 'the disclosed package access';
  paragraphs.push(
    `“Allow once” applies only to this exact command and directory. “Allow for conversation” keeps ${retainedAuthority} available for later workspace commands.`
  );
  if (reason) paragraphs.push(`Agent says: ${reason}`);
  return paragraphs.join('\n\n');
}

function renderApproval(request) {
  if (!request || typeof request.approvalId !== 'string') return;
  pendingApproval = request;
  closeComposerPopovers();
  const label = typeof request.label === 'string' && request.label ? request.label : 'this element';
  const interactionCopy = {
    browser_click: `Let Agent click “${label}”?`,
    browser_type: `Let Agent type in “${label}”?`,
    browser_select: `Let Agent change “${label}”?`,
    browser_press: `Let Agent press a key on “${label}”?`,
  };
  const diagnostic = request.diagnostic;
  const nodeRequest = request.nodeRequest;
  const nodeLifecycle = request.nodeLifecycle;
  const interaction = request.interaction;
  const publication = request.publication;
  const workspace = request.workspace;
  const workspacePermission = request.workspacePermission;
  elements.approval.classList.toggle('diagnostic-approval', Boolean(diagnostic));
  elements.approval.classList.toggle(
    'conversation-approval',
    Boolean(diagnostic || workspacePermission)
  );
  const diagnosticSubject =
    diagnostic?.scope === 'node' ? `${diagnostic.service} node` : 'Freedom application';
  const nodeLabels = {
    ant: 'Ant',
    ipfs: 'IPFS',
    radicle: 'Radicle',
    tor: 'Tor',
    'myotis-ethereum': 'Myotis Ethereum',
    'myotis-gnosis': 'Myotis Gnosis',
  };
  elements.approvalAction.textContent = workspacePermission
    ? `Run “${workspacePermission.command}”?`
    : workspace
      ? 'Enable a managed project workspace for this conversation?'
      : publication
        ? publication.kind === 'text'
          ? 'Publish this text to Swarm?'
          : `Publish “${publication.name}” to Swarm?`
        : nodeRequest
          ? `Allow this ${nodeLabels[nodeRequest.service] || nodeRequest.service} node request?`
          : nodeLifecycle
            ? `${nodeLifecycle.action[0].toUpperCase()}${nodeLifecycle.action.slice(1)} the ${nodeLabels[nodeLifecycle.service] || nodeLifecycle.service} node?`
            : diagnostic
              ? `Share recent ${diagnosticSubject} diagnostics with ${diagnostic.providerLabel}?`
              : request.action === 'form_submission'
                ? `Submit this form using “${label}”?`
                : request.action === 'file_download'
                  ? `Download ${label.replace(/^download\s+/i, '').trim() || 'this file'}?`
                  : request.action === 'file_upload'
                    ? `Choose a file to share with ${describeApprovalOrigin(request.destinationOrigin)?.label || 'this site'}?`
                    : request.action === 'wallet_connection'
                      ? 'Connect this site to a wallet account?'
                      : request.action === 'wallet_transaction'
                        ? 'Approve this wallet transaction?'
                        : request.action === 'wallet_transfer'
                          ? 'Send these funds from your Freedom wallet?'
                          : request.action === 'wallet_signature'
                            ? 'Approve this wallet signature?'
                            : interaction
                              ? interaction.kind === 'uncertain'
                                ? interactionCopy[request.operation] ||
                                  `Let Agent interact with “${label}”?`
                                : `${interaction.summary.replace(/[.?!]+$/, '')}?`
                              : interactionCopy[request.operation] ||
                                `Let Agent interact with “${label}”?`;
  elements.approvalOrigin.textContent = workspacePermission
    ? workspacePermission.network
      ? 'With access to the internet, localhost, and LAN.'
      : ''
    : workspace
      ? 'Agent can create, edit, and delete files inside a Freedom-managed project workspace.'
      : publication
        ? publication.workspacePath
          ? 'This publishes the managed project source’s current files using an existing postage batch. The content is public, unencrypted, and may remain retrievable.'
          : publication.kind === 'folder'
            ? 'This publishes the attached folder’s current contents using an existing postage batch. The content is public, unencrypted, and may remain retrievable.'
            : 'This publishes the attached content using an existing postage batch. The content is public, unencrypted, and may remain retrievable.'
        : nodeRequest
          ? `${nodeRequest.providerLabel}${nodeRequest.modelId ? ` using ${nodeRequest.modelId}` : ''} independently classified this request as ${effectLabel(nodeRequest.effect).toLowerCase()}. Freedom has not sent it to the node yet.`
          : nodeLifecycle
            ? `${nodeLifecycle.providerLabel}${nodeLifecycle.modelId ? ` using ${nodeLifecycle.modelId}` : ''} classified this as ${effectLabel(nodeLifecycle.effect).toLowerCase()}. Freedom will run it through the node manager and verify the resulting state.`
            : diagnostic
              ? diagnostic.local
                ? `Raw diagnostic logs will be added to this conversation with ${diagnostic.providerLabel}${diagnostic.modelId ? ` using ${diagnostic.modelId}` : ''}. They remain on this device, but may include peer IDs, network or wallet addresses, local paths, and requested resources.`
                : `This sends raw diagnostic logs to ${diagnostic.providerLabel}${diagnostic.modelId ? ` using ${diagnostic.modelId}` : ''}. They may include peer IDs, network or wallet addresses, local paths, and requested resources.`
              : request.action === 'file_upload'
                ? `For “${label}” · Freedom shares only the file you choose and never shows Agent its local path.`
                : request.wallet
                  ? request.wallet.kind === 'transfer'
                    ? 'Prepared directly by Freedom. The exact transfer is held until you decide.'
                    : 'Requested by the page Agent is controlling. The request is held until you decide.'
                  : interaction
                    ? interaction.kind === 'uncertain'
                      ? `Freedom could not confidently determine whether this interaction on ${approvalOriginSummary(request)} is consequential.`
                      : `Based on Agent’s stated intent and the visible target on ${approvalOriginSummary(request)}. Freedom has not audited the page’s hidden behavior.`
                    : approvalOriginSummary(request);
  elements.approvalApprove.textContent = workspacePermission
    ? 'Allow once'
    : workspace
      ? 'Enable workspace'
      : publication
        ? 'Publish'
        : diagnostic
          ? 'Share once'
          : request.action === 'file_upload'
            ? 'Choose file…'
            : request.wallet
              ? request.wallet.kind === 'signature'
                ? 'Sign once'
                : request.wallet.kind === 'transaction'
                  ? 'Confirm transaction'
                  : request.wallet.kind === 'transfer'
                    ? 'Send once'
                    : 'Connect once'
              : 'Allow once';
  elements.approvalApprove.classList.toggle('primary', !diagnostic && !workspacePermission);
  elements.approvalApprove.classList.toggle(
    'secondary',
    Boolean(diagnostic || workspacePermission)
  );
  elements.walletApprovalDetails.hidden = true;
  elements.nodeRequestDetails.hidden = true;
  elements.publicationDetails.hidden = true;
  elements.workspacePermissionDetails.hidden = !workspacePermission && !workspace;
  elements.workspacePermissionDetails.open = false;
  elements.workspacePermissionSummary.textContent = workspacePermission
    ? workspaceCommandPermissionDetails(workspacePermission, request.label)
    : workspace
      ? workspaceEnablementDetails(workspace)
      : '';
  elements.walletUnlock.hidden = true;
  elements.approvalAllowConversation.hidden = !diagnostic && !workspacePermission;
  if (diagnostic) elements.approvalAllowConversation.textContent = 'Share for conversation';
  if (workspacePermission) {
    elements.approvalAllowConversation.textContent = 'Allow for conversation';
  }
  if (request.wallet) renderWalletApproval(request);
  if (nodeRequest) renderNodeRequestApproval(request);
  if (nodeLifecycle) renderNodeLifecycleApproval(request);
  if (publication) renderPublicationApproval(request);
  setApprovalControlsDisabled(false);
  setMessage(elements.approvalMessage, 'Agent is waiting');
  elements.composer.classList.add('approval-pending');
  elements.approval.hidden = false;
}

async function ensureWalletUnlocked(request) {
  if (!request.wallet?.requiresUnlock) return true;
  const status = await window.identity.getStatus();
  if (status?.isUnlocked) return true;
  const canUseTouchId = await window.quickUnlock.canUseTouchId();
  const touchIdEnabled = await window.quickUnlock.isEnabled();
  if (canUseTouchId && touchIdEnabled) {
    setMessage(elements.approvalMessage, 'Waiting for Touch ID…');
    const quick = await window.quickUnlock.unlock();
    if (!quick?.success) {
      setMessage(elements.approvalMessage, quick?.error || 'Wallet unlock was cancelled', true);
      return false;
    }
    const unlocked = await window.identity.unlock(quick.password);
    if (!unlocked?.success) {
      setMessage(elements.approvalMessage, unlocked?.error || 'Wallet unlock failed', true);
      return false;
    }
    return true;
  }
  elements.walletUnlock.hidden = false;
  elements.walletPassword.focus();
  setMessage(elements.approvalMessage, 'Wallet is locked');
  return false;
}

async function decideApproval(approved, options = {}) {
  const request = pendingApproval;
  if (!request || !currentRunId) return;
  setApprovalControlsDisabled(true);
  if (approved && request.wallet) {
    try {
      if (!(await ensureWalletUnlocked(request))) {
        setApprovalControlsDisabled(false);
        return;
      }
    } catch {
      setApprovalControlsDisabled(false);
      setMessage(elements.approvalMessage, 'Wallet unlock failed', true);
      return;
    }
  }
  setMessage(elements.approvalMessage, approved ? 'Allowing…' : 'Not allowing…');
  try {
    const walletIndex = Number(elements.walletAccount.value);
    const decisionOptions = approved
      ? {
          ...(request.wallet?.kind === 'connection' && Number.isSafeInteger(walletIndex)
            ? { walletIndex }
            : {}),
          ...(request.diagnostic && options.diagnosticScope === 'conversation'
            ? { diagnosticScope: 'conversation' }
            : {}),
          ...(request.workspacePermission && options.workspacePermissionScope === 'conversation'
            ? { workspacePermissionScope: 'conversation' }
            : {}),
        }
      : null;
    const hasDecisionOptions = decisionOptions && Object.keys(decisionOptions).length > 0;
    const response = hasDecisionOptions
      ? await window.electronAPI.decideAgentApproval(
          currentRunId,
          request.approvalId,
          approved,
          decisionOptions
        )
      : await window.electronAPI.decideAgentApproval(currentRunId, request.approvalId, approved);
    if (!response?.ok && pendingApproval === request) {
      setApprovalControlsDisabled(false);
      setMessage(
        elements.approvalMessage,
        responseMessage(response, 'Could not record the decision'),
        true
      );
    }
  } catch {
    if (pendingApproval !== request) return;
    setApprovalControlsDisabled(false);
    setMessage(elements.approvalMessage, 'Could not record the decision', true);
  }
}

async function unlockWalletWithPassword() {
  const request = pendingApproval;
  const password = elements.walletPassword.value;
  if (!request?.wallet || !password) return;
  elements.walletUnlockSubmit.disabled = true;
  try {
    const result = await window.identity.unlock(password);
    if (!result?.success) {
      setMessage(elements.approvalMessage, result?.error || 'Incorrect password', true);
      return;
    }
    elements.walletPassword.value = '';
    elements.walletUnlock.hidden = true;
    await decideApproval(true);
  } catch {
    setMessage(elements.approvalMessage, 'Wallet unlock failed', true);
  } finally {
    elements.walletUnlockSubmit.disabled = false;
  }
}

function formatOperation(operation) {
  return String(operation || 'browser action')
    .replace(/^browser_/, '')
    .replaceAll('_', ' ');
}

function formatToolError(code, operation) {
  const labels = {
    TAB_NOT_FOUND: 'Page is no longer open',
    NAVIGATION_FAILED: 'Page could not be opened',
    WAIT_TIMEOUT: 'Expected page state did not appear',
    STALE_ELEMENT_REFERENCE: 'Page changed before this could run',
    ELEMENT_NOT_FOUND: 'Page element is no longer available',
    ELEMENT_NOT_INTERACTABLE: 'Page element could not be used',
    APPROVAL_REQUIRED: 'Approval is still required',
    POLICY_DENIED: 'Blocked by Freedom policy',
    USER_CANCELLED: 'Not applied',
    FILE_UPLOAD_CANCELLED_BY_USER: 'File selection cancelled by you',
    DOWNLOAD_CANCELLED_BY_USER: 'Download cancelled by you',
    WALLET_REQUEST_CANCELLED_BY_USER: 'Wallet request declined by you',
    CAPABILITY_UNAVAILABLE: 'Browser capability is unavailable',
    INTERNAL_ERROR: 'Browser action failed unexpectedly',
    INVALID_WORKSPACE_REQUEST: 'Workspace request is invalid',
    WORKSPACE_COMMAND_CANCELLED: 'Workspace command was stopped',
    WORKSPACE_COMMAND_FAILED: 'Workspace command exited unsuccessfully',
    WORKSPACE_COMMAND_NOT_FOUND: 'A required command is not available in the workspace shell',
    WORKSPACE_COMMAND_TIMED_OUT: 'Workspace command timed out',
    WORKSPACE_DIRECTORY_UNAVAILABLE: 'Workspace directory does not exist',
    WORKSPACE_EXECUTION_FAILED: 'Workspace command could not be executed',
    WORKSPACE_FILE_TOO_LARGE: 'Workspace file exceeds the supported size limit',
    WORKSPACE_FILE_UNAVAILABLE: 'Workspace file could not be accessed',
    WORKSPACE_FILE_UNSAFE: 'Blocked unsafe workspace path',
    WORKSPACE_PATH_NOT_FOUND: 'Workspace path does not exist',
    WORKSPACE_PATH_TYPE_MISMATCH: 'Workspace path has the wrong file type',
    WORKSPACE_POLICY_FAILED: 'Workspace boundary could not be established',
    WORKSPACE_PROTECTED_PATH: 'Blocked protected workspace path',
    WORKSPACE_RUNTIME_UNAVAILABLE: 'Workspace runtime is unavailable',
    WORKSPACE_SANDBOX_DENIED: 'Blocked by workspace sandbox policy',
    WORKSPACE_WRITE_FAILED: 'Workspace file could not be written',
  };
  if (operation === 'attachment_list') return 'Attached sources could not be listed';
  if (operation === 'attachment_read') return 'Attached source could not be read';
  if (
    ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls', 'workspace_preview'].includes(operation)
  ) {
    return labels[code] || 'Workspace operation failed';
  }
  return labels[code] || 'Browser action failed';
}

function renderTurnOutcome(view, outcome, error) {
  if (!view || !outcome || typeof outcome !== 'object') return;
  if (outcome.verification === 'not_applicable') {
    view.outcome.hidden = true;
    return;
  }
  const icons = { success: '✓', caution: '!', danger: '×', neutral: '•' };
  const tone = Object.hasOwn(icons, outcome.tone) ? outcome.tone : 'neutral';
  view.outcome.className = `agent-turn-outcome ${tone}`;
  view.outcomeIcon.textContent = icons[tone];
  view.outcomeHeadline.textContent = outcome.headline || 'Run finished';
  view.outcomeDetail.textContent = outcome.detail || '';
  view.outcomeNextStep.textContent = outcome.nextStep ? `Next: ${outcome.nextStep}` : '';
  view.outcomeNextStep.hidden = !outcome.nextStep;
  view.outcomeTechnicalDetail.textContent = outcome.technicalDetails || '';
  view.outcomeTechnical.hidden = !outcome.technicalDetails;
  view.outcomeTechnical.open = false;
  const canRetry =
    outcome.canRetry === true &&
    error?.code === 'PROVIDER_ERROR' &&
    typeof view.userText === 'string' &&
    Boolean(view.userText.trim());
  view.outcomeActions.hidden = !canRetry;
  view.outcomeRetry.hidden = !canRetry;
  view.outcomeRetry.disabled = false;
  view.outcome.hidden = false;
}

function outcomeSummaryLabel(outcome) {
  if (outcome?.verification === 'artifact_available') return 'Download verified';
  if (outcome?.verification === 'download_cancelled') return 'Download cancelled';
  if (outcome?.verification === 'result_observed') return 'Result checked';
  if (outcome?.verification === 'actions_recorded') return 'Actions recorded';
  if (outcome?.verification === 'browser_observed') return 'Browser inspected';
  if (outcome?.verification === 'nodes_inspected') return 'Node status checked';
  if (outcome?.verification === 'diagnostics_inspected') return 'Diagnostics inspected';
  if (outcome?.verification === 'attachments_inspected') return 'Sources inspected';
  if (outcome?.verification === 'swarm_publication_verified') return 'Publication verified';
  if (outcome?.verification === 'swarm_publication_completed') return 'Published to Swarm';
  if (outcome?.verification === 'swarm_publication_in_flight') return 'Publication still running';
  if (outcome?.verification === 'model_only') return 'Agent reported';
  if (outcome?.kind === 'recovery') return 'Needs recovery';
  if (outcome?.kind === 'interrupted') return 'Stopped';
  return '';
}

function formatArtifactBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KB`;
  return `${(value / 1_048_576).toFixed(value < 10_485_760 ? 1 : 0)} MB`;
}

function renderArtifact(runId, artifact) {
  const view = turnView(runId);
  if (
    !view ||
    !artifact ||
    !/^artifact_[a-f0-9]{20}$/.test(artifact.artifactId) ||
    typeof artifact.filename !== 'string' ||
    artifact.state !== 'completed' ||
    artifact.available !== true
  ) {
    return;
  }
  if (view.artifactList.querySelector(`[data-artifact-id="${artifact.artifactId}"]`)) return;
  const card = document.createElement('div');
  card.className = 'agent-artifact';
  card.dataset.artifactId = artifact.artifactId;
  const copy = document.createElement('div');
  copy.className = 'agent-artifact-copy';
  const name = document.createElement('strong');
  name.textContent = artifact.filename;
  const meta = document.createElement('span');
  meta.textContent = `${formatArtifactBytes(artifact.bytes)} · ${artifact.location === 'chosen_location' ? 'Chosen location' : 'Downloads'}`;
  copy.appendChild(name);
  copy.appendChild(meta);
  const actions = document.createElement('div');
  actions.className = 'agent-artifact-actions';
  for (const [label, action] of [
    ['Open', () => window.electronAPI.openAgentArtifact(artifact.artifactId)],
    ['Show', () => window.electronAPI.showAgentArtifactInFolder(artifact.artifactId)],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = artifact.available !== true;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await action();
        if (!result?.success) {
          setMessage(elements.runMessage, result?.error || 'File unavailable', true);
        }
      } finally {
        button.disabled = artifact.available !== true;
      }
    });
    actions.appendChild(button);
  }
  card.appendChild(copy);
  card.appendChild(actions);
  view.artifactList.appendChild(card);
  view.artifactList.hidden = false;
}

function renderPublication(runId, publication) {
  const view = turnView(runId);
  if (
    !view ||
    !publication ||
    !/^swarm_pub_[a-f0-9]{24}$/.test(publication.publicationId) ||
    publication.state !== 'completed' ||
    typeof publication.name !== 'string' ||
    !/^bzz:\/\/[a-f0-9]{64}$/.test(publication.bzzUrl)
  ) {
    return;
  }
  if (view.artifactList.querySelector(`[data-publication-id="${publication.publicationId}"]`)) {
    return;
  }
  const card = document.createElement('div');
  card.className = 'agent-artifact agent-publication';
  card.dataset.publicationId = publication.publicationId;
  const copy = document.createElement('div');
  copy.className = 'agent-artifact-copy';
  const name = document.createElement('strong');
  name.textContent = publication.kind === 'text' ? 'Text' : publication.name;
  const meta = document.createElement('span');
  meta.textContent = publication.verified
    ? 'Swarm · retrieval verified'
    : 'Swarm · published, verification pending';
  copy.appendChild(name);
  copy.appendChild(meta);
  const actions = document.createElement('div');
  actions.className = 'agent-artifact-actions';
  for (const [label, action] of [
    ['Open', () => window.electronAPI.openAgentPublication(publication.bzzUrl)],
    ['Copy URL', () => window.electronAPI.copyText(publication.bzzUrl)],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await action();
        if (result?.success === false) {
          setMessage(elements.runMessage, result.error || 'Publication unavailable', true);
        }
      } finally {
        button.disabled = false;
      }
    });
    actions.appendChild(button);
  }
  card.appendChild(copy);
  card.appendChild(actions);
  view.artifactList.appendChild(card);
  view.artifactList.hidden = false;
}

function addToolRow(event) {
  const view = turnView(event.runId);
  if (!view || typeof event.toolCallId !== 'string') return;
  const row = document.createElement('li');
  row.className = 'agent-tool-item';
  const state = document.createElement('span');
  state.className = 'agent-tool-state';
  state.textContent = '•';
  const label = document.createElement('span');
  label.textContent = event.intent || event.label || formatOperation(event.operation);
  const approval = document.createElement('span');
  approval.className = 'agent-tool-approval';
  approval.hidden = true;
  row.appendChild(state);
  row.appendChild(label);
  row.appendChild(approval);
  view.toolList.appendChild(row);
  view.activity.hidden = false;
  view.activity.open = true;
  view.actionCount += 1;
  toolRows.set(`${event.runId}:${event.toolCallId}`, { row, state, label, approval });
  updateToolApproval(event.runId, event.toolCallId, event.approval);
}

function updateToolApproval(runId, toolCallId, decision) {
  if (typeof toolCallId !== 'string') return;
  const record = toolRows.get(`${runId}:${toolCallId}`);
  if (!record) return;
  const labels = {
    requested: 'Approval needed',
    approved: 'Approved',
    declined: 'Declined',
    withdrawn: 'Withdrawn',
  };
  record.approval.textContent = labels[decision] || '';
  record.approval.hidden = !labels[decision];
}

function attachmentDisplayKey(event) {
  const receipt = event?.attachment;
  if (event?.status !== 'succeeded' || !receipt || !['list', 'read'].includes(receipt.action)) {
    return '';
  }
  const target = receipt.resourceId || 'conversation';
  const path = receipt.relativePath || receipt.name || '';
  return `${event.runId}:${receipt.action}:${target}:${path}`;
}

function finishToolRow(event) {
  let record = toolRows.get(`${event.runId}:${event.toolCallId}`);
  if (!record) return;
  const displayKey = attachmentDisplayKey(event);
  const existingAttachmentRow = displayKey ? attachmentDisplayRows.get(displayKey) : null;
  if (existingAttachmentRow && existingAttachmentRow !== record) {
    record.row.remove();
    record = existingAttachmentRow;
    toolRows.set(`${event.runId}:${event.toolCallId}`, record);
  } else if (displayKey) {
    attachmentDisplayRows.set(displayKey, record);
  }
  const downloadCancelled = event.errorCode === 'DOWNLOAD_CANCELLED_BY_USER';
  const uploadCancelled = event.errorCode === 'FILE_UPLOAD_CANCELLED_BY_USER';
  const publicationCancelled = event.errorCode === 'SWARM_PUBLICATION_CANCELLED_BY_USER';
  const userCancelled = downloadCancelled || uploadCancelled || publicationCancelled;
  record.label.textContent = event.label || record.label.textContent;
  record.state.textContent = userCancelled ? '•' : event.status === 'failed' ? '×' : '✓';
  record.row.classList.toggle('cancelled', userCancelled);
  record.row.classList.toggle('failed', event.status === 'failed' && !userCancelled);
  if (event.status === 'failed') {
    record.row.title = formatToolError(event.errorCode, event.operation);
    record.label.textContent = `${record.label.textContent} — ${formatToolError(event.errorCode, event.operation)}`;
  }
  updateToolApproval(event.runId, event.toolCallId, event.approval);
  if (userCancelled) {
    record.approval.textContent = 'Cancelled by you';
    record.approval.hidden = false;
  }
  if (event.artifact) renderArtifact(event.runId, event.artifact);
  if (event.publication) renderPublication(event.runId, event.publication);
}

function updateToolProgress(event) {
  const record = toolRows.get(`${event.runId}:${event.toolCallId}`);
  if (!record) return;
  if (event.operation === 'swarm_publish' && event.publication) {
    const publication = event.publication;
    const subject = publicationSubject(publication);
    record.label.textContent =
      publication.state === 'verifying'
        ? `Verifying ${subject}`
        : publication.state === 'completed'
          ? `Published ${subject} to Swarm`
          : publication.state === 'failed'
            ? `Publication failed for ${subject}`
            : `Publishing ${subject}${Number.isSafeInteger(event.progress) ? ` · ${event.progress}%` : ''}`;
    if (publication.state === 'completed') renderPublication(event.runId, publication);
    return;
  }
  const received = Math.max(0, Number(event.receivedBytes) || 0);
  const total = Math.max(0, Number(event.totalBytes) || 0);
  const progress = total > 0 ? ` · ${Math.min(100, Math.round((received / total) * 100))}%` : '';
  const cancelled = event.state === 'cancelled';
  record.label.textContent = cancelled ? 'Download cancelled' : `Downloading${progress}`;
  record.row.classList.toggle('cancelled', cancelled);
  if (event.artifact) renderArtifact(event.runId, event.artifact);
}

function finishTurnView(runId, event = {}) {
  const view = turnView(runId);
  if (!view) return;
  clearLiveStatus(runId);
  const actionCount = Number.isSafeInteger(event.actionCount)
    ? event.actionCount
    : view.actionCount;
  if (actionCount > 0) {
    view.activity.hidden = false;
    view.activity.open = false;
    const outcomeLabel = outcomeSummaryLabel(event.outcome);
    view.activitySummary.textContent = `Worked for ${formatDuration(event.durationMs)} · ${actionCount} ${actionCount === 1 ? 'action' : 'actions'}${outcomeLabel ? ` · ${outcomeLabel}` : ''}`;
  } else {
    view.activity.hidden = true;
  }
  renderTurnOutcome(view, event.outcome, event.error);
  if (event.status === 'completed') renderAssistantMarkdown(view);
}

function applyReadyConversationState(state) {
  if (!state?.conversationId) return false;
  workspaceProjectionGeneration += 1;
  applyWorkspaceProjection(state);
  if (Object.hasOwn(APPROVAL_MODE_LABELS, state.approvalMode)) {
    setApprovalMode(state.approvalMode, { force: true });
  }
  currentConversationId = state.conversationId;
  currentRunId = null;
  lastFinishedRunId = null;
  stopRequestedRunId = null;
  conversationRendererTabId = Number.isSafeInteger(state.rendererTabId)
    ? state.rendererTabId
    : null;
  dismissedPageContextTabId = null;
  const transcript = Array.isArray(state.transcript) ? state.transcript : [];
  conversationResources = Array.isArray(state.resources) ? state.resources : [];
  setConversationTitle(state.title || transcript[0]?.userText || 'Current task');
  restoreTranscript(transcript);
  setAgentControlledTab(null);
  setRunState('idle', 'Ready');
  renderTaskPages();
  renderSessionSidebar();
  renderPageContext();
  return true;
}

async function openSavedSession(conversationId) {
  if (currentRunStatus !== 'idle' || conversationId === currentConversationId) return;
  setMessage(elements.runMessage, 'Opening saved session…');
  try {
    const response = await window.electronAPI.openAgentSession(conversationId);
    if (!response?.ok || !applyReadyConversationState(response.state)) {
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not open the saved session'),
        true
      );
      return;
    }
    setMessage(
      elements.runMessage,
      response.state.runtimeAvailable
        ? 'Live conversation and workspace restored.'
        : 'Saved conversation restored. Agent will inspect a fresh page before continuing.'
    );
    elements.prompt.focus();
    void refreshSessionHistory();
  } catch {
    setMessage(elements.runMessage, 'Could not open the saved session', true);
  }
}

async function claimAgentOwnedTab(rendererTabId) {
  if (!Number.isSafeInteger(rendererTabId) || rendererTabId < 1) return;
  if (currentRunId && currentRunStatus === 'running') {
    requestTakeoverConfirmation(rendererTabId);
    return;
  }
  if (currentRunId && ['pausing', 'resuming', 'stopping'].includes(currentRunStatus)) return;
  try {
    const response = await window.electronAPI.claimAgentTab(rendererTabId);
    if (!response?.ok) {
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not claim the Agent tab'),
        true
      );
      return;
    }
    applyWorkspaceProjection(response.state);
    if (currentRunId && response.state?.runId !== currentRunId) {
      currentRunId = null;
      setAgentControlledTab(null);
      setRunState('idle', 'Claimed');
    }
    setMessage(elements.runMessage, 'This tab is now yours. Agent no longer controls it.');
  } catch {
    setMessage(elements.runMessage, 'Could not claim the Agent tab', true);
  }
}

async function renameSavedSession(session) {
  if (currentRunStatus !== 'idle') return;
  const title = window.prompt('Rename session', session.title || '');
  if (title === null || !title.trim() || title.trim() === session.title) return;
  try {
    const response = await window.electronAPI.renameAgentSession(
      session.conversationId,
      title.trim()
    );
    if (!response?.ok) {
      setMessage(elements.runMessage, responseMessage(response, 'Could not rename session'), true);
      return;
    }
    if (session.conversationId === currentConversationId) {
      setConversationTitle(response.session?.title || title.trim());
    }
    await refreshSessionHistory();
  } catch {
    setMessage(elements.runMessage, 'Could not rename session', true);
  }
}

async function deleteSavedSession(session) {
  if (currentRunStatus !== 'idle') return;
  if (!window.confirm(`Delete “${session.title}”? This cannot be undone.`)) return;
  try {
    const response = await window.electronAPI.deleteAgentSession(session.conversationId);
    if (!response?.ok) {
      setMessage(elements.runMessage, responseMessage(response, 'Could not delete session'), true);
      return;
    }
    if (session.conversationId === currentConversationId) applyConversationCleared();
    await refreshSessionHistory();
  } catch {
    setMessage(elements.runMessage, 'Could not delete session', true);
  }
}

function applyConversationCleared() {
  workspaceProjectionGeneration += 1;
  currentConversationId = null;
  conversationRendererTabId = null;
  dismissedPageContextTabId = null;
  pendingPromptText = '';
  conversationResources = [];
  currentRunId = null;
  lastFinishedRunId = null;
  stopRequestedRunId = null;
  setConversationTitle('New task');
  setAgentControlledTab(null);
  taskTabProjection = [];
  renderTaskPages();
  resetConversationUi();
  setRunState('idle', 'Idle');
  renderSessionSidebar();
  void refreshSessionHistory();
  void refreshWorkspaceProjection();
}

function handleAgentEvent(event) {
  if (event?.type === 'conversation_cleared') {
    if (!currentConversationId || event.conversationId === currentConversationId) {
      applyConversationCleared();
    }
    return;
  }
  if (event?.type === 'conversation_resources_changed') {
    if (event.conversationId === currentConversationId && Array.isArray(event.resources)) {
      conversationResources = event.resources;
      renderPageContext();
    }
    return;
  }
  if (event?.type === 'conversation_approval_mode_changed') {
    if (event.conversationId === currentConversationId) {
      setApprovalMode(event.approvalMode, { force: true });
    }
    return;
  }
  if (!event || typeof event.runId !== 'string') return;
  if (
    currentConversationId &&
    typeof event.conversationId === 'string' &&
    event.conversationId !== currentConversationId
  ) {
    return;
  }
  if (currentRunId && currentRunId !== event.runId) return;
  if (event.type === 'run_started') {
    if (!currentConversationId && typeof event.userText === 'string') {
      setConversationTitle(event.userText);
    }
    if (
      typeof event.conversationId === 'string' &&
      event.conversationId !== currentConversationId
    ) {
      workspaceProjectionGeneration += 1;
      currentConversationId = event.conversationId;
    }
    if (Object.hasOwn(APPROVAL_MODE_LABELS, event.approvalMode)) {
      setApprovalMode(event.approvalMode, { force: true });
    }
    currentRunId = event.runId;
    lastFinishedRunId = null;
    if (!turnView(event.runId)) {
      createTurnView({
        runId: event.runId,
        userText: typeof event.userText === 'string' ? event.userText : pendingPromptText,
        assistantText: '',
        attachments: Array.isArray(event.attachments) ? event.attachments : [],
      });
    }
    if (Array.isArray(event.attachments) && event.attachments.length) {
      const attachedIds = new Set(event.attachments.map((item) => item.resourceId));
      conversationResources = [
        ...conversationResources.filter((item) => !attachedIds.has(item.resourceId)),
        ...event.attachments,
      ];
      pendingAttachments = [];
      renderPageContext();
    }
    pendingPromptText = '';
    setRunState('running', 'Running');
    setLiveStatus(event.runId, 'Thinking…');
    elements.emptyState.hidden = true;
    setMessage(
      elements.runMessage,
      conversationRendererTabId
        ? 'Agent can use the page you shared and any tabs it opens.'
        : 'Agent can use only the tabs it opens for this conversation.'
    );
    void refreshSessionHistory();
    return;
  }
  if (event.type === 'tool_finished' && event.runId !== currentRunId) {
    finishToolRow(event);
    void refreshWorkspaceProjection();
    void refreshSessionHistory();
    return;
  }
  if (!currentRunId) return;
  if (event.type === 'run_thinking') {
    setLiveStatus(event.runId, 'Thinking…');
  } else if (event.type === 'run_responding') {
    setLiveStatus(event.runId, 'Responding…');
  } else if (
    event.type === 'run_progress' &&
    event.source === 'reasoning_heading' &&
    typeof event.message === 'string'
  ) {
    setLiveStatus(event.runId, event.message);
  } else if (
    event.type === 'workspace_phase' &&
    currentRunStatus === 'running' &&
    typeof event.message === 'string'
  ) {
    setLiveStatus(event.runId, event.message);
  } else if (event.type === 'workspace_changed') {
    void refreshWorkspaceProjection();
  } else if (event.type === 'guidance_queued') {
    createGuidanceView(event.runId, event.guidance);
    setMessage(
      elements.runMessage,
      pendingApproval
        ? 'Guidance queued. Decide the pending approval separately.'
        : 'Guidance queued for Agent.'
    );
  } else if (
    ['guidance_applying', 'guidance_applied', 'guidance_cancelled'].includes(event.type) &&
    typeof event.guidanceId === 'string'
  ) {
    const status = event.type.replace('guidance_', '');
    updateGuidanceView(event.runId, event.guidanceId, status);
    if (status === 'applying') {
      setMessage(elements.runMessage, 'Applying your guidance…');
      setLiveStatus(event.runId, 'Applying your guidance…');
    }
  } else if (event.type === 'assistant_text_delta' && typeof event.text === 'string') {
    const view = turnView(event.runId);
    if (!view) return;
    view.assistantText += event.text;
    view.output.textContent = view.assistantText;
    setLiveStatus(event.runId, 'Responding…');
    view.section.scrollIntoView?.({ block: 'end' });
    elements.emptyState.hidden = true;
  } else if (event.type === 'tool_started') {
    addToolRow(event);
    const view = turnView(event.runId);
    if (view && event.intent) view.activitySummary.textContent = event.intent;
    setMessage(elements.runMessage, event.intent || 'Agent is working in the browser…');
    setLiveStatus(event.runId, event.intent || 'Working…');
    elements.emptyState.hidden = true;
  } else if (event.type === 'tool_finished') {
    finishToolRow(event);
    if (event.status === 'failed') {
      setMessage(
        elements.runMessage,
        event.errorCode === 'DOWNLOAD_CANCELLED_BY_USER'
          ? 'Download cancelled by you. Agent will not retry it unless you ask.'
          : event.errorCode === 'FILE_UPLOAD_CANCELLED_BY_USER'
            ? 'File selection cancelled by you. Agent will not retry it unless you ask.'
            : `${formatToolError(event.errorCode, event.operation)}. Agent is deciding how to recover.`
      );
      setLiveStatus(event.runId, 'Recovering from an issue…');
    } else if (event.label) {
      setMessage(elements.runMessage, event.label);
      setLiveStatus(event.runId, 'Checking the result…');
    } else {
      setLiveStatus(event.runId, 'Checking the result…');
    }
    void refreshWorkspaceProjection();
  } else if (event.type === 'tool_progress') {
    updateToolProgress(event);
    if (event.operation === 'swarm_publish') {
      const name = publicationSubject(event.publication);
      const label =
        event.state === 'verifying'
          ? `Verifying ${name} on Swarm…`
          : event.state === 'completed'
            ? `Published ${name} to Swarm.`
            : `Publishing ${name}${Number.isSafeInteger(event.progress) ? ` · ${event.progress}%` : ''}…`;
      setMessage(elements.runMessage, label);
      setLiveStatus(event.runId, label);
    } else if (event.state === 'cancelled') {
      setMessage(elements.runMessage, 'Download cancelled by you.');
      setLiveStatus(event.runId, 'Continuing after the cancelled download…');
    } else {
      const received = formatArtifactBytes(event.receivedBytes);
      const total = event.totalBytes > 0 ? ` of ${formatArtifactBytes(event.totalBytes)}` : '';
      setMessage(elements.runMessage, `Downloading ${received}${total}…`);
      setLiveStatus(event.runId, `Downloading ${received}${total}…`);
    }
  } else if (event.type === 'run_retrying') {
    const delaySeconds = Math.max(1, Math.ceil((Number(event.delayMs) || 0) / 1_000));
    setRunState('running', 'Reconnecting');
    setMessage(
      elements.runMessage,
      `${event.message || 'The model provider request failed.'} Retrying automatically (${event.attempt} of ${event.maxAttempts}) in ${delaySeconds}s…`
    );
    setLiveStatus(event.runId, `Reconnecting · attempt ${event.attempt} of ${event.maxAttempts}…`);
  } else if (event.type === 'run_retry_recovered') {
    setRunState('running', 'Running');
    setMessage(elements.runMessage, 'Model connection restored. Agent is continuing…');
    setLiveStatus(event.runId, 'Connection restored. Continuing…');
  } else if (event.type === 'context_compaction_started') {
    setMessage(elements.runMessage, 'Making room for more conversation…');
    setLiveStatus(event.runId, 'Making room for more conversation…');
  } else if (event.type === 'context_compaction_finished') {
    setMessage(
      elements.runMessage,
      event.status === 'failed'
        ? 'Could not compact the conversation; continuing with available context.'
        : 'Conversation compacted. Continuing…',
      event.status === 'failed'
    );
    setLiveStatus(
      event.runId,
      event.status === 'failed' ? 'Continuing with available context…' : 'Continuing…'
    );
  } else if (event.type === 'approval_requested') {
    updateToolApproval(event.runId, event.toolCallId, 'requested');
    renderApproval(event);
    setRunState('running', 'Approval needed');
    setLiveStatus(event.runId, 'Waiting for your approval', { active: false });
  } else if (
    event.type === 'approval_resolved' &&
    pendingApproval?.approvalId === event.approvalId
  ) {
    updateToolApproval(event.runId, event.toolCallId, event.decision);
    clearApproval();
    setRunState('running', 'Running');
    setLiveStatus(event.runId, 'Continuing…');
  } else if (event.type === 'run_pausing') {
    setRunState('pausing', 'Taking over');
    setMessage(elements.runMessage, 'Taking over after the current browser operation settles…');
    setLiveStatus(event.runId, 'Finishing the current action…');
  } else if (event.type === 'run_paused') {
    clearApproval();
    setRunState('paused', 'You’re in control');
    setMessage(elements.runMessage, 'Agent is waiting while you use its pages.');
    setLiveStatus(event.runId, 'Waiting while you use the page', { active: false });
  } else if (event.type === 'run_resuming') {
    setRunState('resuming', 'Resuming');
    setMessage(elements.runMessage, 'Checking the page before the agent continues…');
    setLiveStatus(event.runId, 'Checking the page before continuing…');
  } else if (event.type === 'run_resumed') {
    setRunState('running', 'Running');
    setMessage(elements.runMessage, 'Agent is re-reading the current page before acting.');
    setLiveStatus(event.runId, 'Reading the page again…');
  } else if (event.type === 'run_finished') {
    const status = event.status || 'finished';
    const wasStopped = status === 'cancelled' && stopRequestedRunId === event.runId;
    clearApproval();
    setRunState(
      'idle',
      wasStopped
        ? 'Stopped'
        : status === 'completed'
          ? 'Complete'
          : event.error?.code === 'PROVIDER_ERROR'
            ? 'Provider issue'
            : status
    );
    if (wasStopped) {
      setMessage(elements.runMessage, 'Agent stopped.');
    } else if (event.error?.message && event.error.code !== 'PROVIDER_ERROR') {
      setMessage(elements.runMessage, event.error.message, true);
    } else {
      setMessage(elements.runMessage);
    }
    finishTurnView(event.runId, event);
    lastFinishedRunId = event.runId;
    currentRunId = null;
    stopRequestedRunId = null;
    setAgentControlledTab(null);
    void refreshWorkspaceProjection();
    void refreshSessionHistory();
  }
}

async function startRun(options = {}) {
  const explicitPrompt =
    typeof options.prompt === 'string' && options.prompt.trim() ? options.prompt.trim() : null;
  const prompt = explicitPrompt || elements.prompt.value.trim();
  if (!prompt) {
    setMessage(elements.runMessage, 'Describe what you want the agent to do', true);
    return false;
  }
  const sharedPage = currentConversationId ? null : pageContextTab();
  const rendererTabId = currentConversationId
    ? conversationRendererTabId
    : Number.isSafeInteger(sharedPage?.id)
      ? sharedPage.id
      : null;
  const startsConversation = !currentConversationId;
  if (startsConversation) setConversationTitle(prompt);
  pendingPromptText = prompt;
  if (!explicitPrompt) elements.prompt.value = '';
  if (!currentConversationId) conversationRendererTabId = rendererTabId;
  if (conversationRendererTabId) setAgentControlledTab(conversationRendererTabId);
  setRunState('starting', 'Starting');
  setMessage(elements.runMessage);
  try {
    const attachmentIds = explicitPrompt
      ? []
      : pendingAttachments.map((attachment) => attachment.selectionId);
    const response = attachmentIds.length
      ? await window.electronAPI.startAgent(rendererTabId, prompt, approvalMode, attachmentIds)
      : await window.electronAPI.startAgent(rendererTabId, prompt, approvalMode);
    if (!response?.ok) {
      currentRunId = null;
      if (!currentConversationId) {
        conversationRendererTabId = null;
        setAgentControlledTab(null);
        setConversationTitle('New task');
      }
      if (!elements.prompt.value) elements.prompt.value = pendingPromptText;
      pendingPromptText = '';
      setRunState('idle', 'Idle');
      setMessage(elements.runMessage, responseMessage(response, 'Could not start the agent'), true);
      focusComposer({ preserveExplicitFocus: true });
      return false;
    }
    if (response.conversationId && response.conversationId !== currentConversationId) {
      workspaceProjectionGeneration += 1;
      currentConversationId = response.conversationId;
    }
    renderPageContext();
    void refreshWorkspaceProjection();
    pendingPromptText = '';
    void refreshSessionHistory();
    if (lastFinishedRunId !== response.runId) {
      currentRunId = response.runId;
      setRunState('running', 'Running');
    } else {
      setRunState('idle', elements.runStatus.textContent || 'Complete');
    }
    focusComposer({ preserveExplicitFocus: true });
    return true;
  } catch {
    currentRunId = null;
    if (!currentConversationId) {
      conversationRendererTabId = null;
      setAgentControlledTab(null);
      setConversationTitle('New task');
    }
    if (!elements.prompt.value) elements.prompt.value = pendingPromptText;
    pendingPromptText = '';
    setRunState('idle', 'Idle');
    setMessage(elements.runMessage, 'Could not start the agent', true);
    focusComposer({ preserveExplicitFocus: true });
    return false;
  }
}

async function retryProviderTurn(view) {
  if (
    currentRunStatus !== 'idle' ||
    !currentConversationId ||
    !view ||
    typeof view.userText !== 'string' ||
    !view.userText.trim()
  ) {
    return;
  }
  view.outcomeRetry.disabled = true;
  view.outcomeRetry.textContent = 'Retrying…';
  const started = await startRun({ prompt: view.userText });
  if (!started) {
    view.outcomeRetry.disabled = false;
    view.outcomeRetry.textContent = 'Retry';
  }
}

async function steerRun() {
  if (!currentRunId || currentRunStatus !== 'running') return;
  const prompt = elements.prompt.value.trim();
  if (!prompt) return;
  const runId = currentRunId;
  elements.prompt.value = '';
  updateSendAvailability();
  focusComposer();
  try {
    const response = await window.electronAPI.steerAgent(runId, prompt);
    if (!response?.ok && currentRunId === runId) {
      if (!elements.prompt.value) elements.prompt.value = prompt;
      updateSendAvailability();
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not send guidance to Agent'),
        true
      );
    }
  } catch {
    if (currentRunId !== runId) return;
    if (!elements.prompt.value) elements.prompt.value = prompt;
    updateSendAvailability();
    setMessage(elements.runMessage, 'Could not send guidance to Agent', true);
  }
}

function submitComposer() {
  if (currentRunStatus === 'running') {
    if (elements.prompt.value.trim()) {
      void steerRun();
    } else {
      void stopRun();
    }
  } else if (currentRunStatus === 'paused') {
    void resumeRun(elements.prompt.value.trim());
  } else if (currentRunStatus === 'idle') {
    void startRun();
  }
}

async function clearConversation() {
  if (!currentConversationId || currentRunStatus !== 'idle') return;
  elements.newChat.disabled = true;
  setMessage(elements.runMessage, 'Starting a new chat…');
  try {
    const response = await window.electronAPI.clearAgentConversation();
    if (!response?.ok) {
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not start a new chat'),
        true
      );
      elements.newChat.disabled = false;
      return;
    }
    applyConversationCleared();
    elements.prompt.focus();
  } catch {
    setMessage(elements.runMessage, 'Could not start a new chat', true);
    elements.newChat.disabled = false;
  }
}

async function startNewSessionFromSidebar() {
  if (currentRunStatus !== 'idle') return;
  if (currentConversationId) {
    await clearConversation();
    return;
  }
  elements.prompt.focus();
}

async function takeOverRun() {
  if (!currentRunId || currentRunStatus !== 'running') return;
  const runId = currentRunId;
  setTakeoverDialogOpen(false);
  setRunState('pausing', 'Taking over');
  setMessage(elements.runMessage, 'Taking over…');
  setLiveStatus(runId, 'Finishing the current action…');
  try {
    const response = await window.electronAPI.pauseAgent(runId);
    if ((!response?.ok || response.paused !== true) && currentRunId === runId) {
      setRunState('running', 'Running');
      setMessage(elements.runMessage, responseMessage(response, 'Could not take over'), true);
      setLiveStatus(runId, 'Continuing…');
    }
  } catch {
    if (currentRunId !== runId) return;
    setRunState('running', 'Running');
    setMessage(elements.runMessage, 'Could not take over', true);
    setLiveStatus(runId, 'Continuing…');
  }
}

async function resumeRun(instruction = '') {
  if (!currentRunId || currentRunStatus !== 'paused') return;
  const runId = currentRunId;
  const guidance = typeof instruction === 'string' ? instruction.trim() : '';
  if (guidance) elements.prompt.value = '';
  setRunState('resuming', 'Resuming');
  setMessage(elements.runMessage, 'Checking the page before the agent continues…');
  setLiveStatus(runId, 'Checking the page before continuing…');
  try {
    const response = await window.electronAPI.resumeAgent(runId, guidance || undefined);
    if ((!response?.ok || response.resumed !== true) && currentRunId === runId) {
      if (guidance && !elements.prompt.value) elements.prompt.value = guidance;
      setRunState('paused', 'You’re in control');
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not resume the agent'),
        true
      );
      setLiveStatus(runId, 'Waiting while you use the page', { active: false });
      focusComposer({ preserveExplicitFocus: true });
    }
  } catch {
    if (currentRunId !== runId) return;
    if (guidance && !elements.prompt.value) elements.prompt.value = guidance;
    setRunState('paused', 'You’re in control');
    setMessage(elements.runMessage, 'Could not resume the agent', true);
    setLiveStatus(runId, 'Waiting while you use the page', { active: false });
    focusComposer({ preserveExplicitFocus: true });
  }
}

async function stopRun() {
  if (!currentRunId || currentRunStatus !== 'running') return;
  const previousStatus = currentRunStatus;
  const approvalAtStop = pendingApproval;
  if (approvalAtStop) {
    setApprovalControlsDisabled(true);
    setMessage(elements.approvalMessage, 'Stopping…');
  }
  stopRequestedRunId = currentRunId;
  setTakeoverDialogOpen(false);
  setRunState('stopping', 'Stopping');
  setMessage(elements.runMessage, 'Stopping Agent…');
  setLiveStatus(currentRunId, 'Stopping…');
  try {
    const response = await window.electronAPI.stopAgent(currentRunId);
    if (!response?.ok) {
      stopRequestedRunId = null;
      setRunState(previousStatus, 'Running');
      if (pendingApproval === approvalAtStop) {
        setApprovalControlsDisabled(false);
        setMessage(elements.approvalMessage, 'Agent is waiting');
      }
      setMessage(elements.runMessage, responseMessage(response, 'Could not stop the agent'), true);
      setLiveStatus(currentRunId, 'Continuing…');
    }
  } catch {
    stopRequestedRunId = null;
    setRunState(previousStatus, 'Running');
    if (pendingApproval === approvalAtStop) {
      setApprovalControlsDisabled(false);
      setMessage(elements.approvalMessage, 'Agent is waiting');
    }
    setMessage(elements.runMessage, 'Could not stop the agent', true);
    setLiveStatus(currentRunId, 'Continuing…');
  }
}

async function restoreRunState() {
  const generation = workspaceProjectionGeneration;
  const expectedConversationId = currentConversationId;
  try {
    const response = await window.electronAPI.getAgentState();
    const state = response?.ok ? response.state : null;
    if (
      generation !== workspaceProjectionGeneration ||
      expectedConversationId !== currentConversationId
    ) {
      return;
    }
    applyWorkspaceProjection(state);
    if (!state?.conversationId) return;
    applyReadyConversationState(state);

    if (state.runId && state.status !== 'ready') {
      currentRunId = state.runId;
      if (conversationRendererTabId) setAgentControlledTab(conversationRendererTabId);
      const restoredStatus = ['paused', 'pausing', 'resuming'].includes(state.status)
        ? state.status
        : 'running';
      const restoredLabel =
        restoredStatus === 'paused'
          ? 'You’re in control'
          : restoredStatus === 'pausing'
            ? 'Taking over'
            : restoredStatus === 'resuming'
              ? 'Resuming'
              : 'Running';
      setRunState(restoredStatus, restoredLabel);
      setMessage(elements.runMessage, 'This run began before the panel was loaded');
      setLiveStatus(
        state.runId,
        restoredStatus === 'paused'
          ? 'Waiting while you use the page'
          : restoredStatus === 'pausing'
            ? 'Finishing the current action…'
            : restoredStatus === 'resuming'
              ? 'Checking the page before continuing…'
              : 'Working…',
        { active: restoredStatus !== 'paused' }
      );
      if (state.pendingApproval) {
        renderApproval(state.pendingApproval);
        setRunState('running', 'Approval needed');
        setLiveStatus(state.runId, 'Waiting for your approval', { active: false });
      }
    } else {
      setRunState('idle', 'Ready');
    }
  } catch {
    // Idle is the safe renderer default when lifecycle state cannot be restored.
  }
}

export function initAgentUi(options = {}) {
  elements = {
    toggle: byId('agent-toggle-btn'),
    panel: byId('agent-sidebar'),
    close: byId('agent-sidebar-close'),
    agentFirstToggle: byId('agent-first-toggle'),
    agentFirstTitlebar: byId('agent-first-titlebar'),
    agentFirstTitle: byId('agent-first-title'),
    browserReturn: byId('agent-first-browser-return'),
    sessionSidebarToggle: byId('agent-session-sidebar-toggle'),
    workspaceSidebarToggle: byId('agent-workspace-sidebar-toggle'),
    sessionSidebar: byId('agent-session-sidebar'),
    sessionResizer: byId('agent-session-resizer'),
    pageSurface: byId('agent-page-surface'),
    workspaceResizer: byId('agent-workspace-resizer'),
    sessionNewChat: byId('agent-session-new-chat'),
    sessionList: byId('agent-session-list'),
    sessionHistoryEmpty: byId('agent-session-history-empty'),
    taskPages: byId('agent-task-pages'),
    taskPageCount: byId('agent-task-page-count'),
    taskPageList: byId('agent-task-page-list'),
    taskPagesEmpty: byId('agent-task-pages-empty'),
    taskPagesNote: byId('agent-task-pages-note'),
    workspaceNav: byId('agent-workspace-nav'),
    workspaceBack: byId('agent-workspace-back'),
    workspaceForward: byId('agent-workspace-forward'),
    workspaceReload: byId('agent-workspace-reload'),
    workspaceAddressHost: byId('agent-workspace-address-host'),
    back: byId('agent-sidebar-back'),
    title: byId('agent-sidebar-title'),
    subtitle: byId('agent-sidebar-subtitle'),
    loadingView: byId('agent-loading-view'),
    setupView: byId('agent-setup-view'),
    workspaceView: byId('agent-workspace-view'),
    connectedProviders: byId('agent-connected-providers'),
    connectedProviderList: byId('agent-connected-provider-list'),
    provider: byId('agent-provider-select'),
    providerStatus: byId('agent-provider-status'),
    providerPrivacy: byId('agent-provider-privacy'),
    hostedFields: byId('agent-hosted-fields'),
    apiKeyField: byId('agent-api-key-field'),
    subscriptionFields: byId('agent-subscription-fields'),
    ollamaFields: byId('agent-ollama-fields'),
    model: byId('agent-model-select'),
    apiKey: byId('agent-api-key'),
    ollamaModel: byId('agent-ollama-model'),
    ollamaUrl: byId('agent-ollama-url'),
    saveProvider: byId('agent-provider-save'),
    loginProvider: byId('agent-provider-login'),
    cancelProviderLogin: byId('agent-provider-cancel-login'),
    authCode: byId('agent-auth-code'),
    authUserCode: byId('agent-auth-user-code'),
    providerMessage: byId('agent-provider-message'),
    pageContexts: byId('agent-page-contexts'),
    pageContext: byId('agent-page-context'),
    pageContextLabel: byId('agent-page-context-label'),
    prompt: byId('agent-prompt'),
    composer: byId('agent-composer'),
    run: byId('agent-run'),
    newChat: byId('agent-new-chat'),
    pageInterlock: byId('agent-page-interlock'),
    pageLockTrigger: byId('agent-page-lock-trigger'),
    pageLockHint: byId('agent-page-lock-hint'),
    takeoverDialog: byId('agent-takeover-dialog'),
    takeoverCancel: byId('agent-takeover-cancel'),
    takeoverConfirm: byId('agent-takeover-confirm'),
    runStatus: byId('agent-run-status'),
    runMessage: byId('agent-run-message'),
    approval: byId('agent-approval'),
    approvalAction: byId('agent-approval-action'),
    approvalOrigin: byId('agent-approval-origin'),
    workspacePermissionDetails: byId('agent-workspace-permission-details'),
    workspacePermissionSummary: byId('agent-workspace-permission-summary'),
    approvalApprove: byId('agent-approval-approve'),
    approvalAllowConversation: byId('agent-approval-allow-conversation'),
    approvalDecline: byId('agent-approval-decline'),
    approvalStop: byId('agent-approval-stop'),
    approvalMessage: byId('agent-approval-message'),
    walletApprovalDetails: byId('agent-wallet-approval-details'),
    walletApprovalSummary: byId('agent-wallet-approval-summary'),
    nodeRequestDetails: byId('agent-node-request-details'),
    nodeRequestSummary: byId('agent-node-request-summary'),
    publicationDetails: byId('agent-publication-details'),
    publicationSummary: byId('agent-publication-summary'),
    walletAccountField: byId('agent-wallet-account-field'),
    walletAccount: byId('agent-wallet-account'),
    walletUnlock: byId('agent-wallet-unlock'),
    walletPassword: byId('agent-wallet-password'),
    walletUnlockSubmit: byId('agent-wallet-unlock-submit'),
    transcript: byId('agent-transcript'),
    emptyState: byId('agent-empty-state'),
    modelMenuButton: byId('agent-model-menu-button'),
    activeModelLabel: byId('agent-active-model-label'),
    modelMenu: byId('agent-model-menu'),
    modelMenuList: byId('agent-model-menu-list'),
    manageProviders: byId('agent-manage-providers'),
    approvalModeButton: byId('agent-approval-mode-button'),
    activeApprovalModeLabel: byId('agent-active-approval-mode-label'),
    approvalModePopover: byId('agent-approval-mode-popover'),
    approvalModeEvery: byId('agent-approval-mode-every'),
    approvalModeSensitive: byId('agent-approval-mode-sensitive'),
    approvalModeAllow: byId('agent-approval-mode-allow'),
    attachmentButton: byId('agent-attachment-button'),
    attachmentMenu: byId('agent-attachment-menu'),
    attachFiles: byId('agent-attach-files'),
    attachFolder: byId('agent-attach-folder'),
    attachmentContexts: byId('agent-attachment-contexts'),
  };
  if (Object.values(elements).some((element) => !element)) return;
  getActiveTab = typeof options.getActiveTab === 'function' ? options.getActiveTab : () => null;
  getOpenTabs = typeof options.getOpenTabs === 'function' ? options.getOpenTabs : () => [];
  isTabAgentOwned =
    typeof options.isTabAgentOwned === 'function' ? options.isTabAgentOwned : () => false;
  switchToTab = typeof options.switchTab === 'function' ? options.switchTab : () => {};
  setAgentControlledTab =
    typeof options.setAgentControlledTab === 'function' ? options.setAgentControlledTab : () => {};
  setAgentTabCustody =
    typeof options.setAgentTabCustody === 'function' ? options.setAgentTabCustody : () => {};
  setAgentTabClaimHandler =
    typeof options.setAgentTabClaimHandler === 'function'
      ? options.setAgentTabClaimHandler
      : () => {};
  setTabStripProjection =
    typeof options.setTabStripProjection === 'function' ? options.setTabStripProjection : () => {};
  setWorkspaceNavigationProjection =
    typeof options.setWorkspaceNavigationProjection === 'function'
      ? options.setWorkspaceNavigationProjection
      : () => {};
  setWorkspaceNavigationEditable =
    typeof options.setWorkspaceNavigationEditable === 'function'
      ? options.setWorkspaceNavigationEditable
      : () => {};
  if (isPrivateWindow()) {
    elements.toggle.classList.add('hidden');
    return;
  }

  setAgentTabClaimHandler(claimAgentOwnedTab);

  elements.toggle.addEventListener('click', togglePanel);
  elements.close.addEventListener('click', closePanel);
  elements.agentFirstToggle.addEventListener('click', () => setAgentFirstMode(!agentFirstMode));
  elements.browserReturn.addEventListener('click', () => setAgentFirstMode(false));
  elements.sessionSidebarToggle.addEventListener('click', () =>
    setSessionSidebarOpen(!sessionSidebarOpen)
  );
  elements.workspaceSidebarToggle.addEventListener('click', () =>
    setWorkspaceSidebarOpen(!workspaceSidebarOpen)
  );
  initPaneResizer('session', elements.sessionResizer);
  initPaneResizer('workspace', elements.workspaceResizer);
  elements.taskPageList.addEventListener(
    'wheel',
    (event) => {
      if (elements.taskPageList.scrollWidth <= elements.taskPageList.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      elements.taskPageList.scrollLeft += delta;
    },
    { passive: false }
  );
  elements.sessionNewChat.addEventListener('click', startNewSessionFromSidebar);
  elements.back.addEventListener('click', () => setAgentView('workspace'));
  elements.provider.addEventListener('change', renderProviderFields);
  elements.saveProvider.addEventListener('click', saveProvider);
  elements.loginProvider.addEventListener('click', loginSubscriptionProvider);
  elements.cancelProviderLogin.addEventListener('click', cancelProviderLogin);
  elements.run.addEventListener('click', submitComposer);
  elements.attachmentButton.addEventListener('click', () => {
    const opening = elements.attachmentMenu.hidden;
    closeComposerPopovers();
    elements.attachmentMenu.hidden = !opening;
    elements.attachmentButton.setAttribute('aria-expanded', String(opening));
  });
  elements.attachFiles.addEventListener('click', () => addAttachments('files'));
  elements.attachFolder.addEventListener('click', () => addAttachments('folder'));
  elements.pageContext.addEventListener('click', () => {
    if (currentConversationId || currentRunStatus !== 'idle') return;
    dismissedPageContextTabId = getActiveTab()?.id || null;
    renderPageContext();
    elements.prompt.focus();
  });
  elements.newChat.addEventListener('click', clearConversation);
  elements.prompt.addEventListener('input', updateSendAvailability);
  elements.prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!elements.run.disabled) submitComposer();
  });
  elements.pageLockTrigger.addEventListener('click', () => requestTakeoverConfirmation());
  elements.pageInterlock.addEventListener('wheel', (event) => event.preventDefault(), {
    passive: false,
  });
  elements.pageInterlock.addEventListener('contextmenu', (event) => event.preventDefault());
  elements.takeoverCancel.addEventListener('click', (event) => {
    event.stopPropagation();
    setTakeoverDialogOpen(false);
  });
  elements.takeoverConfirm.addEventListener('click', (event) => {
    event.stopPropagation();
    elements.takeoverCancel.disabled = true;
    elements.takeoverConfirm.disabled = true;
    void takeOverRun();
  });
  elements.approvalApprove.addEventListener('click', () => decideApproval(true));
  elements.approvalAllowConversation.addEventListener('click', () =>
    decideApproval(true, {
      diagnosticScope: 'conversation',
      workspacePermissionScope: 'conversation',
    })
  );
  elements.approvalDecline.addEventListener('click', () => decideApproval(false));
  elements.approvalStop.addEventListener('click', () => stopRun());
  elements.walletUnlockSubmit.addEventListener('click', unlockWalletWithPassword);
  elements.walletPassword.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void unlockWalletWithPassword();
  });
  elements.modelMenuButton.addEventListener('click', () => {
    const opening = elements.modelMenu.hidden;
    closeComposerPopovers();
    elements.modelMenu.hidden = !opening;
    elements.modelMenuButton.setAttribute('aria-expanded', String(opening));
  });
  elements.approvalModeButton.addEventListener('click', () => {
    const opening = elements.approvalModePopover.hidden;
    closeComposerPopovers();
    elements.approvalModePopover.hidden = !opening;
    elements.approvalModeButton.setAttribute('aria-expanded', String(opening));
  });
  elements.approvalModeEvery.addEventListener(
    'click',
    () => void selectApprovalMode(APPROVAL_MODES.EVERY_INTERACTION)
  );
  elements.approvalModeSensitive.addEventListener(
    'click',
    () => void selectApprovalMode(APPROVAL_MODES.SENSITIVE_ACTIONS)
  );
  elements.approvalModeAllow.addEventListener(
    'click',
    () => void selectApprovalMode(APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS)
  );
  elements.manageProviders.addEventListener('click', showProviderSetup);
  document.addEventListener('click', (event) => {
    if (
      !elements.modelMenu.hidden &&
      !elements.modelMenu.contains(event.target) &&
      !elements.modelMenuButton.contains(event.target)
    ) {
      closeComposerPopovers();
    }
    if (
      !elements.approvalModePopover.hidden &&
      !elements.approvalModePopover.contains(event.target) &&
      !elements.approvalModeButton.contains(event.target)
    ) {
      closeComposerPopovers();
    }
    if (
      !elements.attachmentMenu.hidden &&
      !elements.attachmentMenu.contains(event.target) &&
      !elements.attachmentButton.contains(event.target)
    ) {
      closeComposerPopovers();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const popoverWasOpen =
      !elements.modelMenu.hidden ||
      !elements.approvalModePopover.hidden ||
      !elements.attachmentMenu.hidden;
    closeComposerPopovers();
    if (!elements.takeoverDialog.hidden) {
      setTakeoverDialogOpen(false);
    } else if (!popoverWasOpen && currentRunStatus === 'running' && currentRunId) {
      void stopRun();
    } else if (!popoverWasOpen && agentFirstMode) {
      setAgentFirstMode(false);
    }
  });
  document.addEventListener('sidebar-opened', closePanel);
  onSignatureFlightChange((inFlight) => {
    elements.toggle.disabled = inFlight;
    if (inFlight) closePanel();
  });
  agentEventUnsubscribe?.();
  agentEventUnsubscribe = window.electronAPI.onAgentEvent(handleAgentEvent);
  providerAuthEventUnsubscribe?.();
  providerAuthEventUnsubscribe =
    window.electronAPI.onAgentProviderAuthEvent(handleProviderAuthEvent);
  tabPresentationUnsubscribe?.();
  tabPresentationUnsubscribe =
    typeof options.subscribeTabPresentation === 'function'
      ? options.subscribeTabPresentation((tabs) => {
          openTabs = Array.isArray(tabs) ? tabs : [];
          if (
            dismissedPageContextTabId &&
            !openTabs.some((tab) => tab.id === dismissedPageContextTabId && tab.isActive)
          ) {
            dismissedPageContextTabId = null;
          }
          renderPageContext();
          renderTaskPages();
          ensureWorkspacePageVisible();
          renderPageInterlock();
        })
      : null;
  setPanelOpen(false);
  setSessionSidebarOpen(true);
  setWorkspaceSidebarOpen(true);
  setConversationTitle('New task');
  setAgentFirstMode(false);
  setAgentView('loading');
  renderProviderFields();
  updateSendAvailability();
  setWorkspaceNavigationEditable(true);
  renderSessionSidebar();
  refreshProvider();
  restoreRunState();
  void refreshSessionHistory();
}

export { formatOperation, handleAgentEvent, providerPrivacyMessage, responseMessage };
