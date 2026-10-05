import { createMcpConnectionsPanel } from './agent-mcp-connections.js';
import { createPageActions, pageActionPrompt } from './agent-page-actions.js';
import { createWorkspaceInspector } from './agent-workspace-panel.js';
import { isPrivateWindow } from './private-mode.js';
import { homeUrl } from './page-urls.js';
import { matchesShortcut } from './shortcuts.js';
import { close as closeWalletSidebar, isVisible as isWalletSidebarVisible } from './sidebar.js';
import { isSignatureInFlight, onSignatureFlightChange } from './wallet/signature-flight.js';

const PROVIDER_NAMES = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI · API',
  'openai-chatgpt': 'OpenAI · ChatGPT',
  'meta-subscription': 'Meta · Muse',
  'openai-codex': 'OpenAI · ChatGPT (legacy)',
  openrouter: 'OpenRouter',
  xai: 'xAI (Grok)',
  meta: 'Meta (Muse)',
  venice: 'Venice',
  'near-ai': 'NEAR AI',
  ollama: 'Ollama',
});
const APPROVAL_MODES = Object.freeze({
  EVERY_INTERACTION: 'every_interaction',
  SENSITIVE_ACTIONS: 'sensitive_actions',
  ALLOW_WEBSITE_INTERACTIONS: 'allow_website_interactions',
});
const APPROVAL_MODE_LABELS = Object.freeze({
  [APPROVAL_MODES.EVERY_INTERACTION]: 'Ask frequently',
  [APPROVAL_MODES.SENSITIVE_ACTIONS]: 'Ask when needed',
  [APPROVAL_MODES.ALLOW_WEBSITE_INTERACTIONS]: 'Fewer interruptions',
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
let pageActions = null;
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
const expandedModelProviders = new Set();
let providerReady = false;
let providerLoginPending = false;
let choosingProviderMethod = false;
let currentConversationId = null;
let conversationRendererTabId = null;
let dismissedPageContextTabId = null;
let pendingPromptText = '';
let currentRunId = null;
let currentRunStatus = 'idle';
let pendingAttachments = [];
let attachmentSelectionPending = false;
let attachmentSelectionGeneration = 0;
let composerDragDepth = 0;
let conversationResources = [];
let lastFinishedRunId = null;
let stopRequestedRunId = null;
let pendingApproval = null;
let lastApprovalDecisionAt = -Infinity;
let lastDisplayedApprovalId = null;
let approvalReadyAt = 0;
let lastGuidanceSentAt = -Infinity;
let panelOpen = false;
let agentView = 'loading';
let servicesReturnToAgentFirst = false;
let approvalMode = APPROVAL_MODES.SENSITIVE_ACTIONS;
let approvalModeMutationPending = false;
let agentEventUnsubscribe = null;
let providerAuthEventUnsubscribe = null;
let tabPresentationUnsubscribe = null;
let openTabs = [];
let taskTabProjection = [];
let workspaceProcesses = [];
let workspaceProjectionGeneration = 0;
let workspaceInspector = null;
let composerResizeObserver = null;
let workspaceInspectionConversationId = null;
let agentFirstMode = false;
let focusBeforeOpen = null;
let launcherSnapshot = null;
// Optional floating-presentation nodes, looked up after the required set:
// a missing one only loses decoration, never Agent itself.
let panelInner = null;
let panelHeader = null;
let floatTitle = null;
let runHeader = null;
let runHeaderHome = null;
let scopeHelpButton = null;
let scopeHelpText = null;
let scopeNotice = '';
let sessionSidebarOpen = true;
let sessionContextMenu = null;
let workspaceSidebarOpen = true;
const hiddenWorkspaceConversations = new Set();
let conversationTitle = 'New task';
let sessionHistory = [];
let sessionHistoryLoading = false;
const paneWidths = { session: null, workspace: null };
const toolRows = new Map();
const attachmentDisplayRows = new Map();
const processDisplayRows = new Map();
const turnViews = new Map();
const guidanceViews = new Map();
const attachmentPreviewLoaders = new WeakMap();
let attachmentPreviewObserver = null;

function classifierUncertaintyText(reason) {
  const messages = {
    invalid_classifier_output: 'The model returned an unreadable permission assessment. Please review this action.',
    classifier_invalid_json: 'The model returned an unreadable permission assessment. Please review this action.',
    classifier_invalid_schema: 'The model returned an incomplete or invalid permission assessment. Please review this action.',
    classifier_empty_output: 'The model did not return a permission assessment. Please review this action.',
    classifier_output_too_large: 'The model’s permission assessment was too long to validate. Please review this action.',
    classifier_truncated_output: 'The model’s permission assessment was cut short. Please review this action.',
    classifier_unexpected_tool: 'The model did not return the required permission assessment. Please review this action.',
    classifier_timeout: 'The permission check took too long. Please review this action.',
    classifier_provider_error: 'The model provider could not complete the permission check. Please review this action.',
    classifier_cancelled: 'The permission check was stopped.',
    classifier_runtime_unavailable: 'The model is unavailable for the permission check. Please review this action.',
    classifier_session_unavailable: 'The permission check could not start. Please review this action.',
    classifier_input_rejected: 'This action could not be assessed automatically. Please review it.',
  };
  return Object.hasOwn(messages, reason) ? messages[reason] : reason;
}

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

function pageActionsTab() {
  if (agentFirstMode) return workspacePages().find((entry) => entry.tab.isActive)?.tab || null;
  return getActiveTab();
}

function pageActionsNeedNewChat(tab) {
  return Boolean(currentConversationId && tab && conversationRendererTabId !== tab.id &&
    !taskTabProjection.some((entry) => entry.rendererTabId === tab.id));
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

async function addAttachments(kind, files) {
  if (currentRunStatus !== 'idle' || pendingApproval || attachmentSelectionPending) return;
  attachmentSelectionPending = true;
  const generation = attachmentSelectionGeneration;
  updateSendAvailability();
  closeComposerPopovers();
  setMessage(elements.runMessage, files ? 'Adding files…' : kind === 'folder' ? 'Choose a folder…' : 'Choose files…');
  try {
    const response =
      files ? await window.electronAPI.dropAgentFiles(files) : kind === 'folder'
        ? await window.electronAPI.pickAgentFolder()
        : await window.electronAPI.pickAgentFiles();
    if (generation !== attachmentSelectionGeneration) {
      for (const selection of response?.selections || []) {
        await window.electronAPI.removeAgentAttachment(selection.selectionId);
      }
      return;
    }
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
    if (generation === attachmentSelectionGeneration) setMessage(elements.runMessage, 'Could not add attachment. Try Add files again.', true);
  } finally {
    attachmentSelectionPending = false;
    updateSendAvailability();
  }
}

function resetComposerDrop() {
  composerDragDepth = 0;
  elements.composer.classList.remove('file-drop-active');
}

function installComposerDrop() {
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  const canAttach = () => currentRunStatus === 'idle' && !pendingApproval && !attachmentSelectionPending;
  elements.composer.addEventListener('dragenter', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepth += 1;
    elements.composer.classList.toggle('file-drop-active', canAttach());
  });
  elements.composer.addEventListener('dragover', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = canAttach() ? 'copy' : 'none';
  });
  elements.composer.addEventListener('dragleave', event => {
    if (!composerDragDepth) return;
    event.preventDefault();
    composerDragDepth = Math.max(0, composerDragDepth - 1);
    if (!composerDragDepth) resetComposerDrop();
  });
  elements.composer.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    resetComposerDrop();
    if (!canAttach()) {
      setMessage(elements.runMessage, attachmentSelectionPending
        ? 'Wait for the current files to finish attaching, then drop these again.'
        : 'Wait for Agent to finish, then drop files to attach them to your next message.');
      return;
    }
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) void addAttachments('files', files);
  });
  document.addEventListener('dragend', resetComposerDrop);
  document.addEventListener('drop', resetComposerDrop);
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
  if (['openai-chatgpt', 'openai-codex'].includes(providerId)) {
    return 'Requests go to OpenAI through your ChatGPT subscription, including conversation and content Agent reads.';
  }
  const description = providerCatalog.find((provider) => provider.providerId === providerId)?.privacy;
  if (description) return `Your task, conversation and content Agent reads are sent to this provider. ${description}`;
  return `Your task and page content the agent reads may be sent to ${providerName(providerId)}. Avoid using Agent on pages containing sensitive information.`;
}

function providerAuthType(providerId) {
  return (
    providerCatalog.find((candidate) => candidate.providerId === providerId)?.authType ||
    (['openai-chatgpt', 'openai-codex', 'meta-subscription'].includes(providerId) ? 'subscription' : 'api_key')
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
    const query = elements.modelMenuSearch.value.trim().toLowerCase();
    const favorites = connection.favoriteModelIds || [connection.modelId];
    return models.filter((model) => {
      if (!uiModelAllowed(model, connection.privacyPolicy)) return false;
      return !query || `${model.name} ${model.id} ${providerName(connection.providerId)}`.toLowerCase().includes(query);
    }).sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id))).map((model) => ({
      favorite: favorites.includes(model.id),
      providerId: connection.providerId,
      modelId: model.id,
      name: model.name || model.id,
    }));
  });
}

function closeComposerPopovers() {
  workspaceInspector?.dismissPopover();
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
  setModeMenuOpen(false);
  setScopeHelpOpen(false);
  if (nextView !== 'workspace' && agentFirstMode) setAgentFirstMode(false);
  agentView = nextView;
  if (elements.panel.dataset) elements.panel.dataset.agentView = nextView;
  elements.loadingView.hidden = nextView !== 'loading';
  elements.setupView.hidden = nextView !== 'setup';
  elements.mcpPanel.hidden = nextView !== 'services';
  elements.workspaceView.hidden = nextView !== 'workspace';
  const setup = nextView === 'setup';
  elements.browserModeToggle.hidden = nextView !== 'workspace';
  elements.title.hidden = nextView === 'workspace';
  elements.subtitle.hidden = nextView === 'workspace';
  const services = nextView === 'services';
  const canReturn = services || (setup && providerStatus?.configured === true);
  elements.back.hidden = !canReturn;
  elements.title.textContent = services ? 'Services' : setup ? (canReturn ? 'Models' : 'Set up Agent') : 'Agent';
  elements.subtitle.textContent = services ? 'Connected tools and integrations' : setup
    ? canReturn
      ? 'Add or manage providers'
      : 'Connect a model to continue'
    : 'Give Agent a task';
  elements.agentFirstToggle.hidden = nextView !== 'workspace';
  closeComposerPopovers();
  syncFloatingPresentation();
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
  if (floatTitle) {
    floatTitle.textContent = conversationTitle;
    floatTitle.title = conversationTitle;
  }
}

// Why Agent may or may not use the current page is reference, not news: in
// the floating column it lives behind the header's help button instead of
// occupying the status line, which stays free for live runtime messages.
function setScopeNotice(text = '') {
  scopeNotice = text;
  if (scopeHelpText) scopeHelpText.textContent = text;
  if (scopeHelpButton) scopeHelpButton.hidden = !text;
  if (!text) setScopeHelpOpen(false);
}

// The explanation follows the conversation's own shared-page state, so a
// reopened conversation and a new chat never show a previous chat's note.
function scopeNoticeForConversation() {
  if (!currentConversationId && !currentRunId) return '';
  return conversationRendererTabId
    ? 'Agent can use the page you shared and any tabs it opens.'
    : 'Agent can use only the tabs it opens for this conversation.';
}

function setScopeHelpOpen(open) {
  if (!scopeHelpButton || !scopeHelpText) return;
  const next = open === true && Boolean(scopeNotice);
  scopeHelpText.hidden = !next;
  scopeHelpButton.setAttribute('aria-expanded', String(next));
}

