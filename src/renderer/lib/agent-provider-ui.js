import { modelPrivacyInfo, createModelPrivacySymbols } from './agent-privacy.js';

const PROVIDER_NAMES = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI · API',
  'anthropic-claude': 'Anthropic · Claude subscription',
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
// Shared provider and model UI. Only Settings mounts the configuration form;
// the conversation host supplies just its model picker and lifecycle callbacks.
export function createAgentProviderUi(options = {}) {
  const api = options.api || window.electronAPI;
  const byId = (id) => document.getElementById(id);
  const elements = {
    compatibility: byId('agent-compatibility'),
    compatibilityModel: byId('agent-compatibility-model'),
    compatibilityNote: byId('agent-compatibility-note'),
    compatibilityActions: byId('agent-compatibility-actions'),
    compatibilityResult: byId('agent-compatibility-result'),
    compatibilityContinue: byId('agent-compatibility-continue'),
    customFields: byId('agent-custom-fields'),
    customName: byId('agent-custom-name'),
    customUrl: byId('agent-custom-url'),
    customModels: byId('agent-custom-models'),
    customClearKey: byId('agent-custom-clear-key'),
    customClearKeyField: byId('agent-custom-clear-key-field'),
    customTransport: byId('agent-custom-transport'),
    customSettings: byId('agent-custom-model-settings'),
    customContext: byId('agent-custom-context'),
    customOutput: byId('agent-custom-output'),
    customVision: byId('agent-custom-vision'),
    customReasoning: byId('agent-custom-reasoning'),
    customSchema: byId('agent-custom-schema'),
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
    providerDisconnectConfirm: byId('agent-provider-disconnect-confirm'),
    providerDisconnectQuestion: byId('agent-provider-disconnect-question'),
    providerDisconnectAccept: byId('agent-provider-disconnect-accept'),
    providerDisconnectCancel: byId('agent-provider-disconnect-cancel'),
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
    ...options.elements,
  };
  const state = options.state || {
    providerCatalog: [],
    providerCatalogPromise: null,
    providerStatus: null,
    providerReady: false,
  };
  const context = options.context || {
    conversationId: null,
    runStatus: 'idle',
    view: 'settings',
    privacy: null,
    showPrimaryView() {},
    setAgentView() {},
    focusComposer() {},
    updateSendAvailability() {},
    closeComposerPopovers() {},
  };
  let catalogGeneration = 0;
  let compatibilityCheck = null;
  let compatibilityCheckPending = false;
  let providerLoginPending = false;
  let providerLoginGeneration = 0;
  let choosingProviderMethod = false;
  const expandedModelProviders = new Set();
  const responseMessage = (response, fallback) => response?.error?.message || fallback;
  const setMessage = (element, text = '', error = false) => {
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('error', error);
  };
  const isCustomProvider = (id) => id === 'openai-compatible' || id?.startsWith('custom-');
  function providerName(providerId) {
    return (
      PROVIDER_NAMES[providerId] ||
      providerConnection(providerId)?.name ||
      state.providerCatalog.find((p) => p.providerId === providerId)?.name ||
      (providerId === 'openai-compatible' ? 'OpenAI-compatible' : '') ||
      providerId ||
      'Model'
    );
  }

  // What a provider's page is called. While it still asks how to connect
  // (subscription or API key) it is the company, not one of the two ways:
  // "OpenAI", not "OpenAI · API".
  function providerPageTitle(providerId) {
    if (!choosingProviderMethod || elements.provider?.value !== providerId)
      return providerName(providerId);
    if (['anthropic', 'anthropic-claude'].includes(providerId)) return 'Anthropic';
    if (['meta', 'meta-subscription'].includes(providerId)) return 'Meta (Muse)';
    return 'OpenAI';
  }

  function providerPrivacyMessage(providerId) {
    if (providerId === 'ollama') {
      return 'Model requests stay on this device and are sent only to your local Ollama server.';
    }
    if (['openai-chatgpt', 'openai-codex'].includes(providerId)) {
      return 'Requests go to OpenAI through your ChatGPT subscription, including conversation and content Agent reads.';
    }
    const description = state.providerCatalog.find(
      (provider) => provider.providerId === providerId
    )?.privacy;
    if (description)
      return `Your task, conversation and content Agent reads are sent to this provider. ${description}`;
    return `Your task and page content the agent reads may be sent to ${providerName(providerId)}. Avoid using Agent on pages containing sensitive information.`;
  }

  function providerAuthType(providerId) {
    return (
      state.providerCatalog.find((candidate) => candidate.providerId === providerId)?.authType ||
      (['anthropic-claude', 'openai-chatgpt', 'openai-codex', 'meta-subscription'].includes(
        providerId
      )
        ? 'subscription'
        : 'api_key')
    );
  }

  function providerConnections() {
    if (Array.isArray(state.providerStatus?.connections)) return state.providerStatus.connections;
    if (!state.providerStatus?.configured) return [];
    return [
      {
        kind: state.providerStatus.kind,
        providerId: state.providerStatus.providerId,
        modelId: state.providerStatus.modelId,
        ...(state.providerStatus.kind === 'ollama' && {
          baseUrl: state.providerStatus.baseUrl,
          modelIds: [state.providerStatus.modelId],
        }),
      },
    ];
  }

  function providerConnection(providerId) {
    return providerConnections().find((connection) => connection.providerId === providerId);
  }

  function catalogModel(providerId, modelId) {
    return state.providerCatalog
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
          : state.providerCatalog.find((provider) => provider.providerId === connection.providerId)
              ?.models || [{ id: connection.modelId, name: connection.modelId }];
      const query = elements.modelMenuSearch.value.trim().toLowerCase();
      const favorites = connection.favoriteModelIds || [connection.modelId];
      return models
        .filter((model) => {
          if (!uiModelAllowed(model, connection.privacyPolicy)) return false;
          return (
            !query ||
            `${model.name} ${model.id} ${providerName(connection.providerId)}`
              .toLowerCase()
              .includes(query)
          );
        })
        .sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)))
        .map((model) => ({
          favorite: favorites.includes(model.id),
          providerId: connection.providerId,
          modelId: model.id,
          name: model.name || model.id,
          privacyInfo: modelPrivacyInfo(
            connection.providerId,
            model,
            connection.baseUrl,
            context.conversationId && connection.providerId === state.providerStatus?.providerId
              ? context.privacy?.settings()
              : undefined
          ),
        }));
    });
  }

  function renderProviderFields() {
    if (!elements.provider) return;
    const providerId = elements.provider.value;
    const isCustom = isCustomProvider(providerId);
    const isOllama = providerId === 'ollama';
    const isSubscription = providerAuthType(providerId) === 'subscription';
    const connection = providerConnection(providerId);
    const isConnectedSubscription = connection?.kind === 'subscription';
    const isMeta = ['meta', 'meta-subscription'].includes(providerId);
    const isClaude = ['anthropic', 'anthropic-claude'].includes(providerId);
    const canUpgradeChatgpt = providerId === 'openai-codex' && isConnectedSubscription;
    const descriptor = state.providerCatalog.find((item) => item.providerId === providerId);
    elements.customFields.hidden = !isCustom;
    elements.customSettings.hidden = !isCustom || !connection;
    elements.customUrl.disabled = isCustom && Boolean(connection);
    elements.customClearKeyField.hidden = !isCustom || !connection?.hasApiKey;
    elements.model.hidden = !isCustom;
    elements.compatibility.hidden = !isCustom || !connection;
    (isCustom ? elements.compatibilityModel : elements.hostedFields).appendChild(elements.model);
    if (isCustom) {
      elements.compatibilityNote.appendChild(elements.testProviderNote);
      elements.compatibilityActions.prepend(elements.testProvider);
    } else {
      elements.providerAdvanced.appendChild(elements.testProvider);
      elements.providerAdvanced.appendChild(elements.testProviderNote);
    }
    elements.testProvider.textContent = isCustom ? 'Check compatibility' : 'Send test prompt';
    elements.testProvider.disabled = compatibilityCheckPending;
    elements.testProviderNote.textContent = isCustom
      ? 'Sends up to three small synthetic requests to check streaming, tool calling and tool results. No files or pages are shared. Token charges may apply.'
      : 'Sends only “Reply with OK.” to this model. Token charges may apply.';
    elements.providerHeading.textContent = providerName(providerId);
    elements.providerStatus.textContent = connection ? 'Connected' : 'Not connected';
    elements.providerStatus.classList.toggle('active', Boolean(connection));
    elements.providerPrivacy.textContent = providerPrivacyMessage(providerId);
    elements.hostedFields.classList.toggle('hidden', isOllama || !connection);
    elements.ollamaFields.classList.toggle('hidden', !isOllama);
    elements.apiKeyField.classList.toggle('hidden', isSubscription || isOllama);
    (connection ? elements.keySettings : elements.connectionFields).prepend(elements.apiKeyField);
    if (isCustom && !connection) elements.connectionFields.prepend(elements.customFields);
    elements.subscriptionFields.classList.toggle(
      'hidden',
      !isSubscription || (isConnectedSubscription && !canUpgradeChatgpt && !providerLoginPending)
    );
    elements.saveProvider.hidden = isSubscription;
    elements.authCode.hidden = !providerLoginPending || !elements.authUserCode.textContent;
    elements.subscriptionNote.hidden = Boolean(connection) && !canUpgradeChatgpt;
    elements.subscriptionNote.textContent = canUpgradeChatgpt
      ? 'This connection uses the older Codex login. Sign in with ChatGPT to use the new connection. Your current connection stays available.'
      : isClaude
        ? 'Install Claude Code and sign in with claude auth login in your terminal, then connect here. Uses a personal Pro or Max subscription; managed installations are not supported. Freedom never copies your login credentials.'
        : isMeta
          ? 'Connect with your Meta account.'
          : 'Connect with your ChatGPT subscription.';
    elements.loginProvider.hidden =
      !isSubscription || (isConnectedSubscription && !canUpgradeChatgpt) || providerLoginPending;
    elements.loginProvider.textContent = canUpgradeChatgpt
      ? 'Upgrade ChatGPT sign-in'
      : isClaude
        ? 'Connect installed Claude'
        : isMeta
          ? 'Sign in with Meta'
          : 'Continue with ChatGPT';
    elements.cancelProviderLogin.hidden = !isSubscription || !providerLoginPending;
    elements.provider.disabled = providerLoginPending;
    elements.model.disabled = providerLoginPending;
    elements.modelRefresh.hidden = !isOllama && !descriptor?.canRefresh;
    elements.modelRefresh.disabled = (isOllama || isSubscription || isCustom) && !connection;
    elements.apiKey.placeholder =
      isCustom && !connection
        ? 'Optional — leave empty if not required'
        : connection
          ? 'Leave empty to keep your saved key'
          : 'Stored encrypted on this device';
    elements.saveProvider.textContent = isOllama
      ? connection
        ? 'Save connection'
        : 'Connect to Ollama'
      : connection
        ? 'Save connection'
        : 'Connect provider';
    elements.modelDetails.hidden = !connection;
    elements.testProvider.hidden = !connection;
    if (!connection) closeDisconnectConfirm();
    elements.providerDisconnect.hidden =
      !connection || elements.providerDisconnectConfirm?.hidden === false;
    elements.testProviderNote.hidden = !connection;
    const policies = providerId === 'openrouter' ? [] : descriptor?.policies || [];
    elements.privacyControls.hidden = policies.length === 0;
    elements.privacyPolicy.replaceChildren(
      ...policies.map(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
      })
    );
    elements.privacyPolicy.value = connection?.privacyPolicy || 'standard';
    elements.privacySave.hidden = !connection;
    elements.catalogStatus.textContent = descriptor?.updatedAt
      ? `Catalog updated ${new Date(descriptor.updatedAt).toLocaleString()}`
      : descriptor?.canRefresh
        ? 'Refresh to discover current models. No prompts are sent.'
        : 'Bundled model catalog';
    if (!isOllama) renderModelOptions(providerId);
    else renderProviderModelPreview(providerId);
    const subscriptionConnected = Boolean(
      isClaude
        ? providerConnection('anthropic-claude')
        : isMeta
          ? providerConnection('meta-subscription')
          : providerConnection('openai-chatgpt') || providerConnection('openai-codex')
    );
    elements.subscriptionMethodTitle.textContent = isClaude
      ? 'Claude subscription'
      : isMeta
        ? 'Meta subscription'
        : 'ChatGPT subscription';
    elements.subscriptionMethodHelp.textContent = isClaude
      ? 'Use your installed Claude Code login'
      : isMeta
        ? 'Use your Meta account'
        : 'Use your ChatGPT account';
    elements.authCodeInstruction.textContent = `Enter this code on the ${isMeta ? 'Meta' : 'OpenAI'} page`;
    const apiConnected = Boolean(
      providerConnection(isClaude ? 'anthropic' : isMeta ? 'meta' : 'openai')
    );
    elements.chatgptConnectionState.textContent = subscriptionConnected ? 'Connected' : 'Connect';
    elements.apiConnectionState.textContent = apiConnected ? 'Connected' : 'Connect';
    elements.chatgptConnectionState.classList.toggle('active', subscriptionConnected);
    elements.apiConnectionState.classList.toggle('active', apiConnected);
    if (choosingProviderMethod) {
      elements.providerHeading.textContent = providerPageTitle(providerId);
      elements.providerStatus.textContent =
        subscriptionConnected || apiConnected ? 'Connected' : 'Not connected';
      elements.providerStatus.classList.toggle('active', subscriptionConnected || apiConnected);
    }
  }

  function renderProviderModelPreview(providerId) {
    const connection = providerConnection(providerId);
    const models =
      providerId === 'ollama'
        ? (connection?.modelIds || (connection ? [connection.modelId] : [])).map((id) => ({
            id,
            name: id,
          }))
        : state.providerCatalog.find((provider) => provider.providerId === providerId)?.models ||
          [];
    const available = models.filter((model) =>
      uiModelAllowed(model, elements.privacyPolicy.value || 'standard')
    );
    elements.providerModelsHeading.textContent = available.length
      ? `Available models · ${available.length}`
      : 'Available models';
    elements.providerModelsList.replaceChildren(
      ...available.map((model) => {
        const row = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = model.name || model.id;
        const info = modelPrivacyInfo(providerId, model, connection?.baseUrl);
        const privacy = createModelPrivacySymbols(info);
        row.appendChild(name);
        row.appendChild(privacy);
        if (connection) {
          row.appendChild(favoriteButton(providerId, model.id));
          name.className = 'agent-settings-model-name';
          const select = document.createElement('button');
          select.type = 'button';
          select.textContent = model.name || model.id;
          select.setAttribute('aria-label', `Use ${model.name || model.id} for new chats`);
          select.setAttribute(
            'aria-pressed',
            String(
              state.providerStatus?.providerId === providerId &&
                state.providerStatus?.modelId === model.id
            )
          );
          select.addEventListener('click', () => selectModel(providerId, model.id));
          name.replaceChildren(select);
        }
        row.title = `${model.id}\n${info.detail}`;
        return row;
      })
    );
    elements.providerModelsList.scrollTop = 0;
    elements.providerModelsList.hidden = !available.length;
    elements.providerModelsEmpty.hidden = Boolean(available.length);
    elements.providerModelsEmpty.textContent = models.length
      ? 'No models meet the current requirements'
      : connection
        ? 'Refresh to discover available models'
        : 'Connect to discover available models';
  }

  function uiModelAllowed(model, policy = 'standard') {
    return (
      model.available !== false &&
      model.tools !== false &&
      (policy !== 'private' || ['private', 'tee'].includes(model.privacy)) &&
      (policy !== 'tee' || model.privacy === 'tee')
    );
  }

  let providerScreen = 'home';
  let applyingSettingsRoute = false;
  function showProviderScreen(screen) {
    closeDisconnectConfirm();
    providerScreen = screen;
    elements.providerHome.hidden = screen !== 'home';
    elements.providerBrowser.hidden = screen !== 'browser';
    elements.providerDetail.hidden = screen !== 'detail';
    setMessage(elements.providerMessage, '');
    if (screen === 'browser') elements.providerSearch.focus();
    if (!applyingSettingsRoute) options.onScreenChange?.(screen, elements.provider.value);
  }

  function openProviderDetail(providerId, chooseMethod = false) {
    closeDisconnectConfirm();
    choosingProviderMethod = chooseMethod;
    elements.provider.value = providerId;
    elements.apiKey.value = '';
    elements.model.value = providerConnection(providerId)?.modelId || '';
    if (providerId === 'ollama') {
      const connection = providerConnection(providerId);
      elements.ollamaUrl.value = connection?.baseUrl || 'http://127.0.0.1:11434/v1';
    }
    if (isCustomProvider(providerId)) {
      const connection = providerConnection(providerId);
      elements.customName.value = connection?.name || '';
      elements.customUrl.value = connection?.baseUrl || '';
      elements.customModels.value = connection?.models.map((m) => m.id).join('\n') || '';
      elements.customClearKey.checked = false;
      renderCustomTransport();
    }
    elements.providerAdvanced.open = false;
    elements.providerMethods.hidden = !chooseMethod;
    elements.connectionFields.hidden = chooseMethod;
    showProviderScreen('detail');
    renderProviderFields();
    const descriptor = state.providerCatalog.find((item) => item.providerId === providerId);
    if (
      !chooseMethod &&
      providerConnection(providerId) &&
      descriptor?.canRefresh &&
      (!descriptor.updatedAt || Date.now() - descriptor.updatedAt > 24 * 60 * 60 * 1000)
    ) {
      refreshModelCatalog({ background: true });
    }
  }

  function createProviderLogo(providerId) {
    const files = {
      openai: 'openai.png',
      'openai-chatgpt': 'openai.png',
      'openai-codex': 'openai.png',
      anthropic: 'anthropic.png',
      'anthropic-claude': 'anthropic.png',
      xai: 'xai-light.svg',
      meta: 'meta.svg',
      'meta-subscription': 'meta.svg',
      openrouter: 'openrouter.png',
      venice: 'venice.png',
      'near-ai': 'near-ai.svg',
      ollama: 'ollama.png',
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
    image.src = `${options.assetBase || 'assets/provider-logos/'}${file}`;
    image.alt = '';
    image.width = 32;
    image.height = 32;
    image.draggable = false;
    logo.appendChild(image);
    if (providerId === 'xai') {
      image.classList.add('agent-provider-logo-light');
      const dark = document.createElement('img');
      dark.className = 'agent-provider-logo agent-provider-logo-dark';
      dark.src = `${options.assetBase || 'assets/provider-logos/'}xai-dark.svg`;
      dark.alt = '';
      dark.width = 32;
      dark.height = 32;
      dark.draggable = false;
      logo.appendChild(dark);
    }
    return logo;
  }

  function renderProviderOptions() {
    if (!elements.provider) return;
    const selected = elements.provider.value;
    const definitions = [
      ...state.providerCatalog,
      { providerId: 'openai-compatible', name: 'OpenAI-compatible', group: 'Custom connections' },
      { providerId: 'ollama', name: 'Ollama', group: 'On this device' },
    ];
    elements.provider.replaceChildren(
      ...definitions.map((definition) => {
        const option = document.createElement('option');
        option.value = definition.providerId;
        option.textContent = definition.name;
        return option;
      })
    );
    elements.provider.value = definitions.some((item) => item.providerId === selected)
      ? selected
      : definitions[0]?.providerId || '';
    const query = elements.providerSearch.value.trim().toLowerCase();
    const content = [];
    let group;
    let groupRows;
    const descriptions = {
      openai: 'ChatGPT subscription or API key',
      anthropic: 'Claude subscription or API key',
      xai: 'Grok models',
      meta: 'Meta subscription or API key',
      openrouter: 'Many model providers, one API key',
      venice: 'Models with privacy options',
      'near-ai': 'TEE and external models',
      ollama: 'Models running on your computer',
      'openai-compatible': 'Connect your own endpoint',
    };
    for (const definition of definitions) {
      if (definition.providerId.startsWith('custom-')) continue;
      if (
        ['anthropic-claude', 'openai-chatgpt', 'openai-codex', 'meta-subscription'].includes(
          definition.providerId
        )
      )
        continue;
      const name = definition.providerId === 'openai' ? 'OpenAI' : definition.name;
      if (
        !`${name} ${definition.providerId} ${definition.providerId === 'openai' ? 'ChatGPT subscription API' : ''}`
          .toLowerCase()
          .includes(query)
      )
        continue;
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
      const connected = Boolean(
        providerConnection(definition.providerId) ||
        (definition.providerId === 'openai' &&
          (providerConnection('openai-chatgpt') || providerConnection('openai-codex'))) ||
        (definition.providerId === 'meta' && providerConnection('meta-subscription')) ||
        (definition.providerId === 'anthropic' && providerConnection('anthropic-claude'))
      );
      const indicator = document.createElement('span');
      indicator.className = 'agent-provider-indicator';
      indicator.textContent = connected ? '✓' : '›';
      indicator.title = connected ? 'Connected' : 'Connect provider';
      indicator.classList.toggle('active', connected);
      button.appendChild(avatar);
      button.appendChild(copy);
      button.appendChild(indicator);
      button.addEventListener('click', () =>
        openProviderDetail(
          definition.providerId,
          ['openai', 'meta', 'anthropic'].includes(definition.providerId)
        )
      );
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
    button.setAttribute(
      'aria-label',
      `${active ? 'Unfavorite' : 'Favorite'} ${modelName(providerId, modelId)}`
    );
    button.setAttribute('aria-pressed', String(active));
    button.hidden = !connection;
    button.addEventListener('click', async () => {
      button.disabled = true;
      await saveProviderPreferences(
        {
          favoriteModelIds: active
            ? favorites.filter((id) => id !== modelId)
            : [...favorites, modelId],
        },
        providerId
      );
      button.disabled = false;
    });
    return button;
  }

  function renderModelOptions(providerId) {
    renderProviderModelPreview(providerId);
    const selectedModel = elements.model.value || providerConnection(providerId)?.modelId;
    const provider = state.providerCatalog.find((candidate) => candidate.providerId === providerId);
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
      elements.model.value =
        options.find((option) => option.value === provider?.defaultModelId && !option.disabled)
          ?.value ||
        options.find((option) => !option.disabled)?.value ||
        '';
    }
    loadCustomModelSettings();
    renderModelDetails();
    renderCompatibilityCheck();
  }

  function renderCustomTransport() {
    elements.customTransport.textContent = elements.customUrl.value.trim().startsWith('http:')
      ? 'HTTP sends messages and any API key without transport encryption. Use only a network you trust.'
      : 'Requests go directly to this endpoint. Retention and privacy guarantees are unknown. Add a new connection to change a saved URL.';
  }
  function loadCustomModelSettings() {
    const model = catalogModel(elements.provider.value, elements.model.value);
    elements.customContext.value = model?.contextWindow || 32768;
    elements.customOutput.value = model?.maxTokens || 4096;
    elements.customVision.checked = model?.vision === true;
    elements.customReasoning.checked = model?.reasoning === true;
    elements.customSchema.checked = model?.jsonSchema === true;
  }
  function renderModelDetails() {
    const providerId = elements.provider.value;
    const model = catalogModel(providerId, elements.model.value);
    const parts = [];
    if (model) {
      parts.push(model.id);
      if (model.contextWindow)
        parts.push(`${new Intl.NumberFormat().format(model.contextWindow)} context`);
      if (model.vision) parts.push('Images');
      if (model.reasoning) parts.push('Reasoning');
      parts.push(
        model.tools === true
          ? 'Tool calling'
          : model.tools === false
            ? 'No tool calling'
            : 'Tool support not reported'
      );
      if (model.inputPrice != null && model.outputPrice != null)
        parts.push(`$${model.inputPrice} input / $${model.outputPrice} output per 1M tokens`);
    }
    elements.modelDetails.textContent =
      parts.join(' · ') || 'No matching models. Try another search or refresh the catalog.';
    if (model) {
      const info = modelPrivacyInfo(providerId, model, providerConnection(providerId)?.baseUrl);
      const privacy = createModelPrivacySymbols(info);
      privacy.classList.add('agent-model-privacy-detail');
      elements.modelDetails.appendChild(privacy);
    }
  }

  async function saveProviderPreferences(preferences, providerId = elements.provider.value) {
    try {
      const response = await api.setAgentProviderPreferences(providerId, preferences);
      if (!response?.ok) {
        setMessage(
          elements.providerMessage,
          responseMessage(response, 'Could not save preferences'),
          true
        );
        return;
      }
      state.providerStatus = response.status;
      if (elements.provider?.value === providerId) {
        renderProviderFields();
        renderModelDetails();
      }
      renderConnectedProviders();
      renderActiveModel();
      setMessage(elements.providerMessage, 'Preferences saved');
    } catch {
      setMessage(elements.providerMessage, 'Could not save preferences', true);
    }
  }

  // A catalog refresh says so only when someone asked for it, and only for a
  // moment: a page opened on a day-old catalog refreshes in the background with
  // no status line, not even when it fails (the previous catalog stays in use,
  // and nobody asked), and a clicked refresh's "refreshed" clears itself
  // (#803). A clicked refresh's failure stays until the next action, like every
  // other error here.
  const TRANSIENT_MESSAGE_MS = 4000;
  let transientTimer = null;
  function setTransientMessage(element, text) {
    clearTimeout(transientTimer);
    setMessage(element, text);
    transientTimer = setTimeout(() => {
      if (element.textContent === text) setMessage(element, '');
    }, TRANSIENT_MESSAGE_MS);
  }

  async function refreshModelCatalog({ background = false } = {}) {
    const providerId = elements.provider.value;
    elements.modelRefresh.disabled = true;
    if (!background) setMessage(elements.providerMessage, 'Refreshing model catalog…');
    try {
      const response = await api.refreshAgentProviderModels(
        providerId,
        elements.apiKey.value || undefined
      );
      if (!response?.ok) {
        if (!background)
          setMessage(
            elements.providerMessage,
            responseMessage(
              response,
              'Could not refresh models. Your previous catalog is still available.'
            ),
            true
          );
        return;
      }
      state.providerCatalog = response.catalog;
      if (response.status) state.providerStatus = response.status;
      renderProviderFields();
      renderConnectedProviders();
      renderActiveModel();
      if (!background) setTransientMessage(elements.providerMessage, 'Model catalog refreshed');
      return true;
    } catch {
      if (!background)
        setMessage(
          elements.providerMessage,
          'Could not refresh models. Your previous catalog is still available.',
          true
        );
    } finally {
      elements.modelRefresh.disabled = false;
    }
  }

  function compatibilityKey() {
    const connection = providerConnection(elements.provider.value);
    return JSON.stringify([connection?.providerId, connection?.updatedAt, elements.model.value]);
  }

  function renderCompatibilityCheck() {
    if (!isCustomProvider(elements.provider.value)) return;
    const check = compatibilityCheck?.key === compatibilityKey() ? compatibilityCheck : null;
    setMessage(
      elements.compatibilityResult,
      check?.message || 'Not checked. Your connection is ready to use.',
      check?.failed === true
    );
    elements.testProvider.textContent = check?.pending
      ? 'Checking…'
      : check
        ? 'Check again'
        : 'Check compatibility';
    elements.testProvider.disabled = compatibilityCheckPending;
    elements.compatibilityContinue.textContent = check?.pending
      ? 'Continue while checking'
      : check?.failed
        ? 'Continue anyway'
        : check
          ? 'Continue'
          : 'Continue without checking';
  }

  async function testProviderConnection() {
    const providerId = elements.provider.value;
    const modelId =
      providerId === 'ollama' ? providerConnection(providerId)?.modelId : elements.model.value;
    const custom = isCustomProvider(providerId);
    const key = compatibilityKey();
    elements.testProvider.disabled = true;
    if (custom) {
      compatibilityCheckPending = true;
      compatibilityCheck = { key, pending: true, message: `Checking ${modelId}…` };
      renderCompatibilityCheck();
    } else setMessage(elements.providerMessage, 'Sending test prompt…');
    try {
      const response = await api.testAgentProviderConnection(providerId, modelId);
      if (custom) {
        const result = response?.result;
        const descriptions = {
          streaming: 'Chat works; streaming was not verified.',
          toolCall: 'Chat and streaming work; tool calling failed.',
          toolResult: 'Chat and tool calling work; using the tool result failed.',
          chat: 'Chat could not be verified. Check the model, endpoint and credentials, then retry.',
        };
        const passed = response?.ok && result?.outcome === 'tools_verified';
        compatibilityCheck = {
          key,
          failed: !passed,
          message: `${modelId}: ${
            passed
              ? 'Chat and tools verified, including streaming and tool results.'
              : response?.ok
                ? descriptions[result?.failedStage] || descriptions.chat
                : responseMessage(response, descriptions.chat)
          }`,
        };
      } else if (
        elements.provider.value === providerId &&
        (providerId === 'ollama'
          ? providerConnection(providerId)?.modelId
          : elements.model.value) === modelId
      ) {
        setMessage(
          elements.providerMessage,
          response?.ok
            ? response.result.outcome === 'token_limit'
              ? 'Connection accepted. The model reached the test token limit before finishing.'
              : `Model responded in ${Math.max(0.1, response.result.elapsedMs / 1000).toFixed(1)}s`
            : responseMessage(response, 'Test prompt failed'),
          !response?.ok
        );
      }
    } catch {
      if (custom)
        compatibilityCheck = {
          key,
          failed: true,
          message: `${modelId}: Compatibility check could not finish. You can retry or continue anyway.`,
        };
      else setMessage(elements.providerMessage, 'Test prompt failed', true);
    } finally {
      if (custom) compatibilityCheckPending = false;
      elements.testProvider.disabled = false;
      renderCompatibilityCheck();
    }
  }

  function renderConnectedProviders() {
    if (!elements.provider) return;
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
    if (!elements.modelMenuList) return;
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
      chevron.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
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
          state.providerStatus?.providerId === model.providerId &&
          state.providerStatus?.modelId === model.modelId;
        option.classList.toggle('active', active);
        option.setAttribute('aria-checked', String(active));
        const name = document.createElement('span');
        name.textContent = model.name;
        const check = document.createElement('span');
        check.className = 'agent-model-check';
        check.textContent = active ? '✓' : '';
        option.appendChild(name);
        option.appendChild(check);
        const privacy = createModelPrivacySymbols(model.privacyInfo);
        option.appendChild(privacy);
        option.title = model.privacyInfo.detail;
        option.setAttribute(
          'aria-label',
          `${model.name}. ${model.privacyInfo.label}. ${model.privacyInfo.detail}`
        );
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
      empty.textContent = elements.modelMenuSearch.value
        ? 'No matching models meet your privacy settings'
        : 'Connect a provider to browse its models';
      elements.modelMenuList.appendChild(empty);
    }
  }

  function renderActiveModel() {
    if (!elements.activeModelLabel) return;
    const selected = context.activeModel || state.providerStatus;
    context.privacy?.setProvider(selected?.providerId);
    const configured = Boolean(selected?.modelId);
    elements.activeModelLabel.textContent = configured
      ? modelName(selected.providerId, selected.modelId)
      : 'Choose model';
    elements.modelMenuButton.title = configured
      ? `${providerName(selected.providerId)} · ${selected.modelId}`
      : '';
    renderModelMenu();
  }

  function renderProviderStatus(status) {
    state.providerStatus = status;
    const configured = status?.configured === true;
    if (elements.provider) {
      elements.providerStatus.textContent = configured
        ? `${providerName(status.providerId)} · ${status.modelId}`
        : 'Not configured';
      elements.providerStatus.classList.toggle('active', configured);
      if (
        configured &&
        (elements.providerDetail.hidden || !elements.provider.value) &&
        (Object.hasOwn(PROVIDER_NAMES, status.providerId) || isCustomProvider(status.providerId))
      ) {
        elements.provider.value = status.providerId;
        if (status.providerId === 'ollama') {
          elements.ollamaUrl.value = status.baseUrl || 'http://127.0.0.1:11434/v1';
        }
      }
    }
    renderProviderFields();
    renderConnectedProviders();
    renderActiveModel();
    context.updateSendAvailability();
    options.onStatusChange?.(status);
    if (context.view === 'loading') context.showPrimaryView();
    else if (context.view === 'setup') context.setAgentView('setup');
  }

  async function refreshProvider() {
    try {
      const response = await api.getAgentProviderStatus();
      if (!response?.ok) {
        setMessage(
          elements.providerMessage,
          responseMessage(response, 'Could not load the agent model'),
          true
        );
        state.providerReady = true;
        state.providerStatus = { configured: false, connections: [] };
        context.showPrimaryView();
        return;
      }
      state.providerReady = true;
      renderProviderStatus(response.status);
    } catch {
      state.providerReady = true;
      state.providerStatus = { configured: false, connections: [] };
      setMessage(elements.providerMessage, 'Could not load the agent model', true);
      context.showPrimaryView();
    }
  }

  function invalidateCatalog({ keepModels = false } = {}) {
    catalogGeneration += 1;
    if (!keepModels) state.providerCatalog = [];
    state.providerCatalogPromise = null;
  }

  async function loadProviderCatalog() {
    if (state.providerCatalog.length) return state.providerCatalog;
    if (state.providerCatalogPromise) return state.providerCatalogPromise;
    const generation = catalogGeneration;
    state.providerCatalogPromise = (async () => {
      try {
        const response = await api.getAgentProviderCatalog();
        if (generation !== catalogGeneration || !response?.ok || !Array.isArray(response.catalog))
          return state.providerCatalog;
        state.providerCatalog = response.catalog;
        renderProviderOptions();
        renderProviderFields();
        renderConnectedProviders();
        renderActiveModel();
        return state.providerCatalog;
      } catch {
        // A saved Ollama model remains usable even if the hosted catalog cannot load.
        return state.providerCatalog;
      } finally {
        if (generation === catalogGeneration) state.providerCatalogPromise = null;
      }
    })();
    return state.providerCatalogPromise;
  }

  async function selectModel(providerId, modelId) {
    if (context.runStatus !== 'idle' || context.conversationId) return;
    if (elements.modelMenuButton) elements.modelMenuButton.disabled = true;
    try {
      const response = await api.selectAgentModel(providerId, modelId);
      if (!response?.ok) {
        setMessage(elements.runMessage, responseMessage(response, 'Could not select model'), true);
        return;
      }
      renderProviderStatus(response.status);
      context.closeComposerPopovers();
    } catch {
      setMessage(elements.runMessage, 'Could not select model', true);
    } finally {
      if (elements.modelMenuButton)
        elements.modelMenuButton.disabled =
          context.runStatus !== 'idle' || Boolean(context.conversationId);
    }
  }

  // Disconnecting deletes the stored API key or sign-in, which cannot be
  // undone from this page, so it asks first — in the page, the way the
  // Shortcuts conflict prompt does, not with a native dialog.
  function openDisconnectConfirm(providerId) {
    const confirm = elements.providerDisconnectConfirm;
    if (!confirm || !providerConnection(providerId)) return;
    const connection = providerConnection(providerId);
    const consequence =
      connection.kind === 'hosted' || connection.hasApiKey
      ? ' Its saved API key is deleted from this device.'
      : connection.kind === 'subscription'
        ? ' You will need to sign in again to reconnect.'
        : '';
    elements.providerDisconnectQuestion.textContent = `Disconnect ${providerName(providerId)} from Agent?${consequence}`;
    confirm.hidden = false;
    elements.providerDisconnect.hidden = true;
    elements.providerDisconnectCancel.focus();
  }

  function closeDisconnectConfirm({ restoreFocus = false } = {}) {
    const confirm = elements.providerDisconnectConfirm;
    if (!confirm || confirm.hidden) return;
    confirm.hidden = true;
    if (elements.providerDisconnect && providerConnection(elements.provider.value)) {
      elements.providerDisconnect.hidden = false;
      if (restoreFocus) elements.providerDisconnect.focus();
    }
  }

  async function removeProviderConnection(providerId) {
    const label = providerName(providerId);
    closeDisconnectConfirm();
    try {
      const response = await api.removeAgentProvider(providerId);
      if (!response?.ok) {
        setMessage(
          elements.providerMessage,
          responseMessage(response, `Could not disconnect ${label}`),
          true
        );
        return;
      }
      renderProviderStatus(response.status);
      if (!response.status?.configured) context.setAgentView('setup');
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
    setMessage(
      elements.providerMessage,
      providerId === 'ollama' ? 'Finding installed models…' : 'Saving…'
    );
    try {
      let response;
      if (
        adding &&
        !isCustomProvider(providerId) &&
        providerId !== 'ollama' &&
        !elements.model.value
      ) {
        // Some catalogs require the entered key. Discover them as part of connecting,
        // without making users select a model in the connection form.
        if (!(await refreshModelCatalog())) return;
        elements.privacyPolicy.value = privacyPolicy;
        renderModelOptions(providerId);
        if (!elements.model.value) {
          setMessage(
            elements.providerMessage,
            'No supported models meet this privacy setting',
            true
          );
          return;
        }
      }
      if (isCustomProvider(providerId)) {
        const ids = [
          ...new Set(
            elements.customModels.value
              .split(/[,\n]/)
              .map((s) => s.trim())
              .filter(Boolean)
          ),
        ];
        const oldModels = providerConnection(providerId)?.models || [];
        const models = ids.map((id) => {
          const previous = oldModels.find((m) => m.id === id) || { id };
          return id === elements.model.value
            ? {
                ...previous,
                contextWindow: Number(elements.customContext.value),
                maxTokens: Number(elements.customOutput.value),
                vision: elements.customVision.checked,
                reasoning: elements.customReasoning.checked,
                jsonSchema: elements.customSchema.checked,
              }
            : previous;
        });
        response = await api.configureCompatibleAgentProvider({
          providerId,
          name: elements.customName.value.trim(),
          baseUrl: elements.customUrl.value.trim(),
          apiKey: elements.apiKey.value,
          clearApiKey: elements.customClearKey.checked,
          models,
          modelId: elements.model.value,
        });
        if (response?.ok) {
          state.providerStatus = response.status;
          invalidateCatalog();
          await loadProviderCatalog();
          openProviderDetail(response.status.providerId);
        }
      } else if (providerId === 'ollama') {
        response = await api.configureOllamaAgentProvider(
          undefined,
          elements.ollamaUrl.value.trim()
        );
      } else if (providerAuthType(providerId) === 'subscription') {
        response = await api.selectAgentModel(providerId, elements.model.value);
      } else {
        response = await api.configureHostedAgentProvider(
          providerId,
          elements.model.value,
          elements.apiKey.value,
          ...(elements.privacyControls.hidden ? [] : [elements.privacyPolicy.value])
        );
      }
      elements.apiKey.value = '';
      if (!response?.ok) {
        setMessage(
          elements.providerMessage,
          responseMessage(response, 'Could not save model'),
          true
        );
        return;
      }
      renderProviderStatus(response.status);
      setMessage(
        elements.providerMessage,
        providerId === 'ollama' ? 'Ollama models ready' : 'Model saved for this profile'
      );
      if (isCustomProvider(providerId)) {
        renderCompatibilityCheck();
        if (adding) {
          elements.compatibility.scrollIntoView?.({ block: 'start' });
          elements.testProvider.focus();
        }
      }
    } catch {
      elements.apiKey.value = '';
      setMessage(elements.providerMessage, 'Could not save model', true);
    } finally {
      elements.saveProvider.disabled = false;
    }
  }

  function handleProviderAuthEvent(event) {
    if (
      providerLoginPending &&
      event?.providerId === 'openai-chatgpt' &&
      elements.provider.value === event.providerId
    ) {
      if (event.type === 'auth_url')
        setMessage(elements.providerMessage, 'Finish signing in with ChatGPT in your browser');
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
    setMessage(
      elements.providerMessage,
      `Finish signing in on the ${event.providerId === 'meta-subscription' ? 'Meta' : 'OpenAI'} page`
    );
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
    const loginGeneration = ++providerLoginGeneration;
    elements.authCallback.hidden = true;
    elements.authCallback.open = false;
    elements.authCallbackInput.value = '';
    elements.authCode.hidden = true;
    elements.authUserCode.textContent = '';
    const accountName =
      providerId === 'anthropic-claude'
        ? 'Claude'
        : providerId === 'meta-subscription'
          ? 'Meta'
          : 'ChatGPT';
    setMessage(
      elements.providerMessage,
      providerId === 'anthropic-claude'
        ? 'Checking your installed Claude login…'
        : `Starting ${accountName} sign-in…`
    );
    renderProviderFields();
    try {
      const response = await api.loginSubscriptionAgentProvider(providerId, modelId);
      if (loginGeneration !== providerLoginGeneration) return;
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
      if (loginGeneration === providerLoginGeneration)
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
    if (!providerLoginPending || elements.cancelProviderLogin.disabled) return;
    providerLoginGeneration += 1;
    elements.cancelProviderLogin.disabled = true;
    setMessage(elements.providerMessage, 'Cancelling sign-in…');
    try {
      await api.cancelAgentProviderLogin();
    } catch {
      setMessage(elements.providerMessage, 'Could not cancel sign-in', true);
    } finally {
      elements.cancelProviderLogin.disabled = false;
      if (elements.providerMessage.textContent === 'Cancelling sign-in…')
        setMessage(elements.providerMessage, 'Sign-in cancelled.');
    }
  }

  if (elements.provider) {
    applyingSettingsRoute = true;
    showProviderScreen('home');
    applyingSettingsRoute = false;
    elements.provider.addEventListener('change', () => {
      elements.apiKey.value = '';
      elements.model.value = providerConnection(elements.provider.value)?.modelId || '';
      renderProviderFields();
      setMessage(elements.providerMessage, '');
    });

    elements.providerAdd.addEventListener('click', () => {
      renderProviderOptions();
      showProviderScreen('browser');
    });
    elements.providerListBack.addEventListener('click', () => showProviderScreen('home'));
    elements.providerDetailBack.addEventListener('click', () => {
      if (!providerLoginPending) showProviderScreen('home');
    });
    elements.providerChatgpt.addEventListener('click', () =>
      openProviderDetail(
        elements.provider.value === 'anthropic'
          ? 'anthropic-claude'
          : elements.provider.value === 'meta'
            ? 'meta-subscription'
            : 'openai-chatgpt'
      )
    );
    elements.providerApi.addEventListener('click', () =>
      openProviderDetail(
        elements.provider.value === 'anthropic'
          ? 'anthropic'
          : elements.provider.value === 'meta'
            ? 'meta'
            : 'openai'
      )
    );
    elements.providerSearch.addEventListener('input', renderProviderOptions);
    elements.customUrl.addEventListener('input', renderCustomTransport);
    elements.model.addEventListener('change', () => {
      loadCustomModelSettings();
      renderModelDetails();
      renderCompatibilityCheck();
    });
    elements.modelRefresh.addEventListener('click', () => refreshModelCatalog());
    elements.testProvider.addEventListener('click', testProviderConnection);
    elements.compatibilityContinue.addEventListener('click', async () => {
      if (!context.conversationId && context.runStatus === 'idle') {
        const providerId = elements.provider.value,
          modelId = elements.model.value;
        await selectModel(providerId, modelId);
        if (
          state.providerStatus?.providerId !== providerId ||
          state.providerStatus?.modelId !== modelId
        )
          return;
      }
      context.setAgentView('workspace');
      context.focusComposer();
    });
    elements.privacyPolicy.addEventListener('change', () =>
      renderModelOptions(elements.provider.value)
    );
    elements.privacySave.addEventListener('click', () =>
      saveProviderPreferences({ privacyPolicy: elements.privacyPolicy.value })
    );
    elements.providerDisconnect.addEventListener('click', () =>
      openDisconnectConfirm(elements.provider.value)
    );
    elements.providerDisconnectAccept?.addEventListener('click', () =>
      removeProviderConnection(elements.provider.value)
    );
    elements.providerDisconnectCancel?.addEventListener('click', () =>
      closeDisconnectConfirm({ restoreFocus: true })
    );
    elements.providerDisconnectConfirm?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDisconnectConfirm({ restoreFocus: true });
    });
    elements.saveProvider.addEventListener('click', saveProvider);
    elements.loginProvider.addEventListener('click', loginSubscriptionProvider);
    elements.authCallbackSubmit.addEventListener('click', async () => {
      if (!providerLoginPending) return;
      const callbackUrl = elements.authCallbackInput.value.trim();
      elements.authCallbackInput.value = '';
      try {
        const response = await api.submitAgentProviderLogin(
          elements.authCallback.dataset.requestId,
          callbackUrl
        );
        if (!response?.ok)
          setMessage(
            elements.providerMessage,
            responseMessage(response, 'Could not complete sign-in'),
            true
          );
      } catch {
        setMessage(elements.providerMessage, 'Could not complete sign-in', true);
      }
    });
    elements.cancelProviderLogin.addEventListener('click', cancelProviderLogin);
  }
  // Settings owns URL/history; replaying a route must not push another one or
  // clear a partially edited form on catalogue/status updates.
  function showSettingsPage(screen, providerId) {
    if (
      providerScreen === screen &&
      (screen !== 'detail' || elements.provider.value === providerId)
    )
      return;
    if (providerLoginPending) void cancelProviderLogin();
    applyingSettingsRoute = true;
    try {
      if (screen === 'detail')
        openProviderDetail(
          providerId,
          !providerConnection(providerId) && ['openai', 'anthropic', 'meta'].includes(providerId)
        );
      else {
        if (screen === 'browser') renderProviderOptions();
        showProviderScreen(screen);
      }
    } finally {
      applyingSettingsRoute = false;
    }
  }
  return {
    state,
    showSettingsPage,
    providerName,
    providerPageTitle,
    invalidateCatalog,
    providerPrivacyMessage,
    renderProviderFields,
    renderConnectedProviders,
    renderModelMenu,
    renderActiveModel,
    refreshProvider,
    loadProviderCatalog,
    handleProviderAuthEvent,
    cancelProviderLogin,
  };
}