function setModeMenuOpen(open, restoreFocus = false) {
  const { modeMenu, modeAgent, modeBrowser } = elements;
  const modeToggle = agentFirstMode ? elements.modeToggle : elements.browserModeToggle;
  if (!open) {
    modeMenu.hidePopover?.();
    modeMenu.hidden = true;
    elements.modeToggle.setAttribute('aria-expanded', 'false');
    elements.browserModeToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) modeToggle.focus();
    return;
  }
  closeComposerPopovers();
  closeSessionContextMenu();
  modeMenu.hidden = false;
  modeMenu.showPopover?.();
  modeToggle.setAttribute('aria-expanded', 'true');
  const anchor = modeToggle.getBoundingClientRect();
  const bounds = modeMenu.getBoundingClientRect();
  modeMenu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
  modeMenu.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - bounds.height - 8))}px`;
  (agentFirstMode ? modeAgent : modeBrowser).focus();
}

function closeSessionContextMenu(restoreFocus = false) {
  if (!sessionContextMenu) return;
  const { actions, select } = sessionContextMenu;
  actions.hidePopover?.();
  actions.hidden = true;
  select.setAttribute('aria-expanded', 'false');
  sessionContextMenu = null;
  if (restoreFocus) select.focus();
}

function renderSessionSidebar() {
  closeSessionContextMenu();
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
    select.title = session.title || 'Untitled session';
    select.setAttribute('aria-haspopup', 'menu');
    select.setAttribute('aria-expanded', 'false');
    select.appendChild(title);
    select.addEventListener('click', () => openSavedSession(session.conversationId));

    const actions = document.createElement('div');
    actions.className = 'agent-session-actions';
    actions.setAttribute('popover', 'manual');
    actions.setAttribute('role', 'menu');
    actions.setAttribute('aria-label', `Options for ${session.title || 'session'}`);
    actions.hidden = true;
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.textContent = 'Rename';
    rename.setAttribute('role', 'menuitem');
    rename.addEventListener('click', () => {
      closeSessionContextMenu(true);
      void renameSavedSession(session, row, select);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.setAttribute('role', 'menuitem');
    remove.addEventListener('click', () => {
      closeSessionContextMenu(true);
      void deleteSavedSession(session);
    });
    actions.appendChild(rename);
    actions.appendChild(remove);
    const openMenu = (event, keyboard = false) => {
      event.preventDefault();
      closeSessionContextMenu();
      setModeMenuOpen(false);
      if (currentRunStatus !== 'idle') return;
      actions.hidden = false;
      actions.showPopover?.();
      select.setAttribute('aria-expanded', 'true');
      sessionContextMenu = { actions, select, row };
      const anchor = select.getBoundingClientRect();
      const bounds = actions.getBoundingClientRect();
      const x = keyboard ? anchor.left : event.clientX;
      const y = keyboard ? anchor.bottom : event.clientY;
      actions.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
      actions.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
      rename.focus();
    };
    row.addEventListener('contextmenu', (event) => openMenu(event, !event.clientX && !event.clientY));
    select.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        openMenu(event, true);
      }
    });
    actions.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        closeSessionContextMenu(true);
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? rename : event.key === 'End' ? remove
          : document.activeElement === rename ? remove : rename;
        next.focus();
      }
    });

    row.appendChild(select);
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
  if (currentConversationId) return [...projected, ...openTabs.filter((tab) => tab.kind === 'workspace-viewer' && tab.conversationId === currentConversationId)
    .map((tab) => ({ rendererTabId: tab.id, agentActive: false, tab }))];
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
  syncWorkspaceSidebar(pages.length > 0);
  elements.taskPageCount.textContent = String(pages.length);
  elements.taskPagesEmpty.hidden = pages.length > 0;
  document.body.classList.toggle('agent-workspace-page-empty', pages.length === 0);
  elements.taskPagesNote.textContent = currentConversationId
    ? 'Pages and read-only viewers belonging to this conversation are shown.'
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
  workspaceInspectionConversationId = state?.workspace?.enabled || state?.workspace?.project ? state.conversationId : null;
  workspaceInspector?.setWorkspace(workspaceInspectionConversationId, state?.workspace?.project);
  renderWorkspaceProcesses(state?.workspace?.processes, state?.workspace?.servers);
  renderTaskPages();
  ensureWorkspacePageVisible();
  renderPageInterlock();
}

function validWorkspaceProcess(process) {
  return (
    process?.state === 'running' &&
    typeof process.processId === 'string' &&
    /^workspace_process_[a-f0-9]{24}$/.test(process.processId) &&
    typeof process.command === 'string' &&
    process.command.length > 0 &&
    process.command.length <= 500 &&
    typeof process.workingDirectory === 'string' &&
    process.workingDirectory.length > 0 &&
    process.workingDirectory.length <= 1_024
  );
}

async function stopWorkspaceProcess(processId, button) {
  button.disabled = true;
  button.textContent = 'Stopping…';
  try {
    const response = await window.electronAPI.stopAgentProcess(processId);
    if (!response?.ok) {
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not stop the process'),
        true
      );
      return;
    }
    applyWorkspaceProjection(response.state);
    setMessage(elements.runMessage, 'Process stopped.');
  } catch {
    setMessage(elements.runMessage, 'Could not stop the process', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Stop';
  }
}

async function openWorkspaceProcessPreview(processId, button) {
  button.disabled = true;
  try {
    const response = await window.electronAPI.openAgentProcessPreview(processId);
    if (!response?.ok) {
      setMessage(
        elements.runMessage,
        responseMessage(response, 'Could not open the server preview'),
        true
      );
      return;
    }
    applyWorkspaceProjection(response.state);
    if (agentFirstMode) setWorkspaceSidebarOpen(true);
    setMessage(elements.runMessage, 'Server preview opened.');
  } catch {
    setMessage(elements.runMessage, 'Could not open the server preview', true);
  } finally {
    button.disabled = false;
  }
}

function createWorkspaceProcessItem(process) {
  const item = document.createElement('div');
  item.className = 'agent-process-item';
  item.dataset.processId = process.processId;

  const title = document.createElement('div');
  title.className = 'agent-process-title';
  const dot = document.createElement('span');
  dot.className = 'agent-process-live-dot';
  dot.setAttribute('aria-hidden', 'true');
  const command = document.createElement('span');
  command.className = 'agent-process-command';
  command.textContent = process.command;
  command.title = process.command;
  title.appendChild(dot);
  title.appendChild(command);

  const meta = document.createElement('div');
  meta.className = 'agent-process-meta';
  const directory =
    process.workingDirectory === '.' ? 'Project workspace' : process.workingDirectory;
  const network = process.networkPosture === 'full' ? ' · Network access' : '';
  meta.textContent = `Running · ${directory}${network}`;

  const actions = document.createElement('div');
  actions.className = 'agent-process-actions';
  if (Number.isSafeInteger(process.previewPort)) {
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.textContent = 'Open preview';
    preview.addEventListener('click', () =>
      openWorkspaceProcessPreview(process.processId, preview)
    );
    actions.appendChild(preview);
  }
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'danger';
  stop.textContent = 'Stop';
  stop.addEventListener('click', () => stopWorkspaceProcess(process.processId, stop));
  actions.appendChild(stop);

  item.appendChild(title);
  item.appendChild(meta);
  item.appendChild(actions);
  return item;
}

function createWorkspaceServerItem(server) {
  const running = server.state === 'running';
  const item = document.createElement('div');
  item.className = 'agent-process-item agent-server-item';
  item.dataset.serverId = server.serverId;
  item.dataset.processId = server.processId || '';
  const details = document.createElement('details');
  details.className = 'agent-process-details';
  const summary = document.createElement('summary');
  summary.title = 'Show server configuration';
  const command = document.createElement('span');
  command.className = 'agent-process-command';
  command.textContent = server.command;
  const meta = document.createElement('span');
  meta.className = 'agent-server-meta';
  const stateLabel = { running: 'Running', stopped: 'Stopped', needs_restart: 'Needs restart', restarting: 'Restarting', exit_unconfirmed: 'Exit unconfirmed' }[server.state];
  meta.textContent = `${stateLabel} · :${server.previewPort}`;
  summary.appendChild(command);
  summary.appendChild(meta);
  details.appendChild(summary);
  for (const text of [`Command: ${server.command}`, `Directory: ${server.workingDirectory === '.' ? 'Project workspace' : server.workingDirectory}`, `Port: ${server.previewPort}`]) {
    const line = document.createElement('p');
    line.textContent = text;
    details.appendChild(line);
  }

  const actions = document.createElement('div');
  actions.className = 'agent-process-actions';
  function iconButton(label, path, handler, danger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    if (danger) button.className = 'danger';
    // Static icons only; command and other server data use textContent above.
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
    button.addEventListener('click', () => { if (!button.disabled) handler(button); });
    actions.appendChild(button);
    return button;
  }
  if (running) {
    iconButton('Open preview', '<path d="M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7"/>', button => openWorkspaceProcessPreview(server.processId, button));
    iconButton('Stop server', '<rect x="5" y="5" width="14" height="14" rx="1"/>', button => stopWorkspaceProcess(server.processId, button), true);
  }
  const restart = iconButton(running ? 'Restart server' : 'Start server', running
    ? '<path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6"/>'
    : '<path d="M7 4l14 8-14 8z"/>', () => {
    if (currentRunId || ['restarting', 'exit_unconfirmed'].includes(server.state)) return;
    restart.disabled = true;
    void startRun({ prompt: `Restart saved development server ${server.serverId} using workspace_server. Check its saved command and current permissions first, then reopen its preview.` });
  });
  restart.disabled = Boolean(currentRunId) || ['restarting', 'exit_unconfirmed'].includes(server.state);
  restart.title = server.state === 'exit_unconfirmed' ? 'Start blocked: the previous process exit is unconfirmed'
    : server.state === 'restarting' ? 'Server restart in progress'
      : currentRunId ? 'Wait for the current Agent task to finish'
        : `${running ? 'Restart' : 'Start'} server — Agent checks the saved command and permissions, then opens the preview`;
  item.appendChild(details);
  item.appendChild(actions);
  return item;
}

function renderWorkspaceProcesses(processes, servers = []) {
  workspaceProcesses = Array.isArray(processes) ? processes.filter(validWorkspaceProcess) : [];
  const saved = Array.isArray(servers) ? servers.filter(server =>
    /^workspace_server_[a-f0-9]{24}$/.test(server?.serverId || '') &&
    ['running', 'stopped', 'restarting', 'needs_restart', 'exit_unconfirmed'].includes(server.state) &&
    typeof server.command === 'string' && server.command.length <= 500 &&
    typeof server.workingDirectory === 'string' && server.workingDirectory.length <= 1024 &&
    Number.isInteger(server.previewPort) && server.previewPort >= 1024 && server.previewPort <= 65535 &&
    (server.state !== 'running' || /^workspace_process_[a-f0-9]{24}$/.test(server.processId || ''))).slice(0, 8) : [];
  const count = workspaceProcesses.length;
  const hasWorkspacePanel = count > 0 || saved.length > 0 || Boolean(workspaceInspectionConversationId);
  elements.workspaceBody.classList.toggle('has-processes', count > 0);
  elements.workspaceBody.classList.toggle('has-workspace-panel', hasWorkspacePanel);
  elements.processPanel.hidden = !hasWorkspacePanel;
  elements.processCompact.hidden = !hasWorkspacePanel;
  const serverCount = saved.filter((server) => server.state === 'running').length;
  for (const badge of [elements.processPanelCount, elements.processCompactCount]) {
    badge.textContent = `${saved.length ? serverCount : count} running`;
    badge.hidden = (saved.length ? serverCount : count) === 0;
  }
  for (const heading of [elements.processPanelHeading, elements.processCompactHeading]) heading.hidden = saved.length === 0 && count === 0;
  for (const label of [elements.processPanelLabel, elements.processCompactHeadingLabel]) label.textContent = saved.length ? 'Development servers' : 'Running commands';
  elements.processCompactLabel.textContent =
    workspaceInspectionConversationId ? `Workspace${count ? ` · ${count} running` : ''}` :
      count === 1 ? workspaceProcesses[0].command : `${count} processes running`;
  elements.processCompact.classList.toggle('has-running-processes', count > 0);
  const unsaved = workspaceProcesses.filter(process => !saved.some(server => server.processId === process.processId));
  for (const list of [elements.processPanelList, elements.processCompactList]) {
    const expandedServers = new Set([...list.querySelectorAll('.agent-process-item')]
      .filter((row) => row.querySelector('.agent-process-details')?.open)
      .map((row) => row.dataset.serverId));
    list.replaceChildren(...saved.map((server) => {
      const row = createWorkspaceServerItem(server);
      row.querySelector('.agent-process-details').open = expandedServers.has(server.serverId);
      return row;
    }));
    if (saved.length && unsaved.length) {
      const heading = document.createElement('h3');
      heading.className = 'agent-process-panel-heading';
      heading.textContent = 'Running commands';
      list.appendChild(heading);
    }
    for (const process of unsaved) list.appendChild(createWorkspaceProcessItem(process));
  }
  if (!hasWorkspacePanel) closeComposerPopovers();
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
  setModeMenuOpen(false);
  setScopeHelpOpen(false);
  agentFirstMode = nextMode === true && panelOpen && agentView === 'workspace';
  if (agentFirstMode) {
    setWorkspaceNavigationProjection(elements.workspaceAddressHost);
  } else {
    setTabStripProjection();
    setWorkspaceNavigationProjection();
  }
  elements.modeAgent.setAttribute('aria-checked', String(agentFirstMode));
  elements.modeBrowser.setAttribute('aria-checked', String(!agentFirstMode));
  document.body.classList.toggle('agent-first-mode', agentFirstMode);
  syncFloatingPresentation();
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

function syncWorkspaceSidebar(hasPages = workspacePages().length > 0) {
  workspaceSidebarOpen = hasPages && !hiddenWorkspaceConversations.has(currentConversationId);
  document.body.classList.toggle('agent-workspace-sidebar-closed', !workspaceSidebarOpen);
  const toggle = elements.workspaceSidebarToggle;
  toggle.disabled = !hasPages;
  toggle.setAttribute('aria-expanded', String(workspaceSidebarOpen));
  const label = !hasPages ? 'No pages or viewers in this conversation'
    : workspaceSidebarOpen ? 'Hide workspace sidebar' : 'Show workspace sidebar';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

function setWorkspaceSidebarOpen(nextOpen) {
  if (nextOpen) hiddenWorkspaceConversations.delete(currentConversationId);
  else hiddenWorkspaceConversations.add(currentConversationId);
  syncWorkspaceSidebar();
}

function observeComposerHeight() {
  composerResizeObserver?.disconnect();
  const update = () => {
    const height = elements.composerWrap.getBoundingClientRect().height;
    if (height > 0) {
      elements.workspaceView.style.setProperty('--agent-composer-height', `${height}px`);
    }
    captureLauncherSnapshot();
  };
  update();
  if (typeof ResizeObserver === 'function') {
    composerResizeObserver = new ResizeObserver(update);
    composerResizeObserver.observe(elements.composerWrap);
  }
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
  showProviderScreen('home');
}

function setPanelOpen(nextOpen) {
  if (!nextOpen) {
    setModeMenuOpen(false);
    setScopeHelpOpen(false);
  }
  panelOpen = nextOpen;
  elements.panel.classList.toggle('collapsed', !panelOpen);
  elements.toggle.setAttribute('aria-expanded', String(panelOpen));
  syncFloatingPresentation();
  pageActions?.render();
}

// In browser mode Agent floats over the page instead of docking beside it, so
// the page keeps its width. Before a task exists it is a centred composer;
// once one does (or a saved conversation is reopened) it is a column of
// floating cards on the right. Agent-first mode keeps its own full layout.
function floatingPresentationFor() {
  return agentView === 'workspace' &&
    !currentConversationId &&
    currentRunStatus === 'idle' &&
    !pendingApproval &&
    elements.transcript.hidden
    ? 'launcher'
    : 'column';
}

function prefersReducedMotion() {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

function syncFloatingPresentation() {
  if (!elements?.panel) return;
  const floating = !agentFirstMode;
  const next = floatingPresentationFor();
  const previous = elements.panel.dataset?.presentation;
  const moving =
    floating && panelOpen && Boolean(previous) && previous !== next && !prefersReducedMotion();
  // Leaving the launcher, the DOM may already hold the first turn, so the
  // geometry comes from the last settled launcher layout.
  const before = moving
    ? previous === 'launcher' && launcherSnapshot
      ? launcherSnapshot
      : { composer: elements.composer.getBoundingClientRect?.() }
    : null;
  elements.panel.classList.toggle('agent-floating', floating);
  if (elements.panel.dataset) elements.panel.dataset.presentation = next;
  // A closed floating surface must not take clicks or focus from the page.
  elements.panel.inert = floating && !panelOpen;
  document.body.classList.toggle('agent-floating-open', floating && panelOpen);
  document.body.classList.toggle(
    'agent-floating-column',
    floating && panelOpen && next === 'column'
  );
  placeRunHeader(floating && next === 'column' && agentView === 'workspace');
  placeWorkspaceStrip(floating && next === 'column');
  if (moving) animateFloatingPresentation(previous, next, before);
  captureLauncherSnapshot();
}

// The floating glass belongs to the composer, not the Workspace strip. Keep
// the real strip (including its inspector and handlers) above that surface;
// Agent-first and the launcher retain the original composer-relative layout.
function placeWorkspaceStrip(aboveComposer) {
  const strip = elements.processCompact;
  const composerWrap = elements.composerWrap;
  if (!strip || !composerWrap) return;
  const parent = aboveComposer ? composerWrap.parentNode : composerWrap;
  const anchor = aboveComposer ? composerWrap : elements.attachmentMenu;
  if (parent && strip.parentNode !== parent) parent.insertBefore(strip, anchor);
}

// The floating column folds the run status and New chat into its compact
// header; everywhere else (launcher, settings screens, Agent-first) they go
// back to the head of the conversation, so there is only ever one of each.
function placeRunHeader(inHeader) {
  if (!runHeader || !runHeaderHome || !panelHeader) return;
  const actions = panelHeader.querySelector?.('.agent-sidebar-header-actions') || null;
  if (inHeader) {
    if (runHeader.parentNode !== panelHeader) panelHeader.insertBefore(runHeader, actions);
  } else if (runHeader.parentNode !== runHeaderHome) {
    runHeaderHome.insertBefore(runHeader, runHeaderHome.firstChild);
  }
}

function captureLauncherSnapshot() {
  if (agentFirstMode || !panelOpen || elements.panel.dataset?.presentation !== 'launcher') {
    if (!panelOpen || agentFirstMode) launcherSnapshot = null;
    return;
  }
  launcherSnapshot = {
    composer: elements.composer.getBoundingClientRect?.(),
    launcher: panelInner?.getBoundingClientRect?.(),
    greeting: elements.emptyState.hidden ? null : elements.emptyState.getBoundingClientRect?.(),
  };
}

const FLOAT_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

// Glass cards cannot fade with opacity without losing their blur (see
// agent-floating.css), so they arrive by materialising: blur, tint, border
// and shadow interpolate from nothing to their resting values.
function glassHiddenKeyframe(extra = {}) {
  const hiddenFilter =
    window.getComputedStyle?.(elements.panel)?.getPropertyValue?.('--agent-glass-filter-hidden')?.trim() ||
    'blur(0px)';
  return {
    backgroundColor: 'transparent',
    backdropFilter: hiddenFilter,
    borderColor: 'transparent',
    boxShadow: 'none',
    ...extra,
  };
}

function materialise(element, transform, delay = 0, fadeContents = true) {
  if (typeof element?.animate !== 'function') return;
  const timing = { duration: 380, delay, easing: FLOAT_EASE, fill: 'backwards' };
  element.animate([{ offset: 0, ...glassHiddenKeyframe({ transform }) }], timing);
  if (!fadeContents) return;
  for (const child of element.children || []) fadeIn(child, delay + 80);
}

// Only for content that is not itself glass (opacity would disable a blur).
function fadeIn(element, delay = 0) {
  element?.animate?.([{ offset: 0, opacity: 0 }], {
    duration: 260,
    delay,
    easing: 'ease-out',
    fill: 'backwards',
  });
}

// The composer is the one element both presentations share, so it travels
// between them (first-last-invert-play) while the rest materialises around
// it. Draft, focus and attachments stay put because the node never moves.
function animateFloatingPresentation(previous, next, before) {
  const composer = elements.composer;
  const after = composer.getBoundingClientRect?.();
  if (before?.composer?.width && after?.width && typeof composer.animate === 'function') {
    composer.animate(
      [
        {
          transform: `translate(${before.composer.left - after.left}px, ${
            before.composer.top - after.top
          }px)`,
          width: `${before.composer.width}px`,
        },
        { transform: 'translate(0, 0)', width: `${after.width}px` },
      ],
      { duration: 480, easing: FLOAT_EASE }
    );
  }
  if (previous === 'launcher' && before?.launcher?.width) {
    dissolveLauncherGhost(before.launcher, before.greeting);
  }
  if (next === 'column') {
    materialise(elements.composerWrap, 'none', 0, false);
    materialise(panelHeader, 'none', 160);
  } else {
    materialise(panelInner, 'translateY(10px) scale(0.985)', 40);
  }
}

// The centred card dissolves where it stood while its composer flies to the
// column. The ghost is decorative: no ids, no focusable content, no pointer.
function dissolveLauncherGhost(rect, greetingRect) {
  if (typeof document.createElement !== 'function' || !document.body?.appendChild) return;
  const ghost = document.createElement('div');
  ghost.className = 'agent-floating-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  let greeting = null;
  if (greetingRect?.width && typeof elements.emptyState.cloneNode === 'function') {
    greeting = elements.emptyState.cloneNode(true);
    greeting.removeAttribute?.('id');
    greeting.hidden = false;
    greeting.classList?.add('agent-floating-ghost-greeting');
    Object.assign(greeting.style, {
      left: `${greetingRect.left - rect.left}px`,
      top: `${greetingRect.top - rect.top}px`,
      width: `${greetingRect.width}px`,
    });
    ghost.appendChild(greeting);
  }
  document.body.appendChild(ghost);
  const timing = { duration: 320, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' };
  greeting?.animate?.([{ opacity: 1 }, { opacity: 0 }], { ...timing, duration: 180 });
  const dissolve = ghost.animate?.(
    [{ transform: 'scale(1)' }, glassHiddenKeyframe({ transform: 'scale(0.97)' })],
    timing
  );
  if (dissolve) dissolve.onfinish = () => ghost.remove();
  else ghost.remove();
}

// Cmd/Ctrl+K and the menu item: open Agent, or bring the keyboard back to an
// open composer from the page, and only close it when it already has focus.
function summonPanel() {
  if (!panelOpen) {
    openPanel();
    return;
  }
  if (agentFirstMode) {
    focusComposer();
    return;
  }
  if (!elements.panel.contains(document.activeElement) && focusComposer()) return;
  closePanel();
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
  const hadFocus = elements.panel.contains(document.activeElement);
  if (agentFirstMode) setAgentFirstMode(false);
  if (panelOpen) setPanelOpen(false);
  // Hand the keyboard back to whatever summoned Agent (the page, the toolbar
  // button) rather than leaving it on a surface that is now inert.
  const previous = focusBeforeOpen;
  focusBeforeOpen = null;
  if (hadFocus && previous?.isConnected && !elements.panel.contains(previous)) {
    previous.focus?.({ preventScroll: true });
  }
}

function openPanel() {
  if (isPrivateWindow() || isSignatureInFlight()) return;
  if (isWalletSidebarVisible()) {
    closeWalletSidebar();
    if (isWalletSidebarVisible()) return;
  }
  if (!panelOpen && !elements.panel.contains(document.activeElement)) {
    focusBeforeOpen = document.activeElement || null;
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
  const isMeta = ['meta', 'meta-subscription'].includes(providerId);
  const canUpgradeChatgpt = providerId === 'openai-codex' && isConnectedSubscription;
  const descriptor = providerCatalog.find((item) => item.providerId === providerId);
  elements.providerHeading.textContent = providerName(providerId);
  elements.providerStatus.textContent = connection ? 'Connected' : 'Not connected';
  elements.providerStatus.classList.toggle('active', Boolean(connection));
  elements.providerPrivacy.textContent = providerPrivacyMessage(providerId);
  elements.hostedFields.classList.toggle('hidden', isOllama || !connection);
  elements.ollamaFields.classList.toggle('hidden', !isOllama);
  elements.apiKeyField.classList.toggle('hidden', isSubscription || isOllama);
  (connection ? elements.keySettings : elements.connectionFields).prepend(elements.apiKeyField);
  elements.subscriptionFields.classList.toggle('hidden', !isSubscription || (isConnectedSubscription && !canUpgradeChatgpt && !providerLoginPending));
  elements.saveProvider.hidden = isSubscription;
  elements.authCode.hidden = !providerLoginPending || !elements.authUserCode.textContent;
  elements.subscriptionNote.hidden = Boolean(connection) && !canUpgradeChatgpt;
  elements.subscriptionNote.textContent = canUpgradeChatgpt
    ? 'This connection uses the older Codex login. Sign in with ChatGPT to use the new connection. Your current connection stays available.'
    : isMeta ? 'Connect with your Meta account.' : 'Connect with your ChatGPT subscription.';
  elements.loginProvider.hidden =
    !isSubscription || (isConnectedSubscription && !canUpgradeChatgpt) || providerLoginPending;
  elements.loginProvider.textContent = canUpgradeChatgpt ? 'Upgrade ChatGPT sign-in' : isMeta ? 'Sign in with Meta' : 'Continue with ChatGPT';
  elements.cancelProviderLogin.hidden = !isSubscription || !providerLoginPending;
  elements.provider.disabled = providerLoginPending;
  elements.model.disabled = providerLoginPending;
  elements.modelRefresh.hidden = !isOllama && !descriptor?.canRefresh;
  elements.modelRefresh.disabled = (isOllama || isSubscription) && !connection;
  elements.apiKey.placeholder = connection ? 'Leave empty to keep your saved key' : 'Stored encrypted on this device';
  elements.saveProvider.textContent = isOllama
    ? connection ? 'Save connection' : 'Connect to Ollama'
    : connection ? 'Save connection' : 'Connect provider';
  elements.modelDetails.hidden = !connection;
  elements.testProvider.hidden = !connection;
  elements.providerDisconnect.hidden = !connection;
  elements.testProviderNote.hidden = !connection;
  const policies = descriptor?.policies || [];
  elements.privacyControls.hidden = policies.length === 0;
  elements.privacyPolicy.replaceChildren(...policies.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  elements.privacyPolicy.value = connection?.privacyPolicy || 'standard';
  elements.privacySave.hidden = !connection;
  elements.catalogStatus.textContent = descriptor?.updatedAt
    ? `Catalog updated ${new Date(descriptor.updatedAt).toLocaleString()}`
    : descriptor?.canRefresh ? 'Refresh to discover current models. No prompts are sent.' : 'Bundled model catalog';
  if (!isOllama) renderModelOptions(providerId);
  else renderProviderModelPreview(providerId);
  const subscriptionConnected = Boolean(isMeta ? providerConnection('meta-subscription') : providerConnection('openai-chatgpt') || providerConnection('openai-codex'));
  elements.subscriptionMethodTitle.textContent = isMeta ? 'Meta subscription' : 'ChatGPT subscription';
  elements.subscriptionMethodHelp.textContent = isMeta ? 'Use your Meta account' : 'Use your ChatGPT account';
  elements.authCodeInstruction.textContent = `Enter this code on the ${isMeta ? 'Meta' : 'OpenAI'} page`;
  const apiConnected = Boolean(providerConnection(isMeta ? 'meta' : 'openai'));
  elements.chatgptConnectionState.textContent = subscriptionConnected ? 'Connected' : 'Connect';
  elements.apiConnectionState.textContent = apiConnected ? 'Connected' : 'Connect';
  elements.chatgptConnectionState.classList.toggle('active', subscriptionConnected);
  elements.apiConnectionState.classList.toggle('active', apiConnected);
  if (choosingProviderMethod) {
    elements.providerHeading.textContent = isMeta ? 'Meta (Muse)' : 'OpenAI';
    elements.providerStatus.textContent = subscriptionConnected || apiConnected ? 'Connected' : 'Not connected';
    elements.providerStatus.classList.toggle('active', subscriptionConnected || apiConnected);
  }

}

function renderProviderModelPreview(providerId) {
  const connection = providerConnection(providerId);
  const models = providerId === 'ollama'
    ? (connection?.modelIds || (connection ? [connection.modelId] : [])).map((id) => ({ id, name: id }))
    : providerCatalog.find((provider) => provider.providerId === providerId)?.models || [];
  const available = models.filter((model) => uiModelAllowed(model, elements.privacyPolicy.value || 'standard'));
  elements.providerModelsHeading.textContent = available.length
    ? `Available models · ${available.length}` : 'Available models';
  elements.providerModelsList.replaceChildren(...available.map((model) => {
    const row = document.createElement('li');
    row.textContent = model.name || model.id;
    row.title = model.id;
    return row;
  }));
  elements.providerModelsList.scrollTop = 0;
  elements.providerModelsList.hidden = !available.length;
  elements.providerModelsEmpty.hidden = Boolean(available.length);
  elements.providerModelsEmpty.textContent = models.length
    ? 'No models meet the current requirements'
    : connection ? 'Refresh to discover available models' : 'Connect to discover available models';
}

function uiModelAllowed(model, policy = 'standard') {
  return model.available !== false && model.tools !== false &&
    (policy !== 'private' || ['private', 'tee'].includes(model.privacy)) &&
    (policy !== 'tee' || model.privacy === 'tee');
}

function showProviderScreen(screen) {
  elements.providerHome.hidden = screen !== 'home';
  elements.providerBrowser.hidden = screen !== 'browser';
  elements.providerDetail.hidden = screen !== 'detail';
  setMessage(elements.providerMessage, '');
  if (screen === 'browser') elements.providerSearch.focus();
}

function openProviderDetail(providerId, chooseMethod = false) {
  choosingProviderMethod = chooseMethod;
  elements.provider.value = providerId;
  elements.apiKey.value = '';
  elements.model.value = providerConnection(providerId)?.modelId || '';
  if (providerId === 'ollama') {
    const connection = providerConnection(providerId);
    elements.ollamaUrl.value = connection?.baseUrl || 'http://127.0.0.1:11434/v1';
  }
  elements.providerAdvanced.open = false;
  elements.providerMethods.hidden = !chooseMethod;
  elements.connectionFields.hidden = chooseMethod;
  showProviderScreen('detail');
  renderProviderFields();
  const descriptor = providerCatalog.find((item) => item.providerId === providerId);
  if (!chooseMethod && providerConnection(providerId) && descriptor?.canRefresh &&
      (!descriptor.updatedAt || Date.now() - descriptor.updatedAt > 24 * 60 * 60 * 1000)) {
    refreshModelCatalog();
  }
}

function createProviderLogo(providerId) {
  const files = {
    openai: 'openai.png', 'openai-chatgpt': 'openai.png', 'openai-codex': 'openai.png', anthropic: 'anthropic.png',
    xai: 'xai-light.svg', meta: 'meta.svg', 'meta-subscription': 'meta.svg', openrouter: 'openrouter.png',
    venice: 'venice.png', 'near-ai': 'near-ai.svg', ollama: 'ollama.png',
  };
  const logo = document.createElement('span');
  logo.className = 'agent-provider-avatar';
  logo.setAttribute('aria-hidden', 'true');
  const file = files[providerId];
  if (!file) {
    logo.textContent = providerName(providerId).slice(0, 1);
    return logo;
  }
  const image = document.createElement('img');
  image.className = 'agent-provider-logo';
  image.src = `assets/provider-logos/${file}`;
  image.alt = '';
  image.width = 32;
  image.height = 32;
  image.draggable = false;
  logo.appendChild(image);
  if (providerId === 'xai') {
    image.classList.add('agent-provider-logo-light');
    const dark = document.createElement('img');
    dark.className = 'agent-provider-logo agent-provider-logo-dark';
    dark.src = 'assets/provider-logos/xai-dark.svg';
    dark.alt = '';
    dark.width = 32;
    dark.height = 32;
    dark.draggable = false;
    logo.appendChild(dark);
  }
  return logo;
}

function renderProviderOptions() {
  const selected = elements.provider.value;
  const definitions = [...providerCatalog, { providerId: 'ollama', name: 'Ollama', group: 'On this device' }];
  elements.provider.replaceChildren(...definitions.map((definition) => {
    const option = document.createElement('option');
    option.value = definition.providerId;
    option.textContent = definition.name;
    return option;
  }));
  elements.provider.value = definitions.some((item) => item.providerId === selected) ? selected : definitions[0]?.providerId || '';
  const query = elements.providerSearch.value.trim().toLowerCase();
  const content = [];
  let group;
  let groupRows;
  const descriptions = {
    openai: 'ChatGPT subscription or API key',
    anthropic: 'Claude models',
    xai: 'Grok models',
    meta: 'Meta subscription or API key',
    openrouter: 'Many model providers, one API key',
    venice: 'Models with privacy options',
    'near-ai': 'TEE and external models',
    ollama: 'Models running on your computer',
  };
  for (const definition of definitions) {
    if (['openai-chatgpt', 'openai-codex', 'meta-subscription'].includes(definition.providerId)) continue;
    const name = definition.providerId === 'openai' ? 'OpenAI' : definition.name;
    if (!`${name} ${definition.providerId} ${definition.providerId === 'openai' ? 'ChatGPT subscription API' : ''}`.toLowerCase().includes(query)) continue;
    if (!groupRows || group !== definition.group) {
      group = definition.group;
      const label = document.createElement('div');
      label.className = 'agent-provider-group-label';
      label.textContent = group || 'Providers';
      groupRows = document.createElement('div');
      groupRows.className = 'agent-provider-group';
      content.push(label, groupRows);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-provider-choice';
    button.setAttribute('aria-label', name);
    const avatar = createProviderLogo(definition.providerId);
    const copy = document.createElement('span');
    copy.className = 'agent-provider-choice-copy';
    const title = document.createElement('strong');
    title.textContent = name;
    const description = document.createElement('span');
    description.textContent = descriptions[definition.providerId] || 'Connect with an API key';
    copy.appendChild(title);
    copy.appendChild(description);
    const connected = Boolean(providerConnection(definition.providerId) ||
      (definition.providerId === 'openai' && (providerConnection('openai-chatgpt') || providerConnection('openai-codex'))) ||
      (definition.providerId === 'meta' && providerConnection('meta-subscription')));
    const indicator = document.createElement('span');
    indicator.className = 'agent-provider-indicator';
    indicator.textContent = connected ? '✓' : '›';
    indicator.title = connected ? 'Connected' : 'Connect provider';
    indicator.classList.toggle('active', connected);
    button.appendChild(avatar);
    button.appendChild(copy);
    button.appendChild(indicator);
    button.addEventListener('click', () => openProviderDetail(definition.providerId, ['openai', 'meta'].includes(definition.providerId)));
    groupRows.appendChild(button);
  }
  if (!content.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No matching providers';
    content.push(empty);
  }
  elements.providerChoices.replaceChildren(...content);
}

function favoriteButton(providerId, modelId) {
  const connection = providerConnection(providerId);
  const favorites = connection?.favoriteModelIds || [connection?.modelId];
  const active = favorites.includes(modelId);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'agent-model-star';
  button.textContent = active ? '★' : '☆';
  button.setAttribute('aria-label', `${active ? 'Unfavorite' : 'Favorite'} ${modelName(providerId, modelId)}`);
  button.setAttribute('aria-pressed', String(active));
  button.hidden = !connection;
  button.addEventListener('click', async () => {
    button.disabled = true;
    await saveProviderPreferences({ favoriteModelIds: active ? favorites.filter((id) => id !== modelId) : [...favorites, modelId] }, providerId);
    button.disabled = false;
  });
  return button;
}

function renderModelOptions(providerId) {
  renderProviderModelPreview(providerId);
  const selectedModel =
    elements.model.value || providerConnection(providerId)?.modelId;
  const provider = providerCatalog.find((candidate) => candidate.providerId === providerId);
  const connection = providerConnection(providerId);
  const favorites = connection?.favoriteModelIds || [connection?.modelId];
  const options = (provider?.models || []).map((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${favorites.includes(model.id) ? '★ ' : ''}${model.name || model.id}${model.available === false ? ' · Unavailable' : model.tools === false ? ' · No tool calling' : ''}`;
    option.disabled = !uiModelAllowed(model, elements.privacyPolicy.value);
    return option;
  });
  elements.model.replaceChildren(...options);
  if (options.some((option) => option.value === selectedModel && !option.disabled)) {
    elements.model.value = selectedModel;
  } else {
    elements.model.value = options.find((option) => option.value === provider?.defaultModelId && !option.disabled)?.value ||
      options.find((option) => !option.disabled)?.value || '';
  }
  renderModelDetails();
}

function renderModelDetails() {
  const providerId = elements.provider.value;
  const model = catalogModel(providerId, elements.model.value);
  const parts = [];
  if (model) {
    parts.push(model.id);
    if (model.contextWindow) parts.push(`${new Intl.NumberFormat().format(model.contextWindow)} context`);
    if (model.vision) parts.push('Images');
    if (model.reasoning) parts.push('Reasoning');
    parts.push(model.tools === true ? 'Tool calling' : model.tools === false ? 'No tool calling' : 'Tool support not reported');
    if (model.privacy && !['standard', 'routing'].includes(model.privacy)) parts.push(`${model.privacy.toUpperCase()} · provider reported`);
    if (model.inputPrice != null && model.outputPrice != null) parts.push(`$${model.inputPrice} input / $${model.outputPrice} output per 1M tokens`);
  }
  elements.modelDetails.textContent = parts.join(' · ') || 'No matching models. Try another search or refresh the catalog.';

}

async function saveProviderPreferences(preferences, providerId = elements.provider.value) {
  try {
    const response = await window.electronAPI.setAgentProviderPreferences(providerId, preferences);
    if (!response?.ok) {
      setMessage(elements.providerMessage, responseMessage(response, 'Could not save preferences'), true);
      return;
    }
    providerStatus = response.status;
    if (elements.provider.value === providerId) { renderProviderFields(); renderModelDetails(); }
    renderConnectedProviders();
    renderActiveModel();
    setMessage(elements.providerMessage, 'Preferences saved');
  } catch { setMessage(elements.providerMessage, 'Could not save preferences', true); }
}

async function refreshModelCatalog() {
  const providerId = elements.provider.value;
  elements.modelRefresh.disabled = true;
  setMessage(elements.providerMessage, 'Refreshing model catalog…');
  try {
    const response = await window.electronAPI.refreshAgentProviderModels(providerId, elements.apiKey.value || undefined);
    if (!response?.ok) {
      setMessage(elements.providerMessage, responseMessage(response, 'Could not refresh models. Your previous catalog is still available.'), true);
      return;
    }
    providerCatalog = response.catalog;
    if (response.status) providerStatus = response.status;
    renderProviderFields();
    renderConnectedProviders();
    renderActiveModel();
    setMessage(elements.providerMessage, 'Model catalog refreshed');
    return true;
  } catch { setMessage(elements.providerMessage, 'Could not refresh models. Your previous catalog is still available.', true); }
  finally { elements.modelRefresh.disabled = false; }
}

async function testProviderConnection() {
  const providerId = elements.provider.value;
  elements.testProvider.disabled = true;
  setMessage(elements.providerMessage, 'Sending test prompt…');
  try {
    const response = await window.electronAPI.testAgentProviderConnection(providerId,
      providerId === 'ollama' ? providerConnection(providerId)?.modelId : elements.model.value);
    setMessage(elements.providerMessage, response?.ok
      ? response.result.outcome === 'token_limit'
        ? 'Connection accepted. The model reached the test token limit before finishing.'
        : `Model responded in ${Math.max(0.1, response.result.elapsedMs / 1000).toFixed(1)}s`
      : responseMessage(response, 'Test prompt failed'), !response?.ok);
  } catch { setMessage(elements.providerMessage, 'Test prompt failed', true); }
  finally { elements.testProvider.disabled = false; }
}

function renderConnectedProviders() {
  const connections = providerConnections();
  elements.connectedProviders.hidden = connections.length === 0;
  const rows = connections.map((connection) => {
    const row = document.createElement('button');
    row.type = 'button';
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
    row.appendChild(createProviderLogo(connection.providerId));
    row.appendChild(copy);
    const chevron = document.createElement('span');
    chevron.textContent = '›';
    chevron.setAttribute('aria-hidden', 'true');
    row.appendChild(chevron);
    row.addEventListener('click', () => openProviderDetail(connection.providerId));
    return row;
  });
  elements.connectedProviderList.replaceChildren(...rows);
}

function renderModelMenu() {
  const models = configuredModels();
  const searching = Boolean(elements.modelMenuSearch.value.trim());
  const groups = new Map();
  for (const model of models) {
    if (!groups.has(model.providerId)) groups.set(model.providerId, []);
    groups.get(model.providerId).push(model);
  }
  const content = [];
  for (const [providerId, providerModels] of groups) {
    const expanded = searching || expandedModelProviders.has(providerId);
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'agent-model-group-label';
    label.setAttribute('aria-expanded', String(expanded));
    label.disabled = searching;
    const title = document.createElement('span');
    title.textContent = providerName(providerId);
    const chevron = document.createElement('span');
    chevron.className = 'agent-model-group-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
    label.appendChild(title);
    label.appendChild(chevron);
    label.addEventListener('click', (event) => {
      // Replacing this header would otherwise look like an outside click.
      event.stopPropagation();
      if (expandedModelProviders.has(providerId)) expandedModelProviders.delete(providerId);
      else expandedModelProviders.add(providerId);
      renderModelMenu();
      elements.modelMenuList.querySelector(`[data-provider-id="${providerId}"]`)?.focus();
    });
    label.dataset.providerId = providerId;
    content.push(label);
    for (const model of providerModels.filter((model) => expanded || model.favorite)) {
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
      const row = document.createElement('div');
      row.className = 'agent-model-row';
      row.appendChild(option);
      row.appendChild(favoriteButton(providerId, model.modelId));
      content.push(row);
    }
  }
  elements.modelMenuList.replaceChildren(...content);
  if (!content.length) {
    const empty = document.createElement('p');
    empty.className = 'agent-catalog-status';
    empty.textContent = elements.modelMenuSearch.value ? 'No matching models meet your privacy settings' : 'Connect a provider to browse its models';
    elements.modelMenuList.appendChild(empty);
  }
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
      elements.ollamaUrl.value = status.baseUrl || 'http://127.0.0.1:11434/v1';
    }
  }
  renderProviderFields();
  renderConnectedProviders();
  renderActiveModel();
  updateSendAvailability();
  if (agentView === 'loading') showPrimaryView();
  else if (agentView === 'setup') setAgentView('setup');
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
      renderProviderOptions();
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
    showProviderScreen('home');
  } catch {
    setMessage(elements.providerMessage, `Could not disconnect ${label}`, true);
  }
}

async function saveProvider() {
  const providerId = elements.provider.value;
  const privacyPolicy = elements.privacyPolicy.value;
  const adding = !providerConnection(providerId);
  elements.saveProvider.disabled = true;
  setMessage(elements.providerMessage, providerId === 'ollama' ? 'Finding installed models…' : 'Saving…');
  try {
    let response;
    if (adding && providerId !== 'ollama' && !elements.model.value) {
      // Some catalogs require the entered key. Discover them as part of connecting,
      // without making users select a model in the connection form.
      if (!await refreshModelCatalog()) return;
      elements.privacyPolicy.value = privacyPolicy;
      renderModelOptions(providerId);
      if (!elements.model.value) {
        setMessage(elements.providerMessage, 'No supported models meet this privacy setting', true);
        return;
      }
    }
    if (providerId === 'ollama') {
      response = await window.electronAPI.configureOllamaAgentProvider(
        undefined,
        elements.ollamaUrl.value.trim()
      );
    } else if (providerAuthType(providerId) === 'subscription') {
      response = await window.electronAPI.selectAgentModel(providerId, elements.model.value);
    } else {
      response = await window.electronAPI.configureHostedAgentProvider(
        providerId,
        elements.model.value,
        elements.apiKey.value,
        ...(elements.privacyControls.hidden ? [] : [elements.privacyPolicy.value])
      );
    }
    elements.apiKey.value = '';
    if (!response?.ok) {
      setMessage(elements.providerMessage, responseMessage(response, 'Could not save model'), true);
      return;
    }
    renderProviderStatus(response.status);
    setMessage(elements.providerMessage, providerId === 'ollama' ? 'Ollama models ready' : 'Model saved for this profile');
  } catch {
    elements.apiKey.value = '';
    setMessage(elements.providerMessage, 'Could not save model', true);
  } finally {
    elements.saveProvider.disabled = false;
  }
}

function handleProviderAuthEvent(event) {
  if (providerLoginPending && event?.providerId === 'openai-chatgpt' && elements.provider.value === event.providerId) {
    if (event.type === 'auth_url') setMessage(elements.providerMessage, 'Finish signing in with ChatGPT in your browser');
    if (event.type === 'manual_code' && typeof event.requestId === 'string') {
      elements.authCallback.hidden = false;
      elements.authCallback.dataset.requestId = event.requestId;
    }
    return;
  }
  if (
    !providerLoginPending ||
    event?.type !== 'device_code' ||
    !['openai-codex', 'meta-subscription'].includes(event.providerId) ||
    elements.provider.value !== event.providerId ||
    typeof event.userCode !== 'string'
  ) {
    return;
  }
  elements.authUserCode.textContent = event.userCode;
  elements.authCode.hidden = false;
  setMessage(elements.providerMessage, `Finish signing in on the ${event.providerId === 'meta-subscription' ? 'Meta' : 'OpenAI'} page`);
}

async function loginSubscriptionProvider() {
  if (elements.provider.value === 'openai-codex' && providerConnection('openai-codex')) {
    openProviderDetail('openai-chatgpt');
  }
  const providerId = elements.provider.value;
  const modelId = elements.model.value;
  if (providerAuthType(providerId) !== 'subscription' || !modelId) {
    setMessage(elements.providerMessage, 'Choose a subscription model first', true);
    return;
  }
  providerLoginPending = true;
  elements.authCallback.hidden = true;
  elements.authCallback.open = false;
  elements.authCallbackInput.value = '';
  elements.authCode.hidden = true;
  elements.authUserCode.textContent = '';
  const accountName = providerId === 'meta-subscription' ? 'Meta' : 'ChatGPT';
  setMessage(elements.providerMessage, `Starting ${accountName} sign-in…`);
  renderProviderFields();
  try {
    const response = await window.electronAPI.loginSubscriptionAgentProvider(providerId, modelId);
    if (!response?.ok) {
      setMessage(
        elements.providerMessage,
        responseMessage(response, `Could not sign in with ${accountName}`),
        response?.error?.code !== 'AGENT_PROVIDER_AUTH_CANCELLED'
      );
      return;
    }
    renderProviderStatus(response.status);
    openProviderDetail(providerId);
    setMessage(elements.providerMessage, `${accountName} connected`);
  } catch {
    setMessage(elements.providerMessage, `Could not sign in with ${accountName}`, true);
  } finally {
    providerLoginPending = false;
    elements.authCallback.hidden = true;
    elements.authCallbackInput.value = '';
    delete elements.authCallback.dataset.requestId;
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
  pageActions?.render();
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
  syncFloatingPresentation();
}

function updateSendAvailability() {
  const hasText = Boolean(elements.prompt.value.trim());
  let action = 'send';
  let label = 'Run task';
  let disabled = true;
  if (currentRunStatus === 'idle') {
    disabled = !hasText || !providerStatus?.configured || approvalModeMutationPending || attachmentSelectionPending;
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
  attachmentSelectionGeneration += 1;
  resetComposerDrop();
  toolRows.clear();
  attachmentDisplayRows.clear();
  processDisplayRows.clear();
  turnViews.clear();
  guidanceViews.clear();
  attachmentPreviewObserver?.disconnect();
  attachmentPreviewObserver = null;
  elements.transcript.replaceChildren();
  elements.transcript.hidden = true;
  elements.emptyState.hidden = false;
  clearApproval();
  setMessage(elements.runMessage);
  setScopeNotice();
  syncFloatingPresentation();
}

function createTurnView(turn) {
  for (const previous of turnViews.values()) {
    previous.output.removeAttribute('id');
    previous.toolList.removeAttribute('id');
    previous.outcomeActions.hidden = true;
    previous.outcomeRetry.hidden = true;
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

  const activity = document.createElement('details');
  activity.className = 'agent-turn-activity';
  activity.open = false;
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
  section.appendChild(assistantRow);
  section.appendChild(outcome);
  section.appendChild(artifactList);
  section.appendChild(activity);
  section.appendChild(liveStatus);
  elements.transcript.appendChild(section);
  elements.transcript.hidden = false;
  elements.emptyState.hidden = true;
  syncFloatingPresentation();

  const view = {
    section,
    output,
    assistantRow,
    outputSegments: [{ output, text: turn.assistantText || '' }],
    assistantSegmentClosed: false,
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
    helperCards: new Map(),
    activity,
    activitySummary,
    toolList,
    liveStatus,
    liveStatusLabel,
    userText: turn.userText || '',
    assistantText: turn.assistantText || '',
    actionCount: 0,
  };
  turnViews.set(turn.runId, view);
  for (const guidance of Array.isArray(turn.guidance) ? turn.guidance : []) {
    createGuidanceView(turn.runId, guidance);
  }
  return view;
}

// A message stays where it was spoken. Tool starts and user guidance close
// the current segment; the next assistant text gets a new bubble after them.
function closeAssistantSegment(view) {
  if (view.assistantSegmentClosed) return;
  view.assistantSegmentClosed = true;
  const segment = view.outputSegments.at(-1);
  if (segment.text) renderAgentMarkdown(segment.output, segment.text);
}

function appendAssistantText(view, text) {
  if (!text) return;
  if (view.assistantSegmentClosed) {
    if (view.outputSegments.at(-1).text) {
      view.output.removeAttribute('id');
      view.assistantRow = document.createElement('div');
      view.assistantRow.className = 'agent-message-row assistant';
      view.output = document.createElement('div');
      view.output.id = 'agent-output';
      view.output.className = 'agent-output';
      view.assistantRow.appendChild(view.output);
      view.outputSegments.push({ output: view.output, text: '' });
    }
    view.section.insertBefore(view.assistantRow, view.outcome);
    view.assistantSegmentClosed = false;
  }
  view.assistantText += text;
  const segment = view.outputSegments.at(-1);
  segment.text += text;
  // Keep the streaming text node rather than replacing an ever-growing answer.
  if (view.output.lastChild?.nodeType === 3) view.output.lastChild.appendData(text);
  else view.output.insertAdjacentText('beforeend', text);
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
  closeAssistantSegment(view);
  const group = document.createElement('div');
  group.className = 'agent-guidance-list';
  group.appendChild(row);
  view.section.insertBefore(group, view.outcome);
  const record = { row, status };
  guidanceViews.set(key, record);
  updateGuidanceView(runId, guidance.guidanceId, guidance.status);
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

function renderAgentMarkdown(output, text) {
  if (!text || !window.marked?.parse || !window.DOMPurify?.sanitize) return;
  try {
    const rendered = window.marked.parse(text, { gfm: true, breaks: true });
    if (typeof rendered !== 'string') return;
    output.innerHTML = window.DOMPurify.sanitize(rendered, {
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
    output.classList.add('rendered-markdown');
  } catch {
    output.textContent = text;
    output.classList.remove('rendered-markdown');
  }
}

function restoreTranscript(transcript = []) {
  resetConversationUi();
  for (const turn of transcript) {
    if (!turn || typeof turn.runId !== 'string') continue;
    const view = createTurnView({ ...turn, assistantText: '', guidance: [] });
    const text = turn.assistantText || '';
    const entries = [
      ...(Array.isArray(turn.activity) ? turn.activity : []).map(item => ({ kind: 'tool', item })),
      ...(Array.isArray(turn.guidance) ? turn.guidance : []).map(item => ({ kind: 'guidance', item })),
    ].map(entry => ({ ...entry, offset: Number.isSafeInteger(entry.item.textOffset)
      ? Math.max(0, Math.min(text.length, entry.item.textOffset)) : 0 }));
    // Older history has no offsets: retain its work before the final answer.
    entries.sort((a, b) => a.offset - b.offset ||
      (a.item.timelineOrder || 0) - (b.item.timelineOrder || 0));
    let cursor = 0;
    for (const { kind, item, offset } of entries) {
      appendAssistantText(view, text.slice(cursor, offset));
      cursor = offset;
      if (kind === 'guidance') createGuidanceView(turn.runId, item);
      else {
        addToolRow({ ...item, runId: turn.runId });
        if (item.status !== 'running') finishToolRow({ ...item, runId: turn.runId });
      }
    }
    appendAssistantText(view, text.slice(cursor));
    if (
      turn.status &&
      !['starting', 'running', 'pausing', 'paused', 'resuming'].includes(turn.status)
    ) {
      finishTurnView(turn.runId, turn);
    }
  }
  const scroller = elements.workspaceBody?.querySelector('.agent-workspace-scroll');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
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

function approvalDisplayText(value) {
  // Show invisible formatting controls literally; preserve the request's exact
  // bytes for execution/signing and ordinary international text for display.
  return String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    character => ['\t', '\n', '\u200c', '\u200d'].includes(character) ? character
      : `\\u{${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`);
}

function appendWalletSummary(label, value) {
  if (!value) return;
  const term = document.createElement('dt');
  term.textContent = approvalDisplayText(label);
  const description = document.createElement('dd');
  description.textContent = approvalDisplayText(value);
  elements.walletApprovalSummary.appendChild(term);
  elements.walletApprovalSummary.appendChild(description);
}

function appendNodeRequestSummary(label, value) {
  if (!value) return;
  const term = document.createElement('dt');
  term.textContent = approvalDisplayText(label);
  const description = document.createElement('dd');
  description.textContent = approvalDisplayText(value);
  elements.nodeRequestSummary.appendChild(term);
  elements.nodeRequestSummary.appendChild(description);
}

function appendPublicationSummary(label, value) {
  if (!value) return;
  const term = document.createElement('dt');
  term.textContent = approvalDisplayText(label);
  const description = document.createElement('dd');
  description.textContent = approvalDisplayText(value);
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
        ? 'Project folder'
        : 'Project file'
      : publication.kind === 'folder'
        ? 'Attached folder'
        : publication.kind === 'file'
          ? 'Attached file'
          : 'Text'
  );
  if (publication.kind !== 'text') appendPublicationSummary('Name', publication.name);
  appendPublicationSummary('Project path', publication.workspacePath);
  if (Number.isSafeInteger(publication.bytes)) {
    appendPublicationSummary('Size', formatArtifactBytes(publication.bytes));
  }
  appendPublicationSummary('Media type', publication.contentType);
  appendPublicationSummary('Text to publish', publication.text);
  if (publication.files?.length) appendPublicationSummary('Files to publish', publication.files.map(file => `${file.path} (${formatArtifactBytes(file.bytes)})`).join('\n'));
  if (publication.excludedCount) appendPublicationSummary('Excluded', `${publication.excludedCount} private or credential entries`);
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
    appendNodeRequestSummary('Uncertainty', nodeRequest.classification.uncertainties.map(classifierUncertaintyText).join('\n'));
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
    appendNodeRequestSummary('Uncertainty', lifecycle.classification.uncertainties.map(classifierUncertaintyText).join('\n'));
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
      option.textContent = approvalDisplayText(`${account.name || 'Wallet'} · ${shortAddress(account.address)}`);
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

function workspaceCommandPermissionSummary(permission, reason) {
  const lines = reason ? [`Agent request: ${reason}`] : [];
  const installed = permission.commands
    .filter(({ status }) => status === 'requires_permission').map(({ name }) => name);
  if (installed.length) lines.push(`Installed tools needing workspace access: ${installed.join(', ')}.`);
  const unavailable = permission.commands.filter(({ status }) => status === 'unavailable');
  for (const command of unavailable) {
    lines.push(command.resolution === 'not_found'
      ? `${command.name}: not found in the supported command environment.`
      : command.resolution === 'unsupported_entry_point'
        ? `${command.name}: installed entry point cannot be exposed to the workspace.`
        : `${command.name}: unavailable in the workspace; installation status unknown.`);
  }
  if (permission.network) lines.push('With access to the internet, localhost, and LAN.');
  return lines.join('\n');
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
  approvalReadyAt = Math.max(Date.now(), lastApprovalDecisionAt + 600, lastDisplayedApprovalId && lastDisplayedApprovalId !== request?.approvalId ? Date.now() + 600 : 0);
  lastDisplayedApprovalId = request?.approvalId || lastDisplayedApprovalId;
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
  const pageTool = request.pageTool;
  const mcp = request.mcp;
  const publication = request.publication;
  const workspace = request.workspace;
  const workspacePermission = request.workspacePermission;
  const projectAccess = request.projectAccess;
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
  elements.approvalAction.textContent = mcp
    ? `Run “${mcp.name}” on ${mcp.server}?`
    : projectAccess
    ? `Allow editing “${projectAccess.name}”?`
    : pageTool
    ? `Run website tool “${pageTool.name}”?`
    : workspacePermission
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
              ? `Let Agent inspect recent ${diagnosticSubject} logs?`
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
                            : request.operation === 'browser_handle_dialog'
                              ? 'Respond to this website dialog?'
                              : interaction
                              ? interaction.kind === 'uncertain'
                                ? interactionCopy[request.operation] ||
                                  `Let Agent interact with “${label}”?`
                                : `${interaction.summary.replace(/[.?!]+$/, '')}?`
                              : interactionCopy[request.operation] ||
                                `Let Agent interact with “${label}”?`;
  elements.approvalOrigin.textContent = mcp
    ? `${approvalOriginSummary(request)} · This sends the arguments below to the connected service. Its claimed behavior is not verified.`
    : projectAccess
    ? `Agent can modify files and create local Git commits in this project. Access lasts for this conversation until you revoke it or restart Freedom. Change it anytime in the project menu.${request.label ? `\n\nAgent request: ${request.label}` : ''}`
    : pageTool
    ? `${approvalOriginSummary(request)} · This website tool runs using your current site session. Its claimed behavior is not verified.${pageTool.manualSubmit ? ' You will still need to submit the form yourself.' : ''}`
    : workspacePermission
    ? workspaceCommandPermissionSummary(workspacePermission, request.label)
    : workspace
      ? 'Agent can create, edit, and delete files inside a Freedom-managed project workspace.'
      : publication
        ? publication.workspacePath
          ? 'This publishes the managed project source snapshot listed below using an existing postage batch. The content is public, unencrypted, and may remain retrievable.'
          : publication.kind === 'folder'
            ? 'This publishes the attached folder snapshot listed below using an existing postage batch. The content is public, unencrypted, and may remain retrievable.'
            : 'This publishes the attached content using an existing postage batch. The content is public, unencrypted, and may remain retrievable.'
        : nodeRequest
          ? `${nodeRequest.providerLabel}${nodeRequest.modelId ? ` using ${nodeRequest.modelId}` : ''} independently classified this request as ${effectLabel(nodeRequest.effect).toLowerCase()}. Freedom has not sent it to the node yet.`
          : nodeLifecycle
            ? `${nodeLifecycle.providerLabel}${nodeLifecycle.modelId ? ` using ${nodeLifecycle.modelId}` : ''} classified this as ${effectLabel(nodeLifecycle.effect).toLowerCase()}. Freedom will run it through the node manager and verify the resulting state.`
            : diagnostic
              ? diagnostic.local
                ? `Raw diagnostic logs will be added to this conversation with ${diagnostic.providerLabel}${diagnostic.modelId ? ` using ${diagnostic.modelId}` : ''}. They remain on this device, but may include peer IDs, network or wallet addresses, local paths, and requested resources.`
                : `A bounded excerpt is added to this conversation and sent to your selected model at ${diagnostic.providerLabel}${diagnostic.modelId ? ` (${diagnostic.modelId})` : ''} to troubleshoot this problem. This is not a feedback report. Logs may include peer IDs, network or wallet addresses, local paths, and requested resources.`
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
  if (request.pageMessage) elements.approvalOrigin.textContent += `\n\nPage says: ${JSON.stringify(request.pageMessage)}`;
  if (request.inputPreview) elements.approvalOrigin.textContent += `\n\n${request.inputPreview.replace(/\r\n?|\n/g, ' ⏎ ')}`;
  if (interaction?.uncertainties?.length) elements.approvalOrigin.textContent += `\n\n${interaction.uncertainties.map(classifierUncertaintyText).join('\n')}`;
  elements.pageToolDetails.hidden = !pageTool && !mcp;
  elements.pageToolDetails.open = Boolean(pageTool || mcp);
  elements.pageToolArguments.textContent = mcp?.argumentsJSON || pageTool?.argumentsJSON || '';
  elements.approvalApprove.textContent = projectAccess
    ? 'Allow editing'
    : workspacePermission
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
  if (diagnostic) {
    elements.approvalAllowConversation.textContent = 'Share for conversation';
    elements.approvalOrigin.textContent += ' Sharing for this conversation covers node and Freedom application logs, including browsing diagnostics.';
  }
  if (workspacePermission) {
    elements.approvalAllowConversation.textContent = 'Allow for conversation';
  }
  if (request.wallet) renderWalletApproval(request);
  if (nodeRequest) renderNodeRequestApproval(request);
  if (nodeLifecycle) renderNodeLifecycleApproval(request);
  if (publication) renderPublicationApproval(request);
  for (const element of [elements.approvalAction, elements.approvalOrigin, elements.pageToolArguments, elements.workspacePermissionSummary]) {
    element.textContent = approvalDisplayText(element.textContent);
  }
  setApprovalControlsDisabled(false);
  if (Date.now() < approvalReadyAt) {
    elements.approvalApprove.disabled = true;
    elements.approvalAllowConversation.disabled = true;
    setTimeout(() => {
      if (pendingApproval !== request) return;
      elements.approvalApprove.disabled = false;
      elements.approvalAllowConversation.disabled = false;
    }, approvalReadyAt - Date.now());
  }
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

async function decideApproval(approved, options = {}, request = pendingApproval) {
  const runId = currentRunId;
  if (!request || !runId || request !== pendingApproval || (approved && Date.now() < approvalReadyAt)) return;
  setApprovalControlsDisabled(true);
  if (approved && request.wallet) {
    try {
      if (!(await ensureWalletUnlocked(request))) {
        if (pendingApproval !== request || currentRunId !== runId) return;
        setApprovalControlsDisabled(false);
        return;
      }
    } catch {
      if (pendingApproval !== request || currentRunId !== runId) return;
      setApprovalControlsDisabled(false);
      setMessage(elements.approvalMessage, 'Wallet unlock failed', true);
      return;
    }
  }
  if (pendingApproval !== request || currentRunId !== runId) return;
  lastApprovalDecisionAt = Date.now();
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
          runId,
          request.approvalId,
          approved,
          decisionOptions
        )
      : await window.electronAPI.decideAgentApproval(runId, request.approvalId, approved);
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
    if (pendingApproval !== request) return;
    if (!result?.success) {
      setMessage(elements.approvalMessage, result?.error || 'Incorrect password', true);
      return;
    }
    elements.walletPassword.value = '';
    elements.walletUnlock.hidden = true;
    await decideApproval(true, {}, request);
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
  if (operation === 'delegate_task') return 'The delegated task did not complete';
  if (operation === 'helper_reports') return 'Could not read the saved report. Reopen this conversation and try again';
  if (operation === 'helper_task') return 'The helper request could not be completed';
  const labels = {
    TAB_NOT_FOUND: 'Page is no longer open',
    NAVIGATION_FAILED: 'Page could not be opened',
    WAIT_TIMEOUT: 'Expected page state did not appear',
    STALE_ELEMENT_REFERENCE: 'Page changed before this could run',
    ELEMENT_NOT_FOUND: 'Page element is no longer available',
    ELEMENT_NOT_INTERACTABLE: 'Page element could not be used',
    APPROVAL_REQUIRED: 'Approval is still required',
    OBSERVATION_REQUIRED: 'Agent needs to refresh its view of this page',
    TAB_BUSY: 'A helper is currently using this tab',
    POLICY_DENIED: 'Blocked by Freedom policy',
    USER_CANCELLED: 'Cancelled; earlier effects may remain',
    FILE_UPLOAD_CANCELLED_BY_USER: 'File selection cancelled by you',
    DOWNLOAD_CANCELLED_BY_USER: 'Download cancelled by you',
    WALLET_REQUEST_CANCELLED_BY_USER: 'Wallet request declined by you',
    POSTAGE_CAPACITY_INSUFFICIENT: 'Postage capacity is too small for this upload',
    POSTAGE_UNAVAILABLE: 'No usable postage batch is available',
    CAPABILITY_UNAVAILABLE: 'Browser capability is unavailable',
    INTERNAL_ERROR: 'Browser action failed unexpectedly',
    PROJECT_READ_ONLY: 'Project is read-only. Agent can request editing access if needed',
    PROJECT_WRITE_DECLINED: 'Project editing access was declined',
    PROJECT_ACCESS_INVALID: 'Project access request expired or is invalid',
    PROJECT_UNAVAILABLE: 'No project is attached to this conversation',
    PROJECT_IN_USE: 'Project is already open for editing in another conversation',
    PROJECT_RECONNECT_REQUIRED: 'Reconnect the project from its menu to continue',
    PROJECT_CHANGED: 'Project moved or became unavailable. Reconnect it to continue',
    WORKSPACE_DIFF_UNAVAILABLE: 'Text diff unavailable. Inspect accessible files or review it in your Git client',
    PAGE_TOOL_OUTCOME_UNCONFIRMED: 'Website action did not confirm success. Inspect its result before retrying',
    WORKSPACE_HISTORY_UNAVAILABLE: 'Git operation unavailable. Inspect repository state before retrying',
    INVALID_WORKSPACE_REQUEST: 'Workspace request is invalid',
    WORKSPACE_COMMAND_CANCELLED: 'Workspace command was stopped',
    WORKSPACE_OPERATION_CANCELLED: 'Project operation was stopped',
    COMMAND_PERMISSION_DECLINED: 'Project permission was declined',
    EXECUTABLE_ACCESS_DECLINED: 'Executable access was declined',
    EXECUTABLE_INTERPRETER_UNAVAILABLE: 'A required script interpreter is unavailable',
    EXECUTABLE_INTERPRETER_UNSUPPORTED: 'The script launcher could not be resolved safely',
    WORKSPACE_COMMAND_FAILED: 'Workspace command exited unsuccessfully',
    WORKSPACE_AUDIT_FINDINGS: 'Dependency audit found vulnerabilities',
    COMMAND_REVIEW_STALE: 'Project files changed; command access needs a fresh review',
    WORKSPACE_COMMAND_NOT_FOUND: 'Command unavailable in this workspace; check installed-tool access before retrying',
    WORKSPACE_COMMAND_TIMED_OUT: 'Workspace command timed out',
    WORKSPACE_DIRECTORY_UNAVAILABLE: 'Workspace directory does not exist',
    WORKSPACE_EXECUTION_FAILED: 'Workspace command could not be executed',
    WORKSPACE_WRITER_BUSY: 'Project editing is owned by a helper or still in progress',
    DELEGATED_PATH_DENIED: 'File is outside the helper assignment',
    UNSAFE_GIT_CONFIGURATION: 'Project Git configuration is unsupported by the sandbox',
    WORKSPACE_CHANGED_DURING_VALIDATION: 'Project changed during filesystem validation',
    WORKSPACE_HARDLINK_DENIED: 'Project hardlinks could not be safely isolated',
    WORKSPACE_SPECIAL_FILE_DENIED: 'Project contains an unsupported special file',
    WORKSPACE_VALIDATION_LIMIT: 'Project exceeds the filesystem validation limit',
    EXTERNAL_GIT_METADATA_DENIED: 'Git metadata outside the project is unsupported',
    PROTECTED_PATH_MISSING: 'Required workspace metadata is unavailable',
    INVALID_WORKSPACE: 'Project root or working directory is unavailable',
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
  if (operation === 'workspace_history') return code === 'INTERNAL_ERROR' ? 'Git operation failed unexpectedly' : labels[code] || 'Git operation failed';
  if (
    ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls', 'workspace_preview',
      'write_stdin', 'request_permissions'].includes(operation)
  ) {
    return labels[code] || 'Workspace operation failed';
  }
  return labels[code] || 'Browser action failed';
}

// Verification stays in the receipts. Only unresolved outcomes and useful
// receipts belong beside the answer; downloads/publications have their own cards.
function visibleOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return null;
  if (outcome.publication?.publicationId) return null;
  if (outcome.kind === 'recovery') return outcome;
  if (outcome.notice) return outcome.notice;
  if (outcome.kind === 'interrupted') return outcome.counts?.changed > 0
    ? { ...outcome, detail: 'Changes made before stopping remain in place. Review the activity before continuing.' } : null;
  if ([
    'wallet_broadcast', 'page_tool_unresolved', 'swarm_publication_in_flight',
    'swarm_publication_failed', 'swarm_publication_outcome_unknown',
    'node_request_in_flight', 'node_delivery_uncertain',
  ].includes(outcome.verification)) return outcome;
  if (outcome.verification === 'workspace_execution_recorded' &&
      ['failed', 'timed_out', 'sandbox_denied'].includes(outcome.workspace?.state)) {
    return { ...outcome, headline: 'Project operation did not complete',
      detail: `${outcome.workspace.command || 'The last project operation'} did not complete. Check the activity for details.` };
  }
  return null;
}

function renderTurnOutcome(view, outcome, error) {
  if (!view) return;
  outcome = visibleOutcome(outcome);
  view.outcome.hidden = !outcome;
  if (!outcome) return;
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
    typeof publication.name !== 'string'
  ) {
    return;
  }
  const card = view.artifactList.querySelector(`[data-publication-id="${publication.publicationId}"]`) || document.createElement('div');
  const detailsOpen = card.querySelector('details')?.open;
  card.replaceChildren();
  card.className = 'agent-artifact agent-publication';
  card.dataset.publicationId = publication.publicationId;
  const copy = document.createElement('div');
  copy.className = 'agent-artifact-copy';
  const name = document.createElement('strong');
  name.textContent = publication.kind === 'text' ? 'Text' : publication.name;
  const meta = document.createElement('span');
  meta.textContent = publication.message || ({ waiting_postage: 'Waiting for postage', uploading: 'Uploading to Swarm', confirming: 'Waiting for network confirmation', verifying: 'Checking retrieval', failed: 'Upload failed', outcome_unknown: 'Publication needs checking', completed: publication.verified ? 'Swarm · retrieval verified' : 'Swarm · published, verification pending' })[publication.state];
  if (publication.state === 'confirming' && Number.isSafeInteger(publication.progress)) meta.textContent += ` · ${publication.progress}%`;
  if (publication.error) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Technical details';
    const error = document.createElement('p');
    error.textContent = publication.error;
    details.append(summary, error);
    details.open = Boolean(detailsOpen);
    copy.appendChild(details);
  }
  copy.appendChild(name);
  copy.appendChild(meta);
  const actions = document.createElement('div');
  actions.className = 'agent-artifact-actions';
  for (const [label, action] of (publication.state === 'completed' && /^bzz:\/\/[a-f0-9]{64}$/.test(publication.bzzUrl) ? [
    ['Open', () => window.electronAPI.openAgentPublication(publication.bzzUrl)],
    ['Copy URL', () => window.electronAPI.copyText(publication.bzzUrl)],
  ] : [])) {
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

function renderToolPage(record, event, finished = false) {
  record.pageIcon = null;
  record.label.classList.remove('agent-tool-page');
  if (!event.operation?.startsWith('browser_') || !event.origin) return;
  const label = (finished ? event.label : event.intent || event.label) || '';
  if (!label.endsWith(event.origin)) return;
  let host;
  try { host = new URL(event.origin).hostname; } catch { return; }
  if (!host) return;
  const action = label.slice(0, -event.origin.length).trim();
  const title = typeof event.pageTitle === 'string' ? event.pageTitle.slice(0, 240).trim() : '';
  const icon = document.createElement('span');
  icon.className = 'agent-tool-page-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/></svg>';
  const copy = document.createElement('span');
  copy.className = 'agent-tool-page-copy';
  const headline = document.createElement('span');
  headline.className = 'agent-tool-page-title';
  headline.textContent = `${action} ${title || host}`;
  headline.title = headline.textContent;
  copy.appendChild(headline);
  if (title) {
    const site = document.createElement('span');
    site.className = 'agent-tool-page-site';
    site.textContent = host;
    copy.appendChild(site);
  }
  if (finished && event.status === 'failed') {
    const error = document.createElement('span');
    error.className = 'agent-tool-page-error';
    error.textContent = formatToolError(event.errorCode, event.operation);
    copy.appendChild(error);
  }
  record.label.classList.add('agent-tool-page');
  record.label.replaceChildren(icon, copy);
  record.pageIcon = icon;
  // History rendering must not initiate requests to sites the user visited.
  void (async () => {
    try {
      const favicon = await window.electronAPI.getCachedFavicon?.(event.origin);
      if (record.pageIcon !== icon || typeof favicon !== 'string' ||
          !favicon.startsWith('data:image/') || favicon.length > 512 * 1024) return;
      const image = document.createElement('img');
      image.alt = '';
      image.src = favicon;
      image.addEventListener('error', () => { image.remove(); });
      icon.appendChild(image);
    } catch { /* Keep the neutral page icon when the favicon cache is unavailable. */ }
  })();
}

function addToolRow(event) {
  const view = turnView(event.runId);
  if (!view || typeof event.toolCallId !== 'string') return;
  const row = document.createElement('li');
  row.className = 'agent-tool-item';
  row.dataset.state = 'running';
  const state = document.createElement('span');
  state.className = 'agent-tool-state';
  state.textContent = '•';
  const label = document.createElement(event.operation === 'delegate_task' ? 'div' : 'span');
  label.textContent = event.intent || event.label || formatOperation(event.operation);
  const approval = document.createElement('span');
  approval.className = 'agent-tool-approval';
  approval.hidden = true;
  row.appendChild(state);
  row.appendChild(label);
  row.appendChild(approval);
  view.toolList.appendChild(row);
  view.activity.hidden = false;
  view.activity.dataset.state = 'working';
  view.actionCount += 1;
  closeAssistantSegment(view);
  let helperList = null;
  if (event.operation === 'delegate_task') {
    helperList = document.createElement('div');
    helperList.className = 'agent-helper-list';
    helperList.hidden = true;
    view.section.insertBefore(helperList, view.outcome);
  }
  toolRows.set(`${event.runId}:${event.toolCallId}`, { row, state, label, approval, helperList });
  renderToolPage(toolRows.get(`${event.runId}:${event.toolCallId}`), event);
  updateToolApproval(event.runId, event.toolCallId, event.approval);
}

function updateToolApproval(runId, toolCallId, decision) {
  if (typeof toolCallId !== 'string') return;
  const record = toolRows.get(`${runId}:${toolCallId}`);
  if (!record) return;
  const labels = {
    requested: 'Approval needed',
    approved: 'Approved',
    reviewer_approved: 'Approved by reviewer',
    declined: 'Declined',
    withdrawn: 'Withdrawn',
  };
  record.approval.textContent = labels[decision] || '';
  record.approval.hidden = !labels[decision];
  record.row.dataset.approval = labels[decision] ? decision : '';
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
  const processId = event.workspace?.processId;
  if (['bash', 'write_stdin'].includes(event.operation) && /^workspace_process_[a-f0-9]{24}$/.test(processId || '')) {
    const key = `${event.runId}:${processId}`;
    const existing = processDisplayRows.get(key);
    if (existing && existing !== record) {
      record.row.remove();
      record = existing;
      toolRows.set(`${event.runId}:${event.toolCallId}`, record);
    }
    // A late poll must not turn a finished process back into a running one.
    if (record.processTerminal && event.workspace.state === 'running') return;
    record.processTerminal = event.workspace.state !== 'running';
    processDisplayRows.set(key, record);
  }
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
  record.row.dataset.state = userCancelled ? 'cancelled' : event.status === 'failed' ? 'failed' : 'succeeded';
  record.row.title = '';
  if (event.status === 'failed' && event.operation !== 'delegate_task') {
    record.row.title = formatToolError(event.errorCode, event.operation);
    record.label.textContent = `${record.label.textContent} — ${formatToolError(event.errorCode, event.operation)}`;
  }
  renderToolPage(record, event, true);
  if (event.operation === 'delegate_task' && (event.subagent || event.subagents)) {
    const receipts = Array.isArray(event.subagents) ? event.subagents : [event.subagent];
    const view = turnView(event.runId);
    record.row.hidden = true;
    view.activity.hidden = [...view.toolList.children].every(row => row.hidden);
    record.helperList.hidden = false;
    for (const receipt of receipts) {
      const key = receipt.taskId || `${event.toolCallId}:${receipts.indexOf(receipt)}`;
      let card = view.helperCards.get(key);
      if (!card) {
        const details = document.createElement('details');
        details.className = 'agent-subagent-report';
        details.dataset.taskId = key;
        const summary = document.createElement('summary');
        const copy = document.createElement('span');
        copy.className = 'agent-helper-copy';
        const title = document.createElement('strong');
        title.className = 'agent-helper-title';
        const status = document.createElement('span');
        status.className = 'agent-helper-status';
        const preview = document.createElement('span');
        preview.className = 'agent-helper-preview';
        copy.appendChild(title); copy.appendChild(status); copy.appendChild(preview);
        const stop = document.createElement('button');
        stop.type = 'button'; stop.className = 'agent-button agent-helper-stop';
        stop.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
        stop.title = 'Stop helper';
        card = { details, summary, title, status, preview, stop, stopping: false };
        details.addEventListener('toggle', () => {
          if (details.open && card.reportId && !card.reportLoaded) card.loadReport?.();
        });
        stop.addEventListener('click', async click => {
          click.preventDefault(); click.stopPropagation();
          if (card.stopping || currentRunId !== event.runId || card.state !== 'running') return;
          card.stopping = true; stop.disabled = true; stop.title = 'Stopping…';
          try {
            const response = await window.electronAPI.stopAgentHelper(event.runId, receipt.taskId);
            if (!response?.ok || !response.stopped) {
              setMessage(elements.runMessage, response?.error?.message || 'This helper is no longer running. Its latest status will appear here.', true);
            }
          } catch { setMessage(elements.runMessage, 'Could not stop this helper. Try again, or use Stop task to stop all work.', true); }
          finally { card.stopping = false; stop.disabled = card.state !== 'running'; stop.title = 'Stop helper'; }
        });
        const chevron = document.createElement('span');
        chevron.className = 'agent-helper-chevron'; chevron.setAttribute('aria-hidden', 'true');
        // Lucide chevron-right, matching the workspace/composer icon style.
        chevron.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
        summary.appendChild(copy); summary.appendChild(stop); summary.appendChild(chevron);
        details.appendChild(summary);
        view.helperCards.set(key, card);
        record.helperList.appendChild(details);
      }
      const { details, summary } = card;
      card.state = receipt.state;
      details.dataset.state = receipt.state;
      card.title.textContent = receipt.title || 'Delegated task';
      const state = { running: 'Working', completed: 'Completed', cancelled: 'Stopped', failed: 'Failed',
        timed_out: 'Timed out', limited: 'Could not start' }[receipt.state] || 'Incomplete';
      const kind = receipt.mode === 'browser' ? 'Browser helper' : receipt.mode === 'edit' ? 'Editing helper' : 'Read-only helper';
      card.status.textContent = `${kind} · ${state}${receipt.state === 'running' && receipt.activity ? ` · ${receipt.activity}` : ''}`;
      card.preview.textContent = receipt.state === 'completed' ? (receipt.report || '').slice(0, 180) :
        receipt.state === 'cancelled' && ['edit', 'browser'].includes(receipt.mode) ? 'Stopped work may have made changes. Expand to review.' : '';
      card.preview.hidden = !card.preview.textContent;
      card.stop.hidden = receipt.state !== 'running' || currentRunId !== event.runId;
      card.stop.disabled = card.stopping || card.stop.hidden;
      card.stop.setAttribute('aria-label', `Stop helper: ${receipt.title || 'Delegated task'}`);
      // Keep the summary and its focused Stop button stable during progress updates.
      for (const child of [...details.children]) if (child !== summary) child.remove();
      const note = document.createElement('p');
      const calls = Number.isSafeInteger(receipt.toolCalls) ? receipt.toolCalls : 0;
      const scripts = Number.isSafeInteger(receipt.toolScripts) && receipt.toolScripts > 0 ? receipt.toolScripts : 0;
      note.textContent = `${calls} tool ${calls === 1 ? 'call' : 'calls'}${scripts ? ` · ${scripts} tool ${scripts === 1 ? 'script' : 'scripts'}` : ''} · Model-generated findings${receipt.reportTruncated ? ' · Report shortened' : ''}`;
      const report = document.createElement('div');
      report.className = 'agent-helper-report-body';
      report.textContent = typeof receipt.report === 'string' && receipt.report
        ? receipt.report : receipt.state === 'running' ? 'The helper is working. Its report will appear here.' : 'No complete report was returned';
      renderAgentMarkdown(report, report.textContent);
      if (receipt.state === 'completed' && receipt.report && report.classList.contains('rendered-markdown')) {
        card.preview.textContent = report.textContent.replace(/\s+/g, ' ').trim().slice(0, 180);
      }
      details.appendChild(note);
      details.appendChild(report);
      configureHelperReport(card, receipt, report);
      if (receipt.mode === 'browser') {
        const actions = document.createElement('ul');
        for (const action of (receipt.browserActions || []).slice(0, 48)) {
          const item = document.createElement('li');
          item.textContent = `${action.status === 'succeeded' ? '✓' : '×'} ${action.label || action.operation.replace(/^browser_/, '').replaceAll('_', ' ')}${action.pageTitle || action.origin ? ` — ${action.pageTitle || action.origin}` : ''}`;
          actions.appendChild(item);
        }
        details.appendChild(actions);
        if (receipt.browserPending) {
          const pending = document.createElement('p');
          pending.textContent = 'A browser operation was still settling. Review the returned tabs before continuing; stopping does not undo page actions.';
          details.appendChild(pending);
        }
      }
      if (receipt.mode === 'edit') {
        const changes = document.createElement('p');
        const paths = Array.isArray(receipt.changedFiles) ? receipt.changedFiles.slice(0, 20) : [];
        changes.textContent = paths.length ? `Files changed: ${paths.join(', ')}` : 'No completed file writes recorded';
        if (receipt.writesPending || (receipt.attemptedFiles || []).some(file => !paths.includes(file))) changes.textContent += ' Some writes were attempted or still settling; review the current files.';
        details.appendChild(changes);
      }
    }
    if (receipts.some(receipt => receipt.state === 'running')) {
      record.state.textContent = '•';
      record.row.dataset.state = 'running';
      record.row.classList.remove('failed');
    }
    if (receipts.every(receipt => ['completed', 'cancelled'].includes(receipt.state)) &&
        receipts.some(receipt => receipt.state === 'cancelled')) {
      record.state.textContent = '•';
      record.row.classList.remove('failed');
      record.row.classList.add('cancelled');
      record.row.dataset.state = 'cancelled';
    }
  }
  updateToolApproval(event.runId, event.toolCallId, event.approval);
  if (userCancelled) {
    record.approval.textContent = 'Cancelled by you';
    record.approval.hidden = false;
  }
  if (event.artifact) renderArtifact(event.runId, event.artifact);
  if (event.publication) renderPublication(event.runId, event.publication);
}

// Load only expanded reports. Each click fetches another bounded page; conversation
// changes and newer follow-up reports invalidate in-flight responses.
function configureHelperReport(card, receipt, body) {
  if (!receipt.reportId) return;
  const conversationId = currentConversationId;
  const reportId = receipt.reportId;
  if (card.reportId !== reportId) {
    card.reportId = reportId;
    card.reportText = '';
    card.reportLoaded = false;
    card.reportLoading = false;
    card.reportOffset = 0;
    card.reportError = '';
  }
  const more = document.createElement('button');
  more.type = 'button'; more.className = 'agent-button';
  card.details.appendChild(more);
  const paint = () => {
    const text = card.reportLoaded ? card.reportText : receipt.report || '';
    body.textContent = text;
    renderAgentMarkdown(body, text);
    more.hidden = card.reportLoaded && card.reportOffset === null;
    more.disabled = card.reportLoading;
    more.textContent = card.reportLoading ? 'Loading report…' : card.reportError
      ? 'Retry loading report' : card.reportLoaded ? 'Show more' : 'Load report';
    more.title = card.reportError || '';
  };
  card.paintReport = paint;
  card.loadReport = async () => {
    if (card.reportLoading || card.reportOffset === null || currentConversationId !== conversationId) return;
    card.reportLoading = true; card.paintReport();
    try {
      const response = await window.electronAPI.readAgentHelperReport(conversationId, reportId, card.reportOffset);
      if (currentConversationId !== conversationId || card.reportId !== reportId) return;
      if (!response?.ok || response.result?.error || typeof response.result?.text !== 'string') {
        throw new Error(response?.result?.error || response?.error?.message || 'Could not load this report. Try again.');
      }
      card.reportText += response.result.text;
      card.reportOffset = response.result.nextOffset;
      card.reportLoaded = true;
      card.reportError = '';
    } catch (error) {
      if (currentConversationId === conversationId && card.reportId === reportId) card.reportError = error.message;
    } finally {
      if (currentConversationId === conversationId && card.reportId === reportId) {
        card.reportLoading = false; card.paintReport();
      }
    }
  };
  more.addEventListener('click', () => card.loadReport());
  paint();
  if (card.details.open && !card.reportLoaded && !card.reportError) card.loadReport();
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
    renderPublication(event.runId, publication);
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
  view.activity.dataset.state = [...view.toolList.children].some(row => row.classList.contains('failed')) ? 'failed' : 'done';
  const actionCount = Number.isSafeInteger(event.actionCount)
    ? event.actionCount
    : view.actionCount;
  if (actionCount > 0) {
    view.activity.hidden = [...view.toolList.children].every(row => row.hidden);
    view.activity.open = false;
    const outcomeLabel = outcomeSummaryLabel(event.outcome);
    view.activitySummary.textContent = `Worked for ${formatDuration(event.durationMs)} · ${actionCount} ${actionCount === 1 ? 'action' : 'actions'}${outcomeLabel ? ` · ${outcomeLabel}` : ''}`;
  } else {
    view.activity.hidden = true;
  }
  renderTurnOutcome(view, event.outcome, event.error);
  if (event.status === 'completed') {
    for (const segment of view.outputSegments) {
      if (!segment.output.classList.contains('rendered-markdown')) renderAgentMarkdown(segment.output, segment.text);
    }
  }
}

function applyReadyConversationState(state) {
  if (!state?.conversationId) return false;
  workspaceProjectionGeneration += 1;
  currentConversationId = state.conversationId;
  applyWorkspaceProjection(state);
  if (Object.hasOwn(APPROVAL_MODE_LABELS, state.approvalMode)) {
    setApprovalMode(state.approvalMode, { force: true });
  }
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
  setScopeNotice(scopeNoticeForConversation());
  renderTaskPages();
  renderSessionSidebar();
  renderPageContext();
  return true;
}

async function changeProjectAccess(action) {
  if (currentRunStatus !== 'idle') return;
  closeComposerPopovers();
  try {
    const response = await window.electronAPI.agentProjectAccess(action, currentConversationId);
    if (response?.cancelled) return;
    if (!response?.ok || !applyReadyConversationState(response.state)) {
      setMessage(elements.runMessage, responseMessage(response, 'Could not change project access'), true);
      return;
    }
    await refreshSessionHistory();
    const stoppedAccess = action === 'remove' || action === 'read';
    const message = action === 'open' ? 'Project opened with read-only access.' : action === 'remove'
      ? 'Project disconnected. Reconnect it here when you need it again.' : action === 'read'
        ? 'Project is now read-only.' : 'Project access updated.';
    setMessage(elements.runMessage, message + (stoppedAccess && response.state.workspace?.commands?.length
      ? ' Previously launched processes may keep access until they exit.' : ''));
  } catch { setMessage(elements.runMessage, 'Could not change project access', true); }
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

async function renameSavedSession(session, row, select) {
  if (currentRunStatus !== 'idle') return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'agent-session-select';
  input.setAttribute('aria-label', 'Session title');
  input.maxLength = 120;
  input.value = session.title || '';
  select.hidden = true;
  row.appendChild(input);
  const title = await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; input.remove(); select.hidden = false; resolve(value);
    };
    input.addEventListener('keydown', event => {
      if (!['Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      finish(event.key === 'Enter' ? input.value : null);
      select.focus();
    });
    input.addEventListener('blur', () => finish(null));
    input.focus(); input.select?.();
  });
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
  hiddenWorkspaceConversations.delete(null);
  workspaceInspectionConversationId = null;
  workspaceInspector?.setWorkspace(null);
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
  renderWorkspaceProcesses([]);
  renderTaskPages();
  resetConversationUi();
  setRunState('idle', 'Idle');
  renderSessionSidebar();
  void refreshSessionHistory();
  void refreshWorkspaceProjection();
}

function handleAgentEvent(event) {
  const scroller = elements.workspaceBody?.querySelector('.agent-workspace-scroll');
  const follow = scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 48;
  try {
    applyAgentEvent(event);
  } finally {
    // Incoming tokens and helper updates must not fight someone reading above.
    // Only scroll this container, never the page or its overflow ancestors.
    if (follow) scroller.scrollTop = scroller.scrollHeight;
  }
}

function applyAgentEvent(event) {
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
  if (event?.type === 'workspace_processes_changed') {
    if (event.conversationId === currentConversationId) void refreshWorkspaceProjection();
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
    const scope =
      scopeNoticeForConversation() ||
      'Agent can use only the tabs it opens for this conversation.';
    setScopeNotice(scope);
    // Agent-first mode has no floating header, so it keeps the inline notice.
    setMessage(elements.runMessage, agentFirstMode ? scope : '');
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
    ['reasoning_heading', 'subagent'].includes(event.source) &&
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
    appendAssistantText(view, event.text);
    setLiveStatus(event.runId, 'Responding…');
    elements.emptyState.hidden = true;
  } else if (event.type === 'workspace_checkpoint_started') {
    setLiveStatus(event.runId, 'Saving workspace version…');
  } else if (event.type === 'tool_started') {
    addToolRow(event);
    const view = turnView(event.runId);
    if (view && event.intent) view.activitySummary.textContent = event.intent;
    setMessage(elements.runMessage, event.intent || 'Agent is working in the browser…');
    setLiveStatus(event.runId, event.intent || 'Working…');
    elements.emptyState.hidden = true;
  } else if (event.type === 'tool_finished') {
    finishToolRow(event);
    if (event.operation === 'delegate_task' && (event.subagents || [event.subagent]).some(item => item?.state === 'running')) {
      setMessage(elements.runMessage, event.label || 'Helpers are working.');
      setLiveStatus(event.runId, 'Helpers are working…');
    } else if (event.operation === 'delegate_task' && (event.subagents || [event.subagent]).every(item => item && ['completed', 'cancelled'].includes(item.state))) {
      setMessage(elements.runMessage, event.label || 'Helper work finished.');
      setLiveStatus(event.runId, 'Reviewing helper results…');
    } else if (event.status === 'failed') {
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
    setPanelOpen(true);
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
    for (const card of turnView(event.runId)?.helperCards.values() || []) { card.stop.hidden = true; card.stop.disabled = true; }
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
  if (attachmentSelectionPending) return false;
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
  captureLauncherSnapshot();
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
    !view || view !== [...turnViews.values()].at(-1) ||
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
  lastGuidanceSentAt = Date.now();
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

function submitComposer({ allowStop = false } = {}) {
  if (currentRunStatus === 'running') {
    if (elements.prompt.value.trim()) {
      void steerRun();
    } else if (allowStop && Date.now() - lastGuidanceSentAt >= 600) {
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
      for (const card of turnView(state.runId)?.helperCards.values() || []) {
        card.stop.hidden = card.state !== 'running'; card.stop.disabled = card.stop.hidden || card.stopping;
      }
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
    sessionSidebarToggle: byId('agent-session-sidebar-toggle'),
    workspaceSidebarToggle: byId('agent-workspace-sidebar-toggle'),
    sessionSidebar: byId('agent-session-sidebar'),
    modeToggle: byId('agent-mode-toggle'),
    browserModeToggle: byId('agent-browser-mode-toggle'),
    modeMenu: byId('agent-mode-menu'),
    modeAgent: byId('agent-mode-agent'),
    modeBrowser: byId('agent-mode-browser'),
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
    workspaceBody: byId('agent-workspace-body'),
    workspaceInspectorPanel: byId('agent-workspace-inspector-panel'),
    workspaceInspectorCompact: byId('agent-workspace-inspector-compact'),
    processPanel: byId('agent-process-panel'),
    processPanelCount: byId('agent-process-panel-count'),
    processPanelHeading: byId('agent-process-panel-heading'),
    processPanelLabel: byId('agent-process-panel-label'),
    processCompactHeading: byId('agent-process-compact-heading'),
    processCompactHeadingLabel: byId('agent-process-compact-heading-label'),
    processPanelList: byId('agent-process-panel-list'),
    processCompact: byId('agent-process-compact'),
    processCompactToggle: byId('agent-process-compact-toggle'),
    workspaceRefresh: byId('agent-workspace-refresh'),
    processCompactLabel: byId('agent-process-compact-label'),
    processCompactPopover: byId('agent-process-compact-popover'),
    processCompactCount: byId('agent-process-compact-count'),
    processCompactList: byId('agent-process-compact-list'),
    mcpPanel: byId('agent-mcp-panel'),
    providerHome: byId('agent-provider-home'),
    providerBrowser: byId('agent-provider-browser'),
    providerDetail: byId('agent-provider-detail'),
    providerAdd: byId('agent-provider-add'),
    providerListBack: byId('agent-provider-list-back'),
    providerDetailBack: byId('agent-provider-detail-back'),
    providerChoices: byId('agent-provider-choices'),
    providerMethods: byId('agent-provider-methods'),
    providerChatgpt: byId('agent-provider-chatgpt'),
    subscriptionMethodTitle: byId('agent-subscription-method-title'),
    subscriptionMethodHelp: byId('agent-subscription-method-help'),
    authCodeInstruction: byId('agent-auth-code-instruction'),
    chatgptConnectionState: byId('agent-provider-chatgpt-state'),
    apiConnectionState: byId('agent-provider-api-state'),
    providerApi: byId('agent-provider-api'),
    connectionFields: byId('agent-provider-connection-fields'),
    providerAdvanced: byId('agent-provider-advanced'),
    providerModelsHeading: byId('agent-provider-models-heading'),
    providerModelsList: byId('agent-provider-models-list'),
    providerModelsEmpty: byId('agent-provider-models-empty'),
    keySettings: byId('agent-provider-key-settings'),
    subscriptionNote: byId('agent-subscription-note'),
    connectedProviders: byId('agent-connected-providers'),
    connectedProviderList: byId('agent-connected-provider-list'),
    provider: byId('agent-provider-select'),
    providerHeading: byId('agent-provider-form-heading'),
    providerSearch: byId('agent-provider-search'),
    testProvider: byId('agent-provider-test'),
    testProviderNote: byId('agent-provider-test-note'),
    modelRefresh: byId('agent-model-refresh'),
    modelDetails: byId('agent-model-details'),
    providerDisconnect: byId('agent-provider-disconnect'),
    modelMenuSearch: byId('agent-model-menu-search'),
    catalogStatus: byId('agent-catalog-status'),
    privacyControls: byId('agent-privacy-controls'),
    privacyPolicy: byId('agent-privacy-policy'),
    privacySave: byId('agent-privacy-save'),
    providerStatus: byId('agent-provider-status'),
    providerPrivacy: byId('agent-provider-privacy'),
    hostedFields: byId('agent-hosted-fields'),
    apiKeyField: byId('agent-api-key-field'),
    subscriptionFields: byId('agent-subscription-fields'),
    ollamaFields: byId('agent-ollama-fields'),
    model: byId('agent-model-select'),
    apiKey: byId('agent-api-key'),
    ollamaUrl: byId('agent-ollama-url'),
    saveProvider: byId('agent-provider-save'),
    loginProvider: byId('agent-provider-login'),
    cancelProviderLogin: byId('agent-provider-cancel-login'),
    authCode: byId('agent-auth-code'),
    authCallback: byId('agent-auth-callback'),
    authCallbackInput: byId('agent-auth-callback-input'),
    authCallbackSubmit: byId('agent-auth-callback-submit'),
    authUserCode: byId('agent-auth-user-code'),
    providerMessage: byId('agent-provider-message'),
    pageContexts: byId('agent-page-contexts'),
    pageContext: byId('agent-page-context'),
    pageContextLabel: byId('agent-page-context-label'),
    prompt: byId('agent-prompt'),
    composer: byId('agent-composer'),
    composerWrap: byId('agent-composer-wrap'),
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
    pageToolDetails: byId('agent-page-tool-details'),
    pageToolArguments: byId('agent-page-tool-arguments'),
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
    openProject: byId('agent-open-project'),
    attachmentContexts: byId('agent-attachment-contexts'),
  };
  if (Object.values(elements).some((element) => !element)) return;
  panelInner = elements.panel.querySelector?.('.agent-sidebar-inner') || null;
  panelHeader = elements.panel.querySelector?.('.agent-sidebar-header') || null;
  runHeader = elements.panel.querySelector?.('.agent-run-header') || null;
  runHeaderHome = runHeader?.parentNode || null;
  floatTitle = byId('agent-float-title');
  scopeHelpButton = byId('agent-scope-help');
  scopeHelpText = byId('agent-scope-help-text');
  scopeHelpButton?.addEventListener?.('click', () =>
    setScopeHelpOpen(scopeHelpText?.hidden !== false)
  );
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

  workspaceInspector = createWorkspaceInspector([elements.workspaceInspectorPanel, elements.workspaceInspectorCompact], {
    openTab: options.createWorkspaceViewerTab,
    closeTab: options.closeViewerTab,
    onOpenViewer: () => { if (agentFirstMode) setWorkspaceSidebarOpen(true); },
  }, { compactHost: elements.workspaceInspectorCompact, refreshControl: elements.workspaceRefresh, onProjectAccess: changeProjectAccess });
  setAgentTabClaimHandler(claimAgentOwnedTab);
  pageActions?.dispose();
  if (byId('agent-page-actions') && window.electronAPI.getAgentPageActions) {
    pageActions = createPageActions({
      host: byId('agent-page-actions'), hint: byId('agent-page-actions-hint'), toggle: elements.toggle,
      getTab: pageActionsTab,
      getState: () => ({
        open: panelOpen,
        suppressed: agentFirstMode || isSignatureInFlight() || isWalletSidebarVisible(),
        busy: currentRunStatus !== 'idle' || Boolean(pendingApproval),
        newChat: pageActionsNeedNewChat(pageActionsTab()),
      }),
      discover: (tabId) => window.electronAPI.getAgentPageActions(tabId),
      openPanel,
      onSelect: async (action, tab) => {
        openPanel();
        if (!panelOpen || currentRunStatus !== 'idle') return;
        if (pageActionsNeedNewChat(tab)) {
          await clearConversation();
          if (currentConversationId) return;
        }
        if (getActiveTab()?.id !== tab.id || getActiveTab()?.url !== tab.url) return;
        dismissedPageContextTabId = null;
        const prompt = pageActionPrompt(action, tab.url);
        if (!providerReady) {
          elements.prompt.value = prompt;
          showProviderSetup();
          return;
        }
        await startRun({ prompt });
      },
    });
  }

  syncFloatingPresentation();
  panelInner?.addEventListener?.('transitionend', (event) => {
    if (event.target === panelInner) captureLauncherSnapshot();
  });
  elements.toggle.addEventListener('click', togglePanel);
  elements.close.addEventListener('click', closePanel);
  elements.agentFirstToggle.addEventListener('click', () => setAgentFirstMode(!agentFirstMode));
  for (const toggle of [elements.modeToggle, elements.browserModeToggle]) {
    toggle.addEventListener('click', () => setModeMenuOpen(elements.modeMenu.hidden));
    toggle.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setModeMenuOpen(true);
        (event.key === 'ArrowUp' ? elements.modeBrowser : elements.modeAgent).focus();
      }
    });
  }
  elements.modeAgent.addEventListener('click', () => {
    if (agentFirstMode) setModeMenuOpen(false, true);
    else setAgentFirstMode(true);
  });
  elements.modeBrowser.addEventListener('click', () => {
    if (!agentFirstMode) setModeMenuOpen(false, true);
    else {
      setAgentFirstMode(false);
      elements.browserModeToggle.focus();
    }
  });
  elements.modeMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      setModeMenuOpen(false, true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? elements.modeAgent : event.key === 'End' ? elements.modeBrowser
        : document.activeElement === elements.modeAgent ? elements.modeBrowser : elements.modeAgent;
      next.focus();
    }
  });
  elements.sessionSidebarToggle.addEventListener('click', () =>
    setSessionSidebarOpen(!sessionSidebarOpen)
  );
  elements.workspaceSidebarToggle.addEventListener('click', () => {
    if (!elements.workspaceSidebarToggle.disabled) setWorkspaceSidebarOpen(!workspaceSidebarOpen);
  });
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
  elements.back.addEventListener('click', () => {
    if (agentView === 'services' && mcpPanel.back()) return;
    const restoreAgentFirst = agentView === 'services' && servicesReturnToAgentFirst;
    setAgentView('workspace');
    if (restoreAgentFirst) setAgentFirstMode(true);
    focusComposer();
  });
  elements.provider.addEventListener('change', () => {
    elements.apiKey.value = '';
      elements.model.value = providerConnection(elements.provider.value)?.modelId || '';
    renderProviderFields();
    setMessage(elements.providerMessage, '');
  });
  const mcpPanel = createMcpConnectionsPanel(elements.mcpPanel, window.electronAPI);
  byId('agent-mcp-open').addEventListener('click', () => {
    servicesReturnToAgentFirst = agentFirstMode;
    setAgentView('services');
    mcpPanel.open();
  });
  elements.providerAdd.addEventListener('click', () => { renderProviderOptions(); showProviderScreen('browser'); });
  elements.providerListBack.addEventListener('click', () => showProviderScreen('home'));
  elements.providerDetailBack.addEventListener('click', () => { if (!providerLoginPending) showProviderScreen('home'); });
  elements.providerChatgpt.addEventListener('click', () => openProviderDetail(elements.provider.value === 'meta' ? 'meta-subscription' : 'openai-chatgpt'));
  elements.providerApi.addEventListener('click', () => openProviderDetail(elements.provider.value === 'meta' ? 'meta' : 'openai'));
  elements.providerSearch.addEventListener('input', renderProviderOptions);
  elements.model.addEventListener('change', renderModelDetails);
  elements.modelRefresh.addEventListener('click', refreshModelCatalog);
  elements.testProvider.addEventListener('click', testProviderConnection);
  elements.modelMenuSearch.addEventListener('input', renderModelMenu);
  elements.privacyPolicy.addEventListener('change', () => renderModelOptions(elements.provider.value));
  elements.privacySave.addEventListener('click', () => saveProviderPreferences({ privacyPolicy: elements.privacyPolicy.value }));
  elements.providerDisconnect.addEventListener('click', () => removeProviderConnection(elements.provider.value));
  elements.saveProvider.addEventListener('click', saveProvider);
  elements.loginProvider.addEventListener('click', loginSubscriptionProvider);
  elements.authCallbackSubmit.addEventListener('click', async () => {
    if (!providerLoginPending) return;
    const callbackUrl = elements.authCallbackInput.value.trim();
    elements.authCallbackInput.value = '';
    try {
      const response = await window.electronAPI.submitAgentProviderLogin(elements.authCallback.dataset.requestId, callbackUrl);
      if (!response?.ok) setMessage(elements.providerMessage, responseMessage(response, 'Could not complete sign-in'), true);
    } catch { setMessage(elements.providerMessage, 'Could not complete sign-in', true); }
  });
  elements.cancelProviderLogin.addEventListener('click', cancelProviderLogin);
  elements.run.addEventListener('click', event => submitComposer({ allowStop: !(event.detail > 1) }));
  elements.processCompactToggle.addEventListener('click', () => {
    const opening = elements.processCompactPopover.hidden;
    closeComposerPopovers();
    elements.processCompactPopover.hidden = !opening;
    elements.processCompactToggle.setAttribute('aria-expanded', String(opening));
  });
  elements.attachmentButton.addEventListener('click', () => {
    const opening = elements.attachmentMenu.hidden;
    closeComposerPopovers();
    elements.attachmentMenu.hidden = !opening;
    elements.attachmentButton.setAttribute('aria-expanded', String(opening));
  });
  elements.attachFiles.addEventListener('click', () => addAttachments('files'));
  installComposerDrop();
  elements.attachFolder.addEventListener('click', () => addAttachments('folder'));
  elements.openProject.addEventListener('click', () => void changeProjectAccess('open'));
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
  elements.approvalApprove.addEventListener('click', event => { if (!(event.detail > 1)) void decideApproval(true); });
  elements.approvalAllowConversation.addEventListener('click', event =>
    !(event.detail > 1) && decideApproval(true, {
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
    if (!elements.modeMenu.hidden && !elements.modeMenu.contains(event.target) && !elements.modeToggle.contains(event.target) && !elements.browserModeToggle.contains(event.target)) setModeMenuOpen(false);
    if (sessionContextMenu && !sessionContextMenu.actions.contains(event.target)) closeSessionContextMenu();
    for (const host of [elements.workspaceInspectorPanel, elements.workspaceInspectorCompact]) {
      const options = host.querySelector('.agent-workspace-options');
      if (options?.open && !(event.composedPath?.() || []).includes(options) && !options.contains(event.target)) options.open = false;
    }
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
  document.addEventListener('contextmenu', (event) => {
    if (sessionContextMenu && !sessionContextMenu.row.contains(event.target)) closeSessionContextMenu();
  });
  document.addEventListener('scroll', () => closeSessionContextMenu(), true);
  window.addEventListener('resize', () => {
    closeSessionContextMenu();
    setModeMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector?.('dialog[open]')) return;
    if (!elements.modeMenu.hidden) {
      event.preventDefault();
      setModeMenuOpen(false, true);
      return;
    }
    if (sessionContextMenu) {
      event.preventDefault();
      closeSessionContextMenu(true);
      return;
    }
    if (scopeHelpText && !scopeHelpText.hidden) {
      event.preventDefault();
      setScopeHelpOpen(false);
      scopeHelpButton?.focus?.();
      return;
    }
    const openOptions = [elements.workspaceInspectorPanel, elements.workspaceInspectorCompact]
      .map((host) => host.querySelector('.agent-workspace-options')).find((options) => options?.open);
    if (openOptions) {
      event.preventDefault();
      openOptions.open = false;
      openOptions.querySelector('summary').focus();
      return;
    }
    const popoverWasOpen =
      !elements.modelMenu.hidden ||
      !elements.approvalModePopover.hidden ||
      !elements.attachmentMenu.hidden;
    closeComposerPopovers();
    if (popoverWasOpen) event.preventDefault();
    if (!elements.takeoverDialog.hidden) {
      event.preventDefault();
      setTakeoverDialogOpen(false);
    } else if (!popoverWasOpen && !elements.processCompactPopover.hidden) {
      event.preventDefault();
      elements.processCompactPopover.hidden = true;
      elements.processCompactToggle.setAttribute('aria-expanded', 'false');
      elements.processCompactToggle.focus();
    } else if (!popoverWasOpen && !agentFirstMode && panelOpen && !pendingApproval &&
      (elements.panel.contains(event.target) || event.target === document.body)) {
      // The floating surface only goes away: a running task keeps running and
      // the draft stays in the composer for the next Cmd/Ctrl+K.
      event.preventDefault();
      closePanel();
    } else if (!popoverWasOpen && agentFirstMode && currentRunStatus === 'running' && currentRunId &&
      elements.panel.contains(event.target) && !event.target?.closest?.('input, textarea, [contenteditable], #agent-approval')) {
      event.preventDefault();
      void stopRun();
    } else if (!popoverWasOpen && agentFirstMode) {
      setAgentFirstMode(false);
    }
  });
  // Cmd/Ctrl+K while the chrome has focus; with the page focused the same
  // chord arrives through the View menu accelerator instead (main → agent:toggle).
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !matchesShortcut(event, 'view.toggleAgent')) return;
    event.preventDefault();
    summonPanel();
  });
  window.electronAPI?.onToggleAgent?.(() => summonPanel());
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
          const previousActive = openTabs.find(tab => tab.isActive)?.id;
          openTabs = Array.isArray(tabs) ? tabs : [];
          const active = openTabs.find(tab => tab.isActive);
          if (agentFirstMode && active && active.id !== previousActive &&
              !workspacePages().some(entry => entry.rendererTabId === active.id)) setAgentFirstMode(false);
          if (
            dismissedPageContextTabId &&
            !openTabs.some((tab) => tab.id === dismissedPageContextTabId && tab.isActive)
          ) {
            dismissedPageContextTabId = null;
          }
          void pageActions?.refresh();
          renderPageContext();
          renderTaskPages();
          renderPageInterlock();
        })
      : null;
  observeComposerHeight();
  setPanelOpen(false);
  setSessionSidebarOpen(true);
  setWorkspaceSidebarOpen(true);
  setConversationTitle('New task');
  setAgentFirstMode(false);
  setAgentView('loading');
  setApprovalMode(approvalMode);
  renderProviderFields();
  updateSendAvailability();
  setWorkspaceNavigationEditable(true);
  renderSessionSidebar();
  refreshProvider();
  restoreRunState();
  void refreshSessionHistory();
}

export { formatOperation, handleAgentEvent, providerPrivacyMessage, responseMessage };
